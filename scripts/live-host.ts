#!/usr/bin/env node
/**
 * HOST live gate (test-plan §7).
 *
 * Split by what a script may honestly do on someone's machine:
 *
 * - Automated: everything that runs the *shipped* artifact in a temporary data
 *   root — stdio server start, 20-tool discovery, `workers_list` smoke, and
 *   HOST-COMMON-001 (SIGTERM → process gone within 15 s, lock released,
 *   transcript still readable).
 * - Manual: install / enable / reload / disable / uninstall, which mutate the
 *   operator's real host configuration. The gate prints the exact steps and
 *   records them as `manual-pending` with the command to confirm them; §1
 *   forbids inventing a pass for work nobody did.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { discoverHostArtifactSpecs, NANNY_HOOK_ENTRY, type HostDriver } from '@taskshuttle/host-kit';
import { createPluginTranscriptStore } from '../packages/plugin/src/store/plugin-transcript-store.js';
import { FROZEN_ENGINE_IDS } from '../packages/plugin/src/schemas.js';
import { buildReport, cliVersion, exemptedEngines, exitCodeFor, validateReport, writeReport, type CaseResult } from './live/evidence.js';
import { parseHostInstallEvidence, validateHostInstallEvidence } from './live/host-install-evidence.js';
import type { HostProbeCase, HostProbeContext } from './live/host-probes.js';
import { resolvePluginDist } from './plugin-artifact-path.js';

type CaseOutcome = Omit<CaseResult, 'id' | 'title' | 'durationMs'>;

const root = resolve(process.cwd());
const pluginDist = resolvePluginDist(root);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const startedAt = new Date().toISOString();
const cases: CaseResult[] = [];
/**
 * How state 3's trust gate was satisfied, stated by the operator.
 *
 * `persisted` means codex recorded a `hooks.state."…".trusted_hash` entry —
 * the path a real user takes. `bypassed` means `--dangerously-bypass-hook-trust`,
 * which proves the enabled-and-trusted branch runs but proves nothing about
 * trust being persisted or re-read. They are not interchangeable and the
 * evidence must not blur them.
 */
const codexTrust = process.argv.find((argument) => argument.startsWith('--codex-trust='))?.slice('--codex-trust='.length);
const confirmed = new Set((process.argv.find((argument) => argument.startsWith('--confirm='))?.slice('--confirm='.length) ?? '').split(',').filter(Boolean));
const hostInstallEvidencePath = process.argv.find((argument) => argument.startsWith('--host-install-evidence='))?.slice('--host-install-evidence='.length);
const hostSpecs = await discoverHostArtifactSpecs(root);

async function driverFor(spec: (typeof hostSpecs)[number]): Promise<HostDriver> {
  const module = await import(pathToFileURL(join(root, spec.directory, spec.hostManifest.driver)).href) as { default?: HostDriver };
  if (module.default === undefined || module.default.id !== spec.host) throw new Error(`host '${spec.host}' driver does not match its manifest`);
  return module.default;
}

async function probesFor(spec: (typeof hostSpecs)[number]): Promise<readonly HostProbeCase[]> {
  const path = join(root, spec.directory, 'live.ts');
  if (!existsSync(path)) return [];
  const module = await import(pathToFileURL(path).href) as { default?: readonly HostProbeCase[] };
  if (!Array.isArray(module.default)) throw new Error(`host '${spec.host}' live probe module must export an array`);
  return module.default;
}

async function operationPlan(spec: (typeof hostSpecs)[number], operation: 'install' | 'verify' | 'uninstall'): Promise<{ driver: HostDriver; commands: readonly { binary: string; argv: readonly string[] }[]; detail: string }> {
  const driver = await driverFor(spec);
  const result = await driver[operation]({ manifest: spec.hostManifest, roots: { repository: root, host: join(root, spec.directory), output: join(root, spec.directory) } });
  return { driver, commands: result.commands ?? [], detail: result.detail };
}

