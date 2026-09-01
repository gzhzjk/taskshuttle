import { describe, expect, it } from 'vitest';

import { deriveDiffEntries, derivedEntryKey, PATCH_TEXT_LIMIT } from '../../packages/plugin/src/console/ui/diff-sources.js';
import { diffLines } from '../../packages/plugin/src/console/ui/diff-lines.js';

/**
 * The three diff shapes of ADR 0021, asserted by shape and never by engine id —
 * the engine set is open (ADR 0004), so a test that names engines is a test
 * that misses the next one.
 *
 * The fixtures are modelled on shapes counted in this machine's stored
 * transcripts (console-diff-shapes-design.md §1), not copied from them: real
 * rawInput carries other projects' source.
 */

const edit = (rawInput: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  sessionUpdate: 'tool_call',
  toolCallId: 'call-1',
  kind: 'edit',
  status: 'pending',
  rawInput,
  ...extra,
});

describe('deriveDiffEntries — native ACP diff blocks', () => {
  it('reads every diff block of an event and numbers them by position', () => {
    const entries = deriveDiffEntries({
      sessionUpdate: 'tool_call',
      content: [
        { type: 'diff', path: 'a.ts', oldText: 'x', newText: 'y' },
        { type: 'text', text: 'noise' },
        { type: 'diff', path: 'a.ts', oldText: 'p', newText: 'q' },
      ],
    });
    expect(entries.map((e) => [e.origin, e.part, e.path])).toEqual([
      ['engine', 0, 'a.ts'],
      ['engine', 1, 'a.ts'],
    ]);
  });

  it('takes the native block and does not also rebuild from rawInput', () => {
    const entries = deriveDiffEntries(
      edit(
        { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] },
        { content: [{ type: 'diff', path: 'a.ts', oldText: 'x', newText: 'y' }] },
      ),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.origin).toBe('engine');
  });
});

describe('deriveDiffEntries — rawInput.edits', () => {
  it('rebuilds one entry per hunk, and the counts match diffLines', () => {
    const entries = deriveDiffEntries(
      edit({ path: 'src/a.ts', edits: [{ oldText: 'one\ntwo', newText: 'one\ntwo\nthree' }] }),
    );
    expect(entries).toEqual([
      { origin: 'reconstructed', part: 0, path: 'src/a.ts', oldText: 'one\ntwo', newText: 'one\ntwo\nthree' },
    ]);
    const lines = diffLines(entries[0]?.oldText, entries[0]?.newText);
    expect(lines.filter((l) => l.t === 'add')).toHaveLength(1);
    expect(lines.filter((l) => l.t === 'del')).toHaveLength(0);
  });

  it('keeps multi-hunk edits apart rather than concatenating them', () => {
    const entries = deriveDiffEntries(
      edit({
        path: 'src/a.ts',
        edits: [
          { oldText: 'a', newText: 'A' },
          { oldText: 'b', newText: 'B' },
          { oldText: 'c', newText: 'C' },
        ],
      }),
    );
    expect(entries.map((e) => [e.part, e.oldText, e.newText])).toEqual([
      [0, 'a', 'A'],
      [1, 'b', 'B'],
      [2, 'c', 'C'],
    ]);
  });

  it('keeps two identical hunks of one call apart', () => {
    // They differ only by position, and position is the whole reason `part`
    // exists: collapsing them would lose an edit the engine stated twice.
    const entries = deriveDiffEntries(
      edit({ path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }, { oldText: 'x', newText: 'y' }] }),
    );
    expect(entries).toHaveLength(2);
    expect(derivedEntryKey(entries[0]!)).not.toBe(derivedEntryKey(entries[1]!));
  });

  it('falls back to locations[0].path when rawInput has no path', () => {
    const entries = deriveDiffEntries(
      edit({ edits: [{ oldText: 'a', newText: 'b' }] }, { locations: [{ path: 'from/locations.ts' }] }),
    );
    expect(entries[0]?.path).toBe('from/locations.ts');
  });

  it('produces nothing at all when one hunk is malformed', () => {
    // Negative case for the validation: without it, diffLines' String(x ?? '')
    // coercion turns `undefined` into a plausible "deleted one line" diff.
    const entries = deriveDiffEntries(
      edit({ path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c' }] }),
    );
    expect(entries).toEqual([]);
    expect(diffLines(undefined, 'b')).not.toHaveLength(0); // the coercion this guards against
  });

  it('ignores an empty edits array rather than reporting an empty diff', () => {
    expect(deriveDiffEntries(edit({ path: 'a.ts', edits: [] }))).toEqual([]);
  });
});

