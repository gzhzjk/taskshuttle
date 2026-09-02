import { createFolder } from 'runskein/fold';

import { diffLines } from './diff-lines.js';
import { deriveDiffEntries } from './diff-sources.js';
import { backfillToolSnapshot, mergeToolRow } from './tool-row-state.js';
import { contentLabel, noticeLabel, toolArgsView } from './content-labels.js';
import { renderedSeqAfterPage } from './backfill-cursor.js';
import { applyPreviewPolicy, composeRunText, thoughtDisplay } from './run-text.js';
import { continuesOpenRun, joinFragmentContent } from './seam-merge.js';
import { CONNECTING, OPEN, createRowLedger, createSuppression, handleFetchFailure, handleStreamError } from './failure.js';
import {
  beginBackfill,
  createDiffContentCache,
  diffEntryKey,
  groupDiffEntries,
  insertBySeq,
  rememberDiffOwner,
  retractOwnedEntries,
} from './diff-index-view.js';

/* ============================================================
   TaskShuttle Console UI — live wiring (console-design §10/§10.1,
   console-v2 §4). The initial transcript backfill pages through
   /events?projection=folded (console-v2 §3.2); from the high
   watermark on, the SSE stream carries verbatim raw events and the
   browser folder folds them (ADR 0006/0010). The seam between the
   two is the §3.2 merge (seam-merge.js): an incoming message run
   continues the tail run when the tail is still OPEN and the keys
   match — open state, not bare adjacency, is what separates a
   message the page cut from a message that ended.

   All data comes from the §6 GET routes and the /api/stream SSE
   endpoints. There is no credential: the console is bounded by its
   port (ADR 0032), so nothing here authenticates. Degraded mode
   (exposeTranscripts: false, §7.8) is handled by the API
   projections — this file simply tolerates the absent fields
   (no name/cwd, envelope-only events, no interaction payload, and
   no Diff tab, §3.4).
   ============================================================ */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const shortId = (id) => (id.length <= 10 ? id : id.slice(0, 8) + '…');

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';
}
const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(2) + ' MiB' : Math.ceil(n / 1024) + ' KiB');
const fmtTime = (ts) => (ts > 0 ? new Date(ts).toTimeString().slice(0, 8) : '');

const PRIO_LABEL = { high: 'P0', normal: 'P1', low: 'P2' };

/* A turn's engine-reported usage, compact enough for the column. The shape is
   opaque (Record<string, unknown>) and may be absent or partial, so this only
   reads the numeric fields Realm's Usage actually defines and returns '' when
   none are present — the row never depends on it. */
function usageSummary(usage) {
  if (!usage || typeof usage !== 'object') return '';
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const total = isNum(usage.total) ? usage.total : null;
  const input = isNum(usage.input) ? usage.input : null;
  const output = isNum(usage.output) ? usage.output : null;
  const fmt = (n) => n.toLocaleString('en-US');
  if (total !== null) return `↯ ${fmt(total)} tok`;
  const parts = [];
  if (input !== null) parts.push(`in ${fmt(input)}`);
  if (output !== null) parts.push(`out ${fmt(output)}`);
  return parts.length > 0 ? `↯ ${parts.join(' ')}` : '';
}

/* console-v2 §3.2/§7: the preview cap mirrors the server's folded-projection
   constant; it is a constant here too, not configuration. */
const PREVIEW_LIMIT = 512;

/* ---------- client state ---------- */

const state = {
  instance: null,          // GET /api/instance
  sessions: [],            // GET /api/sessions .sessions
  turns: [],               // GET /api/turns .turns
  interactions: [],        // GET /api/interactions .interactions
  activeSessionId: null,
  lastSeq: 0,              // transcript watermark of the selected session (§5.1) — display only
  /* The last seq actually rendered. Distinct from the watermark: the folded
     backfill learns the watermark with the first page but renders page by
     page, and the SSE fallback after a failed page must resume here, not at
     the watermark — anything between would vanish, with appendFrame's dedup
     hiding the gap (backfill-cursor.js carries the page rule). */
  renderedSeq: 0,
  deleted: false,          // §5.4 invalidated for the selected session
  view: 'sessions',
  sessionStream: null,     // EventSource | null
  /* The session stream's own suppression flag (§10.0). Per stream and never
     shared: closeSessionStream marks it before close(), so the CLOSED that
     the close itself produces is not rendered as a failure, while a genuine
     terminal failure on the stream that replaced it still is. */
  sessionSuppression: null,
  instanceStream: null,
  /* §10.0 failure rows, keyed by operation within the session named by
     failureRowSession. Held here rather than looked up in the DOM because the
     transcript pane is emptied and rebuilt; re-selecting the same session
     re-attaches these, while selecting another drops them. */
  failureRows: new Map(),  // operation -> Element
  /* Which reads behind each row are still failed; the rule is in failure.js. */
  failedReads: createRowLedger(),
  failureRowSession: null,
  /* Folding (ADR 0006). The live wire stays verbatim; the fold happens here.
     One folder per selected session, and its lifetime is the panel's: a
     transient reconnect keeps both the folder and the Last-Event-ID cursor,
     while selecting a session or reloading rebuilds both. */
  folder: null,            // Folder | null
  msg: null,               // open message run (between messageStart/messageEnd)
  /* The stream's tail element, when it is a message run or a tool group:
     the §3.2 seam merge and the §4.4 group extension both require adjacency,
     and any other node appended in between breaks it. */
  tail: null,              // { type: 'msg', run } | { type: 'group', group } | null
  toolRows: new Map(),     // toolCallId -> { node, display, group } — display is the mergeToolRow accumulation
  selectEpoch: 0,          // incremented per selectSession; stale async work checks it
  /* Frame batching: a chatty turn delivers many SSE messages per paint, so
     DOM work is batched instead of per frame — one fragment append, one
     re-render per open message run, one scroll/seq update per flush. */
  frameQueue: [],          // event/event_ref frames awaiting the next flush
  flushScheduled: false,
  /* console-v2 §4.5: Transcript / Diff switch for the transcript panel. */
  txView: 'transcript',
  diffView: null,          // per-session view state; see freshDiffView() — reset on select
  // seq -> diff bodies, bounded: the live stream hands over every diff's full
  // text, and keeping all of them duplicated the transcript's own tool rows
  // for the whole session. An evicted body is one single-event fetch away.
  diffContent: createDiffContentCache(200),
};

/* A read that failed, carrying the §10.0 outcome rather than a message the
   catch would have to parse back. Both api() and the folded backfill throw it,
   so every catch classifies from the same fact. */
class ApiFailure extends Error {
  constructor(path, outcome) {
    super(`GET ${path} → ${outcome.kind === 'status' ? outcome.status : outcome.kind}`);
    this.name = 'ApiFailure';
    this.outcome = outcome;
  }
}

/* Read the outcome a catch was handed.

   Anything that is not an ApiFailure came from the work AFTER the read — a
   derivation, a cache update, a render — so calling it `malformed` labels it
   wrongly, and the label the operator sees ("the answer was not readable")
   will be about the response when the fault was local. That is accepted
   deliberately: an unrendered failure is the defect §10.0 exists to end, and a
   wrong label costs far less than silence. If this starts firing in practice,
   the fix is a fifth outcome kind, not a silent return. */
function failureOutcome(error) {
  return error instanceof ApiFailure ? error.outcome : { kind: 'malformed' };
}

/**
 * Read a JSON route, distinguishing the four outcomes §10.0 classifies on: a
 * response that arrived (whatever its status), a fetch that rejected, a body
 * that did not parse, and a body that ended early.
 * @throws {ApiFailure} on anything but a 2xx that parsed.
 */
async function api(path) {
  let res;
  try {
    res = await fetch(path, { headers: { accept: 'application/json' } });
  } catch {
    throw new ApiFailure(path, { kind: 'network' });
  }
  if (!res.ok) throw new ApiFailure(path, { kind: 'status', status: res.status });
  return readJson(path, res);
}

/* A truncated body and an unparseable one are different facts: the first is a
   connection that died mid-answer, the second an answer that was never JSON.
   `res.json()` reports the former as a network-ish TypeError and the latter as
   a SyntaxError, which is the only signal available here. */
async function readJson(path, res) {
  try {
    return await res.json();
  } catch (error) {
    throw new ApiFailure(path, { kind: error instanceof SyntaxError ? 'malformed' : 'aborted' });
  }
}

/* ---------- §10.0 failure rendering ---------- */

/** The stream pill, the only surface the pane-less operations have. */
function setStreamPill(label, offline) {
  $('stream-pill').classList.toggle('offline', offline);
  $('stream-label').textContent = label;
}

/**
 * The pill is one line shared by every operation with no pane of its own — the
 * three collection-style reads and the instance stream — so it is **computed**
 * from what is outstanding rather than written by whoever spoke last.
 *
 * The rule this shape enforces by construction: the console may not report
 * itself healthy while any pane-less operation is still failed. An earlier
 * version kept a ledger and had `setStreamPill` callers besides it, and that
 * is all it takes to wedge — a transient "reconnecting" written outside the
 * ledger could not be recovered by the reader that owned the ledger, and the
 * pill stayed offline over a stream that had come back. There is one writer
 * now, and nothing to keep in step with anything else.
 */
const pillFailures = new Map(); // operation -> the reason it reported
let pillReconnecting = false;

/** Recompute the pill. The only writer; every state change routes through it. */
function renderPill() {
  // An outstanding failure outranks a reconnect: the reconnect is the browser
  // working on it, and the failure is something that is still true.
  const outstanding = [...pillFailures.values()];
  if (outstanding.length > 0) { setStreamPill(outstanding[outstanding.length - 1], true); return; }
  if (pillReconnecting) { setStreamPill('SSE · reconnecting', true); return; }
  if (state.instanceStream !== null && state.instanceStream.readyState === OPEN) { setStreamPill('SSE · live', false); return; }
  setStreamPill('SSE · connecting', true);
}

/**
 * The sink for operations with no transcript pane: collections, topology, the
 * instance read and the instance stream. `row` and `invalidated` cannot be
 * reached from those operations; they throw rather than write somewhere
 * plausible, so a misrouted classification is a test failure and not a row
 * that silently never appears.
 */
function pillSink(operation) {
  return {
    pill: (reason) => {
      // Re-inserted, not updated in place: the pill shows the most recent
      // failure, and a Map keeps a re-set key in its original position.
      pillFailures.delete(operation);
      pillFailures.set(operation, reason);
      renderPill();
    },
    row: () => { throw new Error('a pane-less operation classified to a transcript row'); },
    invalidated: () => { throw new Error('a pane-less operation classified to the invalidated banner'); },
    rawFallback: () => { throw new Error('a pane-less operation classified to the raw-stream fallback'); },
  };
}

/** One pane-less operation succeeded; whether that shows depends on the rest.
 *  Reached only from `pillRead`, which is what decides "succeeded". */
function clearStreamPill(operation) {
  pillFailures.delete(operation);
  renderPill();
}

/* Staleness as a property of the read rather than of the site.
   Every pane-less read is superseded by a later read of the same operation,
   and a superseded one must neither apply its answer nor say anything about
   the pill — reporting a failure the current read has moved past, or clearing
   one it has just recorded, both misreport health on the surface whose whole
   job is not to.
   This was three transcriptions of that rule and one site with none at all:
   `loadInstance` is re-entrant, because its repeat caller tests
   `state.instance === null`, which is set after an await. Two overlapping
   retries could therefore land in the wrong order, leave a failure recorded by
   the loser, and wedge the pill offline for the life of the page — the winner
   having already set `state.instance`, so nothing would ever call it again.
   There is no way to spell an unguarded pane-less read now. */
const pillGenerations = new Map();

/**
 * Run one pane-less read under its operation's generation.
 *
 * @param operation - the pill key; also what a failure is reported under.
 * @param body - issues the read and resolves with what the caller needs.
 * @param stillWanted - an extra supersession axis, for a read whose answer can
 *   also be made irrelevant by something other than a newer read of it. The
 *   topology refresh has one: the operator can leave the view while it is in
 *   flight, and nothing bumps a generation when they do.
 * @returns what `body` resolved with, or **undefined** when the read failed or
 *   was superseded — in both cases the caller must apply nothing.
 */
async function pillRead(operation, body, stillWanted = () => true) {
  const mine = (pillGenerations.get(operation) ?? 0) + 1;
  pillGenerations.set(operation, mine);
  const current = () => pillGenerations.get(operation) === mine && stillWanted();
  let answer;
  try {
    answer = await body();
  } catch (error) {
    if (current()) handleFetchFailure(failureOutcome(error), operation, pillSink(operation));
    return undefined;
  }
  if (!current()) return undefined;
  clearStreamPill(operation);
  return answer;
}

/** The browser is retrying the instance stream, or has stopped retrying. */
function setPillReconnecting(reconnecting) {
  pillReconnecting = reconnecting;
  renderPill();
}

/**
 * Read the instance header, and retry it when the stream comes back.
 *
 * A failure here means the console is unreachable (§10.0) — but this read runs
 * once at startup and would otherwise never run again, which leaves two ways to
 * be wrong. Taking its label down when the stream opens says the console
 * answered when this route may still be failing, and the header stays on its
 * placeholders behind a healthy pill. Leaving the label up forever says the
 * console is unreachable when it plainly is not. So the stream opening
 * re-asks rather than deciding: the label comes down only if the answer does.
 */
async function loadInstance() {
  const info = await pillRead('instance', () => api('/api/instance'));
  if (info === undefined) return;
  state.instance = info;
  renderInstance();
}

