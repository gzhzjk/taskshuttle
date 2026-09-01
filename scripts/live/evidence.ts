import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { hostname, platform, release, arch } from 'node:os';

/**
 * Evidence model for the live gates (test-plan §7-9). A gate run is only worth
 * anything if someone else can check it later, so every case carries its
 * verdict, the IDs it touched and, for anything not passed, an explicit reason.
 * `na` is a first-class verdict precisely so a gate never has to pretend.
 */
export type CaseStatus = 'pass' | 'fail' | 'na' | 'manual-pending';

export interface CaseResult {
  readonly id: string;
  readonly title: string;
  readonly status: CaseStatus;
  /** Required for anything that is not a pass; §1 forbids unexplained N/A. */
  readonly reason?: string;
  /**
   * Set by the recorder on the per-engine round trip (ENG-<ENGINE>-001) only.
   * ADR 0011 guardrail 4's predicate reads this marker instead of parsing ids:
   * ENG-AUTH-001 has the identical id shape and is not a round trip.
   */
  readonly roundTrip?: boolean;
  /**
   * Set by the recorder at the moment it files a mid-run refusal as N/A
   * (ADR 0011): the engine that came up and refused while working. Recorder-set
   * while the typed error is in hand, never backfilled from reason text —
   * guardrail 4's objection was to backfilling, not to marking. Pre-run N/A
   * classes (not installed, not logged in) carry no marker and are therefore
   * never reported as exemptions (guardrail 3).
   */
  readonly exemptedEngine?: string;
  /** Stable IDs and seq ranges the case produced. */
  readonly evidence?: Record<string, string | number | boolean | readonly string[]>;
  readonly durationMs?: number;
}

export interface GateReport {
  readonly gate: 'host' | 'engine' | 'workflow' | 'console';
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** True when engines were the scripted ACP fixture rather than real CLIs. */
  readonly simulated: boolean;
  readonly environment: {
    readonly os: string;
    readonly osRelease: string;
    readonly arch: string;
    readonly host: string;
    readonly node: string;
    readonly cliVersions: Record<string, string>;
  };
  readonly provenance: {
    readonly realmVersion: string;
    readonly wrappers: Record<string, string>;
    readonly hostBaselines: Record<string, string>;
    readonly artifactDigest: string;
    readonly pluginVersion: string;
    readonly gitCommit?: string;
  };
  readonly cases: readonly CaseResult[];
  readonly summary: { readonly pass: number; readonly fail: number; readonly na: number; readonly manualPending: number };
}

export class ReportError extends Error {}

/** SHA-256 over the built runtime entries, so a report names the artifact it exercised. */
export function artifactDigest(root: string = process.cwd()): string {
  const hash = createHash('sha256');
  for (const entry of ['dist/cli.js', 'dist/launch.js']) {
    try { hash.update(readFileSync(join(root, entry))); }
    catch { hash.update(`missing:${entry}`); }
  }
  return hash.digest('hex');
}

export function cliVersion(command: string, args: readonly string[] = ['--version']): string {
  try {
    return execFileSync(command, [...args], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0] ?? 'unknown';
  } catch {
    return 'not-installed';
  }
}

function gitCommit(root: string): string | undefined {
  try { return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return undefined; }
}

export interface ReportInput {
  readonly gate: GateReport['gate'];
  readonly runId: string;
  readonly startedAt: string;
  readonly simulated: boolean;
  readonly cases: readonly CaseResult[];
  readonly cliVersions?: Record<string, string>;
  readonly root?: string;
}

export function buildReport(input: ReportInput): GateReport {
  const root = resolve(input.root ?? process.cwd());
  const release_ = JSON.parse(readFileSync(join(root, 'release/metadata.json'), 'utf8')) as {
    realmVersion: string; wrappers: Record<string, string>; hosts: Record<string, string>;
  };
  const pkg = JSON.parse(readFileSync(join(root, 'packages', 'plugin', 'package.json'), 'utf8')) as { version: string };
  const commit = gitCommit(root);
  return {
    gate: input.gate,
    runId: input.runId,
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
    simulated: input.simulated,
    environment: {
      os: platform(),
      osRelease: release(),
      arch: arch(),
      host: hostname(),
      node: process.version,
      cliVersions: input.cliVersions ?? {},
    },
    provenance: {
      realmVersion: release_.realmVersion,
      wrappers: release_.wrappers,
      hostBaselines: release_.hosts,
      artifactDigest: artifactDigest(root),
      pluginVersion: pkg.version,
      ...(commit === undefined ? {} : { gitCommit: commit }),
    },
    cases: input.cases,
    summary: {
      pass: input.cases.filter((entry) => entry.status === 'pass').length,
      fail: input.cases.filter((entry) => entry.status === 'fail').length,
      na: input.cases.filter((entry) => entry.status === 'na').length,
      manualPending: input.cases.filter((entry) => entry.status === 'manual-pending').length,
    },
  };
}

