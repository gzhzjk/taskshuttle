import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isContainedPath, validateMcpCatalog, type McpCatalogEntry } from './security-policy.js';

/**
 * Installation configuration (design §4.2). Values come only from a user or
 * administrator install surface (or a trusted host context), never from tool
 * arguments. Invalid values fail startup with a field-level error instead of
 * being silently clamped.
 */
export interface PluginConfig {
  readonly allowedRoots: readonly string[];
  /**
   * Permits engines that mvp §4.2 does not require and the live matrix has not
   * verified (ADR 0004). The frozen four are unaffected — they are authorized by
   * the spec, not by gate evidence.
   */
  readonly allowUnverifiedEngines: boolean;
  /** When true, session_create consults the repo-layer defaults file under hostCwd (ADR 0039). */
  readonly repoDefaults: boolean;
  readonly maxOpenSessions: number;
  readonly maxActiveTurns: number;
  readonly maxActiveTurnsPerEngine: number;
  readonly maxQueuedTurns: number;
  readonly interactionTtlMs: number | null;
  readonly retentionDays: number | null;
  readonly responseByteBudget: number;
  readonly mcpCatalog: Readonly<Record<string, McpCatalogEntry>>;
  readonly console: ConsoleConfig;
}

/**
 * The loopback observation console (design §10.4, ADR 0003). It is granted only
 * from the install surface: no tool argument or orchestrator input can disable
 * or query it, and none can enable it either — with the one amendment of ADR
 * 0019: `project_init` may start the listener, itself gated by the
 * install-surface `allowInitStart` field below. Default off at boot; absent
 * means identical boot-time behaviour to a build without the feature.
 */
export interface ConsoleConfig {
  readonly enabled: boolean;
  /** 0 = ephemeral port; an explicit port already in use fails start-up. */
  readonly port: number;
  readonly exposeTranscripts: boolean;
  /** Caps concurrent SSE subscribers, and with them the worst-case synchronous read load on the event loop. */
  readonly maxConsoleStreams: number;
  /**
   * The operator's veto over `project_init`'s console start (ADR 0019): the one
   * tool that may create the listener loses that right when this is false.
   * Deliberately independent of `enabled`, which keeps its boot-time meaning
   * only — reading `enabled: false` as blocking init too would leave this field
   * vetoing a start that can never happen, i.e. vacuous.
   */
  readonly allowInitStart: boolean;
}

export class PluginConfigError extends Error {
  readonly code = 'INVALID_ARGUMENT';
  constructor(readonly field: string, message: string) {
    super(`invalid plugin config field '${field}': ${message}`);
    this.name = 'PluginConfigError';
  }
}

export const MIB = 1_048_576;

export const defaultPluginConfig = Object.freeze({
  allowUnverifiedEngines: false,
  repoDefaults: false,
  maxOpenSessions: 32,
  maxActiveTurns: 8,
  maxActiveTurnsPerEngine: 2,
  maxQueuedTurns: 256,
  interactionTtlMs: 1_800_000,
  retentionDays: 30,
  responseByteBudget: MIB,
});

export const defaultConsoleConfig: ConsoleConfig = Object.freeze({
  enabled: false,
  port: 0,
  exposeTranscripts: true,
  maxConsoleStreams: 8,
  allowInitStart: true,
});

const KNOWN_CONSOLE_FIELDS = new Set(['enabled', 'port', 'exposeTranscripts', 'maxConsoleStreams', 'allowInitStart']);

const KNOWN_FIELDS = new Set([
  'allowedRoots',
  'allowUnverifiedEngines',
  'repoDefaults',
  'maxOpenSessions',
  'maxActiveTurns',
  'maxActiveTurnsPerEngine',
  'maxQueuedTurns',
  'interactionTtlMs',
  'retentionDays',
  'responseByteBudget',
  'mcpCatalog',
  'console',
]);

function integerField(source: Record<string, unknown>, field: string, min: number, max: number, fallback: number, label = field): number {
  const value = source[field];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new PluginConfigError(label, 'must be an integer');
  if (value < min || value > max) throw new PluginConfigError(label, `must be in ${min}..${max}`);
  return value;
}

