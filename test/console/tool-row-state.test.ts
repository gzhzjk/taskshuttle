import { describe, expect, it } from 'vitest';

import { applyToolRunFields, backfillToolSnapshot, mergeToolRow } from '../../packages/plugin/src/console/ui/tool-row-state.js';

/**
 * The diff-view regression behind ADR 0006's §10 rebuild: fold's whole-array
 * content replacement and terminal-row eviction are wire-faithful, but the
 * console's diff view accumulated `content[].type === 'diff'` entries across
 * the raw stream before folding existed. mergeToolRow restores that display
 * semantic without touching the vendored folder.
 */

const DIFF = { type: 'diff', path: 'src/foo.ts', oldText: 'const b = 2;', newText: 'const b = 3;' };
const TEXT = { type: 'content', content: { type: 'text', text: 'Success' } };

/**
 * What a content block becomes once merged: since ADR 0021 the row holds the
 * DERIVED entry, which states where it came from and its position in the
 * carrying event. Native blocks keep their fields and gain those two.
 */
const asMerged = (diff: Record<string, unknown>, part = 0) => ({ ...diff, origin: 'engine', part });

describe('mergeToolRow (console diff view, ADR 0006)', () => {
  it('keeps a diff when a later update replaces content with text output', () => {
    const first = mergeToolRow(undefined, { toolCallId: 'tc1', title: 'Edit', kind: 'edit', status: 'in_progress' });
    const withDiff = mergeToolRow(first.row, { toolCallId: 'tc1', status: 'completed', content: [DIFF] });
    expect(withDiff.row.diffs).toEqual([asMerged(DIFF)]);
    // The pattern that used to kill the diff: a post-completion update whose
    // content is the tool's text output, whole-array replacing the diff.
    const afterText = mergeToolRow(withDiff.row, { toolCallId: 'tc1', content: [TEXT] });
    expect(afterText.row.diffs).toEqual([asMerged(DIFF)]);
    expect(afterText.row.content).toEqual([TEXT]);
  });

  it('a late update after terminal eviction merges into the kept row instead of blanking it', () => {
    const first = mergeToolRow(undefined, { toolCallId: 'tc1', title: 'Edit', kind: 'edit', status: 'completed', content: [DIFF] });
    // The folder evicts terminal rows, so this update arrives as a fresh
    // partial snapshot: no title, no kind, no diff.
    const late = mergeToolRow(first.row, { toolCallId: 'tc1', status: 'completed', content: [TEXT] });
    expect(late.row.title).toBe('Edit');
    expect(late.row.kind).toBe('edit');
    expect(late.row.diffs).toEqual([asMerged(DIFF)]);
  });

  it('accumulates distinct diffs and dedupes the same diff reported twice', () => {
    const other = { type: 'diff', path: 'src/bar.ts', oldText: 'x', newText: 'y' };
    let acc = mergeToolRow(undefined, { toolCallId: 'tc1', content: [DIFF] }).row;
    acc = mergeToolRow(acc, { toolCallId: 'tc1', content: [other] }).row;
    // A reconnect replays the first snapshot: same diff, reported again.
    acc = mergeToolRow(acc, { toolCallId: 'tc1', content: [DIFF, other] }).row;
    expect(acc.diffs).toEqual([asMerged(DIFF), asMerged(other)]);
  });

  it('marks only display-relevant changes as changed', () => {
    const first = mergeToolRow(undefined, { toolCallId: 'tc1', title: 'Edit', status: 'in_progress' });
    expect(first.changed).toBe(true);
    // Text-only content: nothing the card renders changed.
    expect(mergeToolRow(first.row, { toolCallId: 'tc1', content: [TEXT] }).changed).toBe(false);
    // A status flip and a new diff both dirty the card.
    expect(mergeToolRow(first.row, { toolCallId: 'tc1', status: 'completed' }).changed).toBe(true);
    expect(mergeToolRow(first.row, { toolCallId: 'tc1', content: [DIFF] }).changed).toBe(true);
  });

  it('a snapshot may null a nullable field; null means no change, not erasure', () => {
    const first = mergeToolRow(undefined, { toolCallId: 'tc1', title: 'Edit' });
    const nulled = mergeToolRow(first.row, { toolCallId: 'tc1', title: null });
    expect(nulled.row.title).toBe('Edit');
  });
});

