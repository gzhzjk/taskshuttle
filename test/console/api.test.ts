import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptEvent } from 'runskein';

import { ConsoleDataSource, type ConsoleStreamFrame, projectUsageBlock } from '../../packages/plugin/src/console/data-source.js';
import { verificationState } from '../../packages/plugin/src/engine-support.js';
import { ConsoleServer } from '../../packages/plugin/src/console/server.js';
import type { InstanceManifest } from '../../packages/plugin/src/lifecycle.js';
import { resolvePluginConfig, type ConsoleConfig, type PluginConfig } from '../../packages/plugin/src/plugin-config.js';
import { SessionRegistry, type RegistryObserver } from '../../packages/core/src/registry.js';
import { readTranscriptPage } from '../../packages/plugin/src/transcript-page.js';
import { createPluginTranscriptStore, type PluginTranscriptStore } from '../../packages/plugin/src/store/plugin-transcript-store.js';

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

interface SseFrame {
  id?: string;
  data: ConsoleStreamFrame & Record<string, unknown>;
}

/** Minimal EventSource-less SSE reader over the raw socket. */
interface SseClient {
  readonly frames: SseFrame[];
  /** Resolves when the server confirmed the subscription (`: subscribed`). */
  readonly ready: Promise<void>;
  readonly ended: Promise<void>;
  close(): void;
}

function openSse(port: number, path: string, headers: Record<string, string>): SseClient {
  const frames: SseFrame[] = [];
  let buffered = '';
  let endResolve: () => void = () => undefined;
  let readyResolve: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => { endResolve = resolve; });
  const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
  const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
    res.on('data', (chunk: Buffer) => {
      readyResolve();
      buffered += chunk.toString('utf8');
      const blocks = buffered.split('\n\n');
      buffered = blocks.pop() ?? '';
      for (const block of blocks) {
        let id: string | undefined;
        let data: string | undefined;
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) id = line.slice(4);
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (data !== undefined) frames.push({ ...(id === undefined ? {} : { id }), data: JSON.parse(data) as SseFrame['data'] });
      }
    });
    res.on('end', () => endResolve());
    // A destroyed socket (client-initiated close) ends with 'close', not 'end'.
    res.on('close', () => endResolve());
  });
  req.on('error', () => endResolve());
  req.end();
  return { frames, ready, ended, close: () => req.destroy() };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function textEvent(sessionId: string, seq: number, text: string): TranscriptEvent {
  return { seq, ts: seq * 1_000, sessionId, engineId: 'codex', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } };
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
  // A small budget is needed to exercise paging; config validation floors the
  // install surface at 1 MiB, so the test rig patches the frozen value.
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
  /* Extra request headers. Empty since ADR 0032 removed the console's
     credential, and kept as a seam rather than deleted: a case still needs to
     send a wrong Host or a Last-Event-ID, and reintroducing the parameter at
     that point would mean touching every call in the file. */
  readonly headers: Record<string, string>;
}

const rigs: Rig[] = [];

async function startRig(options: { exposeTranscripts?: boolean; maxConsoleStreams?: number; budgetBytes?: number; engines?: string[]; onEngines?: () => void } = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'taskshuttle-console-api-'));
  const config = testConfig(
    { exposeTranscripts: options.exposeTranscripts ?? true, maxConsoleStreams: options.maxConsoleStreams ?? 8 },
    options.budgetBytes,
  );
  // The direct rig forwards the registry's single observer slot to the data
  // source; the runtime's composed multiplexer is covered by the e2e test.
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
    // The counting seam belongs on the provider rather than on the hub behind
    // it: what the warm has to reach is this call, not Realm's cache.
    engines: async () => { options.onEngines?.(); return options.engines ?? ['codex', 'claude-code']; },
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

