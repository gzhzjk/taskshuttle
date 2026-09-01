// SEC-REC-014 (ADR 0031): the nanny is a second process, not a second call
// site — it performs the bounded ancestry walk itself, against the same locks,
// and exits silently on `delegated` and on `unavailable`. The hook runs as the
// built standalone artifact exactly the way a host launches it, spawned from
// this test process: whatever lock this process holds, the child's real
// ancestry passes through it. SEC-REC-013's nanny half (a malformed marker
// still exits successfully) lives beside its server half in
// delegation-consumers.test.ts.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTaskShuttleServer, type TaskShuttleServer } from '../../packages/plugin/src/server.js';
import { FakeRunskeinHub } from '../../packages/plugin/src/testkit/fake-runskein.js';
import { InstanceManager, inspectProcessIdentity } from '../../packages/plugin/src/lifecycle.js';

const NANNY_JS = join(process.cwd(), 'hosts', 'claude-code', 'dist', 'nanny.js');

const open: TaskShuttleServer[] = [];
const roots: string[] = [];

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

/**
 * A live instance with an unsettled turn in `cwd`, owned by THIS process —
 * which is precisely what makes the variant delegated once the hook runs as
 * our spawned child. Built from a running runtime rather than hand-written
 * files: liveness is decided against the OS identity of the owning pid.
 */
async function delegatedFixture(): Promise<{ dataRoot: string; cwd: string }> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-nanny-walk-data-'));
  roots.push(dataRoot);
  const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-nanny-walk-cwd-'));
  roots.push(cwd);
  const hub = new FakeRunskeinHub({
    // The turn must STILL be running when the spawned hook reads the
    // snapshot — a prompt that resolves itself empties `active` within
    // milliseconds and every verdict below degrades to silence.
    closeResolvesPrompt: false,
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
  const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  const started = await plugin.invoke('turn_start', { sessionId: created.output.sessionId, prompt: [{ type: 'text', text: 'work' }] });
  if (!started.ok) throw new Error(`turn_start failed: ${started.error.code}`);
  // The snapshot writer defers a microtask and then writes the file.
  await new Promise((resolve) => setTimeout(resolve, 100));
  return { dataRoot, cwd };
}

/**
 * The root variant needs the same loud state with NO ancestor holding a lock:
 * launchd owns this one — alive, so the instance stays discoverable and its
 * snapshot readable, but no walk ever matches it before reaching pid 1.
 */
async function rootFixture(): Promise<{ dataRoot: string; cwd: string }> {
  if (process.platform === 'win32') throw new Error('no launchd on this platform; ADR 0014 matrix only');
  const owner = await inspectProcessIdentity(1);
  if (!owner.exists || owner.processStartedAt === undefined) throw new Error('pid 1 unreadable; cannot stage a non-ancestor live lock here');
  const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-nanny-walk-root-'));
  roots.push(dataRoot);
  const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-nanny-walk-cwd-root-'));
  roots.push(cwd);
  const manager = await InstanceManager.create({
    dataRoot,
    pid: 1,
    processStartedAt: owner.processStartedAt,
    exePath: owner.exePath ?? '/sbin/launchd',
    rootNonce: randomBytes(16).toString('hex'),
  });
  // The snapshot stores the workspace as the RUNTIME resolves it (realpath),
  // while the host payload goes through resolveWorkspace before comparison —
  // on macOS /var is a symlink to /private/var, so the raw path never matches.
  const realCwd = await realpath(cwd);
  // The frozen snapshot shape (ids, enums, timestamps); written directly
  // because the writer belongs to a running runtime and this instance's
  // "runtime" is launchd, which has none.
  await writeFile(join(manager.instanceDir, 'nanny.json'), `${JSON.stringify({
    instanceId: manager.instanceId,
    updatedAt: new Date().toISOString(),
    seq: 1,
    turnsDispatched: 1,
    active: [{ turnId: 't-root', sessionId: 's-root', engine: 'codex', state: 'running', startedAt: new Date().toISOString(), cwd: realCwd }],
    pendingInteractions: [],
  })}\n`);
  return { dataRoot, cwd };
}

interface NannyRun { readonly code: number; readonly stdout: string; readonly stderr: string }

function runStandaloneNanny(dataRoot: string, payload: unknown): Promise<NannyRun> {
  // The environment is scrubbed by construction: the whole point is that no
  // marker survives, and the walk must stand in for it.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: process.env['HOME'] ?? tmpdir(),
    REALM_PLUGIN_DATA_ROOT: dataRoot,
  };
  for (const key of Object.keys(env)) if (key.startsWith('REALM_DELEGATION_')) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NANNY_JS], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
    child.stdin.end(JSON.stringify(payload));
  });
}

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close().catch(() => undefined);
});