/**
 * The UI side of the §3.2 page seam for tool runs (M1 of the console-v2
 * review): the server folds every page with a fresh RunAssembler, so a tool
 * call cut by the page boundary arrives as one folded run per page. The UI
 * merges them by toolCallId through the same mergeToolRow the live path uses
 * — the regression being pinned is the earlier behavior, which placed every
 * page's run as a new card whose title degenerated to the bare toolCallId.
 */
describe('mergeToolRow — rebuilt diffs (ADR 0021)', () => {
  const RAW = { path: 'src/a.ts', edits: [{ oldText: 'one', newText: 'two' }] };

  it('rebuilds a diff from edit parameters when no diff block was sent', () => {
    const { row } = mergeToolRow(undefined, { toolCallId: 'tc1', title: 'edit', status: 'pending', rawInput: RAW });
    expect(row.diffs).toEqual([
      { type: 'diff', origin: 'reconstructed', part: 0, path: 'src/a.ts', oldText: 'one', newText: 'two' },
    ]);
  });

  it('drops what it rebuilt once the engine sends a diff of its own', () => {
    // row.diffs otherwise only ever accumulates — that exemption is for diffs
    // the engine reported, not for stand-ins we drew from its parameters.
    const first = mergeToolRow(undefined, { toolCallId: 'tc1', title: 'edit', status: 'pending', rawInput: RAW });
    expect(first.row.diffs).toHaveLength(1);
    const second = mergeToolRow(first.row, {
      toolCallId: 'tc1',
      status: 'completed',
      content: [{ type: 'diff', path: 'src/a.ts', oldText: 'one', newText: 'two' }],
    });
    expect(second.row.diffs).toEqual([
      { type: 'diff', origin: 'engine', part: 0, path: 'src/a.ts', oldText: 'one', newText: 'two' },
    ]);
    expect(second.changed).toBe(true);
  });

  it('does not relabel a rebuilt diff as the engine own diff when a page is backfilled', () => {
    // The backfill path feeds a run's already-derived diffs back through the
    // merge. Re-deriving them as content would stamp every one 'engine' — the
    // page would credit the engine with a diff it never sent, which is the one
    // thing ADR 0021 exists to prevent, and it would happen on every refresh.
    const live = mergeToolRow(undefined, {
      toolCallId: 'tc1',
      title: 'edit',
      status: 'pending',
      rawInput: { path: 'a.ts', edits: [{ oldText: 'one', newText: 'two' }] },
    });
    const backfilled = mergeToolRow(
      undefined,
      backfillToolSnapshot({ toolCallId: 'tc1', title: 'edit', status: 'pending', diffs: live.row.diffs }),
    );
    expect(backfilled.row.diffs).toEqual(live.row.diffs);
    expect(backfilled.row.diffs[0]?.origin).toBe('reconstructed');
  });

  it('replaces a call rebuilt set rather than accumulating it', () => {
    // The whole point of whole-set recomputation: a hunk the engine stops
    // claiming has to leave the row, and per-entry accumulation cannot express
    // that. Without this, [A,B] followed by [A,C] renders A, B and C.
    const first = mergeToolRow(undefined, {
      toolCallId: 'tc1',
      title: 'edit',
      rawInput: { path: 'a.ts', edits: [{ oldText: 'a', newText: 'A' }, { oldText: 'b', newText: 'B' }] },
    });
    const second = mergeToolRow(first.row, {
      toolCallId: 'tc1',
      rawInput: { path: 'a.ts', edits: [{ oldText: 'a', newText: 'A' }, { oldText: 'c', newText: 'C' }] },
    });
    expect(second.row.diffs.map((entry) => entry.newText)).toEqual(['A', 'C']);
    expect(second.changed).toBe(true);
  });

  it('keeps the rebuilt set when a later snapshot says nothing about it', () => {
    // A status-only patch must not be read as "the engine withdrew its edits".
    const first = mergeToolRow(undefined, {
      toolCallId: 'tc1',
      title: 'edit',
      rawInput: { path: 'a.ts', edits: [{ oldText: 'a', newText: 'A' }] },
    });
    const second = mergeToolRow(first.row, { toolCallId: 'tc1', status: 'completed' });
    expect(second.row.diffs).toHaveLength(1);
  });

  it('does not rebuild for a call that already stated a native diff', () => {
    // The latch, in the order the server already handles and this did not:
    // native first, rawInput after. Without it the row shows the engine's diff
    // and our stand-in for the same edit, side by side.
    const first = mergeToolRow(undefined, {
      toolCallId: 'tc1',
      title: 'edit',
      content: [{ type: 'diff', path: 'a.ts', oldText: 'a', newText: 'A' }],
    });
    const second = mergeToolRow(first.row, {
      toolCallId: 'tc1',
      rawInput: { path: 'a.ts', edits: [{ oldText: 'a', newText: 'A' }] },
    });
    expect(second.row.diffs).toHaveLength(1);
    expect(second.row.diffs[0]?.origin).toBe('engine');
  });

  it('tells a deleted file apart from an edit that changed no lines', () => {
    // Both carry zero counts; only `deleted` separates them, so it has to be
    // part of identity or the row silently keeps the wrong one.
    const first = mergeToolRow(undefined, {
      toolCallId: 'tc1',
      rawInput: { patchText: '*** Begin Patch\n*** Delete File: a.ts\n*** End Patch' },
    });
    expect(first.row.diffs[0]?.deleted).toBe(true);
    const second = mergeToolRow(first.row, {
      toolCallId: 'tc1',
      rawInput: { path: 'a.ts', edits: [{ oldText: 'same', newText: 'same' }] },
    });
    expect(second.row.diffs[0]?.deleted).toBeUndefined();
    expect(second.changed).toBe(true);
  });

  it('keeps two identical hunks of one call as two rows', () => {
    const { row } = mergeToolRow(undefined, {
      toolCallId: 'tc1',
      rawInput: { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }, { oldText: 'x', newText: 'y' }] },
    });
    expect(row.diffs).toHaveLength(2);
  });

  it('keeps two identical native blocks of one event as two rows', () => {
    // The server index keeps both. If the row collapses them, the diff page
    // and the transcript card disagree about the same event — and the page
    // that shows fewer is the one that is wrong.
    const { row } = mergeToolRow(undefined, {
      toolCallId: 'tc1',
      content: [
        { type: 'diff', path: 'a.ts', oldText: 'x', newText: 'y' },
        { type: 'diff', path: 'a.ts', oldText: 'x', newText: 'y' },
      ],
    });
    expect(row.diffs).toHaveLength(2);
  });

  it('grows to the largest count any one snapshot claimed', () => {
    // One A already accumulated, then a snapshot claiming two: the second is a
    // sibling, not a replay, and dedup by identity alone cannot tell the
    // difference. Counting can.
    const D = { type: 'diff', path: 'a.ts', oldText: 'x', newText: 'y' };
    const first = mergeToolRow(undefined, { toolCallId: 'tc1', content: [D] });
    const second = mergeToolRow(first.row, { toolCallId: 'tc1', content: [D, D] });
    expect(second.row.diffs).toHaveLength(2);
    // ...and a later replay of the same two does not make it four.
    const third = mergeToolRow(second.row, { toolCallId: 'tc1', content: [D, D] });
    expect(third.row.diffs).toHaveLength(2);
  });

  it('notices a deleted file becoming an edit that changed nothing', () => {
    // Both carry empty texts and zero counts; `deleted` is the only thing that
    // differs, so without it in the key `changed` stays false and the card
    // keeps rendering "deleted" for an entry that is no longer a deletion.
    const first = mergeToolRow(undefined, {
      toolCallId: 'tc1',
      rawInput: { patchText: '*** Begin Patch\n*** Delete File: a.ts\n*** End Patch' },
    });
    const second = mergeToolRow(first.row, {
      toolCallId: 'tc1',
      rawInput: { path: 'a.ts', edits: [{ oldText: '', newText: '' }] },
    });
    expect(second.changed).toBe(true);
    expect(second.row.diffs[0]?.deleted).toBeUndefined();
  });

  it('keeps a native diff when a later update carries only text output', () => {
    // The reason the accumulate-only rule exists in the first place: an agent
    // reporting a diff and then replacing content with "Success" must not lose
    // the diff. Clearing rebuilt entries must not have broken that.
    const withDiff = mergeToolRow(undefined, {
      toolCallId: 'tc1',
      status: 'in_progress',
      content: [{ type: 'diff', path: 'a.ts', oldText: 'x', newText: 'y' }],
    });
    const afterText = mergeToolRow(withDiff.row, {
      toolCallId: 'tc1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'Success' } }],
    });
    expect(afterText.row.diffs).toHaveLength(1);
  });
});