describe('console read APIs', () => {
  // Starting the listener publishes console.json, and from that moment
  // `console open` can probe this port under its deadline. The only work
  // /api/instance awaits is engine discovery, whose first call costs seconds —
  // so unless the start warms it, the probe's own request is what pays, and it
  // expires first. That made every first open of an untouched console fail and
  // every retry succeed. The request count is the assertion: the warm must
  // happen with nothing having asked.
  it('warms engine discovery when the listener starts, before any request', async () => {
    let calls = 0;
    await startRig({ onEngines: () => { calls += 1; } });
    await vi.waitFor(() => { if (calls === 0) throw new Error('starting the console never warmed engine discovery'); });
    expect(calls).toBe(1);
  });

  it('serves instance metadata from the whitelist, with engine verification and defects', async () => {
    const rig = await startRig();
    const res = await request(rig.server.port, { path: '/api/instance', headers: rig.headers });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body).toMatchObject({ instanceId: 'test-instance', createdAt: manifest.createdAt, host: 'test-host', alive: true });
    // The states come from the shared table rather than a literal: which
    // engines carry evidence changes every time a live matrix runs, and a test
    // that pins today's answer tests the week instead of the API.
    expect(body['engines']).toEqual([
      { engine: 'codex', verification: verificationState('codex') },
      // §5.6: the recorded defect sits beside the engine entry.
      { engine: 'claude-code', verification: verificationState('claude-code'), knownDefects: ['session.fork'] },
    ]);
    expect(body['config']).toEqual({ maxOpenSessions: 32, maxActiveTurns: 8, maxActiveTurnsPerEngine: 2, maxQueuedTurns: 256, exposeTranscripts: true, maxConsoleStreams: 8 });
    // §7.6: identity credentials and environment fields never leave.
    for (const forbidden of ['tokenHash', 'launchTokenHash', 'exePath', 'pid', 'rootNonce', 'allowedRoots']) {
      expect(res.body).not.toContain(forbidden);
    }
  });

  it('re-reads the manifest per request, so a rewritten host label shows up', async () => {
    // The host label is rewritten when the MCP client identifies itself after
    // start-up; a snapshotted manifest would keep showing the platform label.
    const live: InstanceManifest = { ...manifest, host: 'darwin' };
    const dir = await mkdtemp(join(tmpdir(), 'taskshuttle-console-live-host-'));
    const registry = new SessionRegistry({ instanceId: manifest.instanceId });
  const store = createPluginTranscriptStore(join(dir, 'taskshuttle.sqlite'));
    try {
      const dataSource = new ConsoleDataSource({
        config: testConfig(),
        registry,
        store,
        // structuredClone mirrors InstanceManager.getManifest's copy semantics:
        // a plain reference would make a construction-time snapshot
        // indistinguishable from a per-request read.
        instance: () => structuredClone(live),
        engines: async () => [],
        isTranscriptDeleted: () => false,
        isVisible: () => true,
      });
      expect((await dataSource.instanceInfo())['host']).toBe('darwin');
      live.host = 'claude-code';
      expect((await dataSource.instanceInfo())['host']).toBe('claude-code');
    } finally {
      await store.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('lists and details sessions, and 404s an unknown id', async () => {
    const rig = await startRig();
    seedSession(rig);
    const listed = await request(rig.server.port, { path: '/api/sessions', headers: rig.headers });
    expect(listed.status).toBe(200);
    const sessions = (JSON.parse(listed.body) as { sessions: Array<Record<string, unknown>> }).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionId: 's1', engine: 'codex', state: 'idle', name: 'main', cwd: '/work/project', permissionMode: 'ask-orchestrator', verification: verificationState('codex') });
    expect(sessions[0]?.['createdAt']).toBeTypeOf('string');

    const detail = await request(rig.server.port, { path: '/api/sessions/s1', headers: rig.headers });
    expect((JSON.parse(detail.body) as Record<string, unknown>)['sessionId']).toBe('s1');
    expect((await request(rig.server.port, { path: '/api/sessions/nope', headers: rig.headers })).status).toBe(404);
  });

  it('lists turns with ordering token, priority and durations', async () => {
    const rig = await startRig();
    seedSession(rig);
    expect(rig.registry.createTurn('s1', { id: 't1', prompt: [{ type: 'text', text: 'zz-prompt-content' }], priority: 'high' }).ok).toBe(true);
    const res = await request(rig.server.port, { path: '/api/turns', headers: rig.headers });
    const turns = (JSON.parse(res.body) as { turns: Array<Record<string, unknown>> }).turns;
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ turnId: 't1', sessionId: 's1', engine: 'codex', state: 'queued', priority: 'high', enqueueSeq: '1' });
    // The prompt is content; it never appears on this route.
    expect(res.body).not.toContain('zz-prompt-content');
  });

  it('projects a turn\'s engine-reported usage onto the turns route, verbatim in full mode', async () => {
    const rig = await startRig();
    seedSession(rig);
    expect(rig.registry.createTurn('s1', { id: 't1', prompt: [{ type: 'text', text: 'hi' }] }).ok).toBe(true);
    expect(rig.registry.createTurn('s1', { id: 't2', prompt: [{ type: 'text', text: 'hi' }] }).ok).toBe(true);
    // Full mode returns the block as the engine reported it, cost included —
    // the §7.8 whitelist applies only when transcripts are off.
    const usage = { input: 1_200, output: 340, total: 1_540, cost: 0.0123, currency: 'USD' };
    expect(rig.registry.setTurnOutcome('t1', { usage }).ok).toBe(true);
    const res = await request(rig.server.port, { path: '/api/turns', headers: rig.headers });
    const turns = (JSON.parse(res.body) as { turns: Array<Record<string, unknown>> }).turns;
    expect(turns.find((t) => t['turnId'] === 't1')?.['usage']).toEqual(usage);
    // A turn without an outcome carries no usage key at all.
    expect(turns.find((t) => t['turnId'] === 't2')).not.toHaveProperty('usage');
  });

  it('projects only the whitelisted count keys of usage in degraded mode', async () => {
    const rig = await startRig({ exposeTranscripts: false });
    seedSession(rig);
    rig.registry.createTurn('s1', { id: 't1', prompt: [{ type: 'text', text: 'hi' }] });
    // §7.8: counts may leave, everything else may not. The seeded block probes
    // each leak class: money by name (cost/currency), money by another name
    // (costPerToken — numeric, so a type-based filter would pass it), a
    // case-variant (Cost), and a plain string (model).
    rig.registry.setTurnOutcome('t1', { usage: { input: 1_200, output: 340, total: 1_540, cost: 0.0123, currency: 'USD', Cost: 9, costPerToken: 0.0001, model: 'zz-model-name' } });
    const res = await request(rig.server.port, { path: '/api/turns', headers: rig.headers });
    const turns = (JSON.parse(res.body) as { turns: Array<Record<string, unknown>> }).turns;
    expect(turns[0]?.['usage']).toEqual({ input: 1_200, output: 340, total: 1_540 });
    expect(res.body).not.toContain('0.0123');
    expect(res.body).not.toContain('USD');
    expect(res.body).not.toContain('currency');
    expect(res.body).not.toContain('costPerToken');
    expect(res.body).not.toContain('zz-model-name');
  });

  it('lists pending interactions with their payload', async () => {
    const rig = await startRig();
    seedSession(rig);
    rig.registry.createTurn('s1', { id: 't1', prompt: [{ type: 'text', text: 'hi' }] });
    expect(rig.registry.startTurn('t1').ok).toBe(true);
    expect(rig.registry.addInteraction('t1', { id: 'i1', kind: 'question', payload: { question: 'pick one' } }).ok).toBe(true);
    const res = await request(rig.server.port, { path: '/api/interactions', headers: rig.headers });
    const interactions = (JSON.parse(res.body) as { interactions: Array<Record<string, unknown>> }).interactions;
    expect(interactions).toHaveLength(1);
    expect(interactions[0]).toMatchObject({ interactionId: 'i1', turnId: 't1', sessionId: 's1', kind: 'question', state: 'pending', payload: { question: 'pick one' } });
    expect(interactions[0]?.['expiresAt']).toBeTypeOf('string');
  });

  it('applies the §7.8 global whitelist in degraded mode on every route', async () => {
    const rig = await startRig({ exposeTranscripts: false });
    seedSession(rig);
    rig.registry.createTurn('s1', { id: 't1', prompt: [{ type: 'text', text: 'hi' }] });
    rig.registry.startTurn('t1');
    rig.registry.addInteraction('t1', { id: 'i1', kind: 'question', payload: { question: 'pick one' } });
    await rig.store.append(textEvent('r1', 1, 'secret body'));

    const sessions = await request(rig.server.port, { path: '/api/sessions', headers: rig.headers });
    expect(sessions.status).toBe(200);
    expect(sessions.body).not.toContain('main');
    expect(sessions.body).not.toContain('/work/project');
    const entry = (JSON.parse(sessions.body) as { sessions: Array<Record<string, unknown>> }).sessions[0]!;
    expect(entry).toMatchObject({ sessionId: 's1', engine: 'codex', state: 'busy' });
    expect(entry).not.toHaveProperty('name');
    expect(entry).not.toHaveProperty('cwd');
    expect(entry).not.toHaveProperty('permissionMode');

    const interactions = await request(rig.server.port, { path: '/api/interactions', headers: rig.headers });
    expect(interactions.body).not.toContain('pick one');
    expect((JSON.parse(interactions.body) as { interactions: Array<Record<string, unknown>> }).interactions[0]).not.toHaveProperty('payload');

    const events = await request(rig.server.port, { path: '/api/sessions/s1/events', headers: rig.headers });
    expect(events.status).toBe(200);
    expect(events.body).not.toContain('secret body');
    const page = JSON.parse(events.body) as { events: Array<Record<string, unknown>> };
    expect(page.events[0]).toEqual({ seq: 1, ts: 1_000, byteLen: page.events[0]!['byteLen'] });

    // Error bodies stay content-free as well.
    const missing = await request(rig.server.port, { path: '/api/sessions/nope', headers: rig.headers });
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body)).toEqual({ error: 'not_found' });
  });
});

