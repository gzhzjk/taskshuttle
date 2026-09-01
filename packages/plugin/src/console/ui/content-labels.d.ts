/**
 * Type declarations for the pure label helpers (content-labels.js, ADR 0023).
 * Inputs are loose on purpose — transcript bytes come from another process
 * and are not assumed well-typed; the functions themselves never throw.
 */

/** What a content block contributes to an event's meta line. */
export interface ContentLabel {
  /** Always a non-empty string; escaping is the caller's job. */
  label: string;
  /** Present only when a `uri` exists to hover. */
  title?: string;
}

export function contentLabel(block: unknown): ContentLabel;

export function noticeLabel(update: unknown): string;

/** What a tool call's args contribute to the card (ADR 0023 §4.1). */
export interface ToolArgsView {
  /** The capped text; escaping is the caller's job. */
  text: string;
  /** Full text for the hover title. */
  title: string;
  /** True only on a standalone card whose args came from level 3 (`content`). */
  inferred: boolean;
}

export function toolArgsView(args: unknown, options?: { inline?: boolean }): ToolArgsView | undefined;
