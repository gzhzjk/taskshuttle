/**
 * Merging folded pages back into the run sequence they represent, for the two
 * places that assert `merge(folded pages)` === `fold(raw)`: the unit
 * mutual-inference check and the CONSOLE-026 gate case.
 *
 * **This file owns no rule.** Every judgement it applies is imported from the
 * modules the browser runs — the seam predicate and the fragment join from
 * `seam-merge.js`, the tool-row accumulation and the run's field names from
 * `tool-row-state.js`. That is the point: a check written against its own copy
 * of the rule cannot catch the UI applying a different one, and both halves of
 * this rule had exactly that shape before — a seam predicate that ignored the
 * open state in one corner, and a diff dedup keyed differently on each side.
 *
 * What is genuinely local here is re-serialization: turning the merged content
 * back into the wire shape a server would have emitted for the whole message,
 * so the comparison against the reference fold is field-for-field. The UI does
 * not do that — it mounts what it will show — and the difference is a decision
 * recorded in `seam-merge.js`, not an accident.
 *
 * Seam flags are page artifacts: they ride through the merge so a joined
 * fragment inherits whether it too was cut, and are stripped at the end, on
 * both sides of the comparison.
 */

import { PREVIEW_LIMIT } from '../../packages/plugin/src/console/folded-projection.js';
import { continuesRun, joinFragmentContent, isMessageRunKind, type FragmentContent } from '../../packages/plugin/src/console/ui/seam-merge.js';
import { applyToolRunFields, backfillToolSnapshot, mergeToolRow, type ToolDisplayRow } from '../../packages/plugin/src/console/ui/tool-row-state.js';

/** A run of the folded projection, as the wire carries it. */
export type FoldedRun = Record<string, unknown> & { seqFrom: number; seqTo: number; kind: string };

/**
 * Key-sorted stringify: deep equality that ignores object key order.
 * @param value - any JSON-representable value.
 * @returns a string equal for values differing only in key order.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * Re-serialize the joined content the way the server would have emitted it for
 * the whole message: a run carries `text` only while it is under the cap, and
 * `preview` + `truncated` + `fullBytes` once it is not.
 *
 * This is the half that is NOT shared with the UI, on purpose — the UI mounts
 * what it will show, this side reproduces a wire shape so the comparison
 * against fold(raw) is field-for-field. The content itself comes from the
 * shared rule.
 * @param last - the accumulating run, mutated in place.
 * @param run - the fragment being joined onto it.
 */
function joinFragments(last: FoldedRun, run: FoldedRun): void {
  const joined = joinFragmentContent(last as FragmentContent, run as FragmentContent, PREVIEW_LIMIT);
  if (joined.text === undefined || joined.text.length > PREVIEW_LIMIT) {
    last['preview'] = joined.preview;
    last['truncated'] = true;
    last['fullBytes'] = joined.fullBytes;
    delete last['text'];
    return;
  }
  last['text'] = joined.text;
  delete last['preview'];
  delete last['truncated'];
  delete last['fullBytes'];
}

/**
 * Strip the seam flags from a run list. The unpaged reference fold carries
 * `openEnd` too when the transcript ends mid-message, so both sides of the
 * equivalence need this before they are compared.
 * @param runs - run list, mutated in place.
 * @returns the same array.
 */
export function stripSeamFlags(runs: FoldedRun[]): FoldedRun[] {
  for (const run of runs) {
    delete run['openStart'];
    delete run['openEnd'];
  }
  return runs;
}

/**
 * Merge folded pages into the run sequence they represent.
 * @param pages - each page's `runs`, in cursor order.
 * @returns one run list, seam flags removed.
 */
export function mergeFoldedPages(pages: FoldedRun[][]): FoldedRun[] {
  const out: FoldedRun[] = [];
  /** The merged display row behind each emitted tool run. */
  const rows = new Map<FoldedRun, ToolDisplayRow>();
  for (const page of pages) {
    for (const raw of page) {
      const run: FoldedRun = { ...raw };
      const last = out.at(-1);
      if (
        isMessageRunKind(run.kind) && last !== undefined &&
        continuesRun(
          { kind: last.kind, messageId: last['messageId'] as string | undefined, open: last['openEnd'] === true },
          { kind: run.kind, messageId: run['messageId'] as string | undefined, fromFoldedPage: true, openStart: run['openStart'] },
        )
      ) {
        joinFragments(last, run);
        last.seqTo = run.seqTo;
        if (run['openEnd'] !== true) delete last['openEnd'];
        continue;
      }
      if (run.kind === 'tool') {
        const existing = out.find((candidate) => candidate.kind === 'tool' && candidate['toolCallId'] === run['toolCallId']);
        if (existing !== undefined) {
          // The tool half of the seam, through the same accumulation the UI and
          // the server's own projection use: field completion plus the diff
          // union mergeToolRow performs, then the run fields written by the one
          // function that knows which they are. A second implementation here is
          // what let the two sides disagree about the diff dedup key.
          const merged = mergeToolRow(rows.get(existing), backfillToolSnapshot(run)).row;
          rows.set(existing, merged);
          applyToolRunFields(existing, merged);
          existing.seqTo = run.seqTo;
          continue;
        }
        rows.set(run, mergeToolRow(undefined, backfillToolSnapshot(run)).row);
      }
      out.push(run);
    }
  }
  return stripSeamFlags(out);
}