describe('backfillToolSnapshot (console-v2 §3.2 page seam)', () => {
  const OTHER_DIFF = { type: 'diff', path: 'src/bar.ts', oldText: 'x', newText: 'y' };

  it('translates the folded wire shape: toolKind → kind, diffs ride under their own key, ids stringify', () => {
    expect(backfillToolSnapshot({ kind: 'tool', toolCallId: 7, seqFrom: 4, seqTo: 5, title: 'Edit', toolKind: 'edit', status: 'completed', diffs: [DIFF] }))
      .toEqual({ toolCallId: '7', title: 'Edit', kind: 'edit', status: 'completed', derivedDiffs: [DIFF] });
    // `derivedDiffs`, not `content`: these entries were derived once already and
    // carry their own origin, so re-deriving them would credit the engine with
    // any that were rebuilt (ADR 0021).
    // Absent fields stay absent; an empty diff list carries nothing.
    expect(backfillToolSnapshot({ toolCallId: 'tc2' })).toEqual({ toolCallId: 'tc2' });
  });

  it('a later page’s partial run merges into the same call’s row — fields complete, diffs union', () => {
    // Page 1: the call ran to completion with a diff.
    const first = mergeToolRow(undefined, backfillToolSnapshot({
      kind: 'tool', toolCallId: 'tc1', seqFrom: 4, seqTo: 5, title: 'Edit', name: 'edit', toolKind: 'edit', status: 'completed', diffs: [DIFF],
    }));
    // Page 2: the cold-started page folder saw only a late update — a partial
    // run with no title/name/kind and one more diff.
    const merged = mergeToolRow(first.row, backfillToolSnapshot({
      kind: 'tool', toolCallId: 'tc1', seqFrom: 16, seqTo: 16, status: 'completed', diffs: [OTHER_DIFF],
    }));
    expect(merged.changed).toBe(true);
    expect(merged.row.title).toBe('Edit');
    expect(merged.row.name).toBe('edit');
    expect(merged.row.kind).toBe('edit');
    expect(merged.row.diffs).toEqual([asMerged(DIFF), asMerged(OTHER_DIFF)]);
  });

  it('a fragment repeating only what the row already knows dirties nothing', () => {
    const first = mergeToolRow(undefined, backfillToolSnapshot({ toolCallId: 'tc1', title: 'Edit', status: 'completed', diffs: [DIFF] }));
    const replay = mergeToolRow(first.row, backfillToolSnapshot({ toolCallId: 'tc1', status: 'completed', diffs: [DIFF] }));
    expect(replay.row.diffs).toEqual([asMerged(DIFF)]);
    expect(replay.changed).toBe(false);
  });
});