function formatCommands(commands: readonly { binary: string; argv: readonly string[] }[]): string {
  return commands.map((command) => [command.binary, ...command.argv].join(' ')).join(' | ');
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

interface StdioServer {
  readonly pid: number;
  readonly dataRoot: string;
  /** The directory the artifact was launched in — the outer cwd bound (ADR 0007). */
  readonly workRoot: string;
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  stop(signal: NodeJS.Signals): Promise<{ exitedWithinMs: number | undefined }>;
}

/** Drive the *built* artifact over stdio, exactly as a host would. */
/**
 * The `ToolError` envelope of a failed tool call, or undefined when the call
 * succeeded. Error results carry the envelope as JSON in the text content and
 * no `structuredContent` at all (ADR 0024), so a reader that looks in the
 * structured field sees `undefined` and mistakes every failure for a success —
 * which is why this is one helper and not two call sites.
 */
/**
 * The `ToolError` envelope of a failed tool call, or undefined when the call
 * succeeded. Error results carry the envelope as JSON in the text content and
 * no `structuredContent` at all (ADR 0024), so a reader that looks in the
 * structured field sees `undefined` and mistakes every failure for a success —
 * which is why this is one helper and not two call sites. The envelope's
 * `cause` projection is what classifies an authentication refusal (ADR 0011).
 */
function toolFailure(result: Record<string, unknown>): { code?: string; message?: string; cause?: unknown } | undefined {
  if (result['isError'] !== true) return undefined;
  const content = result['content'];
  const first = Array.isArray(content) ? content[0] as { text?: unknown } | undefined : undefined;
  if (typeof first?.text !== 'string') return { message: 'the error result carried no text content' };
  try {
    const parsed = JSON.parse(first.text) as { error?: { code?: string; message?: string; cause?: unknown } };
    return parsed.error ?? { message: first.text };
  } catch { return { message: first.text }; }
}

async function startStdioServer(): Promise<StdioServer> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-host-gate-'));
  const workRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-host-work-'));
  const entry = join(pluginDist, 'launch.js');
  if (!existsSync(entry)) throw new Error('packages/plugin/dist/launch.js is missing; run pnpm build first');
  const child = spawn(process.execPath, [entry], {
    // The host launches the plugin in the directory it works in; that directory
    // is the outer boundary (ADR 0007), so the gate has to launch it the same way.
    cwd: workRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      REALM_PLUGIN_DATA_ROOT: dataRoot,
      REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [workRoot] }),
      REALM_PLUGIN_LOG: 'off',
    },
  });
  if (child.pid === undefined) throw new Error('the plugin process did not start');

  let buffer = '';
  const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(cause: unknown): void }>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      try {
        const message = JSON.parse(line) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
        if (message.id === undefined) continue;
        const waiter = pending.get(message.id);
        if (waiter === undefined) continue;
        pending.delete(message.id);
        if (message.error !== undefined) waiter.reject(new Error(message.error.message ?? 'JSON-RPC error'));
        else waiter.resolve(message.result ?? {});
      } catch { /* a non-JSON line is not a response */ }
    }
  });

  let nextId = 0;
  const request = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = ++nextId;
    const message = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => { pending.delete(id); rejectRequest(new Error(`${method} timed out`)); }, 30_000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolveRequest(value); },
        reject: (cause) => { clearTimeout(timer); rejectRequest(cause); },
      });
      child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  };

  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'host-gate', version: '0.1.0' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  return {
    pid: child.pid,
    dataRoot,
    workRoot,
    request,
    async stop(signal) {
      const stoppedAt = Date.now();
      const exited = new Promise<number>((resolveExit) => child.once('exit', () => resolveExit(Date.now() - stoppedAt)));
      child.kill(signal);
      const raced = await Promise.race([exited, new Promise<undefined>((resolveTimeout) => { const timer = setTimeout(() => resolveTimeout(undefined), 15_000); timer.unref?.(); })]);
      if (raced === undefined) child.kill('SIGKILL');
      await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
      return { exitedWithinMs: raced };
    },
  };
}