describe('deriveDiffEntries — patchText', () => {
  const patch = (body: string) => edit({ patchText: `*** Begin Patch\n${body}\n*** End Patch` });

  it('rebuilds an Update segment, treating @@ locators as neither add nor del', () => {
    const entries = deriveDiffEntries(patch('*** Update File: src/a.ts\n@@ class A\n keep\n-gone\n+added'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ origin: 'reconstructed', part: 0, path: 'src/a.ts' });
    const lines = diffLines(entries[0]?.oldText, entries[0]?.newText);
    expect(lines.filter((l) => l.t === 'add').map((l) => l.x)).toEqual(['added']);
    expect(lines.filter((l) => l.t === 'del').map((l) => l.x)).toEqual(['gone']);
  });

  it('rebuilds an Add segment as pure additions', () => {
    const entries = deriveDiffEntries(patch('*** Add File: new.ts\n+one\n+two'));
    expect(entries[0]?.oldText).toBe('');
    expect(entries[0]?.newText).toBe('one\ntwo');
  });

  it('states a Delete segment without claiming any line counts', () => {
    const entries = deriveDiffEntries(patch('*** Delete File: gone.ts'));
    expect(entries).toEqual([
      { origin: 'reconstructed', part: 0, path: 'gone.ts', oldText: '', newText: '', deleted: true },
    ]);
  });

  it('splits a multi-file patch by segment', () => {
    const entries = deriveDiffEntries(patch('*** Update File: a.ts\n+a\n*** Update File: b.ts\n+b'));
    expect(entries.map((e) => [e.part, e.path])).toEqual([
      [0, 'a.ts'],
      [1, 'b.ts'],
    ]);
  });

  it('drops only the segment holding an unprefixed line, and leaves a gap in part', () => {
    // Real data has this: one Add File segment on this machine carries a line
    // with no prefix. Counting it as context would put it on both sides and
    // report a real addition as +0.
    const entries = deriveDiffEntries(
      patch('*** Update File: a.ts\n+a\n*** Add File: bad.ts\n+ok\nunprefixed\n*** Update File: c.ts\n+c'),
    );
    expect(entries.map((e) => [e.part, e.path])).toEqual([
      [0, 'a.ts'],
      [2, 'c.ts'],
    ]);
  });

  it('produces nothing when the envelope or a file header is missing', () => {
    expect(deriveDiffEntries(edit({ patchText: '*** Update File: a.ts\n+a' }))).toEqual([]);
    expect(deriveDiffEntries(patch('no file header here'))).toEqual([]);
  });

  it('does not parse a patch past the size bound', () => {
    const huge = `*** Begin Patch\n*** Add File: big.ts\n${'+x\n'.repeat(4)}${'y'.repeat(PATCH_TEXT_LIMIT)}\n*** End Patch`;
    expect(deriveDiffEntries(edit({ patchText: huge }))).toEqual([]);
  });
});

