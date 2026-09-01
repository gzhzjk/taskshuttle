import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { DELEGATION_ENV } from '../../packages/plugin/src/security-policy.js';
import { normaliseHookInput, runNannyHook, selectInstance } from '../../packages/plugin/src/nanny.js';
import { createTaskShuttleServer, type TaskShuttleServer } from '../../packages/plugin/src/server.js';
import { FakeRunskeinHub } from '../../packages/plugin/src/testkit/fake-runskein.js';

/**
 * The hook driven end to end against a real instance directory.
 *
 * The fixtures are a running runtime rather than hand-written manifests on
 * purpose: liveness is decided from the instance lock and the owning process's
 * identity, and a hand-built lock passes on darwin (where the OS supplies no
 * identity fields) while failing on Linux. A real instance is the same
 * everywhere.
 */

const open: TaskShuttleServer[] = [];

const descriptor = {
  engine: 'codex',
  installed: true,
  authenticated: true,
  available: true,
  capabilities: { loadSession: true, session: {}, prompt: {}, mcp: {}, providers: false },
  models: [],
  modes: [],
  providers: [],
  configOptions: [],
  source: 'builtin',
};

async function startPlugin(): Promise<{ plugin: TaskShuttleServer; dataRoot: string }> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-nanny-hook-'));
  const hub = new FakeRunskeinHub({
    closeResolvesPrompt: true,
    engineInfos: [{ id: 'codex', installed: true, authenticated: true, health: 'ready', version: '1.0.0' }] as never,
    descriptors: { codex: descriptor } as never,
  });
  const plugin = createTaskShuttleServer({
    dataRoot,
    env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [tmpdir()] }) } as NodeJS.ProcessEnv,
    hostCwd: tmpdir(),
    hubFactory: () => Object.assign(hub, { on: () => () => undefined, rescan: async () => undefined }) as never,
  });
  open.push(plugin);
  await plugin.runtime.ready;
  return { plugin, dataRoot };
}

/** Runs the hook the way a host does: a JSON payload in, at most one JSON object out. */
async function runHook(dataRoot: string, payload: unknown, env: NodeJS.ProcessEnv = {}): Promise<string> {
  let out = '';
  const code = await runNannyHook({
    env: { REALM_PLUGIN_DATA_ROOT: dataRoot, ...env },
    stdin: Readable.from([JSON.stringify(payload)]),
    write: (text) => { out += text; },
  });
  // A hook that exits non-zero interferes with a host it was only observing.
  expect(code).toBe(0);
  return out;
}

/** A session with a turn that never settles, so the snapshot has something in it. */
async function dispatchTurn(plugin: TaskShuttleServer, cwd: string): Promise<string> {
  const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error('session_create failed');
  const started = await plugin.invoke('turn_start', { sessionId: created.output.sessionId, prompt: [{ type: 'text', text: 'work' }] });
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error('turn_start failed');
  // The writer defers a microtask and then writes a file.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return started.output.turnId;
}

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close().catch(() => undefined);
});