function nullableIntegerField(source: Record<string, unknown>, field: string, min: number, max: number, fallback: number | null): number | null {
  const value = source[field];
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new PluginConfigError(field, 'must be an integer or null');
  if (value < min || value > max) throw new PluginConfigError(field, `must be null or in ${min}..${max}`);
  return value;
}

function booleanField(source: Record<string, unknown>, field: string, fallback: boolean, label = field): boolean {
  const value = source[field];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new PluginConfigError(label, 'must be a boolean');
  return value;
}

/**
 * The host's working directory is the outer boundary (ADR 0007); configuration
 * may only draw a smaller one inside it. Containment is judged on resolved
 * paths by the same helper the cwd check uses — an entry may travel through a
 * symlink, but where it lands is what counts — and the resolved path is what is
 * kept: `SecurityPolicy` refuses a symlinked root outright, so handing it the
 * raw path would let a config that passes here kill start-up later with an
 * unrelated error.
 */
function narrowToHostCwd(roots: readonly string[], hostCwd: string, field: string): string[] {
  let outer: string;
  try { outer = realpathSync(hostCwd); }
  catch { throw new PluginConfigError(field, `the host working directory '${hostCwd}' does not resolve to an existing directory`); }
  const narrowed: string[] = [];
  for (const root of roots) {
    // A root that does not exist yet cannot be shown to be inside; refusing is
    // the fail-closed answer, and it is also a clear signal of a typo.
    let resolved: string;
    try { resolved = realpathSync(root); }
    catch { throw new PluginConfigError(field, `'${root}' does not resolve to an existing directory inside the host working directory`); }
    if (!isContainedPath(resolved, outer)) {
      throw new PluginConfigError(field, `'${root}' is outside the host working directory '${outer}'; configuration may only narrow the boundary, never move it`);
    }
    narrowed.push(resolved);
  }
  return [...new Set(narrowed)];
}

/** Where the host working directory came from (ADR 0025). */
export type HostCwdSource = 'env' | 'pwd-fallback' | 'cwd' | 'option';

export interface HostCwdResolution {
  readonly hostCwd: string;
  readonly source: HostCwdSource;
}

/** `REALM_PLUGIN_HOST_CWD`: the operator naming the boundary outright (ADR 0025). */
export const HOST_CWD_ENV = 'TASKSHUTTLE_HOST_CWD';
const LEGACY_HOST_CWD_ENV = 'REALM_PLUGIN_HOST_CWD';

/**
 * The plugin's own install root, derived from an entry module's URL: the bundle
 * lives at `<root>/dist/<entry>.js` and the sources at `<root>/src/<entry>.ts`,
 * so the root is two levels up either way. Callers pass their own
 * `import.meta.url` — the entry knows where it is, and nothing further down
 * does.
 */
export function installRootFrom(entryModuleUrl: string): string {
  return dirname(dirname(fileURLToPath(entryModuleUrl)));
}

/**
 * An absolute path that resolves to an existing directory, or undefined when
 * the value is unusable for any reason — absent, relative, gone, or a file.
 * Unusable is never fatal here; every caller falls through to the next source.
 */
function resolvedDirectory(value: string | undefined): string | undefined {
  // POSIX absolute paths only. On win32 every value is rejected and the whole
  // rule degrades to `process.cwd()` — today's behaviour, granting nothing —
  // which is the right failure while no host on that platform is supported.
  if (value === undefined || value.length === 0 || !value.startsWith('/')) return undefined;
  try {
    const resolved = realpathSync(value);
    return statSync(resolved).isDirectory() ? resolved : undefined;
  } catch { return undefined; }
}