describe('deriveDiffEntries — malformed input produces nothing', () => {
  it('rejects a native diff block whose texts are not strings', () => {
    // Same standard as rawInput: diffLines would coerce `undefined` into a
    // plausible one-line deletion, and the page would show a diff nobody sent.
    expect(deriveDiffEntries({ content: [{ type: 'diff', path: 'a.ts', oldText: undefined, newText: 'x' }] })).toEqual([]);
    expect(
      deriveDiffEntries({
        content: [
          { type: 'diff', path: 'a.ts', oldText: 'a', newText: 'b' },
          { type: 'diff', path: 'b.ts', oldText: 'a', newText: 42 },
        ],
      }),
    ).toEqual([]);
  });

  it('does not fall back to rawInput when the native block is the malformed part', () => {
    // "No diff block" and "a diff block I refuse to read" are different
    // answers. Treating them alike lets a call whose engine-stated diff was
    // rejected come back as a rebuilt one — quietly downgrading the engine's
    // own claim into ours.
    expect(
      deriveDiffEntries(
        edit(
          { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] },
          { content: [{ type: 'diff', path: 'a.ts', oldText: undefined, newText: 'x' }] },
        ),
      ),
    ).toEqual([]);
  });

  it('rejects a Delete segment that carries body lines', () => {
    // The format says a deletion carries no lines. One that does is not the
    // shape being read, and emitting `deleted` for it would state something
    // about a file on the strength of a patch we did not understand.
    expect(
      deriveDiffEntries(edit({ patchText: '*** Begin Patch\n*** Delete File: a.ts\n+unexpected\n*** End Patch' })),
    ).toEqual([]);
  });

  it('rejects a path that is present but not a usable string', () => {
    // Absent is fine — an entry can be pathless. Present-but-wrong is not: it
    // says this is not the shape being read.
    expect(deriveDiffEntries({ content: [{ type: 'diff', path: 42, oldText: 'a', newText: 'b' }] })).toEqual([]);
    expect(deriveDiffEntries(edit({ path: 42, edits: [{ oldText: 'a', newText: 'b' }] }))).toEqual([]);
    // Absent path with no locations: still derived, just pathless.
    expect(deriveDiffEntries({ content: [{ type: 'diff', oldText: 'a', newText: 'b' }] })).toHaveLength(1);
    // The fallback is held to the same standard as the field it stands in for.
    expect(
      deriveDiffEntries({ rawInput: { edits: [{ oldText: 'a', newText: 'b' }] }, locations: [{ path: 42 }] }),
    ).toEqual([]);
  });

  it('rejects a decorated envelope marker', () => {
    expect(
      deriveDiffEntries(edit({ patchText: '*** Begin Patch extra\n*** Update File: a.ts\n+x\n*** End Patch' })),
    ).toEqual([]);
  });

  it('requires a closed patch envelope', () => {
    // A truncated patch is not a patch: what came through may be a prefix of
    // something larger, and half a patch renders as a confident whole one.
    expect(deriveDiffEntries(edit({ patchText: '*** Begin Patch\n*** Update File: a.ts\n+x' }))).toEqual([]);
  });

  it('rejects an envelope whose markers are out of order', () => {
    expect(
      deriveDiffEntries(edit({ patchText: '*** End Patch\n*** Begin Patch\n*** Update File: a.ts\n+x' })),
    ).toEqual([]);
  });

  it('rejects content sitting outside any file segment', () => {
    // A locator or a stray line before the first file header means this is not
    // the shape being read, and guessing which file it belonged to is exactly
    // the confident wrong answer the rule forbids.
    expect(
      deriveDiffEntries(edit({ patchText: '*** Begin Patch\n@@ outside\n*** Update File: a.ts\n+x\n*** End Patch' })),
    ).toEqual([]);
  });

  it('rejects an unknown *** marker inside the envelope', () => {
    expect(
      deriveDiffEntries(edit({ patchText: '*** Begin Patch\n*** Move File: a.ts\n+x\n*** End Patch' })),
    ).toEqual([]);
  });

  it('drops a segment whose header states no path', () => {
    const entries = deriveDiffEntries(
      edit({ patchText: '*** Begin Patch\n*** Update File:    \n+x\n*** Update File: b.ts\n+y\n*** End Patch' }),
    );
    expect(entries.map((e) => e.path)).toEqual(['b.ts']);
  });

  it('reads a patch with CRLF line endings', () => {
    const entries = deriveDiffEntries(
      edit({ patchText: '*** Begin Patch\r\n*** Add File: a.ts\r\n+one\r\n+two\r\n*** End Patch\r\n' }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.newText).toBe('one\ntwo');
  });
});

describe('deriveDiffEntries — when to read', () => {
  it('reads a pending call and an in_progress one alike', () => {
    // The two engines that need this mostly never reach a terminal status;
    // a terminal gate here would drop them entirely rather than delay them.
    for (const status of ['pending', 'in_progress', 'completed', 'failed']) {
      const entries = deriveDiffEntries(edit({ path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] }, { status }));
      expect(entries, status).toHaveLength(1);
    }
  });
});

describe('derivedEntryKey', () => {
  it('separates parts of one call and joins restatements of the same content', () => {
    const [first, second] = deriveDiffEntries(
      edit({ path: 'a.ts', edits: [{ oldText: 'a', newText: 'A' }, { oldText: 'b', newText: 'B' }] }),
    );
    expect(derivedEntryKey(first!)).not.toBe(derivedEntryKey(second!));

    const again = deriveDiffEntries(edit({ path: 'a.ts', edits: [{ oldText: 'a', newText: 'A' }] }));
    expect(derivedEntryKey(again[0]!)).toBe(derivedEntryKey(first!));
  });

  it('separates a native entry from a rebuilt one with the same content', () => {
    const native = deriveDiffEntries({ content: [{ type: 'diff', path: 'a.ts', oldText: 'a', newText: 'A' }] });
    const rebuilt = deriveDiffEntries(edit({ path: 'a.ts', edits: [{ oldText: 'a', newText: 'A' }] }));
    expect(derivedEntryKey(native[0]!)).not.toBe(derivedEntryKey(rebuilt[0]!));
  });
});
