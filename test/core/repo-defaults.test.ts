import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskShuttleServer, type TaskShuttleServer } from '../../packages/plugin/src/server.js';
import { FakeRunskeinHub } from '../../packages/plugin/src/testkit/fake-runskein.js';
import { loadRepoConfig, ProjectConfigError, projectKeyFor, resolveRepoProfile } from '../../packages/plugin/src/project-config.js';

const descriptor = {
  engine: 'codex',
  installed: true,
  authenticated: true,
  available: true,
  capabilities: { loadSession: true, session: { fork: true }, prompt: { image: true, embeddedContext: true }, mcp: {}, providers: false },
  models: [], modes: [], providers: [], configOptions: [],
  source: 'builtin',
} as const;
const engineInfos = [{ id: 'codex', installed: true, authenticated: true, health: 'ready', version: '1.0.0' }];
function fakeHub(hub: FakeRunskeinHub) { return Object.assign(hub, { on: () => () => undefined, rescan: async () => undefined }); }
const open: TaskShuttleServer[] = [];
afterEach(async () => { while (open.length > 0) await open.pop()!.close().catch(() => undefined); });

async function tempDir(prefix: string): Promise<string> { return mkdtemp(join(tmpdir(), prefix)); }

describe('repo layer opt-in', () => {
  it('off: invalid R does not block create', async () => {
    const hostCwd = await tempDir('taskshuttle-repo-off-');
    const dataRoot = await tempDir('taskshuttle-repo-off-root-');
    await writeFile(join(hostCwd, 'taskshuttle.config.json'), '{ invalid json');
    const hub = new FakeRunskeinHub({ engineInfos: engineInfos as never, descriptors: { codex: descriptor } as never });
    const plugin = createTaskShuttleServer({ dataRoot, hostCwd, env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [hostCwd], repoDefaults: false }), REALM_PLUGIN_LOG: 'off' } as NodeJS.ProcessEnv, hubFactory: () => fakeHub(hub) as never });
    open.push(plugin);
    await plugin.runtime.ready;
    const res = await plugin.invoke('session_create', { engine: 'codex', cwd: hostCwd });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.output['config']).toBeUndefined();
  });

  it('opt-in on hostCwd join only: symlink/dir → error, 0644 ok, absent → undefined', async () => {
    const hostCwd = await tempDir('taskshuttle-repo-join-');
    // absent → undefined
    expect(loadRepoConfig(hostCwd)).toBeUndefined();
    // 0644 ok (no 0600 check for repo)
    await writeFile(join(hostCwd, 'taskshuttle.config.json'), JSON.stringify({ profiles: { a: { config: { model: 'm' } } } }), { mode: 0o644 });
    await chmod(join(hostCwd, 'taskshuttle.config.json'), 0o644);
    expect(loadRepoConfig(hostCwd)?.profiles['a']?.config).toEqual({ model: 'm' });
    // dir → error
    const host2 = await tempDir('taskshuttle-repo-dir-');
    await mkdir(join(host2, 'taskshuttle.config.json'));
    expect(() => loadRepoConfig(host2)).toThrow(ProjectConfigError);
    // symlink → error
    const host3 = await tempDir('taskshuttle-repo-sym-');
    const target = join(host3, 'real.json');
    await writeFile(target, JSON.stringify({ profiles: { a: { config: { model: 'm' } } } }));
    await symlink(target, join(host3, 'taskshuttle.config.json'));
    expect(() => loadRepoConfig(host3)).toThrow(ProjectConfigError);
  });
});

