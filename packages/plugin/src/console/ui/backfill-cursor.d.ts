/**
 * Type declarations for the backfill resume-cursor rule (backfill-cursor.js).
 * Structural and deliberately loose — the page is whatever the events route
 * returned, so it is a record, not the projected types.
 */

/** Advance the resume cursor over one rendered backfill page (console-v2 §3.2). */
export function renderedSeqAfterPage(renderedSeq: number, page: unknown): number;