/**
 * One row per `{ sessionId, operation }` (§10.0), appended to the transcript
 * pane — where the transcript would have continued on a first render, and at
 * the top of it after a re-selection, since `resetTranscriptView` re-attaches
 * the retained rows into an emptied pane before any content arrives. A
 * repeated failure updates its row rather than adding one, so a stalled
 * console does not accumulate a wall of them.
 *
 * `reader` names the individual read behind this failure, because several of
 * them share one row: a run's full text, one diff's content, the diff index.
 * The row is shared by design; what may not be shared is the decision to take
 * it down, which is why each failure is remembered under its own reader.
 */
function renderFailureRow(sessionId, operation, reason, reader) {
  // The pane belongs to whatever is selected now; a late failure from a
  // session the operator has already left has nowhere honest to render.
  if (sessionId !== state.activeSessionId) return;
  state.failedReads.fail(operation, reader);
  let node = state.failureRows.get(operation);
  if (node === undefined) {
    node = document.createElement('div');
    node.className = 'failure-row';
    state.failureRows.set(operation, node);
  }
  if (node.parentNode === null) {
    // The §3.2 seam merge and the §4.4 group extension both need the run they
    // continue to be the pane's last child, so a row appended in between ends
    // that run rather than silently breaking the next merge.
    breakTail();
    streamEl().appendChild(node);
  }
  node.textContent = reason;
}

/**
 * Record that one read recovered, and take the row down once **none** of the
 * reads sharing it is still failed.
 *
 * The row is keyed by operation, so a bare clear on any success erases a
 * notice whose own failure is still true — two transcript reads in flight, one
 * fails, the other succeeds, and the operator is told nothing about the first.
 * That is the silence §10.0 exists to end, reintroduced by the fix for its
 * opposite.
 *
 * @param operation - the row's key.
 * @param reader - the read that recovered; the same id it failed under.
 */
function clearFailureRow(operation, reader) {
  if (!state.failedReads.recover(operation, reader)) return;
  const node = state.failureRows.get(operation);
  if (node === undefined) return;
  state.failureRows.delete(operation);
  node.remove();
}

/**
 * The reader id for one diff body's expansion.
 *
 * Keyed by the entry, not by its seq. Several entries can sit at one seq — a
 * call with three hunks is three entries — and `state.diffContent` is only
 * populated after the request resolves, so two of them can each have a request
 * in flight before either caches. They are separate reads that happen to ask
 * the same question, and giving them one id would let one's success take down
 * the other's failure: the exact defect the ledger exists for, one level down.
 */
function diffReader(entry) {
  return `diff:${entry.seq}:${entry.path ?? ''}:${entry.part ?? ''}`;
}

/**
 * The sink for a session-scoped operation: its pane, its banner, its fallback.
 * `reader` defaults to the operation itself, which is right for the operations
 * that are a singleton per session — the folded backfill and the stream.
 */
function transcriptSink(sessionId, operation, onRawFallback, reader = operation) {
  return {
    row: (reason) => renderFailureRow(sessionId, operation, reason, reader),
    // Unreachable, and it throws for the same reason pillSink's do: a session
    // operation classifying to the pill would write it from outside the one
    // writer, which is exactly the wedge that shape exists to prevent.
    pill: () => { throw new Error('a session-scoped operation classified to the stream pill'); },
    invalidated: () => { if (sessionId === state.activeSessionId) showInvalidated(); },
    rawFallback: () => { if (typeof onRawFallback === 'function') onRawFallback(); },
  };
}

/* ---------- engine markers (§5.6): neutral facts, no verdict ---------- */

function engineBadges(engine, verification, knownDefects) {
  let out = '';
  if (verification !== 'verified') {
    out += '<span class="eng-badge" title="unverified: not covered by the ENG verification matrix (release/metadata.json)">unverified</span>';
  }
  for (const capability of knownDefects ?? []) {
    out += `<span class="eng-badge defect" title="known defect: ${esc(capability)}">defect: ${esc(capability)}</span>`;
  }
  return out;
}

/* ---------- top bar / status bar ---------- */

function renderInstance() {
  const info = state.instance;
  if (!info) return;
  $('meta-instance').textContent = shortId(String(info.instanceId));
  $('meta-host').textContent = String(info.host);
  const alive = $('meta-alive');
  alive.textContent = String(info.alive);
  alive.className = info.alive ? 'alive-yes' : 'alive-no';
  const engines = $('meta-engines');
  engines.innerHTML = 'engines';
  for (const e of info.engines ?? []) {
    const span = document.createElement('span');
    span.className = 'eng';
    let marks = '';
    if (e.verification !== 'verified') {
      marks += '<span class="eng-mini" title="unverified: not covered by the ENG verification matrix (release/metadata.json)">◌</span>';
    }
    for (const capability of e.knownDefects ?? []) {
      marks += `<span class="eng-mini defect" title="known defect: ${esc(capability)}">!</span>`;
    }
    span.innerHTML = `${esc(e.engine)}${marks}`;
    engines.appendChild(span);
  }
  const degraded = info.config && info.config.exposeTranscripts === false;
  $('mode-hint').textContent = degraded ? 'degraded · ids/states only (§7.8)' : 'full fidelity';
  // §3.4: degraded mode serves an empty diff index, so the toggle is hidden
  // rather than permanently empty.
  $('tx-tabs').hidden = degraded;
  $('status-bind').textContent = location.host;
  $('status-expose').textContent = String(info.config?.exposeTranscripts ?? true);
}

/* ---------- sessions column ---------- */

function sessionLabel(s) {
  return typeof s.name === 'string' && s.name !== '' ? s.name : shortId(String(s.sessionId));
}

/* The session's engine-reported observed config (design §5.1, §6.3). Only
   engine-reported keys are shown; a key the engine never reported is left out
   entirely — it never falls back to the requested `config` value. */
function observedConfigSummary(s) {
  const oc = s.observedConfig;
  if (!oc || typeof oc !== 'object') return '';
  const entries = Object.entries(oc).filter(([, v]) => v && typeof v === 'object' && 'value' in v && v.value !== undefined);
  if (entries.length === 0) return '';
  // Plain text, not markup: the caller needs the same string in an element and
  // in a title attribute, and escaping here would double-escape one of them.
  return entries.map(([k, v]) => `${k}=${String(v.value)}`).join(' · ');
}

/* The session's cumulative usage (mvp §10.6). Deliberately a different glyph
   (Σ) from the turn row's per-turn ↯ so the two quantities are never read as
   one being a sum of the other (§6.3). It is a running total the engine
   reports, not a live counter: nothing here interpolates between reports. */
function sessionUsageSummary(s) {
  const u = s.usage;
  if (!u || typeof u !== 'object') return '';
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const total = isNum(u.total) ? u.total : null;
  const input = isNum(u.input) ? u.input : null;
  const output = isNum(u.output) ? u.output : null;
  const fmt = (n) => n.toLocaleString('en-US');
  if (total !== null) return `Σ ${fmt(total)} tok`;
  const parts = [];
  if (input !== null) parts.push(`in ${fmt(input)}`);
  if (output !== null) parts.push(`out ${fmt(output)}`);
  return parts.length > 0 ? `Σ ${parts.join(' ')}` : '';
}

function renderSessions() {
  const el = $('session-list');
  el.innerHTML = '';
  for (const s of state.sessions) {
    const btn = document.createElement('button');
    btn.className = 'session-card' + (s.sessionId === state.activeSessionId ? ' active' : '');
    btn.dataset.s = s.state;
    const badges = engineBadges(s.engine, s.verification, s.knownDefects);
    const obs = observedConfigSummary(s);
    const su = sessionUsageSummary(s);
    const hasObs = obs !== '' || su !== '';
    btn.innerHTML = `
      <div class="row1">
        <span class="state-dot"></span>
        <span class="name">${esc(sessionLabel(s))}</span>
        <span class="engine">${esc(s.engine)}</span>
        <span class="state-chip">${esc(s.state)}</span>
      </div>
      <div class="row2">
        ${typeof s.cwd === 'string' ? `<span class="cwd">${esc(s.cwd)}</span>` : ''}
        <span class="elapsed" data-start="${Date.parse(s.createdAt)}">${fmtElapsed(Date.now() - Date.parse(s.createdAt))}</span>
      </div>
      ${hasObs ? `<div class="row3">
        ${obs ? `<span class="obs-config" title="${esc(obs)}&#10;&#10;engine-reported config — never guessed from the requested config">${esc(obs)}</span>` : ''}
        ${su ? `<span class="session-usage" title="session cumulative usage — a running total, not a single turn's">${su}</span>` : ''}
      </div>` : ''}
      ${badges ? `<div class="badges-row">${badges}</div>` : ''}`;
    btn.onclick = () => selectSession(s.sessionId);
    el.appendChild(btn);
  }
  $('session-count').textContent = state.sessions.length;
  if (state.sessions.length === 0) {
    el.innerHTML = '<div class="empty-hint">no sessions yet</div>';
  }
}

/* ---------- minimal markdown (console-v2 §4.3) ----------
   Self-contained subset (§7.5 CSP forbids external libraries): fenced code
   blocks, #-### headings, unordered/ordered lists, quotes, inline
   code/bold/italic/links. Every text run is escaped BEFORE the tags are
   applied — the renderer never accepts raw HTML, so the injection surface
   is zero. Agent message runs only; thoughts and tool output stay plain. */

function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
}

