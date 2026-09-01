import { describe, expect, it } from 'vitest';

import {
  beginBackfill,
  createDiffContentCache,
  diffEntryKey,
  groupDiffEntries,
  insertBySeq,
  rememberDiffOwner,
  retractOwnedEntries,
  type DiffEntry,
  type DiffViewState,
} from '../../packages/plugin/src/console/ui/diff-index-view.js';

/**
 * The diff view is fed from two sources at once — live SSE diffs, recorded
 * whether or not the view was opened, and the §3.1 index, backfilled the first
 * time it is. The regression pinned here is arrival-order appending: by the
 * time the view opens it already holds the newest diffs, so the backfill's
 * older ones landed after them and the list showed the session's history below
 * its present.
 */

const entry = (seq: number, path?: string): DiffEntry => ({ seq, adds: 1, dels: 0, ...(path === undefined ? {} : { path }) });

describe('diff index view list discipline (console-v2 §3.1/§4.5)', () => {
  it('places backfilled history before the live diffs already collected', () => {
    const entries: DiffEntry[] = [];
    // What the SSE stream recorded while the user watched the transcript.
    for (const seq of [500, 512, 520]) insertBySeq(entries, entry(seq));
    // What the paged index backfill brings when the Diff tab is first opened.
    for (const seq of [10, 11, 499, 512]) insertBySeq(entries, entry(seq));
    expect(entries.map((item) => item.seq)).toEqual([10, 11, 499, 500, 512, 512, 520]);
  });

  it('appends a new live diff at the end — it always carries the highest seq', () => {
    const entries: DiffEntry[] = [entry(1), entry(4)];
    expect(insertBySeq(entries, entry(9))).toBe(2);
    expect(entries.map((item) => item.seq)).toEqual([1, 4, 9]);
  });

  it('keeps the diffs of one event together, in the order the event listed them', () => {
    const entries: DiffEntry[] = [entry(3, 'a.ts'), entry(3, 'b.ts')];
    insertBySeq(entries, entry(2, 'z.ts'));
    expect(entries.map((item) => `${item.seq}:${String(item.path)}`)).toEqual(['2:z.ts', '3:a.ts', '3:b.ts']);
  });

  it('identifies an entry by seq, path and counts, so the two sources deduplicate', () => {
    expect(diffEntryKey(entry(3, 'a.ts'))).toBe(diffEntryKey({ seq: 3, path: 'a.ts', adds: 1, dels: 0, tool: 'edit' }));
    expect(diffEntryKey(entry(3, 'a.ts'))).not.toBe(diffEntryKey(entry(3, 'b.ts')));
    expect(diffEntryKey(entry(3))).not.toBe(diffEntryKey(entry(4)));
  });
});

describe('diff view file grouping (console-v2 §4.5)', () => {
  /**
   * The flat seq-ordered list rendered one row per edit, so a file edited ten
   * times occupied ten rows repeating the same path. Grouping is a render-time
   * derivation over that list: the model stays flat (identity, dedup and ADR
   * 0021 supersession are untouched), and only the drawing groups by path.
   */

  it('groups entries by path, first appearance first, seq order inside', () => {
    const groups = groupDiffEntries([
      { seq: 5, path: 'a.ts', adds: 1, dels: 0 },
      { seq: 7, path: 'b.ts', adds: 2, dels: 1 },
      { seq: 9, path: 'a.ts', adds: 3, dels: 2 },
    ]);
    expect(groups.map((g) => g.path)).toEqual(['a.ts', 'b.ts']);
    expect(groups[0]?.entries.map((e) => e.seq)).toEqual([5, 9]);
    expect(groups[1]?.entries.map((e) => e.seq)).toEqual([7]);
  });

  it('sums each group the way the summary row sums the whole list', () => {
    const groups = groupDiffEntries([
      { seq: 5, path: 'a.ts', adds: 1, dels: 0 },
      { seq: 9, path: 'a.ts', adds: 3, dels: 2 },
      // A deletion entry states no line counts; it contributes 0, matching
      // renderDiffSummary's convention.
      { seq: 11, path: 'a.ts', adds: 0, dels: 0, deleted: true },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ adds: 4, dels: 2 });
  });

  it('collects pathless entries into one group keyed by the empty path', () => {
    // The wire allows a pathless diff; dropping it here would remove it from
    // the page while renderDiffSummary still counts it.
    const groups = groupDiffEntries([
      { seq: 5, adds: 1, dels: 0 },
      { seq: 7, path: 'a.ts', adds: 1, dels: 1 },
      { seq: 9, adds: 2, dels: 0 },
    ]);
    expect(groups.map((g) => g.path)).toEqual(['', 'a.ts']);
    expect(groups[0]?.entries.map((e) => e.seq)).toEqual([5, 9]);
  });

  it('returns no groups for an empty list', () => {
    expect(groupDiffEntries([])).toEqual([]);
  });
});

