// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * CONSOLE-048: the transcript head shows the engine's own session id (GZH-80).
 *
 * Driven through the real `app.js` in a DOM, because every decision here is
 * the client's. The server's half is already done and unchanged: in full mode
 * it sends the first event's `update` — `_meta` included — and in degraded
 * mode it sends `{seq, ts, byteLen}` and nothing else.
 *
 * What the cases have to pin is the second state as hard as the first. A row
 * that shows a placeholder, or TaskShuttle's own session id, when the engine
 * never reported one is worse than a blank row: it looks resumable and is not.
 */

const SESSION = 's-0000-1111';
const SESSION_META_KEY = 'runskein.dev/sessionMeta';

let streams: FakeEventSource[] = [];

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = FakeEventSource.CONNECTING;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(readonly url: string) { streams.push(this); }
  close(): void { this.readyState = FakeEventSource.CLOSED; }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }) as unknown as Response;
}

/** One `session_info_update`, shaped the way the store's `readMeta` reads it. */
function firstEvent(meta: unknown): Record<string, unknown> {
  return {
    seq: 1,
    ts: 1,
    sessionId: SESSION,
    engineId: 'codex',
    update: { sessionUpdate: 'session_info_update', ...(meta === undefined ? {} : { _meta: { [SESSION_META_KEY]: meta } }) },
  };
}

interface Loaded { paths: string[] }

/**
 * @param eventsFor - answers the events route; `raw` is the single-event
 *   projection the resume row reads, `folded` the pane's own backfill.
 */
