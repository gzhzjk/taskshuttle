/**
 * Where a diff comes from (ADR 0021): the three shapes an engine may use to say
 * "this call edited a file", read by shape rather than by engine id.
 *
 * 1. an ACP `diff` content block          → origin 'engine'
 * 2. `rawInput.{path, edits[{oldText,newText}]}` → origin 'reconstructed'
 * 3. `rawInput.patchText` (apply_patch)   → origin 'reconstructed'
 *
 * A call takes the first shape it matches: an engine that sent a diff is the
 * authority on its own edit, and rebuilding one alongside it would only raise
 * the question of which to believe.
 *
 * Shared by the server-side diff index and the browser, the way diff-lines.js
 * and tool-row-state.js are: one implementation, two consumers, so the index
 * numbers and the rendered card can never disagree about what an edit was.
 *
 * Two rules earn their place over the obvious alternatives:
 *
 * - **Validated before it reaches diffLines.** That helper coerces with
 *   `String(x ?? '')`, so malformed input would come out as a plausible diff
 *   rather than as nothing. Anything unexpected makes the whole call produce
 *   nothing: a shape that is half right says the engine is not doing what we
 *   think it is, and half of a wrong guess is still a wrong guess.
 * - **No terminal-status gate.** Reading only at a terminal status is right for
 *   a streamed text field, and wrong here: on the two engines that need this,
 *   most edit calls never reach a terminal status at all, so waiting yields
 *   blanks rather than accuracy. Correctness comes from validation plus the
 *   caller's supersession instead.
 */

/** §6: a patch text past this is not parsed at all — treated as unparseable. */
export const PATCH_TEXT_LIMIT = 1024 * 1024;

const FILE_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/;

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * A stated path, or `undefined` when none was stated.
 *
 * `null` and absent both mean "not stated", which is allowed — an entry can be
 * pathless. Anything else present is a refusal, not a default: a path that is a
 * number, or an empty string, says this is not the shape being read, and
 * quietly rendering the entry without it would hide that.
 */
const NO_PATH = Symbol('no path');
const REJECT = Symbol('reject');

function statedPath(value) {
  if (value === undefined || value === null) return NO_PATH;
  return typeof value === 'string' && value.trim() !== '' ? value : REJECT;
}

/**
 * Native ACP diff blocks, in the order the event carries them.
 * `part` is the position among the diff items of this event, so two blocks for
 * the same path stay distinguishable — they are not, today, without it.
 */
/**
 * @returns the event's native diff entries, `[]` when it stated one this
 * refuses to read, and `undefined` when it stated none at all. The caller must
 * keep those last two apart: a rejected native block is not an absent one, and
 * falling back to `rawInput` after rejecting it would quietly turn the
 * engine's own claim into a rebuilt stand-in for it.
 */
function fromContent(content) {
  const entries = [];
  if (!Array.isArray(content)) return undefined;
  let part = 0;
  for (const item of content) {
    if (!isRecord(item) || item['type'] !== 'diff') continue;
    // Validated exactly as rawInput is, and for the same reason: diffLines
    // coerces, so an absent oldText would render as a one-line deletion the
    // engine never reported. One bad block discards the call's blocks rather
    // than leaving a set that is right in some places and invented in others.
    if (typeof item['oldText'] !== 'string' || typeof item['newText'] !== 'string') return [];
    const path = statedPath(item['path']);
    if (path === REJECT) return [];
    entries.push({
      origin: 'engine',
      part: part++,
      path: path === NO_PATH ? undefined : path,
      oldText: item['oldText'],
      newText: item['newText'],
    });
  }
  return entries.length > 0 ? entries : undefined;
}

/**
 * `rawInput.edits[]`: one entry per hunk, all against `rawInput.path`.
 * Each hunk stands alone — hunks are fragments of a file at different offsets,
 * so concatenating them would render a text that never existed.
 */
function fromEdits(rawInput, locations) {
  const edits = rawInput['edits'];
  if (!Array.isArray(edits) || edits.length === 0) return undefined;
  const stated = statedPath(rawInput['path']);
  if (stated === REJECT) return [];
  // The fallback is held to the same standard as the field it stands in for:
  // a location whose path is present but unusable is a refusal, not a miss.
  const fallback = statedPath(locations?.[0]?.path);
  if (fallback === REJECT) return [];
  const path = stated !== NO_PATH ? stated : fallback === NO_PATH ? undefined : fallback;
  const entries = [];
  for (let part = 0; part < edits.length; part++) {
    const edit = edits[part];
    // Validation is all-or-nothing for the call: a partly recognisable edits
    // array means this engine's shape is not the one being read here.
    if (!isRecord(edit) || typeof edit['oldText'] !== 'string' || typeof edit['newText'] !== 'string') return [];
    entries.push({ origin: 'reconstructed', part, path, oldText: edit['oldText'], newText: edit['newText'] });
  }
  return entries;
}

/**
 * One `*** (Add|Update|Delete) File:` segment, reconstructed into the two texts
 * a line diff needs. `-` and context lines rebuild the old side, `+` and context
 * lines the new side; `@@` locator lines are context and count as neither.
 *
 * A line with none of those prefixes makes the segment produce nothing. Counting
 * it as context is what the first draft did, and in an `Add File` segment that
 * puts the same line on both sides — reporting a real addition as `+0`, which is
 * a confident wrong answer where silence is merely an incomplete one.
 *
 * @returns the segment's texts, or undefined when it cannot be represented.
 */