describe('diff content cache (console-v2 §4.5)', () => {
  /**
   * Every live diff arrives with its full oldText/newText and used to be kept
   * for the session's whole life — a second copy of text the transcript's own
   * tool rows already hold. The regression pinned here is that unbounded
   * growth; what an evicted body costs is one single-event fetch, which §4.5
   * already routes expansion through.
   */
  it('keeps at most `limit` events and evicts the least recently used', () => {
    const cache = createDiffContentCache(3);
    for (const seq of [1, 2, 3]) cache.set(seq, [{ seq }]);
    expect(cache.size).toBe(3);
    // Touching 1 makes 2 the oldest, so 4 evicts 2 rather than 1.
    expect(cache.get(1)).toEqual([{ seq: 1 }]);
    cache.set(4, [{ seq: 4 }]);
    expect(cache.size).toBe(3);
    expect(cache.get(2)).toBeUndefined();
    expect(cache.get(1)).toEqual([{ seq: 1 }]);
    expect(cache.get(3)).toEqual([{ seq: 3 }]);
    expect(cache.get(4)).toEqual([{ seq: 4 }]);
  });

  it('re-setting a held seq refreshes it without growing the cache', () => {
    const cache = createDiffContentCache(2);
    cache.set(1, [{ v: 'old' }]);
    cache.set(2, [{ v: 'b' }]);
    cache.set(1, [{ v: 'new' }]);
    expect(cache.size).toBe(2);
    expect(cache.get(1)).toEqual([{ v: 'new' }]);
    // 1 was refreshed, so the next insert evicts 2.
    cache.set(3, [{ v: 'c' }]);
    expect(cache.get(2)).toBeUndefined();
    expect(cache.get(1)).toEqual([{ v: 'new' }]);
  });

  it('clear empties it — a session switch keeps nothing from the last one', () => {
    const cache = createDiffContentCache(5);
    cache.set(1, [{}]);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get(1)).toBeUndefined();
  });
});

describe('diff view supersession (ADR 0021)', () => {
  const view = (): DiffViewState => ({ entries: [], keys: new Set(), retracted: new Set(), owners: new Map(), generation: 0 });
  const entry = (seq: number, path: string, part = 0, origin = 'reconstructed'): DiffEntry => ({ seq, path, part, origin, adds: 1, dels: 0 });

  const insert = (v: DiffViewState, e: DiffEntry) => {
    const key = diffEntryKey(e);
    v.keys.add(key);
    insertBySeq(v.entries, e);
    return key;
  };

  it('withdraws an entry the live path inserted, and remembers that it did', () => {
    const v = view();
    const e = entry(3, 'a.ts');
    const wireKey = insert(v, e);
    rememberDiffOwner(v, 'tc1', 'display-a', wireKey);

    const { removed, unlocated } = retractOwnedEntries(v, 'tc1', ['display-a']);
    expect(removed).toEqual([wireKey]);
    expect(unlocated).toBe(false);
    expect(v.entries).toEqual([]);
    expect(v.keys.has(wireKey)).toBe(false);
    // The tombstone is the point: the entry is gone AND cannot come back.
    expect(v.retracted.has(wireKey)).toBe(true);
  });

  it('reports an entry it cannot locate rather than silently doing nothing', () => {
    // This is the backfilled entry: no owner was ever recorded for it, so the
    // caller has to refetch instead of pretending the withdrawal happened.
    const v = view();
    insert(v, entry(3, 'a.ts'));
    const { removed, unlocated } = retractOwnedEntries(v, 'tc1', ['display-a']);
    expect(removed).toEqual([]);
    expect(unlocated).toBe(true);
    expect(v.entries).toHaveLength(1);
  });

  it('separates two calls that both have rebuilt entries', () => {
    const v = view();
    const first = insert(v, entry(3, 'a.ts'));
    const second = insert(v, entry(4, 'b.ts'));
    rememberDiffOwner(v, 'tc1', 'display-a', first);
    rememberDiffOwner(v, 'tc2', 'display-b', second);

    const { removed } = retractOwnedEntries(v, 'tc1', ['display-a']);
    expect(removed).toEqual([first]);
    expect(v.entries.map((e) => e.path)).toEqual(['b.ts']);
  });

  it('empties the view and moves the generation on when a backfill starts', () => {
    const v = view();
    const key = insert(v, entry(3, 'a.ts'));
    rememberDiffOwner(v, 'tc1', 'display-a', key);
    v.retracted.add('stale');

    const generation = beginBackfill(v);
    expect(generation).toBe(1);
    // Everything goes: a refetch that only appended would keep exactly the
    // rows it was run to drop, and stale tombstones would block rows the
    // server legitimately still has.
    expect(v.entries).toEqual([]);
    expect(v.keys.size).toBe(0);
    expect(v.retracted.size).toBe(0);
    expect(v.owners.size).toBe(0);
    expect(beginBackfill(v)).toBe(2);
  });
});
