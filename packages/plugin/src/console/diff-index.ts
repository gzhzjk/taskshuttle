import type { TranscriptEvent } from 'runskein';

import { deriveDiffEntries, derivedEntryKey, type DerivedDiffEntry } from './ui/diff-sources.js';
import { diffLines } from './ui/diff-lines.js';

/**
 * The in-memory diff index of console-v2 §3.1: one entry per
 * `content[].type === 'diff'` item carried by a `tool_call` /
 * `tool_call_update` event — never the diff content itself. Maintained on the
 * store's post-commit append fan-out (§5.2), so entering the diff view costs
 * O(index size), not O(transcript length).
 *
 * Lifecycle (§3.5, answered before the index was built):
 * - restart / archive: the data source rebuilds a session's index with one
 *   on-demand scan of its events the first time the route is hit;
 * - cap: DIFF_INDEX_LIMIT entries per session; past it the session falls back
 *   to scanning on each request — never a silently truncated list posing as
 *   complete;
 * - transcript_delete: the data source drops the session's index with the
 *   §5.4 invalidation.
 *
 * `adds` / `dels` come from the same diffLines the UI's diff cards use, so the
 * index numbers and the rendered `+a −d` cannot diverge.
 *
 * Since ADR 0021 an entry may also be *reconstructed* — rebuilt from the edit
 * parameters of an engine that never sent a diff block — and says so in
 * `origin`. Two rules follow, both of which need the call id this index already
 * keeps internally and still never puts on the wire:
 *
 * - a call that states a native diff never produces reconstructed entries
 *   again, and any it already produced are removed: the summary sums every
 *   entry without looking at `origin`, so leaving both would not add a row, it
 *   would double the line counts;
 * - a restatement of the same rawInput changes nothing, while a *different*
 *   one replaces the call's whole reconstructed set. Replacing the set rather
 *   than patching it per part is what makes a hunk that disappears from
 *   `edits[]` disappear from the page.
 */

/** §3.5: per-session cap; a constant, not install-surface configuration. */
export const DIFF_INDEX_LIMIT = 1000;