function mdRender(src) {
  const lines = String(src).split('\n');
  const out = [];
  let i = 0, list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  while (i < lines.length) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${mdInline(esc(h[2]))}</h${h[1].length}>`); i++; continue; }
    const ul = line.match(/^\s*[-*]\s+(.+)$/);
    if (ul) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${mdInline(esc(ul[1]))}</li>`); i++; continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ol) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${mdInline(esc(ol[1]))}</li>`); i++; continue;
    }
    const q = line.match(/^>\s?(.*)$/);
    if (q) { closeList(); out.push(`<blockquote>${mdInline(esc(q[1]))}</blockquote>`); i++; continue; }
    closeList();
    if (line.trim() !== '') out.push(`<p>${mdInline(esc(line))}</p>`);
    i++;
  }
  closeList();
  return out.join('');
}

/* ---------- transcript column ---------- */

const streamEl = () => $('stream');

function updateSeqLabel() {
  $('tx-seq').textContent = state.activeSessionId === null
    ? ''
    : `seq 1..${state.renderedSeq} · watermark ${state.lastSeq}`;
}

/* Stickiness is a property of the transcript stream, which is the container
   frames are appended to — not of whichever panel happens to be showing. The
   §4.5 diff view is a separate list the user scrolls on its own; measuring it
   here made an arriving transcript event scroll the diff list, and made the
   pill offer to jump somewhere the pill's own click could not reach. */
function pinnedToBottom(el = streamEl()) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

function appendFrame(frame) {
  if (frame.type !== 'event' && frame.type !== 'event_ref') return;
  if (frame.seq <= state.renderedSeq) return; // reconnect overlap, deduped by seq (§5.1)
  state.renderedSeq = frame.seq;
  if (frame.seq > state.lastSeq) state.lastSeq = frame.seq;
  state.frameQueue.push(frame);
  scheduleFrameFlush();
}

function scheduleFrameFlush() {
  if (state.flushScheduled) return;
  state.flushScheduled = true;
  // rAF aligns the commit with a paint; the timeout is the background-tab
  // lane, where rAF is throttled away entirely and queued frames would never
  // flush. Whichever fires first wins; the other finds the flag cleared.
  requestAnimationFrame(() => flushFrames());
  setTimeout(() => flushFrames(), 100);
}

/* ---------- render batching ----------
   One batch is one DOM commit: nodes collect in a fragment, the open message
   re-renders once, and thought-clamp measurement (which needs connected
   nodes) runs right after the append. Shared by the SSE flush and the
   folded backfill. Module-level because exactly one batch can be in flight. */
let batch = null; // { fragment, dirtyMsg, measure } while a flush/backfill runs

function batchBegin() {
  batch = { fragment: document.createDocumentFragment(), dirtyMsg: false, measure: new Set() };
}

function batchAppend(node) {
  batch.fragment.appendChild(node);
}

function batchCommit() {
  const current = batch;
  batch = null;
  if (current.dirtyMsg && state.msg !== null) renderMessage(state.msg);
  streamEl().appendChild(current.fragment);
  for (const run of current.measure) measureMessageToggle(run);
}

function flushFrames() {
  if (!state.flushScheduled) return;
  state.flushScheduled = false;
  const frames = state.frameQueue;
  if (frames.length === 0) return;
  state.frameQueue = [];
  // Stickiness is decided before the append (console-v2 §4.6): measured after
  // the append, the new rows' own height pushes the distance past the 60px
  // threshold and "was at the bottom" is misjudged.
  const stick = pinnedToBottom();
  batchBegin();
  try {
    for (const frame of frames) {
      if (frame.type === 'event_ref') {
        // An oversized event arrives without its body (§9.4), so it is not a
        // TranscriptEvent and must not enter the folder. The fold itself
        // keeps the message open across the gap — the folder never saw the
        // event, which is why the server-side folded projection continues
        // the fragment past the reference run. The UI instead settles any
        // open message run first, so the reference shows as the gap it is
        // rather than splicing itself into the middle of a sentence — v1
        // behavior, kept; the two sides disagree about run boundaries here
        // by design.
        if (state.msg !== null) { settleMessage(state.msg); state.msg = null; }
        breakTail();
        batchAppend(eventRefNode(frame));
        continue;
      }
      const ev = frame.event;
      if (ev?.update === undefined) {
        // Degraded mode (§7.8): an envelope carries nothing to fold.
        if (state.msg !== null) { settleMessage(state.msg); state.msg = null; }
        breakTail();
        batchAppend(envelopeNode(frame));
        continue;
      }
      if (state.folder === null) continue;
      for (const folded of state.folder.push(ev)) renderFolded(folded);
    }
  } finally {
    batchCommit();
  }
  updateSeqLabel();
  const stream = streamEl();
  if (stick) {
    stream.scrollTop = stream.scrollHeight;
    $('to-bottom').classList.remove('show');
  } else if (state.txView !== 'diff') {
    // Under the diff view the transcript is display:none — an offer to jump to
    // the bottom of a panel the user cannot see is noise, and setTxView shows
    // it again on the way back if it still applies.
    $('to-bottom').classList.add('show');
  }
}

/* ---------- message runs (console-v2 §4.1/§4.3) ----------
   A run renders one logical message instead of per-word rows. The DOM holds
   only the preview while collapsed; the full text lives in memory (live
   path) or is fetched on expand via the raw projection's toSeq range
   (§3.2). Thought runs clamp to two lines and stay plain text; agent runs
   render markdown; user runs render as prompt cards. */

function renderMessage(run) {
  const shown = run.expanded || !run.truncated ? (run.text ?? run.preview) : run.preview;
  if (run.kind === 'thought') {
    // Whitespace-only thoughts render as empty clamped cards (GZH-38): the
    // display text is trimmed, and a thought with nothing visible hides its
    // whole block — but never a truncated one, whose content lives past the
    // cap and whose show-more toggle must stay reachable. The raw text stays
    // intact for expand and seam merge either way.
    const visible = thoughtDisplay(run, PREVIEW_LIMIT);
    run.el.hidden = visible === '' && run.truncated !== true;
    run.textEl.textContent = visible;
  } else {
    if (run.kind === 'agent') run.textEl.innerHTML = mdRender(shown);
    else run.textEl.textContent = shown;
  }
}

/* The show more/less toggle appears only when content actually exceeds the
   two-line clamp (scrollHeight, not a character-count guess) or a truncated
   preview has more to fetch. Requires a connected element, so callers queue
   runs into batch.measure and measurement happens right after the commit. */
function measureMessageToggle(run) {
  if (run.toggle === null || !run.el.isConnected) return;
  if (run.expanded || run.truncated) {
    run.toggle.hidden = false;
    return;
  }
  run.toggle.hidden = run.kind !== 'thought'
    || run.textEl.scrollHeight <= run.textEl.clientHeight + 1;
}

function onToggleMessage(run) {
  run.expanded = !run.expanded;
  if (run.cardEl !== null) run.cardEl.classList.toggle('expanded', run.expanded);
  run.toggle.textContent = run.expanded ? 'show less' : 'show more';
  if (run.expanded && run.text === undefined) startFullTextFetch(run);
  renderMessage(run);
  measureMessageToggle(run);
}

/* §3.2: the full text behind a truncated preview is re-composed from the raw
   projection over the run's own seq interval — the chunks of one message
   run concatenate in seq order. Live appends that arrive mid-fetch land in
   pendingTail and join the fetched text when it resolves. */
function startFullTextFetch(run) {
  if (run.fetching !== null) return;
  const sessionId = state.activeSessionId;
  if (sessionId === null) return;
  const epoch = state.selectEpoch;
  // The fetch re-pulls the run's whole seq interval, so the tail chunks
  // already queued come back inside the response — clear pendingTail NOW,
  // not at resolve: after a failed attempt the retry would otherwise prepend
  // those chunks a second time. Chunks landing mid-flight re-accumulate from
  // empty and join the fetched text when it resolves.
  run.pendingTail = '';
  const fetchPage = (afterSeq, toSeq) =>
    api(`/api/sessions/${encodeURIComponent(sessionId)}/events?afterSeq=${afterSeq}&toSeq=${toSeq}`);
  // One reader per run: two runs expanding at once share the row but not the
  // right to remove it.
  const reader = `text:${run.seqFrom}`;
  run.fetching = composeRunText(fetchPage, run.seqFrom, run.seqTo)
    .then((text) => {
      if (epoch !== state.selectEpoch) return;
      clearFailureRow('sessionRead', reader);
      run.text = text + run.pendingTail;
      run.pendingTail = '';
      applyPreviewPolicy(run, PREVIEW_LIMIT);
      renderMessage(run);
      measureMessageToggle(run);
    })
    .catch((error) => {
      // The preview stays and the next expand retries, but §10.0 forbids
      // leaving it at that: the operator asked for the full text and has to be
      // told it did not arrive.
      if (epoch === state.selectEpoch) handleFetchFailure(failureOutcome(error), 'sessionRead', transcriptSink(sessionId, 'sessionRead', undefined, reader));
    })
    .finally(() => { run.fetching = null; });
}

function makeMessageRun(kind, messageId, meta, options) {
  const run = {
    kind,
    messageId,
    seqFrom: meta.seq,
    seqTo: meta.seq,
    text: options.text,
    preview: options.preview ?? options.text ?? '',
    truncated: options.truncated ?? false,
    open: options.open ?? false,
    expanded: false,
    pendingTail: '',
    fetching: null,
    el: null,
    textEl: null,
    toggle: null,
    cardEl: null,
  };
  const block = document.createElement('div');
  block.className = `event k-${kind}-run`;
  block.innerHTML = `<div class="meta"><span class="seq">#${meta.seq}</span>${meta.ts > 0 ? `<span class="time">${fmtTime(meta.ts)}</span>` : ''}<span class="kind">${esc(kind)}</span></div>`;
  const body = document.createElement('div');
  body.className = 'body';
  if (kind === 'thought') {
    // §4.1: de-emphasized — italic, dashed left border, muted color, no
    // markdown. Streaming (message not ended) adds the shimmer sweep over
    // the text and the bouncing dots.
    const card = document.createElement('div');
    card.className = 'thought-card clampable' + (run.open ? ' streaming' : '');
    const textEl = document.createElement('div');
    textEl.className = 'thought-text';
    card.appendChild(textEl);
    if (run.open) {
      const dots = document.createElement('span');
      dots.className = 'think-dots';
      dots.innerHTML = '<i></i><i></i><i></i>';
      card.appendChild(dots);
    }
    const toggle = document.createElement('button');
    toggle.className = 'thought-toggle';
    toggle.hidden = true;
    toggle.textContent = 'show more';
    toggle.onclick = () => onToggleMessage(run);
    card.appendChild(toggle);
    body.appendChild(card);
    run.cardEl = card;
    run.textEl = textEl;
    run.toggle = toggle;
  } else {
    const textEl = document.createElement('div');
    textEl.className = kind === 'user' ? 'prompt-card' : 'md';
    body.appendChild(textEl);
    const toggle = document.createElement('button');
    toggle.className = 'thought-toggle msg-toggle';
    toggle.hidden = true;
    toggle.textContent = 'show more';
    toggle.onclick = () => onToggleMessage(run);
    body.appendChild(toggle);
    run.textEl = textEl;
    run.toggle = toggle;
  }
  block.appendChild(body);
  run.el = block;
  renderMessage(run);
  batchAppend(block);
  batch.measure.add(run);
  return run;
}

/** messageEnd: the run settles — shimmer and dots come off, final render. */
function settleMessage(run) {
  run.open = false;
  if (run.cardEl !== null) {
    run.cardEl.classList.remove('streaming');
    run.cardEl.querySelector('.think-dots')?.remove();
  }
  renderMessage(run);
  if (batch !== null) batch.measure.add(run);
  else measureMessageToggle(run);
}

/* An adopted backfill fragment (tail run left open by openEnd) never gets a
   messageEnd from a cold-started folder — the next non-chunk event IS its
   end. Live-open runs settle via messageEnd instead, so this only fires for
   the adopted case (state.msg === null). */
function settleOpenTailMessage() {
  if (state.msg === null && state.tail !== null && state.tail.type === 'msg' && state.tail.run.open) {
    settleMessage(state.tail.run);
  }
}

/** Anything that is neither a message run nor a tool-group member breaks tail adjacency. */
function breakTail() {
  settleOpenTailMessage();
  state.tail = null;
}

/** Streaming visuals for a run the live stream continues (§4.1). */
function setStreaming(run) {
  run.open = true;
  if (run.cardEl === null || run.cardEl.classList.contains('streaming')) return;
  run.cardEl.classList.add('streaming');
  const dots = document.createElement('span');
  dots.className = 'think-dots';
  dots.innerHTML = '<i></i><i></i><i></i>';
  run.cardEl.insertBefore(dots, run.toggle);
}

function onMessageStart(kind, messageId, ts, seq) {
  if (continuesOpenRun(state.tail, { kind, messageId })) {
    // §3.2 live seam: the browser folder cold-started at the folded/raw
    // boundary opens an implicit messageStart for an unseen messageId, and
    // the backfill's still-open tail run of the same key is that message
    // (seam-merge.js owns the rule and the reasoning).
    state.msg = state.tail.run;
    setStreaming(state.msg);
    if (state.msg.truncated && state.msg.text === undefined) startFullTextFetch(state.msg);
    return;
  }
  settleOpenTailMessage();
  state.msg = makeMessageRun(kind, messageId, { ts, seq }, { text: '', open: true });
  state.tail = { type: 'msg', run: state.msg };
}

function onMessageAppend(text, seq) {
  if (state.msg === null) {
    // The folder appends only inside an open stream; this is pure defence.
    state.msg = makeMessageRun('agent', undefined, { ts: 0, seq }, { text: '', open: true });
    state.tail = { type: 'msg', run: state.msg };
  }
  const run = state.msg;
  run.seqTo = seq;
  if (run.text === undefined || run.fetching !== null) {
    run.pendingTail += text;
    return;
  }
  run.text += text;
  applyPreviewPolicy(run, PREVIEW_LIMIT);
  batch.dirtyMsg = true;
  // The clamp toggle is measured, not guessed: growth past the two-line clamp
  // by live appends must surface the toggle.
  batch.measure.add(run);
}

function onMessageEnd() {
  if (state.msg === null) return;
  settleMessage(state.msg);
  state.msg = null;
}

/* ---------- tool rows and the §4.4 aggregation group ----------
   Consecutive terminal tool rows without diffs collapse into one group
   (header: count + first 3 deduped tool names + seq range, collapsed by
   default, items rendered lazily on first expand). A tool row carrying a
   diff stays a standalone card and breaks the grouping. Rows that are
   still in progress trail the group as standalone cards and join it when
   they terminate — unless something else landed in between, which breaks
   adjacency and leaves them standalone. */

const isTerminalTool = (row) => row.status === 'completed' || row.status === 'failed';
const isGroupableTool = (row) => isTerminalTool(row) && row.diffs.length === 0;

/* One rendering of a diff body, used by the transcript's diff card and by the
   §4.5 diff view. Two copies of this markup meant two places to keep the sign
   glyphs, the escaping and the blank-line filler agreeing.

   The gutter is a sign column and the code, and nothing else: the console's
   diffs carry no line numbers (ADR 0035). Nothing on the wire says where a
   diff starts, and a number the reader cannot classify invites the one reading
   that is usually wrong. */
function diffLinesHtml(lines) {
  return lines.map((l) =>
    `<div class="dline ${l.t}"><span class="sign">${l.t === 'add' ? '+' : l.t === 'del' ? '−' : '·'}</span><span class="code">${esc(l.x) || ' '}</span></div>`,
  ).join('');
}

/** The `rebuilt` marker (ADR 0021): this diff is ours, drawn from the engine's
   edit parameters, not one the engine reported. Native diffs get no marker —
   the common case should not carry the noise. */
const REBUILT_TAG =
  '<span class="rebuilt" title="Rebuilt by the plugin from the edit parameters the engine sent; not a diff the engine reported">rebuilt</span>';

/** Provenance marker for tool args the fold layer inferred from streamed
   parameter text (`from === 'content'`, ADR 0023 §4.1): visually aligned
   with `.rebuilt` but a separate constant and rule — that selector is scoped
   to `.diff-head` and cannot be reused here. rawInput/locations are fields
   the engine reported itself and carry no marker. */
const INFERRED_TAG =
  '<span class="inferred" title="Inferred by the fold layer from the parameter text the engine streamed; not a field the engine reported">inferred</span>';

/** A deleted file states no line counts, so the card shows what it knows. */
const DELETED_TAG = '<span class="stats"><span class="del">deleted</span></span>';

/** Expanding a deleted entry has nothing to show, and saying why is not the
   same as saying the content could not be fetched — the engine never sent it. */
const DELETED_BODY =
  '<div class="dline"><span class="sign"></span><span class="code">the patch declared only a deletion — it carried no deleted content</span></div>';

function diffBlock(toolName, entry) {
  const deleted = entry.deleted === true;
  const lines = deleted ? [] : diffLines(entry.oldText, entry.newText);
  const adds = lines.filter((l) => l.t === 'add').length;
  const dels = lines.filter((l) => l.t === 'del').length;
  const stats = deleted
    ? DELETED_TAG
    : `<span class="stats"><span class="add">+${adds}</span><span class="del">−${dels}</span></span>`;
  const body = deleted ? DELETED_BODY : diffLinesHtml(lines);
  return `<div class="diff">
    <div class="diff-head" title="View diff">
      <span class="tname">${esc(toolName)}</span>
      <span class="path">${esc(entry.path ?? '')}</span>
      ${entry.origin === 'reconstructed' ? REBUILT_TAG : ''}
      ${stats}
      <span class="chev">▶</span>
    </div>
    <div class="diff-lines">${body}</div>
  </div>`;
}

/** Diffs come off the merged display row (tool-row-state.js): the folded
   snapshot's whole-array content replacement must not erase a diff the tool
   already reported. */
