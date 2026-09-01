import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptEvent } from 'runskein';

import { ConsoleDataSource } from '../../packages/plugin/src/console/data-source.js';
import { PREVIEW_LIMIT, RunAssembler, textChunkKey } from '../../packages/plugin/src/console/folded-projection.js';
import { ConsoleServer } from '../../packages/plugin/src/console/server.js';
import type { InstanceManifest } from '../../packages/plugin/src/lifecycle.js';
import { resolvePluginConfig, type ConsoleConfig, type PluginConfig } from '../../packages/plugin/src/plugin-config.js';
import { SessionRegistry, type RegistryObserver } from '../../packages/core/src/registry.js';
import type { PluginTranscriptStore } from '../../packages/plugin/src/store/plugin-transcript-store.js';
import { createPluginTranscriptStore } from '../../packages/plugin/src/store/plugin-transcript-store.js';
import { mergeFoldedPages as mergePages, stripSeamFlags } from '../../scripts/live/fold-merge.js';

/**
 * The folded projection of console-v2 §3.2 (ADR 0010). The load-bearing
 * assertion is the mutual-inference gate: for one event stream, folding the
 * full raw stream equals merging the folded pages, where merging is the §3.2
 * seam rule (a page-tail `openEnd` fragment joins the next page's `openStart`
 * fragment of the same (kind, messageId); tool runs merge by toolCallId). If
 * interval splitting or watermark semantics drift, that equality fails.
 */

interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function request(port: number, options: { method?: string; path?: string; headers?: Record<string, string> } = {}): Promise<HttpResponse> {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path ?? '/', ...(options.headers === undefined ? {} : { headers: options.headers }) },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolveRequest({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', rejectRequest);
    req.end();
  });
}

type Run = Record<string, unknown> & { seqFrom: number; seqTo: number; kind: string };

interface FoldedPage {
  runs: Run[];
  nextSeq: number;
  highWatermark: number;
  hasMore: boolean;
}

function event(sessionId: string, seq: number, update: Record<string, unknown>): TranscriptEvent {
  return { seq, ts: seq * 1_000, sessionId, engineId: 'codex', update: update as unknown as TranscriptEvent['update'] };
}

function chunk(sessionId: string, seq: number, sessionUpdate: string, text: string, messageId?: string): TranscriptEvent {
  return event(sessionId, seq, { sessionUpdate, content: { type: 'text', text }, ...(messageId === undefined ? {} : { messageId }) });
}

const DIFF_1 = { type: 'diff', path: 'src/a.ts', oldText: 'one\ntwo', newText: 'one\n2' };
const DIFF_2 = { type: 'diff', path: 'src/b.ts', oldText: '', newText: 'new' };
const DIFF_3 = { type: 'diff', path: 'src/c.ts', oldText: 'old', newText: 'new' };

/**
 * The mutual-inference fixture: message streams that paging can split, a tool
 * call whose update can land on another page, a diff-carrying call, an unseen
 * tool_call_update (partial row), two plan updates, two usage updates AND an
 * envelope-carried usage snapshot, one notice, one unknown update (raw).
 *
 * The usage events are here on purpose: accumulated folder state used to
 * travel in the runs, and a page folder cold-started mid-stream cannot
 * reproduce a snapshot earlier events contributed to — so paging between a
 * `usage_update` and a later envelope usage was a real divergence the fixture
 * used to dodge by containing one such event. Neither plan nor usage runs
 * carry snapshots any more, so both are equivalence-safe and the fixture
 * exercises the case rather than avoiding it.
 */
