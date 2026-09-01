/**
 * Type declarations for the diff view's list discipline (diff-index-view.js).
 * Entries come off the §3.1 wire, so the shape stays structural.
 */

/** One diff index entry, as the route projects it. */
export interface DiffEntry {
  readonly seq: number;
  readonly path?: string;
  readonly adds: number;
  readonly dels: number;
  readonly [field: string]: unknown;
}

/** Stable identity of an entry, for deduplicating the two sources. */
export function diffEntryKey(entry: DiffEntry): string;

/** Insert into a seq-ordered list, returning the index used. */
export function insertBySeq(entries: DiffEntry[], entry: DiffEntry): number;

/** One file's group in the diff view: its entries in seq order, plus sums. */
export interface DiffEntryGroup {
  readonly path: string;
  readonly entries: DiffEntry[];
  adds: number;
  dels: number;
}

/** Group a seq-ordered list by path (`''` for pathless), first appearance first. */
export function groupDiffEntries(entries: readonly DiffEntry[]): DiffEntryGroup[];

/** Bounded, least-recently-used store of diff bodies keyed by event seq. */
export interface DiffContentCache {
  get(seq: number): unknown[] | undefined;
  set(seq: number, value: unknown[]): void;
  clear(): void;
  readonly size: number;
}

/** Create the cache with a retention limit in events. */
export function createDiffContentCache(limit: number): DiffContentCache;

/** The mutable diff view state the supersession helpers operate on. */
export interface DiffViewState {
  entries: DiffEntry[];
  keys: Set<string>;
  retracted: Set<string>;
  owners: Map<string, Map<string, string>>;
  generation: number;
  [field: string]: unknown;
}

/** Record which wire entry a call's rebuilt diff became. */
export function rememberDiffOwner(view: DiffViewState, toolCallId: string, displayKey: string, wireKey: string): void;

/** Withdraw a call's rebuilt entries; `unlocated` means the view needs a refetch. */
export function retractOwnedEntries(
  view: DiffViewState,
  toolCallId: string,
  displayKeys: readonly string[],
): { removed: string[]; unlocated: boolean };

/** Empty the view for a fresh backfill and return its generation token. */
export function beginBackfill(view: DiffViewState): number;
