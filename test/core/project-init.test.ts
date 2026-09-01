// INIT-001..006: project_init generates the project's worker-defaults file from
// the live registry and starts the console. The generation and flow rules are
// owned by the project-init design record; these tests pin them. The console-side matrix
// (CONSOLE-030..033) lives in scripts/live-console.ts; the depth and
// allowInitStart gates are asserted here too because they cost nothing live.
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { LogRecord } from '../../packages/plugin/src/logger.js';
import { projectKeyFor } from '../../packages/plugin/src/project-config.js';
import { createTaskShuttleServer, type TaskShuttleServer } from '../../packages/plugin/src/server.js';
import { FakeRunskeinHub } from '../../packages/plugin/src/testkit/fake-runskein.js';

const open: TaskShuttleServer[] = [];
const logs = new Map<TaskShuttleServer, LogRecord[]>();
const blockers: NetServer[] = [];

/** The minimal template skeleton; generation must take profile names/purpose from it. */
const TEMPLATE = {
  defaultProfile: 'implementing',
  profiles: {
    implementing: { purpose: '实现已定的任务', config: {} },
    reviewing: { config: {} },
  },
};

interface EngineSpec {
  readonly id: string;
  readonly installed: boolean;
  readonly configOptions?: Array<{ id: string; name?: string; category?: string; type?: string; currentValue?: string | boolean }>;
}

interface Rig {
  readonly plugin: TaskShuttleServer;
  readonly hostCwd: string;
  readonly dataRoot: string;
  readonly infos: Array<Record<string, unknown>>;
  readonly descriptors: Record<string, unknown>;
  readonly rescans: { count: number };
}

function descriptorOf(spec: EngineSpec): Record<string, unknown> {
  return {
    engine: spec.id,
    installed: spec.installed,
    authenticated: spec.installed,
    available: spec.installed,
    capabilities: { loadSession: true, session: {}, prompt: {}, mcp: {}, providers: false },
    configOptions: (spec.configOptions ?? []).map((option) => ({ name: option.id, type: 'select', ...option })),
    source: 'probe',
  };
}

async function start(engines: EngineSpec[], config: Record<string, unknown> = {}, extraEnv: NodeJS.ProcessEnv = {}): Promise<Rig> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-init-data-'));
  const hostCwd = await mkdtemp(join(tmpdir(), 'taskshuttle-init-host-'));
  const templatePath = join(await mkdtemp(join(tmpdir(), 'taskshuttle-init-tpl-')), 'default-config.json');
  await writeFile(templatePath, JSON.stringify(TEMPLATE), { mode: 0o600 });
  const rescans = { count: 0 };
  const infos = engines.map((spec) => ({ id: spec.id, installed: spec.installed, authenticated: spec.installed, health: spec.installed ? 'ready' : 'not-installed', version: '1.0.0' }));
  const descriptors: Record<string, unknown> = Object.fromEntries(engines.filter((spec) => spec.installed).map((spec) => [spec.id, descriptorOf(spec)]));
  const hub = new FakeRunskeinHub({ engineInfos: infos as never, descriptors: descriptors as never });
  Object.assign(hub, {
    on: () => () => undefined,
    rescan: async () => { rescans.count += 1; },
  });
  const sink: LogRecord[] = [];
  const plugin = createTaskShuttleServer({
    dataRoot,
    env: {
      REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [hostCwd], ...config }),
      REALM_PLUGIN_DEFAULTS_TEMPLATE: templatePath,
      REALM_PLUGIN_LOG: 'off',
      ...extraEnv,
    } as NodeJS.ProcessEnv,
    hostCwd,
    hubFactory: () => hub as never,
    logSink: (record) => { sink.push(record); },
  });
  open.push(plugin);
  logs.set(plugin, sink);
  await plugin.runtime.ready;
  return { plugin, hostCwd, dataRoot, infos, descriptors, rescans };
}

const CODEX: EngineSpec = {
  id: 'codex',
  installed: true,
  configOptions: [
    { id: 'model', category: 'model', currentValue: 'm-current' },
    { id: 'reasoning_effort', category: 'thought_level', currentValue: 'high' },
    { id: 'approval', category: 'mode', currentValue: 'on-request' },
    { id: 'valueless', category: 'model' },
  ],
};

function configPath(rig: Rig): string {
  return join(rig.dataRoot, projectKeyFor(rig.hostCwd), 'config.json');
}

