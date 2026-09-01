import { deriveDiffEntries } from './diff-sources.js';

/**
 * The args preview cap mirrors folded-projection.ts's PREVIEW_LIMIT (same
 * value, same role): the ui/ modules must stay import-free of server code —
 * the dependency points the other way — so the constant lives here by value.
 * Truncating inside mergeToolRow is what makes the display value canonical:
 * the client and the server projection cannot truncate differently, and
 * re-truncating an already-truncated text is a no-op, which is why repeated
 * projections of one row are safe.
 */
export const PREVIEW_LIMIT = 512;

/**
 * Source rank for merging args across snapshots (ADR 0023 §3.3): the fold
 * library's own chain order. A later snapshot may state where the call acted
 * on from a weaker source than one already held — both are true statements,
 * but "the command" replacing "a path" would change what the call did.
 */
const ARGS_RANK = { rawInput: 3, locations: 2, content: 1 };

/**
 * The only shape that enters a display row: `{ text, from }`, text capped at
 * PREVIEW_LIMIT, `value` dropped at this single point so no downstream site
 * can leak it into the projection. `from` must be an own key of ARGS_RANK:
 * an unrecognized source is malformed, i.e. absence — letting it in would
 * make "unknown" the weakest rank and let any real source overwrite a held
 * statement that was never actually contradicted.
 * Transcript bytes are not assumed well-typed.
 */
function normalizeArgs(args) {
  if (args === null || typeof args !== 'object') return undefined;
  const { text, from } = args;
  if (typeof text !== 'string' || typeof from !== 'string' || !Object.hasOwn(ARGS_RANK, from)) return undefined;
  return { text: text.length > PREVIEW_LIMIT ? text.slice(0, PREVIEW_LIMIT) : text, from };
}

/**
 * Value equality on `(text, from)`. Identity comparison cannot be used: every
 * snapshot hands over a fresh object, so `!==` would dirty the card on every
 * tool_call_update and redraw rows that did not change.
 */
function argsEqual(a, b) {
  if (a === b) return true;
  return a !== undefined && b !== undefined && a.text === b.text && a.from === b.from;
}

/**
 * The complete merge decision for args, in four steps (ADR 0023 §3.3):
 * absence keeps what stands; first sighting takes it; no downgrade to a
 * weaker source; equal-or-stronger source wins, same source included — the
 * latest statement of the current call is its current state, with no second
 * tie-breaker. Diff's accumulate-as-historical-fact rule does NOT apply here:
 * diffs accumulate because content is whole-array replaced, while args is a
 * derived value recomputed from each row's whole state.
 */
function mergeArgs(held, incoming) {
  if (incoming === undefined || incoming === null) return held;
  const next = normalizeArgs(incoming);
  if (next === undefined) return held;
  if (held === undefined) return next;
  // Both sources are chain members here (normalizeArgs validated them), so
  // the rank lookup cannot miss.
  if (ARGS_RANK[next.from] < ARGS_RANK[held.from]) return held;
  return next;
}

/**
 * Presentation-side merge of folded ToolRow snapshots (ADR 0006).
 *
 * The folder's row semantics are wire-faithful: `content` is a whole-array
 * replacement per ACP, and a terminal row is evicted, so an update that lands
 * after completion starts a fresh partial row carrying only what that update
 * said. Both are correct — but the pre-fold diff view accumulated
 * `content[].type === 'diff'` entries across the raw event stream, and an
 * agent that reports an edit's diff first and its "Success" text later (a
 * normal pattern) would see the diff silently replaced. A diff, once
 * reported, is a historical fact about what the tool did, so the display row
 * accumulates diff entries while every other field follows the latest
 * snapshot. Pure and DOM-free so the merge is unit-testable; app.js renders
 * whatever this returns.
 */

/**
 * Two identities, because a row has two questions to answer about a diff and
 * one key cannot answer both.
 *
 * `diffIdentity` ignores position: it decides whether a block arriving now is
 * one the row already accumulated from an EARLIER snapshot. A reconnect
 * replays snapshots, and content is a whole-array replacement, so the same
 * block routinely comes back at a different index — treating that as new would
 * deal a second row for one edit.
 *
 * `diffStateKey` carries position and the deleted flag: it decides whether the
 * row's rendered state changed. Two identical blocks in one event are two
 * distinct edits there (the server's index keeps both), and a deleted file and
 * an edit that changed nothing differ by nothing else at all.
 *
 * Dedup counts rather than merely checks membership: the row keeps as many
 * copies of one identity as the largest number a single snapshot claimed. A
 * membership test cannot separate "this snapshot claims two of these" from
 * "this snapshot is replaying the one already held".
 */