/** One indexed diff. `toolCallId` correlates later status/name patches; it never leaves the process. */
export interface DiffIndexEntry {
  readonly seq: number;
  readonly toolCallId?: string;
  tool?: string;
  path?: string;
  readonly adds: number;
  readonly dels: number;
  status?: string;
  /** Where the diff came from: stated by the engine, or rebuilt from its edit parameters. */
  readonly origin: 'engine' | 'reconstructed';
  /** Position within the carrying event; never renumbered, so a dropped patch segment leaves a gap. */
  readonly part: number;
  /** A patch segment that declared a deletion and carried no lines: no counts are claimed. */
  readonly deleted?: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class DiffIndex {
  /**
   * @param limit - entries kept before `overflow` trips and further appends
   * are refused. The retained list stays at cap size; callers that need the
   * honest full list (the §3.5 on-demand scan) construct with a raised limit.
   */
  constructor(public limit: number = DIFF_INDEX_LIMIT) {}

  private readonly list: DiffIndexEntry[] = [];
  private readonly byToolCall = new Map<string, DiffIndexEntry[]>();
  /** Last tool label seen per call id — updates carrying a diff rarely repeat the title/name. */
  private readonly labels = new Map<string, string>();
  /** Calls that have stated a native diff: they are never rebuilt for again. */
  private readonly nativeCalls = new Set<string>();
  /** The derived keys each call's reconstructed entries currently stand on. */
  private readonly derivedKeys = new Map<string, readonly string[]>();
  private overflowed = false;

  get overflow(): boolean {
    return this.overflowed;
  }

  get size(): number {
    return this.list.length;
  }

  get entries(): readonly DiffIndexEntry[] {
    return this.list;
  }

  /** Index one appended event; a no-op for non-tool events and once overflowed. */
  addEvent(event: TranscriptEvent): void {
    if (this.overflowed) return;
    const update: unknown = event.update;
    if (!isRecord(update)) return;
    const name = update['sessionUpdate'];
    if (name !== 'tool_call' && name !== 'tool_call_update') return;
    const toolCallId = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : undefined;
    const label =
      typeof update['name'] === 'string' ? update['name'] : typeof update['title'] === 'string' ? update['title'] : undefined;
    if (toolCallId !== undefined && label !== undefined) this.labels.set(toolCallId, label);
    const status = typeof update['status'] === 'string' ? update['status'] : undefined;
    // A later patch's status belongs to the entries the call already produced.
    if (toolCallId !== undefined && status !== undefined) {
      for (const entry of this.byToolCall.get(toolCallId) ?? []) entry.status = status;
    }

    const derived = deriveDiffEntries(update);
    if (derived.length === 0) return;
    const native = derived[0]?.origin === 'engine';
    // The latch: an engine that has stated a diff for this call is the
    // authority on it, so nothing is rebuilt for that call afterwards.
    if (!native && toolCallId !== undefined && this.nativeCalls.has(toolCallId)) return;
    if (native && toolCallId !== undefined) this.nativeCalls.add(toolCallId);

    if (toolCallId !== undefined) {
      const keys = derived.map(derivedEntryKey);
      const previous = this.derivedKeys.get(toolCallId);
      // The same rawInput restated — this happens, so it is not defensive
      // coding — must not repaint anything, let alone deal a second row.
      if (!native && previous !== undefined && sameKeys(previous, keys)) return;
      // Anything else supersedes what this call said before: a native diff
      // arriving late, or a different rawInput. Whole set, never per part.
      if (previous !== undefined) this.dropReconstructed(toolCallId);
      this.derivedKeys.set(toolCallId, native ? [] : keys);
    }

    const tool = label ?? (toolCallId === undefined ? undefined : this.labels.get(toolCallId));
    for (const entry of derived) {
      if (this.list.length >= this.limit) {
        this.overflowed = true;
        return;
      }
      this.push(event.seq, toolCallId, tool, status, entry);
    }
  }

  /** One derived entry, in index shape. Counts come from the shared diffLines, as the native path always has. */
  private push(
    seq: number,
    toolCallId: string | undefined,
    tool: string | undefined,
    status: string | undefined,
    derived: DerivedDiffEntry,
  ): void {
    const lines = derived.deleted === true ? [] : diffLines(derived.oldText, derived.newText);
    const entry: DiffIndexEntry = {
      seq,
      ...(toolCallId === undefined ? {} : { toolCallId }),
      ...(tool === undefined ? {} : { tool }),
      ...(derived.path === undefined ? {} : { path: derived.path }),
      adds: lines.filter((line) => line.t === 'add').length,
      dels: lines.filter((line) => line.t === 'del').length,
      ...(status === undefined ? {} : { status }),
      origin: derived.origin,
      part: derived.part,
      ...(derived.deleted === true ? { deleted: true as const } : {}),
    };
    this.list.push(entry);
    if (toolCallId !== undefined) {
      const group = this.byToolCall.get(toolCallId) ?? [];
      group.push(entry);
      this.byToolCall.set(toolCallId, group);
    }
  }

  /** Remove a call's reconstructed entries; its native ones are history and stay. */
  private dropReconstructed(toolCallId: string): void {
    const group = this.byToolCall.get(toolCallId);
    if (group === undefined) return;
    const dropped = new Set(group.filter((entry) => entry.origin === 'reconstructed'));
    if (dropped.size === 0) return;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const entry = this.list[i];
      if (entry !== undefined && dropped.has(entry)) this.list.splice(i, 1);
    }
    const kept = group.filter((entry) => !dropped.has(entry));
    if (kept.length === 0) this.byToolCall.delete(toolCallId);
    else this.byToolCall.set(toolCallId, kept);
  }
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i]);
}

/**
 * The §3.1 wire shape: `{ seq, tool, path, adds, dels, status, origin, part,
 * deleted? }` — no content, no correlation key. Every optional
 * field is spread in or left out rather than set to `undefined`, so the object
 * this returns has exactly the keys it means; `JSON.stringify` would drop an
 * undefined value on its way to the wire, but the object is also read directly
 * (the route's tests, and any in-process consumer), and "absent" and "present
 * and undefined" are not the same object.
 */
export function diffIndexEntryOutput(entry: DiffIndexEntry): Record<string, unknown> {
  return {
    seq: entry.seq,
    ...(entry.tool === undefined ? {} : { tool: entry.tool }),
    ...(entry.path === undefined ? {} : { path: entry.path }),
    adds: entry.adds,
    dels: entry.dels,
    ...(entry.status === undefined ? {} : { status: entry.status }),
    origin: entry.origin,
    part: entry.part,
    ...(entry.deleted === true ? { deleted: true } : {}),
  };
}
