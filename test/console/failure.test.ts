import { describe, expect, it } from 'vitest';

import type { FailureSink } from '../../packages/plugin/src/console/ui/failure.js';
import { classifyFailure, createRowLedger, handleFetchFailure, handleStreamError, createSuppression } from '../../packages/plugin/src/console/ui/failure.js';

/**
 * The client's failure-rendering contract (console-design §10.0: rendering
 * under ADR 0032, the row ledger and recovery under ADR 0036).
 *
 * The rule is a property, not a status code: a failure the client cannot
 * recover from must be rendered, and never presented as a pending reconnect.
 * GZH-44 is what happens when it is not — an evicted console rendered as
 * "reconnecting" with a blank pane and a clean browser console.
 *
 * The contract is split so that every decision is assertable without a DOM:
 * `classifyFailure` decides, and `handleFetchFailure` / `handleStreamError`
 * drive an injected sink. The other half — that a failure ever reaches a
 * decision — is `client-failure.test.ts`, which loads the shipped page in a
 * DOM and drives the real `app.js`; see the note at the end of this file.
 */

interface Recorded { readonly call: string; readonly reason?: string }

function recordingSink(): { calls: Recorded[]; sink: FailureSink } {
  const calls: Recorded[] = [];
  const make = (call: string) => (reason?: string) => { calls.push(reason === undefined ? { call } : { call, reason }); };
  return { calls, sink: { row: make('row'), pill: make('pill'), invalidated: make('invalidated'), rawFallback: make('rawFallback') } };
}

describe('classifyFailure: §10.0 outcome × operation', () => {
  it('413 on the folded backfill takes the raw-stream fallback, and only there', () => {
    expect(classifyFailure({ kind: 'status', status: 413 }, 'backfillFolded')).toEqual({ render: 'rawFallback' });
    expect(classifyFailure({ kind: 'status', status: 413 }, 'sessionRead').render).toBe('row');
  });

  it('404 on a session-scoped read is the invalidated banner, not an error row', () => {
    expect(classifyFailure({ kind: 'status', status: 404 }, 'sessionRead')).toEqual({ render: 'invalidated' });
    expect(classifyFailure({ kind: 'status', status: 404 }, 'backfillFolded')).toEqual({ render: 'invalidated' });
  });

  it('renders nothing for a 2xx that parsed', () => {
    for (const status of [200, 201, 202, 204, 206]) {
      for (const operation of ['backfillFolded', 'sessionRead', 'collections', 'topology', 'instance'] as const) {
        expect(classifyFailure({ kind: 'status', status }, operation)).toEqual({ render: 'none' });
      }
    }
  });

  // Every remaining cell of §10.0's matrix, rather than a sample: a classifier
  // that is right about 500 and wrong about 401 passes a sample.
  it.each([
    ['backfillFolded', 'row'], ['sessionRead', 'row'],
    ['collections', 'pill'], ['topology', 'pill'], ['instance', 'pill'],
  ] as const)('routes every non-recoverable outcome for %s to the %s', (operation, render) => {
    // 404 and 413 are deliberately absent from this list — they have their own
    // cases above, where the transcript operations treat them specially.
    for (const status of [400, 401, 402, 403, 405, 409, 500, 502, 503]) {
      const rendering = classifyFailure({ kind: 'status', status }, operation);
      expect(rendering.render).toBe(render);
      expect(rendering).toHaveProperty('reason');
      // A reason that names nothing renders a row saying nothing, which is the
      // silence this contract exists to end. §10.0 asks for the status in the
      // transcript row's text; the pill only has to distinguish CONNECTING
      // from CLOSED, so requiring a number there would fail a correct generic
      // message.
      if (render === 'row') expect(String((rendering as { reason: string }).reason)).toMatch(new RegExp(String(status)));
      else expect(String((rendering as { reason: string }).reason).length).toBeGreaterThan(0);
    }
    // 404 and 413 are special only for the transcript operations. On a
    // collection they are ordinary failures, and a classifier that invalidates
    // the session on a 404 from /api/turns would be wrong in a way the skip
    // above would never catch.
    if (render === 'pill') {
      for (const status of [404, 413]) {
        expect(classifyFailure({ kind: 'status', status }, operation).render).toBe('pill');
      }
    }
    // A network failure carries no status, and a malformed 2xx body carries a
    // successful one, so a classifier keyed on status alone cannot type either.
    for (const kind of ['network', 'malformed', 'aborted'] as const) {
      const rendering = classifyFailure({ kind }, operation);
      expect(rendering.render).toBe(render);
      expect(String((rendering as { reason: string }).reason).length).toBeGreaterThan(0);
    }
  });
});