function toolRowNode(row) {
  const node = document.createElement('div');
  node.className = 'event k-tool_call';
  const title = row.title ?? row.name ?? row.toolCallId;
  const kindTag = row.kind ? `<span class="tkind">${esc(row.kind)}</span>` : '';
  const status = row.status ? `<span class="targs">${esc(row.status)}</span>` : '';
  // What the call acted on (ADR 0023 §4.1): one line after the status span.
  // The decision (draw or not, marker or not) lives in toolArgsView; here is
  // only element assembly, with the full text in the title attribute.
  const argsView = toolArgsView(row.args);
  const argsLine = argsView === undefined
    ? ''
    : `<span class="tcall-args" title="${esc(argsView.title)}">${argsView.inferred ? INFERRED_TAG : ''}${esc(argsView.text)}</span>`;
  let inner = `<div class="tool-card"><span class="tname">${esc(title)}</span>${kindTag}${status}${argsLine}</div>`;
  for (const entry of row.diffs) inner += diffBlock(title, entry);
  node.innerHTML = `<div class="body">${inner}</div>`;
  for (const dh of node.querySelectorAll('.diff-head')) {
    dh.onclick = () => dh.parentElement.classList.toggle('open');
  }
  return node;
}

function toolGroupItemNode(row) {
  const item = document.createElement('div');
  item.className = 'tg-item';
  const name = row.name ?? row.title ?? row.toolCallId;
  const detail = [row.kind, row.status].filter(Boolean).join(' · ');
  // Third inline segment on the group line (ADR 0023 §4.1): the container's
  // existing ellipsis owns truncation here, so no overflow of its own — and
  // no `inferred` marker either, which would crowd out the very text it
  // annotates; expand to a card to see provenance. `inline` encodes that
  // decision in the shared view function.
  const argsView = toolArgsView(row.args, { inline: true });
  const argsSpan = argsView === undefined ? '' : `<span class="tcall-args" title="${esc(argsView.title)}">${esc(argsView.text)}</span>`;
  item.innerHTML = `<span class="tname">${esc(name)}</span> <span class="targs">${esc(detail)}</span>${argsSpan}`;
  return item;
}

function startToolGroup(meta) {
  const node = document.createElement('div');
  node.className = 'event k-tool_group';
  node.innerHTML = `
    <div class="meta"><span class="seq"></span>${meta.ts > 0 ? `<span class="time">${fmtTime(meta.ts)}</span>` : ''}<span class="kind">tool_group</span></div>
    <div class="body"><div class="tool-group collapsed">
      <div class="tg-head">
        <span class="tg-count"></span>
        <span class="tg-names"></span>
        <span class="chev">▶</span>
      </div>
      <div class="tg-items"></div>
    </div></div>`;
  const group = {
    node,
    itemsEl: node.querySelector('.tg-items'),
    countEl: node.querySelector('.tg-count'),
    namesEl: node.querySelector('.tg-names'),
    seqEl: node.querySelector('.meta .seq'),
    rows: [],               // [{ id, row }] in arrival order
    itemNodes: new Map(),   // id -> rendered .tg-item (only once rendered)
    names: [],              // deduped, first-seen order
    seqFrom: meta.seq,
    seqTo: meta.seq,
    rendered: false,        // §4.4: items render on first expand, never before
    trailers: new Map(),    // toolCallId -> standalone in-progress card trailing the group
  };
  node.querySelector('.tg-head').onclick = () => {
    const card = node.querySelector('.tool-group');
    card.classList.toggle('collapsed');
    if (!card.classList.contains('collapsed') && !group.rendered) {
      group.rendered = true;
      for (const item of group.rows) {
        const itemNode = toolGroupItemNode(item.row);
        group.itemNodes.set(item.id, itemNode);
        group.itemsEl.appendChild(itemNode);
      }
    }
  };
  batchAppend(node);
  return group;
}

function groupRefresh(group) {
  group.countEl.textContent = `${group.rows.length} tool call${group.rows.length === 1 ? '' : 's'}`;
  group.namesEl.textContent =
    group.names.slice(0, 3).join(' · ') + (group.names.length > 3 ? ` +${group.names.length - 3}` : '');
  group.seqEl.textContent = `#${group.seqFrom}..${group.seqTo}`;
}

function groupAdd(group, id, row, seq) {
  group.rows.push({ id, row });
  group.seqTo = seq;
  const name = row.name ?? row.title ?? row.toolCallId;
  if (!group.names.includes(name)) group.names.push(name);
  groupRefresh(group);
  if (group.rendered) {
    const itemNode = toolGroupItemNode(row);
    group.itemNodes.set(id, itemNode);
    group.itemsEl.appendChild(itemNode);
  }
  state.toolRows.set(id, { node: null, display: row, group });
}

/** First placement of a display row: into the tail group when groupable,
   else a standalone card (which may trail the group until it terminates). */
function placeNewToolRow(id, row, meta) {
  if (isGroupableTool(row)) {
    const group = state.tail !== null && state.tail.type === 'group' ? state.tail.group : startToolGroup(meta);
    state.tail = { type: 'group', group };
    groupAdd(group, id, row, meta.seq);
    return;
  }
  const node = toolRowNode(row);
  batchAppend(node);
  state.toolRows.set(id, { node, display: row, group: null });
  const group = state.tail !== null && state.tail.type === 'group' ? state.tail.group : null;
  if (group !== null && !isTerminalTool(row) && row.diffs.length === 0) {
    // An in-progress call trails the group as a card and joins on completion.
    group.trailers.set(id, node);
  } else {
    // A diff card (or a terminal one that cannot join) breaks the group (§4.4).
    state.tail = null;
  }
}

/** A grouped row that gained a diff leaves the group for a standalone card. */
function groupExtract(group, entry, row, meta) {
  group.rows = group.rows.filter((item) => item.id !== entry.id);
  group.itemNodes.get(entry.id)?.remove();
  group.itemNodes.delete(entry.id);
  group.names = [];
  for (const item of group.rows) {
    const name = item.row.name ?? item.row.title ?? item.id;
    if (!group.names.includes(name)) group.names.push(name);
  }
  if (group.rows.length > 0) groupRefresh(group);
  const node = toolRowNode(row);
  if (group.rows.length === 0) group.node.replaceWith(node);
  else group.node.after(node);
  entry.node = node;
  entry.group = null;
}

function onToolRow(snapshot, meta) {
  const id = snapshot.toolCallId;
  const prev = state.toolRows.get(id);
  const { row, changed } = mergeToolRow(prev?.display, snapshot);
  // A key set difference, not a slice by length: since ADR 0021 a merge can
  // REPLACE a call's rebuilt diffs rather than only append to them (a hunk that
  // vanishes from rawInput, or a native diff superseding the lot), and a
  // length-based delta silently yields nothing whenever the array shrank.
  const before = new Map((prev?.display?.diffs ?? []).map((entry) => [displayDiffKey(entry), entry]));
  const after = new Map(row.diffs.map((entry) => [displayDiffKey(entry), entry]));
  const freshDiffs = [...after].filter(([key]) => !before.has(key)).map(([, entry]) => entry);
  const goneDiffs = [...before].filter(([key]) => !after.has(key)).map(([, entry]) => entry);
  if (meta.backfill !== true && goneDiffs.length > 0) retractLiveDiffs(id, goneDiffs);
  // Live diffs feed the §4.5 diff view; backfilled runs must not. The index
  // keys an entry by the seq of the event that CARRIED the diff, and a folded
  // run's seqTo is the last event that touched the row — the same seq when the
  // whole call folded inside one page and a single event, a different one as
  // soon as an update follows or the call spans pages. Recording from here
  // would key some entries right and some wrong, and the wrong ones would
  // escape the dedup and deal a second row. The index already has all of them.
  if (meta.backfill !== true && freshDiffs.length > 0) recordLiveDiffs(row, freshDiffs, meta);
  settleOpenTailMessage();

  if (prev === undefined) {
    placeNewToolRow(id, row, meta);
    return;
  }

  // Keyed by toolCallId and patched in place: sparse updates patch the row
  // the folder maintains, they do not append another row. A patch that
  // dirties nothing the card renders (text-only output, a replayed snapshot)
  // leaves the DOM row — and its computed diff — untouched.
  if (!changed) {
    prev.display = row;
    return;
  }
  prev.display = row;

  if (prev.group !== null) {
    if (row.diffs.length > 0) {
      groupExtract(prev.group, prev, row, meta);
      state.tail = null;
    } else {
      const itemNode = prev.group.itemNodes.get(id);
      if (itemNode !== undefined) {
        const fresh = toolGroupItemNode(row);
        itemNode.replaceWith(fresh);
        prev.group.itemNodes.set(id, fresh);
      }
    }
    return;
  }

  if (isGroupableTool(row) && state.tail !== null && state.tail.type === 'group' && state.tail.group.trailers.has(id)) {
    // Terminal transition of the card trailing the group: it joins the group.
    const group = state.tail.group;
    group.trailers.delete(id);
    prev.node?.remove();
    prev.node = null;
    prev.group = group;
    groupAdd(group, id, row, meta.seq);
    return;
  }

  // parentNode, not isConnected: a row created earlier in this same flush
  // still sits in the unattached fragment, and replaceWith is valid there.
  const node = toolRowNode(row);
  if (prev.node !== null && prev.node.parentNode !== null) prev.node.replaceWith(node);
  prev.node = node;
  if (row.diffs.length > 0) state.tail = null;
}

/** Backfilled tool run (folded projection §3.2): one page's folded view of a
   tool call. The server folds every page with a fresh RunAssembler, so a call
   cut by the page boundary arrives as one run per page — the §3.2 merge joins
   them by toolCallId (field completion, and the diff rules of mergeToolRow:
   union for engine-reported diffs, replacement for rebuilt ones) rather than dealing a
   second card whose title degenerates to the bare id. That merge IS the live
   toolRow patch path, so this routes through onToolRow with backfillToolSnapshot
   translating the wire shape. `meta.seq` is the run's seqTo, which is the right
   anchor for rendering and the wrong one for the diff index — see onToolRow,
   which owns that reasoning; `backfill: true` is what keeps it off that path. */
function onBackfillToolRun(run) {
  onToolRow(backfillToolSnapshot(run), { seq: run.seqTo, ts: 0, backfill: true });
}

/* ---------- folded rendering (ADR 0006 / §5.7, console-v2 §3.2) ----------
   Live path: the browser folder turns the verbatim chunk stream into
   presentation events. Degraded mode never reaches here — an envelope
   carries no `update` to fold (§7.8). usageState is the envelope's token
   accounting riding every event; it derives no row (the v2 transcript shows
   messages, tools and diffs), and it must not break message/group adjacency. */

function renderFolded(folded) {
  const { event, source } = folded;
  if (event.type === 'messageStart') {
    onMessageStart(event.kind, event.messageId, source.ts, source.seq);
  } else if (event.type === 'messageAppend') {
    onMessageAppend(event.block?.text ?? '', source.seq);
  } else if (event.type === 'messageEnd') {
    onMessageEnd();
  } else if (event.type === 'content') {
    breakTail();
    const node = document.createElement('div');
    node.className = `event k-${event.kind}`;
    // resource_link shows its human summary with the uri on hover; every
    // other block keeps the bare type (ADR 0023 §4.2). Same helper as the
    // backfill path — one owner, so live and refresh cannot disagree.
    const link = contentLabel(event.block);
    const titleAttr = link.title !== undefined ? ` title="${esc(link.title)}"` : '';
    node.innerHTML = `<div class="meta"><span class="seq">#${source.seq}</span><span class="time">${fmtTime(source.ts)}</span><span class="kind"${titleAttr}>${esc(link.label)}</span></div>`;
    batchAppend(node);
  } else if (event.type === 'toolRow') {
    onToolRow(event.row, source);
  } else if (event.type === 'planState' || event.type === 'notice') {
    breakTail();
    const node = document.createElement('div');
    node.className = 'event k-notice';
    // A meta event names itself (ADR 0023 §4.3); planState keeps its label.
    const kindText = event.type === 'notice' ? noticeLabel(event.update) : event.type;
    node.innerHTML = `<div class="meta"><span class="seq">#${source.seq}</span><span class="time">${fmtTime(source.ts)}</span><span class="kind">${esc(kindText)}</span></div>`;
    batchAppend(node);
  } else if (event.type === 'usageState') {
    // No row: token accounting rides nearly every envelope and would be a
    // notice per event. A chunk-carried snapshot settles nothing — it rode in
    // on a message that is still open, and `state.msg` is non-null by the time
    // it arrives, because the folder emits messageStart/Append before it.
    //
    // A snapshot from a bare `usage_update` is the opposite: that update ENDS
    // the open message, and at the folded/raw seam the cold-started folder has
    // no messageStart of its own to close, so it emits no messageEnd and the
    // adopted tail run would stay open — and the next message would merge into
    // it. `state.msg === null` is exactly that case, and settleOpenTailMessage
    // is a no-op in the other.
    if (state.msg === null) settleOpenTailMessage();
  } else if (event.type === 'raw') {
    // The folder never drops what it did not understand, and neither does this.
    breakTail();
    const node = document.createElement('div');
    node.className = 'event k-raw';
    node.innerHTML = `<div class="meta"><span class="seq">#${source.seq}</span><span class="time">${fmtTime(source.ts)}</span><span class="kind">raw · ${esc(event.reason)}</span></div>`;
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = JSON.stringify(event.update);
    node.appendChild(body);
    batchAppend(node);
  }
}