describe('the nanny walks for itself (SEC-REC-014)', () => {
  it('exits silently when a live ancestor lock delegates it', { timeout: 60_000 }, async () => {
    if (!existsSync(NANNY_JS)) throw new Error('hosts/claude-code/dist/nanny.js is missing; run pnpm build before this case');
    const { dataRoot, cwd } = await delegatedFixture();
    const run = await runStandaloneNanny(dataRoot, { hook_event_name: 'Stop', cwd, stop_hook_active: false });
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
  });

  it('runs normally for a root — the silences above are verdicts, not blindness', { timeout: 60_000 }, async () => {
    if (!existsSync(NANNY_JS)) throw new Error('hosts/claude-code/dist/nanny.js is missing; run pnpm build before this case');
    const { dataRoot, cwd } = await rootFixture();
    const run = await runStandaloneNanny(dataRoot, { hook_event_name: 'Stop', cwd, stop_hook_active: false });
    expect(run.code).toBe(0);
    const decision = JSON.parse(run.stdout) as { decision?: string };
    expect(decision.decision).toBe('block');
  });

  // NANNY-028 (ADR 0033). Every root in the field has closed instance
  // directories beside the live one; none of the cases above did, and reading
  // the locks made every one of them doubt, which left this hook silent on
  // every root session. The closed records carry fabricated identities: a
  // copied one can match the spawned child's real ancestry exactly and silence
  // the hook for a reason that has nothing to do with this case.
  it('speaks on a root whose data root carries closed instances (NANNY-028)', { timeout: 60_000 }, async () => {
    if (!existsSync(NANNY_JS)) throw new Error('hosts/claude-code/dist/nanny.js is missing; run pnpm build before this case');
    const { dataRoot, cwd } = await rootFixture();
    for (let n = 0; n < 6; n += 1) {
      const dir = join(dataRoot, 'instances', `closed-${n}`);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'instance.json'), `${JSON.stringify({
        instanceId: `closed-${n}`,
        pid: 2_000_000 + n,
        processStartedAt: `2026-08-2${n}T00:00:00.000Z`,
        closedAt: '2026-08-25T00:00:00.000Z',
      })}\n`);
    }
    const run = await runStandaloneNanny(dataRoot, { hook_event_name: 'Stop', cwd, stop_hook_active: false });
    expect(run.code).toBe(0);
    const decision = JSON.parse(run.stdout) as { decision?: string };
    expect(decision.decision).toBe('block');
  });

  it('an unreadable instance root is unavailable and stays silent', { timeout: 60_000 }, async () => {
    if (!existsSync(NANNY_JS)) throw new Error('hosts/claude-code/dist/nanny.js is missing; run pnpm build before this case');
    const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-nanny-walk-blind-'));
    roots.push(dataRoot);
    // `instances` as a regular file: the snapshot cannot be taken at all,
    // which is doubt, and doubt keeps the hook quiet.
    await writeFile(join(dataRoot, 'instances'), 'not a directory');
    const run = await runStandaloneNanny(dataRoot, { hook_event_name: 'Stop', cwd: tmpdir(), stop_hook_active: false });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
  });
});