describe('console events endpoint', () => {
  it('pages identically to the shared pagination core', async () => {
    const rig = await startRig();
    seedSession(rig);
    for (let seq = 1; seq <= 3; seq += 1) await rig.store.append(textEvent('r1', seq, `event ${seq}`));
    const res = await request(rig.server.port, { path: '/api/sessions/s1/events?afterSeq=0', headers: rig.headers });
    expect(res.status).toBe(200);
    const expected = await readTranscriptPage(rig.store, 'r1', 3, { afterSeq: 0, limit: 100, budgetBytes: rig.config.responseByteBudget });
    expect(JSON.parse(res.body)).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it('splits pages on the byte budget with identical nextSeq/hasMore', async () => {
    const budgetBytes = 2_048;
    const rig = await startRig({ budgetBytes });
    seedSession(rig);
    for (let seq = 1; seq <= 6; seq += 1) await rig.store.append(textEvent('r1', seq, 'x'.repeat(400)));
    const first = await request(rig.server.port, { path: '/api/sessions/s1/events?afterSeq=0', headers: rig.headers });
    const page1 = JSON.parse(first.body) as { events: unknown[]; nextSeq: number; highWatermark: number; hasMore: boolean };
    const expected1 = await readTranscriptPage(rig.store, 'r1', 6, { afterSeq: 0, limit: 100, budgetBytes });
    expect(page1).toEqual(JSON.parse(JSON.stringify(expected1)));
    expect(page1.hasMore).toBe(true);
    const second = await request(rig.server.port, { path: `/api/sessions/s1/events?afterSeq=${page1.nextSeq - 1}`, headers: rig.headers });
    const expected2 = await readTranscriptPage(rig.store, 'r1', 6, { afterSeq: page1.nextSeq - 1, limit: 100, budgetBytes });
    expect(JSON.parse(second.body)).toEqual(JSON.parse(JSON.stringify(expected2)));
  });

  it('answers an oversized event with the §9.4 reference, not the content', async () => {
    const rig = await startRig({ budgetBytes: 2_048 });
    seedSession(rig);
    await rig.store.append(textEvent('r1', 1, 'huge'.repeat(2_000)));
    const res = await request(rig.server.port, { path: '/api/sessions/s1/events?afterSeq=0', headers: rig.headers });
    expect(res.status).toBe(413);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body).toMatchObject({ error: 'payload_too_large', seq: 1, responseByteBudget: 2_048 });
    expect(body['totalBytes']).toBeGreaterThan(2_048);
    expect(body['sha256']).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body).not.toContain('huge');
  });

  it('404s unknown and deleted sessions, and empties a live session without events', async () => {
    const rig = await startRig();
    seedSession(rig);
    expect((await request(rig.server.port, { path: '/api/sessions/s1/events', headers: rig.headers })).body)
      .toBe(JSON.stringify({ events: [], nextSeq: 1, highWatermark: 0, hasMore: false }));
    expect((await request(rig.server.port, { path: '/api/sessions/nope/events', headers: rig.headers })).status).toBe(404);
    expect((await request(rig.server.port, { path: '/api/sessions/s1/events?afterSeq=later', headers: rig.headers })).status).toBe(400);
    // Deleted: the session record survives, but the transcript is gone (§5.4).
    await rig.store.append(textEvent('r1', 1, 'gone'));
    rig.deleted.add('r1');
    expect((await request(rig.server.port, { path: '/api/sessions/s1/events', headers: rig.headers })).status).toBe(404);
  });
});