/** Backfill path: one run of a folded projection page (console-v2 §3.2). */
function renderFoldedRun(run) {
  switch (run.kind) {
    case 'thought':
    case 'agent':
    case 'user': {
      const messageId = typeof run.messageId === 'string' ? run.messageId : undefined;
      if (continuesOpenRun(state.tail, { kind: run.kind, messageId, fromFoldedPage: true, openStart: run.openStart })) {
        // §3.2 page seam: a run never spans pages, so a message cut by the
        // page boundary arrives as two fragments to concatenate. Why the
        // decision needs the open state rather than same-key adjacency is in
        // seam-merge.js, which owns it for both seams.
        const target = state.tail.run;
        target.seqTo = run.seqTo;
        // Content comes from the shared rule; what to MOUNT is this side's
        // decision and stays here. A whole message goes through the §4.1
        // preview policy (thought runs clamp, answers do not); one the server
        // withheld has no full text to mount, so it shows its preview and
        // `text === undefined` is what later sends the expand to the network.
        const joined = joinFragmentContent(target, run, PREVIEW_LIMIT);
        target.text = joined.text;
        target.preview = joined.preview;
        target.fullBytes = joined.fullBytes;
        if (joined.text === undefined) target.truncated = true;
        else applyPreviewPolicy(target, PREVIEW_LIMIT);
        target.open = run.openEnd === true;
        if (target.open) renderMessage(target);
        else settleMessage(target);
        if (batch !== null) batch.measure.add(target);
        return;
      }
      settleOpenTailMessage();
      const msgRun = makeMessageRun(run.kind, messageId, { ts: 0, seq: run.seqFrom }, {
        text: typeof run.text === 'string' ? run.text : undefined,
        preview: typeof run.preview === 'string' ? run.preview : undefined,
        truncated: run.truncated === true,
        open: run.openEnd === true,
      });
      msgRun.seqTo = run.seqTo;
      state.tail = { type: 'msg', run: msgRun };
      return;
    }
    case 'tool':
      onBackfillToolRun(run);
      return;
    case 'oversized':
      // §9.4: an oversized event never entered the folder; the page carries
      // the reference run and the open message fragment continues past it.
      if (state.msg !== null) { settleMessage(state.msg); state.msg = null; }
      breakTail();
      batchAppend(eventRefNode(run));
      return;
    case 'content':
      breakTail();
      {
        const node = document.createElement('div');
        node.className = `event k-${typeof run.messageKind === 'string' ? run.messageKind : 'content'}`;
        const link = contentLabel(run.block);
        const titleAttr = link.title !== undefined ? ` title="${esc(link.title)}"` : '';
        node.innerHTML = `<div class="meta"><span class="seq">#${run.seqFrom}</span><span class="kind"${titleAttr}>${esc(link.label)}</span></div>`;
        batchAppend(node);
      }
      return;
    case 'plan':
    case 'notice':
      breakTail();
      {
        const node = document.createElement('div');
        node.className = 'event k-notice';
        // Same helper the live path uses (ADR 0023 §4.3): a meta event names
        // itself, so refresh shows what live showed.
        const kindText = run.kind === 'plan' ? 'planState' : noticeLabel(run.update);
        node.innerHTML = `<div class="meta"><span class="seq">#${run.seqFrom}</span><span class="kind">${esc(kindText)}</span></div>`;
        batchAppend(node);
      }
      return;
    case 'usage':
      return; // see renderFolded — no row, no adjacency break
    case 'raw':
      breakTail();
      {
        const node = document.createElement('div');
        node.className = 'event k-raw';
        node.innerHTML = `<div class="meta"><span class="seq">#${run.seqFrom}</span><span class="kind">raw · ${esc(run.reason ?? '')}</span></div>`;
        const body = document.createElement('div');
        body.className = 'body';
        body.textContent = JSON.stringify(run.update);
        node.appendChild(body);
        batchAppend(node);
      }
      return;
    default:
      return;
  }
}

/** §7.8: an envelope has no `update`, so there is nothing to fold. */
function envelopeNode(frame) {
  const row = document.createElement('div');
  row.className = 'event';
  row.innerHTML = `<div class="meta"><span class="seq">#${frame.seq}</span><span class="kind">event</span></div>
    <div class="body">event · ${fmtBytes(Number(frame.event?.byteLen ?? 0))}</div>`;
  return row;
}

function eventRefNode(frame) {
  const row = document.createElement('div');
  row.className = 'event';
  row.innerHTML = `
    <div class="meta"><span class="seq">#${frame.seq}</span><span class="kind">event_ref</span></div>
    <div class="body"><div class="oversized" title="oversized event: shown by reference, never its body (§5.2 / design §9.4)">
      <span>⬡ event #${frame.seq}</span>
      ${typeof frame.totalBytes === 'number' ? `<span class="size">${fmtBytes(frame.totalBytes)}</span>` : ''}
      ${typeof frame.sha256 === 'string' ? `<span class="hash">sha256 ${esc(frame.sha256.slice(0, 16))}…</span>` : ''}
    </div></div>`;
  return row;
}

/* ---------- folded backfill + live seam (console-v2 §3.2) ---------- */

/**
 * Page the folded projection to the high watermark, then open the SSE stream
 * from it. Opening after the backfill (rather than racing the two) means no
 * overlap and no gap: events appended in between are re-read by the stream's
 * own backfill from afterSeq. Returns false when a newer selection made this
 * one stale.
 */
async function backfillSession(sessionId, epoch) {
  let afterSeq = 0;
  for (;;) {
    const path = `/api/sessions/${encodeURIComponent(sessionId)}/events?afterSeq=${afterSeq}&projection=folded`;
    let res;
    try {
      res = await fetch(path, { headers: { accept: 'application/json' } });
    } catch {
      throw new ApiFailure(path, { kind: 'network' });
    }
    if (epoch !== state.selectEpoch || state.activeSessionId !== sessionId) return false;
    // The folded route renders oversized single events inline as reference
    // runs (§9.4), so a 413 here is the whole-page backstop only — it carries
    // no seq to skip to. §10.0 classifies it as the one recoverable outcome:
    // selectSession's sink falls back to the raw SSE stream, which pages past
    // the same events as event_ref frames. A 404 is the session being gone and
    // gets the invalidated banner; everything else leaves a row.
    if (!res.ok) throw new ApiFailure(path, { kind: 'status', status: res.status });
    const page = await readJson(path, res);
    // Checked again, and not only after the fetch: reading the body is a
    // second await, and a selection made while it was in flight would render
    // this session's page into the next one's pane and folder.
    if (epoch !== state.selectEpoch || state.activeSessionId !== sessionId) return false;
    batchBegin();
    try {
      if (Array.isArray(page.runs)) {
        for (const run of page.runs) renderFoldedRun(run);
      } else {
        // §3.4 degraded mode: the folded projection degenerates to raw
        // envelope pages — rendered as envelopes, same as the SSE frames.
        for (const event of page.events ?? []) {
          if (state.msg !== null) { settleMessage(state.msg); state.msg = null; }
          breakTail();
          batchAppend(envelopeNode({ seq: event.seq, event }));
        }
      }
    } finally {
      batchCommit();
    }
    // The resume cursor advances over what was actually rendered, never to
    // the watermark: a failed later page leaves the stream fallback to
    // re-deliver exactly the unrendered tail (backfill-cursor.js).
    state.renderedSeq = renderedSeqAfterPage(state.renderedSeq, page);
    if (typeof page.highWatermark === 'number') {
      state.lastSeq = page.highWatermark;
      updateSeqLabel();
    }
    if (page.hasMore !== true) break;
    const next = typeof page.nextSeq === 'number' ? page.nextSeq - 1 : afterSeq + 1;
    if (next <= afterSeq) break; // no forward progress — do not loop forever
    afterSeq = next;
  }
  const stream = streamEl();
  stream.scrollTop = stream.scrollHeight;
  return true;
}

/* ---------- diff summary view (console-v2 §4.5/§3.1) ---------- */

const diffStreamEl = () => $('diff-stream');

function freshDiffView() {
  return {
    initialized: false,
    partial: false,
    entries: [],
    keys: new Set(),
    // ADR 0021 bookkeeping. `owners` is the only place a wire entry can be
    // traced back to its call: the wire deliberately carries no call id, and
    // recordLiveDiffs is the one point holding both it and the entry's seq.
    owners: new Map(),
    // Keys withdrawn by supersession, so a /diffs page already in flight when
    // it happened cannot put them back.
    retracted: new Set(),
    // Bumped on every (re)initialisation; a page answering an older generation
    // is discarded whole. selectEpoch cannot serve — it only moves on a
    // session switch, and this race lives inside one session.
    generation: 0,
  };
}

/* Kept in seq order, not arrival order. Live diffs are recorded from the SSE
   stream whether or not the diff view was ever opened, so by the time it IS
   opened the list already holds the newest entries and the §3.1 index backfill
   brings the older ones — appending would render the session's history after
   its present. The DOM side is grouped by file, so a live diff lands inside
   its file's group rather than at the list's end; appending stays correct for
   a brand-new group because a new diff always carries the highest seq.

   Returns `'inserted'` when the entry is new to the view and `null` when it
   changed nothing — the same diff arriving from the other source deals no
   second row. */
function addDiffIndexEntry(entry) {
  const view = state.diffView;
  if (view === null) return null;
  const key = diffEntryKey(entry);
  // Withdrawn by a supersession that happened while this page was in flight.
  if (view.retracted.has(key)) return null;
  if (view.keys.has(key)) return null;
  view.keys.add(key);
  insertBySeq(view.entries, entry);
  return 'inserted';
}

function renderDiffSummary() {
  const el = diffStreamEl().querySelector('.diff-summary');
  if (el === null) return;
  const entries = state.diffView?.entries ?? [];
  const files = new Set(entries.map((entry) => entry.path ?? ''));
  const adds = entries.reduce((n, entry) => n + (entry.adds ?? 0), 0);
  const dels = entries.reduce((n, entry) => n + (entry.dels ?? 0), 0);
  el.innerHTML = `${files.size} file${files.size === 1 ? '' : 's'} changed · <span class="add">+${adds}</span> <span class="del">−${dels}</span>`;
}

/** One file group's head: path (a muted placeholder when the wire stated
   none), a `deleted` marker when any entry is a deletion, and the summed
   stats. Consumes groupDiffEntries' sums rather than re-adding them — one
   owner for the arithmetic. */
function diffGroupHeadHtml(group) {
  const label = group.path === ''
    ? '<span class="path pathless">(no path)</span>'
    : `<span class="path">${esc(group.path)}</span>`;
  const deleted = group.entries.some((entry) => entry.deleted === true);
  return `${label}
    <span class="stats">${deleted ? '<span class="del">deleted</span> ' : ''}<span class="add">+${group.adds}</span><span class="del">−${group.dels}</span></span>`;
}

function diffGroupNode(group) {
  const node = document.createElement('div');
  node.className = 'diff-group';
  node.dataset.diffGroupPath = group.path;
  node.innerHTML = `<div class="diff-group-head">${diffGroupHeadHtml(group)}</div><div class="diff-group-items"></div>`;
  const items = node.querySelector('.diff-group-items');
  for (const entry of group.entries) items.appendChild(diffItemNode(entry));
  return node;
}

/* Live arrival and supersession both change a group after it was drawn: the
   head's sums are rebuilt from the model (which addDiffIndexEntry / retraction
   has already updated), never adjusted incrementally — two arithmetics for one
   number would drift. */
function refreshDiffGroupHead(groupNode) {
  const path = groupNode.dataset.diffGroupPath ?? '';
  const entries = (state.diffView?.entries ?? []).filter((entry) => (entry.path ?? '') === path);
  const group = groupDiffEntries(entries)[0];
  if (group !== undefined) groupNode.querySelector('.diff-group-head').innerHTML = diffGroupHeadHtml(group);
}

function diffItemNode(entry) {
  const row = document.createElement('div');
  row.className = 'event k-tool_call';
  row.dataset.diffKey = diffEntryKey(entry);
  row.innerHTML = `
    <div class="body"><div class="diff">
      <div class="diff-head" title="View diff">
        <span class="seq">#${entry.seq}</span>
        <span class="tname">${esc(entry.tool ?? 'tool')}</span>
        ${entry.origin === 'reconstructed' ? REBUILT_TAG : ''}
        ${entry.deleted === true ? DELETED_TAG : `<span class="stats"><span class="add">+${entry.adds}</span><span class="del">−${entry.dels}</span></span>`}
        <span class="chev">▶</span>
      </div>
      <div class="diff-lines"></div>
    </div></div>`;
  const head = row.querySelector('.diff-head');
  head.onclick = () => {
    const card = head.parentElement;
    card.classList.toggle('open');
    if (card.classList.contains('open') && card.dataset.loaded !== '1') {
      card.dataset.loaded = '1';
      // A read that failed must be retryable, or the row it renders can never
      // come down: the card was marked loaded before the call, so re-opening
      // it did nothing and the failed reader stayed outstanding forever —
      // holding the shared row up for every other reader with it.
      void loadDiffLines(entry, card.querySelector('.diff-lines')).then((loaded) => {
        if (loaded === false) delete card.dataset.loaded;
      });
    }
  };
  return row;
}

/* Expansion content comes from the live-observed cache when the diff arrived
   over SSE, else from the raw projection's single-event fetch (§3.1: content
   stays on the events routes; the index carries no content).

   Returns **false** when the read failed, and the caller un-marks the card so
   the operator can retry — without that a failed expansion is unrepeatable and
   the row it rendered can never come down. Every other exit returns undefined,
   which means "loaded, leave the card marked"; a bare `return` added to a new
   branch therefore does the right thing, and a `return false` must mean the
   content is genuinely not there. */
