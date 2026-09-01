import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptEvent } from 'runskein';

import { ConsoleDataSource } from '../../packages/plugin/src/console/data-source.js';
import { DIFF_INDEX_LIMIT, DiffIndex, diffIndexEntryOutput } from '../../packages/plugin/src/console/diff-index.js';
import { ConsoleServer } from '../../packages/plugin/src/console/server.js';
import { diffLines } from '../../packages/plugin/src/console/ui/diff-lines.js';
import type { InstanceManifest } from '../../packages/plugin/src/lifecycle.js';
import { resolvePluginConfig, type ConsoleConfig, type PluginConfig } from '../../packages/plugin/src/plugin-config.js';
import { SessionRegistry, type RegistryObserver } from '../../packages/core/src/registry.js';
import type { PluginTranscriptStore } from '../../packages/plugin/src/store/plugin-transcript-store.js';
import { createPluginTranscriptStore } from '../../packages/plugin/src/store/plugin-transcript-store.js';

/**
 * The diff index of console-v2 §3.1 and its §3.5 lifecycle: maintained on the
 * append fan-out, rebuilt by one on-demand scan when the index has no
 * authoritative state (restart/archive), falling back to per-request scans
 * past the per-session cap — never a silently truncated list — and cleared
 * with transcript_delete (§5.4).
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

function event(sessionId: string, seq: number, update: Record<string, unknown>): TranscriptEvent {
  return { seq, ts: seq * 1_000, sessionId, engineId: 'codex', update: update as unknown as TranscriptEvent['update'] };
}

function toolCall(sessionId: string, seq: number, toolCallId: string, extra: Record<string, unknown>): TranscriptEvent {
  return event(sessionId, seq, { sessionUpdate: 'tool_call', toolCallId, ...extra });
}

function toolUpdate(sessionId: string, seq: number, toolCallId: string, extra: Record<string, unknown>): TranscriptEvent {
  return event(sessionId, seq, { sessionUpdate: 'tool_call_update', toolCallId, ...extra });
}

function textChunk(sessionId: string, seq: number, text: string): TranscriptEvent {
  return event(sessionId, seq, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
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

function testConfig(consoleOverrides: Partial<ConsoleConfig> = {}): PluginConfig {
  return resolvePluginConfig({ allowedRoots: [tmpdir()], console: { enabled: true, ...consoleOverrides } });
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

function wireDataSource(config: PluginConfig, registry: SessionRegistry, store: PluginTranscriptStore, deleted: Set<string>): ConsoleDataSource {
  return new ConsoleDataSource({
    config,
    registry,
    store,
    instance: () => manifest,
    engines: async () => ['codex'],
    isTranscriptDeleted: (realmSessionId) => deleted.has(realmSessionId),
    isVisible: () => true,
  });
}

async function startRig(options: { exposeTranscripts?: boolean } = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'taskshuttle-console-diffs-'));
  const config = testConfig({ exposeTranscripts: options.exposeTranscripts ?? true });
  let target: RegistryObserver | undefined;
  const forwarding: RegistryObserver = {
    onSessionTransition: (event) => target?.onSessionTransition?.(event),
    onTurnTransition: (event) => target?.onTurnTransition?.(event),
    onInteractionTransition: (event) => target?.onInteractionTransition?.(event),
  };
  const registry = new SessionRegistry({ instanceId: manifest.instanceId, observer: forwarding });
  const store = createPluginTranscriptStore(join(dir, 'taskshuttle.sqlite'));
  const deleted = new Set<string>();
  const dataSource = wireDataSource(config, registry, store, deleted);
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

interface DiffPage {
  diffs: Array<Record<string, unknown>>;
  nextSeq: number;
  highWatermark: number;
  hasMore: boolean;
}

/** One page of the route (§3.1 pages like every other content route). */
async function fetchDiffs(rig: Rig, afterSeq?: number): Promise<DiffPage> {
  const res = await request(rig.server.port, {
    path: `/api/sessions/s1/diffs${afterSeq === undefined ? '' : `?afterSeq=${afterSeq}`}`,
    headers: rig.headers,
  });
  expect(res.status).toBe(200);
  return JSON.parse(res.body) as DiffPage;
}

