import { NotFoundError, type TranscriptEvent } from 'runskein';

import { KNOWN_BROKEN_CAPABILITIES, verificationState } from '../engine-support.js';
import type { InstanceManifest } from '../lifecycle.js';
import type { PluginConfig } from '../plugin-config.js';
import type { InteractionRecord, RegistryObserver, SessionRecord, SessionRegistry, TurnRecord } from '@taskshuttle/core';
import { readTranscriptPage, transcriptEventOutput, type TranscriptPage } from '../transcript-page.js';
import { toPluginException } from '../error-mapper.js';
import type { PluginTranscriptStore, TranscriptStoreListener } from '../store/plugin-transcript-store.js';
import { DIFF_INDEX_LIMIT, DiffIndex, diffIndexEntryOutput, type DiffIndexEntry } from './diff-index.js';
import { RunAssembler, textChunkKey, type FoldedPage, type MessageKey } from './folded-projection.js';

/**
 * The console's read model (console-design §5/§6). Everything the HTTP surface
 * serves is projected here from the same sources the tools use — the in-memory
 * registry and the transcript store — and every projection is built from a
 * whitelist (§7.6): fields are picked, never filtered out.
 *
 * §7.8 degraded mode (`exposeTranscripts: false`) is a global response
 * whitelist, implemented here at the projection boundary: with it off, a
 * projection contains only enum states, stable IDs, timestamps, counts and
 * durations — no name/cwd, no interaction payload, no event body. Error bodies
 * stay the stable enum-like strings the server already emits.
 */

/** Forced paging (§3.3): the events endpoint never returns more per request. */
const EVENTS_PAGE_LIMIT = 100;
/** SSE backfill pages through the store at the same budget as a tool read (§5.2). */
const BACKFILL_PAGE_LIMIT = 100;
/** Forced paging for the diff index (§3.1), on the same cursor discipline as /events. */
const DIFF_PAGE_LIMIT = 500;
/** Nodes the topology graph draws (§5.5); past this the response says it is a slice. */
const TOPOLOGY_NODE_LIMIT = 200;

/**
 * The count keys of Realm's `Usage` (input/output/total/uncached/cacheRead/
 * cacheCreation/thought) — the only usage fields that may leave in degraded
 * mode (§7.8). The list is enumerated rather than derived from the value's
 * type because money is numeric too (`cost`, and any `price`-like field an
 * engine adds later); per §7.6 a field that is not listed here does not
 * leave, which deliberately means a genuinely new count field Realm adds
 * stays hidden in degraded mode until someone adds it to this list.
 */
const DEGRADED_USAGE_COUNT_KEYS: ReadonlySet<string> = new Set(['input', 'output', 'total', 'uncached', 'cacheRead', 'cacheCreation', 'thought']);

/**
 * The engine-reported usage block, projected against the §7.8 whitelist.
 * Full mode returns it verbatim; degraded mode keeps only the enumerated
 * count keys (DEGRADED_USAGE_COUNT_KEYS), and only when the value is
 * actually a finite number — a count key carrying a string is not a count.
 * Everything else stays behind, whatever its type: a cost is numeric too,
 * and so is any price-like field an engine adds later, so key names — not
 * value types — are the boundary. Do not loosen this to a type check or a
 * cost/currency strip: both pass the first numeric non-count field an
 * engine adds (§7.6).
 *
 * This is the shared pure unit (design §8.4): both the turn projection and
 * the session projection call it, so the two faces apply one filter. The
 * structural sharing is guaranteed by code review, not by a test (a member-
 * identical duplicate is behaviourally indistinguishable over HTTP).
 */
export function projectUsageBlock(usage: Record<string, unknown>, expose: boolean): Record<string, unknown> {
  if (expose) return usage;
  return Object.fromEntries(
    Object.entries(usage).filter(
      ([key, value]) => DEGRADED_USAGE_COUNT_KEYS.has(key) && typeof value === 'number' && Number.isFinite(value),
    ),
  );
}

/**
 * Upper-bound margin for one event's folded output over its raw size: the
 * run-envelope keys (`seqFrom`/`seqTo`/`kind`/`reason`, up to two runs per
 * event when the folder rides a token-usage snapshot on the envelope). The
 * folded cut check is deliberately conservative; the final whole-page
 * re-check is the backstop, mirroring readTranscriptPage.
 */
const FOLDED_RUN_OVERHEAD = 192;

/**
 * "The store has no transcript under this id" — deleted, or a live session that
 * has not appended yet. Distinguished from every other store failure, which the
 * console must surface rather than render as an empty or finished transcript.
 */
function isTranscriptAbsent(cause: unknown): boolean {
  return cause instanceof NotFoundError || (cause as { name?: unknown } | undefined)?.name === 'NotFoundError';
}

/** Unknown or deleted session; the server maps this to 404. */
export class ConsoleNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super('not found');
    this.name = 'ConsoleNotFoundError';
  }
}

export type ConsoleStreamFrame =
  | { readonly type: 'event'; readonly sessionId: string; readonly seq: number; readonly event: Record<string, unknown> }
  /** An oversized event as a reference, never its body (design §9.4). */
  | { readonly type: 'event_ref'; readonly sessionId: string; readonly seq: number; readonly totalBytes?: number; readonly sha256?: string }
  /** §5.4: the session's transcript was deleted; the server closes the stream after this frame. */
  | { readonly type: 'invalidated'; readonly sessionId: string }
  | { readonly type: 'engine_crash'; readonly engine: string }
  | { readonly type: 'transition'; readonly kind: 'session' | 'turn' | 'interaction'; readonly [field: string]: unknown };

/**
 * The execution topology (§5.5). `totalSessions` is how many visible sessions
 * exist; `truncated` says the node set is the most recent slice of them.
 */
export interface TopologyView {
  readonly nodes: Record<string, unknown>[];
  readonly edges: Record<string, unknown>[];
  readonly totalSessions: number;
  readonly truncated?: boolean;
}

/** One page of the §3.1 diff index; same cursor shape as a transcript page. */
export interface DiffIndexPage {
  readonly diffs: Record<string, unknown>[];
  readonly nextSeq: number;
  readonly highWatermark: number;
  readonly hasMore: boolean;
}

export interface ConsoleStreamSink {
  /** Called off the hot path (from a scheduled flush), in frame order. */
  send(frame: ConsoleStreamFrame): void;
  /** Ends the stream server-side; every queued frame has been sent by then. */
  end(): void;
}

