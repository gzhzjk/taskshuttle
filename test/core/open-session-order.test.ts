import { mkdtemp, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeRunskeinHub } from '../../packages/plugin/src/testkit/fake-runskein.js';
import type { CwdEvidence } from '../../packages/plugin/src/cwd-boundary.js';
import { InteractionBroker, type InteractionBrokerOptions } from '../../packages/plugin/src/interaction-broker.js';

const descriptor = {
  engine: 'codex', installed: true, authenticated: true, available: true,
  capabilities: { loadSession: true, session: { fork: true }, prompt: { image: true, embeddedContext: true }, mcp: {}, providers: false },
  models: [], modes: [], providers: [], configOptions: [], source: 'builtin',
} as never;
const engineInfos = [{ id: 'codex', installed: true, authenticated: true, health: 'ready', version: '1.0.0' }];

function fakeHub(hub: FakeRunskeinHub) {
  return Object.assign(hub, { on: () => () => undefined, rescan: async () => undefined });
}

// Shared order array — spies and mocked constructor push into the same array.
const order: string[] = [];
class RecordingInteractionBroker extends InteractionBroker {
  constructor(options: InteractionBrokerOptions) {
    order.push('broker');
    super(options);
  }
}

const brokerFactory = (options: InteractionBrokerOptions): InteractionBroker => new RecordingInteractionBroker(options);

const { createTaskShuttleServer } = await import('../../packages/plugin/src/server.js');
import type { TaskShuttleServer } from '../../packages/plugin/src/server.js';

const open: TaskShuttleServer[] = [];
afterEach(async () => { while (open.length) await open.pop()!.close().catch(() => undefined); vi.restoreAllMocks(); order.length = 0; });

describe('SEC-CWD-027: verify immediately precedes hub.session', () => {
  it('describe+broker before resolveCwd/verify, verify immediately before hub.session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sec-cwd-027-'));
    const cwd = await mkdtemp(join(tmpdir(), 'sec-cwd-027-cwd-'));
    const hub = new FakeRunskeinHub({ engineInfos: engineInfos as never, descriptors: { codex: descriptor } as never });
    const plugin = createTaskShuttleServer({ dataRoot: root, env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [tmpdir()] }) } as NodeJS.ProcessEnv, hostCwd: tmpdir(), hubFactory: () => fakeHub(hub) as never, brokerFactory, logSink: () => {} });
    open.push(plugin);
    const deps = await plugin.runtime.ready as unknown as { policy: { resolveCwd: (p: string) => Promise<unknown>; verifyCwdBeforeSpawn: (s: unknown) => Promise<void> }; hub: { describe: (e: string) => Promise<unknown>; session: (o: unknown) => Promise<unknown> } };
    order.length = 0;
    const origDescribe = deps.hub.describe.bind(deps.hub);
    vi.spyOn(deps.hub, 'describe').mockImplementation(async (...a) => { order.push('describe'); return origDescribe(...a); });
    const origSession = deps.hub.session.bind(deps.hub);
    vi.spyOn(deps.hub, 'session').mockImplementation(async (...a) => { order.push('hub.session'); return origSession(...a); });
    const origResolve = deps.policy.resolveCwd.bind(deps.policy);
    vi.spyOn(deps.policy, 'resolveCwd').mockImplementation(async (...a) => { order.push('resolveCwd'); return origResolve(...a); });
    const origVerify = deps.policy.verifyCwdBeforeSpawn.bind(deps.policy);
    vi.spyOn(deps.policy, 'verifyCwdBeforeSpawn').mockImplementation(async (...a) => { order.push('verify'); return origVerify(...a); });
    order.length = 0;
    const res = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(res.ok).toBe(true);
    const last5 = order.slice(-5);
    expect(last5).toEqual(['describe', 'broker', 'resolveCwd', 'verify', 'hub.session']);
    expect(last5.indexOf('verify') + 1).toBe(last5.indexOf('hub.session'));
  });
});

describe('SEC-CWD-028: swap between narrowed verify and spawn is refused', () => {
  it('resolveCwd spy swaps on openSession reading, verify fails, hub.session never called', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sec-cwd-028-root-'));
    const base = await mkdtemp(join(tmpdir(), 'sec-cwd-028-base-'));
    const cwd = join(base, 'cwd');
    const other = join(base, 'other');
    const next = join(base, 'next');
    await mkdir(cwd); await mkdir(other); await mkdir(next);
    const hub = new FakeRunskeinHub({ engineInfos: engineInfos as never, descriptors: { codex: descriptor } as never });
    const plugin = createTaskShuttleServer({ dataRoot: root, env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [base], maxOpenSessions: 1 }) } as NodeJS.ProcessEnv, hostCwd: base, hubFactory: () => fakeHub(hub) as never, brokerFactory, logSink: () => {} });
    open.push(plugin);
    const deps = await plugin.runtime.ready as unknown as { policy: { resolveCwd: (p: string) => Promise<CwdEvidence>; verifyCwdBeforeSpawn: (e: CwdEvidence) => Promise<void> }; hub: { session: (o: unknown) => Promise<unknown> } };
    const registry = plugin.runtime.registry;
    const originalCreateSession = registry.createSession.bind(registry);
    let reservationCreated = false;
    vi.spyOn(registry, 'createSession').mockImplementation((input) => {
      const result = originalCreateSession(input);
      reservationCreated ||= result.ok;
      return result;
    });
    const origResolve = deps.policy.resolveCwd.bind(deps.policy);
    let adapterResolveSeen = false;
    let swapped = false;
    vi.spyOn(deps.policy, 'resolveCwd').mockImplementation(async (p: string) => {
      const snap = await origResolve(p);
      // The adapter is the only resolve after Core has reserved the record.
      // Marking the stage from the real reservation avoids a brittle call index.
      if (reservationCreated) adapterResolveSeen = true;
      return snap;
    });
    const origVerify = deps.policy.verifyCwdBeforeSpawn.bind(deps.policy);
    vi.spyOn(deps.policy, 'verifyCwdBeforeSpawn').mockImplementation(async (e: CwdEvidence) => {
      if (reservationCreated && adapterResolveSeen && !swapped) {
        swapped = true;
        // Swap after the adapter's snapshot but before its verify.
        await rename(cwd, cwd + '.moved');
        await rename(other, cwd);
      }
      return origVerify(e);
    });
    const sessSpy = vi.spyOn(deps.hub, 'session');
    const originalDiscard = registry.discardCreatingSession.bind(registry);
    let discardedWhileCreating = false;
    const discardSpy = vi.spyOn(registry, 'discardCreatingSession').mockImplementation((id) => {
      discardedWhileCreating = registry.getSession(id)?.state === 'creating';
      return originalDiscard(id);
    });
    const res = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('PERMISSION_DENIED');
    expect(reservationCreated).toBe(true);
    expect(adapterResolveSeen).toBe(true);
    expect(swapped).toBe(true);
    expect(discardSpy).toHaveBeenCalledTimes(1);
    expect(discardedWhileCreating).toBe(true);
    expect(sessSpy).not.toHaveBeenCalled();

    // A refusal before the actual spawn must discard the creating reservation;
    // otherwise the next legitimate create would hit the one-session limit.
    const nextRes = await plugin.invoke('session_create', { engine: 'codex', cwd: next });
    expect(nextRes.ok).toBe(true);
  });
});