async function loadDiffLines(entry, linesEl) {
  if (entry.deleted === true) {
    // Nothing to fetch: the patch segment carried no lines. Saying so is not
    // the same as the "content unavailable" message below, which claims the
    // content exists and could not be had.
    linesEl.innerHTML = DELETED_BODY;
    return;
  }
  const epoch = state.selectEpoch;
  let entries = state.diffContent.get(entry.seq);
  // A cache hit is this reader succeeding, and it has to say so. Two entries
  // can share a seq while having their own reader ids, so a sibling's fetch can
  // populate the cache after this one failed: without this the failed reader
  // stays outstanding, and the row it holds up cannot come down for any reader
  // — over a pane that is now rendering the diff correctly.
  if (entries !== undefined) clearFailureRow('sessionRead', diffReader(entry));
  if (entries === undefined) {
    const sessionId = state.activeSessionId;
    if (sessionId === null) return;
    try {
      const page = await api(`/api/sessions/${encodeURIComponent(sessionId)}/events?afterSeq=${entry.seq - 1}&toSeq=${entry.seq}`);
      if (epoch !== state.selectEpoch) return;
      // The same derivation the index ran, over the same raw event: a rebuilt
      // diff's body is in this event's rawInput, so no new server route is
      // needed to expand one.
      entries = deriveDiffEntries(page.events?.[0]?.update);
      state.diffContent.set(entry.seq, entries);
      clearFailureRow('sessionRead', diffReader(entry));
    } catch (error) {
      // The placeholder used to assert one of these for both: that an
      // oversized event legitimately stays a reference. It says neither now,
      // because the row says what happened. Both reach a row — §10.0 gives
      // `sessionRead` only one exception, a 404, and a 413 is not it.
      linesEl.innerHTML = '<div class="dline"><span class="sign"></span><span class="code">content unavailable</span></div>';
      if (epoch === state.selectEpoch) handleFetchFailure(failureOutcome(error), 'sessionRead', transcriptSink(sessionId, 'sessionRead', undefined, diffReader(entry)));
      return false;
    }
  }
  // By (path, part): a call with three hunks has three entries at one seq and
  // one path, and matching on path alone renders the first for all three.
  const match =
    entries.find((c) => (c.path ?? undefined) === entry.path && c.part === entry.part) ??
    entries.find((c) => (c.path ?? undefined) === entry.path) ??
    entries[0];
  if (match === undefined) {
    linesEl.innerHTML = '<div class="dline"><span class="sign"></span><span class="code">no diff content at this seq</span></div>';
    return;
  }
  linesEl.innerHTML = diffLinesHtml(diffLines(match.oldText, match.newText));
}

function renderDiffList() {
  const stream = diffStreamEl();
  stream.innerHTML = '<div class="diff-summary"></div>';
  const entries = state.diffView?.entries ?? [];
  const partial = state.diffView?.partial === true;
  // "no diffs yet" is a claim about the session. After a failed index walk it
  // is not one this UI can make — the notice below says what is actually
  // known instead.
  if (entries.length === 0 && !partial) {
    stream.insertAdjacentHTML('beforeend', '<div class="diff-empty">no diffs yet in this session</div>');
  } else {
    for (const group of groupDiffEntries(entries)) stream.appendChild(diffGroupNode(group));
  }
  // An interrupted index walk leaves a prefix; say so rather than let the
  // summary above it pass for the session's totals.
  if (partial) {
    stream.insertAdjacentHTML('beforeend',
      '<div class="diff-empty diff-partial">index incomplete — a page of the diff index failed to load, so the totals above count only what is listed. Switch away and back to retry.</div>');
  }
  renderDiffSummary();
}

/**
 * How a display-row diff is identified while diffing one merge against the next.
 *
 * This one DOES carry `part`, where tool-row-state's own key deliberately does
 * not. The two answer different questions: that key has to collapse the same
 * native diff re-reported at a different index in a later whole-array content
 * replacement, while this one has to tell two entries of the *current* row
 * apart — and one call can state two identical hunks, which differ only by
 * position. Without `part` here they would collide, and `view.owners` would
 * keep one owner for two rows.
 */
