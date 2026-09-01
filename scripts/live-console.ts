#!/usr/bin/env node
/**
 * CONSOLE live gate (console-design §12 step 8): the loopback observation
 * console against a real runtime, driven through the scripted ACP fixture —
 * CONSOLE-001..029 cover the §7 security posture, the §5 read model/streams,
 * the §7.8 degraded whitelist, the §8.2 `console open` subcommand and the
 * console-v2 §3 projection/diff-index routes (ADR 0010).
 *
 * The gate always runs simulated engines: every assertion here is about the
 * plugin's own HTTP surface, and a real CLI adds cost without changing what
 * is being proven. The report records `simulated: true` accordingly.
 */
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { connect as netConnect, createServer as createNetServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TranscriptEvent } from 'runskein';

import type { ConsoleStreamFrame } from '../packages/plugin/src/console/data-source.js';
import { PREVIEW_LIMIT, RunAssembler } from '../packages/plugin/src/console/folded-projection.js';
import { KNOWN_BROKEN_CAPABILITIES, verificationState } from '../packages/plugin/src/engine-support.js';
import { runConsoleOpen } from '../packages/plugin/src/console/open.js';
import { CONSOLE_CSP } from '../packages/plugin/src/console/server.js';
import { settleDelegation, type DelegationDiagnostics, type DelegationRecord } from '../packages/plugin/src/delegation-evidence.js';
import { InstanceManager, processStartTime } from '../packages/plugin/src/lifecycle.js';
import type { LogRecord } from '../packages/plugin/src/logger.js';
import { readDelegationIdentity } from '../packages/plugin/src/security-policy.js';
import { projectKeyFor } from '../packages/plugin/src/project-config.js';
import type { EngineId } from '../packages/plugin/src/schemas.js';
import { createTaskShuttleServer, type TaskShuttleServer } from '../packages/plugin/src/server.js';
import { UI_APP_CSS, UI_APP_JS } from '../packages/plugin/src/console/ui-assets.js';
import { simulatedHubFactory, SIMULATED_ENGINES } from '../packages/plugin/src/testkit/simulated-engines.js';
import { buildReport, exitCodeFor, validateReport, writeReport, type CaseResult } from './live/evidence.js';
import { canonicalJson, mergeFoldedPages, stripSeamFlags, type FoldedRun as GateRun } from './live/fold-merge.js';
import { resolvePluginDist } from './plugin-artifact-path.js';

type CaseOutcome = Omit<CaseResult, 'id' | 'title' | 'durationMs'>;

// CONSOLE-021 spawns the built shim; fail fast when the build is absent rather
// than reporting a misleading case failure (same rule as live-host.ts).
const PLUGIN_DIST = resolvePluginDist(process.cwd());
const LAUNCH_PATH = join(PLUGIN_DIST, 'launch.js');
if (!existsSync(LAUNCH_PATH)) throw new Error('packages/plugin/dist/launch.js is missing; run pnpm build before the console gate');
// project_init's generation skeleton ships beside the bundle; from source (this
// gate runs under tsx) the bundle-relative default would not resolve, so every
// plugin the gate starts gets the built copy explicitly.
const DEFAULTS_TEMPLATE = join(PLUGIN_DIST, 'default-config.json');
if (!existsSync(DEFAULTS_TEMPLATE)) throw new Error('packages/plugin/dist/default-config.json is missing; run pnpm build before the console gate');

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const startedAt = new Date().toISOString();
const cases: CaseResult[] = [];
const cleanups: Array<() => Promise<void>> = [];

/**
 * Drains by popping, so cases registered after an earlier drain are still torn
 * down. A one-shot `reverse()` left the plugins that CONSOLE-022..024 start
 * holding their listener and SQLite handle open, and the gate wrote its report
 * and then never exited.
 */
async function drainCleanups(): Promise<void> {
  for (let cleanup = cleanups.pop(); cleanup !== undefined; cleanup = cleanups.pop()) await cleanup();
}

interface PluginContext {
  readonly plugin: TaskShuttleServer;
  readonly dataRoot: string;
  readonly workRoot: string;
  readonly port: number;
  /** Structured log lines the plugin emitted, for withheld/started assertions. */
  readonly logs: readonly LogRecord[];
}

interface StartOptions {
  /** Console config fragment; absent means the feature stays off (the default). */
  readonly console?: Record<string, unknown>;
  /** Read console.json after ready; defaults to whether the console was enabled. */
  readonly expectManifest?: boolean;
  readonly engineEnv?: Partial<Record<EngineId, Record<string, string>>>;
  /** Extra process env for the runtime, e.g. the §7.7 delegation triplet. */
  readonly env?: Record<string, string>;
  /** Reuse an existing root (CONSOLE-004 pre-populates one for recovery). */
  readonly dataRoot?: string;
  /**
   * The delegation verdict, settled before construction exactly as cli.ts
   * settles it (ADR 0031). The gate has no nested instance to derive it from —
   * the simulated engine loads no MCP servers of its own — so cases that need
   * a non-root verdict inject it here; CONSOLE-005's ancestry half additionally
   * derives one through the real process table.
   */
  readonly delegation?: DelegationRecord;
}

async function startPlugin(options: StartOptions = {}): Promise<PluginContext> {
  const dataRoot = options.dataRoot ?? await mkdtemp(join(tmpdir(), 'taskshuttle-console-gate-'));
  const workRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-console-work-'));
  const config: Record<string, unknown> = { allowedRoots: [workRoot], ...(options.console === undefined ? {} : { console: options.console }) };
  const sink: LogRecord[] = [];
  const plugin = createTaskShuttleServer({
    dataRoot,
    env: { REALM_PLUGIN_CONFIG: JSON.stringify(config), REALM_PLUGIN_LOG: 'off', REALM_PLUGIN_DEFAULTS_TEMPLATE: DEFAULTS_TEMPLATE, ...options.env } as NodeJS.ProcessEnv,
    hostCwd: workRoot,
    hubFactory: simulatedHubFactory({ env: options.engineEnv ?? {} }),
    logSink: (record) => { sink.push(record); },
    ...(options.delegation === undefined ? {} : { delegation: options.delegation }),
  });
  cleanups.push(async () => {
    await plugin.close().catch(() => undefined);
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workRoot, { recursive: true, force: true });
  });
  await plugin.runtime.ready;
  // The manifest exists only when this plugin actually started a console.
  const context = { plugin, dataRoot, workRoot, logs: sink, port: 0 };
  if (!(options.expectManifest ?? options.console?.['enabled'] === true)) return context;
  const raw = JSON.parse(await readFile(join(dataRoot, 'instances', plugin.runtime.instanceId, 'console.json'), 'utf8')) as { port: number };
  return { ...context, port: raw.port };
}

function consoleJsonPath(dataRoot: string, instanceId: string): string {
  return join(dataRoot, 'instances', instanceId, 'console.json');
}

interface HttpResult {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function http(port: number, path: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<HttpResult> {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 8_000_000) { req.destroy(new Error(`body from ${path} exceeded 8MB`)); return; }
        chunks.push(chunk);
      });
      res.on('end', () => { clearTimeout(deadline); resolveRequest({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }); });
    });
    // Every case in this gate reaches routes through here, so an unbounded
    // wait is a gate that hangs rather than reports — worse than one that fails.
    const deadline = setTimeout(() => { req.destroy(new Error(`no complete response from ${path} within 15s`)); }, 15_000);
    req.on('error', (cause) => { clearTimeout(deadline); rejectRequest(cause); });
    req.end();
  });
}

/**
 * Status and headers of a long-lived response, without waiting for it to end.
 *
 * `http()` resolves on the response's `end` event, so it can never inspect
 * `/api/stream`: that response stays open until the client closes it. This
 * reads the head, then destroys the socket. CONSOLE-043 and CONSOLE-045 both
 * need it — the SSE route is part of "every route" for the credential-free
 * walk, and part of the header walk that must find no `Set-Cookie`.
 */
function httpHandshake(port: number, path: string, options: { headers?: Record<string, string> } = {}): Promise<Omit<HttpResult, 'body'>> {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: options.headers ?? {} }, (res) => {
      clearTimeout(deadline);
      const head = { status: res.statusCode ?? 0, headers: res.headers };
      res.destroy();
      req.destroy();
      resolveRequest(head);
    });
    // A gate that hangs is worse than one that fails: without this a route that
    // never answers stalls the whole run instead of reporting the case.
    const deadline = setTimeout(() => { req.destroy(new Error(`no response head from ${path} within 10s`)); }, 10_000);
    req.on('error', (cause) => { clearTimeout(deadline); rejectRequest(cause); });
    req.end();
  });
}

/**
 * A browser-equivalent client: one cookie jar shared across every port on
 * `127.0.0.1`, and redirects followed.
 *
 * Both properties are the point rather than convenience. A cookie's scope is
 * the host and excludes the port (RFC 6265 §8.5), which is the whole of
 * GZH-44: two consoles on one machine share one slot, and the second visited
 * evicts the first. `http()` has neither a jar nor redirect handling, so
 * CONSOLE-042 cannot be written with it.
 */
function browserJar(): { get(port: number, path: string): Promise<HttpResult>; cookie(): string | undefined } {
  let jar: string | undefined;
  const once = (port: number, path: string): Promise<HttpResult> =>
    new Promise((resolveRequest, rejectRequest) => {
      const headers = jar === undefined ? {} : { cookie: jar };
      const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
        const setCookie = res.headers['set-cookie'];
        const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
        // One jar for the whole host: the name/value pair is kept and every
        // attribute discarded, which is exactly the scoping the defect exploits.
        if (first !== undefined) jar = first.split(';')[0];
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          // Bounded: an endless body must fail the case, not exhaust the run.
          if (bytes > 4_000_000) { req.destroy(new Error(`body from ${path} exceeded 4MB`)); return; }
          chunks.push(chunk);
        });
        res.on('end', () => { clearTimeout(deadline); resolveRequest({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }); });
      });
      const deadline = setTimeout(() => { req.destroy(new Error(`no complete response from ${path} within 15s`)); }, 15_000);
      req.on('error', (cause) => { clearTimeout(deadline); rejectRequest(cause); });
      req.end();
    });
  return {
    async get(port, path) {
      let result = await once(port, path);
      for (let hop = 0; hop < 4 && result.status >= 300 && result.status < 400; hop += 1) {
        const location = result.headers['location'];
        if (typeof location !== 'string') break;
        result = await once(port, location);
      }
      return result;
    },
    cookie: () => jar,
  };
}

/**
 * A listener that answers the way a **pre-upgrade** console did: `401` with the
 * console CSP on every path, which is precisely the fingerprint the old
 * `console open` probe looked for.
 *
 * CONSOLE-046 needs this rather than a rewritten manifest on a live listener.
 * Once the credential is gone a real listener answers `/api/instance` with 200
 * and its own id, so the probe opens it — a case built that way could never
 * pass after the change it exists for. The mixed-version state it describes is
 * a genuinely old server, and this is the only way to have one.
 *
 * Every request is recorded, because what separates a reader that tolerates a
 * legacy manifest from one that rejects it is not the verdict — both end at
 * *not listening* — but whether the probe was issued at all.
 */
async function legacyConsole(): Promise<{ port: number; requests: Array<{ path: string; host: string; method: string; credentials: string[] }> }> {
  const requests: Array<{ path: string; host: string; method: string; credentials: string[] }> = [];
  const server = createHttpServer((req, res) => {
    const credentials = ['cookie', 'authorization', 'proxy-authorization'].filter((name) => req.headers[name] !== undefined);
    requests.push({ path: req.url ?? '/', host: String(req.headers.host ?? ''), method: req.method ?? 'GET', credentials });
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'content-security-policy': CONSOLE_CSP });
    res.end('{"error":"unauthorized"}');
  });
  // A bind failure must fail the case, not leave the promise pending: an
  // unresolved listen() hangs the gate before record() can report anything.
  await new Promise<void>((ready, fail) => {
    const timer = setTimeout(() => fail(new Error('legacy console fixture did not bind within 5s')), 5_000);
    server.once('error', (cause) => { clearTimeout(timer); fail(cause); });
    server.listen(0, '127.0.0.1', () => { clearTimeout(timer); ready(); });
  });
  cleanups.push(async () => { await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('legacy console fixture has no port');
  return { port: address.port, requests };
}

interface SseClient {
  readonly frames: Array<{ id?: string; data: ConsoleStreamFrame & Record<string, unknown> }>;
  readonly ready: Promise<void>;
  readonly ended: Promise<void>;
  close(): void;
}

function openSse(port: number, path: string): SseClient {
  const frames: SseClient['frames'] = [];
  let buffered = '';
  let endResolve: () => void = () => undefined;
  let readyResolve: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => { endResolve = resolve; });
  const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
  const req = httpRequest({ host: '127.0.0.1', port, path }, (res) => {
    res.on('data', (chunk: Buffer) => {
      readyResolve();
      buffered += chunk.toString('utf8');
      const blocks = buffered.split('\n\n');
      buffered = blocks.pop() ?? '';
      for (const block of blocks) {
        let id: string | undefined;
        let data: string | undefined;
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) id = line.slice(4);
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (data !== undefined) frames.push({ ...(id === undefined ? {} : { id }), data: JSON.parse(data) as ConsoleStreamFrame & Record<string, unknown> });
      }
    });
    res.on('end', () => endResolve());
    res.on('close', () => endResolve());
  });
  req.on('error', () => endResolve());
  req.end();
  return { frames, ready, ended, close: () => req.destroy() };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Rejects rather than waiting forever: a hung invoke would otherwise escape
 *  every deadline in this file and hang the gate instead of failing a case. */
async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function settle(plugin: TaskShuttleServer, turnId: string, budgetMs = 60_000, pollMs = 50): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const result = await withDeadline(plugin.invoke('turn_get', { turnId }), 30_000, `turn_get ${turnId}`);
    if (result.ok && ['completed', 'failed', 'cancelled'].includes(result.output.state)) return;
    if (Date.now() > deadline) throw new Error(`turn ${turnId} never settled`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function runTurn(plugin: TaskShuttleServer, sessionId: string, text: string): Promise<string> {
  const started = await withDeadline(plugin.invoke('turn_start', { sessionId, prompt: [{ type: 'text', text }] }), 30_000, `turn_start on ${sessionId}`);
  if (!started.ok) throw new Error(`turn_start failed: ${started.error.code}`);
  await settle(plugin, started.output.turnId);
  return started.output.turnId;
}

/** A TCP dial with a verdict instead of an exception. */
function tryConnect(host: string, port: number, timeoutMs = 3_000): Promise<string> {
  return new Promise((resolveDial) => {
    const socket = netConnect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolveDial('timeout'); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolveDial('connected'); });
    socket.once('error', (cause: NodeJS.ErrnoException) => { clearTimeout(timer); resolveDial(cause.code ?? 'error'); });
  });
}