/** The whole index, paged to its end — what the UI's diff view does. */
async function fetchAllDiffs(rig: Rig): Promise<Array<Record<string, unknown>>> {
  const diffs: Array<Record<string, unknown>> = [];
  let afterSeq = 0;
  for (;;) {
    const page = await fetchDiffs(rig, afterSeq);
    diffs.push(...page.diffs);
    if (!page.hasMore) return diffs;
    expect(page.nextSeq - 1).toBeGreaterThan(afterSeq);
    afterSeq = page.nextSeq - 1;
  }
}

describe('diff index route (§3.1)', () => {
  it('indexes diffs on append, correlates later status, and counts with the UI’s LCS', async () => {
    const rig = await startRig();
    seedSession(rig);
    const oldText = 'a\nb\nc';
    const newText = 'a\nx\nc';
    await rig.store.append(toolCall('r1', 1, 'tc1', { title: 'Edit', kind: 'edit', status: 'in_progress', content: [{ type: 'diff', path: 'src/a.ts', oldText, newText }] }));
    await rig.store.append(textChunk('r1', 2, 'unrelated'));
    await rig.store.append(toolUpdate('r1', 3, 'tc1', { status: 'completed' }));

    // A warm index answers without touching the store's read path (§3.1).
    const spy = vi.spyOn(rig.store, 'read');
    const body = await fetchDiffs(rig);
    expect(spy).not.toHaveBeenCalled();
    expect(body.highWatermark).toBe(3);
    const lines = diffLines(oldText, newText);
    expect(body.diffs).toEqual([
      {
        seq: 1,
        tool: 'Edit',
        path: 'src/a.ts',
        adds: lines.filter((line) => line.t === 'add').length,
        dels: lines.filter((line) => line.t === 'del').length,
        status: 'completed',
        // ADR 0021: every entry states where it came from, and its position in
        // the carrying event. A native block is 'engine'.
        origin: 'engine',
        part: 0,
      },
    ]);
    expect(body.diffs[0]).toMatchObject({ adds: 1, dels: 1 });

    // afterSeq filters the index like the events cursor.
    expect((await fetchDiffs(rig, 1)).diffs).toEqual([]);
    expect((await fetchDiffs(rig, 0)).diffs).toHaveLength(1);
  });

  it('prefers the tool name over its title, keeps every diff of a call, and recalls the label on a content-only update', async () => {
    const rig = await startRig();
    seedSession(rig);
    await rig.store.append(
      toolCall('r1', 1, 'tc1', {
        title: 'Write file',
        name: 'fs_write',
        status: 'completed',
        content: [
          { type: 'diff', path: 'x.ts', oldText: '', newText: 'new' },
          { type: 'diff', path: 'y.ts', oldText: 'a\nb', newText: 'a' },
        ],
      }),
    );
    await rig.store.append(toolCall('r1', 2, 'tc2', { title: 'Edit', status: 'in_progress' }));
    await rig.store.append(toolUpdate('r1', 3, 'tc2', { status: 'completed', content: [{ type: 'diff', path: 'z.ts', oldText: 'old', newText: 'new' }] }));

    const body = await fetchDiffs(rig);
    expect(body.diffs).toEqual([
      // `part` tells the two diffs of one event apart — without it they share
      // a seq, and two same-path diffs would collapse into one row (ADR 0021).
      { seq: 1, tool: 'fs_write', path: 'x.ts', adds: 1, dels: 1, status: 'completed', origin: 'engine', part: 0 },
      { seq: 1, tool: 'fs_write', path: 'y.ts', adds: 0, dels: 1, status: 'completed', origin: 'engine', part: 1 },
      // The update carried no title; the index recalls it from the tool_call.
      { seq: 3, tool: 'Edit', path: 'z.ts', adds: 1, dels: 1, status: 'completed', origin: 'engine', part: 0 },
    ]);
  });

  it('rebuilds a diff from edit parameters when the engine sent no diff block', async () => {
    // The shape two engines actually use: no diff content anywhere, the edit
    // sitting in rawInput, and the call never reaching a terminal status.
    const rig = await startRig();
    seedSession(rig);
    await rig.store.append(
      toolCall('r1', 1, 'tc1', {
        title: 'edit',
        kind: 'edit',
        status: 'pending',
        rawInput: { path: 'src/a.ts', edits: [{ oldText: 'one\ntwo', newText: 'one\n2' }] },
        locations: [{ path: 'src/a.ts' }],
      }),
    );
    const body = await fetchDiffs(rig);
    expect(body.diffs).toEqual([
      { seq: 1, tool: 'edit', path: 'src/a.ts', adds: 1, dels: 1, status: 'pending', origin: 'reconstructed', part: 0 },
    ]);
  });

  it('drops what it rebuilt once the engine states a diff of its own', async () => {
    // The summary sums every entry without looking at origin, so leaving both
    // would not add a row — it would report twice the lines actually changed.
    const rig = await startRig();
    seedSession(rig);
    await rig.store.append(
      toolCall('r1', 1, 'tc1', { title: 'edit', status: 'pending', rawInput: { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] } }),
    );
    await rig.store.append(
      toolUpdate('r1', 2, 'tc1', { status: 'completed', content: [{ type: 'diff', path: 'a.ts', oldText: 'x', newText: 'y' }] }),
    );
    const body = await fetchDiffs(rig);
    expect(body.diffs).toHaveLength(1);
    expect(body.diffs[0]).toMatchObject({ seq: 2, origin: 'engine' });

    // And the latch holds: a later rawInput does not start rebuilding again.
    await rig.store.append(toolUpdate('r1', 3, 'tc1', { rawInput: { path: 'a.ts', edits: [{ oldText: 'p', newText: 'q' }] } }));
    expect((await fetchDiffs(rig)).diffs).toHaveLength(1);
  });

  it('restates the same rawInput without dealing a second row', async () => {
    // Not defensive coding: on this machine 28 opencode edit calls produced 36
    // patchText events, the extra 8 being the same patch sent again.
    const rig = await startRig();
    seedSession(rig);
    const rawInput = { patchText: '*** Begin Patch\n*** Update File: a.ts\n+added\n*** End Patch' };
    await rig.store.append(toolCall('r1', 1, 'tc1', { title: 'patch', status: 'pending' }));
    await rig.store.append(toolUpdate('r1', 2, 'tc1', { status: 'in_progress', rawInput }));
    await rig.store.append(toolUpdate('r1', 3, 'tc1', { status: 'in_progress', rawInput }));
    const body = await fetchDiffs(rig);
    expect(body.diffs).toHaveLength(1);
    // dels counts the empty old side as one line, exactly as a native diff of a
    // newly created file already does here — the reconstruction inherits the
    // shared diffLines convention rather than inventing a second one.
    expect(body.diffs[0]).toMatchObject({ seq: 2, path: 'a.ts', adds: 1, dels: 1, origin: 'reconstructed' });
  });

  it('recomputes a call as a whole set, so a hunk that disappears leaves the page', async () => {
    const rig = await startRig();
    seedSession(rig);
    await rig.store.append(
      toolCall('r1', 1, 'tc1', {
        title: 'edit',
        status: 'pending',
        rawInput: { path: 'a.ts', edits: [{ oldText: 'a', newText: 'A' }, { oldText: 'b', newText: 'B' }] },
      }),
    );
    expect((await fetchDiffs(rig)).diffs).toHaveLength(2);

    await rig.store.append(
      toolUpdate('r1', 2, 'tc1', { rawInput: { path: 'a.ts', edits: [{ oldText: 'a', newText: 'A' }] } }),
    );
    const body = await fetchDiffs(rig);
    // Patching per part would have left the second hunk behind — an edit the
    // engine no longer claims to be making.
    expect(body.diffs).toHaveLength(1);
    expect(body.diffs.every((entry) => entry['seq'] === 2)).toBe(true);
  });

  it('states a deleted file without claiming a line count', async () => {
    const rig = await startRig();
    seedSession(rig);
    await rig.store.append(
      toolCall('r1', 1, 'tc1', {
        title: 'patch',
        status: 'in_progress',
        rawInput: { patchText: '*** Begin Patch\n*** Delete File: gone.ts\n*** End Patch' },
      }),
    );
    const body = await fetchDiffs(rig);
    // The entry exists so the file is not missing from the page; the counts are
    // zero and `deleted` is what tells the UI not to render them as a number.
    expect(body.diffs).toEqual([
      { seq: 1, tool: 'patch', path: 'gone.ts', adds: 0, dels: 0, status: 'in_progress', origin: 'reconstructed', part: 0, deleted: true },
    ]);
  });

  it('gives the same index whether built incrementally or rescanned', async () => {
    // The rescan path (restart, archive) replays events in seq order. Every
    // rule here depends only on what has been seen so far, so the two must
    // converge — a page that changes on refresh is the worst kind of bug here.
    const rig = await startRig();
    seedSession(rig);
    await rig.store.append(
      toolCall('r1', 1, 'tc1', { title: 'edit', status: 'pending', rawInput: { path: 'a.ts', edits: [{ oldText: 'a', newText: 'A' }] } }),
    );
    await rig.store.append(
      toolUpdate('r1', 2, 'tc1', { rawInput: { path: 'a.ts', edits: [{ oldText: 'a', newText: 'AA' }] } }),
    );
    await rig.store.append(
      toolCall('r1', 3, 'tc2', { title: 'w', status: 'completed', content: [{ type: 'diff', path: 'b.ts', oldText: '', newText: 'x' }] }),
    );
    const incremental = (await fetchDiffs(rig)).diffs;

    const rescanned = new DiffIndex();
    for await (const event of rig.store.read('r1')) rescanned.addEvent(event);
    expect(rescanned.entries.map(diffIndexEntryOutput)).toEqual(incremental);
  });

  it('404s unknown sessions and 400s a malformed cursor', async () => {
    const rig = await startRig();
    seedSession(rig);
    expect((await request(rig.server.port, { path: '/api/sessions/nope/diffs', headers: rig.headers })).status).toBe(404);
    expect((await request(rig.server.port, { path: '/api/sessions/s1/diffs?afterSeq=later', headers: rig.headers })).status).toBe(400);
    // A live session without events is the empty index.
    expect(await fetchDiffs(rig)).toEqual({ diffs: [], nextSeq: 1, highWatermark: 0, hasMore: false });
  });
});