async function loadConsole(eventsFor: (path: string) => unknown): Promise<Loaded> {
  const html = await readFile(join(process.cwd(), 'packages', 'plugin', 'src', 'console', 'ui', 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.slice(html.indexOf('<head>'));
  const paths: string[] = [];
  vi.stubGlobal('fetch', async (input: string) => {
    paths.push(input);
    if (input.startsWith('/api/instance')) return jsonResponse({ instanceId: 'i-1', createdAt: '2026-01-01T00:00:00.000Z', host: 'darwin', alive: true, engines: [], config: {} });
    if (input.startsWith(`/api/sessions/${SESSION}/events`)) return jsonResponse(eventsFor(input));
    if (input.startsWith('/api/sessions')) return jsonResponse({ sessions: [{ sessionId: SESSION, engine: 'codex', state: 'idle', createdAt: '2026-01-01T00:00:00.000Z', cwd: '/tmp/x', name: 'w' }] });
    return jsonResponse({ turns: [], interactions: [], nodes: [], edges: [] });
  });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error -- untyped browser module, imported to run it
  await import('../../packages/plugin/src/console/ui/app.js');
  await vi.waitFor(() => { if (streams.length === 0) throw new Error('the instance stream never opened'); });
  return { paths };
}

const resumeRow = (): HTMLElement => document.getElementById('tx-resume') as HTMLElement;
const resumeText = (): string => document.getElementById('tx-resume-id')?.textContent ?? '';

/** The console auto-selects its only session; wait for the head to name it. */
async function selected(): Promise<void> {
  await vi.waitFor(() => {
    if (!(document.getElementById('tx-title')?.textContent ?? '').includes('codex')) throw new Error('no session selected yet');
  });
}

afterEach(() => { streams = []; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('CONSOLE-048: the engine\'s own session id in the transcript head', () => {
  /** Full mode: the raw single-event range carries the marker, the folded backfill does not. */
  const fullMode = (meta: unknown) => (path: string): unknown =>
    path.includes('toSeq=1') ? { events: [firstEvent(meta)], highWatermark: 1 } : { runs: [], highWatermark: 1 };

  it('shows the id the engine reported', async () => {
    await loadConsole(fullMode({ cwd: '/tmp/x', status: 'idle', nativeSessionId: 'ses_fa980afe9ffevp74L47qTYfVJB' }));
    await selected();
    await vi.waitFor(() => { if (resumeRow().hidden) throw new Error('the resume row never appeared'); });
    expect(resumeText()).toBe('ses_fa980afe9ffevp74L47qTYfVJB');
  });

  it('reads it from the raw single-event range, not from the folded backfill', async () => {
    // The pane's own backfill asks for `projection=folded`, whose runs carry no
    // `_meta`. A version reading the marker off that page would show the row
    // for nobody, and every other case here would still pass.
    const { paths } = await loadConsole(fullMode({ nativeSessionId: 'ses_x' }));
    await selected();
    await vi.waitFor(() => { if (resumeRow().hidden) throw new Error('the resume row never appeared'); });
    expect(paths).toContainEqual(`/api/sessions/${SESSION}/events?afterSeq=0&toSeq=1`);
  });

  for (const [name, meta] of [
    ['the marker is absent entirely — every pre-rename transcript (ADR 0041)', undefined],
    ['the marker carries no native id', { cwd: '/tmp/x', status: 'idle' }],
    ['the marker is not an object', 'nonsense'],
    ['the marker is null', null],
    ['the native id is an empty string', { nativeSessionId: '' }],
  ] as const) {
    it(`stays hidden when ${name}`, async () => {
      await loadConsole(fullMode(meta));
      await selected();
      // Settle the fetch the selection started before asserting on absence,
      // or this passes on a row that had not been given the chance to appear.
      await vi.waitFor(() => {
        if (!(document.getElementById('tx-title')?.textContent ?? '').includes('codex')) throw new Error('not selected');
      });
      await Promise.resolve();
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      expect(resumeRow().hidden).toBe(true);
      expect(resumeText()).toBe('');
      // Never TaskShuttle's own id standing in for the engine's.
      expect(document.querySelector('#tx-resume-id')?.textContent).not.toContain(SESSION);
    });
  }

  it('stays hidden in degraded mode, because the event carries no update at all', async () => {
    // Not a flag this client reads: with `exposeTranscripts: false` the server
    // projects every event to its envelope (§7.8), so the marker never
    // arrives. Driving the degraded *projection* is what proves the boundary
    // holds by construction rather than by a check somebody has to remember.
    await loadConsole((path) => (path.includes('toSeq=1')
      ? { events: [{ seq: 1, ts: 1, byteLen: 120 }], highWatermark: 1 }
      : { events: [{ seq: 1, ts: 1, byteLen: 120 }], highWatermark: 1 }));
    await selected();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(resumeRow().hidden).toBe(true);
  });

  it('a row given a display keeps an explicit rule for its hidden state', async () => {
    // Not a tautology and not testable through the DOM harness, which never
    // applies the stylesheet: `hidden` is a UA `display: none`, and any
    // `display` this row is given outranks it. The invariant is conditional —
    // *if* `.tx-head-row` carries a display, an `[hidden]` rule must exist —
    // so removing the guard while keeping the layout goes red, which is the
    // combination that would show an empty resume row on every session that
    // has no native id.
    const css = await readFile(join(process.cwd(), 'packages', 'plugin', 'src', 'console', 'ui', 'app.css'), 'utf8');
    const givesDisplay = /\.tx-head-row\s*\{[^}]*display\s*:/.test(css);
    const rehides = /\.tx-head-row\[hidden\]\s*\{[^}]*display\s*:\s*none/.test(css);
    expect(givesDisplay).toBe(true);
    expect(rehides).toBe(true);
  });

  it('says so when the clipboard refuses, and leaves the value on screen', async () => {
    // A button that silently does nothing is worse than one that admits it;
    // the value stays selectable either way, which needs no permission.
    await loadConsole(fullMode({ nativeSessionId: 'ses_x' }));
    await selected();
    await vi.waitFor(() => { if (resumeRow().hidden) throw new Error('the resume row never appeared'); });
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('denied'); } } });
    (document.getElementById('tx-resume-copy') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      const note = document.getElementById('tx-resume-note') as HTMLElement;
      if (note.hidden) throw new Error('no note was shown');
    });
    expect(document.getElementById('tx-resume-note')?.textContent).toContain('select it');
    expect(resumeText()).toBe('ses_x');
  });
});
