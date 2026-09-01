import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConsoleDataSource } from '../../packages/plugin/src/console/data-source.js';
import { ConsoleServer } from '../../packages/plugin/src/console/server.js';
import type { InstanceManifest } from '../../packages/plugin/src/lifecycle.js';
import { resolvePluginConfig, type PluginConfig } from '../../packages/plugin/src/plugin-config.js';
import { SessionRegistry } from '../../packages/core/src/registry.js';
import { createPluginTranscriptStore, type PluginTranscriptStore } from '../../packages/plugin/src/store/plugin-transcript-store.js';

const manifest: InstanceManifest = {
  instanceId: 'test-instance',
  createdAt: '2026-01-01T00:00:00.000Z',
  host: 'test-host',
  pid: 1,
  processStartedAt: '2026-01-01T00:00:00.000Z',
  tokenHash: 'a'.repeat(64),
  exePath: '/test/exe',
};

interface Rig {
  readonly dir: string;
  readonly store: PluginTranscriptStore;
  readonly registry: SessionRegistry;
  readonly dataSource: ConsoleDataSource;
  readonly config: PluginConfig;
  readonly servers: ConsoleServer[];
  advance(ms: number): void;
}

const rigs: Rig[] = [];

async function startRig(options: { exposeTranscripts?: boolean } = {}): Promise<Rig> {
  let nowMs = Date.parse('2026-08-18T00:00:00.000Z');
  const dir = await mkdtemp(join(tmpdir(), 'taskshuttle-console-topology-'));
  const config = resolvePluginConfig({
    allowedRoots: [tmpdir()],
    console: { enabled: true, exposeTranscripts: options.exposeTranscripts ?? true },
  });
  const registry = new SessionRegistry({
    instanceId: manifest.instanceId,
    limits: { maxOpenSessions: 32, maxActiveTurns: 8, maxActiveTurnsPerEngine: 2, maxQueuedTurns: 256 },
    now: () => new Date(nowMs).toISOString(),
  });
  const store = createPluginTranscriptStore(join(dir, 'taskshuttle.sqlite'));
  const dataSource = new ConsoleDataSource({
    config,
    registry,
    store,
    instance: () => manifest,
    engines: async () => ['codex', 'kimi'],
    isTranscriptDeleted: () => false,
    isVisible: () => true,
  });
  const rig: Rig = { dir, store, registry, dataSource, config, servers: [], advance: (ms) => { nowMs += ms; } };
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  while (rigs.length > 0) {
    const rig = rigs.pop()!;
    for (const server of rig.servers) await server.close().catch(() => undefined);
    await rig.store.close().catch(() => undefined);
    await rm(rig.dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function addSession(rig: Rig, id: string, options: { engine?: string; cwd?: string; parent?: string } = {}): void {
  const created = rig.registry.createSession({
    id,
    engine: options.engine ?? 'codex',
    cwd: options.cwd ?? `/work/${id}`,
    ...(options.parent === undefined ? {} : { parentSessionId: options.parent }),
  });
  expect(created.ok).toBe(true);
  expect(rig.registry.markSessionReady(id, `r-${id}`, {}).ok).toBe(true);
}

function edgesOfType(edges: Record<string, unknown>[], type: string): Record<string, unknown>[] {
  return edges.filter((edge) => edge['type'] === type);
}

describe('console execution topology (§5.5)', () => {
  it('derives fork edges from parentSessionId and never conflates root with unknown lineage', async () => {
    const rig = await startRig();
    addSession(rig, 'parent');
    addSession(rig, 'child', { parent: 'parent' });
    // A fork whose parent is not a visible node leaves no dangling edge.
    addSession(rig, 'stray', { parent: 'ghost' });

    const { nodes, edges } = rig.dataSource.topology();
    const lineage = new Map(nodes.map((node) => [node['sessionId'], node['lineage']]));
    expect(lineage.get('parent')).toBe('root');
    expect(lineage.get('child')).toBe('forked');
    expect(lineage.get('stray')).toBe('forked');

    const forks = edgesOfType(edges, 'fork');
    expect(forks).toEqual([{ type: 'fork', from: 'parent', to: 'child' }]);
  });

  it('points a queued turn at the sessions occupying its engine slots, with occupancy and wait time', async () => {
    const rig = await startRig();
    addSession(rig, 'a');
    addSession(rig, 'b');
    addSession(rig, 'q');
    addSession(rig, 'k', { engine: 'kimi' });

    expect(rig.registry.createTurn('a', { id: 'ta', prompt: [{ type: 'text', text: 'a' }] }).ok).toBe(true);
    expect(rig.registry.startTurn('ta').ok).toBe(true);
    expect(rig.registry.createTurn('b', { id: 'tb', prompt: [{ type: 'text', text: 'b' }] }).ok).toBe(true);
    expect(rig.registry.startTurn('tb').ok).toBe(true);
    rig.advance(41_000);
    // Both codex slots (maxActiveTurnsPerEngine = 2) are now occupied.
    expect(rig.registry.createTurn('q', { id: 'tq', prompt: [{ type: 'text', text: 'q' }], priority: 'high' }).ok).toBe(true);
    expect(rig.registry.createTurn('k', { id: 'tk', prompt: [{ type: 'text', text: 'k' }] }).ok).toBe(true);
    rig.advance(1_000);

    const { edges } = rig.dataSource.topology();
    const waits = edgesOfType(edges, 'schedule_wait');
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ type: 'schedule_wait', turnId: 'tq', sessionId: 'q', engine: 'codex', occupied: 2, limit: 2, priority: 'high' });
    expect((waits[0]?.['to'] as string[]).sort()).toEqual(['a', 'b']);
    // waitedMs uses the wall clock, not the registry clock; just assert presence.
    expect(waits[0]?.['waitedMs']).toBeTypeOf('number');
    // kimi has free slots: no wait edge for tk.
    expect(waits.some((edge) => edge['turnId'] === 'tk')).toBe(false);
  });

  it('marks cwd overlap as a hint and excludes closed sessions from the grouping', async () => {
    const rig = await startRig();
    addSession(rig, 'x', { cwd: '/work/shared' });
    addSession(rig, 'y', { cwd: '/work/shared' });
    addSession(rig, 'w', { cwd: '/work/shared' });
    addSession(rig, 'z', { cwd: '/work/elsewhere' });
    expect(rig.registry.beginCloseSession('w').ok).toBe(true);
    expect(rig.registry.completeCloseSession('w').ok).toBe(true);

    const { edges } = rig.dataSource.topology();
    const overlaps = edgesOfType(edges, 'cwd_overlap');
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toMatchObject({ type: 'cwd_overlap', hint: true, cwd: '/work/shared' });
    expect((overlaps[0]?.['sessions'] as string[]).sort()).toEqual(['x', 'y']);
  });

  it('draws time edges from a session that ended to one that started later, ordering only', async () => {
    const rig = await startRig();
    addSession(rig, 'early');
    addSession(rig, 'late');
    expect(rig.registry.beginCloseSession('early').ok).toBe(true);
    expect(rig.registry.completeCloseSession('early').ok).toBe(true);
    const earlyClosedAt = rig.registry.listSessions().find((session) => session.id === 'early')?.closedAt;
    expect(earlyClosedAt).toBeDefined();

    rig.advance(60_000);
    expect(rig.registry.createTurn('late', { id: 'tl', prompt: [{ type: 'text', text: 'l' }] }).ok).toBe(true);
    expect(rig.registry.startTurn('tl').ok).toBe(true);

    const { edges } = rig.dataSource.topology();
    const times = edgesOfType(edges, 'time');
    expect(times).toHaveLength(1);
    expect(times[0]).toMatchObject({ type: 'time', from: 'early', to: 'late', fromEndedAt: earlyClosedAt });
    // Ordering only: the reverse edge does not exist while `late` has not ended.
    expect(times.some((edge) => edge['from'] === 'late')).toBe(false);
  });

  it('draws only the immediate predecessor, not the whole before-relation', async () => {
    // Three sessions ending in order. The full relation is a→b, a→c, b→c;
    // drawing it is quadratic in a session list the registry never shortens,
    // and a→c is implied by following a→b→c. Only the nearest edge is drawn.
    // Each session starts a turn, then closes, before the next one appears.
    const rig = await startRig();
    const closedAt: Record<string, string | undefined> = {};
    for (const id of ['a', 'b', 'c']) {
      addSession(rig, id);
      expect(rig.registry.createTurn(id, { id: `t-${id}`, prompt: [{ type: 'text', text: id }] }).ok).toBe(true);
      expect(rig.registry.startTurn(`t-${id}`).ok).toBe(true);
      rig.advance(60_000);
      expect(rig.registry.claimTerminalCAS(`t-${id}`, { state: 'completed', source: 'engine' }).ok).toBe(true);
      expect(rig.registry.markPromptSettled(`t-${id}`).ok).toBe(true);
      expect(rig.registry.markStoreDrained(`t-${id}`).ok).toBe(true);
      expect(rig.registry.finishTurnCAS(`t-${id}`).ok).toBe(true);
      expect(rig.registry.beginCloseSession(id).ok).toBe(true);
      expect(rig.registry.completeCloseSession(id).ok).toBe(true);
      closedAt[id] = rig.registry.listSessions().find((session) => session.id === id)?.closedAt;
      rig.advance(60_000);
    }
    const times = edgesOfType(rig.dataSource.topology().edges, 'time');
    expect(times.map((edge) => `${String(edge['from'])}→${String(edge['to'])}`)).toEqual(['a→b', 'b→c']);
    expect(times[1]).toMatchObject({ fromEndedAt: closedAt['b'] });
  });

  it('caps the node set and says how many sessions it stands for', async () => {
    const rig = await startRig();
    for (let i = 0; i < 205; i += 1) {
      addSession(rig, `s${String(i).padStart(3, '0')}`);
      rig.advance(1_000);
      expect(rig.registry.beginCloseSession(`s${String(i).padStart(3, '0')}`).ok).toBe(true);
      expect(rig.registry.completeCloseSession(`s${String(i).padStart(3, '0')}`).ok).toBe(true);
    }
    const view = rig.dataSource.topology();
    expect(view.totalSessions).toBe(205);
    expect(view.nodes).toHaveLength(200);
    expect(view.truncated).toBe(true);
    // The slice is the most recent, not the first 200 the registry happens to
    // list — a graph of the oldest sessions is the wrong answer, silently.
    const ids = view.nodes.map((node) => node['sessionId']);
    expect(ids).toContain('s204');
    expect(ids).not.toContain('s000');
    // Every edge stays inside the drawn node set. Checking only string-valued
    // from/to was vacuous for the one edge type that can violate it:
    // schedule_wait's `to` is an ARRAY of the sessions holding the slots, and
    // cwd_overlap carries a `sessions` array — both are walked here.
    const drawn = new Set(ids as string[]);
    const referenced = (edge: Record<string, unknown>): string[] => {
      const out: string[] = [];
      for (const field of ['from', 'to', 'sessionId', 'sessions']) {
        const value = edge[field];
        if (typeof value === 'string') out.push(value);
        else if (Array.isArray(value)) for (const entry of value) if (typeof entry === 'string') out.push(entry);
      }
      return out;
    };
    for (const edge of view.edges) {
      for (const id of referenced(edge)) expect(`${String(edge['type'])}:${id}`).toBe(`${String(edge['type'])}:${drawn.has(id) ? id : 'UNDRAWN'}`);
    }
  });

  it('picks the same slice every time when updatedAt ties', async () => {
    // The clock does not advance, so every session shares an updatedAt and the
    // slice is decided entirely by the tie-break.
    const rig = await startRig();
    for (let i = 0; i < 205; i += 1) {
      const id = `s${String(i).padStart(3, '0')}`;
      addSession(rig, id);
      // Closed, not left open: maxOpenSessions bounds only the open ones, and
      // the clock stays put so every record shares one updatedAt.
      expect(rig.registry.beginCloseSession(id).ok).toBe(true);
      expect(rig.registry.completeCloseSession(id).ok).toBe(true);
    }
    const first = rig.dataSource.topology().nodes.map((node) => node['sessionId']);
    const second = rig.dataSource.topology().nodes.map((node) => node['sessionId']);
    expect(second).toEqual(first);
    expect(first).toHaveLength(200);
    // Descending by id under a full tie: the highest-numbered ids survive.
    expect(first[0]).toBe('s204');
    expect(first).not.toContain('s004');
  });

  it('a schedule_wait edge names only drawn holders, while still counting them all', async () => {
    // The holders are the oldest sessions and fall outside the most-recent
    // slice; the queued turn waiting on them is the newest. `to` is the one
    // edge field that is an ARRAY of session ids, so it was the one that could
    // point at a node the response does not carry — and did.
    const rig = await startRig();
    for (const id of ['holder-1', 'holder-2']) {
      addSession(rig, id);
      expect(rig.registry.createTurn(id, { id: `t-${id}`, prompt: [{ type: 'text', text: 'x' }] }).ok).toBe(true);
      expect(rig.registry.startTurn(`t-${id}`).ok).toBe(true);
      rig.advance(1_000);
    }
    // Enough newer sessions to push both holders out of the 200-node slice.
    for (let i = 0; i < 205; i += 1) {
      const id = `filler-${String(i).padStart(3, '0')}`;
      addSession(rig, id);
      rig.advance(1_000);
      expect(rig.registry.beginCloseSession(id).ok).toBe(true);
      expect(rig.registry.completeCloseSession(id).ok).toBe(true);
    }
    addSession(rig, 'waiter');
    expect(rig.registry.createTurn('waiter', { id: 't-waiter', prompt: [{ type: 'text', text: 'w' }] }).ok).toBe(true);

    const view = rig.dataSource.topology();
    const drawn = new Set(view.nodes.map((node) => node['sessionId'] as string));
    expect(drawn.has('waiter')).toBe(true);
    expect(drawn.has('holder-1')).toBe(false);
    const waits = edgesOfType(view.edges, 'schedule_wait');
    expect(waits).toHaveLength(1);
    // The contention is reported honestly — two slots are taken — but the edge
    // points only at nodes the client can draw.
    expect(waits[0]).toMatchObject({ sessionId: 'waiter', occupied: 2, limit: 2 });
    expect(waits[0]?.['to']).toEqual([]);
  });

  it('reports no truncation below the cap', async () => {
    const rig = await startRig();
    addSession(rig, 'only');
    const view = rig.dataSource.topology();
    expect(view.totalSessions).toBe(1);
    expect(view).not.toHaveProperty('truncated');
  });

  it('stays whitelist-only in degraded mode: edges without the cwd value, nodes without content fields (CONSOLE-018)', async () => {
    const rig = await startRig({ exposeTranscripts: false });
    addSession(rig, 'x', { cwd: '/work/shared', });
    addSession(rig, 'y', { cwd: '/work/shared', parent: 'x' });

    const topology = rig.dataSource.topology();
    const serialized = JSON.stringify(topology);
    expect(serialized).not.toContain('/work/shared');
    expect(serialized).not.toContain('"cwd"');
    expect(serialized).not.toContain('"name"');
    expect(edgesOfType(topology.edges, 'cwd_overlap')).toHaveLength(1);
    expect(edgesOfType(topology.edges, 'fork')).toEqual([{ type: 'fork', from: 'x', to: 'y' }]);
    for (const node of topology.nodes) {
      expect(node['lineage']).toBeDefined();
      expect(node['state']).toBeDefined();
    }
  });

  it('serves /api/topology over the wired route', async () => {
    const rig = await startRig();
    addSession(rig, 'parent');
    addSession(rig, 'child', { parent: 'parent' });
    const server = new ConsoleServer({ config: rig.config.console, instanceDir: rig.dir, dataSource: rig.dataSource });
    rig.servers.push(server);
    await server.start();

    const body = await new Promise<string>((resolveRequest, rejectRequest) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: server.port, path: '/api/topology' },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            expect(res.statusCode).toBe(200);
            resolveRequest(Buffer.concat(chunks).toString('utf8'));
          });
        },
      );
      req.on('error', rejectRequest);
      req.end();
    });
    const parsed = JSON.parse(body) as { nodes: unknown[]; edges: Array<Record<string, unknown>> };
    expect(parsed.nodes).toHaveLength(2);
    expect(edgesOfType(parsed.edges, 'fork')).toEqual([{ type: 'fork', from: 'parent', to: 'child' }]);
  });
});