describe('console SSE streams', () => {
  it('instance stream carries transitions and never transcript events', async () => {
    const rig = await startRig();
    seedSession(rig);
    const stream = openSse(rig.server.port, '/api/stream', rig.headers);
    await stream.ready;
    rig.registry.createTurn('s1', { id: 't1', prompt: [{ type: 'text', text: 'hi' }] });
    rig.registry.startTurn('t1');
    await rig.store.append(textEvent('r1', 1, 'live output'));
    await waitFor(() => stream.frames.some((frame) => frame.data['type'] === 'transition' && frame.data['to'] === 'running'));
    // Give any (forbidden) event frame a chance to arrive, then assert none did.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stream.frames.every((frame) => frame.data['type'] !== 'event')).toBe(true);
    const transition = stream.frames.find((frame) => frame.data['type'] === 'transition' && frame.data['kind'] === 'session')!;
    expect(transition.data).toMatchObject({ kind: 'session', sessionId: 's1' });
    expect(transition.id).toBeUndefined();
    stream.close();
    await stream.ended;
  });

  it('session stream backfills, then lives off the fan-out with zero store reads', async () => {
    const rig = await startRig();
    seedSession(rig);
    await rig.store.append(textEvent('r1', 1, 'first'));
    await rig.store.append(textEvent('r1', 2, 'second'));
    const spy = vi.spyOn(rig.store, 'read');
    const stream = openSse(rig.server.port, '/api/stream?sessionId=s1', rig.headers);
    await waitFor(() => stream.frames.filter((frame) => frame.data['type'] === 'event').length === 2);
    expect(stream.frames.map((frame) => frame.id)).toEqual(['1', '2']);
    expect(stream.frames[0]!.data).toMatchObject({ type: 'event', sessionId: 's1', seq: 1 });
    const readsAfterBackfill = spy.mock.calls.length;
    expect(readsAfterBackfill).toBeGreaterThan(0);

    // Steady state: the append fan-out carries the event; nothing re-reads SQLite.
    await rig.store.append(textEvent('r1', 3, 'third'));
    await waitFor(() => stream.frames.some((frame) => frame.id === '3'));
    expect(spy.mock.calls.length).toBe(readsAfterBackfill);
    const live = stream.frames.find((frame) => frame.id === '3')!;
    expect((live.data['event'] as Record<string, unknown>)['update']).toMatchObject({ sessionUpdate: 'agent_message_chunk' });
    stream.close();
    await stream.ended;
  });

  it('resumes from afterSeq and from Last-Event-ID', async () => {
    const rig = await startRig();
    seedSession(rig);
    for (let seq = 1; seq <= 3; seq += 1) await rig.store.append(textEvent('r1', seq, `e${seq}`));
    const byQuery = openSse(rig.server.port, '/api/stream?sessionId=s1&afterSeq=2', rig.headers);
    await waitFor(() => byQuery.frames.some((frame) => frame.id === '3'));
    expect(byQuery.frames.filter((frame) => frame.data['type'] === 'event').map((frame) => frame.id)).toEqual(['3']);
    byQuery.close();

    const byHeader = openSse(rig.server.port, '/api/stream?sessionId=s1', { ...rig.headers, 'last-event-id': '1' });
    await waitFor(() => byHeader.frames.some((frame) => frame.id === '3'));
    expect(byHeader.frames.filter((frame) => frame.data['type'] === 'event').map((frame) => frame.id)).toEqual(['2', '3']);
    byHeader.close();
  });

  it('caps streams at maxConsoleStreams with 503 and keeps established ones flowing', async () => {
    const rig = await startRig({ maxConsoleStreams: 1 });
    seedSession(rig);
    const first = openSse(rig.server.port, '/api/stream', rig.headers);
    await first.ready;
    const rejected = await request(rig.server.port, { path: '/api/stream?sessionId=s1', headers: rig.headers });
    expect(rejected.status).toBe(503);
    expect(JSON.parse(rejected.body)).toEqual({ error: 'stream_limit' });
    // The established connection is unaffected (CONSOLE-015).
    rig.registry.createTurn('s1', { id: 't1', prompt: [{ type: 'text', text: 'hi' }] });
    rig.registry.startTurn('t1');
    await waitFor(() => first.frames.some((frame) => frame.data['type'] === 'transition'));
    first.close();
    await first.ended;
    // The released slot is reusable.
    const second = await request(rig.server.port, { path: '/api/stream?sessionId=nope', headers: rig.headers });
    expect(second.status).toBe(404);
  });

  it('sends invalidated before closing when the transcript is deleted, then 404s', async () => {
    const rig = await startRig();
    seedSession(rig);
    await rig.store.append(textEvent('r1', 1, 'doomed'));
    const stream = openSse(rig.server.port, '/api/stream?sessionId=s1', rig.headers);
    await waitFor(() => stream.frames.some((frame) => frame.id === '1'));

    rig.deleted.add('r1');
    await rig.store.delete('r1');
    await stream.ended;
    const last = stream.frames.at(-1)!;
    expect(last.data).toEqual({ type: 'invalidated', sessionId: 's1' });
    expect((await request(rig.server.port, { path: '/api/sessions/s1/events', headers: rig.headers })).status).toBe(404);
    // A fresh stream to a deleted session is refused before any connection (§6).
    expect((await request(rig.server.port, { path: '/api/stream?sessionId=s1', headers: rig.headers })).status).toBe(404);
  });

  it('carries engine crashes as instance-level frames', async () => {
    const rig = await startRig();
    const stream = openSse(rig.server.port, '/api/stream', rig.headers);
    await stream.ready;
    rig.dataSource.notifyEngineCrash('codex');
    await waitFor(() => stream.frames.some((frame) => frame.data['type'] === 'engine_crash'));
    expect(stream.frames[0]!.data).toEqual({ type: 'engine_crash', engine: 'codex' });
    stream.close();
    await stream.ended;
  });
});