describe('allowlist', () => {
  it('violations block, same key in P passes', async () => {
    const hostCwd = await tempDir('taskshuttle-repo-allow-');
    await writeFile(join(hostCwd, 'taskshuttle.config.json'), JSON.stringify({ profiles: { a: { config: { api_key: 'x' } } } }));
    expect(() => loadRepoConfig(hostCwd)).toThrow(ProjectConfigError);
    // same key in P is unrestricted — needs valid R so composition doesn't block
    const hostCwd2 = await tempDir('taskshuttle-repo-allow2-');
    await writeFile(join(hostCwd2, 'taskshuttle.config.json'), JSON.stringify({ profiles: { r: { config: { model: 'm' } } } }));
    const dataRoot = await tempDir('taskshuttle-repo-allow-root-');
    const key = projectKeyFor(hostCwd2);
    await mkdir(join(dataRoot, key), { recursive: true, mode: 0o700 });
    await writeFile(join(dataRoot, key, 'config.json'), JSON.stringify({ profiles: { a: { config: { api_key: 'x' } } } }), { mode: 0o600 });
    const hub = new FakeRunskeinHub({ engineInfos: engineInfos as never, descriptors: { codex: descriptor } as never });
    const plugin = createTaskShuttleServer({ dataRoot, hostCwd: hostCwd2, env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [hostCwd2], repoDefaults: true }), REALM_PLUGIN_LOG: 'off' } as NodeJS.ProcessEnv, hubFactory: () => fakeHub(hub) as never });
    open.push(plugin);
    await plugin.runtime.ready;
    const res = await plugin.invoke('session_create', { engine: 'codex', cwd: hostCwd2, profile: 'a' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.output['config']).toEqual({ api_key: 'x' });
  });
});

describe('shadowing and resolution', () => {
  it('P shadows R wholesale', async () => {
    const repo = { profiles: { a: { config: { model: 'm-repo', reasoning: 'low' } } } } as any;
    const project = { profiles: { a: { config: { model: 'm-proj' } } } } as any;
    const { profile, source } = resolveRepoProfile(repo, project, 'a');
    expect(source).toBe('project');
    expect(profile?.config).toEqual({ model: 'm-proj' });
  });
  it('defaultProfile P wins else R', async () => {
    const repo = { defaultProfile: 'r', profiles: { r: { config: { model: 'm-r' } } } } as any;
    const project = { defaultProfile: 'p', profiles: { p: { config: { model: 'm-p' } } } } as any;
    expect(resolveRepoProfile(repo, project, undefined).source).toBe('project');
    expect(resolveRepoProfile(repo, undefined, undefined).source).toBe('repo');
    expect(resolveRepoProfile(undefined, undefined, undefined).profile).toBeUndefined();
    // Dangling defaultProfile is rejected at load time (validateProjectConfig), not here — exercise the load path
    const hostCwd = await tempDir('taskshuttle-repo-dangle-');
    await writeFile(join(hostCwd, 'taskshuttle.config.json'), JSON.stringify({ defaultProfile: 'ghost', profiles: { a: { config: {} } } }));
    expect(() => loadRepoConfig(hostCwd)).toThrow(ProjectConfigError);
  });
  it('explicit profile union lookup', async () => {
    const repo = { profiles: { r: { config: { model: 'm-r' } } } } as any;
    const project = { profiles: { p: { config: { model: 'm-p' } } } } as any;
    expect(resolveRepoProfile(repo, project, 'r').source).toBe('repo');
    expect(resolveRepoProfile(repo, project, 'p').source).toBe('project');
    expect(() => resolveRepoProfile(repo, project, 'ghost')).toThrow(ProjectConfigError);
    expect(() => resolveRepoProfile(undefined, undefined, 'ghost')).toThrow(ProjectConfigError);
    try { resolveRepoProfile(undefined, undefined, 'ghost'); expect.unreachable(); } catch (e) { expect((e as Error).message).toContain('no worker defaults file exists for this project'); }
  });
});

