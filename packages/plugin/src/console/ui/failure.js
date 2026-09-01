/**
 * The console's failure-rendering rule (console-design §10.0, ADR 0032): a
 * failure the client cannot recover from is rendered, and never presented as a
 * pending reconnect. GZH-44 is what the absence of this module looked like — a
 * console evicted out of its own cookie slot showing "reconnecting" over a
 * blank pane, with a clean browser console.
 *
 * Nothing here touches the DOM or any global. `classifyFailure` is pure; the
 * two handlers decide and then call a `sink` of four writers the caller
 * supplies, and `createSuppression` owns one boolean. That is what makes every
 * row of §10.0's table assertable without a DOM — the wiring, that a failure
 * ever reaches a decision, is proved separately by loading the shipped page in
 * one.
 */

/**
 * `EventSource.readyState` values (WHATWG server-sent-events). Named here
 * rather than read off the global: this module is unit-tested in an
 * environment that has no `EventSource`, and the numbers are specified.
 */
export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSED = 2;

/** Operations whose failures have a transcript pane to write into (§10.0). */
const PANE_OPERATIONS = new Set(['backfillFolded', 'sessionRead']);

/** What each operation is called in a row or pill the operator reads. */
const OPERATION_LABEL = {
  backfillFolded: 'transcript backfill',
  sessionRead: 'transcript read',
  collections: 'session list refresh',
  topology: 'topology refresh',
  instance: 'instance read',
};

/** How a non-status outcome reads; none of them carries a status to quote. */
const OUTCOME_LABEL = {
  network: 'the console did not answer',
  malformed: 'the answer was not readable',
  aborted: 'the answer ended early',
};

/**
 * Decide what an operation's outcome must render (console-design §10.0).
 *
 * Keyed on the pair rather than on the status alone: a network failure carries
 * no status and a malformed body carries a successful one, while `413` and
 * `404` mean something specific only for the transcript operations.
 *
 * @param {{kind: 'status', status: number} | {kind: 'network'|'malformed'|'aborted'}} outcome
 * @param {'backfillFolded'|'sessionRead'|'collections'|'topology'|'instance'} operation
 * @returns {{render: 'none'|'rawFallback'|'invalidated'} | {render: 'row'|'pill', reason: string}}
 */
export function classifyFailure(outcome, operation) {
  const pane = PANE_OPERATIONS.has(operation);
  const where = pane ? 'row' : 'pill';
  const what = OPERATION_LABEL[operation] ?? operation;
  if (outcome.kind === 'status') {
    const status = outcome.status;
    if (status >= 200 && status < 300) return { render: 'none' };
    if (pane) {
      // The one recoverable case, and the reason the raw-stream fallback
      // exists: a folded page too large to compose still pages as raw frames.
      if (status === 413 && operation === 'backfillFolded') return { render: 'rawFallback' };
      if (status === 404) return { render: 'invalidated' };
    }
    return { render: where, reason: `${what} failed: HTTP ${status}` };
  }
  return { render: where, reason: `${what} failed: ${OUTCOME_LABEL[outcome.kind] ?? outcome.kind}` };
}

/**
 * Classify a fetch outcome and drive the one sink writer it names.
 *
 * @param {Parameters<typeof classifyFailure>[0]} outcome
 * @param {Parameters<typeof classifyFailure>[1]} operation
 * @param {{row: (reason: string) => void, pill: (reason: string) => void, invalidated: () => void, rawFallback: () => void}} sink
 * @returns {ReturnType<typeof classifyFailure>} the classification, for a caller that must also branch on it.
 */
export function handleFetchFailure(outcome, operation, sink) {
  const rendering = classifyFailure(outcome, operation);
  if (rendering.render === 'row') sink.row(rendering.reason);
  else if (rendering.render === 'pill') sink.pill(rendering.reason);
  else if (rendering.render === 'invalidated') sink.invalidated();
  else if (rendering.render === 'rawFallback') sink.rawFallback();
  return rendering;
}

/**
 * One stream's "this close was ours" flag.
 *
 * Per instance, never shared: a deliberate `close()` also lands in `CLOSED`,
 * and with one flag for the whole page the old stream's asynchronous `onerror`
 * consumes the flag belonging to its replacement — after which a genuine
 * terminal failure renders nothing, which is the defect this file exists for.
 *
 * @returns {{markDeliberate: () => void, deliberate: boolean}}
 */
export function createSuppression() {
  let deliberate = false;
  return {
    markDeliberate() { deliberate = true; },
    get deliberate() { return deliberate; },
  };
}

/**
 * The ledger behind the shared failure rows.
 *
 * §10.0 keys a row by `{ sessionId, operation }`, so several reads of one
 * session share a row: a run's full text, one diff's content, the diff index.
 * Sharing the row is intended; sharing the right to remove it is not. A bare
 * clear on any success takes down a notice whose own failure is still true —
 * two reads in flight, one fails, the other succeeds, and the operator is told
 * nothing about the first. That is the silence this file exists to end,
 * reintroduced by the fix for its opposite.
 *
 * So each failure is remembered under the read that produced it, and the row
 * survives until none is left.
 *
 * @returns {{fail: (operation: string, reader: string) => void, recover: (operation: string, reader: string) => boolean, clear: () => void}}
 *   `recover` is true only when the row may now be taken down.
 */
export function createRowLedger() {
  const failed = new Map();
  return {
    fail(operation, reader) {
      let readers = failed.get(operation);
      if (readers === undefined) { readers = new Set(); failed.set(operation, readers); }
      readers.add(reader);
    },
    recover(operation, reader) {
      const readers = failed.get(operation);
      // No ledger entry means nothing is known to be failed, so a row that
      // exists anyway may go: a caller that renders without recording is a
      // caller this must not strand.
      if (readers === undefined) return true;
      readers.delete(reader);
      if (readers.size > 0) return false;
      failed.delete(operation);
      return true;
    },
    clear() { failed.clear(); },
  };
}

/**
 * Handle an `EventSource` error. `onerror` exposes neither status nor body, so
 * nothing is inferred: the browser has already decided whether it will retry
 * and publishes that as `readyState` — `CONNECTING` is an honest "reconnecting",
 * `CLOSED` is terminal and renders. The one `CLOSED` that does not render is
 * the caller's own `close()`, which lands there too and is told apart only by
 * the suppression flag having been marked first.
 *
 * @param {{readyState: number}} stream - the failing EventSource.
 * @param {ReturnType<typeof createSuppression>} suppression - that stream's own flag.
 * @param {'session'|'instance'} scope - a session stream has a pane; the instance stream has only the pill.
 * @param {Parameters<typeof handleFetchFailure>[2]} sink
 * @returns {{render: 'none'|'row'|'pill'}} what was rendered, so a caller can label a retry itself.
 */
export function handleStreamError(stream, suppression, scope, sink) {
  if (stream.readyState !== CLOSED) return { render: 'none' };
  if (suppression.deliberate) return { render: 'none' };
  if (scope === 'instance') {
    sink.pill('SSE · disconnected');
    return { render: 'pill' };
  }
  sink.row('live transcript stream closed and will not reconnect');
  return { render: 'row' };
}