/**
 * Resolve the host working directory — the outer boundary everything else may
 * only narrow (ADR 0007, narrowed by ADR 0025 and ADR 0034).
 *
 * `process.cwd()` is the answer for every host that starts the plugin in the
 * operator's project, which is all of them but one. A host that spawns the MCP
 * server inside a copy of the plugin's installation (measured on kimi 0.38.0 —
 * and, per GZH-61, not necessarily the copy the code runs from) leaves a
 * boundary no project can sit under, and configuration cannot recover it
 * because configuration may only narrow. So:
 *
 * 1. `REALM_PLUGIN_HOST_CWD` when usable — the operator states the boundary.
 *    It is refused only for the *running* installation: that directory is the
 *    jail being escaped, while another marker-bearing copy can be a real
 *    project (a built checkout of this repository), where this variable is
 *    the only recourse (ADR 0034 decision 3);
 * 2. else `PWD`, but only when the cwd is inside some copy of the plugin —
 *    the running install root, or any ancestor carrying the install marker
 *    `dist/launch.js` (ADR 0034) — and only when `PWD` is neither inside any
 *    such copy, nor the filesystem root, nor the home directory — a stale
 *    environment carries exactly those last two (launchd hands a
 *    GUI-launched process `PWD=/`, cron hands it `$HOME`), and while a home
 *    directory really can be someone's project, refusing costs a fallback to
 *    (3) while accepting would hand a whole home directory to a value nobody
 *    chose;
 * 3. else `process.cwd()`, unchanged.
 *
 * An unusable value in 1 or 2 falls through rather than throwing: a malformed
 * variable must not turn a working host into a dead one. That is deliberately
 * the opposite of a configured root outside the boundary, which fails start-up
 * (SEC-CWD-006) — there, ignoring would silently narrow below what the operator
 * configured; here, ignoring lands on today's behaviour and grants nothing.
 *
 * This is not a freshness check. A stale `PWD` naming some other real project
 * passes it, and nothing available here can tell that from a fresh one: the
 * residual is misdirection, which the returned `source` exists to make visible.
 *
 * @param env - the process environment to read.
 * @param options - `cwd` and `installRoot` are injectable for tests; `home` too.
 * @returns the resolved boundary and which of the three sources produced it.
 */
export function resolveHostCwd(
  env: NodeJS.ProcessEnv,
  options: { cwd?: string; installRoot?: string; home?: string; compatReport?: CompatReport } = {},
): HostCwdResolution {
  const cwd = options.cwd ?? process.cwd();
  const installRoot = resolvedDirectory(options.installRoot);

  const stated = resolvedDirectory(compatEnv(env, HOST_CWD_ENV, LEGACY_HOST_CWD_ENV, options.compatReport));
  if (stated !== undefined && !insideInstall(stated, installRoot)) return { hostCwd: stated, source: 'env' };

  // The predicate is on the RESOLVED cwd, as ADR 0025 pins it. A cwd that does
  // not resolve is not shown to be inside the installation, so it keeps today's
  // behaviour rather than reaching for the environment.
  const resolvedCwd = resolvedDirectory(cwd);
  if (resolvedCwd !== undefined && insideAnyPluginInstall(resolvedCwd, installRoot)) {
    const inherited = resolvedDirectory(env['PWD']);
    // PWD is inherited and unchosen, so it is guarded against every copy of
    // the plugin (ADR 0034 decision 3) — unlike the operator's explicit
    // variable above, which only the running installation refuses.
    if (inherited !== undefined && !insideAnyPluginInstall(inherited, installRoot) && !isDegenerateRoot(inherited, options.home)) {
      return { hostCwd: inherited, source: 'pwd-fallback' };
    }
  }
  return { hostCwd: cwd, source: 'cwd' };
}

function insideInstall(path: string, installRoot: string | undefined): boolean {
  return installRoot !== undefined && (path === installRoot || isContainedPath(path, installRoot));
}

/**
 * The install marker (ADR 0034): a regular file at `<dir>/dist/launch.js`, the
 * entry every spawn path names, shipped by every distribution form — the npm
 * package, the staged host installs, the kimi managed copy, and a built source
 * checkout. Presence is the signal; the bytes are never read.
 */
function isPluginInstallRoot(dir: string): boolean {
  try { return statSync(join(dir, 'dist', 'launch.js')).isFile(); } catch { return false; }
}

/**
 * Inside the running installation (identity, ADR 0025) or inside any copy of
 * the plugin recognized by the marker, walking up from the resolved path
 * (ADR 0034). Identity alone is blind to the measured kimi state, where the
 * code runs from one installation and the host spawns us in another — one
 * stat per level, once per process at start-up.
 */
