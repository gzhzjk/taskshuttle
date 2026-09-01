/**
 * Pure label helpers for content blocks and session meta notices, shared by
 * the live and backfill render paths (ADR 0023). One function per shape so
 * "live shows the name, refresh shows the type again" cannot happen: both
 * paths call the very same code. DOM-free and never throws — transcript bytes
 * come from another process and are not assumed well-typed; unknown shapes
 * fall back to today's labels rather than raising.
 */

/**
 * What a content block contributes to an event's meta line.
 *
 * - `resource_link`: label is the human summary (`name`), falling back to
 *   `uri`, then the bare type name; `title` carries the `uri`. No `uri`, no
 *   `title` property — not an empty string.
 * - every other type (text / image / resource / unknown): label is the type,
 *   unchanged from the pre-ADR behavior; no `title`.
 * - missing or non-string `type`: label is `'content'`, matching the
 *   `block?.type ?? 'content'` both paths used to render.
 *
 * @param block - the content block off the wire (live block or folded run).
 * @returns `{ label, title? }`; `label` is always a non-empty string.
 */
export function contentLabel(block) {
  const type = typeof block?.type === 'string' && block.type !== '' ? block.type : 'content';
  if (type !== 'resource_link') return { label: type };
  const uri = typeof block.uri === 'string' ? block.uri : '';
  const name = typeof block.name === 'string' ? block.name : '';
  const out = { label: name || uri || 'resource_link' };
  if (uri) out.title = uri;
  return out;
}

/** The fixed wording per session meta event; anything else stays `notice`. */
const NOTICE_WORDS = {
  available_commands_update: 'commands',
  current_mode_update: 'mode',
  config_option_update: 'config',
  session_info_update: 'session info',
};

/**
 * One plain-text phrase for a session meta (`NoticeUpdate`) event, so four
 * otherwise identical-looking lines become distinguishable (ADR 0023 §4.3).
 * Dispatches on the runtime `sessionUpdate` string — the two paths hand over
 * different structures and ui/ is JavaScript, so there is no type narrowing
 * to lean on. Engine-private `_meta` content is deliberately not rendered.
 *
 * @param update - the folded notice payload (may be malformed).
 * @returns a plain label; escaping is the caller's job.
 */
export function noticeLabel(update) {
  const kind = update?.sessionUpdate;
  // hasOwn, not a bare lookup: `constructor` or `toString` would otherwise
  // resolve to an inherited function and reach the page as its source text.
  if (typeof kind !== 'string' || !Object.hasOwn(NOTICE_WORDS, kind)) return 'notice';
  const word = NOTICE_WORDS[kind];
  if (kind === 'current_mode_update' && typeof update.currentModeId === 'string' && update.currentModeId !== '') {
    return `${word} ${update.currentModeId}`;
  }
  return word;
}

/**
 * The presentation decision for a tool card's args line (ADR 0023 §4.1),
 * extracted so the DOM assembly stays untested while the decision does not:
 * absent args draw no line at all; the inferred marker appears only on a
 * standalone card whose args came from level 3 of the fold chain — a group
 * row (`inline`) has one line of width and the marker would crowd out the
 * very text it annotates.
 *
 * @param args - the display row's `{ text, from }` (may be absent/malformed).
 * @param options.inline - true for a grouped row's inline third segment.
 * @returns undefined when nothing should render, else `{ text, title, inferred }`.
 */
export function toolArgsView(args, { inline = false } = {}) {
  if (args === null || typeof args !== 'object' || typeof args.text !== 'string' || typeof args.from !== 'string') {
    return undefined;
  }
  return { text: args.text, title: args.text, inferred: !inline && args.from === 'content' };
}