describe('handleFetchFailure: the classification reaches a sink', () => {
  it('calls the sink the classification names, and nothing else', () => {
    const cases: Array<[Parameters<typeof classifyFailure>[0], Parameters<typeof classifyFailure>[1], string]> = [
      [{ kind: 'status', status: 413 }, 'backfillFolded', 'rawFallback'],
      [{ kind: 'status', status: 404 }, 'sessionRead', 'invalidated'],
      [{ kind: 'status', status: 500 }, 'sessionRead', 'row'],
      [{ kind: 'network' }, 'collections', 'pill'],
    ];
    for (const [outcome, operation, expected] of cases) {
      const { calls, sink } = recordingSink();
      handleFetchFailure(outcome, operation, sink);
      expect(calls.map((entry) => entry.call)).toEqual([expected]);
    }
  });

  it('writes nothing for a success', () => {
    const { calls, sink } = recordingSink();
    handleFetchFailure({ kind: 'status', status: 200 }, 'collections', sink);
    expect(calls).toEqual([]);
  });
});

/**
 * The EventSource half. `onerror` exposes neither status nor body, so the
 * client does not infer one: per the WHATWG server-sent-events specification
 * the browser publishes its own recoverability verdict as `readyState`.
 */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = FakeEventSource.CONNECTING;
  onerror: (() => void) | null = null;
  close(): void { this.readyState = FakeEventSource.CLOSED; }
  /** Drives the real handler the way a browser would. */
  fail(readyState: number): void { this.readyState = readyState; this.onerror?.(); }
}

describe('handleStreamError: readyState is the verdict', () => {
  it('renders on CLOSED and leaves the reconnecting indicator on CONNECTING', () => {
    for (const [readyState, expected] of [[FakeEventSource.CLOSED, ['row']], [FakeEventSource.CONNECTING, []]] as const) {
      const stream = new FakeEventSource();
      const suppression = createSuppression();
      const { calls, sink } = recordingSink();
      stream.onerror = () => handleStreamError(stream, suppression, 'session', sink);
      stream.fail(readyState);
      expect(calls.map((entry) => entry.call)).toEqual(expected);
    }
  });

  it('renders nothing for a deliberate close, which also lands in CLOSED', () => {
    const stream = new FakeEventSource();
    const suppression = createSuppression();
    const { calls, sink } = recordingSink();
    stream.onerror = () => handleStreamError(stream, suppression, 'session', sink);
    suppression.markDeliberate();
    stream.close();
    stream.onerror();
    expect(calls).toEqual([]);
  });

  // The session-swap race the per-instance flag exists for: with one shared
  // flag the old stream's asynchronous onerror consumes the suppression that
  // belonged to its replacement, and a genuine terminal failure renders
  // nothing — the original defect, reintroduced by the fix for it.
  it('suppression belongs to the stream that was closed, not to the next one', () => {
    const oldStream = new FakeEventSource();
    const newStream = new FakeEventSource();
    const oldSuppression = createSuppression();
    const newSuppression = createSuppression();
    const { calls, sink } = recordingSink();
    oldStream.onerror = () => handleStreamError(oldStream, oldSuppression, 'session', sink);
    newStream.onerror = () => handleStreamError(newStream, newSuppression, 'session', sink);

    // The order matters, and the obvious one does not reproduce the bug: if
    // the old stream's error is delivered first, a shared flag is consumed
    // before the replacement fails and the replacement still renders. The
    // race is the other order — the browser queues the closed stream's error
    // task, the swap happens, the new stream fails, and only then does the old
    // task run. Both orders are asserted.
    // Separate sinks: with one shared sink a global "suppress the next error"
    // flag passes either ordering, because the aggregate is a single row
    // whichever stream produced it. What must be true is that the row came
    // from the stream that actually failed.
    const oldSink = recordingSink();
    const newSink = recordingSink();
    oldStream.onerror = () => handleStreamError(oldStream, oldSuppression, 'session', oldSink.sink);
    newStream.onerror = () => handleStreamError(newStream, newSuppression, 'session', newSink.sink);
    oldSuppression.markDeliberate();
    oldStream.close();
    newStream.fail(FakeEventSource.CLOSED); // the real terminal failure lands first
    oldStream.onerror();                    // the queued error from the closed stream
    expect(newSink.calls.map((entry) => entry.call)).toEqual(['row']);
    expect(oldSink.calls).toEqual([]);

    const first = new FakeEventSource();
    const second = new FakeEventSource();
    const firstSuppression = createSuppression();
    const secondSuppression = createSuppression();
    const firstSink = recordingSink();
    const secondSink = recordingSink();
    first.onerror = () => handleStreamError(first, firstSuppression, 'session', firstSink.sink);
    second.onerror = () => handleStreamError(second, secondSuppression, 'session', secondSink.sink);
    firstSuppression.markDeliberate();
    first.close();
    first.onerror();
    second.fail(FakeEventSource.CLOSED);
    expect(secondSink.calls.map((entry) => entry.call)).toEqual(['row']);
    expect(firstSink.calls).toEqual([]);
  });

  it('routes the instance-level stream to the pill, where the defect would otherwise survive', () => {
    const stream = new FakeEventSource();
    const { calls, sink } = recordingSink();
    stream.onerror = () => handleStreamError(stream, createSuppression(), 'instance', sink);
    stream.fail(FakeEventSource.CLOSED);
    expect(calls.map((entry) => entry.call)).toEqual(['pill']);
  });
});