describe('session_create e2e merge (SES-040/SES-044 — repo layer contributes to desired config)', () => {
  it('with repoDefaults:true, session_create merges R profile into config; with repoDefaults:false it does not', async () => {
    const hostCwd = await tempDir('taskshuttle-repo-e2e-');
    const dataRoot = await tempDir('taskshuttle-repo-e2e-root-');
    await writeFile(join(hostCwd, 'taskshuttle.config.json'), JSON.stringify({ defaultProfile: 'a', profiles: { a: { config: { model: 'm-repo', reasoning: 'high' } } } }));
    // repoDefaults:true — R contributes
    const hub = new FakeRunskeinHub({ engineInfos: engineInfos as never, descriptors: { codex: descriptor } as never });
    const plugin = createTaskShuttleServer({ dataRoot, hostCwd, env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [hostCwd], repoDefaults: true }), REALM_PLUGIN_LOG: 'off' } as NodeJS.ProcessEnv, hubFactory: () => fakeHub(hub) as never });
    open.push(plugin);
    await plugin.runtime.ready;
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd: hostCwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.output['config']).toEqual({ model: 'm-repo', reasoning: 'high' });
    await plugin.close(); open.pop();
    // repoDefaults:false — same file on disk, but R not read
    const hub2 = new FakeRunskeinHub({ engineInfos: engineInfos as never, descriptors: { codex: descriptor } as never });
    const plugin2 = createTaskShuttleServer({ dataRoot, hostCwd, env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [hostCwd], repoDefaults: false }), REALM_PLUGIN_LOG: 'off' } as NodeJS.ProcessEnv, hubFactory: () => fakeHub(hub2) as never });
    open.push(plugin2);
    await plugin2.runtime.ready;
    const created2 = await plugin2.invoke('session_create', { engine: 'codex', cwd: hostCwd });
    expect(created2.ok).toBe(true);
    if (!created2.ok) return;
    expect(created2.output['config']).toBeUndefined();
  });
});

describe('worker-write immediacy and project_init non-interference', () => {
  it('next session_create sees rewritten R (SES-044)', async () => {
    const hostCwd = await tempDir('taskshuttle-repo-immed-');
    const dataRoot = await tempDir('taskshuttle-repo-immed-root-');
    await writeFile(join(hostCwd, 'taskshuttle.config.json'), JSON.stringify({ defaultProfile: 'a', profiles: { a: { config: { model: 'm1' } } } }));
    const hub = new FakeRunskeinHub({ engineInfos: engineInfos as never, descriptors: { codex: descriptor } as never });
    const plugin = createTaskShuttleServer({ dataRoot, hostCwd, env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [hostCwd], repoDefaults: true }), REALM_PLUGIN_LOG: 'off' } as NodeJS.ProcessEnv, hubFactory: () => fakeHub(hub) as never });
    open.push(plugin);
    await plugin.runtime.ready;
    const first = await plugin.invoke('session_create', { engine: 'codex', cwd: hostCwd });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.output['config']).toEqual({ model: 'm1' });
    await writeFile(join(hostCwd, 'taskshuttle.config.json'), JSON.stringify({ defaultProfile: 'a', profiles: { a: { config: { model: 'm2' } } } }));
    const second = await plugin.invoke('session_create', { engine: 'codex', cwd: hostCwd });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.output['config']).toEqual({ model: 'm2' });
  });
  it('project_init does not touch R', async () => {
    const hostCwd = await tempDir('taskshuttle-repo-init-');
    const dataRoot = await tempDir('taskshuttle-repo-init-root-');
    const repoContent = JSON.stringify({ profiles: { a: { config: { model: 'm-repo' } } } });
    await writeFile(join(hostCwd, 'taskshuttle.config.json'), repoContent);
    const plugin = createTaskShuttleServer({ dataRoot, hostCwd, env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [hostCwd] }), REALM_PLUGIN_LOG: 'off' } as NodeJS.ProcessEnv });
    await plugin.runtime.ready;
    await plugin.invoke('project_init', {});
    expect(await readFile(join(hostCwd, 'taskshuttle.config.json'), 'utf8')).toBe(repoContent);
    // R still loadable
    expect(loadRepoConfig(hostCwd)?.profiles['a']?.config).toEqual({ model: 'm-repo' });
    await plugin.close();
  });
});
