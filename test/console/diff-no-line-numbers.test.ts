// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptEvent } from 'runskein';

/**
 * ADR 0035: the console's diffs show no line numbers. This file carries the
 * record's rendered-half acceptance, because `pnpm release:console` cannot:
 * the testkit's scripted agent emits no `type: 'diff'` content block, so no
 * live gate exercises the rendering end to end. The cases below drive the
 * **real** `app.js` rather than asserting on a model: every diff body — the
 * transcript's card and the diff view's expansion alike — renders sign and
 * code cells, no number cell, and no numbering title. The wire half (no
 * `startLine` key, under the chain ADR 0028 would have proved) lives in
 * `diff-index.test.ts`.
 */

const SESSION = 's-0000-1111';
const PATH = 'src/auth/verify.ts';

function diffCall(seq: number, toolCallId: string): TranscriptEvent {
  return {
    seq,
    ts: seq * 1_000,
    sessionId: SESSION,
    engineId: 'codex',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId,
      title: 'Write',
      kind: 'edit',
      status: 'completed',
      content: [{ type: 'diff', path: PATH, oldText: 'const b = 2;\nconst c = 3;\n', newText: 'const b = 22;\nconst c = 3;\n' }],
    } as unknown as TranscriptEvent['update'],
  };
}

/** The live frame: one edit arriving over SSE. */
function liveDiffFrame(): string {
  return JSON.stringify({ type: 'event', sessionId: SESSION, seq: 4, event: diffCall(4, 'call-1') });
}

interface StubbedFetch {
  (input: string): Promise<Response>;
  /** Resolves the /diffs page, so a case can order the backfill against a live frame. */
  releaseDiffs: (entries: readonly Record<string, unknown>[]) => void;
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
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }) as unknown as Response;
}

function stubFetch(): StubbedFetch {
  let release: ((entries: readonly Record<string, unknown>[]) => void) | undefined;
  const page = new Promise<readonly Record<string, unknown>[]>((resolve) => { release = resolve; });
  const impl = (async (input: string) => {
    if (input.includes('/diffs')) return jsonResponse({ diffs: await page, nextSeq: 5, highWatermark: 4, hasMore: false });
    if (input.startsWith('/api/instance')) return jsonResponse({ instanceId: 'i-1', createdAt: '2026-01-01T00:00:00.000Z', host: 'darwin', alive: true, engines: [], config: {} });
    if (input.startsWith('/api/sessions/')) return jsonResponse({ events: [], runs: [], highWatermark: 0 });
    if (input.startsWith('/api/sessions')) return jsonResponse({ sessions: [{ sessionId: SESSION, engine: 'codex', state: 'idle', createdAt: '2026-01-01T00:00:00.000Z', cwd: '/tmp/x', name: 'w' }] });
    if (input.startsWith('/api/turns')) return jsonResponse({ turns: [] });
    if (input.startsWith('/api/interactions')) return jsonResponse({ interactions: [] });
    if (input.startsWith('/api/topology')) return jsonResponse({ nodes: [], edges: [] });
    return jsonResponse({});
  }) as StubbedFetch;
  impl.releaseDiffs = (entries) => release?.(entries);
  return impl;
}

