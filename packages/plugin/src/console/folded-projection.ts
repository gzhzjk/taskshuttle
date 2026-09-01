import type { TranscriptEvent } from 'runskein';
import { createFolder, type FoldedEvent, type Folder, type MessageKind } from 'runskein/fold';

import { applyToolRunFields, mergeToolRow, type ToolDisplayRow, type ToolRowSnapshot } from './ui/tool-row-state.js';

/**
 * The folded projection of console-v2 §3.2 (ADR 0010): one page of raw
 * transcript events folded through the SAME `runskein/fold` package the
 * browser runs (constraint 2 — one implementation, not two), assembled into
 * the run sequence `/api/sessions/<id>/events?projection=folded` returns.
 *
 * Page-boundary semantics (§3.2, ADR 0010 constraint 5):
 * - a run never spans pages — each page folds its own events with a fresh
 *   folder, and `seqFrom` is never earlier than `afterSeq + 1`;
 * - a message cut by the page boundary becomes one fragment per side; the
 *   page-head fragment carries `openStart` when the cursor event is a text
 *   chunk of the same (kind, messageId), the page-tail fragment carries
 *   `openEnd` whenever the message is still open at the cut; the client joins
 *   an `openEnd` fragment to the same-key `openStart` fragment that follows.
 *   The flags carry the merge, not bare adjacency: `messageId` is optional
 *   and the folder ends a message at every non-chunk update, so two distinct
 *   messages can be same-key adjacent;
 * - oversized events never enter the folder (ADR 0006 / CONSOLE-023); they
 *   appear as `{ kind: 'oversized' }` reference runs. The fold keeps an open
 *   message open across the gap — the folder never saw the event — so the
 *   fragment continues past the reference run. The live UI renders the same
 *   seam differently: it settles the open message at the reference and
 *   starts a fresh run after it (v1 behavior, kept). The two sides disagree
 *   about run boundaries here by design, not by drift.
 *
 * Text runs longer than PREVIEW_LIMIT carry a preview plus `truncated` /
 * `fullBytes`; the full text is re-composed from the raw projection over
 * `afterSeq=seqFrom-1&toSeq=seqTo`. Tool runs keep their `content[]` diff
 * entries verbatim (they feed the §4.5 diff view) via the same mergeToolRow
 * accumulation the UI uses; non-diff content stays in the raw projection.
 * Cumulative folder state never travels in a run. Plan runs carry only the
 * change ids, never the plan snapshot — embedding it made the k-th plan run
 * of a page O(k) events large, growth the per-event budget estimate could not
 * see (constraint 6). Usage runs carry no payload at all, for the sharper
 * reason: the usage snapshot merges channels set by EARLIER events, so a page
 * folder cold-started after them cannot reproduce it and fold(raw) would stop
 * equalling merge(pages) wherever usage crossed a page boundary. Neither UI
 * path renders either payload. With that, the projection only ever derives
 * less (ADR 0010 constraint 4) and its equivalence with raw has no exceptions.
 */

/** §3.2/§7: the preview cap is a constant; the install surface does not grow. */
export const PREVIEW_LIMIT = 512;

/** The folded page body; continuation stays on the event-seq cursor. */
export interface FoldedPage {
  readonly runs: Record<string, unknown>[];
  readonly nextSeq: number;
  readonly highWatermark: number;
  readonly hasMore: boolean;
}

/** (kind, messageId) — the seam merge key of §3.2. */
export interface MessageKey {
  readonly kind: MessageKind;
  readonly messageId: string | undefined;
}

/** Chunk update name → run kind; mirrors CHUNK_KINDS inside runskein/fold, which does not export it. */
const CHUNK_KINDS: Record<string, MessageKind> = {
  agent_message_chunk: 'agent',
  agent_thought_chunk: 'thought',
  user_message_chunk: 'user',
};

/** The (kind, messageId) of a text chunk event; anything else is not a message-stream member. */
export function textChunkKey(event: TranscriptEvent): MessageKey | undefined {
  const update: unknown = event.update;
  if (typeof update !== 'object' || update === null) return undefined;
  const record = update as Record<string, unknown>;
  const kind = CHUNK_KINDS[record['sessionUpdate'] as string];
  if (kind === undefined) return undefined;
  const content = record['content'];
  if (typeof content !== 'object' || content === null || (content as { type?: unknown }).type !== 'text') return undefined;
  const messageId = record['messageId'];
  return { kind, messageId: typeof messageId === 'string' ? messageId : undefined };
}

/** A run in the page output. Mutable while the page assembles; serialized at the end. */
type Run = Record<string, unknown> & { seqFrom: number; seqTo: number; kind: string };