export interface ConsoleDataSourceOptions {
  readonly config: PluginConfig;
  readonly registry: SessionRegistry;
  readonly store: PluginTranscriptStore;
  /**
   * Live view of the own instance manifest — a getter, not a snapshot, because
   * the host label is rewritten when the MCP client identifies itself after
   * start-up. Only the §7.6 whitelist fields are ever projected.
   */
  readonly instance: () => InstanceManifest;
  /** Registered engine ids, from the hub's inventory. */
  readonly engines: () => Promise<readonly string[]>;
  /** Realm-side transcript ids this instance deleted via transcript_delete. */
  readonly isTranscriptDeleted: (realmSessionId: string) => boolean;
  /** Tool-visibility rule (design §6.3): an unpublished fork child does not exist. */
  readonly isVisible: (sessionId: string) => boolean;
}

/**
 * One in-flight on-demand diff scan. `appended` holds what the append path
 * committed while the scan ran, in commit order; `deleted` marks a transcript
 * that went away underneath it. Both are things the scan's own reads cannot
 * observe.
 *
 * The record is not capped, and that is deliberate: dropping from it would
 * make the answer short without making it say so, which is the silently
 * truncated list §3.5 forbids. It holds references to events the scan is
 * already reading past, against a scan that legitimately holds an entry per
 * diff for the entire session.
 */
interface DiffScan {
  readonly appended: TranscriptEvent[];
  deleted?: true;
}

interface Subscriber {
  /** Plugin session id for session streams; undefined for the instance summary. */
  readonly sessionId: string | undefined;
  /** Frames ready to write on the next flush. */
  buffer: ConsoleStreamFrame[];
  /** Live frames held back while the initial backfill is still reading. */
  pending: ConsoleStreamFrame[];
  /** Backfill finished: new frames go straight to the buffer. */
  live: boolean;
  /** Invalidated: only the terminal frame remains, then the stream ends. */
  dead: boolean;
  flushScheduled: boolean;
  readonly sink: ConsoleStreamSink;
}

export class ConsoleDataSource {
  private readonly instanceSubscribers = new Set<Subscriber>();
  /** Session streams keyed by plugin session id (transitions) and Realm id (appends). */
  private readonly sessionSubscribers = new Map<string, Set<Subscriber>>();
  private readonly realmSubscribers = new Map<string, Set<Subscriber>>();
  /** §3.1 diff index, keyed by Realm session id; `complete` only when it saw the transcript from seq 1. */
  private readonly diffIndexes = new Map<string, { index: DiffIndex; complete: boolean }>();
  /** §3.5: sessions past DIFF_INDEX_LIMIT fall back to on-demand scans. */
  private readonly diffOverflow = new Set<string>();
  /**
   * On-demand scans currently in flight, keyed by Realm session id.
   *
   * The drain in `readDiffs` cannot close its own window: `highWatermark`
   * awaits the append chain it captured and then reads the watermark
   * synchronously, so an append registered against that chain commits after
   * the value was read and before `readDiffs` resumes — its fan-out finds the
   * still-incomplete append-path index and drops it, and the scan then
   * installs an index that omits it and is trusted from then on (GZH-42).
   *
   * So the append path records into every scan in flight, and the scan folds
   * that record in immediately before installing, with no await in between —
   * which is what makes the gap unreachable rather than merely narrow. A
   * delete marks the scans instead, because a scan that outlived its
   * transcript must install nothing.
   */
  private readonly diffScans = new Map<string, Set<DiffScan>>();

  constructor(private readonly options: ConsoleDataSourceOptions) {}

  private get expose(): boolean {
    return this.options.config.console.exposeTranscripts;
  }

  /** Composed into the registry's single observer slot by the runtime. */
  readonly observer: RegistryObserver = {
    onSessionTransition: (event) => this.emitTransition('session', event.sessionId, { ...event }),
    onTurnTransition: (event) => this.emitTransition('turn', event.sessionId, { ...event }),
    onInteractionTransition: (event) => this.emitTransition('interaction', event.sessionId, { ...event }),
  };

  /** Registered on the store by the runtime (§5.2: fan-out after commit). */
  readonly storeListener: TranscriptStoreListener = {
    onAppend: (sessionId, event) => this.notifyAppend(sessionId, event),
    onDelete: (sessionId) => this.notifyDelete(sessionId),
  };

  // ---- read model --------------------------------------------------------

  /**
   * Force the one piece of work `/api/instance` awaits — engine discovery —
   * before an operator's command has to wait for it.
   *
   * `console open` confirms a port's identity with a single `GET /api/instance`
   * under a fixed millisecond budget. Engine discovery costs seconds on its
   * first call and is cached from then on, so on a console nothing has touched
   * yet the probe's own request is the call that pays that cost, and the probe
   * expires before the answer arrives. That is deterministic on any machine
   * where discovery outruns the budget, not a race: the operator sees the
   * refusal on every first attempt and success on the retry that the timed-out
   * request warmed. Warming here moves the cost off that path.
   *
   * Failures are swallowed and the promise never rejects — this only fills a
   * cache, and every route that needs engines still reports its own failure
   * when asked. Callers must not await it: it runs while the instance boots.
   */
  async prewarm(): Promise<void> {
    try {
      await this.options.engines();
    } catch {
      /* see above: a cache warm has no one to report to */
    }
  }

  /** §7.6 whitelist only: instanceId, createdAt, host, alive — never pid/exePath/hashes. */
  async instanceInfo(): Promise<Record<string, unknown>> {
    const engines = (await this.options.engines()).map((engine) => ({
      engine,
      verification: verificationState(engine),
      ...this.defectsFor(engine),
    }));
    const { config } = this.options;
    const manifest = this.options.instance();
    return {
      instanceId: manifest.instanceId,
      createdAt: manifest.createdAt,
      host: manifest.host,
      alive: true,
      engines,
      // The operator's own install-surface configuration, echoed back (§7.9).
      config: {
        maxOpenSessions: config.maxOpenSessions,
        maxActiveTurns: config.maxActiveTurns,
        maxActiveTurnsPerEngine: config.maxActiveTurnsPerEngine,
        maxQueuedTurns: config.maxQueuedTurns,
        exposeTranscripts: config.console.exposeTranscripts,
        maxConsoleStreams: config.console.maxConsoleStreams,
      },
    };
  }

  listSessions(): Record<string, unknown>[] {
    return this.options.registry.listSessions()
      .filter((record) => this.options.isVisible(record.id))
      .map((record) => this.projectSession(record));
  }

  getSession(sessionId: string): Record<string, unknown> {
    const record = this.visibleSession(sessionId);
    if (record === undefined) throw new ConsoleNotFoundError();
    return this.projectSession(record);
  }

  listTurns(): Record<string, unknown>[] {
    return this.options.registry.listTurns().map((turn) => this.projectTurn(turn));
  }