describe('diff index lifecycle (§3.5)', () => {
  it('rebuilds an unknown session’s index with one on-demand scan (restart / archive)', async () => {
    const rig = await startRig();
    seedSession(rig);
    await rig.store.append(toolCall('r1', 1, 'tc1', { title: 'Edit', status: 'completed', content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' }] }));
    await rig.store.append(textChunk('r1', 2, 'filler'));

    // A fresh data source over the same store — the process-restart shape: no
    // index state, so the first request scans the session's events once.
    const restarted = wireDataSource(rig.config, rig.registry, rig.store, rig.deleted);
    const spy = vi.spyOn(rig.store, 'read');
    const first = await restarted.readDiffs('s1', 0);
    expect(first.diffs).toEqual([
      { seq: 1, tool: 'Edit', path: 'src/a.ts', adds: 1, dels: 1, status: 'completed', origin: 'engine', part: 0 },
    ]);
    expect(first.highWatermark).toBe(2);
    expect(spy).toHaveBeenCalledTimes(1);
    // The scan result fits the cap, so it is cached: the second request is free.
    const second = await restarted.readDiffs('s1', 0);
    expect(second).toEqual(first);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('past the per-session cap the session scans on demand instead of serving a truncated list', async () => {
    // The cap trip itself, at unit level.
    const index = new DiffIndex(3);
    for (let seq = 1; seq <= 4; seq += 1) {
      index.addEvent(toolCall('r1', seq, `tc${seq}`, { title: 'Edit', status: 'completed', content: [{ type: 'diff', path: `f${seq}.ts`, oldText: 'a', newText: 'b' }] }));
    }
    expect(index.overflow).toBe(true);
    expect(index.size).toBeLessThanOrEqual(3);

    // A session whose index has overflowed answers with the honest full list
    // from a scan — all four diffs, not the three the index retained. The scan
    // itself fits the real cap (4 ≤ DIFF_INDEX_LIMIT), so it is cached and the
    // session is healed rather than marked for per-request scans.
    const rig = await startRig();
    seedSession(rig);
    for (let seq = 1; seq <= 4; seq += 1) {
      await rig.store.append(toolCall('r1', seq, `tc${seq}`, { title: 'Edit', status: 'completed', content: [{ type: 'diff', path: `f${seq}.ts`, oldText: 'a', newText: 'b' }] }));
    }
    const internals = rig.dataSource as unknown as {
      diffIndexes: Map<string, { index: DiffIndex; complete: boolean }>;
      diffOverflow: Set<string>;
    };
    internals.diffIndexes.set('r1', { index, complete: true });
    const body = await fetchDiffs(rig);
    expect(body.diffs.map((entry) => entry['seq'])).toEqual([1, 2, 3, 4]);
    expect(internals.diffOverflow.has('r1')).toBe(false);
  });

  it('a session genuinely past the cap scans on every request — never a truncated shortlist', async () => {
    const rig = await startRig();
    seedSession(rig);
    const total = DIFF_INDEX_LIMIT + 1;
    for (let seq = 1; seq <= total; seq += 1) {
      await rig.store.append(toolCall('r1', seq, `tc${seq}`, { title: 'Edit', status: 'completed', content: [{ type: 'diff', path: `f${seq}.ts`, oldText: 'a', newText: 'b' }] }));
    }
    const internals = rig.dataSource as unknown as { diffOverflow: Set<string> };
    // The append path itself tripped the cap: the session already scans.
    expect(internals.diffOverflow.has('r1')).toBe(true);
    const spy = vi.spyOn(rig.store, 'read');
    // Paged, not truncated: the whole list is reachable, one budgeted page at
    // a time. A short first page is the honest answer §3.5 asks for; a short
    // list claiming to be complete is the failure it forbids.
    const firstPage = await fetchDiffs(rig);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.diffs.length).toBeLessThan(total);
    const first = await fetchAllDiffs(rig);
    expect(first).toHaveLength(total);
    expect(first.at(-1)).toMatchObject({ seq: total, path: `f${total}.ts` });
    const second = await fetchAllDiffs(rig);
    expect(second).toHaveLength(total);
    // No caching of an over-cap result: every request paid the scan.
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it('an append landing mid-scan is drained into the index before it installs', async () => {
    const rig = await startRig();
    seedSession(rig);
    await rig.store.append(toolCall('r1', 1, 'tc1', { title: 'Edit', status: 'completed', content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' }] }));

    // A fresh data source over the same store — the restart shape that forces
    // the on-demand scan. The gate parks the scan after its first event; the
    // store's read contract (the write tail is captured at invocation time)
    // guarantees the resumed stream cannot observe the append, so the race is
    // constructed deterministically rather than by timing luck.
    const restarted = wireDataSource(rig.config, rig.registry, rig.store, rig.deleted);
    const originalRead = rig.store.read.bind(rig.store);
    let firstYield!: () => void;
    let resume!: () => void;
    const firstSeen = new Promise<void>((resolve) => { firstYield = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let wrapped = false;
    const spy = vi.spyOn(rig.store, 'read').mockImplementation(((sessionId: string, opts?: { fromSeq?: number; toSeq?: number }) => {
      const stream = originalRead(sessionId, opts);
      if (wrapped || opts !== undefined) return stream; // only the initial full scan is gated
      wrapped = true;
      return (async function* () {
        let count = 0;
        for await (const event of stream) {
          yield event;
          count += 1;
          if (count === 1) {
            firstYield();
            await gate; // parked mid-scan: the append below lands now
          }
        }
      })();
    }) as typeof rig.store.read);

    const pending = restarted.readDiffs('s1', 0);
    await firstSeen;
    // Mid-scan append: invisible to the scan's snapshot, and the restarted
    // data source's append path never saw seq 1, so no complete index could
    // have picked it up either. Only the drain can deliver it.
    await rig.store.append(toolCall('r1', 2, 'tc2', { title: 'Edit', status: 'completed', content: [{ type: 'diff', path: 'src/b.ts', oldText: 'x', newText: 'y' }] }));
    resume();
    const body = await pending;
    expect(body.diffs.map((entry) => entry['seq'])).toEqual([1, 2]);
    expect(body.highWatermark).toBe(2);
    // The mid-scan append is in the INSTALLED index too: the next request
    // answers both from cache, with no second scan.
    spy.mockClear();
    const second = await restarted.readDiffs('s1', 0);
    expect(second.diffs.map((entry) => entry['seq'])).toEqual([1, 2]);
    expect(spy).not.toHaveBeenCalled();
    const internals = restarted as unknown as { diffIndexes: Map<string, { complete: boolean }> };
    expect(internals.diffIndexes.get('r1')?.complete).toBe(true);
  });

  it('a transcript deleted mid-scan installs nothing and serves the empty index', async () => {
    const rig = await startRig();
    seedSession(rig);
    await rig.store.append(toolCall('r1', 1, 'tc1', { title: 'Edit', status: 'completed', content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' }] }));
    const restarted = wireDataSource(rig.config, rig.registry, rig.store, rig.deleted);
    const originalRead = rig.store.read.bind(rig.store);
    let firstYield!: () => void;
    let resume!: () => void;
    const firstSeen = new Promise<void>((resolve) => { firstYield = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let wrapped = false;
    vi.spyOn(rig.store, 'read').mockImplementation(((sessionId: string, opts?: { fromSeq?: number; toSeq?: number }) => {
      const stream = originalRead(sessionId, opts);
      if (wrapped || opts !== undefined) return stream;
      wrapped = true;
      return (async function* () {
        let count = 0;
        for await (const event of stream) {
          yield event;
          count += 1;
          if (count === 1) {
            firstYield();
            await gate;
          }
        }
      })();
    }) as typeof rig.store.read);

    const pending = restarted.readDiffs('s1', 0);
    await firstSeen;
    await rig.store.delete('r1');
    resume();
    // The drain's re-read doubles as the delete re-check: the scan's partial
    // result is discarded with the transcript, nothing is installed.
    expect(await pending).toEqual({ diffs: [], nextSeq: 1, highWatermark: 0, hasMore: false });
    const internals = restarted as unknown as { diffIndexes: Map<string, unknown> };
    expect(internals.diffIndexes.has('r1')).toBe(false);
  });

  it('an append that commits after the drain read its watermark is not lost by the install (GZH-42)', async () => {
    const rig = await startRig();
    seedSession(rig);
    await rig.store.append(toolCall('r1', 1, 'tc1', { title: 'Edit', status: 'completed', content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' }] }));
    const restarted = wireDataSource(rig.config, rig.registry, rig.store, rig.deleted);
    rig.store.onChange(restarted.storeListener);

    // The window the drain does NOT close. `highWatermark` awaits the append
    // chain it captured and then reads the watermark map synchronously, so an
    // append registered against that same chain commits *after* the value was
    // read and *before* readDiffs resumes: its fan-out finds the still
    // incomplete append-path index and drops it, and the scan then installs an
    // index that omits it and is trusted from then on. Injecting the append
    // between the read and the return is exactly that schedule, made
    // deterministic — the drain's watermark call, not the opening one, whose
    // value is read before the scan even starts.
    const realWatermark = rig.store.highWatermark.bind(rig.store);
    let calls = 0;
    vi.spyOn(rig.store, 'highWatermark').mockImplementation(async (sessionId: string) => {
      const watermark = await realWatermark(sessionId);
      calls += 1;
      if (calls === 2) {
        await rig.store.append(toolCall('r1', 2, 'tc2', { title: 'Edit', status: 'completed', content: [{ type: 'diff', path: 'src/b.ts', oldText: 'x', newText: 'y' }] }));
      }
      return watermark;
    });

    const body = await restarted.readDiffs('s1', 0);
    expect(body.diffs.map((entry) => entry['seq'])).toEqual([1, 2]);
    // Permanence is the actual defect: the installed index is `complete`, so
    // nothing rescans, and a missing entry never comes back on its own.
    const second = await restarted.readDiffs('s1', 0);
    expect(second.diffs.map((entry) => entry['seq'])).toEqual([1, 2]);
  });

  it('a transcript deleted after the drain read its watermark is not resurrected by the install (GZH-42)', async () => {
    const rig = await startRig();
    seedSession(rig);
    await rig.store.append(toolCall('r1', 1, 'tc1', { title: 'Edit', status: 'completed', content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' }] }));
    const restarted = wireDataSource(rig.config, rig.registry, rig.store, rig.deleted);
    rig.store.onChange(restarted.storeListener);

    // Same window as the append case, the other consequence: the delete lands
    // after the drain's watermark was read, so the drain's own reads never see
    // it, and an install that only consulted them would put the deleted
    // session's index back.
    const realWatermark = rig.store.highWatermark.bind(rig.store);
    let calls = 0;
    vi.spyOn(rig.store, 'highWatermark').mockImplementation(async (sessionId: string) => {
      const watermark = await realWatermark(sessionId);
      calls += 1;
      if (calls === 2) await rig.store.delete('r1');
      return watermark;
    });

    expect(await restarted.readDiffs('s1', 0)).toEqual({ diffs: [], nextSeq: 1, highWatermark: 0, hasMore: false });
    const internals = restarted as unknown as { diffIndexes: Map<string, unknown> };
    expect(internals.diffIndexes.has('r1')).toBe(false);
  });

  it('a transcript deleted before the opening scan reads it serves the empty index, not a store error (GZH-42)', async () => {
    const rig = await startRig();
    seedSession(rig);
    await rig.store.append(toolCall('r1', 1, 'tc1', { title: 'Edit', status: 'completed', content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' }] }));
    const restarted = wireDataSource(rig.config, rig.registry, rig.store, rig.deleted);
    rig.store.onChange(restarted.storeListener);

    // Deleted between this call's opening watermark and the scan's snapshot.
    // Only the drain's reads carried an absent-transcript catch, so the
    // opening read used to reject the whole route with a store error — the
    // wrong category for "the transcript is gone".
    const realWatermark = rig.store.highWatermark.bind(rig.store);
    let calls = 0;
    vi.spyOn(rig.store, 'highWatermark').mockImplementation(async (sessionId: string) => {
      const watermark = await realWatermark(sessionId);
      calls += 1;
      if (calls === 1) await rig.store.delete('r1');
      return watermark;
    });

    expect(await restarted.readDiffs('s1', 0)).toEqual({ diffs: [], nextSeq: 1, highWatermark: 0, hasMore: false });
  });

  it('a transcript deleted while the drain is reading serves the empty index, not a store error (GZH-42)', async () => {
    const rig = await startRig();
    seedSession(rig);
    await rig.store.append(toolCall('r1', 1, 'tc1', { title: 'Edit', status: 'completed', content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' }] }));
    const restarted = wireDataSource(rig.config, rig.registry, rig.store, rig.deleted);
    rig.store.onChange(restarted.storeListener);

    // The third way to lose a transcript mid-scan: not before the opening read
    // and not after the watermark, but between that watermark and the drain's
    // own read. All three are the same event to a reader, so all three answer
    // the same way.
    const realWatermark = rig.store.highWatermark.bind(rig.store);
    let calls = 0;
    vi.spyOn(rig.store, 'highWatermark').mockImplementation(async (sessionId: string) => {
      const watermark = await realWatermark(sessionId);
      calls += 1;
      // Report one seq above the truth so the drain must read, then delete the
      // transcript out from under that read.
      if (calls === 2) {
        await rig.store.append(toolCall('r1', 2, 'tc2', { title: 'Edit', status: 'completed', content: [{ type: 'diff', path: 'src/b.ts', oldText: 'x', newText: 'y' }] }));
        await rig.store.delete('r1');
        return watermark + 1;
      }
      return watermark;
    });

    expect(await restarted.readDiffs('s1', 0)).toEqual({ diffs: [], nextSeq: 1, highWatermark: 0, hasMore: false });
    const internals = restarted as unknown as { diffIndexes: Map<string, unknown> };
    expect(internals.diffIndexes.has('r1')).toBe(false);
  });

  it('follows transcript_delete: the session’s index is cleared (§5.4)', async () => {
    const rig = await startRig();
    seedSession(rig);
    await rig.store.append(toolCall('r1', 1, 'tc1', { title: 'Edit', status: 'completed', content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' }] }));
    expect((await fetchDiffs(rig)).diffs).toHaveLength(1);

    await rig.store.delete('r1');
    const internals = rig.dataSource as unknown as { diffIndexes: Map<string, unknown>; diffOverflow: Set<string> };
    expect(internals.diffIndexes.has('r1')).toBe(false);
    expect(internals.diffOverflow.has('r1')).toBe(false);
    // The transcript is gone; the route answers the empty index, from nothing.
    expect(await fetchDiffs(rig)).toEqual({ diffs: [], nextSeq: 1, highWatermark: 0, hasMore: false });
  });
});

describe('diff counting (shared with the UI)', () => {
  it('matches the UI’s LCS line counts, including the oversized-input fallback', () => {
    const index = new DiffIndex();
    // Below the fallback: a real LCS count.
    index.addEvent(toolCall('r1', 1, 'tc1', { title: 'Edit', status: 'completed', content: [{ type: 'diff', path: 'a.ts', oldText: 'x\ny\nz', newText: 'x\nz' }] }));
    // Past the 160000-cell fallback: del-all / add-all.
    const oldText = Array.from({ length: 500 }, (_, i) => `old${i}`).join('\n');
    const newText = Array.from({ length: 400 }, (_, i) => `new${i}`).join('\n');
    index.addEvent(toolCall('r1', 2, 'tc2', { title: 'Edit', status: 'completed', content: [{ type: 'diff', path: 'b.ts', oldText, newText }] }));

    const [small, fallback] = index.entries;
    const smallLines = diffLines('x\ny\nz', 'x\nz');
    expect({ adds: small?.adds, dels: small?.dels }).toEqual({
      adds: smallLines.filter((line) => line.t === 'add').length,
      dels: smallLines.filter((line) => line.t === 'del').length,
    });
    expect({ adds: fallback?.adds, dels: fallback?.dels }).toEqual({ adds: 400, dels: 500 });
  });

  it('the cap constant exists and the degraded route leaks no index fields (§3.4)', async () => {
    expect(DIFF_INDEX_LIMIT).toBe(1_000);
    const rig = await startRig({ exposeTranscripts: false });
    seedSession(rig);
    await rig.store.append(toolCall('r1', 1, 'tc1', { title: 'zz-secret-tool', status: 'completed', content: [{ type: 'diff', path: 'zz/secret.ts', oldText: 'a', newText: 'b' }] }));
    const res = await request(rig.server.port, { path: '/api/sessions/s1/diffs', headers: rig.headers });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('zz/secret.ts');
    expect(res.body).not.toContain('zz-secret-tool');
    expect(JSON.parse(res.body)).toEqual({ diffs: [], nextSeq: 1, highWatermark: 1, hasMore: false });
  });
});

describe('diff index watermark honesty (§3.1)', () => {
  it('never answers with a diff above the watermark it reports', async () => {
    const rig = await startRig();
    seedSession(rig);
    await rig.store.append(toolCall('r1', 1, 'tc1', { title: 'Edit', status: 'completed', content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' }] }));
    // The append fan-out is synchronous with the commit; the watermark read is
    // not. An append landing during that await is already in the cached index
    // and above the number readDiffs is holding — the cached path, which is
    // the one every live session takes.
    const realWatermark = rig.store.highWatermark.bind(rig.store);
    let armed = true;
    vi.spyOn(rig.store, 'highWatermark').mockImplementation(async (sessionId: string) => {
      const watermark = await realWatermark(sessionId);
      if (armed) {
        armed = false;
        await rig.store.append(toolCall('r1', 2, 'tc2', { title: 'Edit', status: 'completed', content: [{ type: 'diff', path: 'src/b.ts', oldText: 'x', newText: 'y' }] }));
      }
      return watermark;
    });
    const body = await rig.dataSource.readDiffs('s1', 0);
    const seqs = body.diffs.map((entry) => entry['seq'] as number);
    expect(seqs).toEqual([1, 2]);
    expect(Math.max(...seqs)).toBeLessThanOrEqual(body.highWatermark);
  });
});

describe('no line numbers (ADR 0035)', () => {
  it('the wire carries no startLine key, even under the whole-file chain ADR 0028 would have proved', () => {
    const index = new DiffIndex();
    // The chain that used to earn a proof: a diff writing c.ts into existence,
    // then the edit whose oldText reproduces it. The plugin consumes no
    // coverage anywhere now, so the projection must not emit the key —
    // `Object.hasOwn`, not `toBeUndefined`, which a key set to `undefined`
    // would satisfy just as well.
    index.addEvent(toolCall('r1', 1, 'tc1', { title: 'Write', status: 'completed', content: [{ type: 'diff', path: 'c.ts', newText: 'p\nq\n' }] }));
    index.addEvent(toolCall('r1', 2, 'tc2', { title: 'Write', status: 'completed', content: [{ type: 'diff', path: 'c.ts', oldText: 'p\nq\n', newText: 'p\nQ\n' }] }));
    expect(index.entries).toHaveLength(1);
    const projected = diffIndexEntryOutput(index.entries[0]!);
    expect(projected).toEqual({ seq: 2, tool: 'Write', path: 'c.ts', adds: 1, dels: 1, status: 'completed', origin: 'engine', part: 0 });
    expect(Object.hasOwn(projected, 'startLine')).toBe(false);
  });
});
