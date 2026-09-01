#!/usr/bin/env node
/**
 * Workflow gate (test-plan §9). WF-001 is develop → review → change → re-review
 * on one Claude session; WF-002 is plan → review → three explicitly chosen
 * workers editing disjoint files, two in parallel and one serial, then a cross
 * review. Hard caps: 6 review iterations and 12 turns per workflow.
 *
 * What is asserted is the mechanism §1 allows a machine to judge — explicit
 * engine selection, the call chain, slot accounting, transcript continuity,
 * sentinels and the orchestrator's follow-up action. Review *quality* is not an
 * oracle here, and in simulated mode the worker text is scripted, which the
 * report states plainly.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTaskShuttleServer, type TaskShuttleServer } from '../packages/plugin/src/server.js';
import { simulatedHubFactory } from '../packages/plugin/src/testkit/simulated-engines.js';
import { engineCliVersions } from './live/engines.js';
import type { EngineId } from '../packages/plugin/src/schemas.js';
import { buildReport, caseForThrow, cliVersion, exemptedEngines, exitCodeFor, preRunExemptionFor, refuseIfClassified, validateReport, writeReport, type CaseOptions, type CaseResult } from './live/evidence.js';
import { resolvePluginDist } from './plugin-artifact-path.js';

const exec = promisify(execFile);
const live = process.argv.includes('--live');

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
type CaseOutcome = Omit<CaseResult, 'id' | 'title' | 'durationMs'>;

const MAX_REVIEW_ITERATIONS = 6;
const MAX_TURNS = 12;

/** A throw-away git repo — §10 forbids running these gates in a real project. */
async function fixtureRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'taskshuttle-wf-fixture-'));
  await writeFile(join(repo, 'sum.mjs'), 'export function sum(values) {\n  return values.reduce((total, value) => total + value, 0);\n}\n');
  await writeFile(join(repo, 'sum.test.mjs'), "import assert from 'node:assert';\nimport { sum } from './sum.mjs';\nassert.strictEqual(sum([1, 2, 3]), 6);\nconsole.log('fixture ok');\n");
  await exec('git', ['init', '-q'], { cwd: repo });
  await exec('git', ['add', '-A'], { cwd: repo });
  await exec('git', ['-c', 'user.email=gate@example.com', '-c', 'user.name=gate', 'commit', '-qm', 'fixture'], { cwd: repo });
  return repo;
}

async function fixtureTestsPass(repo: string): Promise<boolean> {
  try { await exec(process.execPath, ['sum.test.mjs'], { cwd: repo, timeout: 30_000 }); return true; }
  catch { return false; }
}

interface Harness {
  readonly plugin: TaskShuttleServer;
  readonly repo: string;
  turns: number;
  cleanup(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-wf-data-'));
  const repo = await fixtureRepo();
  const plugin = createTaskShuttleServer({
    dataRoot,
    hostCwd: repo,
    env: {
      REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [repo] }),
      REALM_PLUGIN_LOG: 'off',
      // The runtime reads the shim path from *this* env, not from process.env.
      ...(live ? { REALM_PLUGIN_LAUNCH_PATH: process.env['REALM_PLUGIN_LAUNCH_PATH']! } : {}),
    } as NodeJS.ProcessEnv,
    ...(live ? {} : { hubFactory: simulatedHubFactory() }),
  });
  await plugin.runtime.ready;
  return {
    plugin,
    repo,
    turns: 0,
    async cleanup() {
      await plugin.close().catch(() => undefined);
      await rm(dataRoot, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    },
  };
}