function fixture(sessionId: string): TranscriptEvent[] {
  return [
    chunk(sessionId, 1, 'user_message_chunk', 'please change the config', 'u1'),
    chunk(sessionId, 2, 'agent_thought_chunk', 'I should look at ', 't1'),
    chunk(sessionId, 3, 'agent_thought_chunk', 'the settings file first.', 't1'),
    event(sessionId, 4, { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Read', kind: 'read', status: 'in_progress' }),
    event(sessionId, 5, { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed' }),
    chunk(sessionId, 6, 'agent_message_chunk', 'Done: ', 'm1'),
    chunk(sessionId, 7, 'agent_message_chunk', 'updated two files.', 'm1'),
    event(sessionId, 8, { sessionUpdate: 'tool_call', toolCallId: 'tc2', title: 'Edit', kind: 'edit', status: 'in_progress', content: [DIFF_1] }),
    chunk(sessionId, 9, 'agent_thought_chunk', 'double-checking', 't2'),
    // Whole-array content replacement repeats the first diff; the merge dedupes it.
    event(sessionId, 10, { sessionUpdate: 'tool_call_update', toolCallId: 'tc2', status: 'completed', content: [DIFF_1, DIFF_2] }),
    event(sessionId, 11, { sessionUpdate: 'plan', entries: [{ content: 'step', priority: 'high', status: 'pending' }] }),
    event(sessionId, 12, { sessionUpdate: 'usage_update', used: 100, size: 200 }),
    event(sessionId, 13, { sessionUpdate: 'available_commands_update', availableCommands: [] }),
    event(sessionId, 14, { sessionUpdate: 'future_update', payload: { x: 1 } }),
    chunk(sessionId, 15, 'user_message_chunk', 'thanks', 'u2'),
    event(sessionId, 16, { sessionUpdate: 'tool_call_update', toolCallId: 'tc3', status: 'completed', content: [DIFF_3] }),
    // A second plan update: the run carries no cumulative state, so paging
    // between the two cannot diverge from the unpaged fold.
    event(sessionId, 17, { sessionUpdate: 'plan', entries: [{ content: 'step', priority: 'high', status: 'completed' }] }),
    // A second usage_update and an envelope-carried snapshot: the folder's
    // usage state now spans events that paging can separate.
    event(sessionId, 18, { sessionUpdate: 'usage_update', used: 150, size: 200 }),
    Object.assign(chunk(sessionId, 19, 'agent_message_chunk', 'and done.', 'm2'), {
      usage: { input: 10, output: 20 },
    }) as TranscriptEvent,
  ];
}

const manifest: InstanceManifest = {
  instanceId: 'test-instance',
  createdAt: '2026-01-01T00:00:00.000Z',
  host: 'test-host',
  pid: 1,
  processStartedAt: '2026-01-01T00:00:00.000Z',
  tokenHash: 'a'.repeat(64),
  exePath: '/test/exe',
};

function testConfig(consoleOverrides: Partial<ConsoleConfig> = {}, budgetBytes?: number): PluginConfig {
  const base = resolvePluginConfig({ allowedRoots: [tmpdir()], console: { enabled: true, ...consoleOverrides } });
  if (budgetBytes === undefined) return base;
  return { ...base, responseByteBudget: budgetBytes };
}

interface Rig {
  readonly dir: string;
  readonly server: ConsoleServer;
  readonly store: PluginTranscriptStore;
  readonly registry: SessionRegistry;
  readonly dataSource: ConsoleDataSource;
  readonly config: PluginConfig;
  readonly deleted: Set<string>;
  /* Extra request headers; empty, since there is no credential to send. */
  readonly headers: Record<string, string>;
}

const rigs: Rig[] = [];

async function startRig(options: { exposeTranscripts?: boolean; budgetBytes?: number } = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'taskshuttle-console-folded-'));
  const config = testConfig({ exposeTranscripts: options.exposeTranscripts ?? true }, options.budgetBytes);
  let target: RegistryObserver | undefined;
  const forwarding: RegistryObserver = {
    onSessionTransition: (event) => target?.onSessionTransition?.(event),
    onTurnTransition: (event) => target?.onTurnTransition?.(event),
    onInteractionTransition: (event) => target?.onInteractionTransition?.(event),
  };
  const registry = new SessionRegistry({ instanceId: manifest.instanceId, observer: forwarding });
  const store = createPluginTranscriptStore(join(dir, 'taskshuttle.sqlite'));
  const deleted = new Set<string>();
  const dataSource = new ConsoleDataSource({
    config,
    registry,
    store,
    instance: () => manifest,
    engines: async () => ['codex'],
    isTranscriptDeleted: (realmSessionId) => deleted.has(realmSessionId),
    isVisible: () => true,
  });
  target = dataSource.observer;
  store.onChange(dataSource.storeListener);
  const server = new ConsoleServer({ config: config.console, instanceDir: dir, dataSource });
  await server.start();
  const rig: Rig = { dir, server, store, registry, dataSource, config, deleted, headers: {} };
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  while (rigs.length > 0) {
    const rig = rigs.pop()!;
    await rig.server.close().catch(() => undefined);
    await rig.store.close().catch(() => undefined);
    await rm(rig.dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** A ready session `s1` whose Realm-side transcript id is `r1`. */
function seedSession(rig: Rig): void {
  expect(rig.registry.createSession({ id: 's1', engine: 'codex', cwd: '/work/project', name: 'main' }).ok).toBe(true);
  expect(rig.registry.markSessionReady('s1', 'r1', {}).ok).toBe(true);
}

async function fetchFolded(rig: Rig, afterSeq: number): Promise<FoldedPage> {
  const res = await request(rig.server.port, { path: `/api/sessions/s1/events?projection=folded&afterSeq=${afterSeq}`, headers: rig.headers });
  expect(res.status).toBe(200);
  return JSON.parse(res.body) as FoldedPage;
}

/** Page through the folded projection, asserting the §3.2 cursor rule on every run. */
async function foldedPages(rig: Rig): Promise<Run[][]> {
  const pages: Run[][] = [];
  let afterSeq = 0;
  for (;;) {
    const page = await fetchFolded(rig, afterSeq);
    for (const run of page.runs) expect(run.seqFrom).toBeGreaterThanOrEqual(afterSeq + 1);
    pages.push(page.runs);
    if (!page.hasMore) return pages;
    afterSeq = page.nextSeq - 1;
    if (pages.length > 500) throw new Error('folded pagination did not converge');
  }
}


/** The reference side of the gate: the same assembler over the whole stream, unpaged. */
function referenceFold(events: TranscriptEvent[]): Run[] {
  const assembler = new RunAssembler();
  for (const item of events) assembler.pushEvent(item);
  assembler.finish();
  // A transcript ending mid-message leaves a trailing `openEnd` here too: it
  // is the seam mechanism, not part of the folded value, and the merge strips
  // it on the other side.
  return stripSeamFlags(JSON.parse(JSON.stringify(assembler.runs)) as Run[]);
}

describe('folded projection: fold(raw) ≡ merge(folded pages)', () => {
  it('holds across page sizes, including pages that split a message mid-stream', async () => {
    const events = fixture('r1');
    const reference = referenceFold(events);
    expect(reference.length).toBeGreaterThan(4);
    for (const budgetBytes of [undefined, 1_200, 700, 480, 360]) {
      const rig = await startRig(budgetBytes === undefined ? {} : { budgetBytes });
      seedSession(rig);
      for (const item of events) await rig.store.append(item);
      const pages = await foldedPages(rig);
      expect(pages.flat().length).toBeGreaterThanOrEqual(reference.length);
      if (budgetBytes === undefined) expect(pages).toHaveLength(1);
      else expect(pages.length).toBeGreaterThan(1);
      expect(mergePages(pages)).toEqual(reference);
    }
  });
});

describe('folded projection: preview truncation', () => {
  it('truncates a long thought to preview + fullBytes, keeps a short message whole, and the raw range recomposes the full text', async () => {
    const rig = await startRig();
    seedSession(rig);
    const part1 = 'a'.repeat(300);
    const part2 = 'b'.repeat(300);
    await rig.store.append(chunk('r1', 1, 'agent_thought_chunk', part1, 't1'));
    await rig.store.append(chunk('r1', 2, 'agent_thought_chunk', part2, 't1'));
    await rig.store.append(chunk('r1', 3, 'agent_message_chunk', 'short answer', 'm1'));

    const page = await fetchFolded(rig, 0);
    expect(page.hasMore).toBe(false);
    const [thought, message] = page.runs;
    expect(thought).toMatchObject({ seqFrom: 1, seqTo: 2, kind: 'thought', messageId: 't1', truncated: true, fullBytes: 600 });
    expect(thought?.['preview']).toBe((part1 + part2).slice(0, PREVIEW_LIMIT));
    expect(String(thought?.['preview'])).toHaveLength(PREVIEW_LIMIT);
    expect(thought).not.toHaveProperty('text');
    expect(message).toMatchObject({ seqFrom: 3, seqTo: 3, kind: 'agent', text: 'short answer' });
    expect(message).not.toHaveProperty('preview');

    // The expansion path (§3.2): the raw projection over the run's seq range
    // recomposes the truncated text.
    const raw = await request(rig.server.port, {
      path: `/api/sessions/s1/events?afterSeq=${thought!.seqFrom - 1}&toSeq=${thought!.seqTo}`,
      headers: rig.headers,
    });
    expect(raw.status).toBe(200);
    const rawPage = JSON.parse(raw.body) as { events: Array<{ seq: number; update: { content: { text: string } } }> };
    expect(rawPage.events.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(rawPage.events.map((entry) => entry.update.content.text).join('')).toBe(part1 + part2);
  });
});

describe('folded projection: openStart / openEnd seam flags', () => {
  const seed = async (rig: Rig): Promise<void> => {
    seedSession(rig);
    await rig.store.append(chunk('r1', 1, 'agent_message_chunk', 'x'.repeat(100), 'm1'));
    await rig.store.append(chunk('r1', 2, 'agent_message_chunk', 'x'.repeat(100), 'm1'));
    await rig.store.append(chunk('r1', 3, 'agent_message_chunk', 'x'.repeat(100), 'm1'));
    await rig.store.append(event('r1', 4, { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Edit', kind: 'edit', status: 'completed' }));
    await rig.store.append(chunk('r1', 5, 'agent_message_chunk', 'y'.repeat(50), 'm2'));
  };

  it('marks a page-head fragment continuing the cursor event’s message, and a trailing open one openEnd even at the watermark', async () => {
    const rig = await startRig();
    await seed(rig);
    const page = await fetchFolded(rig, 2);
    expect(page.hasMore).toBe(false);
    expect(page.runs.map((run) => run.kind)).toEqual(['agent', 'tool', 'agent']);
    // Event 2 is a text chunk of (agent, m1): the page-head fragment is a continuation.
    expect(page.runs[0]).toMatchObject({ seqFrom: 3, seqTo: 3, messageId: 'm1', openStart: true, text: 'x'.repeat(100) });
    // The tool call at seq 4 ended m1, so its fragment is a finished message.
    expect(page.runs[0]).not.toHaveProperty('openEnd');
    // m2 is still open at the cut. The page reached the watermark, so there is
    // no next page — but the continuation arrives over the raw SSE seam, and
    // the client needs the same flag to join it onto this run rather than
    // dealing a second run mid-sentence (§3.2, seam three).
    expect(page.runs[2]).toMatchObject({ seqFrom: 5, seqTo: 5, messageId: 'm2', text: 'y'.repeat(50), openEnd: true });
    expect(page.runs[2]).not.toHaveProperty('openStart');
  });

  it('marks a page-tail fragment openEnd when the budget cuts the page mid-message', async () => {
    // Sized so a page holds exactly two 100-char chunks of m1: the fragment
    // projection below is the shape the assembler accounts (openEnd reserved).
    const fragment = Buffer.byteLength(
      JSON.stringify({ seqFrom: 1, seqTo: 2, kind: 'agent', messageId: 'm1', text: 'x'.repeat(200), openEnd: true }),
      'utf8',
    );
    const rig = await startRig({ budgetBytes: fragment + 420 });
    await seed(rig);

    const page1 = await fetchFolded(rig, 0);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextSeq).toBe(3);
    expect(page1.runs).toHaveLength(1);
    expect(page1.runs[0]).toMatchObject({ seqFrom: 1, seqTo: 2, kind: 'agent', messageId: 'm1', text: 'x'.repeat(200), openEnd: true });
    expect(page1.runs[0]).not.toHaveProperty('openStart');

    const page2 = await fetchFolded(rig, 2);
    expect(page2.runs[0]).toMatchObject({ seqFrom: 3, seqTo: 3, messageId: 'm1', openStart: true, text: 'x'.repeat(100) });
    expect(page2.runs[0]).not.toHaveProperty('openEnd');
    expect(page2.runs[1]?.kind).toBe('tool');
  });
});

describe('the page merge refuses what the seam rule refuses', () => {
  /**
   * Hand-built pages, because a correct server cannot produce this pair: an
   * `openStart` fragment behind a predecessor that is NOT `openEnd` means the
   * earlier message had ended, and the merge must start a new run. On the wire
   * the two flags move together, so the mutual-inference fixture cannot
   * discriminate this clause — but the UI's live seam has no `openStart` at
   * all and leans on the open state alone, and both now read the same rule.
   */
  it('starts a new run when the predecessor was not left open', () => {
    const closed: Run = { seqFrom: 1, seqTo: 1, kind: 'agent', text: 'first' };
    const next: Run = { seqFrom: 2, seqTo: 2, kind: 'agent', text: 'second', openStart: true };
    expect(mergePages([[closed], [next]])).toEqual([
      { seqFrom: 1, seqTo: 1, kind: 'agent', text: 'first' },
      { seqFrom: 2, seqTo: 2, kind: 'agent', text: 'second' },
    ]);
  });

  it('joins them when it was', () => {
    const open: Run = { seqFrom: 1, seqTo: 1, kind: 'agent', text: 'first ', openEnd: true };
    const next: Run = { seqFrom: 2, seqTo: 2, kind: 'agent', text: 'second', openStart: true };
    expect(mergePages([[open], [next]])).toEqual([{ seqFrom: 1, seqTo: 2, kind: 'agent', text: 'first second' }]);
  });
});

describe('fold(raw) ≡ merge(folded pages): a message past the preview cap', () => {
  it('holds when the split message truncates, on both sides of the cut', async () => {
    // Every other fixture message is far under PREVIEW_LIMIT, so the merge
    // helper's truncation path had never run. A truncated fragment carries
    // preview/truncated/fullBytes and no `text`; joining by concatenating
    // `text` produced text:'' beside a stale fullBytes and failed a correct
    // server.
    // Sized so the page cuts between the two long chunks; without that the
    // whole message fits one page, no fragment is ever joined, and this case
    // asserts nothing about the path it exists for.
    const rig = await startRig({ budgetBytes: PREVIEW_LIMIT + 900 });
    seedSession(rig);
    const half = 'x'.repeat(PREVIEW_LIMIT);
    await rig.store.append(chunk('r1', 1, 'agent_message_chunk', half, 'm1'));
    await rig.store.append(chunk('r1', 2, 'agent_message_chunk', half, 'm1'));
    await rig.store.append(chunk('r1', 3, 'agent_message_chunk', 'tail', 'm1'));

    const reference = referenceFold([
      chunk('r1', 1, 'agent_message_chunk', half, 'm1'),
      chunk('r1', 2, 'agent_message_chunk', half, 'm1'),
      chunk('r1', 3, 'agent_message_chunk', 'tail', 'm1'),
    ]);
    expect(reference[0]).toMatchObject({ truncated: true, fullBytes: PREVIEW_LIMIT * 2 + 4 });

    const pages: Run[][] = [];
    let afterSeq = 0;
    for (;;) {
      const page = await fetchFolded(rig, afterSeq);
      pages.push(page.runs);
      if (!page.hasMore) break;
      afterSeq = page.nextSeq - 1;
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(mergePages(pages)).toEqual(reference);
  });
});

describe('folded projection: openStart and an intervening boundary', () => {
  it('withholds openStart when the page opens with an event that ended the message', async () => {
    // A / usage_update / B, all agent chunks with no messageId, cut after A.
    // The folder ends A at the usage_update, so B is a NEW message — but the
    // cursor probe sees only A's chunk and the keys match, so before the fix
    // page two claimed B continued A and the client merged two messages into
    // one. Nothing on the wire said otherwise: same kind, both ids absent.
    const rig = await startRig();
    seedSession(rig);
    await rig.store.append(chunk('r1', 1, 'agent_message_chunk', 'first message'));
    await rig.store.append(event('r1', 2, { sessionUpdate: 'usage_update', used: 1, size: 2 }));
    await rig.store.append(chunk('r1', 3, 'agent_message_chunk', 'second message'));

    const page = await fetchFolded(rig, 1);
    expect(page.runs.map((run) => run.kind)).toEqual(['usage', 'agent']);
    expect(page.runs[1]).toMatchObject({ seqFrom: 3, seqTo: 3, text: 'second message' });
    expect(page.runs[1]).not.toHaveProperty('openStart');
  });

  it('still marks a real continuation, where the page opens with the message itself', async () => {
    const rig = await startRig();
    seedSession(rig);
    await rig.store.append(chunk('r1', 1, 'agent_message_chunk', 'one ', 'm1'));
    await rig.store.append(chunk('r1', 2, 'agent_message_chunk', 'two', 'm1'));
    const page = await fetchFolded(rig, 1);
    expect(page.runs[0]).toMatchObject({ seqFrom: 2, messageId: 'm1', openStart: true, text: 'two' });
  });

  it('an oversized reference at the page head settles nothing: the fold spans it', async () => {
    const rig = await startRig({ budgetBytes: 2_048 });
    seedSession(rig);
    await rig.store.append(chunk('r1', 1, 'agent_message_chunk', 'a'.repeat(100), 'm1'));
    await rig.store.append(chunk('r1', 2, 'agent_message_chunk', 'huge'.repeat(2_000), 'm1'));
    await rig.store.append(chunk('r1', 3, 'agent_message_chunk', 'b'.repeat(100), 'm1'));
    const page = await fetchFolded(rig, 1);
    expect(page.runs[0]).toMatchObject({ kind: 'oversized', seq: 2 });
    // The reference never reached the folder, so the message it interrupts is
    // still the cursor event's message on both sides of the projection.
    expect(page.runs[1]).toMatchObject({ kind: 'agent', messageId: 'm1', openStart: true });
  });
});

describe('folded projection: plan runs carry no cumulative state', () => {
  it('a plan run is only the meta line: seq interval, kind, change ids — never `state`', async () => {
    const rig = await startRig();
    seedSession(rig);
    await rig.store.append(event('r1', 1, { sessionUpdate: 'plan', entries: [{ content: 'step one', priority: 'high', status: 'pending' }] }));
    await rig.store.append(event('r1', 2, { sessionUpdate: 'plan', entries: [{ content: 'step one', priority: 'high', status: 'completed' }] }));
    const page = await fetchFolded(rig, 0);
    const plans = page.runs.filter((run) => run.kind === 'plan');
    expect(plans).toHaveLength(2);
    // Both UI paths render only the meta line; the folder's cumulative plan
    // snapshot is what made run k O(k) events large (the M4 budget bug).
    for (const run of plans) expect(Object.keys(run).sort()).toEqual(['kind', 'seqFrom', 'seqTo']);
  });

  it('a plan-dense page stays inside the byte budget instead of failing the whole page', async () => {
    // Three plan updates of ~150 KB of entries each. With the cumulative
    // snapshot embedded, run sizes grew 150/300/450 KB while the per-event
    // cut estimate charged only eventBytes + overhead — one push overshot the
    // budget by hundreds of KB and the whole-page re-check answered 413 with
    // no seq, making the folded route unusable for plan-dense sessions.
    const rig = await startRig({ budgetBytes: 700_000 });
    seedSession(rig);
    for (let seq = 1; seq <= 3; seq += 1) {
      const entries = Array.from({ length: 10 }, (_, i) => ({ content: `p${seq} step ${i} ${'x'.repeat(15_000)}`, priority: 'high', status: 'pending' }));
      await rig.store.append(event('r1', seq, { sessionUpdate: 'plan', entries }));
    }
    const res = await request(rig.server.port, { path: '/api/sessions/s1/events?projection=folded&afterSeq=0', headers: rig.headers });
    expect(res.status).toBe(200);
    const page = JSON.parse(res.body) as FoldedPage;
    expect(page.hasMore).toBe(false);
    expect(page.runs.map((run) => run.kind)).toEqual(['plan', 'plan', 'plan']);
  });
});

describe('textChunkKey guards', () => {
  it('a non-object update is not a text chunk — no TypeError (§3.2 cursor probe)', () => {
    const envelope = { ts: 0, sessionId: 'r1', engineId: 'codex' };
    expect(textChunkKey({ seq: 1, ...envelope, update: null as unknown as TranscriptEvent['update'] })).toBeUndefined();
    expect(textChunkKey({ seq: 2, ...envelope, update: 'agent_message_chunk' as unknown as TranscriptEvent['update'] })).toBeUndefined();
    expect(textChunkKey(chunk('r1', 3, 'agent_thought_chunk', 'hi', 't1'))).toEqual({ kind: 'thought', messageId: 't1' });
  });
});

describe('folded projection: oversized events', () => {
  it('carries the §9.4 reference run, never the body, and the open message continues past it', async () => {
    const rig = await startRig({ budgetBytes: 2_048 });
    seedSession(rig);
    await rig.store.append(chunk('r1', 1, 'agent_message_chunk', 'a'.repeat(100), 'm1'));
    await rig.store.append(chunk('r1', 2, 'agent_message_chunk', 'huge'.repeat(2_000), 'm1'));
    await rig.store.append(chunk('r1', 3, 'agent_message_chunk', 'b'.repeat(100), 'm1'));

    const page1 = await fetchFolded(rig, 0);
    expect(page1.hasMore).toBe(true);
    expect(page1.runs).toHaveLength(1);
    expect(page1.runs[0]).toMatchObject({ kind: 'agent', openEnd: true });

    const res = await request(rig.server.port, { path: '/api/sessions/s1/events?projection=folded&afterSeq=1', headers: rig.headers });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('huge');
    const page2 = JSON.parse(res.body) as FoldedPage;
    expect(page2.hasMore).toBe(false);
    const [reference, continuation] = page2.runs;
    expect(reference).toMatchObject({ kind: 'oversized', seq: 2, seqFrom: 2, seqTo: 2 });
    expect(reference?.['totalBytes']).toBeGreaterThan(2_048);
    expect(reference?.['sha256']).toMatch(/^[a-f0-9]{64}$/);
    // The fragment after the reference is a continuation of the same message.
    expect(continuation).toMatchObject({ kind: 'agent', messageId: 'm1', openStart: true, text: 'b'.repeat(100) });
  });
});

describe('events endpoint: toSeq (raw projection only)', () => {
  it('caps the page at the closed-interval bound, keeps watermark and hasMore honest', async () => {
    const rig = await startRig();
    seedSession(rig);
    for (let seq = 1; seq <= 5; seq += 1) await rig.store.append(chunk('r1', seq, 'agent_message_chunk', `e${seq}`));

    const ranged = await request(rig.server.port, { path: '/api/sessions/s1/events?afterSeq=1&toSeq=3', headers: rig.headers });
    expect(ranged.status).toBe(200);
    const page = JSON.parse(ranged.body) as { events: Array<{ seq: number }>; nextSeq: number; highWatermark: number; hasMore: boolean };
    expect(page.events.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(page).toMatchObject({ nextSeq: 4, highWatermark: 5, hasMore: true });

    // The single-event fetch: afterSeq=N-1&toSeq=N.
    const single = await request(rig.server.port, { path: '/api/sessions/s1/events?afterSeq=3&toSeq=4', headers: rig.headers });
    expect((JSON.parse(single.body) as { events: Array<{ seq: number }> }).events.map((entry) => entry.seq)).toEqual([4]);

    // A bound past the watermark reads to the watermark; an inverted range is empty.
    const pastEnd = JSON.parse((await request(rig.server.port, { path: '/api/sessions/s1/events?afterSeq=3&toSeq=99', headers: rig.headers })).body) as { events: unknown[]; hasMore: boolean };
    expect(pastEnd.events).toHaveLength(2);
    expect(pastEnd.hasMore).toBe(false);
    const inverted = JSON.parse((await request(rig.server.port, { path: '/api/sessions/s1/events?afterSeq=0&toSeq=0', headers: rig.headers })).body) as { events: unknown[] };
    expect(inverted.events).toEqual([]);
  });

  it('rejects malformed and misused parameters with 400', async () => {
    const rig = await startRig();
    seedSession(rig);
    await rig.store.append(chunk('r1', 1, 'agent_message_chunk', 'e1'));
    for (const path of [
      '/api/sessions/s1/events?toSeq=later',
      '/api/sessions/s1/events?toSeq=-2',
      '/api/sessions/s1/events?projection=banana',
      '/api/sessions/s1/events?projection=folded&toSeq=3',
    ]) {
      expect((await request(rig.server.port, { path, headers: rig.headers })).status).toBe(400);
    }
    // projection=raw is the spelled-out default, toSeq included.
    const raw = await request(rig.server.port, { path: '/api/sessions/s1/events?projection=raw&afterSeq=0&toSeq=1', headers: rig.headers });
    expect(raw.status).toBe(200);
    expect((JSON.parse(raw.body) as { events: unknown[] }).events).toHaveLength(1);
  });
});

describe('degraded mode (§3.4)', () => {
  it('folded degrades to the raw envelope page and diffs to the empty index — no event body bytes leave', async () => {
    const rig = await startRig({ exposeTranscripts: false });
    seedSession(rig);
    await rig.store.append(chunk('r1', 1, 'agent_message_chunk', 'zz-folded-secret', 'm1'));
    await rig.store.append(event('r1', 2, { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'zz-tool-name', status: 'completed', content: [DIFF_1] }));

    const folded = await request(rig.server.port, { path: '/api/sessions/s1/events?projection=folded', headers: rig.headers });
    expect(folded.status).toBe(200);
    expect(folded.body).not.toContain('zz-folded-secret');
    expect(folded.body).not.toContain('zz-tool-name');
    expect(folded.body).not.toContain('src/a.ts');
    const page = JSON.parse(folded.body) as { events: Array<Record<string, unknown>>; highWatermark: number };
    expect(page.highWatermark).toBe(2);
    expect(page.events).toHaveLength(2);
    for (const entry of page.events) expect(Object.keys(entry).sort()).toEqual(['byteLen', 'seq', 'ts']);

    const diffs = await request(rig.server.port, { path: '/api/sessions/s1/diffs', headers: rig.headers });
    expect(diffs.status).toBe(200);
    expect(diffs.body).not.toContain('src/a.ts');
    expect(diffs.body).not.toContain('zz-tool-name');
    expect(JSON.parse(diffs.body)).toEqual({ diffs: [], nextSeq: 1, highWatermark: 2, hasMore: false });
  });
});
