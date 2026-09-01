import { mkdirSync, mkdtempSync, rmSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { compatEnv, createCompatReport, defaultPluginConfig, installRootFrom, loadPluginConfig, PluginConfigError, resolveDataRoot, resolveHostCwd, resolvePluginConfig } from '../../packages/plugin/src/plugin-config.js';

const roots = { allowedRoots: ['/tmp'] } as const;

/* A throw-away tree standing in for the host's working directory (ADR 0007).
   realpath'd up front: on macOS tmpdir() is itself a symlink, and the rule
   compares resolved paths. */
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'taskshuttle-roots-')));
const hostCwd = join(fixture, 'host');
const inner = join(hostCwd, 'pkg');
const outside = join(fixture, 'elsewhere');
const sibling = `${hostCwd}-sibling`;
const linkInside = join(hostCwd, 'link-in');
const linkOutside = join(hostCwd, 'link-out');
for (const dir of [hostCwd, inner, outside, sibling]) mkdirSync(dir, { recursive: true });
symlinkSync(inner, linkInside);
symlinkSync(outside, linkOutside);

describe('plugin install configuration', () => {
  it('resolves the fresh TaskShuttle root with explicit and legacy precedence', () => {
    expect(resolveDataRoot({ TASKSHUTTLE_DATA_ROOT: '/new', REALM_PLUGIN_DATA_ROOT: '/old' })).toBe('/new');
    expect(resolveDataRoot({ REALM_PLUGIN_DATA_ROOT: '/old' })).toBe('/old');
    expect(resolveDataRoot({}, '/explicit')).toBe('/explicit');
  });

  it('reports each accepted legacy spelling once and lets empty new values win', () => {
    const report = createCompatReport();
    expect(compatEnv({ TASKSHUTTLE_ALLOWED_ROOTS: '', REALM_PLUGIN_ALLOWED_ROOTS: '/old' }, 'TASKSHUTTLE_ALLOWED_ROOTS', 'REALM_PLUGIN_ALLOWED_ROOTS', report)).toBe('');
    expect(compatEnv({ REALM_PLUGIN_ALLOWED_ROOTS: '/old' }, 'TASKSHUTTLE_ALLOWED_ROOTS', 'REALM_PLUGIN_ALLOWED_ROOTS', report)).toBe('/old');
    expect(compatEnv({ REALM_PLUGIN_ALLOWED_ROOTS: '/old' }, 'TASKSHUTTLE_ALLOWED_ROOTS', 'REALM_PLUGIN_ALLOWED_ROOTS', report)).toBe('/old');
    expect(report.entries).toEqual(['REALM_PLUGIN_ALLOWED_ROOTS']);
  });

  it('applies the frozen defaults when the install surface is empty', () => {
    const config = resolvePluginConfig({}, roots);
    expect(config).toMatchObject({
      maxOpenSessions: 32,
      maxActiveTurns: 8,
      maxActiveTurnsPerEngine: 2,
      maxQueuedTurns: 256,
      interactionTtlMs: defaultPluginConfig.interactionTtlMs,
      retentionDays: 30,
      responseByteBudget: 1_048_576,
    });
    expect(config.allowedRoots).toEqual(['/tmp']);
    expect(config.mcpCatalog).toEqual({});
    expect(config.console).toEqual({ enabled: false, port: 0, exposeTranscripts: true, maxConsoleStreams: 8, allowInitStart: true });
  });

  it('defaults the console to disabled and validates its fields at the install surface', () => {
    const config = resolvePluginConfig({ console: { enabled: true, port: 4720, exposeTranscripts: false, maxConsoleStreams: 16, allowInitStart: false } }, roots);
    expect(config.console).toEqual({ enabled: true, port: 4720, exposeTranscripts: false, maxConsoleStreams: 16, allowInitStart: false });
    expect(() => resolvePluginConfig({ console: { enabled: 'yes' } }, roots)).toThrow(/console\.enabled/);
    expect(() => resolvePluginConfig({ console: { port: -1 } }, roots)).toThrow(/console\.port/);
    expect(() => resolvePluginConfig({ console: { port: 65_536 } }, roots)).toThrow(/console\.port/);
    expect(() => resolvePluginConfig({ console: { maxConsoleStreams: 0 } }, roots)).toThrow(/console\.maxConsoleStreams/);
    expect(() => resolvePluginConfig({ console: { maxConsoleStreams: 65 } }, roots)).toThrow(/console\.maxConsoleStreams/);
    expect(() => resolvePluginConfig({ console: { exposeTranscripts: 1 } }, roots)).toThrow(/console\.exposeTranscripts/);
    // ADR 0019: the operator's veto over project_init's console start.
    expect(() => resolvePluginConfig({ console: { allowInitStart: 'no' } }, roots)).toThrow(/console\.allowInitStart/);
    expect(() => resolvePluginConfig({ console: { host: '0.0.0.0' } }, roots)).toThrow(/console\.host/);
    expect(() => resolvePluginConfig({ console: true }, roots)).toThrow(/'console'/);
  });

  it('rejects unknown fields instead of ignoring them', () => {
    expect(() => resolvePluginConfig({ maxOpenSession: 4 }, roots)).toThrow(PluginConfigError);
  });

  it('rejects out-of-range values instead of clamping', () => {
    for (const input of [{ maxOpenSessions: 0 }, { maxOpenSessions: 257 }, { maxActiveTurns: 65 }, { maxQueuedTurns: 4097 }, { interactionTtlMs: 59_999 }, { responseByteBudget: 1_048_575 }, { retentionDays: -1 }]) {
      expect(() => resolvePluginConfig(input, roots), JSON.stringify(input)).toThrow(PluginConfigError);
    }
    expect(resolvePluginConfig({ maxOpenSessions: 1 }, roots).maxOpenSessions).toBe(1);
    expect(resolvePluginConfig({ maxOpenSessions: 256 }, roots).maxOpenSessions).toBe(256);
    expect(resolvePluginConfig({ interactionTtlMs: null }, roots).interactionTtlMs).toBeNull();
    expect(resolvePluginConfig({ retentionDays: null }, roots).retentionDays).toBeNull();
    expect(resolvePluginConfig({ retentionDays: 0 }, roots).retentionDays).toBe(0);
  });

  it('keeps per-engine turn limits under the global limit', () => {
    expect(() => resolvePluginConfig({ maxActiveTurns: 2, maxActiveTurnsPerEngine: 3 }, roots)).toThrow(/maxActiveTurnsPerEngine/);
    expect(resolvePluginConfig({ maxActiveTurns: 4, maxActiveTurnsPerEngine: 4 }, roots).maxActiveTurnsPerEngine).toBe(4);
  });

  it('validates the MCP catalog and refuses raw transport details', () => {
    const entry = { id: 'docs', transport: 'stdio', startupTimeoutMs: 1_000, connectionTimeoutMs: 1_000, permissionDescription: 'documentation search' };
    expect(resolvePluginConfig({ mcpCatalog: { docs: entry } }, roots).mcpCatalog['docs']).toMatchObject({ id: 'docs' });
    expect(() => resolvePluginConfig({ mcpCatalog: { docs: { ...entry, command: 'node' } } }, roots)).toThrow(PluginConfigError);
    expect(() => resolvePluginConfig({ mcpCatalog: { 'realm-plugin': { ...entry, id: 'realm-plugin' } } }, roots)).toThrow(PluginConfigError);
  });

  it('reads the trusted host context from the environment', () => {
    const config = loadPluginConfig(
      { REALM_PLUGIN_CONFIG: JSON.stringify({ maxOpenSessions: 3 }), REALM_PLUGIN_ALLOWED_ROOTS: inner } as NodeJS.ProcessEnv,
      { hostCwd },
    );
    expect(config.maxOpenSessions).toBe(3);
    expect(config.allowedRoots).toEqual([inner]);
    expect(() => loadPluginConfig({ REALM_PLUGIN_CONFIG: '{oops' } as NodeJS.ProcessEnv, { hostCwd })).toThrow(PluginConfigError);
  });

  it('lets an explicit config allowedRoots win over the environment fallback', () => {
    const config = loadPluginConfig(
      { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [inner] }), REALM_PLUGIN_ALLOWED_ROOTS: hostCwd } as NodeJS.ProcessEnv,
      { hostCwd },
    );
    expect(config.allowedRoots).toEqual([inner]);
  });

  // ADR 0007: the host working directory is the outer bound and configuration
  // may only draw a smaller boundary inside it.
  it('defaults to the host working directory when nothing is configured', () => {
    expect(loadPluginConfig({} as NodeJS.ProcessEnv, { hostCwd }).allowedRoots).toEqual([hostCwd]);
  });

  // The resolved path is what is kept, not the path as written: SecurityPolicy
  // refuses a symlinked root, so storing the link would produce a configuration
  // that validates here and then fails start-up for an unrelated reason.
  it('accepts a root that narrows, and keeps it resolved', () => {
    expect(loadPluginConfig({ REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [inner] }) } as NodeJS.ProcessEnv, { hostCwd }).allowedRoots).toEqual([inner]);
    expect(loadPluginConfig({ REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [linkInside] }) } as NodeJS.ProcessEnv, { hostCwd }).allowedRoots).toEqual([inner]);
  });

  it('reports a host working directory that no longer exists as a configuration error', () => {
    const gone = join(fixture, 'gone');
    mkdirSync(gone);
    rmSync(gone, { recursive: true });
    expect(() => loadPluginConfig({} as NodeJS.ProcessEnv, { hostCwd: gone })).toThrow(PluginConfigError);
  });

  it('refuses a root outside the host working directory, from config or env', () => {
    expect(() => loadPluginConfig({ REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [outside] }) } as NodeJS.ProcessEnv, { hostCwd })).toThrow(/may only narrow/u);
    expect(() => loadPluginConfig({ REALM_PLUGIN_ALLOWED_ROOTS: outside } as NodeJS.ProcessEnv, { hostCwd })).toThrow(/may only narrow/u);
  });

  // A link may be travelled through, but where it lands is what counts — that is
  // the same resolved-path rule §9.2 applies to a session cwd.
  it('refuses a root that resolves out of the tree through a symlink', () => {
    expect(() => loadPluginConfig({ REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [linkOutside] }) } as NodeJS.ProcessEnv, { hostCwd })).toThrow(/may only narrow/u);
  });

  it('refuses a sibling whose path merely shares a prefix', () => {
    expect(() => loadPluginConfig({ REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [sibling] }) } as NodeJS.ProcessEnv, { hostCwd })).toThrow(/may only narrow/u);
  });
});