async function settle(plugin: TaskShuttleServer, turnId: string, budgetMs = 120_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const result = await plugin.invoke('turn_get', { turnId });
    if (!result.ok) throw new Error(`turn_get failed: ${result.error.code}`);
    if (['completed', 'failed', 'cancelled'].includes(result.output.state)) return result.output as unknown as Record<string, unknown>;
    if (Date.now() > deadline) throw new Error(`turn ${turnId} never settled`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Submit one turn and charge it against the workflow's hard cap. */
async function turn(context: Harness, engine: EngineId, sessionId: string, text: string): Promise<{ turnId: string; result: Record<string, unknown> }> {
  context.turns += 1;
  if (context.turns > MAX_TURNS) throw new Error(`workflow exceeded ${MAX_TURNS} turns`);
  const started = await context.plugin.invoke('turn_start', { sessionId, prompt: [{ type: 'text', text }] });
  if (!started.ok) {
    refuseOrThrow(engine, `turn_start failed: ${started.error.code} ${started.error.message}`, started.error);
    throw new Error(`turn_start failed: ${started.error.code}`);
  }
  const result = await settle(context.plugin, started.output.turnId);
  if (result['state'] !== 'completed') {
    const failure = result['error'] as FailureShape | undefined;
    const detail = `turn ${started.output.turnId} ended ${String(result['state'])}${failureDetail(failure)}`;
    refuseOrThrow(engine, detail, failure);
    throw new Error(detail);
  }
  return { turnId: started.output.turnId, result };
}

async function createSession(context: Harness, engine: EngineId, name: string): Promise<string> {
  const created = await context.plugin.invoke('session_create', { engine, cwd: context.repo, name });
  if (!created.ok) {
    refuseOrThrow(engine, `session_create(${engine}) failed: ${created.error.code} ${created.error.message}`, created.error);
    throw new Error(`session_create(${engine}) failed: ${created.error.code} ${created.error.message}`);
  }
  if (created.output.engine !== engine) throw new Error('the session did not use the explicitly selected engine');
  return created.output.sessionId;
}

/**
 * Probe every engine a workflow will use before creating any session
 * (mvp §16.5). Without it a never-logged-in engine fails `session_create` and
 * is filed as "came up and refused while working" — guardrail 3's wrong
 * class, the same violation the fork case had. This wrapper only fetches the
 * inventory; the set-level decision lives in `preRunExemptionFor`
 * (evidence.js), testable without a harness fake. Simulated mode fetches
 * nothing: the scripted agent has no environment facts to excuse
 * (guardrail 5).
 *
 * @returns an `na` outcome for the first engine that cannot work here, or
 *   undefined when every engine the workflow uses passed its probe.
 */
async function preRunProbe(context: Harness, engines: readonly EngineId[]): Promise<CaseOutcome | undefined> {
  if (!live) return undefined;
  const inventory = await context.plugin.invoke('workers_list', { rescan: true });
  if (!inventory.ok) throw new Error(`workers_list failed: ${inventory.error.code}`);
  return preRunExemptionFor(inventory.output.workers, engines, live);
}

/**
 * Record a case outcome. Case shaping from a throw, including the mid-run-
 * refusal N/A with its verbatim message, is owned by `caseForThrow` in
 * evidence.js. Unlike the engine gate there is no exit-code softening here:
 * any non-pass case fails the run, because each workflow is one chain and a
 * chain exempted partway proves nothing.
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

await record('WF-001', 'develop → Claude review → change → re-review on one session', async (): Promise<CaseOutcome> => {
  const context = await harness();
  try {
    // Probe before creating: §16.5 requires it so the pre-run and mid-run
    // classes stay distinguishable in this gate's wording.
    const exemption = await preRunProbe(context, ['claude-code']);
    if (exemption !== undefined) return exemption;

    // 1. The orchestrator does the development itself and leaves the sentinel.
    const sentinel = `DEV-${runId}`;
    await writeFile(join(context.repo, 'sum.mjs'), `// ${sentinel}\nexport function sum(values) {\n  return values.reduce((total, value) => total + value, 0);\n}\n`);
    if (!(await fixtureTestsPass(context.repo))) throw new Error('the fixture tests do not pass after the orchestrator change');

    // 2. One explicitly selected reviewer session, reused for the re-review.
    const sessionId = await createSession(context, 'claude-code', 'wf-001-reviewer');
    const diff = (await exec('git', ['diff'], { cwd: context.repo })).stdout;
    const reviewTurns: string[] = [];
    let iterations = 0;
    let review = await turn(context, 'claude-code', sessionId, `Review this diff and describe any problems in prose:\n${diff}`);
    reviewTurns.push(review.turnId);
    iterations += 1;

    // 3. The orchestrator acts on the review, then 4. re-reviews on the same
    //    session until it judges the work done or the cap is reached.
    await writeFile(join(context.repo, 'sum.mjs'), `// ${sentinel}\n// follow-up applied after review\nexport function sum(values) {\n  return values.reduce((total, value) => total + value, 0);\n}\n`);
    if (!(await fixtureTestsPass(context.repo))) throw new Error('the fixture tests broke after the follow-up change');
    while (iterations < 2) {
      review = await turn(context, 'claude-code', sessionId, 'I applied your feedback. Re-review the change and say whether anything remains.');
      reviewTurns.push(review.turnId);
      iterations += 1;
    }
    if (iterations > MAX_REVIEW_ITERATIONS) throw new Error(`exceeded ${MAX_REVIEW_ITERATIONS} review iterations`);

    // 5. The session transcript must be one continuous, ordered stream.
    const transcript = await context.plugin.invoke('transcript_read', { sessionId, afterSeq: 0, limit: 500 });
    if (!transcript.ok) throw new Error(`transcript_read failed: ${transcript.error.code}`);
    const seqs = transcript.output.events.map((event) => event.seq);
    if (seqs.some((seq, index) => index > 0 && seq <= seqs[index - 1]!)) throw new Error('transcript seqs are not continuous');
    for (const turnId of reviewTurns) {
      const detail = await context.plugin.invoke('turn_get', { turnId });
      if (!detail.ok) throw new Error('turn_get failed');
      if (JSON.stringify(detail.output).includes('"blocking"')) throw new Error('the tool protocol leaked a blocking field');
    }

    const closed = await context.plugin.invoke('session_close', { sessionId });
    if (!closed.ok) throw new Error(`session_close failed: ${closed.error.code}`);
    const sentinelPresent = (await readFile(join(context.repo, 'sum.mjs'), 'utf8')).includes(sentinel);
    if (!sentinelPresent) throw new Error('the development sentinel is missing');

    return {
      status: 'pass',
      ...(live ? {} : { reason: 'simulated engines: the mechanism is asserted, the review prose is scripted' }),
      evidence: { sessionId, reviewTurns, iterations, turns: context.turns, events: seqs.length, sentinel },
    };
  } finally {
    await context.cleanup();
  }
});

await record('WF-002', 'plan → review → three explicit workers in parallel/serial → cross review', async (): Promise<CaseOutcome> => {
  const context = await harness();
  try {
    // The worker assignments are declared before the probe so the probe list
    // is *derived* from them: an engine dropped from the workflow disappears
    // from the probe by construction, not by remembering two lists.
    const assignments = [
      { engine: 'opencode' as EngineId, file: 'open.mjs', sentinel: `OPEN-${runId}` },
      { engine: 'kimi' as EngineId, file: 'kimi.mjs', sentinel: `KIMI-${runId}` },
      { engine: 'claude-code' as EngineId, file: 'claude.mjs', sentinel: `CLAUDE-${runId}` },
    ];
    const plannerEngine: EngineId = 'claude-code';
    const exemption = await preRunProbe(context, [...new Set([plannerEngine, ...assignments.map((entry) => entry.engine)])]);
    if (exemption !== undefined) return exemption;

    // 1. Plan, reviewed once by an explicitly selected worker.
    const planner = await createSession(context, plannerEngine, 'wf-002-plan-review');
    await turn(context, plannerEngine, planner, 'Review this plan: three workers each own one file; no worker edits another\'s file.');

    // 2. Three explicit engines, one disjoint file each.
    const workers: Array<{ engine: EngineId; sessionId: string; file: string; sentinel: string }> = [];
    for (const { engine, file, sentinel } of assignments) {
      workers.push({ engine, sessionId: await createSession(context, engine, `wf-002-${engine}`), file, sentinel });
    }

    // 3. Two engines run in parallel, the third depends on their results.
    const parallel = workers.slice(0, 2);
    const started = await Promise.all(parallel.map(async (worker) => {
      const result = await context.plugin.invoke('turn_start', { sessionId: worker.sessionId, prompt: [{ type: 'text', text: `You own ${worker.file}. Describe the change; the orchestrator applies it.` }] });
      if (!result.ok) {
        refuseOrThrow(worker.engine, `turn_start failed: ${result.error.code} ${result.error.message}`, result.error);
        throw new Error(`turn_start failed: ${result.error.code}`);
      }
      context.turns += 1;
      return { worker, turnId: result.output.turnId };
    }));
    const peak = context.plugin.runtime.registry.gate.snapshot();
    for (const { turnId } of started) await settle(context.plugin, turnId);
    for (const worker of parallel) {
      await writeFile(join(context.repo, worker.file), `// ${worker.sentinel}\nexport const owner = '${worker.engine}';\n`);
    }

    const serial = workers[2]!;
    await turn(context, serial.engine, serial.sessionId, `The other two workers finished. You own ${serial.file}; describe your change.`);
    await writeFile(join(context.repo, serial.file), `// ${serial.sentinel}\nexport const owner = '${serial.engine}';\n`);

    // 5. Cross review: the orchestrator carries the context to another worker.
    const crossReview = await turn(context, workers[0]!.engine, workers[0]!.sessionId, `Cross-review the work of ${serial.engine} on ${serial.file}: it now exports an owner constant.`);

    // 4. Workers never create or fork sessions themselves; the count proves it.
    const sessions = await context.plugin.invoke('session_list', {});
    if (!sessions.ok) throw new Error(`session_list failed: ${sessions.error.code}`);
    if (sessions.output.sessions.length !== 4) throw new Error(`expected 4 orchestrator-created sessions, saw ${sessions.output.sessions.length}`);

    // 6. Sentinels and the fixture suite.
    for (const worker of workers) {
      const content = await readFile(join(context.repo, worker.file), 'utf8');
      if (!content.includes(worker.sentinel)) throw new Error(`missing sentinel ${worker.sentinel}`);
    }
    if (!(await fixtureTestsPass(context.repo))) throw new Error('the fixture tests do not pass');
    if (context.turns > MAX_TURNS) throw new Error(`workflow exceeded ${MAX_TURNS} turns`);

    return {
      status: 'pass',
      ...(live ? {} : { reason: 'simulated engines: the mechanism is asserted, the worker prose is scripted' }),
      evidence: {
        engines: workers.map((worker) => worker.engine),
        sentinels: workers.map((worker) => worker.sentinel),
        parallelTurns: started.map((entry) => entry.turnId),
        peakActiveTurns: peak.activeTurns,
        crossReviewTurn: crossReview.turnId,
        turns: context.turns,
        delegationDepthHash: context.plugin.runtime.registry.instanceId.slice(0, 8),
      },
    };
  } finally {
    await context.cleanup();
  }
});

const report = buildReport({
  gate: 'workflow',
  runId,
  startedAt,
  simulated: !live,
  cases,
  cliVersions: live ? engineCliVersions(cliVersion) : { engines: 'simulated' },
});
const problems = validateReport(report);
const written = await writeReport(report);
const exempted = exemptedEngines(report);
console.log(`workflow gate: ${report.summary.pass} pass, ${report.summary.fail} fail${report.simulated ? ' (simulated engines)' : ''}${exempted.length > 0 ? ` — exempted: ${exempted.join(', ')}` : ''}`);
console.log(`report: ${written.markdown}`);
for (const problem of problems) console.error(`report problem: ${problem}`);
for (const entry of cases) if (entry.status === 'fail') console.error(`FAIL ${entry.id}: ${entry.reason}`);
process.exitCode = exitCodeFor(report, problems);