describe('console backfill store failures', () => {
  /**
   * `highWatermark` throws NotFoundError for a transcript that is not there —
   * deleted, or a live session that has not appended yet. Every other store
   * failure means something is wrong, and swallowing it would put the
   * subscriber into a live stream that had silently skipped history. A stream
   * that looks healthy and is missing events is worse than one that closed and
   * can be resumed from Last-Event-ID.
   */
  it('ends the stream on a store failure instead of going live having skipped events', async () => {
    const rig = await startRig();
    const session = rig.registry.createSession({ engine: 'codex', cwd: '/tmp', permissionMode: 'ask-orchestrator' });
    const sessionId = (session as { value?: { id: string } }).value?.id ?? (session as unknown as { id: string }).id;

    const broken = new Error('sqlite is unhappy');
    const original = rig.store.highWatermark.bind(rig.store);
    (rig.store as unknown as { highWatermark: unknown }).highWatermark = async () => { throw broken; };
    try {
      const frames: unknown[] = [];
      let ended = false;
      await expect(rig.dataSource.openStream({
        sessionId,
        afterSeq: 0,
        sink: { send: (frame) => frames.push(frame), end: () => { ended = true; } },
      })).rejects.toBe(broken);
      // The failure is reported by throwing, not by quietly finishing: the
      // caller owns the response and ends it.
      expect(ended).toBe(false);
      expect(frames).toEqual([]);
    } finally {
      (rig.store as unknown as { highWatermark: unknown }).highWatermark = original;
    }
  });

  it('treats a transcript that is simply absent as nothing to backfill', async () => {
    const rig = await startRig();
    const session = rig.registry.createSession({ engine: 'codex', cwd: '/tmp', permissionMode: 'ask-orchestrator' });
    const sessionId = (session as { value?: { id: string } }).value?.id ?? (session as unknown as { id: string }).id;
    // No event has ever been appended for this session, so highWatermark
    // rejects with NotFoundError — which is not an error condition here.
    const unsubscribe = await rig.dataSource.openStream({
      sessionId,
      afterSeq: 0,
      sink: { send: () => undefined, end: () => undefined },
    });
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
  });
});