/** An open message fragment and the run object it will finalize into. */
interface MessageFragment {
  readonly run: Run;
  /** Full text while at or under the preview cap; released once truncated. */
  text: string;
  truncated: boolean;
  preview: string;
  /** UTF-8 length of the full text, accumulated chunk by chunk. */
  fullBytes: number;
}

interface ToolState {
  readonly run: Run;
  row: ToolDisplayRow | undefined;
}

export class RunAssembler {
  private readonly folder: Folder = createFolder();
  private readonly runsList: Run[] = [];
  private fragment: MessageFragment | undefined;
  private readonly toolStates = new Map<string, ToolState>();
  /** Serialized-length cache; a run's entry is dropped whenever it mutates. */
  private readonly lengths = new Map<Run, number>();
  /** openStart is decided by the page's FIRST message run; reference/tool runs before it do not settle it. */
  private openStartSettled = false;

  constructor(private readonly openStartKey?: MessageKey) {}

  get runs(): readonly Run[] {
    return this.runsList;
  }

  /** Fold one raw event of the page. */
  pushEvent(event: TranscriptEvent): void {
    for (const folded of this.folder.push(event)) this.apply(folded);
  }

  /** An oversized event as a reference run (§9.4 fields); never fed to the folder. */
  addOversizedReference(seq: number, canonical: { bytes: Buffer; sha256: string } | undefined): void {
    this.add({
      kind: 'oversized',
      seqFrom: seq,
      seqTo: seq,
      seq,
      ...(canonical === undefined ? {} : { totalBytes: canonical.bytes.byteLength, sha256: canonical.sha256 }),
    });
  }

  /**
   * Serialized size of the run list as it currently stands (runs plus the
   * joining commas, envelope excluded). An open message fragment is counted in
   * its finalized form — preview truncation applied — with `openEnd` reserved,
   * so closing it later never grows the page past what was accounted.
   */
  serializedBytes(): number {
    let total = 0;
    for (let i = 0; i < this.runsList.length; i += 1) {
      const run = this.runsList[i]!;
      let len = this.lengths.get(run);
      if (len === undefined) {
        len = Buffer.byteLength(JSON.stringify(run === this.fragment?.run ? this.projectFragment(run) : run), 'utf8');
        this.lengths.set(run, len);
      }
      total += len + (i === 0 ? 0 : 1);
    }
    return total;
  }

  /**
   * End the page: flush the folder (closing any open message) and mark a
   * tail fragment `openEnd`.
   *
   * The flag says "this run is a fragment the page cut, not a message that
   * ended" — it is NOT conditional on there being a further page. A message
   * still streaming when the page reaches the high watermark is cut just the
   * same, and its continuation arrives over the raw SSE seam (§3.2, seam
   * three) rather than from a next page; the client needs the same signal in
   * both cases to know it may join what follows onto this run. Deciding it
   * from `hasMore` made the last page of a live message claim the message had
   * ended, and the seam merge then dealt a second run mid-sentence.
   */
  finish(): void {
    const fragment = this.fragment;
    for (const folded of this.folder.flush()) this.apply(folded);
    // flush() closes the open message via messageEnd; if it somehow did not,
    // the run is still open — the flag is correct either way.
    if (fragment !== undefined) {
      fragment.run['openEnd'] = true;
      this.dirty(fragment.run);
    }
  }