function displayDiffKey(entry) {
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
 * A call's rebuilt diffs that this merge withdrew: remove their rows, and
 * remember the keys so a /diffs page still in flight cannot re-add them.
 *
 * An entry the live path never inserted has no key here — it came from the
 * index backfill, and nothing client-side can map it back to a call. Those are
 * healed by marking the view for a refetch instead.
 */
function retractLiveDiffs(toolCallId, goneDiffs) {
  const view = state.diffView;
  if (view === null) return;
  const keys = goneDiffs.filter((entry) => entry.origin === 'reconstructed').map(displayDiffKey);
  if (keys.length === 0) return;
  const { removed, unlocated } = retractOwnedEntries(view, toolCallId, keys);
  if (view.initialized) {
    for (const key of removed) removeDiffRow(key);
    if (removed.length > 0) renderDiffSummary();
  }
  // Withdrawn, but this view never inserted it — it came from a backfill, and
  // nothing client-side can say which row it is. Clearing `initialized` makes
  // the next entry into the view refetch from an index that has already
  // applied the withdrawal.
  if (unlocated) view.initialized = false;
}

/** Remove one rendered diff row. Scanned rather than selected: a key holds a
   file path, so it cannot go in an attribute selector unescaped. A group left
   empty goes with its last row — a head with no items still claims the file
   changed. */
function removeDiffRow(key) {
  for (const group of diffStreamEl().querySelectorAll('.diff-group')) {
    const items = group.querySelector('.diff-group-items');
    for (const node of items.children) {
      if (node.dataset?.diffKey === key) {
        node.remove();
        if (items.children.length === 0) group.remove();
        else refreshDiffGroupHead(group);
        return;
      }
    }
  }
}

/* Live diffs arrive over SSE as toolRow patches (§3.1: incremental append,
   no re-render, so expanded cards keep their state). */
function recordLiveDiffs(row, freshDiffs, meta) {
  for (const entry of freshDiffs) {
    const deleted = entry.deleted === true;
    const lines = deleted ? [] : diffLines(entry.oldText, entry.newText);
    const indexEntry = {
      seq: meta.seq,
      ...(row.name ?? row.title ? { tool: row.name ?? row.title } : {}),
      ...(typeof entry.path === 'string' ? { path: entry.path } : {}),
      adds: lines.filter((l) => l.t === 'add').length,
      dels: lines.filter((l) => l.t === 'del').length,
      ...(typeof row.status === 'string' ? { status: row.status } : {}),
      // Field for field what the server's diffIndexEntryOutput emits — the two
      // sources must describe the same diff identically or the view's dedup
      // key tells them apart and shows it twice.
      origin: entry.origin ?? 'engine',
      part: entry.part ?? 0,
      ...(deleted ? { deleted: true } : {}),
    };
    const view = state.diffView;
    if (view !== null && entry.origin === 'reconstructed') {
      rememberDiffOwner(view, row.toolCallId, displayDiffKey(entry), diffEntryKey(indexEntry));
    }
    const cached = state.diffContent.get(meta.seq) ?? [];
    cached.push(entry);
    state.diffContent.set(meta.seq, cached);
    // A duplicate arrival (the same diff from the index backfill) deals no row.
    if (addDiffIndexEntry(indexEntry) === 'inserted' && state.diffView?.initialized === true) {
      const stream = diffStreamEl();
      // The empty-state placeholder goes; the incomplete-index notice does not
      // — the index is still incomplete — and it stays last, so a new group
      // goes in front of it rather than below the sentence about it.
      stream.querySelector('.diff-empty:not(.diff-partial)')?.remove();
      const notice = stream.querySelector('.diff-partial');
      const path = indexEntry.path ?? '';
      // Scanned, not selected: the path cannot go in an attribute selector
      // unescaped (same reason as removeDiffRow).
      let group = null;
      for (const node of stream.querySelectorAll('.diff-group')) {
        if ((node.dataset?.diffGroupPath ?? '') === path) { group = node; break; }
      }
      if (group === null) {
        // A brand-new group appends at the end: a live diff always carries the
        // highest seq, and groups are ordered by their earliest seq.
        const fresh = groupDiffEntries([indexEntry])[0];
        group = diffGroupNode(fresh);
        if (notice === null) stream.appendChild(group);
        else stream.insertBefore(group, notice);
      } else {
        group.querySelector('.diff-group-items').appendChild(diffItemNode(indexEntry));
        refreshDiffGroupHead(group);
      }
      renderDiffSummary();
    }
  }
}

async function enterDiffView() {
  const view = state.diffView;
  const sessionId = state.activeSessionId;
  if (view === null || sessionId === null) return;
  if (!view.initialized) {
    view.initialized = true;
    // A reinitialisation answers only its own generation, and starts from an
    // empty view: the server index has already applied any supersession, so
    // appending onto the old rows would keep exactly what this refetch exists
    // to drop.
    const generation = beginBackfill(view);
    // Take the old rows down now, before the first page comes back.
    // beginBackfill empties the model, and leaving them up until the fetch
    // resolves means a stalled request shows rows the model no longer has —
    // including ones a supersession just withdrew, which is the case this
    // refetch exists to correct. Only the rows go: renderDiffList would also
    // write "no diffs yet in this session", and that is a claim about the
    // session which nothing knows yet.
    diffStreamEl().innerHTML = '<div class="diff-summary"></div>';
    const epoch = state.selectEpoch;
    try {
      // §3.1 is a content route and pages like the others: a session past the
      // index cap can hold far more entries than one budgeted body carries.
      let afterSeq = 0;
      for (;;) {
        const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}/diffs?afterSeq=${afterSeq}`);
        if (epoch !== state.selectEpoch || generation !== view.generation) return;
        // A live diff recorded while this walk ran is already held, so its
        // index twin is dropped by key; every row is redrawn from the model by
        // the renderDiffList that closes this walk.
        for (const entry of data.diffs ?? []) addDiffIndexEntry(entry);
        if (data.hasMore !== true) break;
        const next = typeof data.nextSeq === 'number' ? data.nextSeq - 1 : afterSeq + 1;
        if (next <= afterSeq) break; // no forward progress — do not loop forever
        afterSeq = next;
      }
    } catch (error) {
      // Both axes, exactly as the loop above checks them. `beginBackfill`
      // bumps the generation on the SAME view object rather than handing out a
      // fresh one, so two walks of one session share `initialized`, `partial`
      // and this reader id — and a superseded walk writing its failure back
      // marks the current walk's finished index as partial and leaves a row
      // asserting a read that succeeded. The success path has always checked
      // both; only this one did not.
      if (epoch !== state.selectEpoch || generation !== view.generation) return;
      // §10.0: the shortfall is also stated where the transcript is, not only
      // as a badge on a list the operator may not be looking at.
      handleFetchFailure(failureOutcome(error), 'sessionRead', transcriptSink(sessionId, 'sessionRead', undefined, 'diff-index'));
      // A page failed part-way. The entries already collected are real and
      // stay, but the walk did NOT finish: the list is a prefix of the index
      // and the summary row undercounts. Clearing `initialized` lets a reopen
      // retry, and `partial` makes the shortfall visible meanwhile — a short
      // list with a correct-looking total is read as the answer, which is the
      // worse of the two failures.
      view.initialized = false;
      view.partial = true;
    }
    if (view.initialized) { view.partial = false; clearFailureRow('sessionRead', 'diff-index'); }
  }
  renderDiffList();
}

function setTxView(view) {
  state.txView = view;
  document.querySelector('.transcript-wrap').classList.toggle('tx-diff', view === 'diff');
  document.querySelectorAll('.tx-tabs .vt').forEach((b) => b.classList.toggle('active', b.dataset.txview === view));
  // The pill acts on the transcript, so it is hidden while the diff view is up
  // and restored on the way back if the transcript is still scrolled away.
  $('to-bottom').classList.toggle('show', view !== 'diff' && !pinnedToBottom());
  if (view === 'diff') void enterDiffView();
}

/* ---------- session selection ---------- */

/* One owner for "the transcript panel now shows something else": every cursor,
   every accumulator, both panels' DOM.
   
   It was three copies — select a session, the transcript was deleted, the
   session left the list — and they had already drifted: the third forgot
   `folder` and `deleted`, so after the LAST session was deleted the "transcript
   deleted" banner stayed on screen over an empty panel with nothing left to
   select that would clear it. Both fields are parameters rather than defaults
   so a fourth caller cannot omit them either. */
function resetTranscriptView({ folder, deleted }) {
  state.lastSeq = 0;
  state.renderedSeq = 0;
  state.deleted = deleted;
  state.folder = folder;
  state.msg = null;
  state.tail = null;
  state.toolRows.clear();
  state.frameQueue = [];
  state.diffContent.clear();
  state.diffView = freshDiffView();
  // §10.0: a failure row belongs to the session, not to the pane that is being
  // emptied. Re-selecting the same session re-attaches its unresolved rows;
  // moving to another session — or to none — drops the whole set.
  if (state.failureRowSession !== state.activeSessionId) {
    state.failureRows.clear();
    state.failedReads.clear();
    state.failureRowSession = state.activeSessionId;
  }
  streamEl().innerHTML = '';
  for (const node of state.failureRows.values()) streamEl().appendChild(node);
  diffStreamEl().innerHTML = '';
  $('to-bottom').classList.remove('show');
  $('invalidated').classList.toggle('show', deleted);
  updateSeqLabel();
}

function showInvalidated() {
  // Anything still in flight for this session belongs to the view being
  // replaced. Without this a folded backfill that resolves afterwards renders
  // transcript rows over the banner and opens a stream for a session the
  // server has already told us is gone — the epoch is what everything else in
  // here checks, so moving it is what invalidation has to do.
  state.selectEpoch += 1;
  // The rows go with it. §10.0 drops a failure when there is no longer a place
  // where rendering it would be true, and a deleted session is that: no read of
  // it can ever succeed, so nothing could take these down, and the operator
  // would be left with "transcript read failed: HTTP 500" pinned above the
  // banner saying the session is gone. `resetTranscriptView` keeps them —
  // correctly, since `activeSessionId` has not changed — so this is the one
  // caller that has to say otherwise.
  state.failureRows.clear();
  state.failedReads.clear();
  streamEl().innerHTML = '';
  // And the stream goes too. This function owns "this session is gone"; it
  // must not depend on the server's own `invalidated` frame arriving to close
  // the connection, since the banner can also be reached from a 404 on a
  // session-scoped read, and a stream left open holds a maxConsoleStreams slot
  // for a session nothing will ever read again.
  closeSessionStream();
  resetTranscriptView({ folder: null, deleted: true });
  // §4.5: the diff view has no data either after a delete — back to transcript.
  setTxView('transcript');
}

function openSessionStream(sessionId) {
  // The afterSeq param skips the server's raw backfill of what the UI already
  // rendered — the full watermark on a clean backfill, the last rendered seq
  // on the failure fallback, so the unrendered tail is re-delivered rather
  // than skipped. On a native reconnect Last-Event-ID wins, so the resume
  // point is the last frame actually received (§5.1).
  const es = new EventSource(`/api/stream?sessionId=${encodeURIComponent(sessionId)}&afterSeq=${state.renderedSeq}`);
  state.sessionStream = es;
  const suppression = createSuppression();
  state.sessionSuppression = suppression;
  // The handshake succeeded, so whatever this stream failed with before is
  // over; leaving its row up would state a failure over a working stream.
  es.onopen = () => { if (state.sessionStream === es) clearFailureRow('sessionStream', 'sessionStream'); };
  es.onmessage = (msg) => {
    // `close()` does not retract a message task the browser has already
    // queued, so a frame from the stream of a session the operator has left
    // can still arrive. The frame's own sessionId does not catch it — it is
    // the *old* session's id, which matches the id this closure captured —
    // so the test is on the stream: only the current one may write.
    if (state.sessionStream !== es) return;
    let frame;
    try { frame = JSON.parse(msg.data); } catch { return; }
    if (frame.sessionId !== undefined && frame.sessionId !== sessionId) return;
    // Flush first: queued pre-delete frames belong to the view the invalidated
    // banner is about to replace, not to the discard pile.
    if (frame.type === 'invalidated') { flushFrames(); showInvalidated(); closeStream(es, suppression); return; }
    if (frame.type === 'transition') { onTransition(frame); return; }
    if (state.deleted) return;
    appendFrame(frame);
  };
  // §10.0: CONNECTING is a native reconnect and stays silent here. Nothing
  // reports it for this stream — the pill's "reconnecting" is driven by the
  // instance stream alone, so a session stream retrying under a healthy
  // instance stream shows nothing. That is a concession to the pill being one
  // line, not a claim that it is covered. CLOSED is the browser saying it has
  // given up, and used to render as nothing at all (GZH-44).
  es.onerror = () => { handleStreamError(es, suppression, 'session', transcriptSink(sessionId, 'sessionStream')); };
}

/**
 * The one way a session stream is closed on purpose. `close()` also lands in
 * `CLOSED`, so a close that is not marked first renders the operator's own
 * action as a stream failure (§10.0). Named per stream rather than reading
 * `state`: the caller names the stream it means. That is defence in depth
 * rather than a live hazard — `onmessage` returns early unless `es` is the
 * current stream, so the `invalidated` branch cannot reach here with a stale
 * one — and an earlier version of this comment claimed the hazard instead,
 * which sent a reader looking for a case that cannot occur.
 */
function closeStream(es, suppression) {
  suppression?.markDeliberate();
  es.close();
  if (state.sessionStream === es) {
    state.sessionStream = null;
    state.sessionSuppression = null;
  }
}

/** Close whichever session stream is currently open, if any. */
function closeSessionStream() {
  if (state.sessionStream !== null) closeStream(state.sessionStream, state.sessionSuppression);
}

/** The marker Runskein writes on `session_info_update`; the plugin's store reads the same key. */
const SESSION_META_KEY = 'runskein.dev/sessionMeta';

/**
 * Show the engine's own session id, so an operator can resume the session in
 * that engine's CLI (GZH-80).
 *
 * The plugin's twenty tools have no resume: once a session is closed the only
 * way to keep talking to it is the engine's own CLI, and that needs the id the
 * engine assigned. Nothing else in this console shows it — the head shows
 * `engine · name` and every tool result carries TaskShuttle's own session id.
 *
 * **Where the value comes from, and why it is a second request.** It rides in
 * the first transcript event's `_meta`, and the backfill this pane runs asks
 * for the *folded* projection, whose runs carry no `_meta` at all. So the id
 * needs the raw projection's single-event fetch — the same `afterSeq/toSeq`
 * pair the diff expansion already uses.
 *
 * **Degraded mode needs no rule here.** With `exposeTranscripts: false` the
 * server projects every event to `{seq, ts, byteLen}`, so the marker never
 * arrives and the row simply stays hidden. The boundary holds by construction
 * rather than by a check somebody has to remember (console-design §7.8).
 *
 * **A missing id shows nothing.** Not a placeholder, and never TaskShuttle's
 * own session id in its place: an id that looks resumable and is not costs the
 * operator more than a blank row. Transcripts recorded under the pre-rename
 * dependency project nothing at all (ADR 0041 decision 2), and a first event
 * aged out by retention is the same case.
 */
async function loadResumeId(sessionId, epoch) {
  const row = $('tx-resume');
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/events?afterSeq=0&toSeq=1`;
  let page;
  try {
    page = await api(path);
  } catch {
    // Silent: the id is a convenience, and a failure row for it would sit
    // beside a transcript that loaded perfectly well.
    return;
  }
  if (epoch !== state.selectEpoch || state.activeSessionId !== sessionId) return;
  const first = Array.isArray(page.events) ? page.events[0] : undefined;
  const meta = first?.update?._meta?.[SESSION_META_KEY];
  const nativeSessionId = meta === null || typeof meta !== 'object' ? undefined : meta.nativeSessionId;
  if (typeof nativeSessionId !== 'string' || nativeSessionId === '') return;
  $('tx-resume-id').textContent = nativeSessionId;
  $('tx-resume-id').title = nativeSessionId;
  row.hidden = false;
}

/**
 * Put the resume id on the clipboard, and say plainly when that did not work.
 *
 * `navigator.clipboard` is present on a secure context, and `127.0.0.1` is one
 * — but the write can still be refused, and a button that silently does
 * nothing is worse than one that says so. Either way the value stays
 * selectable, which is the fallback that needs no permission.
 */
async function copyResumeId() {
  const value = $('tx-resume-id').textContent;
  const note = $('tx-resume-note');
  if (value === '') return;
  try {
    await navigator.clipboard.writeText(value);
    note.textContent = 'copied';
  } catch {
    note.textContent = 'could not copy — select it instead';
  }
  note.hidden = false;
}

/** Hide the resume row and its transient note; a new selection starts with neither. */
function clearResumeId() {
  $('tx-resume').hidden = true;
  $('tx-resume-id').textContent = '';
  $('tx-resume-id').title = '';
  $('tx-resume-note').hidden = true;
  $('tx-resume-note').textContent = '';
}

function selectSession(sessionId) {
  closeSessionStream();
  const epoch = ++state.selectEpoch;
  state.activeSessionId = sessionId;
  // A fresh selection gets a fresh folder: the two lifetimes are the same
  // one, which is why a resumed stream never meets a stale fold.
  resetTranscriptView({ folder: createFolder(), deleted: false });
  const s = state.sessions.find((x) => x.sessionId === sessionId);
  $('tx-title').textContent = s ? `${s.engine} · ${sessionLabel(s)}` : shortId(sessionId);
  clearResumeId();
  void loadResumeId(sessionId, epoch);
  renderSessions();
  if (state.txView === 'diff') void enterDiffView();
  backfillSession(sessionId, epoch)
    .then((ok) => {
      if (!ok || epoch !== state.selectEpoch) return;
      clearFailureRow('backfillFolded', 'backfillFolded');
      openSessionStream(sessionId);
    })
    .catch((error) => {
      if (epoch !== state.selectEpoch) return;
      // §10.0 decides what this failure was. Only a 413 is recoverable: the
      // verbatim SSE stream from the last rendered seq pages past the same
      // events, so nothing rendered is skipped or repeated. Every other
      // failure leaves a row where the transcript would have continued —
      // silently opening the fallback instead is what made an evicted console
      // look like a session that had simply produced nothing.
      handleFetchFailure(failureOutcome(error), 'backfillFolded', transcriptSink(sessionId, 'backfillFolded', () => {
        // The fallback is a recovery, so an earlier backfill row must go with
        // it — otherwise a 500 followed by a 413 leaves the 500 on screen
        // above a transcript that is being served.
        clearFailureRow('backfillFolded', 'backfillFolded');
        openSessionStream(sessionId);
      }));
    });
}

/* ---------- turns / interactions columns ---------- */

function renderTurns() {
  const el = $('turn-list');
  el.innerHTML = '';
  const active = state.turns.filter((t) => t.state === 'awaiting-interaction' || t.state === 'running' || t.state === 'queued');
  const terminal = state.turns
    .filter((t) => t.state === 'completed' || t.state === 'failed' || t.state === 'cancelled')
    .sort((a, b) => Date.parse(b.finishedAt ?? b.enqueuedAt) - Date.parse(a.finishedAt ?? a.enqueuedAt))
    .slice(0, 8);
  const byId = new Map(state.sessions.map((s) => [s.sessionId, s]));
  for (const t of [...active, ...terminal]) {
    const s = byId.get(t.sessionId);
    const row = document.createElement('div');
    row.className = 'turn-row';
    row.dataset.state = t.state;
    row.dataset.s = t.state;
    const isLive = t.state === 'running' || t.state === 'awaiting-interaction';
    const dur = typeof t.durationMs === 'number' ? fmtElapsed(t.durationMs)
      : isLive && t.startedAt ? fmtElapsed(Date.now() - Date.parse(t.startedAt))
      : t.state === 'queued' ? fmtElapsed(Date.now() - Date.parse(t.enqueuedAt))
      : '—';
    const usage = usageSummary(t.usage);
    row.innerHTML = `
      <span class="tid">${esc(shortId(t.turnId))}</span>
      <span class="mid">
        <span class="dur" ${isLive && t.startedAt ? `data-tick="${Date.parse(t.startedAt)}"` : ''}>${dur}</span>
        ${usage ? `<span class="usage" title="engine-reported token usage">${usage}</span>` : ''}
      </span>
      <span class="prio">${esc(PRIO_LABEL[t.priority] ?? t.priority)}</span>
      <span class="sub">${esc(t.state)} · ${esc(t.engine)}${s ? ` · ${esc(sessionLabel(s))}` : ''}</span>
      <span class="bar"><i></i></span>`;
    el.appendChild(row);
  }
  $('turn-count').textContent =
    `${state.turns.filter((t) => t.state === 'running' || t.state === 'awaiting-interaction').length} running · ${state.turns.filter((t) => t.state === 'queued').length} queued`;
  if (state.turns.length === 0) el.innerHTML = '<div class="empty-hint">no turns yet</div>';
}

/* Read-only display (§1.2 non-goal: no answering from the console). */
function interactionSummary(ia) {
  const p = ia.payload;
  if (p === undefined || p === null) return `${ia.kind} · ${shortId(ia.interactionId)}`;
  if (typeof p === 'object') {
    if (ia.kind === 'permission') {
      // ACP session/request_permission: {tool, input, options, locations, kind}
      const tool = typeof p.tool === 'string' ? p.tool : 'tool';
      const where = p.input?.path ?? p.locations?.[0]?.path;
      const verbs = Array.isArray(p.options) ? p.options.map((o) => o?.name ?? o?.optionId).filter(Boolean).join(' / ') : '';
      return `${tool}${typeof where === 'string' ? ` · ${where}` : ''}${verbs ? ` — ${verbs}` : ''}`;
    }
    const question = p.question ?? p.questions?.[0]?.question ?? p.questions?.[0]?.header;
    if (typeof question === 'string' && question !== '') return question;
    const text = JSON.stringify(p);
    return text.length > 160 ? text.slice(0, 157) + '…' : text;
  }
  return String(p);
}

function renderInteractions() {
  const el = $('ia-list');
  el.innerHTML = '';
  const now = Date.now();
  const pending = state.interactions.filter((i) => i.state === 'pending');
  const settled = state.interactions.filter((i) => i.state !== 'pending');
  $('ia-count').textContent = `${pending.length} pending`;
  for (const ia of [...pending, ...settled.slice(0, 6)]) {
    const card = document.createElement('div');
    const isPending = ia.state === 'pending';
    card.className = 'interaction-card' + (isPending ? '' : ' settled');
    let ttl = esc(ia.state);
    let pct = 0;
    if (isPending && ia.expiresAt !== undefined) {
      const left = Date.parse(ia.expiresAt) - now;
      const total = Date.parse(ia.expiresAt) - Date.parse(ia.createdAt);
      ttl = left > 0 ? `TTL ${Math.ceil(left / 1000)}s` : 'expired';
      pct = total > 0 ? Math.max(0, Math.min(100, (left / total) * 100)) : 0;
    }
    card.innerHTML = `
      <div class="row1">
        <span class="ikind">${esc(ia.kind)}</span>
        <span class="ttl" ${isPending && ia.expiresAt !== undefined ? `data-ttl-until="${esc(ia.expiresAt)}" data-ttl-from="${esc(ia.createdAt)}"` : ''}>${ttl}</span>
      </div>
      <div class="what">${esc(interactionSummary(ia))}</div>
      <div class="ttl-bar"><i></i></div>
      <div class="ro-note">Read-only display — respond in the host session (§1.2 non-goal)</div>`;
    card.querySelector('.ttl-bar i').style.width = pct + '%';
    el.appendChild(card);
  }
  if (state.interactions.length === 0) el.innerHTML = '<div class="empty-hint">no interactions</div>';
}

/* ---------- topology view (§10.1) ---------- */

const TOPO_COL_W = 300;
const TOPO_ROW_H = 170;
const TOPO_X0 = 40;
const TOPO_Y0 = 40;

let topoDebounce = 0;

async function refreshTopology() {
  if (state.view !== 'topology') return;
  // The view is this read's second supersession axis: the operator can leave
  // topology while the request is in flight, and nothing bumps a generation
  // when they do, so an answer would otherwise render a graph behind the view
  // they left and clear its failure on the way out.
  const data = await pillRead('topology', () => api('/api/topology'), () => state.view === 'topology');
  if (data === undefined) return;
  renderTopology(data);
}

function scheduleTopologyRefresh() {
  if (state.view !== 'topology') return;
  clearTimeout(topoDebounce);
  topoDebounce = setTimeout(refreshTopology, 150);
}

function svgLine(cls, x1, y1, x2, y2, marker) {
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('class', `edge ${cls}`);
  line.setAttribute('x1', x1); line.setAttribute('y1', y1);
  line.setAttribute('x2', x2); line.setAttribute('y2', y2);
  if (marker) line.setAttribute('marker-end', `url(#${marker})`);
  return line;
}

function svgLabel(cls, x, y, text) {
  const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  label.setAttribute('class', `edge-label${cls ? ' ' + cls : ''}`);
  label.setAttribute('x', x); label.setAttribute('y', y);
  label.textContent = text;
  return label;
}

function renderTopology(data) {
  const inner = $('topo-inner');
  const g = $('edges-g');
  g.innerHTML = '';
  for (const node of inner.querySelectorAll('.topo-node, .topo-empty, .topo-truncated')) node.remove();
  const nodes = data.nodes ?? [];
  const edges = data.edges ?? [];
  // The graph is capped server-side once the registry holds more sessions than
  // it can draw. It says so; drawing the slice without saying so would present
  // a part of the run as the whole of it.
  if (data.truncated === true) {
    const notice = document.createElement('div');
    notice.className = 'topo-truncated';
    notice.textContent =
      `showing the ${nodes.length} most recently updated of ${Number(data.totalSessions) || nodes.length} sessions — edges are drawn among these only`;
    inner.appendChild(notice);
  }
  if (nodes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'topo-empty';
    empty.textContent = 'no sessions — the topology appears once workers exist';
    inner.appendChild(empty);
    return;
  }
  // Layout: one column per engine (first-seen order), nodes stacked by
  // creation time. Deterministic placement only — the view draws no
  // conclusions beyond it (§10.1).
  const byEngine = new Map();
  for (const node of [...nodes].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
    const col = byEngine.get(node.engine) ?? [];
    col.push(node);
    byEngine.set(node.engine, col);
  }
  const cols = [...byEngine.values()];
  const pos = new Map();
  cols.forEach((col, c) => col.forEach((node, r) => pos.set(node.sessionId, {
    x: TOPO_X0 + c * TOPO_COL_W,
    y: TOPO_Y0 + r * TOPO_ROW_H,
  })));
  const width = TOPO_X0 + cols.length * TOPO_COL_W;
  const height = TOPO_Y0 + Math.max(...cols.map((c) => c.length)) * TOPO_ROW_H + 60;
  inner.style.width = width + 'px';
  inner.style.height = height + 'px';
  const svg = $('topo-edges');
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);

  const center = (id) => {
    const p = pos.get(id);
    return p === undefined ? undefined : { x: p.x + 106, y: p.y + 45 };
  };

  // schedule_wait edges also tag the waiting node itself (elapsed + slots).
  const waitBySession = new Map();
  for (const edge of edges) {
    if (edge.type === 'schedule_wait') waitBySession.set(edge.sessionId, edge);
  }

  for (const edge of edges) {
    if (edge.type === 'fork') {
      const a = center(edge.from), b = center(edge.to);
      if (!a || !b) continue;
      g.appendChild(svgLine('edge-fork', a.x, a.y, b.x, b.y, 'arrow-fork'));
      g.appendChild(svgLabel('', (a.x + b.x) / 2, Math.min(a.y, b.y) - 12, 'fork'));
    } else if (edge.type === 'schedule_wait') {
      const waiter = center(edge.sessionId);
      if (!waiter) continue;
      let nearest;
      for (const holderId of edge.to ?? []) {
        const holder = center(holderId);
        if (!holder) continue;
        g.appendChild(svgLine('edge-wait', waiter.x, waiter.y, holder.x, holder.y));
        if (nearest === undefined || Math.hypot(holder.x - waiter.x, holder.y - waiter.y) < Math.hypot(nearest.x - waiter.x, nearest.y - waiter.y)) nearest = holder;
      }
      if (nearest !== undefined) {
        // Anchor a third of the way out from the waiter: clear of both nodes.
        const waited = typeof edge.waitedMs === 'number' ? fmtElapsed(edge.waitedMs) : '?';
        g.appendChild(svgLabel('wait',
          waiter.x + (nearest.x - waiter.x) * 0.35 + 10,
          waiter.y + (nearest.y - waiter.y) * 0.35 - 6,
          `${edge.engine} slot ${edge.occupied}/${edge.limit} · ${waited}`));
      }
    } else if (edge.type === 'cwd_overlap') {
      const members = (edge.sessions ?? []).map((id) => ({ id, c: center(id) })).filter((m) => m.c);
      for (let i = 1; i < members.length; i++) {
        g.appendChild(svgLine('edge-cwd', members[i - 1].c.x, members[i - 1].c.y, members[i].c.x, members[i].c.y));
      }
      if (members.length >= 2) {
        const mid = members[Math.floor(members.length / 2)].c;
        g.appendChild(svgLabel('', mid.x + 12, mid.y + 52, 'same cwd · hint only'));
      }
    } else if (edge.type === 'time') {
      const a = center(edge.from), b = center(edge.to);
      if (!a || !b) continue;
      g.appendChild(svgLine('edge-time', a.x, a.y, b.x, b.y, 'arrow-time'));
    }
  }

  for (const node of nodes) {
    const p = pos.get(node.sessionId);
    const el = document.createElement('div');
    el.className = 'topo-node' + (node.lineage === 'unknown' ? ' unknown' : '');
    el.dataset.s = node.state;
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    const badges = engineBadges(node.engine, node.verification, node.knownDefects);
    const wait = waitBySession.get(node.sessionId);
    el.innerHTML = `
      <div class="row1"><span class="state-dot"></span><span class="name">${esc(sessionLabel(node))}</span><span class="engine">${esc(node.engine)}</span></div>
      <div class="row2"><span class="state-chip">${esc(node.state)}</span>${typeof node.cwd === 'string' ? `<span class="cwd">${esc(node.cwd)}</span>` : ''}</div>
      ${badges ? `<div class="badges-row">${badges}</div>` : ''}
      ${node.lineage === 'unknown' ? '<div class="tag-line unknown-tag">? lineage unknown · record predates parent tracking</div>' : ''}
      ${wait ? `<div class="tag-line">⏳ waiting ${typeof wait.waitedMs === 'number' ? fmtElapsed(wait.waitedMs) : ''} · ${esc(wait.engine)} slot</div>` : ''}`;
    inner.appendChild(el);
  }
}

/* ---------- live updates ---------- */

let refreshDebounce = 0;

/* Transition frames carry ids + target states only, so a transition triggers
   a debounced re-fetch of the collections — the same derived view, refreshed
   (§5.3 state data is pulled, §5.2 pushes only the signal). */
function onTransition() {
  clearTimeout(refreshDebounce);
  refreshDebounce = setTimeout(refreshCollections, 120);
}

/* A bare catch that returned silently left the last good lists on screen
   looking current, which is exactly how an unreachable console read as a quiet
   one. Nothing retries on its own — this runs at startup and on a debounced
   transition — so with the console unreachable no transition arrives, and the
   label `pillRead` writes is all the operator gets. */
async function refreshCollections() {
  const answers = await pillRead('collections', () => Promise.all([
    api('/api/sessions'), api('/api/turns'), api('/api/interactions'),
  ]));
  if (answers === undefined) return;
  const [sessions, turns, interactions] = answers;
  state.sessions = sessions.sessions ?? [];
  state.turns = turns.turns ?? [];
  state.interactions = interactions.interactions ?? [];
  renderSessions();
  renderTurns();
  renderInteractions();
  if (state.activeSessionId !== null && !state.sessions.some((s) => s.sessionId === state.activeSessionId)) {
    closeSessionStream();
    state.selectEpoch += 1;
    state.activeSessionId = null;
    // The session is gone, not deleted-while-watched: no banner, and no folder
    // for a stream that no longer exists.
    resetTranscriptView({ folder: null, deleted: false });
    setTxView('transcript');
    $('tx-title').textContent = 'no session selected';
    clearResumeId();
  }
  if (state.activeSessionId === null && state.sessions.length > 0) selectSession(state.sessions[0].sessionId);
  scheduleTopologyRefresh();
}

function openInstanceStream() {
  const es = new EventSource('/api/stream');
  state.instanceStream = es;
  // Nothing closes the instance stream on purpose, so its suppression is
  // never marked; it exists because handleStreamError takes one per stream.
  const suppression = createSuppression();
  es.onopen = () => {
    setPillReconnecting(false);
    clearStreamPill('instanceStream');
    // The stream answering says the console is reachable, which is what the
    // instance read's failure was about — but not that *that route* works. So
    // this re-asks rather than clearing on the strength of a different
    // operation; `loadInstance` takes the label down only if the answer does.
    // It runs once at startup and this is its only other caller, so without
    // the re-ask its failure label would have no way down at all.
    if (state.instance === null) void loadInstance();
  };
  es.onerror = () => {
    // §10.0: the pill must distinguish the two, since saying "reconnecting"
    // for a browser that has stopped reconnecting is the defect itself.
    const rendered = handleStreamError(es, suppression, 'instance', pillSink('instanceStream'));
    // CONNECTING renders nothing through the sink because the browser is still
    // working on it — but the pill must say so, and it says so through the one
    // writer rather than beside it.
    if (rendered.render === 'none') setPillReconnecting(es.readyState === CONNECTING);
  };
  es.onmessage = (msg) => {
    let frame;
    try { frame = JSON.parse(msg.data); } catch { return; }
    if (frame.type === 'transition' || frame.type === 'engine_crash') onTransition(frame);
  };
}

/* ---------- theme / view / keyboard ---------- */

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('taskshuttle-console-theme', t); } catch (e) { /* storage may be disabled */ }
}