describe('nanny hook', () => {
  it('NANNY-001: blocks once with the running turn, reading it from files alone', async () => {
    const { plugin, dataRoot } = await startPlugin();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-nanny-cwd-'));
    const turnId = await dispatchTurn(plugin, cwd);

    const out = await runHook(dataRoot, { hook_event_name: 'Stop', cwd, stop_hook_active: false });
    const decision = JSON.parse(out) as { decision: string; reason: string };
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain(turnId);
  });

  it('NANNY-004: a delegated worker is silent — the guard runs before anything is read', async () => {
    const { plugin, dataRoot } = await startPlugin();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-nanny-cwd-'));
    await dispatchTurn(plugin, cwd);

    // A claude-code worker is a nested Claude Code in the parent's cwd: without
    // the guard it reads the parent's turns, finds its own among them, and
    // blocks itself. `stop_hook_active` cannot save it — the criterion is true
    // every time.
    const out = await runHook(dataRoot, { hook_event_name: 'Stop', cwd, stop_hook_active: false }, {
      [DELEGATION_ENV.version]: '1',
      [DELEGATION_ENV.depth]: '1',
      [DELEGATION_ENV.root]: 'a'.repeat(32),
    });
    expect(out).toBe('');
  });

  it('NANNY-022: a symlinked workspace still matches — the cwd is resolved before it is compared', async () => {
    const { plugin, dataRoot } = await startPlugin();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-nanny-cwd-'));
    const turnId = await dispatchTurn(plugin, cwd);
    // The host reports the path the user typed; the snapshot records the one
    // the runtime resolved. Comparing them literally matches nothing, the
    // filter drops every turn, and the hook falls silent — which the
    // orchestrator reads as "nothing is running".
    const link = join(await mkdtemp(join(tmpdir(), 'taskshuttle-nanny-link-')), 'workspace');
    await symlink(cwd, link);

    const out = await runHook(dataRoot, { hook_event_name: 'Stop', cwd: link, stop_hook_active: false });
    expect(out).not.toBe('');
    expect((JSON.parse(out) as { reason: string }).reason).toContain(turnId);
  });

  it('NANNY-020: on kimi a block is exit code 2 with the reason on stderr, not JSON', async () => {
    const { plugin, dataRoot } = await startPlugin();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-nanny-cwd-'));
    const turnId = await dispatchTurn(plugin, cwd);

    let out = '';
    let err = '';
    // kimi's runner maps exit 2 to a block and reads the reason off stderr. The
    // JSON it parses recognises only `message` and `hookSpecificOutput`, whose
    // sole blocking path is `permissionDecision: "deny"` — permission
    // semantics. A {"decision":"block"} object with exit 0 reads there as a
    // hook that allowed the stop, which is how this was found: the hook ran on
    // kimi and the model went on as if nothing had been said.
    const code = await runNannyHook({
      env: { REALM_PLUGIN_DATA_ROOT: dataRoot, KIMI_PLUGIN_ROOT: '/tmp/plugin' },
      // kimi's payload carries no transcript path and no permission mode; both
      // signals must agree before the exit-code form is used.
      stdin: Readable.from([JSON.stringify({ hook_event_name: 'Stop', cwd, stop_hook_active: false })]),
      write: (text) => { out += text; },
      writeError: (text) => { err += text; },
    });
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toContain(turnId);
  });

  it('NANNY-025: a claude-code payload keeps the JSON form even when kimi env leaked in', async () => {
    const { plugin, dataRoot } = await startPlugin();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-nanny-cwd-'));
    await dispatchTurn(plugin, cwd);

    // `KIMI_CODE_HOME` is exported by kimi's install and inherited by anything
    // started from the same shell. Taking the exit-code path here produced
    // `Stop hook error: …` in a real session — which claude-code renders as a
    // *non-blocking* warning, so the stop was neither clean nor prevented.
    let out = '';
    let err = '';
    const code = await runNannyHook({
      // Neutral absolute path for the same reason as the one in
      // test/core/project-config.test.ts: this file is exported.
      env: { REALM_PLUGIN_DATA_ROOT: dataRoot, KIMI_CODE_HOME: '/absolute/kimi-code-home' },
      stdin: Readable.from([JSON.stringify({
        hook_event_name: 'Stop', cwd, stop_hook_active: false,
        transcript_path: '/tmp/transcript.jsonl', permission_mode: 'default',
      })]),
      write: (text) => { out += text; },
      writeError: (text) => { err += text; },
    });
    expect(code).toBe(0);
    expect(err).toBe('');
    expect((JSON.parse(out) as { decision?: string }).decision).toBe('block');
  });

  it('NANNY-002: an empty data root is silence, not a block', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'taskshuttle-nanny-empty-'));
    expect(await runHook(empty, { hook_event_name: 'Stop', cwd: empty, stop_hook_active: false })).toBe('');
  });

  it('NANNY-002: a malformed payload is silence, not a crash', async () => {
    const { dataRoot } = await startPlugin();
    let out = '';
    const code = await runNannyHook({
      env: { REALM_PLUGIN_DATA_ROOT: dataRoot },
      stdin: Readable.from(['not json at all']),
      write: (text) => { out += text; },
    });
    expect(code).toBe(0);
    expect(out).toBe('');
  });

  it('NANNY-006: the guard turns the block into a note the host shows the user', async () => {
    const { plugin, dataRoot } = await startPlugin();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-nanny-cwd-'));
    await dispatchTurn(plugin, cwd);

    const out = await runHook(dataRoot, { hook_event_name: 'Stop', cwd, stop_hook_active: true });
    const decision = JSON.parse(out) as { decision?: string; systemMessage?: string };
    expect(decision.decision).toBeUndefined();
    expect(decision.systemMessage).toContain('still running');
  });

  it("ANCHOR-015: the hook reads the anchor and the count out of process, matching the tool's own answer", async () => {
    const { plugin, dataRoot } = await startPlugin();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-nanny-cwd-'));
    const written = await plugin.invoke('anchor', { content: 'ship the parser, then the gate' });
    expect(written.ok).toBe(true);
    await dispatchTurn(plugin, cwd);

    const inProcess = await plugin.invoke('anchor', {});
    expect(inProcess.ok).toBe(true);
    if (!inProcess.ok) return;

    const out = await runHook(dataRoot, { hook_event_name: 'Stop', cwd, stop_hook_active: false });
    const decision = JSON.parse(out) as { reason: string };
    expect(decision.reason).toContain('ship the parser, then the gate');
    // The hook has no access to the in-memory counter; it subtracts two files
    // and must land on the same number the tool reports.
    expect(decision.reason).toContain(`dispatched ${inProcess.output.turnsSinceUpdate} turn(s)`);
  });
});

describe('nanny hook payload handling', () => {
  it("reads kimi's spelling of the loop guard as well as claude-code's", () => {
    expect(normaliseHookInput({ stop_hook_active: true }).stopHookActive).toBe(true);
    expect(normaliseHookInput({ stopHookActive: true }).stopHookActive).toBe(true);
    expect(normaliseHookInput({ stop_hook_active: false }).stopHookActive).toBe(false);
    expect(normaliseHookInput({ stopHookActive: false }).stopHookActive).toBe(false);
    // A host that sends no flag is treated as "already blocked": erring toward
    // the guard costs a reminder, erring away from it costs the session.
    expect(normaliseHookInput({}).stopHookActive).toBe(true);
    expect(normaliseHookInput('garbage').stopHookActive).toBe(true);
  });

  it('refuses to guess which instance stopped when two are running in the same workspace', () => {
    const entry = (id: string, cwd: string) => ({
      instance: { instanceId: id, instanceDir: `/tmp/${id}`, createdAt: '2026-08-21T00:00:00.000Z' },
      snapshot: { instanceId: id, updatedAt: '', seq: 1, turnsDispatched: 0, pendingInteractions: [], active: [{ turnId: 't', sessionId: 's', engine: 'codex', state: 'running' as const, cwd }] },
    });
    const a = entry('a', '/tmp/w');
    const b = entry('b', '/tmp/w');
    expect(selectInstance([a, b], '/tmp/w')).toBeUndefined();
    expect(selectInstance([a], '/tmp/w')).toBe(a);
    // No turn in this workspace: a single instance is still unambiguous.
    expect(selectInstance([a], '/tmp/other')).toBe(a);
    expect(selectInstance([a, b], '/tmp/other')).toBeUndefined();
  });
});