  listInteractions(): Record<string, unknown>[] {
    return this.options.registry.listInteractions().map((interaction) => this.projectInteraction(interaction));
  }

  /**
   * The execution topology (§5.5): nodes are visible sessions — the same
   * projection as /api/sessions, so verification/knownDefects stay consistent —
   * plus a `lineage` tag ('root' | 'forked' | 'unknown', §10.1). Edges are the
   * four derivable relations; every edge carries a `type`. All of it is built
   * from IDs, timestamps, enum states and counts, so degraded mode
   * (§7.8/CONSOLE-018) needs no special case beyond projectSession itself.
   */
  topology(): TopologyView {
    const { registry, config } = this.options;
    const visible = registry.listSessions().filter((record) => this.options.isVisible(record.id));
    // The registry never forgets a closed session, so this list grows with the
    // process. The graph is the one route whose cost is not linear in it, and
    // it is unreadable long before the cap anyway — so the node set is the
    // most recently updated TOPOLOGY_NODE_LIMIT sessions, and the response
    // says how many it stands for rather than presenting a slice as the whole.
    const totalSessions = visible.length;
    const sessions = totalSessions <= TOPOLOGY_NODE_LIMIT
      ? visible
      : [...visible]
          // Ties broken by id so the same registry always yields the same
          // slice — descending, the same direction as the timestamp beside
          // it, so the whole ordering reads "newest first". (The time-edge
          // sweep below breaks ties ascending because it walks time forward.)
          .sort((a, b) => ((Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
          .slice(0, TOPOLOGY_NODE_LIMIT);
    const nodes = sessions.map((record) => ({
      ...this.projectSession(record),
      lineage: record.parentSessionId === undefined ? 'unknown' : record.parentSessionId === null ? 'root' : 'forked',
    }));
    const visibleIds = new Set(sessions.map((record) => record.id));
    const edges: Record<string, unknown>[] = [];

    // fork: the recorded parent pointer (§5.5), drawn only when the parent is
    // itself a visible node — a closed-and-dropped parent leaves no dangling edge.
    for (const record of sessions) {
      if (typeof record.parentSessionId === 'string' && visibleIds.has(record.parentSessionId)) {
        edges.push({ type: 'fork', from: record.parentSessionId, to: record.id });
      }
    }

    const turns = registry.listTurns();
    // Bucketed once: walking every turn per session was the second quadratic
    // here, and the time edges below need the same grouping.
    const turnsBySession = new Map<string, TurnRecord[]>();
    for (const turn of turns) {
      const group = turnsBySession.get(turn.sessionId);
      if (group === undefined) turnsBySession.set(turn.sessionId, [turn]);
      else group.push(turn);
    }
    // schedule_wait (§5.5/§10.1): a queued turn whose engine's execution slots
    // are all occupied. Only per-engine contention produces an edge — the
    // engine id is just the grouping key, so newly admitted engines work
    // unchanged; global maxActiveTurns contention has no per-engine "who" to
    // point at and is not reported.
    const limit = config.maxActiveTurnsPerEngine;
    const occupying = new Map<string, TurnRecord[]>();
    for (const turn of turns) {
      if (turn.state !== 'running' && turn.state !== 'awaiting-interaction') continue;
      const holders = occupying.get(turn.engine) ?? [];
      holders.push(turn);
      occupying.set(turn.engine, holders);
    }
    const nowMs = Date.now();
    for (const turn of turns) {
      if (turn.state !== 'queued' || !visibleIds.has(turn.sessionId)) continue;
      // `occupied` counts every holder — that is the contention the edge is
      // about — but `to` may only name nodes the response actually carries.
      // Unfiltered, a holder whose session fell outside the node slice left an
      // edge pointing at a node the client cannot draw.
      const allHolders = occupying.get(turn.engine) ?? [];
      const holders = allHolders.filter((holder) => visibleIds.has(holder.sessionId));
      if (allHolders.length < limit) continue;
      const enqueuedMs = Date.parse(turn.enqueuedAt);
      edges.push({
        type: 'schedule_wait',
        turnId: turn.id,
        sessionId: turn.sessionId,
        to: holders.map((holder) => holder.sessionId),
        engine: turn.engine,
        occupied: allHolders.length,
        limit,
        priority: turn.priority,
        ...(Number.isFinite(enqueuedMs) ? { waitedMs: Math.max(0, nowMs - enqueuedMs) } : {}),
      });
    }

    // cwd_overlap (§5.5): live sessions sharing a working directory. Strictly a
    // hint — the plugin does not manage workspaces (mvp §3.3), so a shared cwd
    // is never rendered as a proven dependency.
    const byCwd = new Map<string, SessionRecord[]>();
    for (const record of sessions) {
      if (record.state === 'closed' || record.state === 'failed') continue;
      const group = byCwd.get(record.cwd) ?? [];
      group.push(record);
      byCwd.set(record.cwd, group);
    }
    for (const [cwd, group] of byCwd) {
      if (group.length < 2) continue;
      edges.push({
        type: 'cwd_overlap',
        sessions: group.map((record) => record.id),
        hint: true,
        // §7.8: the cwd value itself is content-adjacent; degraded mode gets
        // the grouping without the path.
        ...(this.expose ? { cwd } : {}),
      });
    }

    // time (§10.1): session A's last activity — the latest finishedAt across
    // its turns, else its closedAt — ended strictly before session B's first
    // turn started. Ordering only, never a dependency; a session with neither
    // a finished turn nor a closedAt takes part in no time edge.
    //
    // Only B's IMMEDIATE predecessor gets an edge. Drawing every earlier
    // session was the whole "before" relation — quadratic to compute and to
    // serialize, and every edge past the nearest one is implied by following
    // the chain. The reading "A ran before B" survives transitively; what goes
    // is a picture that was unreadable and a response that grew with the
    // square of a list the registry never shortens.
    const ended: Array<{ id: string; ms: number; at: string }> = [];
    const started: Array<{ id: string; ms: number; at: string }> = [];
    for (const record of sessions) {
      let lastMs = Number.NEGATIVE_INFINITY;
      let lastAt = '';
      let firstMs = Number.POSITIVE_INFINITY;
      let firstAt = '';
      for (const turn of turnsBySession.get(record.id) ?? []) {
        if (turn.finishedAt !== undefined) {
          const ms = Date.parse(turn.finishedAt);
          if (Number.isFinite(ms) && ms > lastMs) { lastMs = ms; lastAt = turn.finishedAt; }
        }
        if (turn.startedAt !== undefined) {
          const ms = Date.parse(turn.startedAt);
          if (Number.isFinite(ms) && ms < firstMs) { firstMs = ms; firstAt = turn.startedAt; }
        }
      }
      if (!Number.isFinite(lastMs) && record.closedAt !== undefined) {
        const ms = Date.parse(record.closedAt);
        if (Number.isFinite(ms)) { lastMs = ms; lastAt = record.closedAt; }
      }
      if (Number.isFinite(lastMs)) ended.push({ id: record.id, ms: lastMs, at: lastAt });
      if (Number.isFinite(firstMs)) started.push({ id: record.id, ms: firstMs, at: firstAt });
    }
    // Both sides sorted, then one forward sweep: rescanning `ended` per start
    // would keep the quadratic the edge rule was narrowed to remove, just with
    // fewer edges to show for it. Ties broken by id so the same registry
    // always yields the same graph.
    const byTime = (a: { ms: number; id: string }, b: { ms: number; id: string }): number =>
      (a.ms - b.ms) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    ended.sort(byTime);
    started.sort(byTime);
    let cursor = 0;
    // The two most recent ends seen so far: the nearest one may be the started
    // session itself, which is not its own predecessor.
    let last: { id: string; ms: number; at: string } | undefined;
    let previous: { id: string; ms: number; at: string } | undefined;
    for (const b of started) {
      while (cursor < ended.length && ended[cursor]!.ms < b.ms) {
        previous = last;
        last = ended[cursor];
        cursor += 1;
      }
      const predecessor = last === undefined ? undefined : last.id === b.id ? previous : last;
      if (predecessor !== undefined && predecessor.id !== b.id) {
        edges.push({ type: 'time', from: predecessor.id, to: b.id, fromEndedAt: predecessor.at, toStartedAt: b.at });
      }
    }

    return {
      nodes,
      edges,
      totalSessions,
      ...(nodes.length < totalSessions ? { truncated: true } : {}),
    };
  }

  /**
   * The events endpoint (§5.1): same exclusive cursor, watermark and byte
   * budget as `transcript_read`, via the shared pagination core. In degraded
   * mode an event projects to its whitelist-safe envelope only (§7.8).
   *
   * `toSeq` (console-v2 §3.2) is the raw projection's closed-interval upper
   * bound — the expansion path behind a truncated folded preview. Unset, the
   * behavior is byte-identical to before.
   */
  async readEvents(sessionId: string, afterSeq: number, toSeq?: number): Promise<TranscriptPage> {
    const target = this.streamTarget(sessionId);
    if (target === undefined) throw new ConsoleNotFoundError();
    const { store, config } = this.options;
    const highWatermark = await store.highWatermark(target.realmSessionId).catch((cause: unknown) => {
      // A live session that has produced no event yet is an empty page; a
      // deleted transcript is 404 (design §9.5) — streamTarget already ruled
      // that out, so anything left is the empty live session. A store failure
      // is not either of those and must not be reported as an empty transcript.
      if (isTranscriptAbsent(cause)) return 0;
      throw cause;
    });
    return readTranscriptPage(store, target.realmSessionId, highWatermark, {
      afterSeq,
      limit: EVENTS_PAGE_LIMIT,
      budgetBytes: config.responseByteBudget,
      ...(toSeq === undefined ? {} : { toSeq }),
      project: this.eventProjector(),
    });
  }

  /**
   * The folded projection (console-v2 §3.2, ADR 0010): one page of raw events
   * through the same `runskein/fold` the browser runs, assembled into runs.
   * Runs never span pages; the continuation cursor stays the event seq, so the
   * client can switch back to the raw projection losslessly. The page obeys the
   * same byte budget as raw paging, accounted per run.
   */
  async readEventsFolded(sessionId: string, afterSeq: number): Promise<FoldedPage | TranscriptPage> {
    // §3.4 / ADR 0010 constraint 3: degraded mode is declared here, in the
    // projection — never inherited from routing. The degraded form IS the raw
    // degraded page: seq/ts/byteLen envelopes, no folded shapes.
    if (!this.expose) return this.readEvents(sessionId, afterSeq);
    const target = this.streamTarget(sessionId);
    if (target === undefined) throw new ConsoleNotFoundError();
    const { store, config } = this.options;
    const budget = config.responseByteBudget;
    const highWatermark = await store.highWatermark(target.realmSessionId).catch((cause: unknown) => {
      // Same policy as readEvents: absent transcript of a live session is an
      // empty page; every other store failure is surfaced.
      if (isTranscriptAbsent(cause)) return 0;
      throw cause;
    });
    // openStart (§3.2): one boolean derived from the event at the cursor. Its
    // body never enters the page — every run's seqFrom stays ≥ afterSeq + 1.
    let openStartKey: MessageKey | undefined;
    if (afterSeq >= 1 && afterSeq <= highWatermark) {
      for await (const previous of store.read(target.realmSessionId, { fromSeq: afterSeq, toSeq: afterSeq })) {
        openStartKey = textChunkKey(previous);
      }
    }
    const assembler = new RunAssembler(openStartKey);
    // Same accounting idiom as readTranscriptPage: the envelope is measured
    // once with the widest dynamic values; a final stringify re-checks.
    const envelope = Buffer.byteLength(JSON.stringify({ runs: [], nextSeq: highWatermark + 1, highWatermark, hasMore: true }), 'utf8');
    let nextSeq = afterSeq + 1;
    let hasMore = false;
    if (afterSeq < highWatermark) {
      let consumed = 0;
      for await (const event of store.read(target.realmSessionId, { fromSeq: afterSeq + 1, toSeq: highWatermark })) {
        if (consumed === EVENTS_PAGE_LIMIT) {
          hasMore = true;
          break;
        }
        const eventBytes = Buffer.byteLength(JSON.stringify(transcriptEventOutput(event)), 'utf8');
        if (consumed === 0 && envelope + eventBytes > budget) {
          // §9.4 / ADR 0006: an oversized event never enters the folder; the
          // page carries a reference run. The fold keeps an open message open
          // across it (the folder never saw the event); the live UI settles
          // the message at the reference instead — see folded-projection.
          const canonical = await store.canonicalEvent(target.realmSessionId, event.seq);
          assembler.addOversizedReference(event.seq, canonical);
          consumed += 1;
          nextSeq = event.seq + 1;
          continue;
        }
        // The cut falls between events, never inside one (ADR 0010
        // constraints 4/6): the estimate is the event's raw size plus the
        // run-key overhead, and the projection only ever derives less.
        if (consumed > 0 && envelope + assembler.serializedBytes() + eventBytes + FOLDED_RUN_OVERHEAD > budget) {
          hasMore = true;
          break;
        }
        assembler.pushEvent(event);
        consumed += 1;
        nextSeq = event.seq + 1;
      }
    }
    if (!hasMore) hasMore = nextSeq <= highWatermark;
    // §3.2: a message still open at the cut is a fragment, and carries
    // `openEnd` whether or not a further page follows — its continuation may
    // arrive over the raw SSE seam instead (seam three).
    assembler.finish();
    const page: FoldedPage = { runs: [...assembler.runs], nextSeq, highWatermark, hasMore };
    if (Buffer.byteLength(JSON.stringify(page), 'utf8') > budget) {
      throw toPluginException({
        code: 'PAYLOAD_TOO_LARGE',
        message: 'folded transcript page exceeds the configured response byte budget',
        details: { responseByteBudget: budget },
      });
    }
    return page;
  }

  /**
   * The diff index route (console-v2 §3.1): every diff-carrying tool call of
   * the session, content excluded. Lifecycle per §3.5: maintained on the
   * append fan-out; a session the index has never seen authoritatively
   * (restart, archive) is rebuilt by one on-demand scan of its events; a
   * session past DIFF_INDEX_LIMIT scans on every request rather than serving
   * a truncated list; transcript_delete clears it (notifyDelete). The answer
   * is paged on the same exclusive `afterSeq` cursor and response byte budget
   * as /events (pageDiffs) — the scan path has no cap of its own.
   */
  async readDiffs(sessionId: string, afterSeq: number): Promise<DiffIndexPage> {
    const target = this.streamTarget(sessionId);
    if (target === undefined) throw new ConsoleNotFoundError();
    const { store, config } = this.options;
    let highWatermark = await store.highWatermark(target.realmSessionId).catch((cause: unknown) => {
      if (isTranscriptAbsent(cause)) return 0;
      throw cause;
    });
    // §3.4 / ADR 0010 constraint 3: declared here, not inherited — `path` and
    // `tool` are not §7.8 whitelist fields, so degraded mode gets the empty
    // index, and the UI hides the Diff toggle.
    if (!this.expose) return { diffs: [], nextSeq: afterSeq + 1, highWatermark, hasMore: false };
    if (highWatermark === 0) return { diffs: [], nextSeq: afterSeq + 1, highWatermark, hasMore: false };
    let entries: readonly DiffIndexEntry[];
    const state = this.diffIndexes.get(target.realmSessionId);
    if (state !== undefined && state.complete && !state.index.overflow && !this.diffOverflow.has(target.realmSessionId)) {
      entries = state.index.entries;
    } else {
      // Restart/archive or overflow: one honest scan of the session's events
      // (§3.5). The store offers no content pre-filter, so the read volume is
      // the session's — paid once, and only when the result fits the cap.
      const scanned = new DiffIndex(Number.MAX_SAFE_INTEGER);
      let maxSeq = 0;
      // Registered before the first read: from here to the install, every
      // append this session commits is recorded for this scan (GZH-42).
      const scan = this.openDiffScan(target.realmSessionId);
      try {
        // The opening read gets the same absent-transcript answer the drain's
        // reads already gave. A transcript deleted between this call's
        // watermark and the scan's snapshot is gone, not broken, and the empty
        // index is what "gone" looks like on this route.
        try {
          for await (const event of store.read(target.realmSessionId)) {
            scanned.addEvent(event);
            if (event.seq > maxSeq) maxSeq = event.seq;
          }
        } catch (cause: unknown) {
          if (!isTranscriptAbsent(cause)) throw cause;
          return { diffs: [], nextSeq: afterSeq + 1, highWatermark: 0, hasMore: false };
        }
        // The scan's read is a snapshot captured at invocation (the store
        // documents exactly that), so an append that landed while the scan
        // streamed is in neither the snapshot nor the append-path index — an
        // index created mid-flight by maintainDiffIndex is incomplete and
        // drops it. Drain the increment into the same scan, re-reading from
        // the last seen seq until it comes back empty.
        //
        // This loop closes most of the gap and **not the last of it**: its
        // watermark read resolves before the append that registered against
        // the same chain commits, so that append is invisible here. What
        // closes it is the record folded in after this loop — see `diffScans`.
        // A delete is split the same way: a transcript already gone when a
        // read or a watermark call runs answers the empty index here, and one
        // that lands after them is caught by the scan's `deleted` mark.
        for (;;) {
          const watermark = await store.highWatermark(target.realmSessionId).catch((cause: unknown) => {
            if (isTranscriptAbsent(cause)) return -1;
            throw cause;
          });
          if (watermark < 0) return { diffs: [], nextSeq: afterSeq + 1, highWatermark: 0, hasMore: false };
          if (watermark <= maxSeq) break;
          let grew = false;
          // Same catch as the opening read, for the same reason: the watermark
          // call above converts an absent transcript into the empty index, and
          // a delete landing between it and this read would otherwise leave
          // one of the two reachable ways to lose a transcript answering with
          // a store error and the other with an empty page.
          try {
            for await (const event of store.read(target.realmSessionId, { fromSeq: maxSeq + 1, toSeq: watermark })) {
              scanned.addEvent(event);
              if (event.seq > maxSeq) maxSeq = event.seq;
              grew = true;
            }
          } catch (cause: unknown) {
            if (!isTranscriptAbsent(cause)) throw cause;
            return { diffs: [], nextSeq: afterSeq + 1, highWatermark: 0, hasMore: false };
          }
          if (!grew) break;
        }
        // Everything the append path committed while this scan ran, folded in
        // here and not one await earlier: from this loop to the install below
        // the code never yields, so no further append can slip between what
        // the index holds and the claim that it is complete. Events at or
        // below `maxSeq` are already in — the drain and the record overlap by
        // design, and the seq comparison is what keeps that from double-adding.
        for (const event of scan.appended) {
          if (event.seq <= maxSeq) continue;
          scanned.addEvent(event);
          maxSeq = event.seq;
        }
        // A transcript deleted while the scan ran leaves nothing to install:
        // the fan-out already dropped the session's index, and re-installing
        // this scan's result would resurrect it.
        if (scan.deleted === true) return { diffs: [], nextSeq: afterSeq + 1, highWatermark: 0, hasMore: false };
        if (scanned.size <= DIFF_INDEX_LIMIT) {
          scanned.limit = DIFF_INDEX_LIMIT;
          this.diffIndexes.set(target.realmSessionId, { index: scanned, complete: true });
          this.diffOverflow.delete(target.realmSessionId);
        } else {
          this.diffIndexes.delete(target.realmSessionId);
          this.diffOverflow.add(target.realmSessionId);
        }
        entries = scanned.entries;
        // The drain read past the watermark this call opened with; reporting the
        // stale one would answer with a diff the watermark says cannot exist.
        if (maxSeq > highWatermark) highWatermark = maxSeq;
      } finally {
        this.closeDiffScan(target.realmSessionId, scan);
      }
    }
    return this.pageDiffs(entries, afterSeq, highWatermark, config.responseByteBudget);
  }

  /**
   * One page of the diff index (§3.1). The route is a content route like any
   * other, so it obeys §5.1's forced paging and the same response byte budget:
   * the on-demand scan path of §3.5 can legitimately hold far more than
   * DIFF_INDEX_LIMIT entries, and answering that in one unbounded body is the
   * silent-truncation failure §3.5 forbids, wearing the opposite mask.
   *
   * The cut falls on seq boundaries only: one `tool_call` event can carry
   * several diff items, and they share its seq — an exclusive `afterSeq`
   * cursor cannot address half of such a group, so a group is taken whole or
   * left for the next page.
   */
  private pageDiffs(
    entries: readonly DiffIndexEntry[],
    afterSeq: number,
    reportedWatermark: number,
    budgetBytes: number,
  ): DiffIndexPage {
    const pending = entries.filter((entry) => entry.seq > afterSeq);
    // An indexed entry came from a committed append, so its seq is real
    // whatever the watermark read a moment ago said. The append fan-out is
    // synchronous with the commit while the watermark read is not, so on the
    // cached path an append landing during that await is already in `entries`
    // and above the number the caller is holding — the answer would list a
    // diff its own watermark says cannot exist yet. Report what the answer
    // actually covers.
    let highWatermark = reportedWatermark;
    for (const entry of entries) if (entry.seq > highWatermark) highWatermark = entry.seq;
    const diffs: Record<string, unknown>[] = [];
    let nextSeq = afterSeq + 1;
    let hasMore = false;
    // Measured once with the widest dynamic values, as readTranscriptPage does.
    let used = Buffer.byteLength(JSON.stringify({ diffs: [], nextSeq: highWatermark + 1, highWatermark, hasMore: true }), 'utf8');
    let groupSeq: number | undefined;
    for (const entry of pending) {
      const atGroupBoundary = entry.seq !== groupSeq;
      if (atGroupBoundary && (diffs.length >= DIFF_PAGE_LIMIT || used > budgetBytes)) {
        hasMore = true;
        break;
      }
      const projected = diffIndexEntryOutput(entry);
      used += Buffer.byteLength(JSON.stringify(projected), 'utf8') + (diffs.length === 0 ? 0 : 1);
      diffs.push(projected);
      groupSeq = entry.seq;
      nextSeq = entry.seq + 1;
    }
    // The budget check runs at group boundaries only, so the group that
    // crosses it is completed rather than split — including the case of one
    // group bigger than the whole budget. That is the intended overshoot: an
    // entry is counts plus one path, and half a group has no cursor that
    // addresses it.
    return { diffs, nextSeq, highWatermark, hasMore };
  }

  /** Realm-side id for a visible, not-deleted session; undefined → the caller answers 404. */
  streamTarget(sessionId: string): { realmSessionId: string } | undefined {
    const record = this.visibleSession(sessionId);
    if (record === undefined) return undefined;
    const realmSessionId = record.realmSessionId ?? record.id;
    if (this.options.isTranscriptDeleted(realmSessionId)) return undefined;
    return { realmSessionId };
  }

  // ---- streams -----------------------------------------------------------

  /**
   * Attach a session or instance summary stream (§6). The session form
   * backfills from the store first — its reads await the same per-session
   * append chain a tool read waits on — while live frames are held in
   * `pending`; after the catch-up they are deduplicated by seq and released,
   * and from then on events arrive purely by append fan-out (zero steady-state
   * SQLite reads, §5.2). Returns the unsubscribe function.
   */
  async openStream(options: { sessionId?: string; afterSeq: number; sink: ConsoleStreamSink }): Promise<() => void> {
    const subscriber: Subscriber = {
      sessionId: options.sessionId,
      buffer: [],
      pending: [],
      live: options.sessionId === undefined,
      dead: false,
      flushScheduled: false,
      sink: options.sink,
    };
    if (options.sessionId === undefined) {
      this.instanceSubscribers.add(subscriber);
      return () => {
        this.instanceSubscribers.delete(subscriber);
      };
    }
    const sessionId = options.sessionId;
    const target = this.streamTarget(sessionId);
    if (target === undefined) throw new ConsoleNotFoundError();
    this.addSubscriber(this.sessionSubscribers, sessionId, subscriber);
    this.addSubscriber(this.realmSubscribers, target.realmSessionId, subscriber);
    const unsubscribe = (): void => {
      this.sessionSubscribers.get(sessionId)?.delete(subscriber);
      this.realmSubscribers.get(target.realmSessionId)?.delete(subscriber);
    };
    try {
      await this.backfill(subscriber, sessionId, target.realmSessionId, options.afterSeq);
    } catch (error) {
      // Drop the subscription and hand the failure back. Ending the sink here
      // and returning normally would leave two owners of the response: the
      // caller would take the return as success and write to a stream this
      // method had already closed, and a write after end on a ServerResponse is
      // an *uncaught* ERR_STREAM_WRITE_AFTER_END — a store hiccup during
      // backfill would take the process down. The caller owns the response and
      // already ends it on a throw; the client reconnects from Last-Event-ID.
      unsubscribe();
      throw error;
    }
    return unsubscribe;
  }

  /** hub engine:crash, fanned out as an instance-level summary frame. */
  notifyEngineCrash(engine: string): void {
    const frame: ConsoleStreamFrame = { type: 'engine_crash', engine };
    for (const subscriber of this.instanceSubscribers) this.push(subscriber, frame);
  }

  // ---- internals ----------------------------------------------------------

  private visibleSession(sessionId: string): SessionRecord | undefined {
    if (!this.options.isVisible(sessionId)) return undefined;
    return this.options.registry.getSession(sessionId);
  }

  /** §5.6: recorded defects sit beside an engine's claims, verbatim capability paths. */
  private defectsFor(engine: string): { knownDefects?: string[] } {
    const defects = KNOWN_BROKEN_CAPABILITIES.filter((entry) => entry.engine === engine).map((entry) => entry.capability);
    return defects.length > 0 ? { knownDefects: defects } : {};
  }

  private projectSession(record: SessionRecord): Record<string, unknown> {
    const base: Record<string, unknown> = {
      sessionId: record.id,
      engine: record.engine,
      state: record.state,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.closedAt === undefined ? {} : { closedAt: record.closedAt }),
      ...(record.activeTurnId === undefined ? {} : { activeTurnId: record.activeTurnId }),
      verification: verificationState(record.engine),
      ...this.defectsFor(record.engine),
      ...(record.failure === undefined ? {} : { failure: this.expose ? record.failure : { code: record.failure.code } }),
      // Session cumulative usage goes through the same whitelist as the turn
      // projection, in both modes (design §6.1 / CONSOLE-037): degraded mode
      // keeps only the count keys. Observed config is omitted in degraded mode
      // entirely — its values are model names and reasoning tiers, which are
      // strings and not on the §7.8 whitelist (CONSOLE-038). Letting config
      // values out in degraded mode would widen a security boundary and needs
      // its own ADR (design §6.2); the comment guards the next well-meaning
      // loosening.
      ...(record.usage === undefined ? {} : { usage: projectUsageBlock(record.usage, this.expose) }),
    };
    // §7.8: name and cwd are content-adjacent; they exist only in full mode.
    if (!this.expose) return base;
    return {
      ...base,
      ...(record.name === undefined ? {} : { name: record.name }),
      cwd: record.cwd,
      permissionMode: record.permissionMode,
      ...(record.observedConfig === undefined ? {} : { observedConfig: record.observedConfig }),
    };
  }

  /**
   * Turn records carry no content fields worth suppressing — the prompt never
   * leaves — except the engine-reported usage block (§7.8): token counts are
   * counts and may be shown in degraded mode, but a cost amount and its
   * currency are not counts, so the block goes through a whitelist check of
   * its own (projectUsageBlock) before it leaves in either mode.
   */
  private projectTurn(turn: TurnRecord): Record<string, unknown> {
    const enqueuedAt = Date.parse(turn.enqueuedAt);
    const startedMs = turn.startedAt === undefined ? undefined : Date.parse(turn.startedAt);
    const finishedMs = turn.finishedAt === undefined ? undefined : Date.parse(turn.finishedAt);
    return {
      turnId: turn.id,
      sessionId: turn.sessionId,
      engine: turn.engine,
      state: turn.state,
      priority: turn.priority,
      // JSON has no bigint; enqueueSeq is an opaque ordering token as a string.
      enqueueSeq: turn.enqueueSeq.toString(),
      acceptedAt: turn.acceptedAt,
      enqueuedAt: turn.enqueuedAt,
      ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
      ...(turn.finishedAt === undefined ? {} : { finishedAt: turn.finishedAt }),
      ...(startedMs === undefined || !Number.isFinite(enqueuedAt) ? {} : { queuedMs: Math.max(0, startedMs - enqueuedAt) }),
      ...(startedMs === undefined || finishedMs === undefined ? {} : { durationMs: Math.max(0, finishedMs - startedMs) }),
      ...(turn.usage === undefined ? {} : { usage: projectUsageBlock(turn.usage, this.expose) }),
      ...(turn.error === undefined ? {} : { errorCode: turn.error.code }),
    };
  }

  private projectInteraction(interaction: InteractionRecord): Record<string, unknown> {
    const base: Record<string, unknown> = {
      interactionId: interaction.id,
      turnId: interaction.turnId,
      sessionId: interaction.sessionId,
      kind: interaction.kind,
      state: interaction.state,
      createdAt: interaction.createdAt,
      ...(interaction.expiresAt === undefined ? {} : { expiresAt: interaction.expiresAt }),
      ...(interaction.resolvedAt === undefined ? {} : { resolvedAt: interaction.resolvedAt }),
    };
    // §7.8 names this leak path explicitly: the payload IS the content.
    if (!this.expose) return base;
    return { ...base, payload: interaction.payload };
  }

  /** Full projection, or the whitelist-safe envelope in degraded mode (§7.8). */
  private eventProjector(): (event: TranscriptEvent) => Record<string, unknown> {
    if (this.expose) return transcriptEventOutput;
    return (event) => ({ seq: event.seq, ts: event.ts, byteLen: Buffer.byteLength(JSON.stringify(event), 'utf8') });
  }

  private emitTransition(kind: 'session' | 'turn' | 'interaction', sessionId: string, fields: Record<string, unknown>): void {
    // Unpublished sessions are invisible to the tool surface (design §6.3), so
    // the console — bound by the same closure (§7.9) — never announces them.
    if (!this.options.isVisible(sessionId)) return;
    const frame: ConsoleStreamFrame = { type: 'transition', kind, ...fields };
    for (const subscriber of this.instanceSubscribers) this.push(subscriber, frame);
    const subscribers = this.sessionSubscribers.get(sessionId);
    if (subscribers !== undefined) for (const subscriber of subscribers) this.push(subscriber, frame);
  }

  private notifyAppend(realmSessionId: string, event: TranscriptEvent): void {
    // §3.5: the diff index rides the same post-commit fan-out (§5.2), whether
    // or not anyone is subscribed. In degraded mode it is never built — the
    // route could not serve it anyway (§3.4).
    if (this.expose) this.maintainDiffIndex(realmSessionId, event);
    const subscribers = this.realmSubscribers.get(realmSessionId);
    if (subscribers === undefined) return;
    // The frame addresses the session by the plugin id the UI subscribed with;
    // the projected event keeps the Realm id inside, as transcript_read does.
    // Addressed per subscriber rather than once from the first of them: this set
    // is keyed by the Realm id, and taking one subscriber's plugin id to label
    // everyone's frame is only correct while no two plugin sessions ever share
    // one Realm transcript. `notifyDelete` already addresses each subscriber
    // individually; these two should not disagree about that.
    const projected = this.eventProjector()(event);
    for (const subscriber of subscribers) {
      this.push(subscriber, { type: 'event', sessionId: subscriber.sessionId ?? realmSessionId, seq: event.seq, event: projected });
    }
  }

  /** Register a scan so the append path records into it; paired with `closeDiffScan`. */
  private openDiffScan(realmSessionId: string): DiffScan {
    const scan: DiffScan = { appended: [] };
    const scans = this.diffScans.get(realmSessionId) ?? new Set<DiffScan>();
    scans.add(scan);
    this.diffScans.set(realmSessionId, scans);
    return scan;
  }

  /** Unregister a finished scan, dropping the session's set once it is empty. */
  private closeDiffScan(realmSessionId: string, scan: DiffScan): void {
    const scans = this.diffScans.get(realmSessionId);
    if (scans === undefined) return;
    scans.delete(scan);
    if (scans.size === 0) this.diffScans.delete(realmSessionId);
  }

  /**
   * §3.5: index one appended event. The index is authoritative only when it
   * saw the transcript from its first event (seq 1); anything else — a
   * session that predates this process — is rebuilt by the on-demand scan in
   * readDiffs. Past DIFF_INDEX_LIMIT the session drops out of the index and
   * scans on demand from then on.
   */
  private maintainDiffIndex(realmSessionId: string, event: TranscriptEvent): void {
    // Recorded for every scan in flight before anything else is decided: an
    // overflowed or incomplete index drops this event, and the scan about to
    // install is then the only place it can still come from (GZH-42).
    for (const scan of this.diffScans.get(realmSessionId) ?? []) scan.appended.push(event);
    if (this.diffOverflow.has(realmSessionId)) return;
    let state = this.diffIndexes.get(realmSessionId);
    if (state === undefined) {
      state = { index: new DiffIndex(), complete: event.seq === 1 };
      this.diffIndexes.set(realmSessionId, state);
    }
    if (!state.complete) return;
    state.index.addEvent(event);
    if (state.index.overflow) {
      this.diffIndexes.delete(realmSessionId);
      this.diffOverflow.add(realmSessionId);
    }
  }

  /** §5.4: every subscriber to a deleted session gets the terminal frame, then ends. */
  private notifyDelete(realmSessionId: string): void {
    // §3.5: the diff index follows the transcript it derived from.
    this.diffIndexes.delete(realmSessionId);
    this.diffOverflow.delete(realmSessionId);
    // A scan in flight is derived from the same transcript. Clearing the map
    // alone would let it install its result afterwards, putting the deleted
    // session's index back (GZH-42).
    for (const scan of this.diffScans.get(realmSessionId) ?? []) scan.deleted = true;
    const subscribers = this.realmSubscribers.get(realmSessionId);
    if (subscribers === undefined) return;
    this.realmSubscribers.delete(realmSessionId);
    for (const subscriber of subscribers) {
      if (subscriber.sessionId !== undefined) {
        const set = this.sessionSubscribers.get(subscriber.sessionId);
        set?.delete(subscriber);
        if (set !== undefined && set.size === 0) this.sessionSubscribers.delete(subscriber.sessionId);
      }
      subscriber.dead = true;
      subscriber.pending = [];
      // The UI knows the session by its plugin id; the Realm id never leaves.
      subscriber.buffer = [{ type: 'invalidated', sessionId: subscriber.sessionId ?? realmSessionId }];
      this.scheduleFlush(subscriber);
    }
  }

  private addSubscriber(map: Map<string, Set<Subscriber>>, key: string, subscriber: Subscriber): void {
    const set = map.get(key) ?? new Set<Subscriber>();
    set.add(subscriber);
    map.set(key, set);
  }

  /**
   * Buffer a frame and defer the socket write. Both producers — the registry
   * observer and the store listener — run inside someone else's mutation, so
   * nothing here may touch a socket synchronously.
   */
  private push(subscriber: Subscriber, frame: ConsoleStreamFrame): void {
    if (subscriber.dead) return;
    if (subscriber.live) subscriber.buffer.push(frame);
    else subscriber.pending.push(frame);
    this.scheduleFlush(subscriber);
  }

  private scheduleFlush(subscriber: Subscriber): void {
    if (subscriber.flushScheduled) return;
    subscriber.flushScheduled = true;
    setImmediate(() => this.flush(subscriber));
  }

  private flush(subscriber: Subscriber): void {
    subscriber.flushScheduled = false;
    const frames = subscriber.buffer;
    subscriber.buffer = [];
    for (const frame of frames) subscriber.sink.send(frame);
    // The invalidated frame is written before the close — guaranteed by the
    // single ordered buffer (§5.4).
    if (subscriber.dead) subscriber.sink.end();
  }

  private async backfill(subscriber: Subscriber, sessionId: string, realmSessionId: string, afterSeq: number): Promise<void> {
    const { store, config } = this.options;
    let cursor = afterSeq;
    for (;;) {
      if (subscriber.dead) return;
      // highWatermark/read both await this session's append chain — the same
      // lane discipline a tool read obeys, and the lane is never held.
      //
      // Only "no such transcript" ends the backfill quietly: deleted
      // mid-backfill (the queued invalidated frame is the answer) or a live
      // session that has not produced an event yet. Every other store failure
      // is rethrown, because swallowing it would put the subscriber into a live
      // stream that had silently skipped history — a stream that looks healthy
      // and is missing events is worse than one that closed and can be resumed
      // from Last-Event-ID. A page read two lines below already fails this way;
      // the two must not disagree about the same class of error.
      const highWatermark = await store.highWatermark(realmSessionId).catch((cause: unknown) => {
        if (isTranscriptAbsent(cause)) return -1;
        throw cause;
      });
      if (highWatermark < 0 || cursor >= highWatermark) break;
      try {
        const page = await readTranscriptPage(store, realmSessionId, highWatermark, {
          afterSeq: cursor,
          limit: BACKFILL_PAGE_LIMIT,
          budgetBytes: config.responseByteBudget,
          project: this.eventProjector(),
        });
        for (const event of page.events) {
          const seq = event['seq'] as number;
          this.deliver(subscriber, { type: 'event', sessionId, seq, event });
          cursor = seq;
        }
        if (!page.hasMore) break;
      } catch (error) {
        const details = (error as { code?: unknown; details?: Record<string, unknown> }).details;
        if ((error as { code?: unknown }).code === 'PAYLOAD_TOO_LARGE' && typeof details?.['seq'] === 'number') {
          // An oversized event streams as a reference and the stream continues
          // past it (design §9.4); a page-oriented fetch fails instead.
          const seq = details['seq'];
          this.deliver(subscriber, {
            type: 'event_ref',
            sessionId,
            seq,
            ...(typeof details['totalBytes'] === 'number' ? { totalBytes: details['totalBytes'] } : {}),
            ...(typeof details['sha256'] === 'string' ? { sha256: details['sha256'] } : {}),
          });
          cursor = seq;
          continue;
        }
        throw error;
      }
    }
    // Live frames that arrived during the catch-up are released in order;
    // anything at or below the cursor was already delivered by the backfill.
    subscriber.live = true;
    const pending = subscriber.pending;
    subscriber.pending = [];
    for (const frame of pending) {
      if ((frame.type === 'event' || frame.type === 'event_ref') && frame.seq <= cursor) continue;
      subscriber.buffer.push(frame);
    }
    if (subscriber.buffer.length > 0) this.scheduleFlush(subscriber);
  }

  /** Backfill frames join the same ordered buffer as live ones (never `pending`). */
  private deliver(subscriber: Subscriber, frame: ConsoleStreamFrame): void {
    if (subscriber.dead) return;
    subscriber.buffer.push(frame);
    this.scheduleFlush(subscriber);
  }
}