await record('HOST-COMMON-001', 'shipped artifact: 20 tools, smoke, SIGTERM within 15s, lock released, transcript readable', async (): Promise<CaseOutcome> => {
  const server = await startStdioServer();
  try {
    const tools = await server.request('tools/list');
    const names = ((tools['tools'] ?? []) as Array<{ name: string }>).map((tool) => tool.name).sort();
    if (names.length !== 20) throw new Error(`expected 20 tools, saw ${names.length}`);

    const smoke = await server.request('tools/call', { name: 'workers_list', arguments: { rescan: false } });
    const structured = smoke['structuredContent'] as { workers?: Array<{ engine: string }> } | undefined;
    const engines = structured?.workers?.map((worker) => worker.engine) ?? [];
    // The frozen four must be there; more may be, because Realm's built-in set is
    // open (ADR 0004) and grew to include `pi` in 0.1.0-alpha.10. An exact count
    // would turn every upstream adapter into a failed release gate.
    const missing = FROZEN_ENGINE_IDS.filter((engine) => !engines.includes(engine));
    if (missing.length > 0) throw new Error(`workers_list is missing frozen engines: ${missing.join(', ')}`);

    const instances = join(server.dataRoot, 'instances');
    const before = await readdir(instances);
    if (before.length !== 1) throw new Error(`expected one instance directory, saw ${before.length}`);
    const instanceDir = join(instances, before[0]!);
    if (!existsSync(join(instanceDir, 'instance.lock'))) throw new Error('the instance lock was not created');

    const stopped = await server.stop('SIGTERM');
    if (stopped.exitedWithinMs === undefined) throw new Error('the plugin did not exit within 15s of SIGTERM');
    if (existsSync(join(instanceDir, 'instance.lock'))) throw new Error('the instance lock outlived the process');

    // §7: after shutdown the transcript must still be readable by the next start.
    const manifest = JSON.parse(await readFile(join(instanceDir, 'instance.json'), 'utf8')) as { closedAt?: string };
    if (manifest.closedAt === undefined) throw new Error('the instance manifest was not marked closed');
    const store = createPluginTranscriptStore(join(instanceDir, 'taskshuttle.sqlite'), { dataRoot: server.dataRoot });
    try { await store.sessions(); } finally { await store.close().catch(() => undefined); }
    await rm(server.dataRoot, { recursive: true, force: true }).catch(() => undefined);

    return { status: 'pass', evidence: { pid: server.pid, tools: names.length, engines, exitedWithinMs: stopped.exitedWithinMs } };
  } catch (cause) {
    await server.stop('SIGKILL').catch(() => undefined);
    throw cause;
  }
});

/**
 * Run a staged hook the way a host does: a JSON payload on stdin, JSON on stdout.
 *
 * @param entry - the hook script inside a host bundle.
 * @param payload - the host's stop payload.
 * @param env - extra environment; the hook reads the data root and the delegation marker from it.
 * @returns stdout, trimmed, plus the exit code.
 */
async function runStagedHook(entry: string, payload: unknown, env: NodeJS.ProcessEnv): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    // The hook's own budget is a second; anything past five is a hung hook,
    // which on a real host would hold the user's session open.
    const timer = setTimeout(() => { child.kill('SIGKILL'); rejectRun(new Error('the staged hook did not exit within 5s')); }, 5_000);
    child.once('error', (cause) => { clearTimeout(timer); rejectRun(cause); });
    child.once('close', (code) => { clearTimeout(timer); resolveRun({ stdout: stdout.trim(), code }); });
    child.stdin.end(JSON.stringify(payload));
  });
}

// Host-specific live probes live beside their manifest. This loop owns only
// registration, timing, and evidence; it supplies generic server/process
// seams so a host probe cannot create a second report writer or orchestration
// path of its own.
const probeContext: HostProbeContext = {
  root,
  runId,
  confirmed,
  codexTrust,
  hostBaselines: Object.fromEntries(hostSpecs.map((spec) => [spec.host, spec.hostManifest.baseline])),
  cliVersion,
  startServer: startStdioServer,
  toolFailure,
  runStagedHook,
  nannyHookEntry: NANNY_HOOK_ENTRY,
};
for (const spec of hostSpecs) {
  for (const probe of await probesFor(spec)) {
    await record(probe.id, probe.title, () => probe.run(probeContext));
  }
}

