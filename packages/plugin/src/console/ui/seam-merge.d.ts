/**
 * Type declarations for the §3.2 seam rule (seam-merge.js). Structural and
 * deliberately loose — the fragments are whatever the wire or the UI holds.
 */

/** A fragment's identity, as the party joining onto it sees itself. */
export interface FragmentKey {
  readonly kind: string;
  readonly messageId: string | undefined;
  /** True for a run from a folded page; then `openStart` must also be true. */
  readonly fromFoldedPage?: boolean;
  readonly openStart?: unknown;
}

/** The fragment already accumulated: `open` is its `openEnd`. */
export interface AccumulatedFragment {
  readonly kind: string;
  readonly messageId: string | undefined;
  readonly open?: unknown;
}

/** A fragment's content, in whichever half the sender had. */
export interface FragmentContent {
  readonly text?: string | undefined;
  readonly preview?: string | undefined;
  readonly fullBytes?: number | undefined;
}

/** Which run kinds are message streams — the ones the seam rule applies to. */
export function isMessageRunKind(kind: string): boolean;

/** Does `incoming` continue `previous` instead of starting a new message? */
export function continuesRun(previous: AccumulatedFragment | null | undefined, incoming: FragmentKey): boolean;

/** The UI tail-entry form of continuesRun. */
export function continuesOpenRun(tail: unknown, incoming: FragmentKey): boolean;

/** Combine two fragments' content; `text` is undefined when either withheld its own. */
export function joinFragmentContent(
  previous: FragmentContent,
  incoming: FragmentContent,
  previewLimit: number,
): { text: string | undefined; preview: string; fullBytes: number };