describe('seq query parameters (§5.1 cursors)', () => {
  /**
   * `Number()` accepts far more than a seq: the regression pinned here is a
   * server that invented a cursor from text the client never wrote — `0x10`
   * became 16, `1e3` became 1000, and an empty `?afterSeq=` became "from the
   * beginning". The client then got a page it never asked for with no way to
   * tell, which is worse than the 400 these produce.
   */
  const REJECTED = ['0x10', '1e3', ' 5', '5 ', '', '+5', '5.0', '-1', 'later', 'Infinity', '9007199254740993'];

  it('rejects everything that is not plain decimal digits, on every seq parameter', async () => {
    const rig = await startRig();
    seedSession(rig);
    for (const raw of REJECTED) {
      const value = encodeURIComponent(raw);
      for (const path of [
        `/api/sessions/s1/events?afterSeq=${value}`,
        `/api/sessions/s1/events?afterSeq=0&toSeq=${value}`,
        `/api/sessions/s1/diffs?afterSeq=${value}`,
        `/api/stream?afterSeq=${value}`,
      ]) {
        const res = await request(rig.server.port, { path, headers: rig.headers });
        expect(`${path} → ${res.status}`).toBe(`${path} → 400`);
      }
    }
  });

  it('still accepts a plain cursor and an absent one', async () => {
    const rig = await startRig();
    seedSession(rig);
    for (const path of ['/api/sessions/s1/events?afterSeq=0', '/api/sessions/s1/events?afterSeq=7', '/api/sessions/s1/events']) {
      expect((await request(rig.server.port, { path, headers: rig.headers })).status).toBe(200);
    }
  });
});