/**
 * ADR 0011 guardrail 1, as amended by ADR 0029: the only acceptable mid-run
 * refusal criterion is Realm's own classification, carried across the tool
 * boundary in the error's `cause` projection (`error-mapper`). The gate must
 * never regex or keyword match over the message itself — a substring like
 * /auth/i hits author, authorization, any path containing "auth".
 *
 * Two classifications qualify, because upstream reports a spent quota as a
 * rate limit rather than a dead credential: `UnauthenticatedError`, and
 * `EngineOperationError` carrying `kind: 'rate-limit'`. The name is required
 * alongside the kind — the gate reads parsed JSON, where `instanceof` is
 * unavailable and a bare `kind` check would accept anything shaped like one.
 *
 * A refusal Realm could not classify carries no `kind` and is **not** exempt:
 * an unclassified failure is a failure.
 *
 * @param error - the failure envelope a failed tool call or settled turn carries.
 * @returns the error's original message, verbatim and never rewritten, when the
 *   cause carries either classification; otherwise undefined. Absent, null and
 *   nameless causes are not refusals.
 */
export function classifiedRefusal(
  error: { code?: string; message?: string; cause?: unknown } | undefined,
): { message: string; classification: 'unauthenticated' | 'rate-limit' } | undefined {
  const cause = error?.cause;
  if (cause === null || typeof cause !== 'object') return undefined;
  const { name, kind } = cause as { name?: unknown; kind?: unknown };
  const message = error?.message ?? '';
  if (name === 'UnauthenticatedError') return { message, classification: 'unauthenticated' };
  if (name === 'EngineOperationError' && kind === 'rate-limit') return { message, classification: 'rate-limit' };
  return undefined;
}

/**
 * Thrown by a gate body when, under --live only, an operation or turn fails
 * with one of Realm's refusal classifications (ADR 0011 guardrail 1, amended by ADR 0029). The recorder catches
 * it and files the case as N/A with `originalMessage` verbatim instead of
 * FAIL. Constructing it outside a live run would exempt what under the scripted
 * agent can only be a defect (guardrail 5), so callers check liveness first.
 */
export class MidRunRefusal extends Error {
  /** The engine's original message, preserved verbatim (guardrail 2). */
  readonly originalMessage: string;
  /** The engine that refused; the recorder copies this onto the case so the summary can name it. */
  readonly exemptedEngine: string | undefined;
  /**
   * Which classification Realm made (ADR 0029). Reported rather than judged:
   * before upstream declared rate-limit patterns the two were one class, and a
   * report that says which one is a record of what Realm said, not a claim by
   * the gate about the account.
   */
  readonly classification: 'unauthenticated' | 'rate-limit';

  constructor(
    exemptedEngine: string | undefined,
    originalMessage: string,
    detail: string,
    classification: 'unauthenticated' | 'rate-limit' = 'unauthenticated',
  ) {
    super(detail);
    this.name = 'MidRunRefusal';
    this.originalMessage = originalMessage;
    this.exemptedEngine = exemptedEngine;
    this.classification = classification;
  }
}

/**
 * The engines a run exempted mid-run (ADR 0011 guardrail 4): named in the
 * summary so a reader need not scan rows. Being named gains the engine no
 * support claim — that is judged per-engine by ADR 0012 §3.
 *
 * Reads only the recorder-set `exemptedEngine` field, never reason text;
 * deduplicated in first-appearance order.
 */
export function exemptedEngines(report: GateReport): string[] {
  return [...new Set(report.cases.flatMap((entry) => (entry.exemptedEngine === undefined ? [] : [entry.exemptedEngine])))];
}

/** Recorder options carried onto a case on every path, not just success. */
export interface CaseOptions {
  /** Marks the mandatory per-engine round trip (guardrail 4's predicate input). */
  roundTrip?: boolean;
}

/** What the inventory or descriptor probe reports about one engine. */
export interface EngineProbe {
  readonly installed: boolean;
  readonly authenticated: boolean | 'unknown';
}

/** One entry of a `workers_list` inventory. */
export interface InventoryEntry extends EngineProbe {
  readonly engine: string;
}

/** The na outcome a pre-run exemption produces, or undefined when the case should proceed. */
export type PreRunExemption = {
  readonly status: 'na';
  readonly reason: string;
  readonly evidence?: Record<string, string | number | boolean | readonly string[]>;
};

