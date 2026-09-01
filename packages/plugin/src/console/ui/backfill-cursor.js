/**
 * The backfill resume cursor (console-v2 §3.2): the last seq the UI actually
 * rendered. A folded page's `highWatermark` is how far the SERVER had got,
 * not how far the page got — paging advances through it page by page, and a
 * failed page request must not move the cursor: the SSE fallback
 * (selectSession's catch) opens the stream at this seq and appendFrame
 * dedups by it, so a cursor parked at the watermark would silently skip the
 * unrendered tail of history. Pure and DOM-free so the rule is unit-testable;
 * app.js feeds it every rendered page.
 */

/**
 * Advance the cursor over one rendered page: folded runs by their `seqTo`,
 * degraded-mode envelope pages (§3.4 — `events`, not `runs`) by event seq.
 * Absent or non-numeric fields move nothing, and the cursor never retreats.
 */
export function renderedSeqAfterPage(renderedSeq, page) {
  let seq = renderedSeq;
  if (Array.isArray(page?.runs)) {
    for (const run of page.runs) {
      if (typeof run?.seqTo === 'number' && run.seqTo > seq) seq = run.seqTo;
    }
    return seq;
  }
  const events = Array.isArray(page?.events) ? page.events : [];
  for (const event of events) {
    if (typeof event?.seq === 'number' && event.seq > seq) seq = event.seq;
  }
  return seq;
}