/** A fake instance directory for recovery/open-path cases; the lock file stays, its owner pid decides liveness. */
async function fakeInstance(dataRoot: string, options: { pid: number; consolePort?: number; consoleToken?: string }): Promise<string> {
  // The canonical start time, not a plausible-looking invention: lockAlive
  // compares the lock against the OS identity of the owning pid, so a live
  // owner carrying a fabricated timestamp reads as dead and every case staged
  // on this instance degrades to the stale-lock wording. An unreadable pid
  // (the stale-owner cases) keeps the old fallback.
  const startedAt = (await processStartTime(options.pid)) ?? new Date(Date.now() - 60_000).toISOString();
  const manager = await InstanceManager.create({
    dataRoot,
    rootNonce: randomBytes(16).toString('hex'),
    pid: options.pid,
    processStartedAt: startedAt,
    exePath: process.execPath,
  });
  if (options.consolePort !== undefined) {
    // Deliberately the pre-ADR-0030 shape: §7.3 says a reader meeting a legacy
    // `token` field ignores it rather than rejecting the file, and a fixture in
    // the new shape would never exercise that.
    await writeFile(consoleJsonPath(dataRoot, manager.instanceId), `${JSON.stringify({ port: options.consolePort, token: options.consoleToken ?? 'gate-token', startedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  }
  return manager.instanceId;
}

/** Recursively collect every object key of a parsed JSON body. */
function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) { for (const entry of value) collectKeys(entry, into); return; }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) { into.add(key); collectKeys(entry, into); }
  }
}

function runLaunchSubcommand(args: readonly string[], dataRoot: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(process.execPath, [LAUNCH_PATH, ...args], { env: { ...process.env, REALM_PLUGIN_DATA_ROOT: dataRoot } }, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== 'number') { rejectRun(error); return; }
      resolveRun({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

async function record(id: string, title: string, body: () => Promise<CaseOutcome>): Promise<void> {
  const startedAtMs = Date.now();
  try {
    const outcome = await body();
    cases.push({ id, title, ...outcome, durationMs: Date.now() - startedAtMs });
  } catch (cause) {
    cases.push({ id, title, status: 'fail', reason: cause instanceof Error ? cause.message : String(cause), durationMs: Date.now() - startedAtMs });
  }
}

// CONSOLE-001 (§7.2/§7.4): loopback-only bind; a non-loopback Host is 403.
await record('CONSOLE-001', 'loopback-only bind and Host-header validation', async (): Promise<CaseOutcome> => {
  const { port } = await startPlugin({ console: { enabled: true } });
  const foreign = await http(port, '/api/instance', { headers: { host: `example.com:${port}` } });
  if (foreign.status !== 403 || foreign.body !== '{"error":"forbidden"}') throw new Error(`foreign Host: ${foreign.status} ${foreign.body}`);
  const wrongAuthority = await http(port, '/api/instance', { headers: { host: `127.0.0.1:${port + 1}` } });
  if (wrongAuthority.status !== 403) throw new Error(`wrong-port authority: ${wrongAuthority.status}`);
  const loopback = await http(port, '/api/instance');
  if (loopback.status !== 200) throw new Error(`loopback request: ${loopback.status}`);
  // No port probing anywhere in the plugin; here the gate itself dials the
  // first non-loopback interface to prove the bind address excludes it.
  const external = Object.values(networkInterfaces()).flat().find((info) => info !== undefined && !info.internal && info.family === 'IPv4');
  let externalVerdict = 'no non-loopback IPv4 interface on this host';
  if (external !== undefined) {
    const dialed = await tryConnect(external.address, port);
    if (dialed === 'connected') throw new Error(`console accepted a connection on ${external.address}`);
    externalVerdict = `${external.address} ${dialed}`;
  }
  return { status: 'pass', evidence: { port, foreignHost: foreign.status, loopback: loopback.status, externalDial: externalVerdict } };
});

// CONSOLE-002 (§6): the route table is read-only by construction.
await record('CONSOLE-002', 'non-GET methods get 405 with allow: GET', async (): Promise<CaseOutcome> => {
  const { port } = await startPlugin({ console: { enabled: true } });
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await http(port, '/api/sessions', { method });
    if (res.status !== 405) throw new Error(`${method}: ${res.status}`);
    if (res.headers['allow'] !== 'GET') throw new Error(`${method}: allow header is ${String(res.headers['allow'])}`);
    if (res.body !== '{"error":"method_not_allowed"}') throw new Error(`${method}: ${res.body}`);
  }
  return { status: 'pass', evidence: { methods: ['POST', 'PUT', 'DELETE'], status: 405 } };
});

// CONSOLE-003 is struck by ADR 0032 and removed from execution: it asserted
// that missing and wrong tokens are byte-identical, and there is no token. Its
// number is never reused; CONSOLE-045 asserts the opposite property.

// CONSOLE-004 (§4): close drops the listener and the manifest; the next start's
// recovery deletes a dead instance's stale console.json without probing the port.
await record('CONSOLE-004', 'listener and console.json die with the instance; recovery reaps stale manifests', async (): Promise<CaseOutcome> => {
  const first = await startPlugin({ console: { enabled: true } });
  const ownManifest = consoleJsonPath(first.dataRoot, first.plugin.runtime.instanceId);
  if (!existsSync(ownManifest)) throw new Error('console.json missing while running');
  await first.plugin.close();
  if ((await tryConnect('127.0.0.1', first.port)) === 'connected') throw new Error('port still accepting after close');
  if (existsSync(ownManifest)) throw new Error('console.json survived close');

  const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-console-gate-'));
  const deadId = await fakeInstance(dataRoot, { pid: 999_999_999, consolePort: 41_001 });
  const liveId = await fakeInstance(dataRoot, { pid: process.pid, consolePort: 41_002 });
  const second = await startPlugin({ console: { enabled: true }, dataRoot });
  // The recovery scan runs concurrently with start-up; mutation tools await it
  // (design §4.1.9), so one session round trip is the gate's happens-before.
  const probe = await second.plugin.invoke('session_create', { engine: 'kimi', cwd: second.workRoot });
  if (!probe.ok) throw new Error(`probe session_create failed: ${probe.error.code}`);
  await second.plugin.invoke('session_close', { sessionId: probe.output.sessionId });
  if (existsSync(consoleJsonPath(dataRoot, deadId))) throw new Error('stale console.json survived start-up recovery');
  if (!existsSync(consoleJsonPath(dataRoot, liveId))) throw new Error('a live instance lost its console.json');
  if (!existsSync(consoleJsonPath(dataRoot, second.plugin.runtime.instanceId))) throw new Error('own console.json missing after restart');
  return { status: 'pass', evidence: { closedPortRefused: true, staleReaped: deadId, liveKept: liveId } };
});

// CONSOLE-005 (§7.7, widened by ADR 0031): the console gate is the settled
// delegation verdict, not `REALM_DELEGATION_DEPTH`. Three halves:
//   marker — a worker at depth 1 never opens a port;
//   unavailable — an instance that cannot establish it is a root keeps the
//     console down too, while the tools keep serving, and says so in the log
//     (`console_withheld`, never `console_start_failed`);
//   ancestry with a scrubbed environment — the measured defect. The simulated
//     engine loads no MCP servers of its own, so no nested plugin instance can
//     exist here; what this gate CAN do honestly is derive the verdict through
//     the real process table: it spawns a plain child process, publishes a live
//     lock naming the gate itself, and lets settleDelegation walk real ppid and
//     start-time reads to `ancestry` — then boots a server on that verdict with
//     no marker anywhere in its environment.
await record('CONSOLE-005', 'non-root verdicts open no port; the tools keep serving; withheld is named', async (): Promise<CaseOutcome> => {
  // Marker half: depth >= 1 by environment.
  const env = { REALM_DELEGATION_VERSION: '1', REALM_DELEGATION_DEPTH: '1', REALM_DELEGATION_ROOT: randomBytes(16).toString('hex') };
  const markerCtx = await startPlugin({ console: { enabled: true }, env, expectManifest: false });
  const inventory = await markerCtx.plugin.invoke('workers_list', { rescan: true });
  if (!inventory.ok) throw new Error(`workers_list failed at depth 1: ${inventory.error.code}`);
  if (existsSync(consoleJsonPath(markerCtx.dataRoot, markerCtx.plugin.runtime.instanceId))) throw new Error('console.json exists at delegation depth 1');

  // Unavailable half: doubt fails closed on the console only.
  const unavailableCtx = await startPlugin({ console: { enabled: true }, delegation: { provenance: 'unavailable' }, expectManifest: false });
  const serving = await unavailableCtx.plugin.invoke('workers_list', { rescan: true });
  if (!serving.ok) throw new Error(`tools must serve on unavailable: ${serving.error.code}`);
  if (existsSync(consoleJsonPath(unavailableCtx.dataRoot, unavailableCtx.plugin.runtime.instanceId))) throw new Error('console.json exists on an unavailable verdict');
  if (!unavailableCtx.logs.some((entry) => entry.event === 'console_withheld' && entry.provenance === 'unavailable')) {
    throw new Error('no console_withheld event for the unavailable verdict');
  }
  // Withholding is a decision, not a failure: no start was attempted, so no
  // start-failure may be claimed either.
  if (unavailableCtx.logs.some((entry) => entry.event === 'console_start_failed')) {
    throw new Error('an unavailable verdict logged console_start_failed');
  }

  // Ancestry half, derived through the real process table (see above).
  const walker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' });
  try {
    const ancestryRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-console-gate-'));
    cleanups.push(() => rm(ancestryRoot, { recursive: true, force: true }));
    if (walker.pid === undefined) throw new Error('the stand-in child has no pid');
    const started = await processStartTime(process.pid);
    if (started === undefined) throw new Error('this platform cannot read its own start time; ADR 0014 matrix only');
    // The lock names the gate itself, in the one canonical format both sides read.
    await InstanceManager.create({ dataRoot: ancestryRoot, pid: process.pid, processStartedAt: started, exePath: process.execPath, rootNonce: randomBytes(16).toString('hex') });
    const verdict = await settleDelegation({
      marker: readDelegationIdentity({} as NodeJS.ProcessEnv),
      dataRoot: ancestryRoot,
      pid: walker.pid,
      // Default probe: real ppid and start-time reads for the synthetic child,
      // whose parent chain crosses this process's freshly published lock.
    });
    if (verdict.provenance !== 'ancestry' || verdict.depth !== 1) {
      throw new Error(`the real-table walk answered ${JSON.stringify(verdict)}, not ancestry at depth 1`);
    }
    const ancestryCtx = await startPlugin({ console: { enabled: true }, delegation: verdict, expectManifest: false });
    if (existsSync(consoleJsonPath(ancestryCtx.dataRoot, ancestryCtx.plugin.runtime.instanceId))) throw new Error('console.json exists on an ancestry verdict');
    if (!ancestryCtx.logs.some((entry) => entry.event === 'console_withheld' && entry.provenance === 'ancestry')) {
      throw new Error('no console_withheld event for the ancestry verdict');
    }
    if (ancestryCtx.logs.some((entry) => entry.event === 'console_start_failed')) {
      throw new Error('an ancestry verdict logged console_start_failed');
    }
    return {
      status: 'pass',
      evidence: { markerDepth: 1, unavailableWithheld: true, ancestryDerivedFromProcessTable: true, withheldEvent: 'console_withheld' },
    };
  } finally {
    walker.kill();
  }
});

// CONSOLE-006 (§10.4): the console is off unless the install surface opts in.
await record('CONSOLE-006', 'default configuration starts no console', async (): Promise<CaseOutcome> => {
  const { plugin, dataRoot } = await startPlugin();
  const inventory = await plugin.invoke('workers_list', { rescan: true });
  if (!inventory.ok) throw new Error(`workers_list failed: ${inventory.error.code}`);
  if (existsSync(consoleJsonPath(dataRoot, plugin.runtime.instanceId))) throw new Error('console.json exists with the console disabled');
  return { status: 'pass', evidence: { consoleJson: false } };
});

// CONSOLE-007 (§7.8): with exposeTranscripts: false, no response — page, JSON,
// SSE frame or error body — may contain a content sentinel.
await record('CONSOLE-007', 'degraded mode leaks no prompt, name, cwd or interaction payload', async (): Promise<CaseOutcome> => {
  const { plugin, port, workRoot } = await startPlugin({
    console: { enabled: true, exposeTranscripts: false },
    engineEnv: { kimi: { RUNSKEIN_TESTKIT_ECHO_PROMPT: '1', RUNSKEIN_TESTKIT_ASK_PERMISSION: '1' } },
  });
  const cwd = join(workRoot, 'sentinel-cwd-7f3d');
  await mkdir(cwd, { recursive: true }); // resolveCwd realpaths the cwd, so it must exist
  const sentinelPrompt = 'SENTINEL-PROMPT-4f8a2c';
  const sentinelName = 'SENTINEL-NAME-9d1e';
  const sentinelPayloadPath = '/tmp/root.txt'; // the mock agent's permission payload path
  const created = await plugin.invoke('session_create', { engine: 'kimi', cwd, name: sentinelName, permissionMode: 'ask-orchestrator' });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code} ${created.error.message}`);
  const sessionId = created.output.sessionId;

  const sessionStream = openSse(port, `/api/stream?sessionId=${sessionId}`);
  const instanceStream = openSse(port, '/api/stream');
  await Promise.all([sessionStream.ready, instanceStream.ready]);

  const started = await plugin.invoke('turn_start', { sessionId, prompt: [{ type: 'text', text: sentinelPrompt }] });
  if (!started.ok) throw new Error(`turn_start failed: ${started.error.code}`);
  // The interaction surfaces through the tool surface first; its transition
  // frame is asserted from the collected stream below.
  const deadline = Date.now() + 30_000;
  let interactionId: string | undefined;
  while (interactionId === undefined) {
    if (Date.now() > deadline) throw new Error('no permission interaction appeared');
    const pending = await plugin.invoke('interaction_list', { turnId: started.output.turnId, state: 'pending' });
    if (pending.ok && pending.output.interactions.length > 0) interactionId = pending.output.interactions[0]!.interactionId;
    else await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const answered = await plugin.invoke('interaction_respond', { interactionId, response: { outcome: 'allow' } });
  if (!answered.ok) throw new Error(`interaction_respond failed: ${answered.error.code}`);
  await settle(plugin, started.output.turnId);
  await new Promise((resolve) => setTimeout(resolve, 150));
  // Interaction transitions stream in degraded mode too; the event's own kind
  // ('permission') is what the frame carries.
  if (!sessionStream.frames.some((frame) => frame.data['type'] === 'transition' && typeof frame.data['interactionId'] === 'string')) {
    throw new Error('no interaction transition frame on the session stream');
  }

  const corpus: string[] = [];
  for (const path of ['/', '/app.css', '/app.js', '/api/instance', '/api/sessions', `/api/sessions/${sessionId}`, `/api/sessions/${sessionId}/events?afterSeq=0`, '/api/turns', '/api/interactions', '/api/topology']) {
    const res = await http(port, path);
    if (res.status !== 200) throw new Error(`${path}: ${res.status}`);
    corpus.push(res.body);
  }
  // Error bodies are covered too: a malformed cursor and an unknown session.
  corpus.push((await http(port, `/api/sessions/${sessionId}/events?afterSeq=abc`)).body);
  corpus.push((await http(port, '/api/sessions/nope/events?afterSeq=0')).body);
  for (const frame of [...sessionStream.frames, ...instanceStream.frames]) corpus.push(JSON.stringify(frame.data));
  sessionStream.close();
  instanceStream.close();

  for (const sentinel of [sentinelPrompt, sentinelName, cwd, sentinelPayloadPath]) {
    const hit = corpus.findIndex((body) => body.includes(sentinel));
    if (hit >= 0) throw new Error(`sentinel ${sentinel} leaked into response #${hit}`);
  }
  return { status: 'pass', evidence: { responses: corpus.length, sentinels: 4, eventsEndpointFrames: sessionStream.frames.length } };
});

// CONSOLE-008 (§5.3): a full stream load must not slow the hot path — p95 of
// turn wall time with 8 subscribers ≤ 1.05 × the no-console baseline. The mock
// prompt delay stretches each turn so scheduler jitter cannot dominate.
await record('CONSOLE-008', 'turn p95 with 8 SSE subscribers within 5% of the no-console baseline', async (): Promise<CaseOutcome> => {
  const turns = 20;
  const engineEnv = { kimi: { RUNSKEIN_TESTKIT_ECHO_PROMPT: '1', RUNSKEIN_TESTKIT_PROMPT_DELAY_MS: '400' } };
  const timedTurns = async (plugin: TaskShuttleServer, sessionId: string): Promise<number[]> => {
    const samples: number[] = [];
    for (let index = 0; index < turns; index += 1) {
      const t0 = Date.now();
      const started = await plugin.invoke('turn_start', { sessionId, prompt: [{ type: 'text', text: `tick ${index}` }] });
      if (!started.ok) throw new Error(`turn_start failed: ${started.error.code}`);
      await settle(plugin, started.output.turnId, 60_000, 10);
      samples.push(Date.now() - t0);
    }
    return samples;
  };
  const p95 = (samples: readonly number[]): number => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]!;

  const baseline = await startPlugin({ engineEnv });
  const baseSession = await baseline.plugin.invoke('session_create', { engine: 'kimi', cwd: baseline.workRoot });
  if (!baseSession.ok) throw new Error(`baseline session_create failed: ${baseSession.error.code}`);
  const baseSamples = await timedTurns(baseline.plugin, baseSession.output.sessionId);

  const loaded = await startPlugin({ console: { enabled: true, maxConsoleStreams: 8 }, engineEnv });
  const loadSession = await loaded.plugin.invoke('session_create', { engine: 'kimi', cwd: loaded.workRoot });
  if (!loadSession.ok) throw new Error(`load session_create failed: ${loadSession.error.code}`);
  const streams: SseClient[] = [];
  for (let index = 0; index < 8; index += 1) {
    const stream = openSse(loaded.port, `/api/stream?sessionId=${loadSession.output.sessionId}`);
    streams.push(stream);
  }
  await Promise.all(streams.map((stream) => stream.ready));
  const loadSamples = await timedTurns(loaded.plugin, loadSession.output.sessionId);
  for (const stream of streams) stream.close();

  const baseP95 = p95(baseSamples);
  const loadP95 = p95(loadSamples);
  const ratio = loadP95 / baseP95;
  if (ratio > 1.05) throw new Error(`p95 regression: baseline ${baseP95}ms, loaded ${loadP95}ms (ratio ${ratio.toFixed(3)})`);
  return {
    status: 'pass',
    evidence: { turns, baseP95, loadP95, ratio: Math.round(ratio * 1000) / 1000, baseSamples: baseSamples.join(','), loadSamples: loadSamples.join(',') },
  };
});