/**
 * The pre-run exemption (ADR 0011 guardrails 3 and 5), shared by every case
 * that is about to operate an engine — the round trip checked both probes
 * while the fork case checked only `installed`, so a logged-out engine walked
 * into `session_create` and was filed as "came up and refused while working",
 * which the probe had already contradicted.
 *
 * @param probe - what the inventory/descriptor probe established about the engine.
 * @param engine - the engine's id, named in the reason.
 * @param live - false means the scripted agent, which is always authenticated,
 *   so a logged-out probe there is a defect to be surfaced, not an environment
 *   fact to excuse (guardrail 5).
 * @returns an `na` outcome for not-installed (any mode) and for not-logged-in
 *   (live only); undefined when the login state is unknown — measured reality
 *   on most machines, never treated as logged-out — or the engine is healthy.
 *   The wording names "not installed" / "not logged in" and must never say
 *   "refused while working": that phrase belongs to the mid-run class alone.
 */
export function preRunExemption(probe: EngineProbe, engine: string, live: boolean): PreRunExemption | undefined {
  if (!probe.installed) return { status: 'na', reason: `${engine} CLI is not installed on this machine`, evidence: { installed: false } };
  if (live && probe.authenticated === false) return { status: 'na', reason: `${engine} CLI is not logged in`, evidence: { authenticated: false } };
  return undefined;
}

/**
 * The set-level form of {@link preRunExemption} for a case that uses several
 * engines (mvp §16.5, the workflow gate). Takes the inventory the script
 * already fetched — not a plugin — so the decision is testable without a
 * harness fake; fetching stays in the script.
 *
 * @param workers - the `workers_list` inventory.
 * @param engines - every engine id the case will operate, probed in order.
 * @param live - false returns undefined without inspecting anything: simulated
 *   mode has no environment facts to excuse (guardrail 5), so even an absent
 *   entry is not reached here.
 * @returns the first exemption found, or undefined when every engine passed.
 * @throws {Error} naming any requested engine that is absent from the
 *   inventory — that is a plugin defect and must not become an exemption.
 */
export function preRunExemptionFor(workers: readonly InventoryEntry[], engines: readonly string[], live: boolean): PreRunExemption | undefined {
  if (!live) return undefined;
  for (const engine of engines) {
    const worker = workers.find((entry) => entry.engine === engine);
    if (worker === undefined) throw new Error(`engine ${engine} missing from inventory`);
    const exemption = preRunExemption(worker, engine, live);
    if (exemption !== undefined) return exemption;
  }
  return undefined;
}

export interface CaseForThrowInput {
  readonly id: string;
  readonly title: string;
  /** Whatever the case body threw. */
  readonly caught: unknown;
  readonly options?: CaseOptions;
  readonly durationMs: number;
}

/**
 * The liveness gate in front of the mid-run refusal (ADR 0011 guardrail 5).
 * Both gate scripts held byte-identical copies of this check and nothing
 * executed either, so it lives here now.
 *
 * @param live - false means the scripted agent: an authentication-class error
 *   there can only be a defect, so the plain failure path stands.
 * @param engine - carried onto the thrown refusal so the summary can name it.
 * @param failure - the error envelope from the tool result or settled turn.
 * @param detail - the operation context kept in the N/A reason so the reader
 *   can tell "came up and refused while working" from the pre-run "never came up".
 * @throws {MidRunRefusal} only under --live when Realm classified the failure as a refusal (unauthenticated, or rate-limit; ADR 0011 as amended by ADR 0029).
 */
export function refuseIfClassified(live: boolean, engine: string, failure: { code?: string; message?: string; cause?: unknown } | undefined, detail: string): void {
  const refusal = live && failure !== undefined ? classifiedRefusal(failure) : undefined;
  if (refusal === undefined) return;
  throw new MidRunRefusal(engine, refusal.message, detail, refusal.classification);
}

/**
 * Shape a {@link CaseResult} from a throw — the one owner of what every gate's
 * recorder used to duplicate. A mid-run refusal becomes `na` with its
 * `exemptedEngine` and the verbatim original message in the reason (ADR 0011
 * guardrails 2–3); anything else becomes `fail` with the error's message.
 * `options` are carried onto the case either way: measured against a live kimi
 * quota failure, dropping them on the catch paths erased the round-trip marker
 * exactly when guardrail 4 needed it, and the run exited zero after verifying
 * nothing.
 */
export function caseForThrow({ id, title, caught, options = {}, durationMs }: CaseForThrowInput): CaseResult {
  const refused = caught instanceof MidRunRefusal ? caught : undefined;
  if (refused === undefined) {
    return { id, title, status: 'fail', reason: caught instanceof Error ? caught.message : String(caught), ...options, durationMs };
  }
  return {
    id,
    title,
    status: 'na',
    // exactOptionalPropertyTypes forbids assigning undefined to an optional field; absence is the "no marker" state.
    ...(refused.exemptedEngine === undefined ? {} : { exemptedEngine: refused.exemptedEngine }),
    reason: `${caught instanceof Error ? caught.message : String(caught)}; the engine came up and refused while working `
      + `(Realm classified it as ${refused.classification === 'rate-limit' ? 'a rate limit' : 'an authentication failure'}; `
      + 'the gate reports that classification and judges nothing beyond it). '
      + `Original message: ${refused.originalMessage}`,
    ...options,
    durationMs,
  };
}

