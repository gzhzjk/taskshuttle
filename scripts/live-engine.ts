#!/usr/bin/env node
/**
 * ENG live gate (test-plan §8): inventory → create → two text turns →
 * transcript event check → close, per engine, plus fork/capability/interaction
 * cases.
 *
 * Default mode drives Realm's scripted ACP agent instead of the real CLIs, so
 * the whole plugin path is exercised without spending an engine turn. `--live`
 * runs the same matrix against the installed, logged-in CLIs; the report always
 * records which mode produced it, because a simulated pass is not an ENG pass.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTaskShuttleServer, type TaskShuttleServer } from '../packages/plugin/src/server.js';
import { simulatedHubFactory, SIMULATED_ENGINES } from '../packages/plugin/src/testkit/simulated-engines.js';
import { isFrozenEngine, type EngineId } from '../packages/plugin/src/schemas.js';
import { CLI_FOR_OPTIONAL, CLI_FOR } from './live/engines.js';
import { buildReport, caseForThrow, cliVersion, exemptedEngines, exitCodeFor, preRunExemption, refuseIfClassified, validateReport, writeReport, type CaseOptions, type CaseResult } from './live/evidence.js';
import { resolvePluginDist } from './plugin-artifact-path.js';

type CaseOutcome = Omit<CaseResult, 'id' | 'title' | 'durationMs'>;

/** What a failed tool call or a failed settled turn carries across the boundary. */
interface FailureShape {
  code?: string;
  message?: string;
  cause?: unknown;
}

/** The engine's own words for a failure: "ended failed" alone cannot be acted on. */
function failureDetail(failure: FailureShape | undefined): string {
  return failure === undefined ? '' : `: ${failure.code ?? 'ERROR'} ${failure.message ?? ''}`.trimEnd();
}

/**
 * Throw a mid-run refusal instead of a plain failure when, and only when, the
 * gate runs live. The criterion, the liveness gate and the wording live in
 * `refuseIfClassified` (evidence.js); this wrapper keeps the call sites
 * reading engine-first.
 *
 * @param engine - the refusing engine, carried onto the case so the run's
 *   summary can name it (ADR 0011 guardrail 4).
 * @param detail - the operation context kept in the N/A reason.
 * @param failure - the error envelope from the tool result or settled turn.
 * @throws {MidRunRefusal} only under --live when Realm classified the failure as a refusal (unauthenticated, or rate-limit; ADR 0011 as amended by ADR 0029).
 */
function refuseOrThrow(engine: EngineId, detail: string, failure: FailureShape | undefined): void {
  refuseIfClassified(live, engine, failure, detail);
}

const live = process.argv.includes('--live');
const only = process.argv.find((argument) => argument.startsWith('--engine='))?.slice('--engine='.length) as EngineId | undefined;
const engines = (only === undefined ? SIMULATED_ENGINES : [only]) as readonly EngineId[];
// Live mode spawns real workers through the bundled identity shim. Running
// from source would resolve the shim next to the runtime module, which only
// exists in the build, so point at it explicitly and fail fast if it is absent.
if (live) {
  const shim = join(resolvePluginDist(process.cwd()), 'launch.js');
  if (!existsSync(shim)) throw new Error('packages/plugin/dist/launch.js is missing; run pnpm build before a --live gate');
  process.env['REALM_PLUGIN_LAUNCH_PATH'] = shim;
}

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const startedAt = new Date().toISOString();
const cases: CaseResult[] = [];
const cleanups: Array<() => Promise<void>> = [];