  private apply(folded: FoldedEvent): void {
    const { source, event } = folded;
    // openStart says "this page's head fragment continues the message the
    // cursor event belonged to". That can only be true when the page's FIRST
    // folded event IS that continuation — anything else the folder emits
    // first (a usage snapshot, a tool row, a notice, a raw update) is an event
    // that ENDED the message in the unpaged fold, because the folder closes
    // the open message at every non-chunk update. Settling the flag only on
    // messageStart let `message A / usage_update / message B` with the cut
    // after A hand the client an openStart on B: two distinct messages the
    // client then merged into one, silently. Oversized references settle
    // nothing — they never reach the folder, so the fold spans them on both
    // sides (ADR 0006), which is why addOversizedReference does not go
    // through here.
    if (!this.openStartSettled && event.type !== 'messageStart') this.openStartSettled = true;
    switch (event.type) {
      case 'messageStart': {
        const run: Run = {
          seqFrom: source.seq,
          seqTo: source.seq,
          kind: event.kind,
          ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
        };
        // openStart (§3.2): the page-head fragment continues the message the
        // cursor event belongs to. Only the page's first message run can
        // carry it; oversized reference runs before it are not message runs.
        if (!this.openStartSettled) {
          this.openStartSettled = true;
          if (
            this.openStartKey !== undefined &&
            this.openStartKey.kind === event.kind &&
            this.openStartKey.messageId === event.messageId
          ) {
            run['openStart'] = true;
          }
        }
        this.add(run);
        this.fragment = { run, text: '', truncated: false, preview: '', fullBytes: 0 };
        break;
      }
      case 'messageAppend': {
        // The folder emits messageAppend only inside an open stream.
        const fragment = this.fragment;
        if (fragment === undefined) break;
        fragment.run.seqTo = source.seq;
        const text = event.block.text;
        fragment.fullBytes += Buffer.byteLength(text, 'utf8');
        if (!fragment.truncated) {
          fragment.text += text;
          if (fragment.text.length > PREVIEW_LIMIT) {
            fragment.truncated = true;
            fragment.preview = fragment.text.slice(0, PREVIEW_LIMIT);
            fragment.text = '';
          }
        }
        this.dirty(fragment.run);
        break;
      }
      case 'messageEnd':
        this.closeFragment(source.seq);
        break;
      case 'content':
        // A non-text block of a chunk stream, kept whole (§3.2: nothing dropped).
        this.add({
          seqFrom: source.seq,
          seqTo: source.seq,
          kind: 'content',
          messageKind: event.kind,
          ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
          block: event.block,
        });
        break;
      case 'toolRow': {
        let state = this.toolStates.get(event.row.toolCallId);
        if (state === undefined) {
          const run: Run = { seqFrom: source.seq, seqTo: source.seq, kind: 'tool', toolCallId: event.row.toolCallId };
          state = { run, row: undefined };
          this.toolStates.set(event.row.toolCallId, state);
          this.add(run);
        }
        state.run.seqTo = source.seq;
        // The same merge the UI's diff view relies on: whole-array content
        // replacement must not erase a diff the tool already reported.
        state.row = mergeToolRow(state.row, event.row as unknown as ToolRowSnapshot).row;
        this.projectToolRun(state);
        break;
      }
      case 'planState':
        // No `state`: the folder's plan snapshot is cumulative, so embedding
        // it made the k-th plan run of a page carry O(k) events' worth of
        // plan — past the per-event budget estimate, and both UI paths render
        // only the meta line anyway. The change ids suffice as the meta fact.
        this.add({
          seqFrom: source.seq,
          seqTo: source.seq,
          kind: 'plan',
          ...(event.changedPlanId === undefined ? {} : { changedPlanId: event.changedPlanId }),
          ...(event.removedPlanId === undefined ? {} : { removedPlanId: event.removedPlanId }),
        });
        break;
      case 'usageState':
        // No `usage`: the folder's snapshot merges the ACP context window, the
        // last reported cost and realm's token accounting, and it ACCUMULATES
        // — an event that contributes only tokens still emits the context a
        // previous event set. A page folder cold-started after that event
        // cannot reproduce it, so embedding the snapshot made fold(raw) and
        // merge(pages) disagree wherever usage crossed a page boundary, and
        // put bytes in the run that the per-event budget estimate could not
        // see. Neither UI path renders a usage run at all; the marker keeps
        // the run sequence covering every event, which is all it was for.
        this.add({ seqFrom: source.seq, seqTo: source.seq, kind: 'usage' });
        break;
      case 'notice':
        this.add({ seqFrom: source.seq, seqTo: source.seq, kind: 'notice', update: event.update });
        break;
      case 'raw':
        // Raw stays raw (§3.2): the update passes through untouched.
        this.add({ seqFrom: source.seq, seqTo: source.seq, kind: 'raw', update: event.update, reason: event.reason });
        break;
    }
  }

  /** Rewrite the mutable tool run from the merged display row. */
  private projectToolRun(state: ToolState): void {
    applyToolRunFields(state.run, state.row);
    this.dirty(state.run);
  }

  private closeFragment(seq: number): void {
    const fragment = this.fragment;
    if (fragment === undefined) return;
    fragment.run.seqTo = seq;
    if (fragment.truncated) {
      fragment.run['preview'] = fragment.preview;
      fragment.run['truncated'] = true;
      fragment.run['fullBytes'] = fragment.fullBytes;
    } else {
      fragment.run['text'] = fragment.text;
    }
    this.fragment = undefined;
    this.dirty(fragment.run);
  }

  /** The fragment's run as it will look once closed, plus the openEnd reservation. */
  private projectFragment(run: Run): Run {
    const fragment = this.fragment;
    if (fragment === undefined || fragment.run !== run) return run;
    return {
      ...run,
      ...(fragment.truncated
        ? { preview: fragment.preview, truncated: true, fullBytes: fragment.fullBytes }
        : { text: fragment.text }),
      openEnd: true,
    };
  }

  private add(run: Run): void {
    this.runsList.push(run);
    this.dirty(run);
  }

  private dirty(run: Run): void {
    this.lengths.delete(run);
  }
}
