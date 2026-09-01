/**
 * The §3.2 seam rule — one owner, for every consumer.
 *
 * Three parties must agree about what "these two fragments are one message"
 * means: the UI joining one folded backfill page onto the last, the UI joining
 * the raw SSE stream onto the backfill's tail, and the mutual-inference check
 * that compares merge(folded pages) against fold(raw). They each carried their
 * own copy, and the copies were not the same rule in the corners — which is
 * exactly where a wrong merge hides, because the check that should have caught
 * it was merging by the other rule.
 *
 * Shared here is the part that must not diverge: **is this the same message,
 * and what is its combined content**. Deliberately NOT shared is what each
 * side then does with it — the wire re-serializes a run, the UI decides what
 * to mount (console-v2 §4.1/§4.3: the preview device belongs to thought runs,
 * it is not a rule about long messages). That difference is a decision, so it
 * stays at the two call sites where a reader can see it, rather than inside a
 * shared helper where it would read as an accident.
 *
 * Why the flags and not same-key adjacency: `messageId` is optional and the
 * folder ends the open message at EVERY non-chunk update, so two genuinely
 * distinct messages can be same-key adjacent with only a `usage` run between
 * them — and a `usage` run breaks no adjacency, because token accounting rides
 * nearly every envelope. Open state is what tells a message the page cut from
 * a message that ended.
 *
 * Pure and DOM-free, so every consumer can be tested against it directly.
 */

/**
 * Which run kinds are message streams — the ones the seam rule applies to.
 * @param kind - a folded run's `kind`.
 * @returns true for agent / thought / user runs.
 */
export function isMessageRunKind(kind) {
  return kind === 'agent' || kind === 'thought' || kind === 'user';
}

/** UTF-8 length without Buffer: this module is bundled for the browser. */
function utf8Length(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * Does an incoming fragment continue the one before it?
 * @param previous - `{ kind, messageId, open }`, where `open` is the previous
 * fragment's `openEnd`: the message had not ended when the page cut.
 * @param incoming - `{ kind, messageId }` plus, for a fragment that arrived on
 * a folded page, `fromFoldedPage: true` and the run's own `openStart`.
 * @returns true when the two are one message.
 */
export function continuesRun(previous, incoming) {
  if (previous === null || previous === undefined) return false;
  if (previous.open !== true) return false;
  if (previous.kind !== incoming.kind || previous.messageId !== incoming.messageId) return false;
  // A folded fragment identifies itself; the live folder has no flag to give,
  // and its cold start at the seam is the continuation by construction.
  if (incoming.fromFoldedPage === true && incoming.openStart !== true) return false;
  return true;
}

/**
 * The UI's tail-entry form of {@link continuesRun}. The tail's message run
 * carries `open` for exactly the reason above — the backfill set it from
 * `openEnd`, and the live path clears it at `messageEnd`.
 * @param tail - the transcript tail entry (`{ type: 'msg', run }` or other).
 * @param incoming - as {@link continuesRun}.
 * @returns true when the fragment continues the tail run.
 */
export function continuesOpenRun(tail, incoming) {
  if (tail === null || tail === undefined || tail.type !== 'msg') return false;
  return continuesRun(tail.run, incoming);
}

/**
 * The combined content of two fragments of one message.
 *
 * Returns facts rather than a shape: `text` is the whole message when it is
 * known and `undefined` when either side withheld its own (past the cap the
 * server sends a preview instead), `preview` is the first `previewLimit`
 * characters of as much as is known, and `fullBytes` is the whole message's
 * UTF-8 length. A truncated fragment's preview is already its own first
 * `previewLimit` characters, so prefixing with it yields the same cap the
 * unpaged fold would have produced.
 *
 * Concatenating `text` alone — which two of the three consumers used to do —
 * is wrong the moment either side is truncated: a truncated fragment has no
 * `text`, so the join produced an empty string beside a stale `fullBytes`.
 * @param previous - `{ text?, preview?, fullBytes? }` accumulated so far.
 * @param incoming - `{ text?, preview?, fullBytes? }` being joined onto it.
 * @param previewLimit - the preview cap in characters.
 * @returns `{ text, preview, fullBytes }`.
 */
export function joinFragmentContent(previous, incoming, previewLimit) {
  const textOf = (fragment) => (typeof fragment.text === 'string' ? fragment.text : undefined);
  const shownOf = (fragment) => textOf(fragment) ?? (typeof fragment.preview === 'string' ? fragment.preview : '');
  const bytesOf = (fragment) => {
    const text = textOf(fragment);
    return text === undefined ? Number(fragment.fullBytes ?? 0) : utf8Length(text);
  };
  const previousText = textOf(previous);
  const incomingText = textOf(incoming);
  return {
    text: previousText !== undefined && incomingText !== undefined ? previousText + incomingText : undefined,
    preview: (shownOf(previous) + shownOf(incoming)).slice(0, previewLimit),
    fullBytes: bytesOf(previous) + bytesOf(incoming),
  };
}