describe('mergeToolRow — args (ADR 0023)', () => {
  const ARGS = (text: string, from: 'rawInput' | 'locations' | 'content') => ({ text, from });

  it('carries { text, from } into the row and drops value at entry', () => {
    const merged = mergeToolRow(undefined, {
      toolCallId: 'tc1',
      args: { text: 'npm test', value: { command: 'npm test' }, from: 'rawInput' },
    });
    expect(merged.row.args).toEqual({ text: 'npm test', from: 'rawInput' });
    expect('value' in (merged.row.args ?? {})).toBe(false);
  });

  it('each level of the chain survives the round trip with its origin', () => {
    for (const from of ['rawInput', 'locations', 'content'] as const) {
      const merged = mergeToolRow(undefined, { toolCallId: 'tc1', args: { text: `via ${from}`, from } });
      expect(merged.row.args).toEqual({ text: `via ${from}`, from });
    }
  });

  it('no level hit means no args — absence is a normal state, not an error', () => {
    const merged = mergeToolRow(undefined, { toolCallId: 'tc1', status: 'completed' });
    expect(merged.row.args).toBeUndefined();
  });

  it('truncates text to PREVIEW_LIMIT and truncation is idempotent on the canonical value', async () => {
    const { PREVIEW_LIMIT } = await import('../../packages/plugin/src/console/ui/tool-row-state.js');
    const long = 'x'.repeat(PREVIEW_LIMIT + 50);
    const row = mergeToolRow(undefined, { toolCallId: 'tc1', args: { text: long, from: 'rawInput' } }).row;
    expect(row.args?.text).toHaveLength(PREVIEW_LIMIT);
    // Re-merging an already-truncated statement of the same source changes
    // nothing — repeated projection must not produce different values.
    const again = mergeToolRow(row, { toolCallId: 'tc1', args: { text: row.args!.text, from: 'rawInput' } });
    expect(again.row.args).toEqual(row.args);
    expect(again.changed).toBe(false);
  });

  it('rule 1 — absence keeps what stands (the cross-page partial row)', () => {
    const first = mergeToolRow(undefined, { toolCallId: 'tc1', args: ARGS('/tmp/testkit.txt', 'locations') });
    // A page-seam update carries only its identity; its partial row computes
    // no args and states nothing else.
    const merged = mergeToolRow(first.row, { toolCallId: 'tc1' });
    expect(merged.row.args).toEqual({ text: '/tmp/testkit.txt', from: 'locations' });
    expect(merged.changed).toBe(false);
  });

  it('rule 2 — no downgrade: rawInput is not replaced by locations', () => {
    const first = mergeToolRow(undefined, { toolCallId: 'tc1', args: ARGS('rm -rf build/', 'rawInput') });
    const merged = mergeToolRow(first.row, { toolCallId: 'tc1', status: 'completed', args: ARGS('/tmp/elsewhere', 'locations') });
    expect(merged.row.args).toEqual({ text: 'rm -rf build/', from: 'rawInput' });
  });

  it('rule 3 — a stronger source replaces: locations yields to rawInput', () => {
    const first = mergeToolRow(undefined, { toolCallId: 'tc1', args: ARGS('/tmp/before', 'locations') });
    const merged = mergeToolRow(first.row, { toolCallId: 'tc1', status: 'completed', args: ARGS('git status', 'rawInput') });
    expect(merged.row.args).toEqual({ text: 'git status', from: 'rawInput' });
  });

  it('rule 4 — same source, later wins, whatever the text did', () => {
    const first = mergeToolRow(undefined, { toolCallId: 'tc1', args: ARGS('/tmp/a', 'locations') });
    const merged = mergeToolRow(first.row, { toolCallId: 'tc1', status: 'completed', args: ARGS('/tmp/b', 'locations') });
    expect(merged.row.args).toEqual({ text: '/tmp/b', from: 'locations' });
  });

  it('sequence: rawInput → locations → absent → locations still ends on the rawInput args', () => {
    let row = mergeToolRow(undefined, { toolCallId: 'tc1', args: ARGS('cargo build', 'rawInput') }).row;
    row = mergeToolRow(row, { toolCallId: 'tc1', args: ARGS('/tmp/proj', 'locations') }).row;
    row = mergeToolRow(row, { toolCallId: 'tc1', status: 'running' }).row;
    row = mergeToolRow(row, { toolCallId: 'tc1', status: 'completed', args: ARGS('/tmp/proj', 'locations') }).row;
    expect(row.args).toEqual({ text: 'cargo build', from: 'rawInput' });
  });

  it('(text, from) equality, not identity, decides changed — equal args dirty nothing', () => {
    const first = mergeToolRow(undefined, { toolCallId: 'tc1', args: ARGS('/tmp/x', 'locations') });
    const replay = mergeToolRow(first.row, { toolCallId: 'tc1', args: { text: '/tmp/x', from: 'locations' } });
    expect(replay.changed).toBe(false);
  });

  it('malformed args ride as absence and never enter the row', () => {
    const held = mergeToolRow(undefined, { toolCallId: 'tc1', args: ARGS('keep me', 'rawInput') }).row;
    for (const bad of [null, 'text', 42, {}, { text: 'no from' }, { from: 'rawInput' }]) {
      const merged = mergeToolRow(held, { toolCallId: 'tc1', args: bad as never });
      expect(merged.row.args).toEqual({ text: 'keep me', from: 'rawInput' });
    }
  });

  it('a from outside the chain is malformed, not rank zero (review finding 1)', () => {
    // An unrecognized source must not enter the row at all — with a bare
    // lookup it would take rank 0 and let any real source overwrite it later,
    // so "unknown" and "weakest" are different failures.
    for (const from of ['toString', 'constructor', '__proto__', '', 'RAWINPUT']) {
      expect(mergeToolRow(undefined, { toolCallId: 'tc1', args: { text: 'x', from } as never }).row.args).toBeUndefined();
    }
    // And once held, an unknown-source sighting keeps what stands.
    const held = mergeToolRow(undefined, { toolCallId: 'tc1', args: ARGS('held', 'locations') }).row;
    expect(mergeToolRow(held, { toolCallId: 'tc1', args: { text: 'x', from: 'toString' } as never }).row.args).toEqual({ text: 'held', from: 'locations' });
  });
});