describe('session failure projection (ADR 0029, CONSOLE-041)', () => {
  const failure = {
    code: 'ENGINE_ERROR' as const,
    message: "engine 'kimi' operation 'session/prompt' failed",
    cause: {
      name: 'EngineOperationError',
      message: "engine 'kimi' operation 'session/prompt' failed",
      operation: 'session/create',
      kind: 'rate-limit',
    },
  };

  it('carries a new cause field in full mode without a console change', async () => {
    const rig = await startRig();
    seedSession(rig);
    expect(rig.registry.markSessionFailed('s1', failure).ok).toBe(true);
    const res = await request(rig.server.port, { path: '/api/sessions', headers: rig.headers });
    const sessions = (JSON.parse(res.body) as { sessions: Array<Record<string, unknown>> }).sessions;
    // The envelope leaves whole, which is why the console needs no change when
    // the cause projection gains a field — and why the degraded case below is
    // the boundary that actually has to be pinned.
    expect(sessions[0]?.['failure']).toEqual(failure);
  });

  it('keeps the degraded boundary at the code alone', async () => {
    const rig = await startRig({ exposeTranscripts: false });
    seedSession(rig);
    expect(rig.registry.markSessionFailed('s1', failure).ok).toBe(true);
    const res = await request(rig.server.port, { path: '/api/sessions', headers: rig.headers });
    // Widening this branch to pass the cause through is the mutation this case
    // exists to catch: the message and the classification stay behind.
    expect((JSON.parse(res.body) as { sessions: Array<Record<string, unknown>> }).sessions[0]?.['failure'])
      .toEqual({ code: 'ENGINE_ERROR' });
    expect(res.body).not.toContain('rate-limit');
    expect(res.body).not.toContain('session/prompt');
  });
});

