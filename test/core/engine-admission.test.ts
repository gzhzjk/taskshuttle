import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTaskShuttleServer, type TaskShuttleServer } from '../../packages/plugin/src/server.js';
import { simulatedHubFactory } from '../../packages/plugin/src/testkit/simulated-engines.js';
import { FROZEN_ENGINE_IDS } from '../../packages/plugin/src/schemas.js';

const open: TaskShuttleServer[] = [];

async function start(config: Record<string, unknown> = {}): Promise<TaskShuttleServer> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-admission-'));
  const plugin = createTaskShuttleServer({
    dataRoot,
    env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [tmpdir()], ...config }), REALM_PLUGIN_LOG: 'off' } as NodeJS.ProcessEnv,
    hostCwd: tmpdir(),
    hubFactory: simulatedHubFactory(),
  });
  open.push(plugin);
  await plugin.runtime.ready;
  return plugin;
}

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

describe('engine admission through the tool facade', () => {
  // Both inventory tools go through parseToolOutput, so calling them here is
  // what actually enforces the frozen output contract. worker_describe had no
  // test invoking it at all, which is how it shipped without the fields the
  // schema marks required.
  it('reports verification and usability for every frozen engine', async () => {
    const plugin = await start();
    const listed = await plugin.invoke('workers_list', { rescan: false });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    const byEngine = new Map(listed.output.workers.map((worker) => [worker.engine, worker]));
    for (const engine of FROZEN_ENGINE_IDS) {
      expect(byEngine.get(engine)?.usable, engine).toBe(true);
      expect(['verified', 'unverified', 'unknown']).toContain(byEngine.get(engine)?.verification);

      const described = await plugin.invoke('worker_describe', { engine, rescan: false });
      expect(described.ok, engine).toBe(true);
      if (described.ok) expect(described.output.usable).toBe(true);
    }
  });

  it('keeps the frozen engines in spec order', async () => {
    const plugin = await start();
    const listed = await plugin.invoke('workers_list', { rescan: false });
    if (!listed.ok) throw new Error('workers_list failed');
    expect(listed.output.workers.map((worker) => worker.engine).slice(0, FROZEN_ENGINE_IDS.length)).toEqual([...FROZEN_ENGINE_IDS]);
  });

  it('rejects an engine the registry does not have, and says what it does have', async () => {
    const plugin = await start();
    // Not `pi`: that used to be a safe example of a name nobody would register,
    // and then Realm registered it. A name has to be absent to test absence.
    const created = await plugin.invoke('session_create', { engine: 'not-an-engine', cwd: tmpdir(), permissionMode: 'ask-orchestrator' });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.code).toBe('INVALID_ARGUMENT');
    expect(created.error.details?.['available']).toEqual(expect.arrayContaining([...FROZEN_ENGINE_IDS]));
  });

  // `pi` was this case's subject while it was registered-but-unverified — the
  // first live engine ADR 0004's Phase 3 rule could be proven on. Its matrix has
  // since been run, so it now proves the opposite half: a verified engine outside
  // the frozen set is admitted with no install-surface switch, and carries its
  // recorded defect in `requirements.defective` rather than being hidden.
  it('admits a verified engine outside the frozen set, and still shows its defect', async () => {
    const plugin = await start();
    const listed = await plugin.invoke('workers_list', { rescan: false, requires: ['session.fork'] });
    if (!listed.ok) throw new Error('workers_list failed');
    const pi = listed.output.workers.find((worker) => worker.engine === 'pi');
    if (pi === undefined) return; // Runskein no longer ships it; nothing to assert.
    expect(pi.verification).toBe('verified');
    expect(pi.usable).toBe(true);
    // The claim worth asserting is the one that does not depend on this machine:
    // a capability a known defect covers is **never reported as met**. Whether
    // `pi` advertises `session.fork` at all depends on the pi CLI being present
    // — it is on a maintainer's machine and is not on a hosted runner — so the
    // capability lands in `defective` there and in `unmet` here, and both are
    // correct. Asserting `defective` outright made this hermetic test depend on
    // an installed engine, and it went red on the public CI for that reason.
    const requirements = pi.requirements;
    expect(requirements?.met ?? []).not.toContain('session.fork');
    expect([...(requirements?.defective ?? []), ...(requirements?.unmet ?? [])]).toContain('session.fork');
  });

  // The frozen four are authorized by mvp §4.2, not by gate evidence — a matrix
  // entry may be `false`, and gating on that would remove a required engine from
  // a default install.
  it('admits a frozen engine even though its matrix has not been run', async () => {
    const plugin = await start();
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd: tmpdir(), permissionMode: 'ask-orchestrator' });
    expect(created.ok).toBe(true);
  });

  it('rejects a reserved sentinel before it reaches the registry', async () => {
    const plugin = await start();
    const created = await plugin.invoke('session_create', { engine: 'auto', cwd: tmpdir(), permissionMode: 'ask-orchestrator' });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('capability requirements through the tool facade', () => {
  // The whole point of ADR 0005: a shortlist cannot say *why* an engine missed.
  it('annotates every engine and removes none', async () => {
    const plugin = await start();
    const plain = await plugin.invoke('workers_list', { rescan: false });
    const filtered = await plugin.invoke('workers_list', { rescan: false, requires: ['session.fork'] });
    if (!plain.ok || !filtered.ok) throw new Error('workers_list failed');

    expect(filtered.output.workers.map((w) => w.engine)).toEqual(plain.output.workers.map((w) => w.engine));
    for (const worker of filtered.output.workers) expect(worker.requirements, worker.engine).toBeDefined();
  });

  it('omits the annotation entirely when nothing was required', async () => {
    const plugin = await start();
    const listed = await plugin.invoke('workers_list', { rescan: false });
    if (!listed.ok) throw new Error('workers_list failed');
    for (const worker of listed.output.workers) expect(worker.requirements).toBeUndefined();
  });

  // claude-code advertises session.fork and answers it with Resource not found.
  // Reporting that as simply unmet would hide who is at fault.
  it('reports a recorded defect as defective, not as unmet', async () => {
    const plugin = await start();
    const listed = await plugin.invoke('workers_list', { rescan: false, requires: ['session.fork'] });
    if (!listed.ok) throw new Error('workers_list failed');
    const claude = listed.output.workers.find((w) => w.engine === 'claude-code');
    expect(claude?.requirements?.defective).toEqual(['session.fork']);
    expect(claude?.requirements?.unmet).toEqual([]);
    expect(claude?.requirements?.satisfied).toBe(false);
  });

  it('rejects a capability path no engine exposes, and says which exist', async () => {
    const plugin = await start();
    const listed = await plugin.invoke('workers_list', { rescan: false, requires: ['session.forks'] });
    expect(listed.ok).toBe(false);
    if (listed.ok) return;
    expect(listed.error.code).toBe('INVALID_ARGUMENT');
    expect(listed.error.details?.['known']).toContain('session.fork');
  });

  it('rejects duplicate and over-long requirement lists at the schema', async () => {
    const plugin = await start();
    const duplicated = await plugin.invoke('workers_list', { rescan: false, requires: ['session.fork', 'session.fork'] });
    expect(duplicated.ok).toBe(false);
    const tooMany = await plugin.invoke('workers_list', { rescan: false, requires: Array.from({ length: 9 }, (_, i) => `session.c${i}`) });
    expect(tooMany.ok).toBe(false);
  });
});
