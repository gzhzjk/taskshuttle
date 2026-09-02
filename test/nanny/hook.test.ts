import { mkdtemp, readdir, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { DELEGATION_ENV } from '../../packages/plugin/src/security-policy.js';
import { normaliseHookInput, runNannyHook, selectInstance } from '../../packages/plugin/src/nanny.js';
import type { AncestryProbe } from '../../packages/plugin/src/delegation-evidence.js';
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

/** The pid the hook is told it has; any number, since the probe below is a literal. */
const HOOK_PID = 9_001;

/**
 * A process table in which the hook is a child of `hostPid` (ADR 0057).
 *
 * The real relationship — hook and instance as siblings under the host — cannot
 * be built inside one test process, where the "hook" and the instance share a
 * pid. Reading the real table instead would make these cases depend on where
 * the vitest worker happens to sit, so the ancestry is a literal and what is
 * under test is the match.
 */
function ancestryOf(hostPid: number, hostStartedAt: string | undefined): AncestryProbe {
  return {
    parentOf: async (pid) => (pid === HOOK_PID ? hostPid : undefined),
    startedAt: async (pid) => (pid === hostPid ? hostStartedAt : undefined),
  };
}

/**
 * The host identity the running instance actually recorded, so the probe can
 * match it. A data root with no instance answers a pid nothing claims, which is
 * the honest shape for the cases that assert silence on an empty root.
 */
async function recordedHost(dataRoot: string): Promise<{ hostPid: number; hostProcessStartedAt: string }> {
  const instances = join(dataRoot, 'instances');
  const entries = await readdir(instances).catch(() => [] as string[]);
  const [entry] = entries.filter((name) => !name.startsWith('.'));
  if (entry === undefined) return { hostPid: 9_999, hostProcessStartedAt: 'no instance here' };
  const manifest = JSON.parse(await readFile(join(instances, entry, 'instance.json'), 'utf8')) as
    { hostPid?: number; hostProcessStartedAt?: string };
  // NANNY-029's assertion, made on every hook case rather than once: an
  // instance that recorded no host identity can never be matched, so a silent
  // regression in the writer would make every case below pass for the wrong
  // reason — the hook would be quiet because nothing matched.
  expect(typeof manifest.hostPid).toBe('number');
  expect(typeof manifest.hostProcessStartedAt).toBe('string');
  return { hostPid: manifest.hostPid!, hostProcessStartedAt: manifest.hostProcessStartedAt! };
}

/**
 * The seams every case needs: a literal ancestry, this file's pid, and a budget
 * that is not racing a real `ps`. The three cases that call `runNannyHook`
 * directly — they need the exit code or stderr, which `runHook` does not return
 * — take the same seams from here rather than each rebuilding them.
 */
async function hookSeams(dataRoot: string): Promise<{ pid: number; probe: AncestryProbe; budgetMs: number }> {
  const host = await recordedHost(dataRoot);
  return { pid: HOOK_PID, probe: ancestryOf(host.hostPid, host.hostProcessStartedAt), budgetMs: UNRACED_BUDGET_MS };
}

/** Runs the hook the way a host does: a JSON payload in, at most one JSON object out. */
/**
 * A budget long enough that no case here races a real `ps`.
 *
 * The hook spends one budget across `settleDelegation`'s ancestry walk — a
 * process spawn per hop on darwin — and the state read. At the production
 * second, a loaded machine does not finish, the verdict is `unavailable`, and
 * the hook correctly falls silent; every case below that asserts it *speaks*
 * then fails for a reason that is about the machine and not the decision it
 * names. Two of them failed a release that way (GZH-116). The lapse has its own
 * case, which asks for a budget it cannot meet.
 */
const UNRACED_BUDGET_MS = 60_000;

async function runHook(
  dataRoot: string,
  payload: unknown,
  env: NodeJS.ProcessEnv = {},
  probe?: AncestryProbe,
  budgetMs: number = UNRACED_BUDGET_MS,
): Promise<string> {
  let out = '';
  const resolved = probe ?? ancestryOf(...await (async (): Promise<[number, string]> => {
    const host = await recordedHost(dataRoot);
    return [host.hostPid, host.hostProcessStartedAt];
  })());
  const code = await runNannyHook({
    env: { REALM_PLUGIN_DATA_ROOT: dataRoot, ...env },
    stdin: Readable.from([JSON.stringify(payload)]),
    pid: HOOK_PID,
    probe: resolved,
    budgetMs,
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
      ...await hookSeams(dataRoot),
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
      ...await hookSeams(dataRoot),
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

  it("NANNY-033: another session's instance is not read — not its turns, not its anchor", async () => {
    // The GZH-82 regression, through the whole hook rather than through
    // `selectInstance`: the anchor is read in `readState`, so a case that
    // stopped at the selection would never observe the disclosure it exists to
    // prevent. One live instance, a running turn and a written anchor, and a
    // hook whose ancestry does not contain that instance's host.
    const { plugin, dataRoot } = await startPlugin();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-nanny-cwd-'));
    const turnId = await dispatchTurn(plugin, cwd);
    const wrote = await plugin.invoke('anchor', { content: 'PRIVATE PLAN: ship the thing' });
    expect(wrote.ok).toBe(true);

    // Before ADR 0057 this is exactly the state that spoke: one live instance
    // with a turn in this cwd, so the directory filter chose it.
    const stranger: AncestryProbe = {
      parentOf: async (pid) => (pid === HOOK_PID ? 4_242 : 1),
      startedAt: async () => 'a host this hook never descended from',
    };
    const out = await runHook(dataRoot, { hook_event_name: 'Stop', cwd, stop_hook_active: false }, {}, stranger);
    expect(out).toBe('');
    expect(out).not.toContain(turnId);
    expect(out).not.toContain('PRIVATE PLAN');
  });

  it('NANNY-034: the budget reaches both things that enforce one', async () => {
    // Not timing, and it cannot be. `settleDelegation` holds its **own**
    // `setTimeout(budgetMs)`, so a hook that widened only its outer race would
    // still self-lapse inside the walk on a loaded machine and the fix would be
    // inert — yet on an unloaded one the walk finishes in tens of milliseconds,
    // so no case here can go red on the omission. Removing the threading was
    // negative-tested and left the suite green, which is why this is a
    // structural assertion instead of a silent hope.
    const source = await readFile(join(process.cwd(), 'packages', 'plugin', 'src', 'nanny.ts'), 'utf8');
    expect(source).toMatch(/settleDelegation\(\{[^}]*\bbudgetMs\b[^}]*\}\)/);
    expect(source).not.toMatch(/settleDelegation\(\{[^}]*budgetMs:\s*BUDGET_MS[^}]*\}\)/);
  });

  it('NANNY-034: a budget it cannot meet is silence, not a guess', async () => {
    // The path every case above depends on and none of them covered. The hook
    // spends one budget across the delegation walk and the state read; when it
    // lapses the verdict is `unavailable` and the contract is to say nothing
    // (ADR 0015 §6) rather than block a session on state it could not read.
    // Nothing asserted that, so when a loaded machine made the production
    // second too short, six cases went red and the reason looked like a defect
    // in the hook (GZH-116).
    const { plugin, dataRoot } = await startPlugin();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-nanny-cwd-'));
    await dispatchTurn(plugin, cwd);

    // Same state that blocks in NANNY-001; only the budget differs.
    const out = await runHook(dataRoot, { hook_event_name: 'Stop', cwd, stop_hook_active: false }, {}, undefined, 0);
    expect(out).toBe('');
  });

  it('NANNY-002: an empty data root is silence, not a block', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'taskshuttle-nanny-empty-'));
    expect(await runHook(empty, { hook_event_name: 'Stop', cwd: empty, stop_hook_active: false })).toBe('');
  });

  it('NANNY-002: a malformed payload is silence, not a crash', async () => {
    const { dataRoot } = await startPlugin();
    let out = '';
    const code = await runNannyHook({
      ...await hookSeams(dataRoot),
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

});

/**
 * Selection by identity (ADR 0057). The chains here are literals: what is under
 * test is which instance the hook picks, not whether a real process table can
 * be read.
 */
describe('which instance a stop belongs to', () => {
  const entry = (id: string, host?: { hostPid: number; hostProcessStartedAt: string }) => ({
    instance: { instanceId: id, instanceDir: `/tmp/${id}`, createdAt: '2026-08-21T00:00:00.000Z', ...(host ?? {}) },
    snapshot: undefined,
  });

  /** A chain given nearest-first from pid 500, each entry with its start time. */
  const chain = (hops: { pid: number; startedAt?: string }[]): AncestryProbe => {
    const pids = [500, ...hops.map((hop) => hop.pid)];
    return {
      parentOf: async (pid) => { const index = pids.indexOf(pid); return index === -1 || index + 1 >= pids.length ? 1 : pids[index + 1]; },
      startedAt: async (pid) => hops.find((hop) => hop.pid === pid)?.startedAt,
    };
  };

  it('NANNY-030: the nearest ancestor that matches wins', async () => {
    const near = entry('near', { hostPid: 600, hostProcessStartedAt: 'T600' });
    const far = entry('far', { hostPid: 700, hostProcessStartedAt: 'T700' });
    const probe = chain([{ pid: 600, startedAt: 'T600' }, { pid: 700, startedAt: 'T700' }]);
    // Order in the candidate list must not decide it; the chain must.
    expect(await selectInstance([far, near], { pid: 500, probe })).toBe(near);
  });

  it('NANNY-031: a matching pid with a different start time is not a match', async () => {
    const stale = entry('stale', { hostPid: 600, hostProcessStartedAt: 'T600' });
    // Same pid, reused by a different process. Walking on finds nothing else.
    const probe = chain([{ pid: 600, startedAt: 'T600-but-reused' }]);
    expect(await selectInstance([stale], { pid: 500, probe })).toBeUndefined();
  });

  it('NANNY-023: two instances naming the same host process yield nothing', async () => {
    const a = entry('a', { hostPid: 600, hostProcessStartedAt: 'T600' });
    const b = entry('b', { hostPid: 600, hostProcessStartedAt: 'T600' });
    const probe = chain([{ pid: 600, startedAt: 'T600' }]);
    expect(await selectInstance([a, b], { pid: 500, probe })).toBeUndefined();
  });

  it('NANNY-032: a lone live instance whose host is nowhere in the chain is not chosen', async () => {
    // The GZH-82 shape at the selection level: being the only instance on the
    // machine is not evidence of being the right one.
    const other = entry('other', { hostPid: 999, hostProcessStartedAt: 'T999' });
    const probe = chain([{ pid: 600, startedAt: 'T600' }]);
    expect(await selectInstance([other], { pid: 500, probe })).toBeUndefined();
  });

  it('NANNY-029: an instance that recorded no host identity is never matched', async () => {
    const legacy = entry('legacy');
    const probe = chain([{ pid: 600, startedAt: 'T600' }]);
    expect(await selectInstance([legacy], { pid: 500, probe })).toBeUndefined();
  });

  it('NANNY-029: a half identity is not an identity — a pid without a start time is skipped', async () => {
    // The writer records both or neither. This pins the reader's half of that
    // rule — a record with a pid alone is never matched — which the start-time
    // comparison enforces, not the skip that keeps such records out of the map.
    const half = { instance: { instanceId: 'half', instanceDir: '/tmp/half', createdAt: '2026-08-21T00:00:00.000Z', hostPid: 600 }, snapshot: undefined };
    const probe = chain([{ pid: 600, startedAt: 'T600' }]);
    expect(await selectInstance([half], { pid: 500, probe })).toBeUndefined();
  });

  it('NANNY-031: an ancestor whose start time cannot be read is not a match', async () => {
    const claimant = entry('claimant', { hostPid: 600, hostProcessStartedAt: 'T600' });
    const probe = chain([{ pid: 600 }]);
    expect(await selectInstance([claimant], { pid: 500, probe })).toBeUndefined();
  });

  it('NANNY-032: a walk that cannot read a parent establishes nothing', async () => {
    const claimant = entry('claimant', { hostPid: 600, hostProcessStartedAt: 'T600' });
    const blind: AncestryProbe = { parentOf: async () => undefined, startedAt: async () => 'T600' };
    expect(await selectInstance([claimant], { pid: 500, probe: blind })).toBeUndefined();
  });

  it('NANNY-032: a chain longer than the bound establishes nothing', async () => {
    // An unbounded walk in a path a person is waiting on is a hang waiting for
    // a pathological process table (mvp §5.2's reasoning, same bound).
    const claimant = entry('claimant', { hostPid: 600, hostProcessStartedAt: 'T600' });
    const ladder: AncestryProbe = { parentOf: async (pid) => pid + 1, startedAt: async () => 'T600' };
    expect(await selectInstance([claimant], { pid: 500, probe: ladder, maxHops: 3 })).toBeUndefined();
    // …and with room to reach it, the same chain matches: the bound is what
    // refused, not the chain.
    expect(await selectInstance([claimant], { pid: 500, probe: ladder, maxHops: 200 })).toBe(claimant);
  });

  it('NANNY-032: a cycle in the chain is not a finished walk', async () => {
    const claimant = entry('claimant', { hostPid: 600, hostProcessStartedAt: 'T600' });
    const looping: AncestryProbe = { parentOf: async (pid) => (pid === 500 ? 400 : 500), startedAt: async () => 'T600' };
    expect(await selectInstance([claimant], { pid: 500, probe: looping })).toBeUndefined();
  });
});
