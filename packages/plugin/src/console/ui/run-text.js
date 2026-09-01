/**
 * A message run's text: which part of it the DOM carries, and how the rest is
 * fetched when the server only sent a preview (console-v2 §3.2/§4.1).
 *
 * Paging is the whole point. A run long enough to be truncated is a run of
 * many chunk events — §2's motivating case is a 30 000-character thought,
 * which streams as hundreds of them — so one response (the events route's
 * 100-event limit, or the byte budget before it) routinely carries only its
 * head. Taking that head as the full text is worse than not expanding at all:
 * `show more` would present a cut-off message as the complete one, and the
 * recomputed `truncated`/`preview` would agree with it.
 *
 * `hasMore` on a toSeq-bounded page reports the real watermark rather than the
 * interval's end, so it cannot be the loop's bound; the cursor passing seqTo
 * is. Pure apart from the injected fetcher, so the paging rule is testable
 * without a DOM or a server.
 */

/**
 * @param fetchPage - `(afterSeq, toSeq) => Promise<page>` over the raw events
 * route; a rejected page propagates rather than yielding a partial text.
 * @param seqFrom - first seq of the run's interval (inclusive).
 * @param seqTo - last seq of the run's interval (inclusive).
 * @returns the concatenated text of every text chunk in `seqFrom..seqTo`.
 * @throws whatever `fetchPage` rejects with.
 */
export async function composeRunText(fetchPage, seqFrom, seqTo) {
  let text = '';
  let afterSeq = seqFrom - 1;
  while (afterSeq < seqTo) {
    const page = await fetchPage(afterSeq, seqTo);
    for (const ev of page?.events ?? []) {
      const content = ev?.update?.content;
      if (content?.type === 'text' && typeof content.text === 'string') text += content.text;
    }
    const next = typeof page?.nextSeq === 'number' ? page.nextSeq - 1 : afterSeq;
    if (next <= afterSeq) break; // no forward progress — the interval is spent
    afterSeq = next;
  }
  return text;
}

/**
 * Decide whether a run mounts its preview instead of its whole text.
 *
 * Thought runs only. §4.1 asks for the preview device there and says why —
 * a thought clamps to two lines, so the DOM carries the preview and the full
 * text stays in memory. It is NOT a rule about long messages: applied to agent
 * and user runs it put every answer past the preview cap behind a "show more"
 * no section asks for, and an agent's answer is the console's primary content.
 *
 * Whether expanding needs a network fetch is a separate question with its own
 * answer — `text === undefined`, which only the backfill path produces.
 * @param run - the message run, mutated in place.
 * @param previewLimit - the preview cap in characters.
 * @returns the same run.
 */
export function applyPreviewPolicy(run, previewLimit) {
  run.truncated = run.kind === 'thought' && typeof run.text === 'string' && run.text.length > previewLimit;
  run.preview = run.truncated ? run.text.slice(0, previewLimit) : (run.text ?? run.preview);
  return run;
}

/**
 * A thought run's display text: trimmed, or '' when there is nothing to show.
 *
 * Engines stream thoughts as raw chunks and several emit whitespace-only ones
 * (blank lines between thinking segments); rendered verbatim they show up as
 * empty clamped cards. The selection mirrors what the renderer would show
 * anyway — a collapsed truncated run shows its preview, anything else its
 * text — so the preview policy keeps owning what the DOM carries. The one
 * input that selection does not already bound is the in-memory text behind a
 * collapsed truncated run's whitespace-only preview, and that fallback is
 * sliced to `previewLimit`; an expanded truncated run intentionally returns
 * its whole trimmed text, because expanding is the one state where the whole
 * text is meant to render.
 *
 * The caller suppresses the block only when this returns '' AND the run is
 * not truncated: a truncated run carries content past the cap, and hiding it
 * would make that content unreachable (a hidden block cannot be expanded).
 * For such a run the display falls back to a capped slice of the in-memory
 * text; a backfill run with its text withheld renders empty but stays
 * visible, keeping its show-more toggle alive.
 * @param run - the message run; non-thought kinds have no thought display.
 * @param previewLimit - the preview cap in characters; bounds the fallback,
 * whose in-memory text is the one input the selection does not already bound.
 * @returns the trimmed display text, '' when nothing is visible.
 */
export function thoughtDisplay(run, previewLimit) {
  if (run.kind !== 'thought') return '';
  const preview = typeof run.preview === 'string' ? run.preview : '';
  const collapsed = run.truncated === true && run.expanded !== true;
  const shown = collapsed ? preview : (typeof run.text === 'string' ? run.text : preview);
  const trimmed = shown.trim();
  if (trimmed !== '' || run.truncated !== true) return trimmed;
  const full = typeof run.text === 'string' ? run.text.trim() : '';
  return full.slice(0, previewLimit);
}
