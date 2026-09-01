// SES-022 / SES-023 / SES-025 / FORK-008: session_create fills worker defaults
// from the project config file; explicit keys always win; the per-engine tier
// sits between profile config and explicit; fork inherits purely. The
// rules are owned by the default-config design record (ADR 0018/0019).
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { PluginConfigError } from '../../packages/plugin/src/plugin-config.js';
import { projectKeyFor } from '../../packages/plugin/src/project-config.js';
import { createTaskShuttleServer, type TaskShuttleServer } from '../../packages/plugin/src/server.js';
import { FakeRunskeinHub } from '../../packages/plugin/src/testkit/fake-runskein.js';

const open: TaskShuttleServer[] = [];

const descriptor = {
  engine: 'codex',
  installed: true,
  authenticated: true,
  available: true,
  capabilities: { loadSession: true, session: { fork: true }, prompt: { image: true, embeddedContext: true }, mcp: {}, providers: false },
  models: [],
  modes: [],
  providers: [],
  configOptions: [],
  source: 'builtin',
};

const engineInfos = [{ id: 'codex', installed: true, authenticated: true, health: 'ready', version: '1.0.0' }];

function fakeHub(hub: FakeRunskeinHub) {
  return Object.assign(hub, {
    on: () => () => undefined,
    rescan: async () => undefined,
  });
}

interface Rig {
  readonly plugin: TaskShuttleServer;
  readonly hostCwd: string;
  readonly dataRoot: string;
}

async function start(): Promise<Rig> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-pd-data-'));
  const hostCwd = await mkdtemp(join(tmpdir(), 'taskshuttle-pd-host-'));
  const hub = new FakeRunskeinHub({ engineInfos: engineInfos as never, descriptors: { codex: descriptor } as never });
  const plugin = createTaskShuttleServer({
    dataRoot,
    env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [hostCwd] }) } as NodeJS.ProcessEnv,
    hostCwd,
    hubFactory: () => fakeHub(hub) as never,
  });
  open.push(plugin);
  await plugin.runtime.ready;
  return { plugin, hostCwd, dataRoot };
}

/** Write the project's default-config file; omit to test the absent-file path. */
async function placeDefaults(rig: Rig, content: unknown): Promise<void> {
  const dir = join(rig.dataRoot, projectKeyFor(rig.hostCwd));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'config.json'), typeof content === 'string' ? content : JSON.stringify(content), { mode: 0o600 });
}

const DEFAULTS = {
  defaultProfile: 'implementing',
  profiles: {
    implementing: { purpose: '实现', config: { model: 'm-impl', reasoning: 'high' } },
    reviewing: { config: { model: 'm-rev' } },
  },
};

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close().catch(() => undefined);
});