function consoleManifestPath(rig: Rig): string {
  return join(rig.dataRoot, 'instances', rig.plugin.runtime.instanceId, 'console.json');
}

/** Parse the returned content and collect every profile's engineConfig. */
function engineSections(content: string): Array<Record<string, Record<string, string | boolean>>> {
  const parsed = JSON.parse(content) as { profiles: Record<string, { engineConfig?: Record<string, Record<string, string | boolean>> }> };
  return Object.values(parsed.profiles).map((profile) => profile.engineConfig ?? {});
}

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close().catch(() => undefined);
  while (blockers.length > 0) await new Promise<void>((done) => blockers.pop()!.close(() => done()));
});

describe('project_init (ADR 0019)', () => {
  it('INIT-001: uninstalled engines are pruned into enginesOmitted only, and the lists describe the content regardless of created', async () => {
    const rig = await start([CODEX, { id: 'pi', installed: false }]);
    const first = await rig.plugin.invoke('project_init', {});
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.output.created).toBe(true);
    expect(first.output.path).toBe(configPath(rig));
    for (const sections of engineSections(first.output.content)) {
      expect(Object.keys(sections)).toEqual(['codex']);
    }
    // The omitted engine is named in the output and nowhere in the file — not
    // even the purpose text, which would go stale the moment it was written.
    expect(first.output.enginesIncluded).toEqual(['codex']);
    expect(first.output.enginesOmitted).toEqual(['pi']);
    expect(first.output.content).not.toContain('"pi"');

    // Same call again: untouched file, and the same口径 for both lists.
    const second = await rig.plugin.invoke('project_init', {});
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.output.created).toBe(false);
    expect(second.output.content).toBe(first.output.content);
    expect(second.output.enginesIncluded).toEqual(['codex']);
    expect(second.output.enginesOmitted).toEqual(['pi']);
  });

  it('INIT-002: keys are copied verbatim from each descriptor — model/thought_level with currentValue only; other engines get an empty section', async () => {
    const rig = await start([CODEX, { id: 'kimi', installed: true, configOptions: [] }]);
    const result = await rig.plugin.invoke('project_init', {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const sections of engineSections(result.output.content)) {
      expect(sections['codex']).toEqual({ model: 'm-current', reasoning_effort: 'high' });
      expect(sections['kimi']).toEqual({});
    }
    expect(result.output.enginesIncluded).toEqual(['codex', 'kimi']);
    expect(result.output.enginesOmitted).toEqual([]);
  });

  it('INIT-003: the registry is rescanned before generating — an engine installed mid-run is seen by that very call', async () => {
    const rig = await start([CODEX, { id: 'opencode', installed: false }]);
    const first = await rig.plugin.invoke('project_init', {});
    expect(first.ok && first.output.created).toBe(true);
    // Install opencode now: the registry and its descriptor change under a
    // running plugin, and no restart may be required to see it.
    const entry = rig.infos.find((info) => info['id'] === 'opencode');
    if (entry === undefined) throw new Error('fixture lost opencode');
    entry['installed'] = true;
    entry['authenticated'] = true;
    entry['health'] = 'ready';
    rig.descriptors['opencode'] = descriptorOf({
      id: 'opencode',
      installed: true,
      configOptions: [{ id: 'model', category: 'model', currentValue: 'm-open' }],
    });
    const refreshed = await rig.plugin.invoke('project_init', { refresh: true });
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.output.created).toBe(true);
    for (const sections of engineSections(refreshed.output.content)) {
      expect(sections['opencode']).toEqual({ model: 'm-open' });
    }
    expect(refreshed.output.enginesIncluded).toEqual(['codex', 'opencode']);
    expect(refreshed.output.enginesOmitted).toEqual([]);
    // One rescan per call, including the calls that regenerate.
    expect(rig.rescans.count).toBe(2);
  });

  it('INIT-004: an existing valid file is returned untouched without refresh; refresh appends new sections without rewriting any existing key', async () => {
    const rig = await start([CODEX, { id: 'opencode', installed: false }]);
    // A file the user edited by hand: a custom flat key, and a codex section
    // whose model deliberately differs from the descriptor's current value.
    const edited = {
      defaultProfile: 'implementing',
      profiles: {
        implementing: {
          purpose: '用户手写',
          config: { custom: 'mine' },
          engineConfig: { codex: { model: 'user-edited' } },
        },
      },
    };
    const path = configPath(rig);
    await mkdir(join(rig.dataRoot, projectKeyFor(rig.hostCwd)), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(edited), { mode: 0o600 });

    const untouched = await rig.plugin.invoke('project_init', {});
    expect(untouched.ok).toBe(true);
    if (!untouched.ok) return;
    expect(untouched.output.created).toBe(false);
    expect(untouched.output.content).toBe(JSON.stringify(edited));
    expect(untouched.output.enginesIncluded).toEqual(['codex']);
    // Installed-but-undeclared codex is declared here, so only the uninstalled
    // opencode is omitted; the registry knowing more than the file is the
    // refresh signal.
    expect(untouched.output.enginesOmitted).toEqual(['opencode']);

    const entry = rig.infos.find((info) => info['id'] === 'opencode');
    if (entry === undefined) throw new Error('fixture lost opencode');
    entry['installed'] = true;
    entry['authenticated'] = true;
    entry['health'] = 'ready';
    rig.descriptors['opencode'] = descriptorOf({
      id: 'opencode',
      installed: true,
      configOptions: [{ id: 'model', category: 'model', currentValue: 'm-open' }],
    });
    const refreshed = await rig.plugin.invoke('project_init', { refresh: true });
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.output.created).toBe(true);
    const merged = JSON.parse(refreshed.output.content) as {
      profiles: Record<string, { purpose?: string; config?: Record<string, unknown>; engineConfig?: Record<string, Record<string, unknown>> }>;
    };
    // No existing key rewritten or deleted: the user's model choice and custom
    // flat key survive verbatim, whatever the descriptor now reports.
    expect(merged.profiles['implementing']?.config).toEqual({ custom: 'mine' });
    expect(merged.profiles['implementing']?.engineConfig?.['codex']).toEqual({ model: 'user-edited' });
    expect(merged.profiles['implementing']?.engineConfig?.['opencode']).toEqual({ model: 'm-open' });
    expect(merged.profiles['implementing']?.purpose).toBe('用户手写');
  });

  it('INIT-004: an existing invalid file is a field-level error — never returned, never overwritten, refresh included', async () => {
    const rig = await start([CODEX]);
    const path = configPath(rig);
    await mkdir(join(rig.dataRoot, projectKeyFor(rig.hostCwd)), { recursive: true, mode: 0o700 });
    const invalidBodies = ['{ not json', JSON.stringify({ profiles: { a: { config: {} }, typo: 1 } })];
    for (const body of invalidBodies) {
      await writeFile(path, body, { mode: 0o600 });
      for (const args of [{}, { refresh: true }]) {
        const result = await rig.plugin.invoke('project_init', args);
        expect(result.ok, JSON.stringify(args)).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('INVALID_ARGUMENT');
        // The file on disk is byte-identical afterwards.
        expect(await readFile(path, 'utf8')).toBe(body);
      }
    }
    // Over the 64 KiB content ceiling a valid file counts as invalid too.
    const oversized = JSON.stringify({ profiles: { a: { config: {}, purpose: 'x'.repeat(70 * 1024) } } });
    await writeFile(path, oversized, { mode: 0o600 });
    const big = await rig.plugin.invoke('project_init', {});
    expect(big.ok).toBe(false);
    if (big.ok) return;
    expect(big.error.code).toBe('INVALID_ARGUMENT');
    expect(await readFile(path, 'utf8')).toBe(oversized);
  });

  it('INIT-005: the file is written 0600 in a 0700 directory; a symlink target is a field-level error, never followed', async () => {
    const rig = await start([CODEX]);
    const result = await rig.plugin.invoke('project_init', {});
    expect(result.ok).toBe(true);
    const info = await stat(configPath(rig));
    expect(info.mode & 0o777).toBe(0o600);
    const dirInfo = await stat(join(rig.dataRoot, projectKeyFor(rig.hostCwd)));
    expect(dirInfo.mode & 0o777).toBe(0o700);

    const second = await start([CODEX]);
    const dir = join(second.dataRoot, projectKeyFor(second.hostCwd));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const elsewhere = join(second.dataRoot, 'elsewhere.json');
    await writeFile(elsewhere, '{"sentinel":true}', { mode: 0o600 });
    await symlink(elsewhere, join(dir, 'config.json'));
    const refused = await second.plugin.invoke('project_init', {});
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe('INVALID_ARGUMENT');
    expect(await readFile(elsewhere, 'utf8')).toBe('{"sentinel":true}');
  });

  it('INIT-006: a console start failure is reported without failing the call; a file-write failure fails the call before the console is touched', async () => {
    // Occupy a port and make it the console's explicit one: the same
    // field-level console.port error the boot path raises, here caught into
    // 'start-failed' while the file result stands.
    const blocker = createNetServer();
    blockers.push(blocker);
    await new Promise<void>((done) => blocker.listen(0, '127.0.0.1', done));
    const address = blocker.address();
    if (address === null || typeof address === 'string') throw new Error('blocker has no port');
    const rig = await start([CODEX], { console: { enabled: false, port: address.port } });
    const result = await rig.plugin.invoke('project_init', {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.created).toBe(true);
    expect(result.output.console).toEqual({ state: 'start-failed' });
    expect(existsSync(consoleManifestPath(rig))).toBe(false);
    expect(logs.get(rig.plugin)!.some((record) => record.event === 'console_start_failed' && record['errorCode'] === 'INVALID_ARGUMENT')).toBe(true);

    // The write side is the primary artifact: make the project directory
    // unwritable and the whole call fails, with no console started at all.
    const broken = await start([CODEX]);
    const dir = join(broken.dataRoot, projectKeyFor(broken.hostCwd));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o500);
    try {
      const failed = await broken.plugin.invoke('project_init', {});
      expect(failed.ok).toBe(false);
      expect(existsSync(consoleManifestPath(broken))).toBe(false);
    } finally {
      await chmod(dir, 0o700);
    }
  });

  it('starts the console on the same path as boot: enabled:false does not block init, and a second call reports already-running', async () => {
    const rig = await start([CODEX]);
    expect(existsSync(consoleManifestPath(rig))).toBe(false);
    const first = await rig.plugin.invoke('project_init', {});
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.output.console.state).toBe('started');
    expect(first.output.console.port).toBeGreaterThan(0);
    expect(existsSync(consoleManifestPath(rig))).toBe(true);
    // ADR 0019 clause 3's bound, minus the token half that ADR 0032 struck
    // with the token itself: the output carries a status word and the loopback
    // port, and nothing else. The manifest is { port, startedAt } — a `token`
    // key here would be a credential nothing checks.
    const manifest = JSON.parse(await readFile(consoleManifestPath(rig), 'utf8')) as Record<string, unknown>;
    expect(manifest['port']).toBe(first.output.console.port);
    // Exactly these keys: asserting the absence of `token` alone would pass a
    // manifest that moved the credential under another name or nested it.
    expect(Object.keys(manifest).sort()).toEqual(['port', 'startedAt']);
    // Keys alone would pass a manifest whose startedAt is null or a number.
    expect(typeof manifest['startedAt']).toBe('string');
    expect(new Date(String(manifest['startedAt'])).toISOString()).toBe(manifest['startedAt']);
    expect(Object.keys(first.output.console).sort()).toEqual(['port', 'state']);

    const second = await rig.plugin.invoke('project_init', {});
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.output.console).toEqual({ state: 'already-running', port: manifest.port });
  });

  it('allowInitStart: false reports disabled and starts nothing; the file is still written', async () => {
    const rig = await start([CODEX], { console: { allowInitStart: false } });
    const result = await rig.plugin.invoke('project_init', {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.created).toBe(true);
    expect(result.output.console).toEqual({ state: 'disabled' });
    expect(existsSync(consoleManifestPath(rig))).toBe(false);
  });

  it('a delegated instance (depth >= 1) is refused outright — neither the file nor the console side happens', async () => {
    const rig = await start([CODEX], {}, {
      REALM_DELEGATION_VERSION: '1',
      REALM_DELEGATION_DEPTH: '1',
      REALM_DELEGATION_ROOT: randomBytes(16).toString('hex'),
    });
    const result = await rig.plugin.invoke('project_init', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_SUPPORTED');
    expect(existsSync(configPath(rig))).toBe(false);
    expect(existsSync(consoleManifestPath(rig))).toBe(false);
  });

  it('a closing instance refuses the mutation like any other', async () => {
    const rig = await start([CODEX]);
    await rig.plugin.close();
    const result = await rig.plugin.invoke('project_init', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SESSION_UNAVAILABLE');
  });
});