/**
 * A report is only publishable when every non-pass case says why and the
 * provenance §1.7 requires is present. This is the check that stops a green
 * summary from hiding an unexplained gap.
 */
export function validateReport(report: GateReport): string[] {
  const problems: string[] = [];
  if (report.cases.length === 0) problems.push('report contains no cases');
  for (const entry of report.cases) {
    if (entry.status !== 'pass' && (entry.reason === undefined || entry.reason.trim().length === 0)) {
      problems.push(`case ${entry.id} is ${entry.status} without a reason`);
    }
  }
  // A published version, not a commit sha: Realm ships from a registry now, so the
  // version plus the lockfile's integrity hash is what names the source that was built.
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(report.provenance.realmVersion)) problems.push('provenance is missing the runskein version');
  if (Object.keys(report.provenance.wrappers).length === 0) problems.push('provenance is missing the wrapper pins');
  if (!/^[a-f0-9]{64}$/.test(report.provenance.artifactDigest)) problems.push('provenance is missing the artifact digest');
  if (Object.keys(report.environment.cliVersions).length === 0) problems.push('environment records no CLI versions');
  return problems;
}

export function renderReport(report: GateReport): string {
  const lines: string[] = [];
  lines.push(`# ${report.gate} gate — ${report.runId}`, '');
  lines.push(`- mode: ${report.simulated ? '**simulated engines** (scripted ACP fixture)' : 'live engines'}`);
  lines.push(`- started: ${report.startedAt} → finished: ${report.finishedAt}`);
  lines.push(`- host: ${report.environment.os} ${report.environment.osRelease} ${report.environment.arch}, node ${report.environment.node}`);
  lines.push(`- plugin ${report.provenance.pluginVersion}${report.provenance.gitCommit === undefined ? '' : ` @ ${report.provenance.gitCommit.slice(0, 12)}`}`);
  lines.push(`- runskein ${report.provenance.realmVersion}, wrappers ${Object.entries(report.provenance.wrappers).map(([name, version]) => `${name}@${version}`).join(', ')}`);
  lines.push(`- artifact digest ${report.provenance.artifactDigest.slice(0, 16)}`);
  lines.push(`- CLI versions: ${Object.entries(report.environment.cliVersions).map(([name, version]) => `${name} ${version}`).join(', ') || 'none recorded'}`);
  lines.push('', `**${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.na} N/A, ${report.summary.manualPending} awaiting manual confirmation**`, '');
  const exempted = exemptedEngines(report);
  if (exempted.length > 0) lines.push(`exempted: ${exempted.join(', ')}`, '');
  lines.push('| case | status | detail |', '| --- | --- | --- |');
  for (const entry of report.cases) {
    const detail = entry.reason ?? Object.entries(entry.evidence ?? {}).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('/') : String(value)}`).join(' ');
    lines.push(`| ${entry.id} ${entry.title} | ${entry.status} | ${detail.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Write both machine- and human-readable forms next to each other. */
export async function writeReport(report: GateReport, directory = join(process.cwd(), 'release', 'gates')): Promise<{ json: string; markdown: string }> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const json = join(directory, `${report.gate}-${report.runId}.json`);
  const markdown = join(directory, `${report.gate}-${report.runId}.md`);
  await writeFile(json, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await writeFile(markdown, renderReport(report), { mode: 0o600 });
  return { json, markdown };
}

/**
 * Non-zero exit only for real failures; N/A and manual-pending are reported,
 * not fatal — except where a run exempted its way out of verifying anything
 * (ADR 0011 guardrail 4). Both extra predicates read only `status` (plus the
 * recorder's round-trip marker), never reason text.
 *
 * ENG: if the report contains at least one round-trip case and none passed,
 * nothing was verified — capability and interaction cases keep passing while
 * the engine is unusable, so counting passes proves nothing.
 * WF: each workflow is one chain; a chain exempted partway proves nothing, so
 * any case that is not a pass exits non-zero. This has no "another engine
 * covered it" fallback because the gate runs no per-engine set. Premise, not
 * invariant: WF holds no other legitimate N/A source today; if one appears,
 * this predicate must be rewritten with it.
 */
export function exitCodeFor(report: GateReport, problems: readonly string[]): number {
  if (report.summary.fail > 0 || problems.length > 0) return 1;
  if (report.gate === 'workflow') {
    return report.cases.every((entry) => entry.status === 'pass') ? 0 : 1;
  }
  const roundTrips = report.cases.filter((entry) => entry.roundTrip === true);
  if (roundTrips.length > 0 && roundTrips.every((entry) => entry.status !== 'pass')) return 1;
  return 0;
}