async function startPlugin(engineEnv: Partial<Record<EngineId, Record<string, string>>> = {}): Promise<TaskShuttleServer> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-eng-gate-'));
  const workRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-eng-work-'));
  const plugin = createTaskShuttleServer({
    dataRoot,
    hostCwd: workRoot,
    env: {
      // The gate exists to produce the evidence that makes an engine verified, so
      // it must be able to drive one that is not verified yet — otherwise the
      // admission gate and the matrix wait on each other forever. This is an
      // install-surface switch set by the harness for its own run; it does not
      // widen what a real install accepts, and the report still records the
      // engine as unverified until someone writes the evidence down.
      REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [workRoot], allowUnverifiedEngines: true }),
      REALM_PLUGIN_LOG: 'off',
      // The runtime reads the shim path from *this* env, not from process.env.
      ...(live ? { REALM_PLUGIN_LAUNCH_PATH: process.env['REALM_PLUGIN_LAUNCH_PATH']! } : {}),
    } as NodeJS.ProcessEnv,
    // Live mode uses the production hub; simulated mode swaps only the engine binaries.
    ...(live ? {} : { hubFactory: simulatedHubFactory({ env: engineEnv }) }),
  });
  cleanups.push(async () => {
    await plugin.close().catch(() => undefined);
    await rm(dataRoot, { recursive: true, force: true });
    await rm(workRoot, { recursive: true, force: true });
  });
  await plugin.runtime.ready;
  (plugin as TaskShuttleServer & { workRoot?: string }).workRoot = workRoot;
  return plugin;
}

