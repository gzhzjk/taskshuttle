/**
 * Client-side bookkeeping for the diff view (console-v2 §3.1/§4.5): how an
 * index entry is identified, where it belongs in the list, and how much diff
 * content the view keeps in memory.
 *
 * Both rules exist because the view is fed from two sources at once. Live
 * diffs are recorded off the SSE stream whether or not the view was ever
 * opened, while the §3.1 index arrives in one paged backfill the first time it
 * is. So the same diff can reach the view twice (identity), and the older half
 * of the session can arrive after the newer half (order). Appending in arrival
 * order renders a session's history after its present.
 *
 * Pure and DOM-free so both rules are unit-testable; app.js owns the rendering.
 */

/**
 * Identity of one index entry: the carrying event's seq, what the row shows,
 * and — since ADR 0021 — its position within that event and where it came from.
 *
 * `part` is what makes this a total key. It used to be `(seq, path, adds, dels)`,
 * which deliberately collapsed two pathless diffs of one event with identical
 * counts into one row: the wire carried no ordinal, and inventing one
 * client-side would have given the same diff different keys from the two
 * sources it arrives by — live SSE and the index backfill. The wire carries the
 * ordinal now, both sources state the same one, and the collapse is gone with
 * the reason for it.
 *
 * `origin` is in the key too: a rebuilt diff and an engine's own are different
 * claims about the same edit, and a page that showed one as the other would be
 * saying something the engine never said.
 * @param entry - an index entry from either source.
 * @returns a stable string key.
 */
export function diffEntryKey(entry) {
  return `${entry.seq}|${entry.path ?? ''}|${entry.part ?? 0}|${entry.origin ?? 'engine'}`;
}

/**
 * Insert an entry at its place in seq order, scanning from the end.
 * Appends are O(1) — a live diff always carries the highest seq — and the
 * backfill's older entries walk back to their slot.
 * @param entries - the list, already in seq order; mutated in place.
 * @param entry - the entry to place.
 * @returns the index it was inserted at.
 */
export function insertBySeq(entries, entry) {
  let at = entries.length;
  while (at > 0 && entries[at - 1].seq > entry.seq) at -= 1;
  entries.splice(at, 0, entry);
  return at;
}

/**
 * Render-time grouping of the flat, seq-ordered entry list by file.
 *
 * Grouping is a derivation, not a model change: identity, dedup and the ADR
 * 0021 supersession bookkeeping all keep operating on the flat list, and the
 * view is grouped only when drawn. Group order is each group's earliest seq
 * (i.e. first appearance in the seq-ordered input), so a live append of a
 * brand-new file group at the end is always its correct position.
 *
 * Entries without a path share one group keyed `''` — the wire allows a
 * pathless diff, and dropping it here would remove it from the page while the
 * summary row still counts it.
 *
 * @param entries - the view's entries, in seq order.
 * @returns groups in first-appearance order, each with its entries in seq
 * order and the summed `adds`/`dels` (a `deleted` entry contributes 0, the
 * same convention the summary row uses).
 */
export function groupDiffEntries(entries) {
  const groups = [];
  const byPath = new Map();
  for (const entry of entries) {
    const key = entry.path ?? '';
    let group = byPath.get(key);
    if (group === undefined) {
      group = { path: key, entries: [], adds: 0, dels: 0 };
      byPath.set(key, group);
      groups.push(group);
    }
    group.entries.push(entry);
    group.adds += entry.adds ?? 0;
    group.dels += entry.dels ?? 0;
  }
  return groups;
}

/**
 * Diff bodies the view has seen, newest-used first, holding at most `limit`
 * events' worth.
 *
 * Every live diff arrives with its full `oldText`/`newText` and was kept
 * forever, so a long session's cache grew without bound — and held a second
 * copy of text the transcript's own tool rows already hold. A bound turns the
 * unbounded copy into a hit-rate question: what a viewer expands is what they
 * just saw, and anything evicted is one single-event fetch away (§4.5 sends
 * expansion to the events route anyway).
 * @param limit - how many events' diff content to retain.
 * @returns get / set / clear over seq keys, evicting least-recently-used.
 */
export function createDiffContentCache(limit) {
  const entries = new Map();
  return {
    get(seq) {
      if (!entries.has(seq)) return undefined;
      // Re-insert to move it to the young end: Map iterates in insertion order,
      // which is the whole eviction mechanism here.
      const value = entries.get(seq);
      entries.delete(seq);
      entries.set(seq, value);
      return value;
    },
    set(seq, value) {
      entries.delete(seq);
      entries.set(seq, value);
      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * The diff view's supersession bookkeeping (ADR 0021), kept here rather than in
 * app.js so it can be tested without a DOM: app.js is left holding the node
 * removal and nothing else.
 *
 * The problem it solves: a rebuilt diff can be withdrawn — the engine sends its
 * own diff for that call, or restates its parameters without that hunk — and
 * the view has to take the row back out. Wire entries carry no call id (that
 * boundary stands), so the live path records the mapping as it inserts.
 */

/** Remember which wire entry a call's rebuilt diff became, at insert time. */
export function rememberDiffOwner(view, toolCallId, displayKey, wireKey) {
  const owned = view.owners.get(toolCallId) ?? new Map();
  owned.set(displayKey, wireKey);
  view.owners.set(toolCallId, owned);
}

/**
 * Withdraw a call's rebuilt entries from the view.
 *
 * @param view - the diff view state.
 * @param toolCallId - the call whose entries were withdrawn.
 * @param displayKeys - the display-row keys that disappeared from the row.
 * @returns `removed`, the wire keys taken out (the caller removes their nodes),
 * and `unlocated`, true when at least one withdrawn entry was never inserted by
 * the live path — it came from an index backfill, nothing here can identify it,
 * and the view has to be refetched to be right again.
 */
export function retractOwnedEntries(view, toolCallId, displayKeys) {
  const owned = view.owners.get(toolCallId);
  const removed = [];
  let unlocated = false;
  for (const displayKey of displayKeys) {
    const wireKey = owned?.get(displayKey);
    if (wireKey === undefined) {
      unlocated = true;
      continue;
    }
    owned.delete(displayKey);
    // The tombstone outlives the entry: a /diffs page requested before the
    // withdrawal can still be in flight, and would otherwise put it back.
    view.retracted.add(wireKey);
    view.keys.delete(wireKey);
    const at = view.entries.findIndex((entry) => diffEntryKey(entry) === wireKey);
    if (at >= 0) view.entries.splice(at, 1);
    removed.push(wireKey);
  }
  return { removed, unlocated };
}

/**
 * Start a backfill: empty the view and take a generation token.
 *
 * Clearing is the half that is easy to forget — a refetch that only appends
 * keeps exactly the rows it was run to drop. The token is what makes clearing
 * safe: a page answering an older generation is discarded, so a response that
 * was already in flight cannot repopulate the view it just emptied.
 *
 * @returns the generation this backfill must quote to have its pages accepted.
 */
export function beginBackfill(view) {
  view.entries.length = 0;
  view.keys.clear();
  view.retracted.clear();
  view.owners.clear();
  return ++view.generation;
}