function setView(v) {
  state.view = v;
  document.body.classList.toggle('view-topo', v === 'topology');
  document.querySelectorAll('.view-tabs:not(.tx-tabs) .vt').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  if (v === 'topology') refreshTopology();
}

/* ---------- init ---------- */

async function init() {
  // §7.5 forbids the inline pre-paint script the prototype used, so the
  // persisted theme can only be applied when this deferred bundle runs — a
  // first-frame flash in the default theme is possible (console-v2 §4.7
  // records the compromise).
  try { setTheme(localStorage.getItem('taskshuttle-console-theme') || 'dark'); } catch (e) { /* default dark */ }
  $('tx-resume-copy').onclick = () => { void copyResumeId(); };
  $('theme-toggle').onclick = () =>
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  document.querySelectorAll('.view-tabs:not(.tx-tabs) .vt').forEach((b) => { b.onclick = () => setView(b.dataset.view); });
  document.querySelectorAll('.tx-tabs .vt').forEach((b) => { b.onclick = () => setTxView(b.dataset.txview); });

  const stream = streamEl();
  stream.addEventListener('scroll', () => { if (pinnedToBottom()) $('to-bottom').classList.remove('show'); });
  $('to-bottom').onclick = () => { stream.scrollTop = stream.scrollHeight; $('to-bottom').classList.remove('show'); };

  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key >= '1' && e.key <= '9') {
      const s = state.sessions[Number(e.key) - 1];
      if (s) selectSession(s.sessionId);
    }
    if (e.key === 'g' || e.key === 'G') { stream.scrollTop = stream.scrollHeight; }
    if (e.key === 't' || e.key === 'T') $('theme-toggle').click();
    if (e.key === 'v' || e.key === 'V') setView(state.view === 'topology' ? 'sessions' : 'topology');
  });

  // Duration / TTL ticking — pure re-render of derived labels, no data change.
  setInterval(() => {
    document.querySelectorAll('[data-tick]').forEach((el) => {
      el.textContent = fmtElapsed(Date.now() - Number(el.dataset.tick));
    });
    document.querySelectorAll('.elapsed').forEach((el) => {
      el.textContent = fmtElapsed(Date.now() - Number(el.dataset.start));
    });
    document.querySelectorAll('[data-ttl-until]').forEach((el) => {
      const left = Date.parse(el.dataset.ttlUntil) - Date.now();
      el.textContent = left > 0 ? `TTL ${Math.ceil(left / 1000)}s` : 'expired';
      const total = Date.parse(el.dataset.ttlUntil) - Date.parse(el.dataset.ttlFrom);
      const bar = el.closest('.interaction-card')?.querySelector('.ttl-bar i');
      if (bar && total > 0) bar.style.width = Math.max(0, Math.min(100, (left / total) * 100)) + '%';
    });
  }, 1000);

  await loadInstance();
  await refreshCollections();
  openInstanceStream();
  // Deep-link for the topology view (also used by headless screenshot checks).
  if (location.hash === '#topology') setView('topology');
}

init();
