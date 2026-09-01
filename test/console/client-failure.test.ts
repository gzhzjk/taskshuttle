// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CONSOLE-042's client half, and §10.0's rendering contract, driven through
 * the **real** `app.js` in a DOM.
 *
 * The sink-level tests in `failure.test.ts` prove the decisions. They cannot
 * prove the decision is ever reached: an implementation that exports a perfect
 * classifier and leaves `onerror` empty passes every one of them, and that is
 * precisely GZH-44 — a console evicted out of its cookie slot, rendering
 * "reconnecting" over a blank pane with a clean browser console. So this file
 * loads the shipped page, stubs only the two things a browser would supply
 * (`fetch` and `EventSource`), imports the module, and asserts what a person
 * looking at the screen would see.
 */

const SESSION = 's-0000-1111';

interface StubbedFetch {
  (input: string): Promise<Response>;
  /** Routes that should fail, by path prefix, with the status to answer. */
  fail: Map<string, number>;
  /** Every path requested, so a case can wait for one rather than for a tick. */
  calls: string[];
}

let streams: FakeEventSource[] = [];

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = FakeEventSource.CONNECTING;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) { streams.push(this); }
  close(): void { this.closed = true; this.readyState = FakeEventSource.CLOSED; }
  /** What the browser does when it gives up: CLOSED, then the error event. */
  failTerminally(): void { this.readyState = FakeEventSource.CLOSED; this.onerror?.(); }
  /** What it does between retries: still CONNECTING when the error fires. */
  failTransiently(): void { this.readyState = FakeEventSource.CONNECTING; this.onerror?.(); }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) as unknown as Response;
}

function stubFetch(): StubbedFetch {
  const fail = new Map<string, number>();
  const impl = (async (input: string) => {
    impl.calls.push(input);
    for (const [prefix, status] of fail) {
      if (input.startsWith(prefix)) return jsonResponse({ error: 'refused' }, status);
    }
    if (input.startsWith('/api/instance')) return jsonResponse({ instanceId: 'i-1', createdAt: '2026-01-01T00:00:00.000Z', host: 'darwin', alive: true, engines: [], config: {} });
    if (input.startsWith('/api/sessions/')) return jsonResponse({ events: [], runs: [], highWatermark: 0 });
    if (input.startsWith('/api/sessions')) return jsonResponse({ sessions: [{ sessionId: SESSION, engine: 'codex', state: 'idle', createdAt: '2026-01-01T00:00:00.000Z', cwd: '/tmp/x', name: 'w' }] });
    if (input.startsWith('/api/turns')) return jsonResponse({ turns: [] });
    if (input.startsWith('/api/interactions')) return jsonResponse({ interactions: [] });
    if (input.startsWith('/api/topology')) return jsonResponse({ nodes: [], edges: [] });
    return jsonResponse({});
  }) as StubbedFetch;
  impl.fail = fail;
  impl.calls = [];
  return impl;
}

