/**
 * Type declarations for the DOM-free display-row merge (tool-row-state.js).
 * Structural and deliberately loose — the console renders whatever engines
 * report, so entries are records, not the ACP vocabulary types.
 */

export interface ToolRowSnapshot {
  readonly toolCallId: string;
  // ACP nullable fields: null means "no change", matching the folder's patch semantics.
  readonly title?: string | null;
  readonly name?: string | null;
  readonly kind?: string | null;
  readonly status?: string | null;
  readonly content?: readonly Record<string, unknown>[] | null;
  /** The engine's own tool arguments; a diff is rebuilt from these when it sent no diff block (ADR 0021). */
  readonly rawInput?: unknown;
  readonly locations?: readonly Record<string, unknown>[] | null;
  /** Already-derived diffs handed back by a backfilled run; taken as they are, never re-derived. */
  readonly derivedDiffs?: readonly Record<string, unknown>[];
  /**
   * What the fold library derived this call acted on — its own chain output
   * (rawInput > locations > content), taken as-is; this module never re-runs
   * the chain (ADR 0023 §2).
   */
  readonly args?: {
    readonly text: string;
    readonly value?: unknown;
    readonly from: 'rawInput' | 'locations' | 'content';
  };
}

export interface ToolDisplayRow {
  readonly toolCallId: string;
  readonly title?: string;
  readonly name?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly content?: readonly Record<string, unknown>[];
  /**
   * The row's canonical args: `{ text, from }` only, `text` capped at
   * PREVIEW_LIMIT, `value` dropped on entry (ADR 0023 §3.2). Merged across
   * snapshots with no downgrade to a weaker source.
   */
  readonly args?: { readonly text: string; readonly from: 'rawInput' | 'locations' | 'content' };
  /**
   * Diff entries for this call, in two populations that behave differently:
   * engine-reported ones accumulate across snapshots (deduped by path and
   * texts), while ones rebuilt from the engine's edit parameters are whatever
   * the latest snapshot states, and are cleared once the engine reports a diff
   * of its own (ADR 0021).
   */
  readonly diffs: readonly Record<string, unknown>[];
}

export function mergeToolRow(
  previous: ToolDisplayRow | undefined,
  snapshot: ToolRowSnapshot,
): { row: ToolDisplayRow; changed: boolean };

/** Mirrors folded-projection.ts's PREVIEW_LIMIT; kept in value here because ui/ cannot import server code. */
export const PREVIEW_LIMIT = 512 as const;

/**
 * The folded projection's tool-run wire shape (console-v2 §3.2), loose on
 * purpose. The caller passes the whole run, so the run-envelope keys
 * (`kind`, `seqFrom`, `seqTo`) ride along and must be accepted; only the
 * fields below are read.
 */
export interface BackfillToolRun {
  readonly toolCallId?: unknown;
  readonly title?: unknown;
  readonly name?: unknown;
  readonly toolKind?: unknown;
  readonly status?: unknown;
  readonly diffs?: unknown;
  /** The folded run's `{ text, from }` args, translated back into the snapshot (ADR 0023 §3.2). */
  readonly args?: unknown;
  readonly [field: string]: unknown;
}

/** Convert one folded backfill tool run into the mergeToolRow snapshot shape (§3.2 page seam). */
export function backfillToolSnapshot(run: BackfillToolRun): ToolRowSnapshot;

/** Write a merged display row onto a folded tool run, in the wire's field names. */
export function applyToolRunFields<T extends Record<string, unknown>>(run: T, row: ToolDisplayRow | undefined): T;