function diffIdentity(entry) {
  return JSON.stringify([entry.path ?? null, entry.oldText ?? null, entry.newText ?? null, entry.origin ?? 'engine', entry.deleted === true]);
}

function diffStateKey(entry) {
  return JSON.stringify([
    entry.path ?? null,
    entry.oldText ?? null,
    entry.newText ?? null,
    entry.origin ?? 'engine',
    entry.part ?? 0,
    entry.deleted === true,
  ]);
}

/**
 * What this snapshot says was edited: an ACP diff block if the engine sent one,
 * otherwise a diff rebuilt from the edit parameters it did send (ADR 0021).
 * Shape, not engine id — the derivation is shared with the server's index.
 */
function diffEntries(snapshot) {
  return deriveDiffEntries(snapshot).map((entry) => ({ type: 'diff', ...entry }));
}

/**
 * Diffs handed back by a backfilled run, with the two fields a display row
 * always carries filled in if that run predates them. `origin` defaults to the
 * engine's own because that is what every diff was before rebuilding existed —
 * and it is only ever a default: an entry that says `reconstructed` keeps it.
 */
function normalizeDerived(entries) {
  return entries.map((entry, index) => ({
    ...entry,
    origin: entry.origin === 'reconstructed' ? 'reconstructed' : 'engine',
    part: typeof entry.part === 'number' ? entry.part : index,
  }));
}

/**
 * Merge one folded ToolRow snapshot into the display row kept for its
 * toolCallId. `previous` is undefined for a first sighting. Returns the merged
 * row plus `changed`: whether anything the tool-row card renders (title, name,
 * kind, status, args — by `(text, from)`, never identity — or the accumulated
 * diffs) actually differs — content updates that carry only text output do not
 * dirty the card, so the DOM row and its line diff survive untouched.
 */
export function mergeToolRow(previous, snapshot) {
  const merged = {
    toolCallId: snapshot.toolCallId,
    diffs: previous?.diffs ?? [],
  };
  let changed = previous === undefined;
  for (const field of ['title', 'name', 'kind', 'status']) {
    const value = snapshot[field] ?? previous?.[field];
    if (value !== undefined) merged[field] = value;
    if (value !== previous?.[field]) changed = true;
  }
  // Args ride outside the scalar loop on purpose: that loop compares with
  // !==, and every snapshot's args is a fresh object, so identity would mark
  // the row changed on every update. Equality is by (text, from) — the two
  // keys a row keeps; `value` never enters and so never participates.
  const args = mergeArgs(previous?.args, snapshot.args);
  merged.args = args;
  if (!argsEqual(args, previous?.args)) changed = true;
  // Whole-array replacement stands for the snapshot's own content; the merged
  // row's content is informational only (the card renders scalars + diffs).
  if (Array.isArray(snapshot.content)) merged.content = snapshot.content;
  else if (previous?.content !== undefined) merged.content = previous.content;

  // A backfilled run hands back diffs this module already derived. They are
  // taken as they are: re-deriving them would read them as `content`, and
  // every rebuilt one would come back stamped as the engine's own — the page
  // would credit the engine with a diff it never sent, on every refresh.
  const derived = Array.isArray(snapshot.derivedDiffs) ? normalizeDerived(snapshot.derivedDiffs) : diffEntries(snapshot);
  const previousDiffs = previous?.diffs ?? [];
  const nativeNow = derived.filter((entry) => entry.origin !== 'reconstructed');
  const rebuiltNow = derived.filter((entry) => entry.origin === 'reconstructed');

  // A diff the engine reported is a historical fact: content is replaced whole
  // per ACP, so an agent that reports a diff and then reports "Success" must
  // not lose it. Native entries therefore accumulate, deduped by content.
  const natives = previousDiffs.filter((entry) => entry.origin !== 'reconstructed');
  // Counted, not just seen. A snapshot claiming two identical blocks where the
  // row already holds one is claiming a sibling, not replaying the one it has,
  // and identity alone cannot tell those apart. The rule that can: the row
  // holds as many copies of a diff as the largest number any single snapshot
  // claimed. A replay of [A, A] over a row already holding two changes
  // nothing; [A, A] over a row holding one adds the second.
  const held = new Map();
  for (const entry of natives) {
    const id = diffIdentity(entry);
    held.set(id, (held.get(id) ?? 0) + 1);
  }
  const claimed = new Map();
  for (const entry of nativeNow) {
    const id = diffIdentity(entry);
    const nth = (claimed.get(id) ?? 0) + 1;
    claimed.set(id, nth);
    if (nth > (held.get(id) ?? 0)) natives.push(entry);
  }

  // A diff *we* drew from the engine's parameters is not a fact of that kind.
  // Each snapshot states the whole set of edits the call is making, so the new
  // set replaces the old one — that is what makes a hunk dropped from
  // `edits[]` leave the page. A snapshot that states none keeps what stood; a
  // native diff clears them, the stand-in having been superseded by the thing
  // it stood in for.
  // The latch is on the ROW, not on this snapshot: a call that has ever stated
  // a native diff is never rebuilt for again, in either order. Testing only
  // `nativeNow` would catch rebuilt-then-native and miss native-then-rawInput,
  // which shows the engine's diff and our stand-in for it side by side.
  const rebuilt =
    natives.length > 0
      ? []
      : rebuiltNow.length > 0
        ? rebuiltNow
        : previousDiffs.filter((entry) => entry.origin === 'reconstructed');

  merged.diffs = [...natives, ...rebuilt];
  if (merged.diffs.length !== previousDiffs.length) changed = true;
  else if (merged.diffs.some((entry, i) => diffStateKey(entry) !== diffStateKey(previousDiffs[i] ?? {}))) changed = true;

  return { row: merged, changed };
}