describe('session usage and observed config projection (ADR 0020, §6.1/§6.2, CONSOLE-036..038)', () => {
  it('projectUsageBlock is the shared pure filter unit (design §8.4)', () => {
    const usage = { input: 1_200, output: 340, total: 1_540, cost: 0.0123, currency: 'USD', Cost: 9, costPerToken: 0.0001, model: 'zz-model' };
    // Full mode: the block leaves verbatim, cost included.
    expect(projectUsageBlock(usage, true)).toEqual(usage);
    // Degraded mode: only the enumerated count keys with finite numeric values
    // leave — money by name (cost/currency), money by another name (costPerToken),
    // a case variant (Cost) and a string (model) all stay behind (§7.8).
    expect(projectUsageBlock(usage, false)).toEqual({ input: 1_200, output: 340, total: 1_540 });
    // A count key carrying a string is not a count and never leaves.
    expect(projectUsageBlock({ total: 'many' }, false)).toEqual({});
  });

  it('CONSOLE-036 projects session cumulative usage on /api/sessions, verbatim in full mode', async () => {
    const rig = await startRig();
    seedSession(rig);
    const usage = { input: 1_200, output: 340, total: 1_540, cost: 0.0123, currency: 'USD' };
    rig.registry.updateSessionObservations('s1', { usage });
    const res = await request(rig.server.port, { path: '/api/sessions', headers: rig.headers });
    const sessions = (JSON.parse(res.body) as { sessions: Array<Record<string, unknown>> }).sessions;
    expect(sessions[0]?.['usage']).toEqual(usage);
    // The detail route reads the same record, so it agrees with the list.
    const detail = await request(rig.server.port, { path: '/api/sessions/s1', headers: rig.headers });
    expect((JSON.parse(detail.body) as Record<string, unknown>)['usage']).toEqual(usage);
  });

  it('CONSOLE-037 degrades session usage by the same whitelist the turns route applies', async () => {
    const rig = await startRig({ exposeTranscripts: false });
    seedSession(rig);
    const usage = { input: 1_200, output: 340, total: 1_540, cost: 0.0123, currency: 'USD', Cost: 9, costPerToken: 0.0001, model: 'zz-model' };
    rig.registry.updateSessionObservations('s1', { usage });
    rig.registry.createTurn('s1', { id: 't1', prompt: [{ type: 'text', text: 'hi' }] });
    rig.registry.setTurnOutcome('t1', { usage });

    const sessions = await request(rig.server.port, { path: '/api/sessions', headers: rig.headers });
    const sessionUsage = (JSON.parse(sessions.body) as { sessions: Array<Record<string, unknown>> }).sessions[0]?.['usage'];
    const turns = await request(rig.server.port, { path: '/api/turns', headers: rig.headers });
    const turnUsage = (JSON.parse(turns.body) as { turns: Array<Record<string, unknown>> }).turns[0]?.['usage'];
    // Same input, same output on both faces — behaviorally identical (design
    // §8.4); the structural sharing of one whitelist is code-review-guaranteed.
    expect(sessionUsage).toEqual({ input: 1_200, output: 340, total: 1_540 });
    expect(sessionUsage).toEqual(turnUsage);
    expect(sessions.body).not.toContain('0.0123');
    expect(sessions.body).not.toContain('costPerToken');
    expect(sessions.body).not.toContain('zz-model');
  });

  it('CONSOLE-038 omits observedConfig entirely in degraded mode and carries it in full mode', async () => {
    const observedConfig = { model: { value: 'sonnet', source: 'config_option_update' as const, observedAt: '2026-01-01T00:00:00.000Z' } };
    const full = await startRig();
    seedSession(full);
    full.registry.updateSessionObservations('s1', { observedConfig });
    const fullSessions = await request(full.server.port, { path: '/api/sessions', headers: full.headers });
    expect((JSON.parse(fullSessions.body) as { sessions: Array<Record<string, unknown>> }).sessions[0]?.['observedConfig']).toEqual(observedConfig);

    const degraded = await startRig({ exposeTranscripts: false });
    seedSession(degraded);
    degraded.registry.updateSessionObservations('s1', { observedConfig });
    const degradedSessions = await request(degraded.server.port, { path: '/api/sessions', headers: degraded.headers });
    expect((JSON.parse(degradedSessions.body) as { sessions: Array<Record<string, unknown>> }).sessions[0]).not.toHaveProperty('observedConfig');
    // No key or value leaks: neither the key nor the model name appears.
    expect(degradedSessions.body).not.toContain('observedConfig');
    expect(degradedSessions.body).not.toContain('sonnet');

    // §7.8 is a property of every route, not of one. All three session-bearing
    // routes share projectSession, so the guard is structural — but topology
    // spreads that projection and adds its own key, which is exactly where a
    // later field would slip past the shared guard. Assert the routes, so that
    // slip fails a test instead of only a review.
    for (const path of ['/api/sessions/s1', '/api/topology']) {
      const res = await request(degraded.server.port, { path, headers: degraded.headers });
      expect(res.status).toBe(200);
      expect(res.body).not.toContain('observedConfig');
      expect(res.body).not.toContain('sonnet');
    }
  });
});