function segmentTexts(lines) {
  const oldLines = [];
  const newLines = [];
  for (const line of lines) {
    if (line.startsWith('@@')) continue;
    const body = line.slice(1);
    if (line.startsWith('+')) newLines.push(body);
    else if (line.startsWith('-')) oldLines.push(body);
    else if (line.startsWith(' ')) {
      oldLines.push(body);
      newLines.push(body);
    } else if (line === '') {
      oldLines.push('');
      newLines.push('');
    } else return undefined;
  }
  return { oldText: oldLines.join('\n'), newText: newLines.join('\n') };
}

/**
 * `rawInput.patchText`, the apply_patch envelope.
 *
 * `part` is the segment's ordinal in the patch and is never renumbered, so a
 * segment dropped for being unrepresentable leaves a gap. The ordinal is an
 * identity that has to match between the live path and the index backfill;
 * renumbering would make the same diff arrive under two different identities.
 */
function fromPatchText(rawInput) {
  const text = rawInput['patchText'];
  if (typeof text !== 'string' || text === '') return undefined;
  if (text.length > PATCH_TEXT_LIMIT) return [];
  // CRLF is stripped before anything looks at a prefix: a trailing \r would
  // otherwise ride into every reconstructed line, and a CRLF blank line would
  // read as an unprefixed one and drop its segment.
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  // The envelope is read as a structure, not looked for line by line: an
  // opening marker, a closing one after it, and nothing outside them that
  // matters. Merely *containing* both markers let a patch whose end came
  // before its beginning parse as if it were well formed.
  // Matched exactly, not by prefix: `*** Begin Patch extra` is not this format,
  // and reading it as one means guessing what the extra said.
  const begin = lines.findIndex((line) => line.trim() === '*** Begin Patch');
  if (begin < 0) return [];
  const end = lines.findIndex((line, i) => i > begin && line.trim() === '*** End Patch');
  if (end < 0) return [];
  const body = lines.slice(begin + 1, end);

  const entries = [];
  let part = -1;
  let current;
  const close = () => {
    if (current === undefined) return;
    // A segment whose header names no file cannot be grouped or expanded, and
    // an entry with no path is one the reader cannot act on.
    if (current.path === undefined) {
      current = undefined;
      return;
    }
    if (current.kind === 'Delete') {
      // A deletion segment carries no lines. One that does is a shape this does
      // not read, and stating `deleted` for it would make a claim about a file
      // on the strength of a patch that was not understood.
      //
      // Blank lines are exempt, deliberately: they are formatting, and they say
      // nothing about what was deleted. Rejecting on one would throw out real
      // patches over a blank line before the next marker, which is the kind of
      // strictness that loses data without buying accuracy. Everywhere else in
      // this parser a blank line is treated the same way.
      if (current.lines.some((line) => line !== '')) {
        current = undefined;
        return;
      }
      // The segment carries no lines, so how much was deleted is unknowable
      // without reading the file — which ADR 0021 forbids. The entry exists so
      // the file is not silently missing from the page; it states no numbers.
      entries.push({ origin: 'reconstructed', part: current.part, path: current.path, oldText: '', newText: '', deleted: true });
    } else {
      const texts = segmentTexts(current.lines);
      if (texts !== undefined) {
        entries.push({ origin: 'reconstructed', part: current.part, path: current.path, ...texts });
      }
    }
    current = undefined;
  };

  for (const line of body) {
    const header = FILE_HEADER.exec(line);
    if (header !== null) {
      close();
      part++;
      const stated = statedPath(header[2].trim());
      current = { kind: header[1], path: stated === NO_PATH || stated === REJECT ? undefined : stated, part, lines: [] };
      continue;
    }
    // An unrecognised `*** …` marker is a patch dialect this does not read.
    // Treating it as "close the segment and carry on" would silently drop
    // whatever it meant — a rename, a mode change — while still rendering the
    // rest as a complete account of the edit.
    if (line.startsWith('***')) return [];
    if (current === undefined) {
      // Content before the first file header: it belongs to some file, and
      // there is no honest way to say which.
      if (line !== '') return [];
      continue;
    }
    current.lines.push(line);
  }
  close();
  return entries;
}

/**
 * Every diff this update states, by whichever shape it used.
 *
 * @param update - one `tool_call` / `tool_call_update` update body.
 * @returns entries with `{origin, part, path?, oldText, newText, deleted?}`;
 * empty when the update states no diff, or states one this cannot represent
 * honestly.
 */
export function deriveDiffEntries(update) {
  if (!isRecord(update)) return [];
  const native = fromContent(update['content']);
  // `[]` means a native block was stated and rejected — the call is done, and
  // must not be rebuilt for. Only `undefined`, "no native block at all", falls
  // through to the engine's parameters.
  if (native !== undefined) return native;
  const rawInput = update['rawInput'];
  if (!isRecord(rawInput)) return [];
  const locations = Array.isArray(update['locations']) ? update['locations'] : undefined;
  return fromEdits(rawInput, locations) ?? fromPatchText(rawInput) ?? [];
}

/**
 * Identity of one derived entry *within its call*, for dedup and supersession.
 * Deliberately not the wire identity: the wire key carries the seq of the event
 * that stated the diff, while this one must match across events so that the
 * same content restated does not appear twice.
 *
 * @param entry - a derived entry.
 * @returns a stable string key.
 */
export function derivedEntryKey(entry) {
  return JSON.stringify([entry.origin, entry.part, entry.path ?? null, entry.oldText, entry.newText, entry.deleted === true]);
}
