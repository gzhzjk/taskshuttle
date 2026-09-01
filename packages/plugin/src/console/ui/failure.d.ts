/**
 * Type declarations for the failure-rendering rule (failure.js,
 * console-design §10.0). The union types are the ones §10.0 specifies, so a
 * caller passing an operation that is not in the table fails to compile.
 */

export type FailureOperation = 'backfillFolded' | 'sessionRead' | 'collections' | 'topology' | 'instance';

export type FailureOutcome =
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'network' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'aborted' };

export type Rendering =
  | { readonly render: 'none' }
  | { readonly render: 'rawFallback' }
  | { readonly render: 'invalidated' }
  | { readonly render: 'row'; readonly reason: string }
  | { readonly render: 'pill'; readonly reason: string };

export interface FailureSink {
  readonly row: (reason: string) => void;
  readonly pill: (reason: string) => void;
  readonly invalidated: () => void;
  readonly rawFallback: () => void;
}

export interface Suppression {
  /** Mark the next CLOSED on this stream as the caller's own close(). */
  readonly markDeliberate: () => void;
  readonly deliberate: boolean;
}

/** WHATWG server-sent-events readyState values. */
export const CONNECTING: 0;
export const OPEN: 1;
export const CLOSED: 2;

/** Decide what an operation's outcome must render (§10.0's table, row by row). */
export function classifyFailure(outcome: FailureOutcome, operation: FailureOperation): Rendering;

/** Classify a fetch outcome and drive the one sink writer it names. */
export function handleFetchFailure(outcome: FailureOutcome, operation: FailureOperation, sink: FailureSink): Rendering;

/** One stream's own "this close was ours" flag; never shared between streams. */
export function createSuppression(): Suppression;

export interface RowLedger {
  /** Remember that `reader` failed under this row's key. */
  readonly fail: (operation: string, reader: string) => void;
  /** Forget one reader; true when no other reader behind that row is still failed. */
  readonly recover: (operation: string, reader: string) => boolean;
  readonly clear: () => void;
}

/** Tracks which reads behind each shared row are still failed (§10.0). */
export function createRowLedger(): RowLedger;

/** Render a terminal EventSource failure; a browser still retrying renders nothing. */
export function handleStreamError(
  stream: { readonly readyState: number },
  suppression: Suppression,
  scope: 'session' | 'instance',
  sink: FailureSink,
): { readonly render: 'none' | 'row' | 'pill' };