async function loadConsole(): Promise<StubbedFetch> {
  const html = await readFile(join(process.cwd(), 'packages', 'plugin', 'src', 'console', 'ui', 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.slice(html.indexOf('<head>'));
  const fetchStub = stubFetch();
  vi.stubGlobal('fetch', fetchStub);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error -- untyped browser module, imported to run it
  await import('../../packages/plugin/src/console/ui/app.js');
  await vi.waitFor(() => { if (streams.length === 0) throw new Error('the instance stream never opened'); });
  return fetchStub;
}

/** The session stream the console currently reads (the live one; a replaced stream stays in the array). */
async function sessionStream(): Promise<FakeEventSource> {
  return vi.waitFor(() => {
    const live = streams.filter((stream) => stream.url.includes('sessionId=') && stream.readyState !== FakeEventSource.CLOSED);
    const found = live[live.length - 1];
    if (found === undefined) throw new Error('no live session stream');
    return found;
  });
}

const diffRows = (): Element[] => [...document.querySelectorAll('.diff-group-items > .event')];

async function openDiffView(): Promise<void> {
  const tab = [...document.querySelectorAll('.tx-tabs .vt')].find((node) => (node as HTMLElement).dataset['txview'] === 'diff');
  if (tab === undefined) throw new Error('the diff tab is not in the page');
  (tab as HTMLElement).click();
}

/**
 * The one assertion this file exists for: a rendered diff body is sign cells
 * and code cells and nothing else. A number cell reintroduced into the
 * renderer turns this red, which is the point.
 */
function expectSignAndCodeOnly(body: Element): void {
  const lines = body.querySelectorAll('.dline');
  expect(lines.length).toBeGreaterThan(0);
  expect(body.querySelectorAll('.ln')).toHaveLength(0);
  for (const line of lines) {
    expect(line.querySelectorAll('.sign')).toHaveLength(1);
    expect(line.querySelectorAll('.code')).toHaveLength(1);
  }
}

beforeEach(() => { streams = []; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('no line numbers anywhere a diff is rendered (ADR 0035)', () => {
  it('the transcript card renders sign and code cells, no number cell, no numbering title', async () => {
    await loadConsole();
    (await sessionStream()).onmessage?.({ data: liveDiffFrame() });
    await vi.waitFor(() => {
      // Scoped to the transcript's stream: a diff-view row carries the same
      // classes, and this case never opens that view.
      if (document.querySelectorAll('#stream .event.k-tool_call .diff').length === 0) throw new Error('the transcript never rendered the call');
    });
    const body = document.querySelector('#stream .diff .diff-lines');
    if (body === null) throw new Error('the card has no diff body');
    expect(body.getAttribute('title')).toBeNull();
    expectSignAndCodeOnly(body);
  });

  it('the diff view expansion renders the same way, from the live-observed cache', async () => {
    const fetchStub = await loadConsole();
    fetchStub.releaseDiffs([]);
    await openDiffView();
    (await sessionStream()).onmessage?.({ data: liveDiffFrame() });
    await vi.waitFor(() => { if (diffRows().length !== 1) throw new Error('the live diff was not drawn'); });
    const row = diffRows()[0];
    if (row === undefined) throw new Error('the diff row was never rendered');
    const body = row.querySelector('.diff-lines');
    if (body === null) throw new Error('the row has no diff body');
    expect(body.getAttribute('title')).toBeNull();
    (row.querySelector('.diff-head') as HTMLElement).click();
    await vi.waitFor(() => { if (body.querySelectorAll('.dline').length === 0) throw new Error('the expanded body never loaded'); });
    expectSignAndCodeOnly(body);
  });

  it('the same diff arriving from live and from the backfill deals one row, not two', async () => {
    const fetchStub = await loadConsole();
    // The operator opens the diff view; its backfill is still in flight when
    // the live diff arrives. The local entry is first to the key, and the
    // index's twin of it must be dropped, not dealt a second row.
    await openDiffView();
    (await sessionStream()).onmessage?.({ data: liveDiffFrame() });
    await vi.waitFor(() => { if (diffRows().length !== 1) throw new Error('the live diff was not drawn'); });
    fetchStub.releaseDiffs([{ seq: 4, tool: 'Write', path: PATH, adds: 1, dels: 1, status: 'completed', origin: 'engine', part: 0 }]);
    await vi.waitFor(() => { if (diffRows().length !== 1) throw new Error('the backfill dealt a second row'); });
  });

  it('the deleted-entry placeholder carries no number cells either', async () => {
    const fetchStub = await loadConsole();
    await openDiffView();
    fetchStub.releaseDiffs([{ seq: 4, tool: 'apply_patch', path: 'old.ts', adds: 0, dels: 0, status: 'completed', origin: 'engine', part: 0, deleted: true }]);
    await vi.waitFor(() => { if (diffRows().length !== 1) throw new Error('the deleted entry was not drawn'); });
    const row = diffRows()[0];
    if (row === undefined) throw new Error('the diff row was never rendered');
    (row.querySelector('.diff-head') as HTMLElement).click();
    const body = row.querySelector('.diff-lines');
    if (body === null) throw new Error('the row has no diff body');
    await vi.waitFor(() => { if (body.querySelectorAll('.dline').length === 0) throw new Error('the placeholder never loaded'); });
    expect(body.textContent).toContain('carried no deleted content');
    expectSignAndCodeOnly(body);
  });
});