await record('HOST-ARTIFACT-001', 'every host artifact ships its manifest, skill and bundled entry', async (): Promise<CaseOutcome> => {
  const missing: string[] = [];
  for (const spec of hostSpecs) {
    for (const required of [spec.manifest, 'skills/delegate-workers/SKILL.md']) {
      const path = join(root, spec.directory, required);
      if (!existsSync(path)) missing.push(`${spec.directory}/${required}`);
    }
    const entry = join(root, spec.directory, 'dist/launch.js');
    if (!(await stat(entry).then((info) => info.isFile(), () => false))) missing.push(`${spec.directory}/dist/launch.js`);
  }
  if (missing.length > 0) throw new Error(`missing artifacts: ${missing.join(', ')}`);
  return { status: 'pass', evidence: { hosts: hostSpecs.map((spec) => spec.host) } };
});

for (const spec of hostSpecs) {
  const plan = await operationPlan(spec, 'install');
  const cli = plan.commands[0]?.binary ?? spec.host;
  const installed = cliVersion(cli);
  await record(`HOST-${spec.host.toUpperCase()}-INSTALL`, `${spec.host}: install → discover → reload → disable → uninstall`, async (): Promise<CaseOutcome> => {
    if (installed === 'not-installed') return { status: 'na', reason: `${cli} CLI is not installed on this machine` };
    if (confirmed.has(spec.host)) {
      return { status: 'pass', reason: 'confirmed by the operator with --confirm', evidence: { cli: installed, scopes: spec.supportedScopes } };
    }
    return {
      status: 'manual-pending',
      reason: `mutates the operator's host configuration; run these steps then re-run with --confirm=${spec.host}: ${formatCommands(plan.commands)} (${plan.detail})`,
      evidence: { cli: installed, scopes: spec.supportedScopes },
    };
  });
}

await record('HOST-KIMI-002', 'Kimi project scope', async (): Promise<CaseOutcome> => ({
  status: 'na',
  reason: 'the host does not support project scope; recorded as N/A by design rather than simulated',
}));

// HOST-COMMON-006: confirmation selects a manual case; it is not evidence that
// the old installation disappeared. The typed listing must prove that fact.
await record('HOST-COMMON-006', 'rename install evidence', async (): Promise<CaseOutcome> => {
  if (hostInstallEvidencePath === undefined) {
    return { status: 'manual-pending', reason: 'supply --host-install-evidence=<path> containing the four host listings and npm global listing' };
  }
  const evidence = parseHostInstallEvidence(await readFile(hostInstallEvidencePath, 'utf8'));
  const issues = validateHostInstallEvidence(evidence, hostSpecs.map((spec) => spec.host), 'taskshuttle', 'realm-agent-plugin');
  if (issues.length > 0) throw new Error(issues.join('; '));
  return { status: 'pass', evidence: { evidencePath: hostInstallEvidencePath, hosts: Object.keys(evidence.hosts) } };
});

const report = buildReport({
  gate: 'host',
  runId,
  startedAt,
  simulated: false,
  cases,
  cliVersions: Object.fromEntries(await Promise.all(hostSpecs.map(async (spec) => {
    const plan = await operationPlan(spec, 'install');
    return [spec.host, cliVersion(plan.commands[0]?.binary ?? spec.host)] as const;
  }))),
});
const problems = validateReport(report);
const written = await writeReport(report);
const exempted = exemptedEngines(report);
console.log(`host gate: ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.na} N/A, ${report.summary.manualPending} awaiting manual confirmation${exempted.length > 0 ? ` — exempted: ${exempted.join(', ')}` : ''}`);
console.log(`report: ${written.markdown}`);
for (const problem of problems) console.error(`report problem: ${problem}`);
for (const entry of cases) if (entry.status === 'fail') console.error(`FAIL ${entry.id}: ${entry.reason}`);
process.exitCode = exitCodeFor(report, problems);