// CONSOLE-009 (§5.2): after the backfill, a live session stream is fed purely
// by the append fan-out — it adds zero store reads to what the turn pipeline
// itself performs (beforePrompt/drain read the transcript either way), so the
// assertion is stream-attached reads === no-stream reads on identical turns.
await record('CONSOLE-009', 'a live stream adds zero steady-state store reads', async (): Promise<CaseOutcome> => {
  const ctx = await startPlugin({ console: { enabled: true }, engineEnv: { kimi: { RUNSKEIN_TESTKIT_ECHO_PROMPT: '1' } } });
  const { plugin, port } = ctx;
  const created = await plugin.invoke('session_create', { engine: 'kimi', cwd: ctx.workRoot });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  const sessionId = created.output.sessionId;
  await runTurn(plugin, sessionId, 'warm-up turn');
  const watermark = (await plugin.invoke('transcript_read', { sessionId, afterSeq: 0, limit: 1 }));
  if (!watermark.ok) throw new Error('transcript_read failed');
  const backfillEvents = watermark.output.highWatermark;

  const stream = openSse(port, `/api/stream?sessionId=${sessionId}`);
  await waitFor(() => stream.frames.filter((frame) => frame.data['type'] === 'event').length >= backfillEvents, 15_000, 'backfill frames');
  await new Promise((resolve) => setTimeout(resolve, 150)); // let the catch-up fully drain

  let storeReads = 0;
  const init = await plugin.runtime.ready;
  const store = init.store as unknown as Record<string, unknown>;
  const originalRead = (init.store.read as (...args: unknown[]) => unknown).bind(init.store);
  const originalWatermark = (init.store.highWatermark as (...args: unknown[]) => unknown).bind(init.store);
  store['read'] = (...args: unknown[]) => { storeReads += 1; return originalRead(...args); };
  store['highWatermark'] = (...args: unknown[]) => { storeReads += 1; return originalWatermark(...args); };
  let withStream = -1;
  let withoutStream = -1;
  try {
    storeReads = 0;
    await runTurn(plugin, sessionId, 'measured turn with subscriber');
    await waitFor(() => stream.frames.filter((frame) => frame.data['type'] === 'event').length > backfillEvents, 15_000, 'live frames');
    await new Promise((resolve) => setTimeout(resolve, 150));
    withStream = storeReads;
    stream.close();
    await stream.ended;
    await new Promise((resolve) => setTimeout(resolve, 150)); // the unsubscribe rides the socket close
    storeReads = 0;
    await runTurn(plugin, sessionId, 'measured turn without subscriber');
    withoutStream = storeReads;
  } finally {
    store['read'] = originalRead;
    store['highWatermark'] = originalWatermark;
    stream.close();
  }
  if (withStream !== withoutStream) throw new Error(`the subscriber changed steady-state store reads: ${withStream} with vs ${withoutStream} without`);
  return { status: 'pass', evidence: { backfillEvents, readsWithStream: withStream, readsWithoutStream: withoutStream } };
});

// CONSOLE-010 and CONSOLE-011 are struck by ADR 0032 and removed from
// execution: one asserted a constant-time token comparison, the other the
// first-visit 302 that moved a token into an HttpOnly cookie. Neither
// mechanism exists. Their numbers are never reused.

// CONSOLE-012: /api/instance is a whitelist projection — no token hashes,
// no pid, no exePath. The console's own credential is gone (ADR 0032), so
// what it forbids now is the instance identity material, not a bearer.
// The literal check uses the quoted JSON key shape ("pid") because a bare
// 'pid' occurs inside legitimate values ("rapid", "pids") — a gate that
// fails a correct projection is worse than one that checks less. collectKeys
// already covers every real JSON key, so the literal is only a tripwire for
// a raw '"pid"' occurrence outside the parsed key set (e.g. a different
// serialization shape); a string value carrying a stringified object is
// escaped by JSON.stringify and is deliberately out of reach.
await record('CONSOLE-012', 'instance info carries no hashes, pid or exePath', async (): Promise<CaseOutcome> => {
  const { port } = await startPlugin({ console: { enabled: true } });
  const res = await http(port, '/api/instance');
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  const keys = new Set<string>();
  collectKeys(JSON.parse(res.body), keys);
  for (const forbidden of ['tokenHash', 'launchTokenHash', 'exePath', 'pid']) {
    if (keys.has(forbidden)) throw new Error(`forbidden key present: ${forbidden}`);
    if (res.body.includes(`"${forbidden}"`)) throw new Error(`forbidden literal in body: ${forbidden}`);
  }
  return { status: 'pass', evidence: { keys: [...keys].sort() } };
});

// CONSOLE-013 (§5.4): transcript_delete invalidates subscribers, then the
// events endpoint and any reconnect answer 404.
await record('CONSOLE-013', 'delete invalidates stream subscribers and the route 404s', async (): Promise<CaseOutcome> => {
  const ctx = await startPlugin({ console: { enabled: true } });
  const { plugin, port } = ctx;
  const created = await plugin.invoke('session_create', { engine: 'codex', cwd: ctx.workRoot });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  const sessionId = created.output.sessionId;
  await runTurn(plugin, sessionId, 'produce some events');
  const closed = await plugin.invoke('session_close', { sessionId });
  if (!closed.ok) throw new Error(`session_close failed: ${closed.error.code}`);

  const stream = openSse(port, `/api/stream?sessionId=${sessionId}`);
  await waitFor(() => stream.frames.some((frame) => frame.data['type'] === 'event'), 15_000, 'backfill before delete');
  const deleted = await plugin.invoke('transcript_delete', { sessionId });
  if (!deleted.ok) throw new Error(`transcript_delete failed: ${deleted.error.code}`);
  await stream.ended;
  const last = stream.frames.at(-1)?.data;
  if (last?.['type'] !== 'invalidated' || last['sessionId'] !== sessionId) throw new Error(`last frame: ${JSON.stringify(last)}`);
  const events = await http(port, `/api/sessions/${sessionId}/events?afterSeq=0`);
  if (events.status !== 404) throw new Error(`events after delete: ${events.status}`);
  const reconnect = await http(port, `/api/stream?sessionId=${sessionId}`);
  if (reconnect.status !== 404) throw new Error(`stream reconnect after delete: ${reconnect.status}`);
  return { status: 'pass', evidence: { sessionId, terminalFrame: 'invalidated', eventsStatus: 404, reconnectStatus: 404 } };
});

// CONSOLE-014 (§7.2): an explicit port already in use fails start-up with a
// field-level error; no console.json is written, no fallback port is taken.
await record('CONSOLE-014', 'occupied explicit port fails start with a console.port error', async (): Promise<CaseOutcome> => {
  const blocker = createNetServer();
  await new Promise<void>((resolveListen) => blocker.listen(0, '127.0.0.1', resolveListen));
  const address = blocker.address();
  if (address === null || typeof address === 'string') throw new Error('blocker has no port');
  const occupied = address.port;
  const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-console-gate-'));
  const workRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-console-work-'));
  const plugin = createTaskShuttleServer({
    dataRoot,
    env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [workRoot], console: { enabled: true, port: occupied } }), REALM_PLUGIN_LOG: 'off' } as NodeJS.ProcessEnv,
    hostCwd: workRoot,
    hubFactory: simulatedHubFactory(),
  });
  cleanups.push(async () => {
    await plugin.close().catch(() => undefined);
    await rm(dataRoot, { recursive: true, force: true });
    await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
  });
  let rejection = '';
  try { await plugin.runtime.ready; } catch (cause) { rejection = cause instanceof Error ? cause.message : String(cause); }
  if (rejection === '') throw new Error('ready resolved on an occupied port');
  if (!/console\.port/.test(rejection)) throw new Error(`rejection names the wrong field: ${rejection}`);
  if (existsSync(consoleJsonPath(dataRoot, plugin.runtime.instanceId))) throw new Error('console.json written despite the failed start');
  return { status: 'pass', evidence: { port: occupied, rejection: rejection.slice(0, 120) } };
});

// CONSOLE-015 (§5.2): over maxConsoleStreams the answer is 503; established
// subscribers keep receiving frames.
await record('CONSOLE-015', 'the stream cap answers 503 and existing subscribers keep flowing', async (): Promise<CaseOutcome> => {
  const ctx = await startPlugin({ console: { enabled: true, maxConsoleStreams: 2 } });
  const { plugin, port } = ctx;
  const first = openSse(port, '/api/stream');
  const second = openSse(port, '/api/stream');
  await Promise.all([first.ready, second.ready]);
  const third = await http(port, '/api/stream');
  if (third.status !== 503 || third.body !== '{"error":"stream_limit"}') throw new Error(`third stream: ${third.status} ${third.body}`);
  const created = await plugin.invoke('session_create', { engine: 'kimi', cwd: ctx.workRoot });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  await waitFor(() => first.frames.some((frame) => frame.data['type'] === 'transition' && frame.data['kind'] === 'session'), 10_000, 'first stream transition');
  await waitFor(() => second.frames.some((frame) => frame.data['type'] === 'transition' && frame.data['kind'] === 'session'), 10_000, 'second stream transition');
  first.close();
  second.close();
  return { status: 'pass', evidence: { cap: 2, thirdStatus: 503, establishedStillFlow: true } };
});

