import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTaskShuttleServer, type TaskShuttleServer } from '../../packages/plugin/src/server.js';
import { simulatedAdapters, simulatedEnginesCoverBuiltins, simulatedHubFactory, SIMULATED_ENGINES } from '../../packages/plugin/src/testkit/simulated-engines.js';

const open: TaskShuttleServer[] = [];

async function startSimulated(env: Record<string, Record<string, string>> = {}): Promise<TaskShuttleServer> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-live-'));
  const plugin = createTaskShuttleServer({
    dataRoot,
    env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [tmpdir()] }), REALM_PLUGIN_LOG: 'off' } as NodeJS.ProcessEnv,
    hostCwd: tmpdir(),
    hubFactory: simulatedHubFactory({ env }),
  });
  open.push(plugin);
  await plugin.runtime.ready;
  return plugin;
}

async function settledTurn(plugin: TaskShuttleServer, turnId: string, budgetMs = 20_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const result = await plugin.invoke('turn_get', { turnId });
    if (!result.ok) throw new Error(`turn_get failed: ${result.error.code}`);
    if (['completed', 'failed', 'cancelled'].includes(result.output.state)) return result.output as unknown as Record<string, unknown>;
    if (Date.now() > deadline) throw new Error(`turn ${turnId} never settled (state ${result.output.state})`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close().catch(() => undefined);
});

describe('simulated engine harness', () => {
  it('builds one scripted adapter per frozen engine id, and covers exactly those ids', () => {
    // The ids are ours; the launch shape belongs to the testkit, so assert that
    // every frozen id gets an adapter rather than what the testkit runs.
    expect(simulatedAdapters().map((adapter) => adapter.id)).toEqual([...SIMULATED_ENGINES]);
    expect(simulatedEnginesCoverBuiltins()).toBe(true);
    expect([...SIMULATED_ENGINES]).toEqual(['codex', 'claude-code', 'opencode', 'kimi']);
  });

  it('runs the ENG gate shape end to end: inventory, create, two turns, transcript, close', async () => {
    const plugin = await startSimulated();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-live-cwd-'));

    const inventory = await plugin.invoke('workers_list', { rescan: false });
    expect(inventory.ok).toBe(true);
    if (!inventory.ok) return;
    // The scripted adapters override the frozen ids; a built-in Realm ships that
    // we do not simulate — `pi` today — still appears, because `adapters` extends
    // the built-in set rather than replacing it. So assert that what we simulate
    // is installed, not that nothing else is. Such an engine is reachable in name
    // only: admission refuses it as unverified (see engine-admission.test.ts).
    const installed = inventory.output.workers.filter((worker) => worker.installed).map((worker) => worker.engine);
    expect(installed).toEqual(expect.arrayContaining([...SIMULATED_ENGINES]));

    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.output.sessionId;

    const turns: string[] = [];
    for (const text of ['first instruction', 'second instruction']) {
      const started = await plugin.invoke('turn_start', { sessionId, prompt: [{ type: 'text', text }] });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const settled = await settledTurn(plugin, started.output.turnId);
      expect(settled['state']).toBe('completed');
      expect(typeof settled['finalText']).toBe('string');
      turns.push(started.output.turnId);
    }

    // Every turn's convenience result must line up with the stored events.
    const transcript = await plugin.invoke('transcript_read', { sessionId, afterSeq: 0, limit: 200 });
    expect(transcript.ok).toBe(true);
    if (!transcript.ok) return;
    expect(transcript.output.events.length).toBeGreaterThan(0);
    const seqs = transcript.output.events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
    for (const turnId of turns) {
      const turn = await plugin.invoke('turn_get', { turnId });
      if (!turn.ok) throw new Error('turn_get failed');
      const { fromSeq, throughSeq } = turn.output as { fromSeq?: number | null; throughSeq?: number };
      expect(throughSeq).toBeLessThanOrEqual(transcript.output.highWatermark);
      if (fromSeq !== null && fromSeq !== undefined) expect(seqs).toContain(fromSeq);
    }

    const closed = await plugin.invoke('session_close', { sessionId });
    expect(closed.ok).toBe(true);
    if (closed.ok) expect(closed.output.state).toBe('closed');
  }, 60_000);

  it('surfaces a real permission interaction through the bridge', async () => {
    const plugin = await startSimulated({ codex: { RUNSKEIN_TESTKIT_ASK_PERMISSION: '1' } });
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-live-permission-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd, permissionMode: 'ask-orchestrator' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const started = await plugin.invoke('turn_start', { sessionId: created.output.sessionId, prompt: [{ type: 'text', text: 'touch a file' }] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const deadline = Date.now() + 20_000;
    let interactionId: string | undefined;
    while (interactionId === undefined && Date.now() < deadline) {
      const pending = await plugin.invoke('interaction_list', { turnId: started.output.turnId, state: 'pending' });
      if (pending.ok && pending.output.interactions.length > 0) interactionId = pending.output.interactions[0]!.interactionId;
      else await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(interactionId).toBeDefined();

    const answered = await plugin.invoke('interaction_respond', { interactionId: interactionId!, response: { outcome: 'allow' } });
    expect(answered.ok).toBe(true);
    const settled = await settledTurn(plugin, started.output.turnId);
    expect(settled['state']).toBe('completed');
    expect(settled['pendingPermissionCount']).toBe(0);
  }, 60_000);
});