function insideAnyPluginInstall(path: string, installRoot: string | undefined): boolean {
  if (insideInstall(path, installRoot)) return true;
  let current = path;
  for (;;) {
    if (isPluginInstallRoot(current)) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** The two values a stale environment carries; neither is a boundary anyone chose. */
function isDegenerateRoot(path: string, home = homedir()): boolean {
  return path === parse(path).root || path === home;
}

/** Validate an install-surface config object. Unknown fields are rejected. */
export function resolvePluginConfig(input: unknown, defaults: { allowedRoots?: readonly string[]; hostCwd?: string } = {}): PluginConfig {
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new PluginConfigError('<root>', 'must be an object');
  const source = input as Record<string, unknown>;
  for (const field of Object.keys(source)) {
    if (!KNOWN_FIELDS.has(field)) throw new PluginConfigError(field, 'is not a known configuration field');
  }

  const rootsValue = source['allowedRoots'];
  let allowedRoots: readonly string[];
  if (rootsValue === undefined) {
    allowedRoots = defaults.allowedRoots ?? [];
    if (allowedRoots.length === 0) throw new PluginConfigError('allowedRoots', 'no trusted project root is available');
  } else {
    if (!Array.isArray(rootsValue) || rootsValue.length === 0) throw new PluginConfigError('allowedRoots', 'must be a non-empty array of absolute paths');
    for (const root of rootsValue) {
      if (typeof root !== 'string' || root.trim().length === 0) throw new PluginConfigError('allowedRoots', 'entries must be non-empty strings');
    }
    allowedRoots = [...new Set(rootsValue as string[])];
  }
  // ADR 0007: the host working directory is the outer bound, and configuration
  // may only draw a smaller boundary inside it. Applied to the derived default
  // too — it is trivially inside itself, and checking it uniformly keeps the
  // rule one statement rather than two paths that could drift.
  if (defaults.hostCwd !== undefined) allowedRoots = narrowToHostCwd(allowedRoots, defaults.hostCwd, 'allowedRoots');

  const maxActiveTurns = integerField(source, 'maxActiveTurns', 1, 64, defaultPluginConfig.maxActiveTurns);
  const maxActiveTurnsPerEngine = integerField(source, 'maxActiveTurnsPerEngine', 1, 16, defaultPluginConfig.maxActiveTurnsPerEngine);
  if (maxActiveTurnsPerEngine > maxActiveTurns) throw new PluginConfigError('maxActiveTurnsPerEngine', 'must be <= maxActiveTurns');

  const catalogValue = source['mcpCatalog'];
  let mcpCatalog: Record<string, McpCatalogEntry> = {};
  if (catalogValue !== undefined) {
    if (typeof catalogValue !== 'object' || catalogValue === null || Array.isArray(catalogValue)) throw new PluginConfigError('mcpCatalog', 'must be an object keyed by MCP server id');
    try {
      validateMcpCatalog(catalogValue as Record<string, McpCatalogEntry>);
    } catch (cause) {
      throw new PluginConfigError('mcpCatalog', cause instanceof Error ? cause.message : 'is invalid');
    }
    mcpCatalog = { ...(catalogValue as Record<string, McpCatalogEntry>) };
  }

  const consoleValue = source['console'];
  let consoleConfig: ConsoleConfig = defaultConsoleConfig;
  if (consoleValue !== undefined) {
    if (typeof consoleValue !== 'object' || consoleValue === null || Array.isArray(consoleValue)) throw new PluginConfigError('console', 'must be an object');
    const consoleSource = consoleValue as Record<string, unknown>;
    for (const field of Object.keys(consoleSource)) {
      if (!KNOWN_CONSOLE_FIELDS.has(field)) throw new PluginConfigError(`console.${field}`, 'is not a known configuration field');
    }
    consoleConfig = Object.freeze({
      enabled: booleanField(consoleSource, 'enabled', defaultConsoleConfig.enabled, 'console.enabled'),
      port: integerField(consoleSource, 'port', 0, 65_535, defaultConsoleConfig.port, 'console.port'),
      exposeTranscripts: booleanField(consoleSource, 'exposeTranscripts', defaultConsoleConfig.exposeTranscripts, 'console.exposeTranscripts'),
      maxConsoleStreams: integerField(consoleSource, 'maxConsoleStreams', 1, 64, defaultConsoleConfig.maxConsoleStreams, 'console.maxConsoleStreams'),
      allowInitStart: booleanField(consoleSource, 'allowInitStart', defaultConsoleConfig.allowInitStart, 'console.allowInitStart'),
    });
  }

  return Object.freeze({
    allowedRoots,
    allowUnverifiedEngines: booleanField(source, 'allowUnverifiedEngines', defaultPluginConfig.allowUnverifiedEngines),
    repoDefaults: booleanField(source, 'repoDefaults', defaultPluginConfig.repoDefaults),
    maxOpenSessions: integerField(source, 'maxOpenSessions', 1, 256, defaultPluginConfig.maxOpenSessions),
    maxActiveTurns,
    maxActiveTurnsPerEngine,
    maxQueuedTurns: integerField(source, 'maxQueuedTurns', 1, 4096, defaultPluginConfig.maxQueuedTurns),
    interactionTtlMs: nullableIntegerField(source, 'interactionTtlMs', 60_000, 86_400_000, defaultPluginConfig.interactionTtlMs),
    retentionDays: nullableIntegerField(source, 'retentionDays', 0, 36_500, defaultPluginConfig.retentionDays),
    responseByteBudget: integerField(source, 'responseByteBudget', MIB, 16 * MIB, defaultPluginConfig.responseByteBudget),
    mcpCatalog: Object.freeze(mcpCatalog),
    console: consoleConfig,
  });
}

export const PLUGIN_CONFIG_ENV = 'TASKSHUTTLE_CONFIG';
export const ALLOWED_ROOTS_ENV = 'TASKSHUTTLE_ALLOWED_ROOTS';
export const CONFIG_FILE_ENV = 'TASKSHUTTLE_CONFIG_FILE';
const LEGACY_PLUGIN_CONFIG_ENV = 'REALM_PLUGIN_CONFIG';
const LEGACY_ALLOWED_ROOTS_ENV = 'REALM_PLUGIN_ALLOWED_ROOTS';
const LEGACY_CONFIG_FILE_ENV = 'REALM_PLUGIN_CONFIG_FILE';
export const CONFIG_FILE_NAME = 'config.json';

export interface CompatReport {
  readonly seen: Set<string>;
  readonly entries: string[];
}

export function createCompatReport(): CompatReport { return { seen: new Set(), entries: [] }; }

/** New spelling wins whenever present; an empty new value is still set. */
export function compatEnv(env: NodeJS.ProcessEnv, current: string, legacy: string, report?: CompatReport): string | undefined {
  if (env[current] !== undefined) return env[current];
  if (env[legacy] !== undefined && report !== undefined && !report.seen.has(legacy)) {
    report.seen.add(legacy); report.entries.push(legacy);
  }
  return env[legacy];
}

/**
 * The one rule for where instance state lives (runtime.ts and the
 * `console open` subcommand both resolve through this): an explicit option,
 * else `$TASKSHUTTLE_DATA_ROOT`, else `~/.taskshuttle`.
 */
export function resolveDataRoot(env: NodeJS.ProcessEnv = process.env, explicit?: string, home = homedir(), report?: CompatReport): string {
  if (explicit !== undefined) return explicit;
  const value = compatEnv(env, 'TASKSHUTTLE_DATA_ROOT', 'REALM_PLUGIN_DATA_ROOT', report);
  return value ?? join(home, '.taskshuttle');
}

/**
 * The one rule for where the admin install file lives, so a writer of that file
 * cannot disagree with this reader about which path it is.
 *
 * @param dataRoot resolved data root, used only when no environment override is set.
 * @param env environment to read the override from.
 * @param report collects a legacy environment spelling if one was used.
 * @returns the path, and whether it came from the environment — an absent file
 *   at an explicitly named path is an error, while an absent default one is not.
 */
export function resolvePluginConfigFile(dataRoot: string, env: NodeJS.ProcessEnv = process.env, report?: CompatReport): { path: string; explicit: boolean } {
  const explicit = compatEnv(env, CONFIG_FILE_ENV, LEGACY_CONFIG_FILE_ENV, report);
  return explicit !== undefined && explicit.trim().length > 0
    ? { path: explicit, explicit: true }
    : { path: join(dataRoot, CONFIG_FILE_NAME), explicit: explicit !== undefined };
}

/**
 * Read the admin install file, which is how hosts that cannot inject env into
 * their MCP manifest deliver configuration: `$REALM_PLUGIN_CONFIG_FILE`, else
 * `<data-root>/config.json`. It must be a private regular file; anything else
 * fails start-up rather than being ignored.
 */
export function readPluginConfigFile(dataRoot: string, env: NodeJS.ProcessEnv = process.env, report?: CompatReport): unknown {
  const { path, explicit } = resolvePluginConfigFile(dataRoot, env, report);
  // Open no-follow and validate the handle, not the path: a check-then-read on
  // plugin-owned data is a TOCTOU (design §10.2).
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT' && !explicit) return undefined;
    throw new PluginConfigError('<file>', `${path} could not be opened as a private regular file`);
  }
  try {
    const info: Stats = fstatSync(descriptor);
    if (!info.isFile()) throw new PluginConfigError('<file>', `${path} must be a regular file`);
    if ((info.mode & 0o077) !== 0) throw new PluginConfigError('<file>', `${path} must not be group/world accessible`);
    try { return JSON.parse(readFileSync(descriptor, 'utf8')) as unknown; }
    catch (cause) { if (cause instanceof PluginConfigError) throw cause; throw new PluginConfigError('<file>', `${path} is not valid JSON`); }
  } finally { closeSync(descriptor); }
}

/**
 * Read the install surface from the trusted host context. `REALM_PLUGIN_CONFIG`
 * carries the full object; `REALM_PLUGIN_ALLOWED_ROOTS` remains supported for
 * hosts that only pass the trusted project root.
 */
export function loadPluginConfig(env: NodeJS.ProcessEnv = process.env, defaults: { allowedRoots?: readonly string[]; dataRoot?: string; hostCwd?: string; compatReport?: CompatReport } = {}): PluginConfig {
  const raw = compatEnv(env, PLUGIN_CONFIG_ENV, LEGACY_PLUGIN_CONFIG_ENV, defaults.compatReport);
  const configFile = compatEnv(env, CONFIG_FILE_ENV, LEGACY_CONFIG_FILE_ENV, defaults.compatReport);
  const fromFile = defaults.dataRoot === undefined && configFile === undefined ? undefined : readPluginConfigFile(defaults.dataRoot ?? '', env, defaults.compatReport);
  if (fromFile !== undefined && (typeof fromFile !== 'object' || fromFile === null || Array.isArray(fromFile))) throw new PluginConfigError('<file>', 'must contain a configuration object');
  let fromEnv: Record<string, unknown> = {};
  if (raw !== undefined && raw.trim().length > 0) {
    let value: unknown;
    try { value = JSON.parse(raw) as unknown; }
    catch { throw new PluginConfigError('<root>', `${PLUGIN_CONFIG_ENV} is not valid JSON`); }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PluginConfigError('<root>', `${PLUGIN_CONFIG_ENV} must contain a configuration object`);
    fromEnv = value as Record<string, unknown>;
  }
  // Per-key precedence: the host context overrides the admin install file.
  let parsed: unknown = { ...(fromFile as Record<string, unknown> | undefined ?? {}), ...fromEnv };
  const envRoots = (compatEnv(env, ALLOWED_ROOTS_ENV, LEGACY_ALLOWED_ROOTS_ENV, defaults.compatReport) ?? '').split(',').map((root) => root.trim()).filter((root) => root.length > 0);
  // Without an install root this resolution still detects the jailed state by
  // the install marker (ADR 0034), but cannot refuse an env value that points
  // into the *running* installation — it never learns where that is. Production
  // never lands here: the runtime resolves the boundary once, with the root,
  // and passes it in. A future caller that omits it loses that half of ADR 0025
  // silently.
  const hostCwd = defaults.hostCwd ?? resolveHostCwd(env).hostCwd;
  // The derived default is the host cwd itself; env and file may narrow it.
  const fallbackRoots = envRoots.length > 0 ? envRoots : defaults.allowedRoots ?? [hostCwd];
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && (parsed as Record<string, unknown>)['allowedRoots'] === undefined && envRoots.length > 0) {
    parsed = { ...(parsed as Record<string, unknown>), allowedRoots: envRoots };
  }
  return resolvePluginConfig(parsed, { allowedRoots: fallbackRoots, hostCwd });
}