async function loadConsole(failures: Record<string, number> = {}): Promise<StubbedFetch> {
  const html = await readFile(join(process.cwd(), 'packages', 'plugin', 'src', 'console', 'ui', 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.slice(html.indexOf('<head>'));
  const fetchStub = stubFetch();
  for (const [prefix, status] of Object.entries(failures)) fetchStub.fail.set(prefix, status);
  vi.stubGlobal('fetch', fetchStub);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  // app.js is the shipped browser module and has no type declarations — it is
  // imported for its side effects, which is the whole point of this file.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error -- untyped browser module, imported to run it
  await import('../../packages/plugin/src/console/ui/app.js');
  // init() is async and fires several awaits before it opens its stream.
  await vi.waitFor(() => { if (streams.length === 0) throw new Error('the instance stream never opened'); });
  return fetchStub;
}

const failureRows = (): Element[] => [...document.querySelectorAll('.failure-row')];

/**
 * The instance stream, by what it is rather than by where it lands. It is in
 * fact `streams[0]` today — `init()` opens it before the auto-selected
 * session's, which only arrives an await later inside `backfillSession`'s
 * `then` — so a case taking `streams[0]` is correct right now and would keep
 * passing on the wrong stream if that ordering ever changed. Naming it costs
 * nothing and does not depend on the order.
 */
function instanceStream(): FakeEventSource {
  const found = streams.find((stream) => !stream.url.includes('sessionId='));
  if (found === undefined) throw new Error('the instance stream never opened');
  return found;
}

/**
 * The session stream the console is currently reading: the last one that is
 * still live. Neither half is incidental — `refreshCollections` auto-selects
 * the only session before the test clicks it, and the stream a click opens
 * arrives an await later than the click, so both "the first" and "the last"
 * can name a stream that is already closed and suppressed. Driving one of
 * those proves nothing, and does it silently.
 *
 * Liveness is `readyState`, not the `closed` flag: `closed` records a
 * `close()` call, while a stream that failed terminally is `CLOSED` without
 * anyone having called it. Filtering on the flag would hand back a dead stream
 * and the case would pass on nothing.
 */
async function currentSessionStream(): Promise<FakeEventSource> {
  return vi.waitFor(() => {
    const live = streams.filter((stream) => stream.url.includes('sessionId=') && stream.readyState !== FakeEventSource.CLOSED);
    const found = live[live.length - 1];
    if (found === undefined) throw new Error('no live session stream');
    return found;
  });
}

beforeEach(() => { streams = []; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Clicks the session card the console rendered, the way an operator would. */
async function selectSession(): Promise<void> {
  const button = await vi.waitFor(() => {
    const found = [...document.querySelectorAll('button')].find((element) => (element.textContent ?? '').includes('w') || (element.textContent ?? '').includes(SESSION.slice(0, 6)));
    if (found === undefined) throw new Error('no session card was rendered');
    return found;
  });
  button.click();
}

/**
 * The supersession guards. Two refreshes overlap whenever a debounced one
 * starts while an earlier is still in flight, and the older answer must then
 * neither render its stale data nor clear a failure the current one recorded.
 * Driving it needs the two responses released in the wrong order, which is
 * what the deferred-promise stub below is for.
 */
describe('a superseded refresh neither renders nor reports (§10.0)', () => {
  /** A promise whose settlement this test controls. */
  function deferred<T>(): { promise: Promise<T>; settle: (value: T) => void } {
    let settle: (value: T) => void = () => undefined;
    const promise = new Promise<T>((resolve) => { settle = resolve; });
    return { promise, settle };
  }

  const sessionCard = (): string => document.getElementById('session-list')?.textContent ?? '';

  // The instance read is the one that used to have no guard at all, and its
  // repeat caller tests `state.instance === null` — set after an await, so it
  // is a pre-check and not a mutex. Two overlapping retries landing in the
  // wrong order used to leave the loser's failure recorded while the winner had
  // already set `state.instance`, after which nothing would call it again and
  // the pill stayed offline for the life of the page.
  it('overlapping instance retries cannot wedge the pill', async () => {
    const fetchStub = await loadConsole({ '/api/instance': 503 });
    const label = document.getElementById('stream-label');
    await vi.waitFor(() => { if (!(label?.textContent ?? '').includes('503')) throw new Error(`pill says ${String(label?.textContent)}`); });

    const held = deferred<Response>();
    let instanceReads = 0;
    vi.stubGlobal('fetch', (input: string) => {
      if (input.startsWith('/api/instance')) {
        instanceReads += 1;
        // The first retry is held and will succeed late; the second answers at
        // once and fails, and is the one that owns the verdict.
        if (instanceReads === 1) return held.promise;
        return jsonResponse({ error: 'refused' }, 500);
      }
      return fetchStub(input);
    });

    const stream = instanceStream();
    stream.readyState = FakeEventSource.OPEN;
    stream.onopen?.();                       // retry A — held
    await vi.waitFor(() => { if (instanceReads < 1) throw new Error('retry A never started'); });
    stream.onopen?.();                       // retry B — supersedes A
    await vi.waitFor(() => { if (instanceReads < 2) throw new Error('retry B never started'); });
    held.settle(jsonResponse({ instanceId: 'i-1', createdAt: '2026-01-01T00:00:00.000Z', host: 'darwin', alive: true, engines: [], config: {} }));
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    // B owns the verdict, so the pill reports B's failure — and, crucially, the
    // read is still retryable, so a later success can still clear it.
    expect(label?.textContent).toContain('500');
    fetchStub.fail.clear();
    vi.stubGlobal('fetch', fetchStub);
    stream.onopen?.();
    await vi.waitFor(() => { if (label?.textContent !== 'SSE · live') throw new Error(`the pill is wedged at ${String(label?.textContent)}`); });
  });

  it('a late collections answer does not overwrite the current one', async () => {
    const fetchStub = await loadConsole();
    const first = deferred<Response>();
    let sessionReads = 0;
    vi.stubGlobal('fetch', (input: string) => {
      if (input.startsWith('/api/sessions?') || input === '/api/sessions') {
        sessionReads += 1;
        // The first refresh is held; the second answers at once, with the
        // name the operator should end up seeing.
        if (sessionReads === 1) return first.promise;
        return jsonResponse({ sessions: [{ sessionId: SESSION, engine: 'codex', state: 'idle', createdAt: '2026-01-01T00:00:00.000Z', cwd: '/tmp/x', name: 'newer' }] });
      }
      return fetchStub(input);
    });

    const transition = { data: JSON.stringify({ type: 'transition' }) };
    instanceStream().onmessage?.(transition);
    await vi.waitFor(() => { if (sessionReads < 1) throw new Error('the first refresh never started'); }, { timeout: 2000 });
    instanceStream().onmessage?.(transition);
    await vi.waitFor(() => { if (sessionReads < 2) throw new Error('the second refresh never started'); }, { timeout: 2000 });
    await vi.waitFor(() => { if (!sessionCard().includes('newer')) throw new Error('the second refresh has not rendered'); });

    // Now the superseded one answers, with what the console looked like before.
    first.settle(jsonResponse({ sessions: [{ sessionId: SESSION, engine: 'codex', state: 'idle', createdAt: '2026-01-01T00:00:00.000Z', cwd: '/tmp/x', name: 'stale' }] }));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(sessionCard()).toContain('newer');
    expect(sessionCard()).not.toContain('stale');
  });

  // The view is a second way for a topology answer to be superseded, and
  // nothing bumps the generation when the operator leaves — so without the
  // view check a late answer renders a graph behind the view they left, and
  // clears its failure on the way out.
  it('a topology answer that arrives after the operator left renders nothing', async () => {
    const fetchStub = await loadConsole();
    const held = deferred<Response>();
    let topologyReads = 0;
    vi.stubGlobal('fetch', (input: string) => {
      if (input.startsWith('/api/topology')) { topologyReads += 1; return held.promise; }
      return fetchStub(input);
    });
    const tab = (name: string): HTMLElement => {
      const found = [...document.querySelectorAll('.view-tabs:not(.tx-tabs) .vt')].find((element) => (element as HTMLElement).dataset['view'] === name);
      if (found === undefined) throw new Error(`no ${name} tab`);
      return found as HTMLElement;
    };
    tab('topology').click();
    await vi.waitFor(() => { if (topologyReads === 0) throw new Error('the topology read never started'); });
    tab('sessions').click();

    held.settle(jsonResponse({ nodes: [{ sessionId: SESSION, engine: 'codex', state: 'idle' }], edges: [] }));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    // `renderTopology` draws into `#topo-inner`; a superseded answer must draw
    // nothing there, and must not report health on its way out either.
    expect(document.querySelectorAll('#topo-inner .topo-node')).toHaveLength(0);
  });

  // The catch side of the same rule, which the two cases around it do not
  // reach: a superseded read must not REPORT either. Without it a refresh that
  // lost the race writes a failure label over a console the winner has just
  // found healthy.
  it('a late collections failure does not report over the current success', async () => {
    const fetchStub = await loadConsole();
    const label = document.getElementById('stream-label');
    const first = deferred<Response>();
    let sessionReads = 0;
    vi.stubGlobal('fetch', (input: string) => {
      if (input.startsWith('/api/sessions?') || input === '/api/sessions') {
        sessionReads += 1;
        if (sessionReads === 1) return first.promise;
        return jsonResponse({ sessions: [] });
      }
      return fetchStub(input);
    });

    const transition = { data: JSON.stringify({ type: 'transition' }) };
    instanceStream().onmessage?.(transition);
    await vi.waitFor(() => { if (sessionReads < 1) throw new Error('the first refresh never started'); }, { timeout: 2000 });
    instanceStream().onmessage?.(transition);
    await vi.waitFor(() => { if (sessionReads < 2) throw new Error('the second refresh never started'); }, { timeout: 2000 });

    // The superseded one fails, late.
    first.settle(jsonResponse({ error: 'refused' }, 503));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(label?.textContent).not.toContain('503');
  });

  it('a late collections answer does not clear the current failure', async () => {
    const fetchStub = await loadConsole();
    const label = document.getElementById('stream-label');
    const first = deferred<Response>();
    let sessionReads = 0;
    vi.stubGlobal('fetch', (input: string) => {
      if (input.startsWith('/api/sessions?') || input === '/api/sessions') {
        sessionReads += 1;
        if (sessionReads === 1) return first.promise;
        return jsonResponse({ error: 'refused' }, 503);
      }
      return fetchStub(input);
    });

    const transition = { data: JSON.stringify({ type: 'transition' }) };
    instanceStream().onmessage?.(transition);
    await vi.waitFor(() => { if (sessionReads < 1) throw new Error('the first refresh never started'); }, { timeout: 2000 });
    instanceStream().onmessage?.(transition);
    // The second refresh fails and owns the pill.
    await vi.waitFor(() => { if (!(label?.textContent ?? '').includes('503')) throw new Error(`pill says ${String(label?.textContent)}`); }, { timeout: 2000 });

    // The superseded one succeeds, late. It must not report health over a
    // failure the current refresh recorded after it started.
    first.settle(jsonResponse({ sessions: [] }));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(label?.textContent).toContain('503');
  });
});

describe('the shipped console renders unrecoverable failures (§10.0)', () => {
  it('opens its instance stream through EventSource', async () => {
    await loadConsole();
    expect(instanceStream().url).toBe('/api/stream');
  });

  // The defect itself: a terminal stream failure must not read as
  // "reconnecting". Asserted positively, because the page ships with
  // `SSE · connecting` in that span and nothing has written to it yet — so
  // "does not contain reconnect" was already true before any handler ran, and
  // a client with no `handleStreamError` call at all passed it.
  it('a terminally closed stream is rendered, not shown as reconnecting', async () => {
    await loadConsole();
    const pill = document.getElementById('stream-label');
    instanceStream().failTerminally();
    await vi.waitFor(() => { if (pill?.textContent !== 'SSE · disconnected') throw new Error(`pill says ${String(pill?.textContent)}`); });
    expect(pill?.textContent).toBe('SSE · disconnected');
    expect(document.getElementById('stream-pill')?.classList.contains('offline')).toBe(true);
  });

  it('a transiently failing stream still reads as reconnecting', async () => {
    await loadConsole();
    const pill = document.getElementById('stream-label');
    instanceStream().failTransiently();
    expect(pill?.textContent).toBe('SSE · reconnecting');
  });

  // The fetch half: a transcript read that cannot be recovered must leave a
  // row where the transcript would have been, not an empty pane.
  it('renders a row in the transcript pane when a transcript read fails', async () => {
    const fetchStub = await loadConsole();
    fetchStub.fail.set(`/api/sessions/${SESSION}`, 403);
    await selectSession();
    await vi.waitFor(() => { if (failureRows().length === 0) throw new Error('no failure row was rendered'); });
    expect(failureRows()[0]!.textContent).toContain('403');
  });

  // One row per failure, not one per retry: a stalled console must not
  // accumulate a wall of them.
  it('updates the existing row rather than appending another', async () => {
    const fetchStub = await loadConsole();
    fetchStub.fail.set(`/api/sessions/${SESSION}`, 500);
    await selectSession();
    await vi.waitFor(() => { if (failureRows().length === 0) throw new Error('no failure row'); });
    await selectSession();
    await selectSession();
    expect(failureRows()).toHaveLength(1);
  });

  // §10.0 asks that the row outlive the view that was mounted when it arrived.
  // This asserts the observable half — switching to the diff view and back
  // still shows it; the state-holding half is the re-selection case above,
  // where the pane is genuinely emptied and the row comes back.
  it('the row survives a switch to the diff view and back', async () => {
    const fetchStub = await loadConsole();
    // Only the events route, so the diff view's own read succeeds: with the
    // broader prefix the diff tab issued its own failure under the same row
    // key and re-appended the detached node, and the case could not tell a row
    // that survived from one that was rebuilt.
    fetchStub.fail.set(`/api/sessions/${SESSION}/events`, 502);
    await selectSession();
    await vi.waitFor(() => { if (failureRows().length === 0) throw new Error('no failure row'); });
    const tab = (name: string): HTMLElement => {
      const found = [...document.querySelectorAll('.tx-tabs .vt')].find((element) => (element as HTMLElement).dataset['txview'] === name);
      if (found === undefined) throw new Error(`no ${name} tab`);
      return found as HTMLElement;
    };
    tab('diff').click();
    tab('transcript').click();
    expect(failureRows()).toHaveLength(1);
    expect(failureRows()[0]!.textContent).toContain('502');
  });

  // A row that outlives the failure states a failure over a working pane,
  // which is the same lie as the blank pane, told the other way round.
  //
  // The route this fails is the folded backfill, so what it covers is
  // `backfillFolded` recovery — a path that predates the per-reader ledger and
  // would pass without it. It is kept because it is the only one of the three
  // recovery paths driven end to end through the real client; the ledger's own
  // rule is asserted in `failure.test.ts`, and the stream path below is the
  // case that reds without the fix.
  it('clears the backfill row once the read succeeds again', async () => {
    const fetchStub = await loadConsole();
    fetchStub.fail.set(`/api/sessions/${SESSION}`, 500);
    await selectSession();
    await vi.waitFor(() => { if (failureRows().length === 0) throw new Error('no failure row'); });
    // Re-select while it is STILL failing, so the clear below is reached from
    // a state where the row is genuinely up rather than from a fresh pane.
    // Note what this does NOT prove: a client that drops the row at selection
    // start still satisfies it, because the repeated failure puts the row back
    // before `waitFor` looks. That property is caught by "updates the existing
    // row rather than appending another", which counts rows synchronously
    // after the click and sees the gap.
    await selectSession();
    await vi.waitFor(() => { if (failureRows().length === 0) throw new Error('the row did not come back after a re-selection that failed again'); });
    fetchStub.fail.clear();
    await selectSession();
    await vi.waitFor(() => { if (failureRows().length > 0) throw new Error('the row outlived the failure'); });
    expect(failureRows()).toHaveLength(0);
  });

  // The stream half of the same rule: a stream that reconnects successfully
  // must take its own failure row down with it.
  it('clears the stream row when the stream comes back', async () => {
    await loadConsole();
    const stream = await currentSessionStream();
    stream.failTerminally();
    await vi.waitFor(() => { if (failureRows().length === 0) throw new Error('a terminal session stream rendered nothing'); });
    stream.readyState = FakeEventSource.CONNECTING;
    stream.onopen?.();
    expect(failureRows()).toHaveLength(0);
  });

  // `close()` does not retract a message task the browser has already queued,
  // and the frame's own sessionId cannot catch it: it is the id this stream
  // was opened with. Only the stream's identity can.
  it('ignores a frame from a stream that is no longer the current one', async () => {
    await loadConsole();
    const first = await currentSessionStream();
    await selectSession(); // closes `first` and opens its replacement
    await vi.waitFor(() => { if (!first.closed) throw new Error('the first stream was not closed'); });
    // The frame the closed stream had already queued. Delivering it must not
    // reach the pane the replacement now owns.
    first.onmessage?.({ data: JSON.stringify({ type: 'invalidated', sessionId: SESSION }) });
    expect(document.getElementById('invalidated')?.classList.contains('show')).toBe(false);
  });

  // The pill's half of the recovery rule, in two halves that are the whole
  // rule between them. The instance read runs once at startup and would never
  // run again, so if nothing re-asked, its failure label could never come
  // down — and if the stream opening simply took it down, the console would
  // report itself healthy while that route was still failing and the header
  // still showed its placeholders. So the stream opening re-asks.
  it('leaves the instance failure up while the read is still failing', async () => {
    const fetchStub = await loadConsole({ '/api/instance': 503 });
    const label = document.getElementById('stream-label');
    await vi.waitFor(() => { if (!(label?.textContent ?? '').includes('503')) throw new Error(`pill says ${String(label?.textContent)}`); });

    const instanceStream = streams[0]!;
    instanceStream.readyState = FakeEventSource.OPEN;
    instanceStream.onopen?.();
    // The retry runs and fails again, so the label must stand.
    await vi.waitFor(() => {
      if (!fetchStub.calls.slice(1).some((path) => path.startsWith('/api/instance'))) throw new Error('the instance read was never retried');
    });
    await new Promise((settle) => { setTimeout(settle, 0); });
    expect(label?.textContent).toContain('503');
  });

  it('takes the instance failure down when the retry succeeds', async () => {
    const fetchStub = await loadConsole({ '/api/instance': 503 });
    const label = document.getElementById('stream-label');
    await vi.waitFor(() => { if (!(label?.textContent ?? '').includes('503')) throw new Error(`pill says ${String(label?.textContent)}`); });

    fetchStub.fail.clear();
    const instanceStream = streams[0]!;
    instanceStream.readyState = FakeEventSource.OPEN;
    instanceStream.onopen?.();
    await vi.waitFor(() => { if (label?.textContent !== 'SSE · live') throw new Error(`pill says ${String(label?.textContent)}`); });
    expect(label?.textContent).toBe('SSE · live');
  });

  // The pill is one surface for several operations, so it needs the same rule
  // the rows have: one operation recovering may not erase another's failure.
  // Without it a console with a broken topology reports itself healthy as soon
  // as any list refresh succeeds.
  it('one pane-less operation recovering does not erase another\'s failure', async () => {
    const fetchStub = await loadConsole({ '/api/turns': 503, '/api/topology': 500 });
    const label = document.getElementById('stream-label');
    // The collections refresh at startup fails and owns the pill.
    await vi.waitFor(() => { if (!(label?.textContent ?? '').includes('503')) throw new Error(`pill says ${String(label?.textContent)}`); });

    // The stream is open, so the pill's other guard is not what blocks the
    // clear below — the ledger is the only thing that can.
    streams[0]!.readyState = FakeEventSource.OPEN;

    const tab = (name: string): HTMLElement => {
      const found = [...document.querySelectorAll('.view-tabs:not(.tx-tabs) .vt')].find((element) => (element as HTMLElement).dataset['view'] === name);
      if (found === undefined) throw new Error(`no ${name} tab`);
      return found as HTMLElement;
    };
    tab('topology').click();
    await vi.waitFor(() => { if (!(label?.textContent ?? '').includes('500')) throw new Error(`pill says ${String(label?.textContent)}`); });

    // Topology recovers; collections has not. Waiting on the request rather
    // than on a tick: if the refresh never ran, the assertion below would hold
    // for the wrong reason.
    fetchStub.fail.delete('/api/topology');
    const before = fetchStub.calls.length;
    tab('sessions').click();
    tab('topology').click();
    await vi.waitFor(() => {
      if (!fetchStub.calls.slice(before).some((path) => path.startsWith('/api/topology'))) throw new Error('the topology refresh was never issued');
    });
    // One more turn of the loop, so its success handler has run.
    await new Promise((settle) => { setTimeout(settle, 0); });
    // The property is that the console does not report itself healthy while
    // something is still failed. It is NOT that the label names the operation
    // that is still broken: the pill is one line and shows whichever failure
    // wrote last, so here it still names topology. That is a real limit of a
    // single-line indicator and is left as one rather than papered over with a
    // priority ordering nothing has asked for.
    expect(label?.textContent).not.toBe('SSE · live');
    expect(document.getElementById('stream-pill')?.classList.contains('offline')).toBe(true);
  });

  // An invalidated session must stay invalidated: work still in flight for it
  // belongs to the view the banner replaced, and a folded backfill resolving
  // afterwards would render transcript rows over the banner and open a stream
  // for a session the server has said is gone. The banner arrives here the way
  // it can while a backfill is pending — a session-scoped read answering 404,
  // which §10.0 routes to the banner rather than to a row.
  it('a backfill still in flight cannot render over the invalidated banner', async () => {
    const fetchStub = await loadConsole();
    await selectSession();
    fetchStub.fail.set(`/api/sessions/${SESSION}/diffs`, 404);

    let release: (value: Response) => void = () => undefined;
    const held = new Promise<Response>((settle) => { release = settle; });
    let heldRequests = 0;
    vi.stubGlobal('fetch', (input: string) => {
      if (input.includes('projection=folded')) { heldRequests += 1; return held; }
      return fetchStub(input);
    });
    await selectSession();
    // Counted, not assumed. If a future `selectSession` short-circuits on the
    // already-selected session, no backfill is ever in flight, `release`
    // settles a promise nobody awaits, and both assertions below still hold —
    // the case would become a tautology without saying so.
    await vi.waitFor(() => { if (heldRequests === 0) throw new Error('no backfill was in flight'); });

    const diffTab = [...document.querySelectorAll('.tx-tabs .vt')].find((element) => (element as HTMLElement).dataset['txview'] === 'diff');
    (diffTab as HTMLElement).click();
    await vi.waitFor(() => { if (!(document.getElementById('invalidated')?.classList.contains('show') ?? false)) throw new Error('no invalidated banner'); });

    release(jsonResponse({ runs: [{ seqFrom: 1, seqTo: 1, kind: 'agent', text: 'late' }], highWatermark: 1 }));
    await new Promise((settle) => { setTimeout(settle, 0); });
    expect(document.getElementById('invalidated')?.classList.contains('show')).toBe(true);
    expect(document.getElementById('stream')?.textContent ?? '').not.toContain('late');
  });

  // A close the client performed itself must not be rendered as a failure.
  // This drove the *instance* stream until now, where a failure goes to the
  // pill and can never produce a row — so the assertion was satisfied by every
  // possible implementation, including one with no suppression at all. The
  // rule lives on the session stream, whose close goes through `closeStream`.
  // MAJOR: the pill had a ledgered writer and an unledgered one, and the pair
  // could wedge — a transient "reconnecting" written outside the ledger could
  // not be taken back by the reader that owned it, so the pill stayed offline
  // over a stream that had come back. It is one computed writer now, and this
  // is the case that would have caught the wedge.
  it('the pill returns to live after a transient reconnect', async () => {
    await loadConsole();
    const label = document.getElementById('stream-label');
    const stream = instanceStream();
    stream.failTransiently();
    expect(label?.textContent).toBe('SSE · reconnecting');
    stream.readyState = FakeEventSource.OPEN;
    stream.onopen?.();
    await vi.waitFor(() => { if (label?.textContent !== 'SSE · live') throw new Error(`pill says ${String(label?.textContent)}`); });
    expect(document.getElementById('stream-pill')?.classList.contains('offline')).toBe(false);
  });

  // The precedence half, and the one that needs a second outstanding failure
  // to see: an operation that is still broken outranks a reconnect that has
  // finished. What it does NOT do is discriminate a single line — the pill is
  // computed from state now, so "reconnecting over a connected stream" is
  // unreachable by construction rather than by a check that could be deleted.
  // The line-level guard is the case above, which reds if `onopen` stops
  // clearing the reconnecting flag.
  it('a reconnect that completes never leaves the pill saying reconnecting', async () => {
    const fetchStub = await loadConsole({ '/api/topology': 500 });
    const label = document.getElementById('stream-label');
    const tab = (name: string): HTMLElement => {
      const found = [...document.querySelectorAll('.view-tabs:not(.tx-tabs) .vt')].find((element) => (element as HTMLElement).dataset['view'] === name);
      if (found === undefined) throw new Error(`no ${name} tab`);
      return found as HTMLElement;
    };
    // A topology failure that nothing will retry: leaving the view means no
    // further request is ever issued for it.
    tab('topology').click();
    await vi.waitFor(() => { if (!(label?.textContent ?? '').includes('500')) throw new Error(`pill says ${String(label?.textContent)}`); });
    tab('sessions').click();

    const stream = instanceStream();
    stream.failTransiently();
    stream.readyState = FakeEventSource.OPEN;
    stream.onopen?.();
    await new Promise((settle) => { setTimeout(settle, 0); });
    // The stream is back, so "reconnecting" is false whatever else is wrong.
    expect(label?.textContent).not.toBe('SSE · reconnecting');
    // And topology is still broken, so "live" would be false too.
    expect(label?.textContent).toContain('500');
    expect(fetchStub.calls.filter((path) => path.startsWith('/api/topology'))).toHaveLength(1);
  });

  // A dead stream's late `onopen` must not take down the row belonging to the
  // stream that replaced it — the same identity rule `onmessage` follows.
  it('a superseded stream opening does not clear the current stream row', async () => {
    await loadConsole();
    const first = await currentSessionStream();
    first.failTerminally();
    await vi.waitFor(() => { if (failureRows().length === 0) throw new Error('the terminal stream rendered nothing'); });
    await selectSession(); // opens the replacement
    await vi.waitFor(async () => { if ((await currentSessionStream()) === first) throw new Error('no replacement yet'); });
    first.readyState = FakeEventSource.CONNECTING;
    first.onopen?.();
    expect(failureRows()).toHaveLength(1);
  });

  // The banner owns "this session is gone", so the stream goes with it. This
  // path never receives the server's own `invalidated` frame — the banner came
  // from a 404 on a different read — so nothing else would close it, and a
  // stream left open holds a maxConsoleStreams slot for a session nothing will
  // read again.
  it('closes the session stream when a read invalidates the session', async () => {
    const fetchStub = await loadConsole();
    await selectSession();
    const stream = await currentSessionStream();
    expect(stream.closed).toBe(false);

    fetchStub.fail.set(`/api/sessions/${SESSION}/diffs`, 404);
    const diffTab = [...document.querySelectorAll('.tx-tabs .vt')].find((element) => (element as HTMLElement).dataset['txview'] === 'diff');
    (diffTab as HTMLElement).click();
    await vi.waitFor(() => { if (!(document.getElementById('invalidated')?.classList.contains('show') ?? false)) throw new Error('no invalidated banner'); });
    expect(stream.closed).toBe(true);
  });

  // The row's mirror defect: several reads share one row, so a read that
  // succeeds must say so under its OWN id. `loadDiffLines` can succeed without
  // fetching — a sibling entry at the same seq populates the cache — and that
  // path left the failed reader outstanding, holding a row up over a pane that
  // was rendering the diff correctly.
  it('a failed diff expansion can be retried, and the retry takes its row down', async () => {
    const fetchStub = await loadConsole();
    const seq = 7;
    const entries = [
      { seq, path: 'a.ts', part: 0, added: 1, removed: 0, origin: 'engine' },
      { seq, path: 'a.ts', part: 1, added: 1, removed: 0, origin: 'engine' },
    ];
    let expansions = 0;
    vi.stubGlobal('fetch', (input: string) => {
      if (input.includes('/diffs')) return jsonResponse({ diffs: entries, hasMore: false });
      // The single-event expansion: the first attempt fails, the retry succeeds.
      if (input.includes(`afterSeq=${seq - 1}&toSeq=${seq}`)) {
        expansions += 1;
        if (expansions === 1) return jsonResponse({ error: 'refused' }, 500);
        return jsonResponse({ events: [{ seq, update: { sessionUpdate: 'tool_call_update', rawInput: { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }, { oldText: 'p', newText: 'q' }] } } }] });
      }
      return fetchStub(input);
    });

    await selectSession();
    const diffTab = [...document.querySelectorAll('.tx-tabs .vt')].find((element) => (element as HTMLElement).dataset['txview'] === 'diff');
    (diffTab as HTMLElement).click();
    const heads = await vi.waitFor(() => {
      const found = [...document.querySelectorAll('#diff-stream .diff-head')];
      if (found.length < 2) throw new Error(`only ${found.length} diff rows rendered`);
      return found as HTMLElement[];
    });

    heads[0]!.click(); // fails, and renders the row
    await vi.waitFor(() => { if (failureRows().length === 0) throw new Error('the failed expansion rendered nothing'); });
    heads[0]!.click(); // closes
    heads[0]!.click(); // re-opens: the retry the failure has to leave possible
    await vi.waitFor(() => { if (expansions < 2) throw new Error('the failed expansion was never retried'); });
    await vi.waitFor(() => { if (failureRows().length > 0) throw new Error('the row outlived the read that recovered'); });
    expect(failureRows()).toHaveLength(0);
  });

  // The pill is one surface for several operations, so it needs the same rule
  // the rows have: one operation recovering may not erase another's failure.
  // Without it a console with a broken topology reports itself healthy as soon
  // as any list refresh succeeds.
  it('one pane-less operation recovering does not erase another\'s failure', async () => {
    const fetchStub = await loadConsole({ '/api/turns': 503, '/api/topology': 500 });
    const label = document.getElementById('stream-label');
    // The collections refresh at startup fails and owns the pill.
    await vi.waitFor(() => { if (!(label?.textContent ?? '').includes('503')) throw new Error(`pill says ${String(label?.textContent)}`); });

    // The stream is open, so the pill's other guard is not what blocks the
    // clear below — the ledger is the only thing that can.
    streams[0]!.readyState = FakeEventSource.OPEN;

    const tab = (name: string): HTMLElement => {
      const found = [...document.querySelectorAll('.view-tabs:not(.tx-tabs) .vt')].find((element) => (element as HTMLElement).dataset['view'] === name);
      if (found === undefined) throw new Error(`no ${name} tab`);
      return found as HTMLElement;
    };
    tab('topology').click();
    await vi.waitFor(() => { if (!(label?.textContent ?? '').includes('500')) throw new Error(`pill says ${String(label?.textContent)}`); });

    // Topology recovers; collections has not. Waiting on the request rather
    // than on a tick: if the refresh never ran, the assertion below would hold
    // for the wrong reason.
    fetchStub.fail.delete('/api/topology');
    const before = fetchStub.calls.length;
    tab('sessions').click();
    tab('topology').click();
    await vi.waitFor(() => {
      if (!fetchStub.calls.slice(before).some((path) => path.startsWith('/api/topology'))) throw new Error('the topology refresh was never issued');
    });
    // One more turn of the loop, so its success handler has run.
    await new Promise((settle) => { setTimeout(settle, 0); });
    // The property is that the console does not report itself healthy while
    // something is still failed. It is NOT that the label names the operation
    // that is still broken: the pill is one line and shows whichever failure
    // wrote last, so here it still names topology. That is a real limit of a
    // single-line indicator and is left as one rather than papered over with a
    // priority ordering nothing has asked for.
    expect(label?.textContent).not.toBe('SSE · live');
    expect(document.getElementById('stream-pill')?.classList.contains('offline')).toBe(true);
  });

  // An invalidated session must stay invalidated: work still in flight for it
  // belongs to the view the banner replaced, and a folded backfill resolving
  // afterwards would render transcript rows over the banner and open a stream
  // for a session the server has said is gone. The banner arrives here the way
  // it can while a backfill is pending — a session-scoped read answering 404,
  // which §10.0 routes to the banner rather than to a row.
  it('a backfill still in flight cannot render over the invalidated banner', async () => {
    const fetchStub = await loadConsole();
    await selectSession();
    fetchStub.fail.set(`/api/sessions/${SESSION}/diffs`, 404);

    let release: (value: Response) => void = () => undefined;
    const held = new Promise<Response>((settle) => { release = settle; });
    let heldRequests = 0;
    vi.stubGlobal('fetch', (input: string) => {
      if (input.includes('projection=folded')) { heldRequests += 1; return held; }
      return fetchStub(input);
    });
    await selectSession();
    // Counted, not assumed. If a future `selectSession` short-circuits on the
    // already-selected session, no backfill is ever in flight, `release`
    // settles a promise nobody awaits, and both assertions below still hold —
    // the case would become a tautology without saying so.
    await vi.waitFor(() => { if (heldRequests === 0) throw new Error('no backfill was in flight'); });

    const diffTab = [...document.querySelectorAll('.tx-tabs .vt')].find((element) => (element as HTMLElement).dataset['txview'] === 'diff');
    (diffTab as HTMLElement).click();
    await vi.waitFor(() => { if (!(document.getElementById('invalidated')?.classList.contains('show') ?? false)) throw new Error('no invalidated banner'); });

    release(jsonResponse({ runs: [{ seqFrom: 1, seqTo: 1, kind: 'agent', text: 'late' }], highWatermark: 1 }));
    await new Promise((settle) => { setTimeout(settle, 0); });
    expect(document.getElementById('invalidated')?.classList.contains('show')).toBe(true);
    expect(document.getElementById('stream')?.textContent ?? '').not.toContain('late');
  });

  // A close the client performed itself must not be rendered as a failure.
  // This drove the *instance* stream until now, where a failure goes to the
  // pill and can never produce a row — so the assertion was satisfied by every
  // possible implementation, including one with no suppression at all. The
  // rule lives on the session stream, whose close goes through `closeStream`.
  // MAJOR: the pill had a ledgered writer and an unledgered one, and the pair
  // could wedge — a transient "reconnecting" written outside the ledger could
  // not be taken back by the reader that owned it, so the pill stayed offline
  // over a stream that had come back. It is one computed writer now, and this
  // is the case that would have caught the wedge.
  it('the pill returns to live after a transient reconnect', async () => {
    await loadConsole();
    const label = document.getElementById('stream-label');
    const stream = instanceStream();
    stream.failTransiently();
    expect(label?.textContent).toBe('SSE · reconnecting');
    stream.readyState = FakeEventSource.OPEN;
    stream.onopen?.();
    await vi.waitFor(() => { if (label?.textContent !== 'SSE · live') throw new Error(`pill says ${String(label?.textContent)}`); });
    expect(document.getElementById('stream-pill')?.classList.contains('offline')).toBe(false);
  });

  // The precedence half, and the one that needs a second outstanding failure
  // to see: an operation that is still broken outranks a reconnect that has
  // finished. What it does NOT do is discriminate a single line — the pill is
  // computed from state now, so "reconnecting over a connected stream" is
  // unreachable by construction rather than by a check that could be deleted.
  // The line-level guard is the case above, which reds if `onopen` stops
  // clearing the reconnecting flag.
  it('a reconnect that completes never leaves the pill saying reconnecting', async () => {
    const fetchStub = await loadConsole({ '/api/topology': 500 });
    const label = document.getElementById('stream-label');
    const tab = (name: string): HTMLElement => {
      const found = [...document.querySelectorAll('.view-tabs:not(.tx-tabs) .vt')].find((element) => (element as HTMLElement).dataset['view'] === name);
      if (found === undefined) throw new Error(`no ${name} tab`);
      return found as HTMLElement;
    };
    // A topology failure that nothing will retry: leaving the view means no
    // further request is ever issued for it.
    tab('topology').click();
    await vi.waitFor(() => { if (!(label?.textContent ?? '').includes('500')) throw new Error(`pill says ${String(label?.textContent)}`); });
    tab('sessions').click();

    const stream = instanceStream();
    stream.failTransiently();
    stream.readyState = FakeEventSource.OPEN;
    stream.onopen?.();
    await new Promise((settle) => { setTimeout(settle, 0); });
    // The stream is back, so "reconnecting" is false whatever else is wrong.
    expect(label?.textContent).not.toBe('SSE · reconnecting');
    // And topology is still broken, so "live" would be false too.
    expect(label?.textContent).toContain('500');
    expect(fetchStub.calls.filter((path) => path.startsWith('/api/topology'))).toHaveLength(1);
  });

  // A dead stream's late `onopen` must not take down the row belonging to the
  // stream that replaced it — the same identity rule `onmessage` follows.
  it('a superseded stream opening does not clear the current stream row', async () => {
    await loadConsole();
    const first = await currentSessionStream();
    first.failTerminally();
    await vi.waitFor(() => { if (failureRows().length === 0) throw new Error('the terminal stream rendered nothing'); });
    await selectSession(); // opens the replacement
    await vi.waitFor(async () => { if ((await currentSessionStream()) === first) throw new Error('no replacement yet'); });
    first.readyState = FakeEventSource.CONNECTING;
    first.onopen?.();
    expect(failureRows()).toHaveLength(1);
  });

  // The banner owns "this session is gone", so the stream goes with it. This
  // path never receives the server's own `invalidated` frame — the banner came
  // from a 404 on a different read — so nothing else would close it, and a
  // stream left open holds a maxConsoleStreams slot for a session nothing will
  // read again.
  it('closes the session stream when a read invalidates the session', async () => {
    const fetchStub = await loadConsole();
    await selectSession();
    const stream = await currentSessionStream();
    expect(stream.closed).toBe(false);

    fetchStub.fail.set(`/api/sessions/${SESSION}/diffs`, 404);
    const diffTab = [...document.querySelectorAll('.tx-tabs .vt')].find((element) => (element as HTMLElement).dataset['txview'] === 'diff');
    (diffTab as HTMLElement).click();
    await vi.waitFor(() => { if (!(document.getElementById('invalidated')?.classList.contains('show') ?? false)) throw new Error('no invalidated banner'); });
    expect(stream.closed).toBe(true);
  });

  // The row's mirror defect: several reads share one row, so a read that
  // succeeds must say so under its OWN id. `loadDiffLines` can succeed without
  // fetching — a sibling entry at the same seq populates the cache — and that
  // path left the failed reader outstanding, holding a row up over a pane that
  // was rendering the diff correctly.
  it('a failed diff expansion can be retried, and the retry takes its row down', async () => {
    const fetchStub = await loadConsole();
    const seq = 7;
    const entries = [
      { seq, path: 'a.ts', part: 0, added: 1, removed: 0, origin: 'engine' },
      { seq, path: 'a.ts', part: 1, added: 1, removed: 0, origin: 'engine' },
    ];
    let expansions = 0;
    vi.stubGlobal('fetch', (input: string) => {
      if (input.includes('/diffs')) return jsonResponse({ diffs: entries, hasMore: false });
      // The single-event expansion: the first attempt fails, the retry succeeds.
      if (input.includes(`afterSeq=${seq - 1}&toSeq=${seq}`)) {
        expansions += 1;
        if (expansions === 1) return jsonResponse({ error: 'refused' }, 500);
        return jsonResponse({ events: [{ seq, update: { sessionUpdate: 'tool_call_update', rawInput: { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }, { oldText: 'p', newText: 'q' }] } } }] });
      }
      return fetchStub(input);
    });

    await selectSession();
    const diffTab = [...document.querySelectorAll('.tx-tabs .vt')].find((element) => (element as HTMLElement).dataset['txview'] === 'diff');
    (diffTab as HTMLElement).click();
    const heads = await vi.waitFor(() => {
      const found = [...document.querySelectorAll('#diff-stream .diff-head')];
      if (found.length < 2) throw new Error(`only ${found.length} diff rows rendered`);
      return found as HTMLElement[];
    });

    heads[0]!.click(); // fails, and renders the row
    await vi.waitFor(() => { if (failureRows().length === 0) throw new Error('the failed expansion rendered nothing'); });
    heads[0]!.click(); // closes
    heads[0]!.click(); // re-opens: the retry the failure has to leave possible
    await vi.waitFor(() => { if (expansions < 2) throw new Error('the failed expansion was never retried'); });
    await vi.waitFor(() => { if (failureRows().length > 0) throw new Error('the row outlived the read that recovered'); });
    expect(failureRows()).toHaveLength(0);
  });

  // Guard 1 — cache-hit row clearing (app.js:1629): a sibling entry at the same
  // seq can populate `state.diffContent` after this entry's expansion failed, so
  // re-expanding this entry is a cache hit — no fetch — and the row must come
  // down on that path.
  it('a sibling cache hit clears the failed reader without refetching', async () => {
    const fetchStub = await loadConsole();
    const seq = 9;
    const entries = [
      { seq, path: 'a.ts', part: 0, added: 1, removed: 0, origin: 'reconstructed' },
      { seq, path: 'a.ts', part: 1, added: 1, removed: 0, origin: 'reconstructed' },
    ];
    let expansions = 0;
    vi.stubGlobal('fetch', (input: string) => {
      if (input.includes('/diffs')) return jsonResponse({ diffs: entries, hasMore: false });
      if (input.includes(`/events?afterSeq=${seq - 1}&toSeq=${seq}`)) {
        expansions += 1;
        if (expansions === 1) return jsonResponse({ error: 'refused' }, 500);
        return jsonResponse({ events: [{ seq, update: { sessionUpdate: 'tool_call_update', rawInput: { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }, { oldText: 'p', newText: 'q' }] } } }] });
      }
      return fetchStub(input);
    });
    await selectSession();
    const diffTab = [...document.querySelectorAll('.tx-tabs .vt')].find((element) => (element as HTMLElement).dataset['txview'] === 'diff');
    (diffTab as HTMLElement).click();
    const heads = await vi.waitFor(() => {
      const found = [...document.querySelectorAll('#diff-stream .diff-head')];
      if (found.length < 2) throw new Error(`only ${found.length} diff rows rendered`);
      return found as HTMLElement[];
    });
    heads[0]!.click();
    await vi.waitFor(() => { if (failureRows().length === 0) throw new Error('no failure row'); });
    heads[0]!.click();
    heads[1]!.click();
    await vi.waitFor(() => { if (expansions < 2) throw new Error('sibling not yet fetched'); });
    // Give render a tick so cache is guaranteed set
    await new Promise((r) => setTimeout(r, 0));
    expect(failureRows()).toHaveLength(1);
    // Reopen the failed one — must be cache hit (no third fetch) and clear row
    const before = expansions;
    heads[0]!.click();
    heads[0]!.click();
    await vi.waitFor(() => { if (failureRows().length !== 0) throw new Error('cache-hit did not clear row'); });
    expect(expansions).toBe(before);
    expect(failureRows()).toHaveLength(0);
  });

  // Guard 2 — generation guard (app.js:1854): superseded walk's catch must check generation
  it('a superseded diff-index walk does not leave a failure row or partial flag', async () => {
    const fetchStub = await loadConsole();
    const D1 = { origin: 'reconstructed', part: 0, path: 'a.ts', oldText: 'OLD_1', newText: 'NEW_1' };
    const toolCallId = 'call-x';
    vi.stubGlobal('fetch', (input: string) => {
      if (input.includes('projection=folded')) return jsonResponse({ runs: [{ kind: 'tool', toolCallId, title: 'Edit', toolKind: 'edit', status: 'completed', seqFrom: 2, seqTo: 3, diffs: [D1] }], highWatermark: 3 });
      if (input.includes('/diffs')) return jsonResponse({ diffs: [], hasMore: false });
      return fetchStub(input);
    });
    await selectSession();
    await vi.waitFor(() => { if (!document.querySelector('#stream .k-tool_call')) throw new Error('backfill row not rendered'); });
    let releaseWalk1!: (v: Response) => void;
    const heldWalk1 = new Promise<Response>((r) => { releaseWalk1 = r; });
    let diffCalls = 0;
    vi.stubGlobal('fetch', (input: string) => {
      if (input.includes('/diffs')) { diffCalls += 1; if (diffCalls === 1) return heldWalk1; return jsonResponse({ diffs: [], hasMore: false }); }
      if (input.includes('projection=folded')) return jsonResponse({ runs: [{ kind: 'tool', toolCallId, title: 'Edit', toolKind: 'edit', status: 'completed', seqFrom: 2, seqTo: 3, diffs: [D1] }], highWatermark: 3 });
      return fetchStub(input);
    });
    const diffTab = [...document.querySelectorAll('.tx-tabs .vt')].find((e) => (e as HTMLElement).dataset['txview'] === 'diff') as HTMLElement;
    const txTab = [...document.querySelectorAll('.tx-tabs .vt')].find((e) => (e as HTMLElement).dataset['txview'] === 'transcript') as HTMLElement;
    diffTab.click();
    await vi.waitFor(() => { if (diffCalls < 1) throw new Error('walk1 never started'); });
    const stream = await currentSessionStream();
    // Native diff supersedes rebuilt → gone [D1] unlocated → initialized=false
    stream.onmessage?.({ data: JSON.stringify({ type: 'event', sessionId: SESSION, seq: 10, event: { seq: 10, ts: 10000, sessionId: SESSION, engineId: 'codex', update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'diff', path: 'a.ts', oldText: 'OLD_NATIVE', newText: 'NEW_NATIVE' }] } } }) });
    await new Promise((r) => setTimeout(r, 0));
    txTab.click();
    diffTab.click();
    await vi.waitFor(() => { if (diffCalls < 2) throw new Error('walk2 never started'); });
    await new Promise((r) => setTimeout(r, 100));
    releaseWalk1(jsonResponse({ error: 'refused' }, 500));
    await new Promise((r) => setTimeout(r, 0));
    expect(failureRows()).toHaveLength(0);
    expect(document.querySelector('.diff-partial')).toBeNull();
  });

  // A deleted session's rows can never come down on their own: no read of it
  // will ever succeed. Left in place they sit above the banner that says the
  // session is gone, asserting a failure nobody can resolve.
  it('drops the failure rows when the session is invalidated', async () => {
    const fetchStub = await loadConsole();
    fetchStub.fail.set(`/api/sessions/${SESSION}/events`, 500);
    await selectSession();
    await vi.waitFor(() => { if (failureRows().length === 0) throw new Error('no failure row'); });

    fetchStub.fail.set(`/api/sessions/${SESSION}/diffs`, 404);
    const diffTab = [...document.querySelectorAll('.tx-tabs .vt')].find((element) => (element as HTMLElement).dataset['txview'] === 'diff');
    (diffTab as HTMLElement).click();
    await vi.waitFor(() => { if (!(document.getElementById('invalidated')?.classList.contains('show') ?? false)) throw new Error('no invalidated banner'); });
    expect(failureRows()).toHaveLength(0);
  });

  it('a deliberate close renders nothing', async () => {
    await loadConsole();
    const stream = await currentSessionStream();
    await selectSession(); // closeSessionStream marks the suppression, then closes
    await vi.waitFor(() => { if (!stream.closed) throw new Error('the stream was not closed'); });
    const before = failureRows().length;
    stream.onerror?.(); // the error the browser had already queued for it
    expect(failureRows()).toHaveLength(before);
  });
});