/**
 * The ledger behind the shared row. §10.0 keys a row by operation, so several
 * reads share one; taking it down on any single success is how a fix for a
 * stale row reintroduces the silence it was fixing.
 */
describe('createRowLedger: a shared row outlives one reader recovering', () => {
  it('holds the row while another reader is still failed', () => {
    const ledger = createRowLedger();
    ledger.fail('sessionRead', 'text:10');
    ledger.fail('sessionRead', 'diff:42');
    // The interleaving the row-per-operation key makes possible: two reads of
    // one session in flight, one fails, the other succeeds.
    expect(ledger.recover('sessionRead', 'diff:42')).toBe(false);
    expect(ledger.recover('sessionRead', 'text:10')).toBe(true);
  });

  it('takes the row down when the reader that failed is the one that recovers', () => {
    const ledger = createRowLedger();
    ledger.fail('sessionRead', 'text:10');
    expect(ledger.recover('sessionRead', 'text:10')).toBe(true);
  });

  it('keeps operations apart, since each has its own row', () => {
    const ledger = createRowLedger();
    ledger.fail('sessionRead', 'text:10');
    ledger.fail('backfillFolded', 'backfillFolded');
    expect(ledger.recover('backfillFolded', 'backfillFolded')).toBe(true);
    // That recovery left the other row's reader alone.
    expect(ledger.recover('sessionRead', 'text:10')).toBe(true);
  });

  it('is idempotent, since a read can succeed without ever having failed', () => {
    const ledger = createRowLedger();
    expect(ledger.recover('sessionRead', 'text:10')).toBe(true);
    ledger.fail('sessionRead', 'text:10');
    expect(ledger.recover('sessionRead', 'text:10')).toBe(true);
    expect(ledger.recover('sessionRead', 'text:10')).toBe(true);
  });

  it('forgets everything on clear, which is what selecting another session does', () => {
    const ledger = createRowLedger();
    ledger.fail('sessionRead', 'text:10');
    ledger.fail('sessionRead', 'diff:42');
    ledger.clear();
    expect(ledger.recover('sessionRead', 'text:10')).toBe(true);
  });
});

/**
 * How the wiring is proved: `client-failure.test.ts` loads the shipped page in
 * a DOM, stubs only `fetch` and `EventSource`, imports `app.js` and asserts
 * what an operator would see. This file stops at the decisions, which is what
 * it can assert exactly; a source-text check for the handler names used to sit
 * here and was both too strict — a named handler failed it — and too weak, since
 * `if (false) handleStreamError()` passed it.
 */