describe('worker default profiles on session_create (ADR 0018)', () => {
  it('fills the default profile when the caller gives no config (SES-022)', async () => {
    const rig = await start();
    await placeDefaults(rig, DEFAULTS);
    const created = await rig.plugin.invoke('session_create', { engine: 'codex', cwd: rig.hostCwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.output['config']).toEqual({ model: 'm-impl', reasoning: 'high' });
  });

  it('explicit config wins per key; the profile only fills gaps (SES-022)', async () => {
    const rig = await start();
    await placeDefaults(rig, DEFAULTS);
    const created = await rig.plugin.invoke('session_create', { engine: 'codex', cwd: rig.hostCwd, config: { model: 'm-mine' } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.output['config']).toEqual({ model: 'm-mine', reasoning: 'high' });
  });

  it('selects the named profile when `profile` is given (SES-023)', async () => {
    const rig = await start();
    await placeDefaults(rig, DEFAULTS);
    const created = await rig.plugin.invoke('session_create', { engine: 'codex', cwd: rig.hostCwd, profile: 'reviewing' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.output['config']).toEqual({ model: 'm-rev' });
  });

  it('no profile and no defaultProfile means no fill — byte-identical to before (SES-022)', async () => {
    const rig = await start();
    await placeDefaults(rig, { profiles: { implementing: { config: { model: 'm-impl' } } } });
    const created = await rig.plugin.invoke('session_create', { engine: 'codex', cwd: rig.hostCwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.output['config']).toBeUndefined();
  });

  it('an unknown profile fails INVALID_ARGUMENT and creates nothing (SES-023)', async () => {
    const rig = await start();
    await placeDefaults(rig, DEFAULTS);
    const created = await rig.plugin.invoke('session_create', { engine: 'codex', cwd: rig.hostCwd, profile: 'ghost' });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.code).toBe('INVALID_ARGUMENT');
    const listed = await rig.plugin.invoke('session_list', {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.output['sessions']).toHaveLength(0);
  });

  it('a prototype-member name is not a profile — naming one fails closed (SES-023)', async () => {
    const rig = await start();
    await placeDefaults(rig, DEFAULTS);
    // `toString`/`constructor` resolve through the prototype chain on a naive
    // lookup; without an own-property guard they would read as declared tiers
    // and create without them — the silent path SES-023 forbids.
    const created = await rig.plugin.invoke('session_create', { engine: 'codex', cwd: rig.hostCwd, profile: 'toString' });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.code).toBe('INVALID_ARGUMENT');
    const listed = await rig.plugin.invoke('session_list', {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.output['sessions']).toHaveLength(0);
  });

  it('naming a profile when no file exists fails closed (SES-023)', async () => {
    const rig = await start();
    const created = await rig.plugin.invoke('session_create', { engine: 'codex', cwd: rig.hostCwd, profile: 'implementing' });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.code).toBe('INVALID_ARGUMENT');
  });

  it('an invalid file fails the create but not the plugin (SES-020)', async () => {
    const rig = await start();
    await placeDefaults(rig, '{ not json');
    const created = await rig.plugin.invoke('session_create', { engine: 'codex', cwd: rig.hostCwd });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.code).toBe('INVALID_ARGUMENT');
    // The plugin itself is unharmed: replace the broken file and the next create works.
    await placeDefaults(rig, DEFAULTS);
    const retry = await rig.plugin.invoke('session_create', { engine: 'codex', cwd: rig.hostCwd });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.output['config']).toEqual({ model: 'm-impl', reasoning: 'high' });
  });

  it('fork inherits the parent verbatim; the default file contributes nothing (FORK-008)', async () => {
    const rig = await start();
    // The file appears only AFTER the parent exists: anything on the child is
    // then provably inherited, never filled.
    const parent = await rig.plugin.invoke('session_create', { engine: 'codex', cwd: rig.hostCwd, config: { model: 'm-parent' } });
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;
    await placeDefaults(rig, DEFAULTS);
    const child = await rig.plugin.invoke('session_fork', { sessionId: parent.output.sessionId });
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    expect(child.output['config']).toEqual({ model: 'm-parent' });

    const bare = await rig.plugin.invoke('session_create', { engine: 'codex', cwd: rig.hostCwd, profile: 'reviewing' });
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    const bareChild = await rig.plugin.invoke('session_fork', { sessionId: bare.output.sessionId });
    expect(bareChild.ok).toBe(true);
    if (!bareChild.ok) return;
    expect(bareChild.output['config']).toEqual({ model: 'm-rev' });
  });

  it('merges three tiers: config < engineConfig[E] < explicit (SES-025)', async () => {
    const rig = await start();
    await placeDefaults(rig, {
      defaultProfile: 'implementing',
      profiles: {
        implementing: {
          config: { model: 'm-all', reasoning: 'medium', shared: 'flat' },
          engineConfig: {
            codex: { model: 'm-codex' },
            // Declared but never consulted by this session: codex is the engine.
            pi: { model: 'm-pi', reasoning: 'low', shared: 'pi' },
          },
        },
      },
    });
    const created = await rig.plugin.invoke('session_create', { engine: 'codex', cwd: rig.hostCwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.output['config']).toEqual({ model: 'm-codex', reasoning: 'medium', shared: 'flat' });

    const explicit = await rig.plugin.invoke('session_create', { engine: 'codex', cwd: rig.hostCwd, config: { model: 'm-mine', reasoning: 'high' } });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    expect(explicit.output['config']).toEqual({ model: 'm-mine', reasoning: 'high', shared: 'flat' });
  });

  it('an engine with no engineConfig section gets the flat tier only (SES-025)', async () => {
    const rig = await start();
    await placeDefaults(rig, {
      defaultProfile: 'implementing',
      profiles: {
        implementing: {
          config: { reasoning: 'medium' },
          engineConfig: { pi: { model: 'm-pi' } },
        },
      },
    });
    const created = await rig.plugin.invoke('session_create', { engine: 'codex', cwd: rig.hostCwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.output['config']).toEqual({ reasoning: 'medium' });
  });

  it('an unresolvable host cwd fails start-up with the install-surface error, not a bare errno', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-pd-data-'));
    const gone = join(await mkdtemp(join(tmpdir(), 'taskshuttle-pd-gone-')), 'deleted');
    // loadPluginConfig's narrowToHostCwd owns this condition and reports it
    // field-level; the project-key derivation must not get to throw its bare
    // ENOENT first — that ordering is the only reason this test exists.
    expect(() => createTaskShuttleServer({
      dataRoot,
      env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [gone] }) } as NodeJS.ProcessEnv,
      hostCwd: gone,
      hubFactory: () => { throw new Error('hubFactory must not be reached'); },
    })).toThrowError(PluginConfigError);
  });

  it('derives the project key once at start-up — the host cwd entry may vanish mid-run (SES-021)', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-pd-data-'));
    const real = await mkdtemp(join(tmpdir(), 'taskshuttle-pd-real-'));
    const link = join(await mkdtemp(join(tmpdir(), 'taskshuttle-pd-link-')), 'entry');
    await symlink(real, link);
    const hub = new FakeRunskeinHub({ engineInfos: engineInfos as never, descriptors: { codex: descriptor } as never });
    const plugin = createTaskShuttleServer({
      dataRoot,
      env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [link] }) } as NodeJS.ProcessEnv,
      hostCwd: link,
      hubFactory: () => fakeHub(hub) as never,
    });
    open.push(plugin);
    await plugin.runtime.ready;
    // The key was derived from the symlink entry's realpath at start-up; the
    // file is placed under that key while the entry still exists.
    const rig: Rig = { plugin, hostCwd: link, dataRoot };
    await placeDefaults(rig, DEFAULTS);
    await rm(link);
    // Per-call derivation would now realpath a dead symlink and fail the
    // create; the start-up-derived key keeps the project reachable.
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd: real });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.output['config']).toEqual({ model: 'm-impl', reasoning: 'high' });
  });
});