// CONSOLE-016 (§5.5): a fork draws a fork edge from the recorded parent
// pointer; there is no plugin_sessions table — lineage is the registry record.
await record('CONSOLE-016', 'fork produces a fork edge between parent and child nodes', async (): Promise<CaseOutcome> => {
  const ctx = await startPlugin({ console: { enabled: true } });
  const { plugin, port } = ctx;
  const parent = await plugin.invoke('session_create', { engine: 'kimi', cwd: ctx.workRoot });
  if (!parent.ok) throw new Error(`session_create failed: ${parent.error.code}`);
  const forked = await plugin.invoke('session_fork', { sessionId: parent.output.sessionId, name: 'gate-child' });
  if (!forked.ok) throw new Error(`session_fork failed: ${forked.error.code}`);
  const childId = forked.output.sessionId;
  const record_ = plugin.runtime.registry.getSession(childId);
  if (record_?.parentSessionId !== parent.output.sessionId) throw new Error(`registry parent pointer: ${String(record_?.parentSessionId)}`);
  const topology = await http(port, '/api/topology');
  if (topology.status !== 200) throw new Error(`topology: ${topology.status}`);
  const parsed = JSON.parse(topology.body) as { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
  const edge = parsed.edges.find((entry) => entry['type'] === 'fork' && entry['from'] === parent.output.sessionId && entry['to'] === childId);
  if (edge === undefined) throw new Error(`no fork edge in ${topology.body}`);
  const lineageOf = (id: string): unknown => parsed.nodes.find((node) => node['sessionId'] === id)?.['lineage'];
  if (lineageOf(childId) !== 'forked') throw new Error(`child lineage: ${String(lineageOf(childId))}`);
  if (lineageOf(parent.output.sessionId) !== 'root') throw new Error(`parent lineage: ${String(lineageOf(parent.output.sessionId))}`);
  return { status: 'pass', evidence: { parent: parent.output.sessionId, child: childId, edge: 'fork' } };
});

// CONSOLE-017 (§5.5, reworded in §11): lineage is a three-state projection of
// the registry record — root is parentSessionId === null (never "unknown"),
// "unknown" is reserved for a genuinely absent field, and nothing fabricates a
// parent pointer. Runtime behaviour plus the source-level mapping are pinned.
await record('CONSOLE-017', 'lineage is three-state and never fabricated', async (): Promise<CaseOutcome> => {
  const ctx = await startPlugin({ console: { enabled: true } });
  const { plugin, port } = ctx;
  const created = await plugin.invoke('session_create', { engine: 'kimi', cwd: ctx.workRoot });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  const rootId = created.output.sessionId;
  const rootRecord = plugin.runtime.registry.getSession(rootId);
  if (rootRecord?.parentSessionId !== null) throw new Error(`root parentSessionId: ${String(rootRecord?.parentSessionId)}`);
  const forked = await plugin.invoke('session_fork', { sessionId: rootId });
  if (!forked.ok) throw new Error(`session_fork failed: ${forked.error.code}`);
  if (plugin.runtime.registry.getSession(forked.output.sessionId)?.parentSessionId !== rootId) throw new Error('fork child does not point at its parent');

  const topology = JSON.parse((await http(port, '/api/topology')).body) as { nodes: Array<Record<string, unknown>> };
  const lineageOf = (id: string): unknown => topology.nodes.find((node) => node['sessionId'] === id)?.['lineage'];
  if (lineageOf(rootId) !== 'root') throw new Error(`root renders as ${String(lineageOf(rootId))}`);
  if (lineageOf(forked.output.sessionId) !== 'forked') throw new Error(`child renders as ${String(lineageOf(forked.output.sessionId))}`);

  // The mapping itself: undefined → 'unknown' only, null → 'root' (data-source);
  // the UI renders the unknown tag for that state alone.
  const dataSource = await readFile(join(process.cwd(), 'packages', 'plugin', 'src', 'console', 'data-source.ts'), 'utf8');
  if (!dataSource.includes("parentSessionId === undefined ? 'unknown'")) throw new Error('the undefined → unknown mapping changed');
  if (!dataSource.includes("=== null ? 'root'")) throw new Error('the null → root mapping changed');
  const ui = await readFile(join(process.cwd(), 'packages', 'plugin', 'src', 'console', 'ui', 'app.js'), 'utf8');
  if (!ui.includes("lineage === 'unknown'")) throw new Error('the UI unknown-tag condition changed');
  return { status: 'pass', evidence: { root: rootId, rootLineage: 'root', childLineage: 'forked', mappingPinned: true } };
});

// CONSOLE-018 (§7.8): in degraded mode the topology still renders — nodes and
// edges from IDs, timestamps, enum states and counts only; cwd_overlap carries
// the grouping but never the path.
await record('CONSOLE-018', 'degraded topology renders with no cwd or name anywhere', async (): Promise<CaseOutcome> => {
  const ctx = await startPlugin({ console: { enabled: true, exposeTranscripts: false } });
  const { plugin, port, workRoot } = ctx;
  const shared = join(workRoot, 'shared-cwd');
  await mkdir(shared, { recursive: true });
  const first = await plugin.invoke('session_create', { engine: 'kimi', cwd: shared, name: 'alpha' });
  const second = await plugin.invoke('session_create', { engine: 'codex', cwd: shared, name: 'beta' });
  if (!first.ok || !second.ok) throw new Error('session_create failed');
  const res = await http(port, '/api/topology');
  if (res.status !== 200) throw new Error(`topology: ${res.status}`);
  const parsed = JSON.parse(res.body) as { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
  const keys = new Set<string>();
  collectKeys(parsed, keys);
  for (const forbidden of ['cwd', 'name']) if (keys.has(forbidden)) throw new Error(`degraded topology carries ${forbidden}`);
  if (res.body.includes(shared)) throw new Error('the cwd value leaked into the topology body');
  const overlap = parsed.edges.find((edge) => edge['type'] === 'cwd_overlap');
  if (overlap === undefined) throw new Error('no cwd_overlap edge for two sessions sharing a cwd');
  const group = overlap['sessions'];
  if (!Array.isArray(group) || group.length !== 2) throw new Error(`cwd_overlap group: ${JSON.stringify(group)}`);
  for (const node of parsed.nodes) {
    if (typeof node['lineage'] !== 'string' || typeof node['state'] !== 'string' || typeof node['createdAt'] !== 'string') throw new Error(`node misses whitelist fields: ${JSON.stringify(node)}`);
  }
  return { status: 'pass', evidence: { nodes: parsed.nodes.length, overlapGroup: 2, cwdKeyPresent: false } };
});

// CONSOLE-019 (§5.6): recorded engine defects ride every projection the same
// way — /api/instance, /api/sessions and /api/topology agree verbatim.
await record('CONSOLE-019', 'knownDefects and verification are consistent across projections', async (): Promise<CaseOutcome> => {
  const ctx = await startPlugin({ console: { enabled: true } });
  const { plugin, port } = ctx;
  const created = await plugin.invoke('session_create', { engine: 'claude-code', cwd: ctx.workRoot });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  const instance = JSON.parse((await http(port, '/api/instance')).body) as { engines: Array<Record<string, unknown>> };
  const sessions = JSON.parse((await http(port, '/api/sessions')).body) as { sessions: Array<Record<string, unknown>> };
  const topology = JSON.parse((await http(port, '/api/topology')).body) as { nodes: Array<Record<string, unknown>> };
  const fromInstance = instance.engines.find((engine) => engine['engine'] === 'claude-code');
  const fromSessions = sessions.sessions.find((session) => session['sessionId'] === created.output.sessionId);
  const fromTopology = topology.nodes.find((node) => node['sessionId'] === created.output.sessionId);
  if (fromInstance === undefined || fromSessions === undefined || fromTopology === undefined) throw new Error('claude-code missing from a projection');
  // The expectations come from the shared support table, not literals: which
  // engines carry evidence and defects moves every time a live matrix runs,
  // and a pinned literal tests the week instead of the §5.6 consistency rule
  // (the 'unverified' literal here broke the moment claude-code's matrix was
  // run while its fork defect stayed recorded). Agreement between this table
  // and release/metadata.json is the artifact gate's job; this case proves
  // the three projections agree with the table.
  const expectedDefects = KNOWN_BROKEN_CAPABILITIES.filter((entry) => entry.engine === 'claude-code').map((entry) => entry.capability);
  if (expectedDefects.length === 0) throw new Error('claude-code carries no recorded defect; CONSOLE-019 needs an engine with one');
  const expectedVerification = verificationState('claude-code');
  for (const [label, projection] of [['instance', fromInstance], ['sessions', fromSessions], ['topology', fromTopology]] as const) {
    const defects = projection['knownDefects'];
    if (!Array.isArray(defects) || JSON.stringify(defects) !== JSON.stringify(expectedDefects)) throw new Error(`${label} knownDefects: ${JSON.stringify(defects)}`);
    if (projection['verification'] !== expectedVerification) throw new Error(`${label} verification: ${String(projection['verification'])}`);
  }
  return { status: 'pass', evidence: { engine: 'claude-code', knownDefects: expectedDefects, verification: expectedVerification } };
});

// CONSOLE-020 (§5.2): the instance summary stream carries transitions only —
// never transcript events; the session stream carries the event increments.
await record('CONSOLE-020', 'instance stream has transitions only; session stream has events', async (): Promise<CaseOutcome> => {
  const ctx = await startPlugin({ console: { enabled: true }, engineEnv: { kimi: { RUNSKEIN_TESTKIT_ECHO_PROMPT: '1' } } });
  const { plugin, port } = ctx;
  const created = await plugin.invoke('session_create', { engine: 'kimi', cwd: ctx.workRoot });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  const sessionId = created.output.sessionId;
  const instanceStream = openSse(port, '/api/stream');
  const sessionStream = openSse(port, `/api/stream?sessionId=${sessionId}`);
  await Promise.all([instanceStream.ready, sessionStream.ready]);
  const turnId = await runTurn(plugin, sessionId, 'stream-discrimination turn');
  await waitFor(() => instanceStream.frames.some((frame) => frame.data['type'] === 'transition' && frame.data['turnId'] === turnId && frame.data['to'] === 'completed'), 15_000, 'instance turn transition');
  await waitFor(() => sessionStream.frames.some((frame) => frame.data['type'] === 'event'), 15_000, 'session event frames');
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (instanceStream.frames.some((frame) => frame.data['type'] === 'event' || frame.data['type'] === 'event_ref')) throw new Error('the instance stream carried a transcript event');
  if (!instanceStream.frames.every((frame) => frame.data['type'] === 'transition')) throw new Error('the instance stream carried a non-transition frame');
  const unknown = await http(port, '/api/stream?sessionId=no-such-session');
  if (unknown.status !== 404) throw new Error(`unknown session stream: ${unknown.status}`);
  instanceStream.close();
  sessionStream.close();
  return { status: 'pass', evidence: { instanceFrames: instanceStream.frames.length, sessionEvents: sessionStream.frames.filter((frame) => frame.data['type'] === 'event').length, unknownSession: 404 } };
});

// CONSOLE-021 (§8.2): multiple live consoles demand --instance; dead locks
// read as "not listening", a root with no console.json as "not enabled". The
// opened path itself is covered by test/console/open.test.ts with an injected
// opener — the gate never pops a real browser.
//
// It does not cover ADR 0042's kinship narrowing, and cannot: both fixtures
// name this process as the owner, so both are kin to the `console open` child
// this spawns and the narrowing never decides. Giving one of them a
// non-ancestor owner is not available either — the owner has to be a live pid
// for the lock to read as alive. The case therefore asserts the *fallback*,
// which is the branch a gate can reach; the narrowing's own branches are
// driven by an injected process tree in the unit tests.
//
// The fixtures write pre-ADR-0030 manifests carrying a `token` field, so this
// also holds the line §7.3 draws around them: the field is ignored, and it
// reaches neither stdout nor stderr.
await record('CONSOLE-021', 'console open: listing fallback and liveness wording, and a legacy token field stays out of the output', async (): Promise<CaseOutcome> => {
  const tokenA = 'GATE-SECRET-TOKEN-A';
  const tokenB = 'GATE-SECRET-TOKEN-B';

  const ambiguousRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-console-open-'));
  cleanups.push(() => rm(ambiguousRoot, { recursive: true, force: true }));
  const idA = await fakeInstance(ambiguousRoot, { pid: process.pid, consolePort: 42_001, consoleToken: tokenA });
  const idB = await fakeInstance(ambiguousRoot, { pid: process.pid, consolePort: 42_002, consoleToken: tokenB });
  const ambiguous = await runLaunchSubcommand(['console', 'open'], ambiguousRoot);
  if (ambiguous.code !== 1) throw new Error(`ambiguous exit ${ambiguous.code}`);
  if (!ambiguous.stdout.includes(idA) || !ambiguous.stdout.includes(idB)) throw new Error(`ambiguous output misses an instance: ${ambiguous.stdout}`);
  if (!ambiguous.stdout.includes('--instance')) throw new Error('ambiguous output does not ask for --instance');
  if (ambiguous.stdout.includes(tokenA) || ambiguous.stdout.includes(tokenB) || ambiguous.stderr.includes(tokenA) || ambiguous.stderr.includes(tokenB)) throw new Error('a token reached the output');

  const emptyRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-console-open-'));
  cleanups.push(() => rm(emptyRoot, { recursive: true, force: true }));
  const none = await runLaunchSubcommand(['console', 'open'], emptyRoot);
  if (none.code !== 1 || !none.stdout.includes('no console is enabled')) throw new Error(`empty root: ${none.code} ${none.stdout}`);

  const staleRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-console-open-'));
  cleanups.push(() => rm(staleRoot, { recursive: true, force: true }));
  await fakeInstance(staleRoot, { pid: 999_999_999, consolePort: 42_003, consoleToken: tokenA });
  const stale = await runLaunchSubcommand(['console', 'open'], staleRoot);
  if (stale.code !== 1 || !stale.stdout.includes('not listening')) throw new Error(`stale root: ${stale.code} ${stale.stdout}`);
  if (stale.stdout.includes(tokenA) || stale.stderr.includes(tokenA)) throw new Error('a token reached the output');

  return { status: 'pass', evidence: { ambiguousExit: 1, emptyWording: 'no console is enabled', staleWording: 'not listening', openedPath: 'covered by test/console/open.test.ts (injected opener)', kinshipNarrowing: 'not covered here: both fixture owners are this process, so both are kin — test/console/open.test.ts owns it' } };
});

// CONSOLE-042 (ADR 0032): two consoles on one machine do not evict each other.
// This is the defect GZH-44 recorded, and the case CONSOLE-001..003 could not
// be: not one of them ever ran two instances.
await record('CONSOLE-042', 'two live consoles do not evict each other from a shared cookie jar', async (): Promise<CaseOutcome> => {
  const a = await startPlugin({ console: { enabled: true } });
  const b = await startPlugin({ console: { enabled: true } });
  if (a.port === b.port) throw new Error('both consoles reported the same port');

  // A needs a transcript, so the case can ask for a paged transcript route and
  // not merely a list that happens to be empty.
  const created = await a.plugin.invoke('session_create', { engine: SIMULATED_ENGINES[0], cwd: a.workRoot });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  const sessionId = created.output.sessionId;
  await runTurn(a.plugin, sessionId, 'console-042');

  const jar = browserJar();
  // Visit each console the way a browser would — the bare address, one jar
  // across both ports, following whatever either answers with. Against the
  // pre-fix server this first line already fails, with the 401 that is the
  // defect: there, `/` without a credential was a challenge.
  const visitA = await jar.get(a.port, '/');
  if (visitA.status !== 200) throw new Error(`first visit to A: ${visitA.status}`);
  const visitB = await jar.get(b.port, '/');
  if (visitB.status !== 200) throw new Error(`visit to B: ${visitB.status}`);

  // Back to A, carrying whatever B left in the jar. No `?token=` anywhere:
  // a query credential would let A succeed even while B's cookie was
  // installed, and the case would pass against the very defect it exists for.
  //
  // Several routes rather than one, because "A still works" must not be
  // satisfiable by an implementation that opened up a single path.
  const events = `/api/sessions/${encodeURIComponent(sessionId)}/events?afterSeq=0&projection=folded`;
  for (const path of ['/', '/api/instance', '/api/sessions', '/api/turns', events]) {
    const res = await jar.get(a.port, path);
    if (res.status !== 200) throw new Error(`A after visiting B, ${path}: ${res.status} ${res.body}`);
  }
  // A page with content is not yet A's page: a canned body would satisfy that.
  // The session detail must name this session, and the transcript must reach
  // the watermark the tool surface reports for it.
  const detail = JSON.parse((await jar.get(a.port, `/api/sessions/${encodeURIComponent(sessionId)}`)).body) as { sessionId?: string };
  if (detail.sessionId !== sessionId) throw new Error(`A served a different session's detail: ${String(detail.sessionId)}`);
  const page = JSON.parse((await jar.get(a.port, events)).body) as { runs?: unknown[]; events?: unknown[]; highWatermark?: number };
  const viaTool = await a.plugin.invoke('transcript_read', { sessionId, limit: 1 });
  if (!viaTool.ok) throw new Error(`transcript_read failed: ${viaTool.error.code}`);
  if (page.highWatermark !== viaTool.output.highWatermark) {
    throw new Error(`console watermark ${String(page.highWatermark)} != tool watermark ${viaTool.output.highWatermark}`);
  }
  if ((page.runs ?? page.events ?? []).length === 0) throw new Error('transcript page was empty, so it proves nothing about reading A');
  return { status: 'pass', evidence: { portA: a.port, portB: b.port, routesAfterEviction: 5, watermark: page.highWatermark } };
});

// CONSOLE-043 (§7.4 / §7.3): the two rules that became load-bearing when the
// credential went, plus the inertness of a legacy query.
await record('CONSOLE-043', 'no Set-Cookie, no CORS header, no executable media type, and a legacy token is inert', async (): Promise<CaseOutcome> => {
  const ctx = await startPlugin({ console: { enabled: true } });
  const { port } = ctx;
  const created = await ctx.plugin.invoke('session_create', { engine: SIMULATED_ENGINES[0], cwd: ctx.workRoot });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  const sessionId = created.output.sessionId;
  await runTurn(ctx.plugin, sessionId, 'console-043');
  const encoded = encodeURIComponent(sessionId);

  // The token the *running server* accepts, when it still has one. Before the
  // change this is a genuinely valid credential and drives the 302 +
  // Set-Cookie path — a wrong one would be answered exactly like a
  // credential-free request, so a case using one proves nothing. After the
  // change the manifest has no token and the query is simply an unknown
  // parameter, which is the inertness §7.3 states.
  const manifest = JSON.parse(await readFile(consoleJsonPath(ctx.dataRoot, ctx.plugin.runtime.instanceId), 'utf8')) as Record<string, unknown>;
  // Before the change this is a genuinely valid credential, and the case's red
  // path depends on it: a wrong token is answered exactly like a
  // credential-free request. After the change no valid token can exist, and
  // the query is simply unknown — which is the inertness §7.3 states. The
  // evidence records which of the two states was exercised, so a run cannot
  // silently claim the stronger one.
  const legacyToken = typeof manifest['token'] === 'string' ? manifest['token'] : 'legacy-token-no-longer-issued';

  const okRoutes = ['/', '/app.css', '/app.js', '/fonts/PTMono-Regular.woff2', '/api/instance', '/api/sessions', '/api/turns', '/api/interactions', '/api/topology',
    `/api/sessions/${encoded}`, `/api/sessions/${encoded}/events?afterSeq=0`, `/api/sessions/${encoded}/diffs?afterSeq=0`];
  const errorRoutes: Array<{ path: string; want: number }> = [
    { path: '/nope', want: 404 },
    { path: '/api/sessions/missing-session', want: 404 },
    { path: `/api/sessions/${encoded}/events?afterSeq=0x10`, want: 400 },
  ];
  const apiRoutes = ['/api/instance', '/api/sessions', '/api/turns', '/api/interactions', '/api/topology', `/api/sessions/${encoded}`,
    `/api/sessions/${encoded}/events?afterSeq=0`, `/api/sessions/${encoded}/diffs?afterSeq=0`, ...errorRoutes.map((route) => route.path)];
  const forbidden = (res: Omit<HttpResult, 'body'>, where: string): void => {
    if (res.headers['set-cookie'] !== undefined) throw new Error(`${where} carries Set-Cookie`);
    if (res.headers['access-control-allow-origin'] !== undefined) throw new Error(`${where} carries Access-Control-Allow-Origin`);
  };
  const withToken = (path: string): string => `${path}${path.includes('?') ? '&' : '?'}token=${legacyToken}`;

  // A status alone is not the route's own answer — `200 {"error":"unauthorized"}`
  // and `200 "ok"` both satisfy a status check while the console serves
  // nobody. Each route is checked against the shape §6 gives it, rather than
  // against a heuristic about what a body must not contain: a rule invented
  // here would fail a correct implementation that happens to word things
  // differently.
  const ownAnswer = (path: string, body: string): void => {
    const json = (): Record<string, unknown> => JSON.parse(body) as Record<string, unknown>;
    if (path === '/') { if (!body.includes('<script src="/app.js"')) throw new Error('/ did not serve the UI'); return; }
    if (path === '/app.css' || path === '/app.js' || path.startsWith('/fonts/')) { if (body.length === 0) throw new Error(`${path} served nothing`); return; }
    if (path === '/api/instance') { if (typeof json()['instanceId'] !== 'string') throw new Error('/api/instance carries no instanceId'); return; }
    if (path === '/api/sessions') { if (!Array.isArray(json()['sessions'])) throw new Error('/api/sessions carries no sessions array'); return; }
    if (path === '/api/turns') { if (!Array.isArray(json()['turns'])) throw new Error('/api/turns carries no turns array'); return; }
    if (path === '/api/interactions') { if (!Array.isArray(json()['interactions'])) throw new Error('/api/interactions carries no interactions array'); return; }
    if (path === '/api/topology') { if (!Array.isArray(json()['nodes'])) throw new Error('/api/topology carries no nodes array'); return; }
    if (/\/events\?/.test(path)) { if (json()['highWatermark'] === undefined) throw new Error(`${path} carries no highWatermark`); return; }
    if (/\/diffs\?/.test(path)) { if (json()['highWatermark'] === undefined) throw new Error(`${path} carries no highWatermark`); return; }
    if (json()['sessionId'] !== sessionId) throw new Error(`${path} is not this session's detail`);
  };
  for (const { path, want } of [...okRoutes.map((path) => ({ path, want: 200 })), ...errorRoutes]) {
    const bare = await http(port, path);
    const legacy = await http(port, withToken(path));
    forbidden(bare, `credential-free ${path}`);
    forbidden(legacy, `legacy-token ${path}`);
    // The credential-free answer must be the route's OWN answer. Equality
    // alone is satisfied by a server that answers 401 to both, which is a
    // console that still authenticates — the thing this case exists to refuse.
    if (bare.status !== want) throw new Error(`credential-free ${path}: ${bare.status}, want ${want}`);
    if (want === 200) ownAnswer(path, bare.body);
    // §7.3: the legacy query is ignored, so the answer does not change.
    if (legacy.status !== bare.status || legacy.body !== bare.body) {
      throw new Error(`legacy ?token= changed the answer for ${path}: ${legacy.status} vs ${bare.status}`);
    }
  }

  // The SSE route by handshake only: its frames and heartbeats differ between
  // two connections and it may answer 503 at the cap, so equality is on the
  // head alone.
  const streamBare = await httpHandshake(port, '/api/stream');
  const streamLegacy = await httpHandshake(port, withToken('/api/stream'));
  forbidden(streamBare, 'credential-free /api/stream');
  forbidden(streamLegacy, 'legacy-token /api/stream');
  if (streamBare.status !== 200) throw new Error(`credential-free /api/stream handshake: ${streamBare.status}`);
  if (streamLegacy.status !== streamBare.status || streamLegacy.headers['content-type'] !== streamBare.headers['content-type']) {
    throw new Error(`legacy ?token= changed the /api/stream handshake: ${streamLegacy.status} vs ${streamBare.status}`);
  }

  // The second-order path §7.4 defends: a JSON route must not be pullable
  // cross-origin through <script src>, so the API surface serves only these
  // two media types and honours no callback projection.
  for (const path of apiRoutes) {
    const res = await http(port, path);
    const type = String(res.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json') throw new Error(`${path} serves ${String(type)}, not application/json`);
    for (const parameter of ['callback', 'jsonp']) {
      const variant = await http(port, `${path}${path.includes('?') ? '&' : '?'}${parameter}=cb`);
      // What §7.4 forbids is honouring the parameter, not answering it: a
      // route may equally reject it with an ordinary error. Both are fine;
      // wrapping the body in a call is not, and neither is losing the header
      // and media-type guarantees on the variant response.
      forbidden(variant, `${parameter}-bearing ${path}`);
      const variantType = String(variant.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
      if (variantType !== 'application/json') throw new Error(`${path} served ${String(variantType)} for ?${parameter}=`);
      if (/^\s*[\w$.]+\s*\(/.test(variant.body)) throw new Error(`${path} wrapped its body in a call for ?${parameter}=`);
    }
  }
  const streamType = String(streamBare.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (streamType !== 'text/event-stream') throw new Error(`/api/stream serves ${String(streamType)}`);
  return { status: 'pass', evidence: { routesWalked: okRoutes.length + errorRoutes.length + 1, legacyTokenWasValid: typeof manifest['token'] === 'string', mediaTypes: ['application/json', 'text/event-stream'] } };
});

// CONSOLE-045 (ADR 0032): there is no credential, so every registered route
// answers, and nothing anywhere answers 401 — including a non-GET, which must
// still be the 405 the read-only table gives it.
await record('CONSOLE-045', 'credential-free access to every registered route, and no 401 anywhere', async (): Promise<CaseOutcome> => {
  const ctx = await startPlugin({ console: { enabled: true } });
  const { port } = ctx;
  const created = await ctx.plugin.invoke('session_create', { engine: SIMULATED_ENGINES[0], cwd: ctx.workRoot });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  const sessionId = created.output.sessionId;
  await runTurn(ctx.plugin, sessionId, 'console-045');
  const encoded = encodeURIComponent(sessionId);

  // Every registered route's own answer, not merely "not 401": a server that
  // opened up one path would otherwise pass.
  const expectations: Array<{ path: string; want: number; expect?: (body: string) => void }> = [
    { path: '/', want: 200, expect: (body) => { if (!body.includes('<script src="/app.js"')) throw new Error('/ did not serve the UI'); } },
    // Compared against the assets this build embeds rather than against a
    // guess at their size or contents: a length threshold or a search for the
    // word `function` would reject a valid minified asset, which is a rule
    // invented by the case rather than taken from the design.
    { path: '/app.css', want: 200, expect: (body) => { if (body !== UI_APP_CSS) throw new Error('/app.css is not the embedded stylesheet'); } },
    { path: '/app.js', want: 200, expect: (body) => { if (body !== UI_APP_JS) throw new Error('/app.js is not the embedded script'); } },
    { path: '/fonts/PTMono-Regular.woff2', want: 200, expect: (body) => { if (Buffer.byteLength(body, 'binary') === 0) throw new Error('the font asset was empty'); } },
    { path: '/api/instance', want: 200, expect: (body) => { JSON.parse(body) as { instanceId: string }; } },
    { path: '/api/sessions', want: 200, expect: (body) => { if ((JSON.parse(body) as { sessions: unknown[] }).sessions.length === 0) throw new Error('/api/sessions was empty'); } },
    { path: '/api/turns', want: 200, expect: (body) => { if ((JSON.parse(body) as { turns: unknown[] }).turns.length === 0) throw new Error('/api/turns was empty'); } },
    { path: '/api/interactions', want: 200, expect: (body) => { if (!Array.isArray((JSON.parse(body) as { interactions: unknown[] }).interactions)) throw new Error('/api/interactions has no interactions array'); } },
    { path: '/api/topology', want: 200, expect: (body) => { if (!Array.isArray((JSON.parse(body) as { nodes?: unknown[] }).nodes)) throw new Error('/api/topology has no nodes array'); } },
    { path: `/api/sessions/${encoded}`, want: 200, expect: (body) => { if ((JSON.parse(body) as { sessionId?: string }).sessionId !== sessionId) throw new Error('session detail is a different session'); } },
    { path: `/api/sessions/${encoded}/events?afterSeq=0`, want: 200, expect: (body) => { if ((JSON.parse(body) as { events: unknown[] }).events.length === 0) throw new Error('events page was empty'); } },
    { path: `/api/sessions/${encoded}/diffs?afterSeq=0`, want: 200, expect: (body) => { JSON.parse(body) as Record<string, unknown>; } },
    // Selected credential-free error fixtures: 413 and 500 need contrived
    // state and add nothing to the credential question. Their bodies are
    // asserted too — an error answered with the wrong code's body is the kind
    // of thing a status-only walk never notices.
    { path: '/nope', want: 404, expect: (body) => { if (body !== '{"error":"not_found"}') throw new Error(`/nope body: ${body}`); } },
    { path: '/api/sessions/missing-session', want: 404, expect: (body) => { if (body !== '{"error":"not_found"}') throw new Error(`missing session body: ${body}`); } },
    { path: `/api/sessions/${encoded}/events?afterSeq=0x10`, want: 400, expect: (body) => { if (body !== '{"error":"invalid_argument"}') throw new Error(`malformed cursor body: ${body}`); } },
  ];
  for (const { path, want, expect } of expectations) {
    const res = await http(port, path);
    if (res.status === 401) throw new Error(`${path} answered 401`);
    if (res.status !== want) throw new Error(`${path}: ${res.status}, want ${want}`);
    expect?.(res.body);
  }
  const stream = await httpHandshake(port, '/api/stream');
  if (stream.status !== 200) throw new Error(`/api/stream handshake: ${stream.status}`);

  // Without this half a leftover credential check could keep answering 401 to
  // non-GET while every GET above passes.
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await http(port, '/api/sessions', { method });
    if (res.status !== 405 || res.headers['allow'] !== 'GET') throw new Error(`${method}: ${res.status} allow=${String(res.headers['allow'])}`);
  }
  return { status: 'pass', evidence: { routes: expectations.length + 1, nonGetMethods: 4, unauthorizedResponses: 0 } };
});

// CONSOLE-046 (ADR 0032): legacy-manifest tolerance. There is no
// rewrite-in-place migration to test — every start mints a new instance
// directory and writes a fresh manifest — so the path is the mixed-version
// one: a live OLD listener whose manifest carries a token, read by a NEW
// console open.
await record('CONSOLE-046', 'a legacy token-bearing console.json is parsed, probed, and refused legibly', async (): Promise<CaseOutcome> => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-console-legacy-'));
  cleanups.push(async () => { await rm(dataRoot, { recursive: true, force: true }); });

  // A genuinely pre-upgrade server, not this build with a rewritten manifest:
  // after the change a real listener answers /api/instance with its own id and
  // would be opened, so a case built that way could never pass.
  const legacy = await legacyConsole();
  const instanceId = '99999999-9999-4999-8999-999999999999';
  const manager = await InstanceManager.create({ dataRoot, instanceId, rootNonce: 'c'.repeat(32), pid: process.pid });
  cleanups.push(async () => { await manager.close(); });
  await writeFile(join(manager.instanceDir, 'console.json'),
    JSON.stringify({ port: legacy.port, token: 'a'.repeat(32), startedAt: '2026-01-01T00:00:00.000Z' }) + '\n', { mode: 0o600 });

  // In-process with the opener stubbed, never runLaunchSubcommand: that spawns
  // the production opener, and against a pre-upgrade listener the old probe
  // *succeeds*, so a gate written that way opens a real browser tab on the
  // machine running it. Observing that no browser launches is also half of
  // what this case asserts, and a spawned CLI cannot show it.
  const launched: string[] = [];
  const lines: string[] = [];
  const result = await runConsoleOpen({
    dataRoot,
    instance: instanceId,
    opener: async (url) => { launched.push(url); },
    out: (line) => lines.push(line),
  });

  // `exitCode` is a literal 1 on this variant, so the type already carries what
  // a runtime check would assert; narrowing on `kind` is the whole test.
  if (result.kind !== 'not-listening') throw new Error(`console open returned ${result.kind} against a pre-upgrade listener`);
  if (launched.length > 0) throw new Error(`a browser was launched at ${launched.join(', ')}`);

  // The assertion that separates a reader which TOLERATES the legacy field
  // from one which REJECTS it. Both end at not-listening with the same exit
  // code, so the verdict proves nothing; only a probe actually issued does.
  const probed = legacy.requests.filter((request) => request.path === '/api/instance');
  if (probed.length !== 1) {
    throw new Error(`want exactly one probe of /api/instance, saw ${probed.length}; all paths: ${JSON.stringify(legacy.requests.map((request) => request.path))}`);
  }
  const probe = probed[0]!;
  if (probe.method !== 'GET') throw new Error(`probe used ${probe.method}, not GET`);
  if (probe.host !== `127.0.0.1:${legacy.port}`) throw new Error(`probe used the wrong authority: ${probe.host}`);
  if (probe.credentials.length > 0) throw new Error(`probe presented credentials: ${probe.credentials.join(', ')}`);
  const reported = lines.join(' ');
  if (!reported.includes(String(legacy.port))) throw new Error(`refusal named no port: ${reported}`);
  if (/malformed|invalid|unexpected/i.test(reported)) throw new Error(`legacy manifest was rejected rather than parsed: ${reported}`);
  return { status: 'pass', evidence: { kind: result.kind, browsersLaunched: launched.length, probeRequests: probed.length, reported: lines.at(-1) ?? '' } };
});

await drainCleanups();


// CONSOLE-022..025 (§5.7, ADR 0006, narrowed by ADR 0010): folding is a
// client-side presentation layer *on the default path*. The default wire must
// stay verbatim, the oversized reference must stay out of the folder, degraded
// mode must not fold, and the bundle that carries the folder must remain
// self-contained under `script-src 'self'`. ADR 0010 permits an explicit
// `projection=folded`; it shipped with its own cases (CONSOLE-026..029 below)
// rather than loosening this one, which is why the title says which path it
// guards.
await record('CONSOLE-022', 'the default path stays verbatim: no folded shapes leave the server unasked', async (): Promise<CaseOutcome> => {
  const ctx = await startPlugin({ console: { enabled: true } });
  const { plugin, port } = ctx;
  const created = await plugin.invoke('session_create', { engine: 'kimi', cwd: ctx.workRoot });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  const sessionId = created.output.sessionId;
  const stream = openSse(port, `/api/stream?sessionId=${sessionId}`);
  await stream.ready;
  await runTurn(plugin, sessionId, 'verbatim wire check');
  await waitFor(() => stream.frames.some((frame) => frame.data['type'] === 'event'), 15_000, 'session event frames');

  // A folded response could not answer nextSeq honestly, and would carry
  // presentation shapes instead of ACP updates. Both are checked directly.
  const page = JSON.parse((await http(port, `/api/sessions/${sessionId}/events?afterSeq=0`)).body) as
    { events?: Record<string, unknown>[]; nextSeq?: number };
  const events = page.events ?? [];
  if (events.length === 0) throw new Error('no events to inspect');
  const chunks = events.filter((event) => String((event['update'] as { sessionUpdate?: unknown } | undefined)?.sessionUpdate ?? '').endsWith('_chunk'));
  if (chunks.length === 0) throw new Error('no verbatim chunk events — the server may be folding');
  if (typeof page.nextSeq !== 'number') throw new Error('the page lost its seq cursor');
  for (const frame of stream.frames) {
    if (['messageStart', 'messageAppend', 'toolRow', 'planState'].includes(String(frame.data['type']))) {
      throw new Error(`SSE carried a folded frame: ${String(frame.data['type'])}`);
    }
  }
  stream.close();
  return { status: 'pass', evidence: { events: events.length, verbatimChunks: chunks.length, nextSeq: page.nextSeq } };
});

await record('CONSOLE-023', 'the UI routes event_ref around the folder', async (): Promise<CaseOutcome> => {
  // Source-pinned: driving a browser is out of scope for this gate, so the
  // assertion is on the bundle's structure. Frames now queue and flush in
  // batches, so the invariant pins the feed itself rather than a marker region:
  // exactly one folder feed exists in the bundle, and the event_ref branch of
  // the same flush loop continues past it — the oversized reference cannot
  // reach the folder, and the open run is still closed first, which is what
  // keeps the gap honest instead of a sentence spliced in half.
  const feeds = UI_APP_JS.split('.folder.push(').length - 1;
  if (feeds !== 1) throw new Error(`expected exactly one folder feed in the bundle, found ${feeds}`);
  const feed = UI_APP_JS.indexOf('.folder.push(');
  const before = UI_APP_JS.slice(Math.max(0, feed - 600), feed);
  const steer = before.lastIndexOf('event_ref');
  if (steer < 0) throw new Error('event_ref handling is absent from the flush path');
  if (!before.slice(steer).includes('continue')) throw new Error('event_ref no longer skips the folder feed');
  return { status: 'pass', evidence: { assertion: 'source-level', reason: 'a headless browser is out of scope for this gate' } };
});

await record('CONSOLE-024', 'degraded mode has nothing to fold and renders envelopes', async (): Promise<CaseOutcome> => {
  const ctx = await startPlugin({ console: { enabled: true, exposeTranscripts: false } });
  const { plugin, port } = ctx;
  const created = await plugin.invoke('session_create', { engine: 'kimi', cwd: ctx.workRoot });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  const sessionId = created.output.sessionId;
  await runTurn(plugin, sessionId, 'degraded fold check');
  const page = JSON.parse((await http(port, `/api/sessions/${sessionId}/events?afterSeq=0`)).body) as
    { events?: Record<string, unknown>[] };
  const events = page.events ?? [];
  if (events.length === 0) throw new Error('no events to inspect');
  for (const event of events) {
    for (const key of Object.keys(event)) {
      if (!['seq', 'ts', 'byteLen'].includes(key)) throw new Error(`degraded event carried ${key}`);
    }
  }
  return { status: 'pass', evidence: { events: events.length, keys: 'seq/ts/byteLen' } };
});

await record('CONSOLE-025', 'the UI bundle is self-contained, CSP-clean and carries the folder', async (): Promise<CaseOutcome> => {
  for (const forbidden of ['eval(', 'new Function(', '//# sourceMappingURL']) {
    if (UI_APP_JS.includes(forbidden)) throw new Error(`bundle contains ${forbidden}, forbidden under script-src 'self'`);
  }
  // Same exclusion the artifact gate already makes: the SVG namespace is an XML
  // identifier, never fetched. Reinventing this check more crudely is how the
  // first version of this case failed on the topology view's own markup.
  const stripped = UI_APP_JS.replaceAll('http://www.w3.org/2000/svg', '');
  if (/https?:\/\//iu.test(stripped)) throw new Error('bundle references an external host');
  // Without the folder the UI would render nothing folded, and CONSOLE-022
  // would still pass — so the bundle has to be shown to contain it.
  for (const symbol of ['messageStart', 'toolRow']) {
    if (!UI_APP_JS.includes(symbol)) throw new Error(`runskein/fold is not bundled: ${symbol} missing`);
  }
  return { status: 'pass', evidence: { bytes: UI_APP_JS.length, foldBundled: true } };
});

// CONSOLE-026..029 (console-v2 §3, ADR 0010): the opt-in projection and the
// diff index route. 026 is the mutual-inference assertion the ADR's
// Consequences demand — fold(raw) === merge(folded pages) over a real session
// that actually paginates; the reference side re-folds the raw wire events
// through the same RunAssembler the server uses, because what this guards is
// interval splitting and watermark semantics, not two implementations
// (constraint 2 makes "two implementations" impossible by construction).
// 027/028 declare each new route's degraded behavior in the projection itself
// (constraint 3); 029 shows preview truncation is what the byte budget
// accounts (constraint 6).
await record('CONSOLE-026', 'fold(raw) equals merge(folded pages): run intervals and watermark semantics', async (): Promise<CaseOutcome> => {
  const ctx = await startPlugin({ console: { enabled: true }, engineEnv: { kimi: { RUNSKEIN_TESTKIT_THOUGHT: '1', RUNSKEIN_TESTKIT_TOOL_CALL: '1', RUNSKEIN_TESTKIT_ECHO_PROMPT: '1' } } });
  const { plugin, port } = ctx;
  const created = await plugin.invoke('session_create', { engine: 'kimi', cwd: ctx.workRoot });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  const sessionId = created.output.sessionId;
  // The 100-event page limit must actually cut, otherwise the page seam this
  // case exists for went untested. The scripted agent emits a handful of
  // events per turn, so this drives turns until the watermark passes it.
  let highWatermark = 0;
  for (let turn = 0; turn < 60 && highWatermark <= 100; turn += 1) {
    await runTurn(plugin, sessionId, `mutual-inference turn ${turn}`);
    const head = JSON.parse((await http(port, `/api/sessions/${sessionId}/events?afterSeq=0&toSeq=0`)).body) as { highWatermark: number };
    highWatermark = head.highWatermark;
  }
  if (highWatermark <= 100) throw new Error(`transcript too short to force paging: ${highWatermark}`);

  // The raw projection, paged to the watermark.
  const rawEvents: Record<string, unknown>[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = JSON.parse((await http(port, `/api/sessions/${sessionId}/events?afterSeq=${afterSeq}`)).body) as
      { events: Record<string, unknown>[]; nextSeq: number; hasMore: boolean };
    rawEvents.push(...page.events);
    if (!page.hasMore) break;
    afterSeq = page.nextSeq - 1;
    if (rawEvents.length > 100_000) throw new Error('raw pagination did not converge');
  }
  if (rawEvents.length !== highWatermark) throw new Error(`raw pages gave ${rawEvents.length} events, watermark says ${highWatermark}`);

  // The folded projection, paged by the same event cursor. Every run interval
  // must lie inside this page's slice of the raw range (§3.2 rule 2).
  const pages: GateRun[][] = [];
  afterSeq = 0;
  for (;;) {
    const page = JSON.parse((await http(port, `/api/sessions/${sessionId}/events?afterSeq=${afterSeq}&projection=folded`)).body) as
      { runs: GateRun[]; nextSeq: number; highWatermark: number; hasMore: boolean };
    for (const run of page.runs) {
      if (run.seqFrom < afterSeq + 1) throw new Error(`run seqFrom ${run.seqFrom} predates the cursor ${afterSeq}`);
      if (run.seqFrom > run.seqTo) throw new Error(`inverted run interval ${run.seqFrom}..${run.seqTo}`);
      if (run.seqTo > page.highWatermark) throw new Error(`run seqTo ${run.seqTo} past the watermark ${page.highWatermark}`);
    }
    pages.push(page.runs);
    if (!page.hasMore) break;
    afterSeq = page.nextSeq - 1;
    if (pages.length > 500) throw new Error('folded pagination did not converge');
  }
  if (pages.length < 2) throw new Error('the folded projection never paginated — the seam went untested');

  // The reference side: the same assembler over the whole raw stream, unpaged.
  // Its trailing fragment carries `openEnd` too when the transcript ends
  // mid-message — the same page artifact the merge strips, so strip it here as
  // well; the flags are the seam mechanism, never part of the folded value.
  const assembler = new RunAssembler();
  for (const event of rawEvents) assembler.pushEvent(event as unknown as TranscriptEvent);
  assembler.finish();
  const reference = JSON.parse(JSON.stringify(assembler.runs)) as GateRun[];
  for (const run of reference) {
    delete run['openStart'];
    delete run['openEnd'];
  }
  const merged = mergeFoldedPages(pages);
  if (canonicalJson(merged) !== canonicalJson(reference)) {
    throw new Error(`fold(raw) !== merge(folded pages): ${merged.length} merged runs vs ${reference.length} reference runs`);
  }
  // Natural 100-event paging cuts wherever the turn script happens to put the
  // boundary, so the seam merge can go unexercised while the case still
  // passes. Force a boundary that lands INSIDE a folded run: between a
  // tool_call and the tool_call_update that completes it. Page two then folds
  // a partial row for a call it never saw opened, and the merge has to join
  // the halves by toolCallId; break that and the equality below fails.
  //
  // The message-fragment seam is not reachable through this engine — the
  // scripted agent emits one chunk per message, so no message spans two
  // events and none can straddle a page. That seam, and the openEnd/openStart
  // flags that carry it, are asserted against a multi-chunk fixture in
  // test/console/folded-projection.test.ts, with both flags negative-tested.
  const seamAt = ((): number | undefined => {
    for (let i = 0; i + 1 < rawEvents.length; i += 1) {
      const here = rawEvents[i]!['update'] as { sessionUpdate?: unknown; toolCallId?: unknown };
      const next = rawEvents[i + 1]!['update'] as { sessionUpdate?: unknown; toolCallId?: unknown };
      if (here?.sessionUpdate === 'tool_call' && next?.sessionUpdate === 'tool_call_update' && here.toolCallId === next.toolCallId) {
        return rawEvents[i]!['seq'] as number;
      }
    }
    return undefined;
  })();
  if (seamAt === undefined) throw new Error('no tool call split across two events — the seam cannot be exercised');
  const head = new RunAssembler();
  for (const event of rawEvents) {
    if ((event['seq'] as number) > seamAt) break;
    head.pushEvent(event as unknown as TranscriptEvent);
  }
  head.finish();
  const headRuns = JSON.parse(JSON.stringify(head.runs)) as GateRun[];
  const tailPages: GateRun[][] = [];
  afterSeq = seamAt;
  for (;;) {
    const page = JSON.parse((await http(port, `/api/sessions/${sessionId}/events?afterSeq=${afterSeq}&projection=folded`)).body) as
      { runs: GateRun[]; nextSeq: number; hasMore: boolean };
    tailPages.push(page.runs);
    if (!page.hasMore) break;
    afterSeq = page.nextSeq - 1;
    if (tailPages.length > 500) throw new Error('folded pagination did not converge from the forced seam');
  }
  const seamMerged = mergeFoldedPages([headRuns, ...tailPages]);
  if (canonicalJson(seamMerged) !== canonicalJson(reference)) {
    throw new Error(`fold(raw) !== merge across a forced seam at ${seamAt}: ${seamMerged.length} vs ${reference.length} runs`);
  }
  return { status: 'pass', evidence: { events: rawEvents.length, foldedPages: pages.length, runs: reference.length, forcedSeam: seamAt } };
});

await record('CONSOLE-027', 'degraded folded projection is the raw envelope page: no folded shapes, no event bytes', async (): Promise<CaseOutcome> => {
  const ctx = await startPlugin({ console: { enabled: true, exposeTranscripts: false }, engineEnv: { kimi: { RUNSKEIN_TESTKIT_THOUGHT: '1' } } });
  const { plugin, port } = ctx;
  const created = await plugin.invoke('session_create', { engine: 'kimi', cwd: ctx.workRoot });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  const sessionId = created.output.sessionId;
  await runTurn(plugin, sessionId, 'degraded folded projection check');
  const res = await http(port, `/api/sessions/${sessionId}/events?afterSeq=0&projection=folded`);
  if (res.status !== 200) throw new Error(`folded under degraded mode: ${res.status}`);
  // The scripted turn's thought text and the prompt are the event bodies that
  // must not leave, whatever shape the response takes.
  if (res.body.includes('thinking') || res.body.includes('degraded folded projection check')) {
    throw new Error('an event body left through the folded projection in degraded mode');
  }
  const page = JSON.parse(res.body) as { runs?: unknown; events?: Record<string, unknown>[] };
  if (page.runs !== undefined) throw new Error('degraded mode served folded runs');
  const events = page.events ?? [];
  if (events.length === 0) throw new Error('no events to inspect');
  for (const event of events) {
    for (const key of Object.keys(event)) {
      if (!['seq', 'ts', 'byteLen'].includes(key)) throw new Error(`degraded folded event carried ${key}`);
    }
  }
  return { status: 'pass', evidence: { events: events.length, keys: 'seq/ts/byteLen', runs: 'absent' } };
});

await record('CONSOLE-028', 'degraded diff index is the empty index: no path or tool bytes leave', async (): Promise<CaseOutcome> => {
  const ctx = await startPlugin({ console: { enabled: true, exposeTranscripts: false }, engineEnv: { kimi: { RUNSKEIN_TESTKIT_TOOL_CALL: '1' } } });
  const { plugin, port } = ctx;
  const created = await plugin.invoke('session_create', { engine: 'kimi', cwd: ctx.workRoot });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  const sessionId = created.output.sessionId;
  await runTurn(plugin, sessionId, 'degraded diff index check');
  // An empty index only means something when the transcript HAS a diff to
  // withhold. The scripted agent emits tool calls but no diff content, so the
  // check that keeps this case honest cannot be satisfied here, and passing on
  // an index that is empty for the wrong reason would be worse than not
  // running: it would read as evidence.
  const transcript = await plugin.invoke('transcript_read', { sessionId, afterSeq: 0 });
  if (!transcript.ok) throw new Error(`transcript_read failed: ${transcript.error.code}`);
  const hasDiff = transcript.output.events.some((event) => {
    const content = (event.update as Record<string, unknown>)['content'];
    return Array.isArray(content) && content.some((item) => (item as { type?: unknown } | null)?.type === 'diff');
  });
  const res = await http(port, `/api/sessions/${sessionId}/diffs`);
  if (res.status !== 200) throw new Error(`diffs under degraded mode: ${res.status}`);
  const body = JSON.parse(res.body) as { diffs: unknown[]; highWatermark: number };
  if (body.diffs.length !== 0) throw new Error('degraded mode served diff index entries');
  if (body.highWatermark === 0) throw new Error('the transcript has events but the watermark says none');
  if (!hasDiff) {
    return {
      status: 'na',
      reason: 'the scripted agent emits no diff content, so an empty index here proves nothing about degradation; '
        + 'the degraded projection is asserted against a constructed diff in test/console/diff-index.test.ts, and this '
        + 'case needs an engine that reports diffs',
      evidence: { diffs: 0, highWatermark: body.highWatermark, transcriptHadDiff: false },
    };
  }
  if (res.body.includes('/tmp/') || res.body.includes('write-file')) throw new Error('diff index bytes left in degraded mode');
  return { status: 'pass', evidence: { diffs: 0, highWatermark: body.highWatermark, transcriptHadDiff: true } };
});

await record('CONSOLE-029', 'preview truncation counts toward the byte budget: long text leaves as preview only', async (): Promise<CaseOutcome> => {
  // The scripted agent's thought toggle is fixed-length; the long text runs
  // through RUNSKEIN_TESTKIT_ECHO_PROMPT instead — the same preview path (§3.2 truncates
  // thought and message runs alike).
  const marker = 'L'.repeat(4_000);
  const ctx = await startPlugin({ console: { enabled: true }, engineEnv: { kimi: { RUNSKEIN_TESTKIT_ECHO_PROMPT: '1' } } });
  const { plugin, port } = ctx;
  const created = await plugin.invoke('session_create', { engine: 'kimi', cwd: ctx.workRoot });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  const sessionId = created.output.sessionId;
  await runTurn(plugin, sessionId, marker);

  const folded = await http(port, `/api/sessions/${sessionId}/events?afterSeq=0&projection=folded`);
  if (folded.status !== 200) throw new Error(`folded page: ${folded.status}`);
  const page = JSON.parse(folded.body) as { runs: GateRun[]; hasMore: boolean };
  const echoed = page.runs.find((run) => run.kind === 'agent' && run['truncated'] === true);
  if (echoed === undefined) throw new Error('no truncated run for the long echo');
  if (echoed['preview'] !== marker.slice(0, PREVIEW_LIMIT)) throw new Error('the preview is not the first PREVIEW_LIMIT chars');
  if (echoed['fullBytes'] !== Buffer.byteLength(marker, 'utf8')) throw new Error(`fullBytes ${String(echoed['fullBytes'])}`);
  if ('text' in echoed) throw new Error('a truncated run still carries the full text');
  if (folded.body.includes(marker)) throw new Error('the full text left in the folded page');

  // The page the client actually received is bounded by the byte budget (the
  // server answers 413 otherwise — a 200 already proves the whole-page
  // re-check passed) and truncation is what keeps it small: the raw page over
  // the same range carries the full text.
  const raw = await http(port, `/api/sessions/${sessionId}/events?afterSeq=0`);
  if (raw.status !== 200 || !raw.body.includes(marker)) throw new Error('the raw page lost the full text');
  const foldedBytes = Buffer.byteLength(folded.body, 'utf8');
  const rawBytes = Buffer.byteLength(raw.body, 'utf8');
  if (foldedBytes >= rawBytes) throw new Error(`truncation saved no bytes: folded ${foldedBytes} vs raw ${rawBytes}`);
  if (foldedBytes > 1_048_576) throw new Error('the folded page exceeds the default response byte budget');

  // The expansion path (§3.2): the raw projection over the run's own interval
  // recomposes the truncated text.
  const slice = JSON.parse((await http(port, `/api/sessions/${sessionId}/events?afterSeq=${echoed.seqFrom - 1}&toSeq=${echoed.seqTo}`)).body) as
    { events: Array<{ update: { content?: { text?: string } } }> };
  const recomposed = slice.events.map((event) => event.update.content?.text ?? '').join('');
  if (recomposed !== marker) throw new Error('the raw interval did not recompose the truncated text');
  return { status: 'pass', evidence: { fullBytes: echoed['fullBytes'], previewLimit: PREVIEW_LIMIT, foldedBytes, rawBytes } };
});

// CONSOLE-030 (ADR 0019): init start boots the embedded server and writes the
// same manifest as a boot-time start; with a console already up, project_init
// reports 'already-running'.
await record('CONSOLE-030', 'init start boots the console; repeat init reports already-running', async (): Promise<CaseOutcome> => {
  const ctx = await startPlugin();
  const first = await ctx.plugin.invoke('project_init', {});
  if (!first.ok) throw new Error(`project_init failed: ${first.error.code}`);
  const port = first.output.console.port;
  if (first.output.console.state !== 'started' || port === undefined || port <= 0) {
    throw new Error(`console state: ${JSON.stringify(first.output.console)}`);
  }
  // Same manifest discipline as boot-time start: console.json names the port
  // the server actually bound.
  const manifest = JSON.parse(await readFile(consoleJsonPath(ctx.dataRoot, ctx.plugin.runtime.instanceId), 'utf8')) as { port: number };
  if (manifest.port !== port) throw new Error(`manifest port ${manifest.port} != reported ${port}`);
  const second = await ctx.plugin.invoke('project_init', {});
  if (!second.ok) throw new Error(`repeat project_init failed: ${second.error.code}`);
  if (second.output.console.state !== 'already-running' || second.output.console.port !== port) {
    throw new Error(`repeat console state: ${JSON.stringify(second.output.console)}`);
  }
  // An occupied explicit port reports start-failed with a log event rather
  // than lying, and the file result stands.
  const blocker = createNetServer();
  await new Promise<void>((resolveListen) => blocker.listen(0, '127.0.0.1', resolveListen));
  const address = blocker.address();
  if (address === null || typeof address === 'string') throw new Error('blocker has no port');
  const occupied = address.port;
  const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-console-gate-'));
  const workRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-console-work-'));
  const sink: LogRecord[] = [];
  const failing = createTaskShuttleServer({
    dataRoot,
    env: {
      REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [workRoot], console: { enabled: false, port: occupied } }),
      REALM_PLUGIN_LOG: 'off',
      REALM_PLUGIN_DEFAULTS_TEMPLATE: DEFAULTS_TEMPLATE,
    } as NodeJS.ProcessEnv,
    hostCwd: workRoot,
    hubFactory: simulatedHubFactory(),
    logSink: (entry) => { sink.push(entry); },
  });
  cleanups.push(async () => {
    await failing.close().catch(() => undefined);
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workRoot, { recursive: true, force: true });
    await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
  });
  await failing.runtime.ready;
  const failed = await failing.invoke('project_init', {});
  if (!failed.ok) throw new Error(`project_init on an occupied port failed: ${failed.error.code}`);
  if (failed.output.console.state !== 'start-failed' || 'port' in failed.output.console) {
    throw new Error(`occupied-port console state: ${JSON.stringify(failed.output.console)}`);
  }
  if (!failed.output.created) throw new Error('file side did not complete');
  if (!sink.some((entry) => entry.event === 'console_start_failed' && entry.errorCode === 'INVALID_ARGUMENT')) {
    throw new Error('no console_start_failed log event');
  }
  return { status: 'pass', evidence: { port, repeat: second.output.console.state, occupiedPort: failed.output.console.state } };
});

// CONSOLE-031 (ADR 0019, widened by ADR 0031): the five console states of the
// init output, and ADR 0019 clause 3's surviving disclosure bound.
await record('CONSOLE-031', 'console states: started, already-running, start-failed, disabled, withheld; output carries only the status word and the port', async (): Promise<CaseOutcome> => {
  const startedCtx = await startPlugin();
  const started = await startedCtx.plugin.invoke('project_init', {});
  if (!started.ok) throw new Error(`project_init failed: ${started.error.code}`);
  if (started.output.console.state !== 'started' || started.output.console.port === undefined) {
    throw new Error(`started state: ${JSON.stringify(started.output.console)}`);
  }

  const runningCtx = await startPlugin({ console: { enabled: true } });
  const running = await runningCtx.plugin.invoke('project_init', {});
  if (!running.ok) throw new Error(`project_init failed: ${running.error.code}`);
  if (running.output.console.state !== 'already-running' || running.output.console.port !== runningCtx.port) {
    throw new Error(`already-running state: ${JSON.stringify(running.output.console)}`);
  }

  const blocker = createNetServer();
  await new Promise<void>((resolveListen) => blocker.listen(0, '127.0.0.1', resolveListen));
  const address = blocker.address();
  if (address === null || typeof address === 'string') throw new Error('blocker has no port');
  cleanups.push(async () => {
    await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
  });
  const failingCtx = await startPlugin({ console: { enabled: false, port: address.port }, expectManifest: false });
  const failed = await failingCtx.plugin.invoke('project_init', {});
  if (!failed.ok) throw new Error(`project_init failed: ${failed.error.code}`);
  if (failed.output.console.state !== 'start-failed' || 'port' in failed.output.console) {
    throw new Error(`start-failed state: ${JSON.stringify(failed.output.console)}`);
  }
  // The file side succeeded — the file result stands.
  if (!failed.output.created || failed.output.content.length === 0) throw new Error('file result did not stand');

  const disabledCtx = await startPlugin({ console: { allowInitStart: false } });
  const disabled = await disabledCtx.plugin.invoke('project_init', {});
  if (!disabled.ok) throw new Error(`project_init failed: ${disabled.error.code}`);
  if (disabled.output.console.state !== 'disabled' || 'port' in disabled.output.console) {
    throw new Error(`disabled state: ${JSON.stringify(disabled.output.console)}`);
  }
  if (existsSync(consoleJsonPath(disabledCtx.dataRoot, disabledCtx.plugin.runtime.instanceId))) throw new Error('console.json written while disabled');

  // `withheld` (ADR 0031): an instance that cannot establish it is a root has
  // not failed at anything — the call is not refused, the file side completes,
  // and the state names the verdict instead of inventing a failure.
  const withheldCtx = await startPlugin({ console: { enabled: false }, delegation: { provenance: 'unavailable' }, expectManifest: false });
  const withheld = await withheldCtx.plugin.invoke('project_init', {});
  if (!withheld.ok) throw new Error(`project_init failed on unavailable: ${withheld.error.code}`);
  if (withheld.output.console.state !== 'withheld' || 'port' in withheld.output.console) {
    throw new Error(`withheld state: ${JSON.stringify(withheld.output.console)}`);
  }
  if (!withheld.output.created || withheld.output.content.length === 0) throw new Error('the file side did not survive the withholding');
  if (!withheldCtx.logs.some((entry) => entry.event === 'console_withheld' && entry.provenance === 'unavailable')) {
    throw new Error('no console_withheld event behind the withheld state');
  }
  if (existsSync(consoleJsonPath(withheldCtx.dataRoot, withheldCtx.plugin.runtime.instanceId))) throw new Error('console.json written while withheld');

  // ADR 0019 clause 3's surviving half (§11): the console block discloses the
  // status word and the loopback port and nothing else. The token half went
  // with the token (ADR 0032), so what remains is a whitelist on the keys —
  // asserted rather than assumed, since the block is where a future field
  // would land unnoticed.
  for (const output of [started.output, running.output]) {
    const keys = Object.keys(output.console).sort();
    if (keys.join(',') !== 'port,state') throw new Error(`console block carries more than state and port: ${keys.join(',')}`);
  }
  return { status: 'pass', evidence: { states: [started.output.console.state, running.output.console.state, failed.output.console.state, disabled.output.console.state] } };
});

// CONSOLE-032 (ADR 0019, precedence widened by ADR 0031): init start ignores
// `enabled`, honours `allowInitStart`, and is refused outright on a delegated
// verdict — marker or ancestry alike. The pairs where two conditions hold at
// once are asserted here rather than left to the reading order of the code.
await record('CONSOLE-032', 'init start ignores enabled, honours allowInitStart, refused when delegated; precedence pairs pinned', async (): Promise<CaseOutcome> => {
  const ignoredCtx = await startPlugin({ console: { enabled: false } });
  const ignored = await ignoredCtx.plugin.invoke('project_init', {});
  if (!ignored.ok) throw new Error(`project_init failed: ${ignored.error.code}`);
  if (ignored.output.console.state !== 'started') throw new Error(`enabled:false gave ${ignored.output.console.state}`);

  const refusedCtx = await startPlugin({ console: { allowInitStart: false } });
  const refused = await refusedCtx.plugin.invoke('project_init', {});
  if (!refused.ok) throw new Error(`project_init failed: ${refused.error.code}`);
  if (refused.output.console.state !== 'disabled' || 'port' in refused.output.console) {
    throw new Error(`allowInitStart:false gave ${JSON.stringify(refused.output.console)}`);
  }
  if (existsSync(consoleJsonPath(refusedCtx.dataRoot, refusedCtx.plugin.runtime.instanceId))) throw new Error('console.json written while disabled');

  // Pair: a listener already running WITH the veto — `already-running` outranks
  // it, because the veto governs this start, not whether a console exists.
  const runningVetoCtx = await startPlugin({ console: { enabled: true, allowInitStart: false } });
  const runningVeto = await runningVetoCtx.plugin.invoke('project_init', {});
  if (!runningVeto.ok) throw new Error(`project_init failed: ${runningVeto.error.code}`);
  if (runningVeto.output.console.state !== 'already-running') {
    throw new Error(`running + allowInitStart:false gave ${JSON.stringify(runningVeto.output.console)}, not already-running`);
  }

  const env = { REALM_DELEGATION_VERSION: '1', REALM_DELEGATION_DEPTH: '1', REALM_DELEGATION_ROOT: randomBytes(16).toString('hex') };
  for (const [label, options] of [
    ['marker', { env, expectManifest: false }],
    ['ancestry', { delegation: { provenance: 'ancestry', depth: 1 } as DelegationRecord, expectManifest: false }],
  ] as const) {
    const delegatedCtx = await startPlugin(options);
    const delegated = await delegatedCtx.plugin.invoke('project_init', {});
    if (delegated.ok) throw new Error(`project_init succeeded at depth 1 (${label})`);
    if (delegated.error.code !== 'NOT_SUPPORTED') throw new Error(`depth-1 refusal code (${label}): ${delegated.error.code}`);
    // Neither the config file nor the console side happened.
    if (existsSync(join(delegatedCtx.dataRoot, projectKeyFor(delegatedCtx.workRoot), 'config.json'))) throw new Error(`config written at depth 1 (${label})`);
    if (existsSync(consoleJsonPath(delegatedCtx.dataRoot, delegatedCtx.plugin.runtime.instanceId))) throw new Error(`console.json at depth 1 (${label})`);
  }
  return {
    status: 'pass',
    evidence: {
      enabledIgnored: ignored.output.console.state,
      allowInitStart: refused.output.console.state,
      runningPlusVeto: runningVeto.output.console.state,
      delegatedRefusals: ['marker', 'ancestry'],
    },
  };
});

// CONSOLE-033 (ADR 0019): a console started through project_init is the same
// server — Host-header rejection, read-only routes and loopback bind, replaying
// the CONSOLE-001..002 assertions. The credential half went with CONSOLE-003
// (ADR 0032): it replayed that case's byte-identical-401 check in full.
await record('CONSOLE-033', 'init-started console enforces the same request guards', async (): Promise<CaseOutcome> => {
  const ctx = await startPlugin();
  const init = await ctx.plugin.invoke('project_init', {});
  if (!init.ok) throw new Error(`project_init failed: ${init.error.code}`);
  const port = init.output.console.port;
  if (init.output.console.state !== 'started' || port === undefined) throw new Error(`console state: ${JSON.stringify(init.output.console)}`);
  // CONSOLE-001: a foreign Host and a wrong-port authority are both refused
  // with the RFC 7231 body, before any routing. Replaying these against the
  // init-started listener is not redundant with CONSOLE-001/002/045: those
  // exercise a boot-started one, and cannot prove the same branches here.
  const foreign = await http(port, '/api/instance', { headers: { host: `example.com:${port}` } });
  if (foreign.status !== 403 || foreign.body !== '{"error":"forbidden"}') throw new Error(`foreign Host: ${foreign.status} ${foreign.body}`);
  const wrongAuthority = await http(port, '/api/instance', { headers: { host: `127.0.0.1:${port + 1}` } });
  if (wrongAuthority.status !== 403 || wrongAuthority.body !== '{"error":"forbidden"}') throw new Error(`wrong authority: ${wrongAuthority.status} ${wrongAuthority.body}`);

  // CONSOLE-002: every non-GET is 405 with allow: GET and the method body; the
  // bind excludes non-loopback interfaces while loopback serves.
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const res = await http(port, '/api/sessions', { method });
    if (res.status !== 405 || res.headers['allow'] !== 'GET' || res.body !== '{"error":"method_not_allowed"}') {
      throw new Error(`${method}: ${res.status} allow=${String(res.headers['allow'])} ${res.body}`);
    }
  }
  const post = await http(port, '/api/sessions', { method: 'POST' });
  if (post.status !== 405 || post.headers['allow'] !== 'GET' || post.body !== '{"error":"method_not_allowed"}') throw new Error(`POST: ${post.status} allow=${String(post.headers['allow'])} ${post.body}`);
  const external = Object.values(networkInterfaces()).flat().find((info) => info !== undefined && !info.internal && info.family === 'IPv4');
  let externalVerdict = 'no non-loopback IPv4 interface on this host';
  if (external !== undefined) {
    const dialed = await tryConnect(external.address, port);
    if (dialed === 'connected') throw new Error(`console accepted a connection on ${external.address}`);
    externalVerdict = `${external.address} ${dialed}`;
  }
  const loopback = await http(port, '/api/instance');
  if (loopback.status !== 200) throw new Error(`loopback request: ${loopback.status}`);
  return { status: 'pass', evidence: { port, foreignHost: foreign.status, post: post.status, externalDial: externalVerdict, loopback: loopback.status } };
});

/**
 * Reads /api/turns and returns the turn rows by id, so a case can compare one
 * turn against what the tool face reported for the same turn.
 */
async function turnsById(port: number): Promise<Map<string, Record<string, unknown>>> {
  const res = await http(port, '/api/turns');
  if (res.status !== 200) throw new Error(`/api/turns: ${res.status}`);
  const parsed = JSON.parse(res.body) as { turns: Array<Record<string, unknown>> };
  return new Map(parsed.turns.map((turn) => [String(turn['turnId']), turn]));
}

/** The usage block `turn_get` reports for a settled turn, or undefined. */
async function turnUsage(plugin: TaskShuttleServer, turnId: string): Promise<Record<string, unknown> | undefined> {
  const got = await plugin.invoke('turn_get', { turnId });
  if (!got.ok) throw new Error(`turn_get failed: ${got.error.code}`);
  return (got.output as Record<string, unknown>)['usage'] as Record<string, unknown> | undefined;
}

/**
 * Why the two usage cases below can go N/A, stated once.
 *
 * `RUNSKEIN_TESTKIT_EMIT_USAGE=1` does make the scripted agent send a
 * `usage_update`, but its payload is a context-window gauge — `used`, `size`
 * and a `cost` — with no token counts in it. Realm's `foldUsage` returns the
 * previous value untouched unless the payload carries one of its token keys,
 * so `turnUsage` is never set and `TurnResult.usage` never appears. No amount
 * of fixture configuration produces a simulated turn that carries usage.
 *
 * The env var is confirmed to arrive: with `RUNSKEIN_TESTKIT_STOP_REASON` set on
 * the same channel the turn's stop reason changes. The gap is Realm's fold
 * rule meeting a gauge-shaped report, not the plumbing.
 *
 * Both cases therefore assert everything a usage-free run can prove and then
 * report N/A for the half that needs an engine reporting tokens. The
 * projection itself is asserted against constructed usage blocks in
 * test/console/api.test.ts.
 */
const NO_SIMULATED_USAGE = 'the scripted agent reports usage as a context gauge (used/size/cost) with no token counts, and '
  + "Realm's foldUsage ignores a payload with no token key, so no simulated turn carries usage; the projection is asserted "
  + 'against constructed usage blocks in test/console/api.test.ts, and this case needs an engine that reports tokens';

// CONSOLE-034 (§11): a turn whose engine reported usage projects that block
// onto /api/turns verbatim in full mode, cost and currency included; a turn
// whose engine reported nothing carries no `usage` key at all.
//
// The expectation is taken from `turn_get` rather than written as a literal:
// the scripted fixture's numbers are its own business, and pinning them would
// test the fixture instead of the projection — the rule CONSOLE-019 records.
await record('CONSOLE-034', 'turn usage reaches /api/turns verbatim in full mode', async (): Promise<CaseOutcome> => {
  const ctx = await startPlugin({ console: { enabled: true }, engineEnv: { kimi: { RUNSKEIN_TESTKIT_EMIT_USAGE: '1' } } });
  const { plugin, port, workRoot } = ctx;
  const created = await plugin.invoke('session_create', { engine: 'kimi', cwd: workRoot });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  const turnId = await runTurn(plugin, created.output.sessionId, 'a turn that costs something');
  const fromTool = await turnUsage(plugin, turnId);
  const rows = await turnsById(port);
  const row = rows.get(turnId);
  if (row === undefined) throw new Error('the turn is missing from /api/turns');

  // Provable either way: the route must not invent a usage block the tool face
  // does not have. This is the half that would catch a projection defaulting
  // the field to an empty object.
  if (fromTool === undefined) {
    if ('usage' in row) throw new Error(`a turn with no usage carries the key anyway: ${JSON.stringify(row['usage'])}`);
    return { status: 'na', reason: NO_SIMULATED_USAGE, evidence: { turnOnRoute: true, keyAbsentWhenUnreported: true, usageReported: false } };
  }

  // The registered assertion names cost and currency explicitly, so a fixture
  // that reports tokens but no price must not silently shrink this case.
  if (fromTool['cost'] === undefined || fromTool['currency'] === undefined) throw new Error(`usage without cost/currency: ${JSON.stringify(fromTool)}`);
  if (JSON.stringify(row['usage']) !== JSON.stringify(fromTool)) throw new Error(`route usage differs from turn_get: ${JSON.stringify(row['usage'])} vs ${JSON.stringify(fromTool)}`);
  return { status: 'pass', evidence: { usageKeys: Object.keys(fromTool).sort(), costPresent: true } };
});

// CONSOLE-035 (§7.8): with exposeTranscripts: false the same block leaves only
// its count keys — cost and currency are withheld, and the price appears
// nowhere in the raw body.
//
// The other half of the registered rule — that an unlisted *numeric* key is
// withheld too — is not reachable from here at all: no real engine can be made
// to emit one. That half is owned by test/console/api.test.ts, which feeds the
// projection a crafted block. Recorded so the next reader does not take this
// case for the whole rule.
await record('CONSOLE-035', 'degraded /api/turns keeps usage counts and withholds the price', async (): Promise<CaseOutcome> => {
  const ctx = await startPlugin({ console: { enabled: true, exposeTranscripts: false }, engineEnv: { kimi: { RUNSKEIN_TESTKIT_EMIT_USAGE: '1' } } });
  const { plugin, port, workRoot } = ctx;
  const created = await plugin.invoke('session_create', { engine: 'kimi', cwd: workRoot });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  const turnId = await runTurn(plugin, created.output.sessionId, 'a turn that costs something');

  // The tool face is unaffected by exposeTranscripts, so it still reports the
  // full block — that is what makes the comparison below meaningful.
  const fromTool = await turnUsage(plugin, turnId);
  const res = await http(port, '/api/turns');
  if (res.status !== 200) throw new Error(`/api/turns: ${res.status}`);
  const row = (JSON.parse(res.body) as { turns: Array<Record<string, unknown>> }).turns.find((turn) => turn['turnId'] === turnId);
  if (row === undefined) throw new Error('the turn is missing from degraded /api/turns');

  if (fromTool === undefined) {
    if ('usage' in row) throw new Error(`degraded route invented a usage block: ${JSON.stringify(row['usage'])}`);
    return { status: 'na', reason: NO_SIMULATED_USAGE, evidence: { turnOnRoute: true, keyAbsentWhenUnreported: true, usageReported: false } };
  }

  const price = fromTool['cost'];
  const currency = fromTool['currency'];
  if (typeof price !== 'number' || currency === undefined) throw new Error(`usage without cost/currency: ${JSON.stringify(fromTool)}`);
  const expectedCounts = Object.fromEntries(Object.entries(fromTool).filter(([key]) => key !== 'cost' && key !== 'currency'));
  if (Object.keys(expectedCounts).length === 0) throw new Error('the fixture reports a price and no counts; nothing is left to assert survives');
  if (JSON.stringify(row['usage']) !== JSON.stringify(expectedCounts)) throw new Error(`degraded usage: ${JSON.stringify(row['usage'])}, expected the counts ${JSON.stringify(expectedCounts)}`);
  for (const [key, value] of Object.entries(row['usage'] as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`degraded usage carries a non-finite ${key}: ${JSON.stringify(value)}`);
  }
  // Not just the key: the value must not survive under any spelling.
  const keys = new Set<string>();
  collectKeys(JSON.parse(res.body), keys);
  for (const forbidden of ['cost', 'currency']) if (keys.has(forbidden)) throw new Error(`degraded /api/turns carries ${forbidden}`);
  if (res.body.includes(String(price)) || res.body.includes(String(currency))) throw new Error('the price leaked into the degraded body');
  return { status: 'pass', evidence: { countsKept: Object.keys(expectedCounts).sort(), costWithheld: true, currencyWithheld: true } };
});

// CONSOLE-036 (§11, ADR 0020): /api/sessions projects the session's cumulative
// usage from the same registry record the session tools read, so the two faces
// agree — when the engine reported nothing, both omit the field; when it did,
// both carry the same block. The simulated engine never reports usage, so the
// verbatim half goes N/A; the agreement and the non-invention are provable.
await record('CONSOLE-036', 'session cumulative usage reaches /api/sessions consistently with session_get', async (): Promise<CaseOutcome> => {
  const ctx = await startPlugin({ console: { enabled: true } });
  const { plugin, port, workRoot } = ctx;
  const created = await plugin.invoke('session_create', { engine: 'codex', cwd: workRoot });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  const sessionId = created.output.sessionId;
  const got = await plugin.invoke('session_get', { sessionId });
  if (!got.ok) throw new Error(`session_get failed: ${got.error.code}`);
  const fromTool = (got.output as Record<string, unknown>)['usage'];
  const res = await http(port, '/api/sessions');
  if (res.status !== 200) throw new Error(`/api/sessions: ${res.status}`);
  const row = (JSON.parse(res.body) as { sessions: Array<Record<string, unknown>> }).sessions.find((s) => s['sessionId'] === sessionId);
  if (row === undefined) throw new Error('the session is missing from /api/sessions');
  if ('usage' in row !== (fromTool !== undefined)) throw new Error(`/api/sessions and session_get disagree about session usage: ${JSON.stringify(row['usage'])} vs ${JSON.stringify(fromTool)}`);
  if (fromTool === undefined) return { status: 'na', reason: NO_SIMULATED_USAGE, evidence: { facesAgree: true, usageInvented: false } };
  if (JSON.stringify(row['usage']) !== JSON.stringify(fromTool)) throw new Error(`session usage on the two faces differs: ${JSON.stringify(row['usage'])} vs ${JSON.stringify(fromTool)}`);
  return { status: 'pass', evidence: { usageCarried: true, facesAgree: true } };
});

// CONSOLE-037 (§11, ADR 0020): with exposeTranscripts: false, /api/sessions
// applies the same count-key whitelist the turns route does. With the
// simulated engine both faces omit usage entirely (nothing was reported), so
// the count-keeping half is N/A; the consistent behavior — neither face
// invents a usage key — is provable. The shared-whitelist structure is
// guaranteed by code review, not by this case (design §8.4).
await record('CONSOLE-037', 'degraded /api/sessions withholds the same usage the turns route withholds', async (): Promise<CaseOutcome> => {
  const ctx = await startPlugin({ console: { enabled: true, exposeTranscripts: false } });
  const { plugin, port, workRoot } = ctx;
  const created = await plugin.invoke('session_create', { engine: 'codex', cwd: workRoot });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  const sessionId = created.output.sessionId;
  const sessions = await http(port, '/api/sessions');
  if (sessions.status !== 200) throw new Error(`/api/sessions: ${sessions.status}`);
  const row = (JSON.parse(sessions.body) as { sessions: Array<Record<string, unknown>> }).sessions.find((s) => s['sessionId'] === sessionId);
  if (row === undefined) throw new Error('the session is missing from /api/sessions');
  const turns = await http(port, '/api/turns');
  if (turns.status !== 200) throw new Error(`/api/turns: ${turns.status}`);
  // Neither face has any usage to show: the engine reported none, so neither
  // may invent a usage key. The two faces agree by construction.
  if ('usage' in row) throw new Error(`degraded /api/sessions invented a session usage block: ${JSON.stringify(row['usage'])}`);
  const turnRows = (JSON.parse(turns.body) as { turns: Array<Record<string, unknown>> }).turns;
  for (const turn of turnRows) if ('usage' in turn) throw new Error(`degraded /api/turns invented a usage block: ${JSON.stringify(turn['usage'])}`);
  return { status: 'na', reason: NO_SIMULATED_USAGE, evidence: { facesAgree: true, noUsageInvented: true, countKeysKept: false } };
});

// CONSOLE-038 (§11, ADR 0020): with exposeTranscripts: false, /api/sessions
// carries no observedConfig key or value — model names and reasoning tiers are
// strings and not on the §7.8 whitelist, so the whole block stays behind. This
// half is provable with the simulated engine (the omission is unconditional);
// the full-mode presence needs an engine that reports observed config.
await record('CONSOLE-038', 'degraded /api/sessions omits observedConfig entirely; full mode carries it when reported', async (): Promise<CaseOutcome> => {
  const degraded = await startPlugin({ console: { enabled: true, exposeTranscripts: false } });
  const { port: degPort, workRoot: degRoot, plugin: degPlugin } = degraded;
  const degCreated = await degPlugin.invoke('session_create', { engine: 'codex', cwd: degRoot });
  if (!degCreated.ok) throw new Error(`session_create failed: ${degCreated.error.code}`);
  const degSessions = await http(degPort, '/api/sessions');
  if (degSessions.status !== 200) throw new Error(`/api/sessions: ${degSessions.status}`);
  const degRow = (JSON.parse(degSessions.body) as { sessions: Array<Record<string, unknown>> }).sessions.find((s) => s['sessionId'] === degCreated.output.sessionId);
  if (degRow === undefined) throw new Error('the session is missing from degraded /api/sessions');
  if ('observedConfig' in degRow) throw new Error(`degraded /api/sessions leaked observedConfig: ${JSON.stringify(degRow['observedConfig'])}`);

  const full = await startPlugin({ console: { enabled: true } });
  const { port: fullPort, workRoot: fullRoot, plugin: fullPlugin } = full;
  const fullCreated = await fullPlugin.invoke('session_create', { engine: 'codex', cwd: fullRoot });
  if (!fullCreated.ok) throw new Error(`session_create failed: ${fullCreated.error.code}`);
  const got = await fullPlugin.invoke('session_get', { sessionId: fullCreated.output.sessionId });
  if (!got.ok) throw new Error(`session_get failed: ${got.error.code}`);
  const fromTool = (got.output as Record<string, unknown>)['observedConfig'];
  if (fromTool === undefined) return { status: 'na', reason: NO_SIMULATED_USAGE, evidence: { degradedOmitted: true, fullCarriesWhenReported: false } };
  const fullSessions = await http(fullPort, '/api/sessions');
  if (fullSessions.status !== 200) throw new Error(`/api/sessions: ${fullSessions.status}`);
  const fullRow = (JSON.parse(fullSessions.body) as { sessions: Array<Record<string, unknown>> }).sessions.find((s) => s['sessionId'] === fullCreated.output.sessionId);
  if (fullRow === undefined) throw new Error('the session is missing from full /api/sessions');
  if (JSON.stringify(fullRow['observedConfig']) !== JSON.stringify(fromTool)) throw new Error(`observedConfig on the two faces differs: ${JSON.stringify(fullRow['observedConfig'])} vs ${JSON.stringify(fromTool)}`);
  return { status: 'pass', evidence: { degradedOmitted: true, fullCarriesWhenReported: true } };
});

/** Read the engine's own report back from the raw transcript: the first
 * located path per tool_call id, plus whether a bare tool_call_update (no
 * locations, no rawInput) followed it — the partial-row shape whose computed
 * absence of args must not erase what the first event said (ADR 0023 §3.3
 * rule 1). Expectations come from here, never from fixture constants: the
 * case asserts the chain, not the fixture. */
function reportedToolArgs(events: Array<Record<string, unknown>>): Map<string, { path: string; followedByBareUpdate: boolean }> {
  const reported = new Map<string, { path: string; followedByBareUpdate: boolean }>();
  for (const event of events) {
    const update = event['update'] as Record<string, unknown> | undefined;
    if (update === undefined || typeof update['toolCallId'] !== 'string') continue;
    const id: string = update['toolCallId'];
    if (update['sessionUpdate'] === 'tool_call' && !reported.has(id)) {
      const locations = Array.isArray(update['locations']) ? (update['locations'] as Array<Record<string, unknown>>) : [];
      const located = locations.find((l) => typeof l?.path === 'string') as { path: string } | undefined;
      if (located !== undefined) reported.set(id, { path: located.path, followedByBareUpdate: false });
    } else if (update['sessionUpdate'] === 'tool_call_update' && reported.has(id)) {
      const entry = reported.get(id)!;
      // Status-only means nothing in the fold's chain is present: a terminal
      // update carrying parseable content would derive fresh args, and
      // counting that as "absence kept held" would claim a boundary the run
      // never exercised. Own-property checks — inherited keys are noise.
      const carriesNothing =
        !Object.hasOwn(update, 'rawInput') && !Array.isArray(update['locations']) && !Object.hasOwn(update, 'content');
      if (!entry.followedByBareUpdate && carriesNothing) {
        entry.followedByBareUpdate = true;
      }
    }
  }
  return reported;
}

// CONSOLE-039 (§11, ADR 0023): the folded projection carries what a tool call
// acted on. The scripted agent's tool_call reports `locations` without
// `rawInput`, so the args must come from level 2 of the fold's chain — the
// only level a simulated engine can reach (levels 1 and 3 are unit-test
// territory; see console-design §11 and the upstream testkit note). Each
// folded run is checked against ITS OWN call's reported path by toolCallId,
// and the scripted pair — tool_call, then a status-only tool_call_update —
// makes rule 1 observable: if the merge wrote that absence back, the path
// below vanishes and this case goes red.
await record('CONSOLE-039', 'folded tool runs carry args { text, from } from the reported locations; value never appears', async (): Promise<CaseOutcome> => {
  const ctx = await startPlugin({ console: { enabled: true }, engineEnv: { kimi: { RUNSKEIN_TESTKIT_TOOL_CALL: '1' } } });
  const { plugin, port, workRoot } = ctx;
  const created = await plugin.invoke('session_create', { engine: 'kimi', cwd: workRoot });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  await runTurn(plugin, created.output.sessionId, 'args turn');

  // What did the engine actually report?
  const raw = JSON.parse((await http(port, `/api/sessions/${created.output.sessionId}/events?afterSeq=0`)).body) as {
    events: Array<Record<string, unknown>>;
  };
  const reported = reportedToolArgs(raw.events);
  if (reported.size === 0) {
    return { status: 'na', reason: 'the scripted agent reported no tool call with a located path in this run; an assertion without its subject would be vacuously true', evidence: {} };
  }

  // The folded projection must carry it as args { text, from } — and nothing
  // else: `value` is dropped by design (ADR 0023 §3.1), any extra key is a
  // leak of engine-reported bytes into the wire.
  const folded = JSON.parse((await http(port, `/api/sessions/${created.output.sessionId}/events?afterSeq=0&projection=folded`)).body) as {
    runs: GateRun[];
  };
  let checked = 0;
  let absenceObserved = false;
  for (const run of folded.runs) {
    if (run.kind !== 'tool') continue;
    const expectation = reported.get(String(run.toolCallId));
    if (expectation === undefined) continue;
    const args = run['args'];
    if (args === undefined) throw new Error(`folded run for ${run.toolCallId} lost the args its own tool_call reported`);
    const record_ = args as Record<string, unknown>;
    if (JSON.stringify(Object.keys(record_).sort()) !== JSON.stringify(['from', 'text'])) {
      throw new Error(`args keys are ${JSON.stringify(Object.keys(record_))}, want exactly [from, text]`);
    }
    if (record_['from'] !== 'locations') throw new Error(`args.from is ${String(record_['from'])}, want locations (level 2 is all this shape can reach)`);
    if (record_['text'] !== expectation.path) throw new Error(`args.text ${String(record_['text'])} does not match the location ${run.toolCallId} reported (${expectation.path})`);
    checked += 1;
    if (expectation.followedByBareUpdate) absenceObserved = true;
  }
  if (checked === 0) throw new Error('no folded tool run corresponded to a reported tool_call — nothing was asserted');
  if (!absenceObserved) throw new Error('the transcript had no bare tool_call_update after a located call — rule 1 went unexercised');
  return { status: 'pass', evidence: { from: 'locations', runsChecked: checked, valueLeaked: false, absenceKept: true, absenceExercised: true } };
});

// CONSOLE-040 (§11, ADR 0023): degraded mode never reaches the folded
// projection at all — readEventsFolded falls back to the raw degraded page —
// so the assertion is on the envelope SHAPE, not merely "no args": an
// implementation that served full folded pages minus the args key would pass
// a bare absence check. The full-mode control reads the transcript the same
// way and asserts the exact { text, from } the engine reported — invented or
// unrelated args would satisfy a bare "some run has args" check.
await record('CONSOLE-040', 'degraded folded request returns the raw degraded envelope: no runs, three-key events, and first a full-mode control with args', async (): Promise<CaseOutcome> => {
  // Control: full mode, same script shape, expectation from its own transcript.
  const controlCtx = await startPlugin({ console: { enabled: true }, engineEnv: { kimi: { RUNSKEIN_TESTKIT_TOOL_CALL: '1' } } });
  const controlCreated = await controlCtx.plugin.invoke('session_create', { engine: 'kimi', cwd: controlCtx.workRoot });
  if (!controlCreated.ok) throw new Error(`session_create failed: ${controlCreated.error.code}`);
  await runTurn(controlCtx.plugin, controlCreated.output.sessionId, 'control turn');
  const controlRaw = JSON.parse((await http(controlCtx.port, `/api/sessions/${controlCreated.output.sessionId}/events?afterSeq=0`)).body) as {
    events: Array<Record<string, unknown>>;
  };
  const controlReported = reportedToolArgs(controlRaw.events);
  if (controlReported.size === 0) {
    return {
      status: 'na',
      reason: 'the control run reported no tool call with a located path; the degraded half needs a full-mode positive control to mean anything (§6.1: fixture shape absent is N/A, not fail)',
      evidence: {},
    };
  }
  const controlFolded = JSON.parse((await http(controlCtx.port, `/api/sessions/${controlCreated.output.sessionId}/events?afterSeq=0&projection=folded`)).body) as {
    runs: GateRun[];
  };
  let controlChecked = 0;
  for (const run of controlFolded.runs) {
    if (run.kind !== 'tool') continue;
    const expectation = controlReported.get(String(run.toolCallId));
    if (expectation === undefined) continue;
    const args = run['args'] as Record<string, unknown> | undefined;
    if (args === undefined) throw new Error(`full-mode control: run ${run.toolCallId} lost the args its tool_call reported`);
    if (args['text'] !== expectation.path || args['from'] !== 'locations') {
      throw new Error(`full-mode control args ${JSON.stringify(args)} do not match the reported ${JSON.stringify(expectation.path)} via locations`);
    }
    controlChecked += 1;
  }
  if (controlChecked === 0) throw new Error('full-mode control produced no verifiable args — the degraded half would prove nothing');

  // Subject: degraded mode, same shape. The envelope must be the raw
  // degraded page: no `runs`, every event exactly { seq, ts, byteLen },
  // cursor fields intact.
  const ctx = await startPlugin({ console: { enabled: true, exposeTranscripts: false }, engineEnv: { kimi: { RUNSKEIN_TESTKIT_TOOL_CALL: '1' } } });
  const { plugin, port, workRoot } = ctx;
  const created = await plugin.invoke('session_create', { engine: 'kimi', cwd: workRoot });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  await runTurn(plugin, created.output.sessionId, 'degraded args turn');
  const res = await http(port, `/api/sessions/${created.output.sessionId}/events?afterSeq=0&projection=folded`);
  if (res.status !== 200) throw new Error(`degraded folded request: ${res.status}`);
  const body = JSON.parse(res.body) as Record<string, unknown>;
  if (!('nextSeq' in body) || !('highWatermark' in body) || !('hasMore' in body)) throw new Error('degraded page lost its cursor fields');
  if ('runs' in body) throw new Error('degraded folded request served folded runs');
  const events = body['events'];
  if (!Array.isArray(events) || events.length === 0) throw new Error('degraded page has no events to assert against');
  for (const event of events as Record<string, unknown>[]) {
    if (JSON.stringify(Object.keys(event).sort()) !== JSON.stringify(['byteLen', 'seq', 'ts'])) {
      throw new Error(`degraded event keys are ${JSON.stringify(Object.keys(event))}, want exactly [byteLen, seq, ts]`);
    }
  }
  return { status: 'pass', evidence: { controlRunsChecked: controlChecked, runsServed: false, envelopeShapeEnforced: true } };
});

// CONSOLE-047 (ADR 0033): a console on a data root that is not empty. Every
// other case here builds its fixture in a fresh mkdtemp root, which is why the
// matrix stayed green while no operator could open a console: a cleanly closed
// instance leaves its directory standing with the lock removed, and reading the
// locks made that steady state read as doubt. The case settles the verdict
// against the polluted root itself — the runtime takes an injected verdict and
// never settles one — so what it exercises is the scan, not the gate's fixture.
await record('CONSOLE-047', 'a console starts on a data root that already holds closed instances', async (): Promise<CaseOutcome> => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-console-accumulated-'));
  cleanups.push(async () => { await rm(dataRoot, { recursive: true, force: true }); });

  // Closed the way `performClose` closes: the manifest stays, the lock goes.
  // Written through InstanceManager so the fixture cannot drift from the writer.
  const closedIds: string[] = [];
  for (let n = 0; n < 8; n += 1) {
    const manager = await InstanceManager.create({ dataRoot, rootNonce: randomBytes(16).toString('hex'), pid: process.pid });
    await manager.close({ retentionDays: null });
    closedIds.push(manager.instanceId);
  }
  for (const id of closedIds) {
    if (existsSync(join(dataRoot, 'instances', id, 'instance.lock'))) throw new Error(`closed instance ${id} still holds a lock`);
    if (!existsSync(join(dataRoot, 'instances', id, 'instance.json'))) throw new Error(`closed instance ${id} kept no manifest`);
  }

  const diagnostics: DelegationDiagnostics = {};
  const verdict = await settleDelegation({
    marker: readDelegationIdentity({} as NodeJS.ProcessEnv),
    dataRoot,
    // A pid whose ancestry cannot cross any of those records: the closed
    // instances must be read and then not match, which is the whole point.
    pid: 1,
    diagnostics,
  });
  if (verdict.provenance !== 'root') {
    throw new Error(`an accumulated data root answered ${JSON.stringify(verdict)}, not root (cause: ${diagnostics.cause ?? 'none'})`);
  }
  if ((diagnostics.records ?? 0) < closedIds.length) {
    throw new Error(`the scan reported ${String(diagnostics.records)} records for ${closedIds.length} closed instances`);
  }

  const ctx = await startPlugin({ dataRoot, console: { enabled: true }, delegation: verdict });
  if (!existsSync(consoleJsonPath(ctx.dataRoot, ctx.plugin.runtime.instanceId))) {
    throw new Error('no console.json on a root verdict over an accumulated data root');
  }
  if (ctx.logs.some((entry) => entry.event === 'console_withheld')) throw new Error('the console was withheld on a root verdict');
  return { status: 'pass', evidence: { closedInstances: closedIds.length, recordsScanned: diagnostics.records ?? 0, consoleStarted: true } };
});


await drainCleanups();

const report = buildReport({
  gate: 'console',
  runId,
  startedAt,
  simulated: true,
  cases,
  cliVersions: Object.fromEntries(SIMULATED_ENGINES.map((engine) => [engine, 'simulated'])),
});
const problems = validateReport(report);
const written = await writeReport(report);
console.log(`console gate: ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.na} N/A (simulated engines)`);
console.log(`report: ${written.markdown}`);
for (const problem of problems) console.error(`report problem: ${problem}`);
for (const entry of cases) if (entry.status === 'fail') console.error(`FAIL ${entry.id}: ${entry.reason}`);
process.exitCode = exitCodeFor(report, problems);
