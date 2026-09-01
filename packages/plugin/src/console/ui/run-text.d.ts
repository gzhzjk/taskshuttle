/**
 * Type declarations for the truncated-run expansion path (run-text.js).
 * The page is whatever the raw events route returned, so it stays a record.
 */

/** Page the raw projection over `seqFrom..seqTo` and concatenate its text chunks. */
export function composeRunText(
  fetchPage: (afterSeq: number, toSeq: number) => Promise<unknown>,
  seqFrom: number,
  seqTo: number,
): Promise<string>;

/** A message run as the preview policy sees it. */
export interface MessageRunText {
  kind: string;
  text?: string | undefined;
  preview?: string | undefined;
  truncated?: boolean;
  expanded?: boolean;
}

/** Decide whether the run mounts its preview instead of its whole text. */
export function applyPreviewPolicy<T extends MessageRunText>(run: T, previewLimit: number): T;

/**
 * The thought run's display text: trimmed, or '' when nothing is visible.
 * '' for non-thought kinds — the rule never applies to them. The collapsed
 * truncated fallback (in-memory text standing in for a whitespace-only
 * preview) is capped at previewLimit; an expanded truncated run returns its
 * whole trimmed text, since expanding is meant to render everything. The
 * caller hides the block only when this returns '' and the run is not
 * truncated (a truncated run must keep its show-more reachable).
 */
export function thoughtDisplay(run: MessageRunText, previewLimit: number): string;