async function settle(plugin: TaskShuttleServer, turnId: string, budgetMs = 120_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const result = await plugin.invoke('turn_get', { turnId });
    if (!result.ok) throw new Error(`turn_get failed: ${result.error.code} ${result.error.message}`);
    if (['completed', 'failed', 'cancelled'].includes(result.output.state)) return result.output as unknown as Record<string, unknown>;
    if (Date.now() > deadline) throw new Error(`turn ${turnId} never settled (state ${result.output.state})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Record a case outcome. `options.roundTrip` marks the mandatory per-engine
 * round trip explicitly — never derived from the id, whose shape ENG-AUTH-001
 * shares (ADR 0011 guardrail 4). Case shaping from a throw, including the
 * mid-run-refusal N/A with its verbatim message and the carrying of `options`
 * onto *every* path, is owned by `caseForThrow` in evidence.js.
 */
async function record(id: string, title: string, body: () => Promise<CaseOutcome>, options: CaseOptions = {}): Promise<void> {
  const startedAtMs = Date.now();
  try {
    const outcome = await body();
    cases.push({ id, title, ...outcome, ...options, durationMs: Date.now() - startedAtMs });
  } catch (caught) {
    cases.push(caseForThrow({ id, title, caught, options, durationMs: Date.now() - startedAtMs }));
  }
}

/** ENG-<ENGINE>-001: the mandatory per-engine round trip. */
async function engineRoundTrip(engine: EngineId): Promise<void> {
  await record(`ENG-${engine.toUpperCase()}-001`, 'inventory → create → two turns → transcript → close', async (): Promise<CaseOutcome> => {
    const plugin = await startPlugin();
    const workRoot = (plugin as TaskShuttleServer & { workRoot?: string }).workRoot!;

    const inventory = await plugin.invoke('workers_list', { rescan: true });
    if (!inventory.ok) {
      refuseOrThrow(engine, `workers_list failed: ${inventory.error.code} ${inventory.error.message}`, inventory.error);
      throw new Error(`workers_list failed: ${inventory.error.code}`);
    }
    const worker = inventory.output.workers.find((entry) => entry.engine === engine);
    if (worker === undefined) throw new Error(`engine ${engine} missing from inventory`);
    const exemption = preRunExemption(worker, engine, live);
    if (exemption !== undefined) return exemption;

    const created = await plugin.invoke('session_create', { engine, cwd: workRoot });
    if (!created.ok) {
      refuseOrThrow(engine, `session_create failed: ${created.error.code} ${created.error.message}`, created.error);
      throw new Error(`session_create failed: ${created.error.code} ${created.error.message}`);
    }
    const sessionId = created.output.sessionId;

    const turnIds: string[] = [];
    for (const text of ['Reply with the single word READY.', 'Reply with the single word DONE.']) {
      const started = await plugin.invoke('turn_start', { sessionId, prompt: [{ type: 'text', text }] });
      if (!started.ok) {
        refuseOrThrow(engine, `turn_start failed: ${started.error.code} ${started.error.message}`, started.error);
        throw new Error(`turn_start failed: ${started.error.code}`);
      }
      const settled = await settle(plugin, started.output.turnId);
      if (settled['state'] !== 'completed') {
        const failure = settled['error'] as FailureShape | undefined;
        // Carry the engine's own error: "ended failed" alone cannot be acted on,
        // and a live gate that hides why is a gate that has to be re-run to learn anything.
        const detail = `turn ${started.output.turnId} ended ${String(settled['state'])}${failureDetail(failure)}`;
        refuseOrThrow(engine, detail, failure);
        throw new Error(detail);
      }
      turnIds.push(started.output.turnId);
    }

    // §8: transcript is checked event by event against the turn boundaries.
    const transcript = await plugin.invoke('transcript_read', { sessionId, afterSeq: 0, limit: 500 });
    if (!transcript.ok) throw new Error(`transcript_read failed: ${transcript.error.code}`);
    const seqs = transcript.output.events.map((event) => event.seq);
    if (seqs.some((seq, index) => index > 0 && seq <= seqs[index - 1]!)) throw new Error('transcript seqs are not strictly increasing');
    let finalTexts = 0;
    for (const turnId of turnIds) {
      const turn = await plugin.invoke('turn_get', { turnId });
      if (!turn.ok) throw new Error('turn_get failed');
      const { fromSeq, throughSeq, finalText } = turn.output as { fromSeq?: number | null; throughSeq?: number; finalText?: string };
      if (throughSeq === undefined) throw new Error(`turn ${turnId} has no throughSeq`);
      if (throughSeq > transcript.output.highWatermark) throw new Error(`turn ${turnId} throughSeq exceeds the watermark`);
      if (fromSeq !== null && fromSeq !== undefined && !seqs.includes(fromSeq)) throw new Error(`turn ${turnId} fromSeq ${fromSeq} is not a stored event`);
      if (typeof finalText === 'string' && finalText.length > 0) finalTexts += 1;
    }

    const closed = await plugin.invoke('session_close', { sessionId });
    if (!closed.ok) throw new Error(`session_close failed: ${closed.error.code}`);
    if (closed.output.state !== 'closed') throw new Error(`session ended ${closed.output.state}`);

    return {
      status: 'pass' as const,
      evidence: { sessionId, turnIds, events: seqs.length, highWatermark: transcript.output.highWatermark, finalTexts, version: worker.version ?? 'unknown' },
    };
  }, { roundTrip: true });
}

/** ENG-FORK-001: native fork where supported, an exact NOT_SUPPORTED where not. */
async function forkCase(engine: EngineId): Promise<void> {
  await record(`ENG-FORK-001-${engine}`, 'fork inherits context/config or reports NOT_SUPPORTED', async (): Promise<CaseOutcome> => {
    const plugin = await startPlugin();
    const workRoot = (plugin as TaskShuttleServer & { workRoot?: string }).workRoot!;
    const describe = await plugin.invoke('worker_describe', { engine, rescan: false });
    if (!describe.ok) {
      refuseOrThrow(engine, `worker_describe failed: ${describe.error.code} ${describe.error.message}`, describe.error);
      throw new Error(`worker_describe failed: ${describe.error.code}`);
    }
    // The fork case operates the engine (session_create below), so it owes the
    // same two probes as the round trip: a logged-out engine must be exempted
    // pre-run, not filed as a mid-run refusal after session_create refuses.
    const exemption = preRunExemption(describe.output, engine, live);
    if (exemption !== undefined) return exemption;
    const supportsFork = describe.output.capabilities.session['fork'] === true;

    const created = await plugin.invoke('session_create', { engine, cwd: workRoot, config: {} });
    if (!created.ok) {
      refuseOrThrow(engine, `session_create failed: ${created.error.code} ${created.error.message}`, created.error);
      throw new Error(`session_create failed: ${created.error.code}`);
    }
    const forked = await plugin.invoke('session_fork', { sessionId: created.output.sessionId, name: 'gate-child' });

    if (!supportsFork) {
      if (forked.ok) throw new Error('fork succeeded on an engine that does not advertise it');
      if (forked.error.code !== 'NOT_SUPPORTED') {
        refuseOrThrow(engine, `expected NOT_SUPPORTED, got a failure instead`, forked.error);
        throw new Error(`expected NOT_SUPPORTED, got ${forked.error.code}`);
      }
      return { status: 'pass' as const, evidence: { supportsFork: false, code: forked.error.code } };
    }
    if (!forked.ok) {
      // The engine advertised fork and then failed it. That is an upstream
      // defect, not a plugin one — but it still fails the case: §1 forbids
      // downgrading a broken capability to N/A, and the support matrix must
      // not claim fork for this engine/wrapper version. An authentication-class
      // refusal is the one exception (ADR 0011): the capability was never
      // exercised, so there is no defect claim to launder.
      refuseOrThrow(engine, `session_fork failed: ${forked.error.code} ${forked.error.message}`, forked.error);
      const cause = forked.error.cause === undefined ? '' : ` (${forked.error.cause.name}: ${forked.error.cause.message})`;
      return {
        status: 'fail' as const,
        reason: `engine advertises session.fork but the call failed: ${forked.error.code} ${forked.error.message}${cause}`,
        evidence: { supportsFork: true, defectOwner: 'engine/wrapper', errorCode: forked.error.code },
      };
    }
    if (forked.output.permissionMode !== created.output.permissionMode) throw new Error('child did not inherit the permission mode');
    if (forked.output.cwd !== created.output.cwd) throw new Error('child did not inherit the cwd');
    return { status: 'pass' as const, evidence: { supportsFork: true, parent: created.output.sessionId, child: forked.output.sessionId } };
  });
}

/** ENG-CAP-001: record what the engine actually advertises; never assume. */
async function capabilityCase(engine: EngineId): Promise<void> {
  await record(`ENG-CAP-001-${engine}`, 'capability matrix recorded from the engine descriptor', async (): Promise<CaseOutcome> => {
    const plugin = await startPlugin();
    const describe = await plugin.invoke('worker_describe', { engine, rescan: false });
    if (!describe.ok) {
      refuseOrThrow(engine, `worker_describe failed: ${describe.error.code} ${describe.error.message}`, describe.error);
      throw new Error(`worker_describe failed: ${describe.error.code}`);
    }
    if (!describe.output.installed) return { status: 'na' as const, reason: `${engine} CLI is not installed on this machine` };
    const { capabilities } = describe.output;
    return {
      status: 'pass' as const,
      evidence: {
        image: capabilities.prompt['image'] === true,
        embeddedContext: capabilities.prompt['embeddedContext'] === true,
        fork: capabilities.session['fork'] === true,
        loadSession: capabilities.loadSession,
        authenticated: String(describe.output.authenticated),
      },
    };
  });
}

/** ENG-INT-001: a real permission round trip; simulated mode forces one. */
async function interactionCase(engine: EngineId): Promise<void> {
  await record(`ENG-INT-001-${engine}`, 'permission interaction reaches the orchestrator and is answered', async (): Promise<CaseOutcome> => {
    if (live) {
      return { status: 'na' as const, reason: 'a live engine cannot be forced to request permission; covered by the simulated run and by INT CI cases' };
    }
    const plugin = await startPlugin({ [engine]: { RUNSKEIN_TESTKIT_ASK_PERMISSION: '1' } });
    const workRoot = (plugin as TaskShuttleServer & { workRoot?: string }).workRoot!;
    const created = await plugin.invoke('session_create', { engine, cwd: workRoot, permissionMode: 'ask-orchestrator' });
    if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
    const started = await plugin.invoke('turn_start', { sessionId: created.output.sessionId, prompt: [{ type: 'text', text: 'edit a file' }] });
    if (!started.ok) throw new Error(`turn_start failed: ${started.error.code}`);

    const deadline = Date.now() + 60_000;
    let interactionId: string | undefined;
    while (interactionId === undefined) {
      if (Date.now() > deadline) throw new Error('no permission interaction appeared');
      const pending = await plugin.invoke('interaction_list', { turnId: started.output.turnId, state: 'pending' });
      if (pending.ok && pending.output.interactions.length > 0) interactionId = pending.output.interactions[0]!.interactionId;
      else await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const answered = await plugin.invoke('interaction_respond', { interactionId, response: { outcome: 'allow' } });
    if (!answered.ok) throw new Error(`interaction_respond failed: ${answered.error.code}`);
    const settled = await settle(plugin, started.output.turnId);
    if (settled['state'] !== 'completed') {
      const failure = settled['error'] as { code?: string; message?: string } | undefined;
      const detail = failure === undefined ? '' : `: ${failure.code ?? 'ERROR'} ${failure.message ?? ''}`.trimEnd();
      throw new Error(`turn ended ${String(settled['state'])}${detail}`);
    }
    if (settled['pendingPermissionCount'] !== 0) throw new Error('turn still reports a pending permission');
    return { status: 'pass' as const, evidence: { interactionId, turnId: started.output.turnId } };
  });
}

for (const engine of engines) {
  await engineRoundTrip(engine);
  await forkCase(engine);
  await capabilityCase(engine);
  await interactionCase(engine);
}

await record('ENG-AUTH-001', 'unauthenticated engines report a login hint rather than a fake ready state', async (): Promise<CaseOutcome> => {
  if (!live) return { status: 'na' as const, reason: 'requires a deliberately logged-out CLI fixture; the scripted agent is always authenticated' };
  const plugin = await startPlugin();
  const inventory = await plugin.invoke('workers_list', { rescan: true });
  if (!inventory.ok) throw new Error(`workers_list failed: ${inventory.error.code}`);
  const loggedOut = inventory.output.workers.filter((worker) => worker.installed && worker.authenticated === false);
  if (loggedOut.length === 0) return { status: 'na' as const, reason: 'every installed CLI on this machine is logged in' };
  for (const worker of loggedOut) if (worker.hint === undefined) throw new Error(`${worker.engine} reports no login hint`);
  return { status: 'pass' as const, evidence: { engines: loggedOut.map((worker) => worker.engine) } };
});

for (const cleanup of cleanups.reverse()) await cleanup();

const report = buildReport({
  gate: 'engine',
  runId,
  startedAt,
  simulated: !live,
  cases,
  // CLI_FOR only covers the frozen four; an engine beyond them has no gate-side
  // binary name yet, so its version is reported as unknown rather than guessed.
  cliVersions: Object.fromEntries(engines.map((engine) => {
    if (!live) return [engine, 'simulated'];
    const binary = isFrozenEngine(engine) ? CLI_FOR[engine] : CLI_FOR_OPTIONAL[engine];
    return [engine, binary === undefined ? 'unknown' : cliVersion(binary)];
  })),
});
const problems = validateReport(report);
const written = await writeReport(report);
const exempted = exemptedEngines(report);
console.log(`engine gate: ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.na} N/A${report.simulated ? ' (simulated engines)' : ''}${exempted.length > 0 ? ` — exempted: ${exempted.join(', ')}` : ''}`);
console.log(`report: ${written.markdown}`);
for (const problem of problems) console.error(`report problem: ${problem}`);
for (const entry of cases) if (entry.status === 'fail') console.error(`FAIL ${entry.id}: ${entry.reason}`);
process.exitCode = exitCodeFor(report, problems);