/**
 * The host working directory is the outer boundary (ADR 0007), and ADR 0025
 * changed where it is read from in one detectable situation: a host that spawns
 * the MCP server inside the plugin's own installation leaves a boundary no
 * project can sit under, and configuration cannot recover it because
 * configuration may only narrow. Measured on kimi 0.38.0 (GZH-36). ADR 0034
 * widened the detection from identity with the running install root to the
 * `dist/launch.js` marker on any copy (GZH-61).
 *
 * The fixture mirrors a real install: `<install>/dist` holds the entry, so the
 * install root is two levels up from it.
 */
describe('host cwd resolution (ADR 0025, ADR 0034)', () => {
  const install = join(fixture, 'install');
  const installDist = join(install, 'dist');
  const project = join(fixture, 'project');
  const other = join(fixture, 'other-project');
  for (const dir of [install, installDist, project, other]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(fixture, 'file.txt'), 'not a directory');
  const opts = { installRoot: install, home: fixture };

  it('SEC-CWD-007 reads PWD when the host spawned us inside our own installation', () => {
    // The jailed state: cwd is the install root itself, equality counting as
    // inside — which is exactly where kimi starts the server.
    expect(resolveHostCwd({ PWD: project }, { ...opts, cwd: install })).toEqual({ hostCwd: project, source: 'pwd-fallback' });
    expect(resolveHostCwd({ PWD: project }, { ...opts, cwd: installDist })).toEqual({ hostCwd: project, source: 'pwd-fallback' });
  });

  it('SEC-CWD-008 ignores PWD entirely when the cwd is a normal directory', () => {
    // A conforming host: `process.cwd()` is the project, and a stale or hostile
    // PWD must not move the boundary off it.
    expect(resolveHostCwd({ PWD: other }, { ...opts, cwd: project })).toEqual({ hostCwd: project, source: 'cwd' });
  });

  it('SEC-CWD-009 refuses a degenerate PWD and falls back rather than widening', () => {
    // What a stale environment actually carries: launchd hands a GUI-launched
    // process `PWD=/`, cron hands it $HOME. Taking either would hand a worker
    // the filesystem or the whole home directory as its boundary.
    for (const degenerate of ['/', fixture]) {
      expect(resolveHostCwd({ PWD: degenerate }, { ...opts, cwd: install })).toEqual({ hostCwd: install, source: 'cwd' });
    }
  });

  it('SEC-CWD-010 falls through on an unusable PWD or env value instead of failing start-up', () => {
    // Absent, relative, nonexistent, and a file rather than a directory: each
    // one lands on today's behaviour. A malformed variable must not turn a
    // working host into a dead one — deliberately unlike SEC-CWD-006, where a
    // configured root outside the boundary fails start-up.
    for (const bad of [undefined, 'relative/path', join(fixture, 'missing'), join(fixture, 'file.txt')]) {
      const env = bad === undefined ? {} : { PWD: bad };
      expect(resolveHostCwd(env, { ...opts, cwd: install }).source).toBe('cwd');
      expect(resolveHostCwd({ ...env, REALM_PLUGIN_HOST_CWD: bad ?? '' }, { ...opts, cwd: project }).source).toBe('cwd');
    }
  });

  it('SEC-CWD-011 takes the operator\'s explicit boundary on any host, guard included', () => {
    // Branch (a) is exempt from the degenerate-root guard: the operator named
    // this directory, and refusing it would be the plugin overruling its own
    // operator. It also wins on a conforming host, where nothing else fires.
    expect(resolveHostCwd({ REALM_PLUGIN_HOST_CWD: other, PWD: project }, { ...opts, cwd: install })).toEqual({ hostCwd: other, source: 'env' });
    expect(resolveHostCwd({ REALM_PLUGIN_HOST_CWD: other }, { ...opts, cwd: project })).toEqual({ hostCwd: other, source: 'env' });
    expect(resolveHostCwd({ REALM_PLUGIN_HOST_CWD: fixture }, { ...opts, cwd: project })).toEqual({ hostCwd: fixture, source: 'env' });
  });

  it('SEC-CWD-012 never resolves the boundary to somewhere inside the installation', () => {
    // Both env sources are refused when they point into the plugin's own tree:
    // it is not a project, and a boundary there authorizes nothing useful.
    expect(resolveHostCwd({ REALM_PLUGIN_HOST_CWD: installDist }, { ...opts, cwd: project }).hostCwd).toBe(project);
    expect(resolveHostCwd({ PWD: installDist }, { ...opts, cwd: install })).toEqual({ hostCwd: install, source: 'cwd' });
  });

  it('SEC-CWD-013 requires the cwd itself to resolve before reaching for the environment', () => {
    // The predicate is on the resolved cwd (ADR 0025 decision 1b). A cwd that
    // cannot be resolved has not been shown to be inside the installation, so
    // it keeps today's behaviour instead of taking a boundary from PWD on the
    // strength of a path that is not there.
    // The path is inside the install root by spelling, so a check on the raw
    // string would take the fallback; only resolving it first refuses to.
    const gone = join(install, 'removed-during-start');
    expect(resolveHostCwd({ PWD: project }, { ...opts, cwd: gone })).toEqual({ hostCwd: gone, source: 'cwd' });
  });

  /* ADR 0034: the jailed state is recognized by marker, not by identity. The
     measured GZH-61 state has the code in one installation (the global npm
     install, standing in here as `install`) and the cwd in a *different* copy
     (the kimi managed directory, standing in as `managed`) — the identity
     predicate of ADR 0025 never fires there. */
  const managed = join(fixture, 'managed');
  const managedDist = join(managed, 'dist');
  mkdirSync(managedDist, { recursive: true });
  writeFileSync(join(managedDist, 'launch.js'), '// the install marker\n');

  it('SEC-CWD-024 reads PWD when the host spawned us inside a copy that is not the running installation', () => {
    // The marker at <managed>/dist/launch.js, not containment in `install`, is
    // what fires the fallback here — the GZH-61 state. The nested half proves
    // the walk: <managed>/dist itself carries no marker; its parent does.
    expect(resolveHostCwd({ PWD: project }, { ...opts, cwd: managed })).toEqual({ hostCwd: project, source: 'pwd-fallback' });
    expect(resolveHostCwd({ PWD: project }, { ...opts, cwd: managedDist })).toEqual({ hostCwd: project, source: 'pwd-fallback' });
  });

  it('SEC-CWD-025 guards the two env sources asymmetrically around marker-bearing copies', () => {
    // PWD is inherited and unchosen: naming another copy of the plugin (or
    // inside it) is refused, and resolution falls through to the cwd.
    expect(resolveHostCwd({ PWD: managed }, { ...opts, cwd: install })).toEqual({ hostCwd: install, source: 'cwd' });
    expect(resolveHostCwd({ PWD: managedDist }, { ...opts, cwd: install })).toEqual({ hostCwd: install, source: 'cwd' });
    // REALM_PLUGIN_HOST_CWD is the operator naming the boundary on purpose:
    // refused only for the running installation, accepted for another copy —
    // a marker-bearing directory can be a real project (a built checkout of
    // this repository), and this variable is the only recourse there.
    expect(resolveHostCwd({ REALM_PLUGIN_HOST_CWD: managed }, { ...opts, cwd: install })).toEqual({ hostCwd: managed, source: 'env' });
  });

  it('SEC-CWD-026 ignores PWD when no ancestor of the cwd carries the marker', () => {
    // The walk must find the marker to fire: `project` is an ordinary tree,
    // so a stale PWD naming a real plugin copy still does not move the
    // boundary off process.cwd().
    expect(resolveHostCwd({ PWD: managed }, { ...opts, cwd: project })).toEqual({ hostCwd: project, source: 'cwd' });
  });


  it('derives the install root two levels up from an entry module', () => {
    expect(installRootFrom(`file://${join(installDist, 'launch.js')}`)).toBe(install);
  });
});