/**
 * A folded backfill tool run (console-v2 §3.2) as a mergeToolRow snapshot.
 * The server folds every page with a fresh assembler, so a tool call cut by
 * the page boundary arrives as one run per page; the §3.2 merge joins them by
 * toolCallId — field completion, plus the diff rules of `mergeToolRow`: a
 * union for engine-reported diffs, whole-set replacement for rebuilt ones,
 * through the very same code the live path runs. Field names translate
 * (toolKind → kind), and the run's already-derived `diffs` ride under
 * `derivedDiffs` rather than `content` — they carry their own `origin`, and
 * re-deriving them as content would stamp every rebuilt one as the engine's.
 */
export function backfillToolSnapshot(run) {
  return {
    toolCallId: String(run.toolCallId),
    ...(typeof run.title === 'string' ? { title: run.title } : {}),
    ...(typeof run.name === 'string' ? { name: run.name } : {}),
    ...(typeof run.toolKind === 'string' ? { kind: run.toolKind } : {}),
    ...(typeof run.status === 'string' ? { status: run.status } : {}),
    // Under their own key, not `content`: these are derived entries carrying
    // their own `origin`, and `content` is where an engine's raw blocks live.
    ...(Array.isArray(run.diffs) && run.diffs.length > 0 ? { derivedDiffs: run.diffs } : {}),
    // The projection's args translated back into snapshot shape (ADR 0023):
    // skip the translation and refreshed rows lose what live rows show. Goes
    // through normalizeArgs so only {text, from} can cross, same as everywhere.
    ...(normalizeArgs(run.args) !== undefined ? { args: normalizeArgs(run.args) } : {}),
  };
}

/**
 * Write a merged display row onto a folded tool run, in the wire's field
 * names. One owner for "what a tool run carries", so the server's projection
 * and anything that re-merges pages cannot disagree about it. Diffs ride under
 * `derivedDiffs` rather than `content`, and are taken as they are rather than
 * re-derived — engine-reported ones are unioned into the row, rebuilt ones
 * replace the row's rebuilt set (see mergeToolRow).
 * @param run - the run object, mutated in place.
 * @param row - the merged display row, or undefined to clear the fields.
 * @returns the same run.
 */
export function applyToolRunFields(run, row) {
  for (const field of ['title', 'name', 'toolKind', 'status', 'diffs', 'args']) delete run[field];
  if (row !== undefined) {
    if (row.title !== undefined) run.title = row.title;
    if (row.name !== undefined) run.name = row.name;
    if (row.kind !== undefined) run.toolKind = row.kind;
    if (row.status !== undefined) run.status = row.status;
    if (row.diffs.length > 0) run.diffs = row.diffs;
    // Copied, not referenced: the run is a mutable object on the projection
    // sequence, and a shared reference would let later run rewrites reach
    // back into the display row (ADR 0023 §3.2).
    if (row.args !== undefined) run.args = { ...row.args };
  }
  return run;
}