describe('args across the projection boundary (ADR 0023)', () => {
  it('backfillToolSnapshot translates run.args back into the snapshot shape', () => {
    const snapshot = backfillToolSnapshot({
      kind: 'tool', toolCallId: 'tc9', seqFrom: 1, seqTo: 2, status: 'completed',
      args: { text: 'npm test', from: 'rawInput' },
    });
    expect(snapshot.args).toEqual({ text: 'npm test', from: 'rawInput' });
    // And only those two keys: value leaking through backfill would ride into
    // the display row and then onto the wire.
    expect(snapshot.args === undefined ? [] : Object.keys(snapshot.args)).toEqual(['text', 'from']);
  });

  it('applyToolRunFields writes a copy — rewriting the run cannot reach the row', () => {
    const row = mergeToolRow(undefined, { toolCallId: 'tc1', args: { text: 'npm test', from: 'rawInput' } }).row;
    const run: Record<string, unknown> = { kind: 'tool', seqFrom: 1, seqTo: 2 };
    applyToolRunFields(run, row);
    expect(run['args']).toEqual({ text: 'npm test', from: 'rawInput' });
    const written = run['args'] as Record<string, unknown>;
    written.text = 'tampered';
    expect(row.args).toEqual({ text: 'npm test', from: 'rawInput' });
    // Idempotent under repeated projection: the canonical value wins again.
    applyToolRunFields(run, row);
    expect((run['args'] as Record<string, unknown>).text).toBe('npm test');
  });

  it('two consecutive applyToolRunFields calls are stable — same args value, same serialized run length (review round 2, finding 3)', () => {
    const row = mergeToolRow(undefined, { toolCallId: 'tc1', args: { text: '/tmp/report.md', from: 'locations' } }).row;
    const run: Record<string, unknown> = {};
    applyToolRunFields(run, row);
    const firstArgs = JSON.stringify(run['args']);
    // The whole run's length is what feeds projection byte budgeting — a
    // re-projection that appended or mutated anything would change the wire
    // bytes of an unchanged session page.
    const firstLength = JSON.stringify(run).length;
    applyToolRunFields(run, row);
    expect(JSON.stringify(run['args'])).toBe(firstArgs);
    expect(JSON.stringify(run).length).toBe(firstLength);
  });
});
