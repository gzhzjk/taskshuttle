import { lstatSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { NotFoundError, builtinAdapters, createHub, policies, type Session as RunskeinSession, type TranscriptEvent } from 'runskein';

import { domainCodeFor, legacyCodeFor, mapError, toPluginException } from './error-mapper.js';
import { FROZEN_ENGINE_IDS, isFrozenEngine, type EngineId, type ErrorCode, type PromptBlock } from './schemas.js';
import { capabilityIsKnownBroken, capabilityPaths, engineAdmission, evaluateRequirements, verificationState, type EngineAdmission } from './engine-support.js';
// Keep broker construction behind an explicit Plugin-local seam so tests can
// record interactions without replacing a process-wide constructor.
import { createInteractionBroker, InteractionBroker, type InteractionBrokerOptions, type InteractionResponse } from './interaction-broker.js';
import { NannySnapshotWriter } from './nanny-snapshot.js';
import { createCoreApplication, SessionRegistry, type CoreApplication, type CoreError, type CoreEnvironment, type CoreSessionView, type CoreTurnView, type RegistryObserver, type SessionRecord, type TurnRecord } from '@taskshuttle/core';
import { TurnScheduler, type TurnExecutor } from '@taskshuttle/core';
import { assertSessionCreationAllowed, createWorkerEnvironment, SecurityPolicy, SecurityPolicyError, type DelegationIdentity } from './security-policy.js';
import { consoleAllowed, isDelegated, markerOnlyDelegation, type DelegationDiagnostics, type DelegationRecord } from './delegation-evidence.js';
import type { ToolHandlers } from './tool-facade.js';
import {
  InstanceManager,
  LifecycleManager,
  RetentionScheduler,
  createProcessOrphanKiller,
  reapOrphans,
  recoverAndApplyRetention,
  type OrphanReapOutcome,
  type RecoveryResult,
} from './lifecycle.js';
import { AnchorStore } from './anchor-store.js';
import { createLogger, faultEvent, loggingEnabled, type LogSink, type PluginLogger } from './logger.js';
import { INVALID_TRANSITION_CODE } from '@taskshuttle/core/state-machine.js';
import { compatEnv, createCompatReport, loadPluginConfig, resolveDataRoot, resolveHostCwd, type CompatReport, type HostCwdSource, type PluginConfig } from './plugin-config.js';
import { declaredEngines, engineConfigSection, generateProjectConfig, loadProjectConfig, loadRepoConfig, mergeProfileDefaults, mergeProjectConfig, projectKeyFor, readProjectConfigFile, resolveProfileDefaults, resolveRepoProfile, validateProjectConfig, writeProjectConfigFile, type ConfigOptionLike } from './project-config.js';
import { pinWrapperArgs, unversionedWrapperPackages, wrapperArgsArePinned } from './wrapper-pins.js';
import { createPluginTranscriptStore, nodeSqliteDatabase, type PluginTranscriptStore } from './store/plugin-transcript-store.js';
import { ConsoleServer } from './console/server.js';
import { ConsoleDataSource } from './console/data-source.js';
import { readTranscriptPage } from './transcript-page.js';
import { assertLegacyRootsSafe, resolveLegacyProbeRoots } from './legacy-preflight.js';
import { createSessionWithNormalizedCwd } from './cwd-boundary.js';
import { RunskeinSessionAdapter } from './plugin/runskein-session-adapter.js';
import { RunskeinAgentProvider } from './runskein-adapter.js';

/** Internal transcript database filename; fresh TaskShuttle installs do not read legacy realm.sqlite files. */
const STORE_FILE = 'taskshuttle.sqlite';
/** Wall-clock cap for one dead instance's orphan sweep during recovery. */
const ORPHAN_SWEEP_BUDGET_MS = 15_000;
/** How long shutdown waits for an in-flight start-up scan before giving up on retention. */
const SHUTDOWN_SCAN_WAIT_MS = 5_000;
/** Per-scan cap on `recovery_result` records for benign no-ops. */
const RECOVERY_LOG_SAMPLE = 20;
/** Outcomes that always deserve their own record: they are what a fault looks like. */
const ANOMALOUS_RECOVERY_REASONS: ReadonlySet<string> = new Set(['identity-uncertain', 'recovery-contended', 'recovery-failed']);
/** Tools that only need the store/hub, not the recovery scan (design §4.1.9). */
const READ_ONLY_TOOLS = new Set(['workers_list', 'worker_describe', 'session_list', 'session_get', 'turn_list', 'turn_get', 'interaction_list']);

function fail(code: ErrorCode, message: string, details?: Record<string, unknown>): never {
  throw toPluginException({ code, message, ...(details === undefined ? {} : { details }) });
}

/** Map Core's stable domain error vocabulary to the frozen MCP error vocabulary. */
function failCore(error: CoreError): never {
  const code = ({
    'invalid-input': 'INVALID_ARGUMENT',
    'resource-not-found': 'NOT_FOUND',
    'session-unavailable': 'SESSION_UNAVAILABLE',
    'state-conflict': 'CONFLICT',
    'stale-resource': 'GONE',
    'capacity-exceeded': 'LIMIT_EXCEEDED',
    'operation-unsupported': 'NOT_SUPPORTED',
    'turn-timeout': 'TURN_TIMEOUT',
    'interaction-timeout': 'INTERACTION_TIMEOUT',
    'payload-too-large': 'PAYLOAD_TOO_LARGE',
    'workspace-forbidden': 'PERMISSION_DENIED',
    'recursion-denied': 'RECURSION_DENIED',
    'provider-failure': 'ENGINE_ERROR',
    'storage-failure': 'STORE_ERROR',
    internal: 'INTERNAL',
  }[error.code]) as ErrorCode;
  throw toPluginException({ code, message: error.message, ...(error.details === undefined ? {} : { details: { ...error.details } }), ...(error.cause === undefined ? {} : { cause: error.cause }) });
}

/**
 * Run one Realm round trip and map its failure **where the call is made**
 * (ADR 0027 decision 2(b)).
 *
 * Without this the failure is classified by whichever tool the caller happened
 * to invoke, which cannot tell an engine fault from a bug in our own handler.
 * A typed Realm error and anything already carrying a code keep theirs — the
 * mapper consults those before any operation rule — so this only names what
 * would otherwise be unattributable.
 *
 * @param operation the call's name from ADR 0027's table, without the prefix.
 * @param call the Realm round trip.
 * @returns whatever the call returns.
 * @throws PluginException carrying `ENGINE_ERROR` when the failure was not
 *   already classified, or the original classification when it was.
 */
async function callEngine<T>(operation: string, call: () => Promise<T>, secretLiterals: readonly string[] = []): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    throw toPluginException(mapError(cause, { operation: `engine/${operation}`, secretLiterals }));
  }
}

function textFromPrompt(prompt: PromptBlock[]): string | PromptBlock[] {
  if (prompt.length === 1 && prompt[0]?.type === 'text') return prompt[0].text;
  return prompt;
}

interface RuntimeInit {
  readonly instance: InstanceManager;
  readonly store: PluginTranscriptStore;
  readonly policy: SecurityPolicy;
  readonly hub: ReturnType<typeof createHub>;
  /** Present whenever depth is 0; started at boot only when the install config enabled it, and by project_init later otherwise (ADR 0019). */
  readonly console: ConsoleServer | undefined;
  readonly nanny: NannySnapshotWriter;
}

export interface RuntimeOptions {
  /**
   * The verdict settled before any tool was served (mvp §5.2). Omitting it
   * falls back to the marker alone — today's behaviour — which is correct for
   * in-process construction and wrong for a production entry point; `cli.ts`
   * settles it.
   */
  delegation?: DelegationRecord;
  /** What settling the verdict read and where it stopped; carried onto `console_withheld` (ADR 0033). */
  delegationDiagnostics?: DelegationDiagnostics;
  config?: PluginConfig;
  dataRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam for the legacy-root set; production derives it from home and env. */
  legacyRoots?: readonly string[];
  /** Process identity seam for deterministic legacy-root startup tests. */
  legacyInspector?: import('./lifecycle.js').ProcessInspector;
  compatReport?: CompatReport;
  /** Test seam for a fake Realm hub; production always uses `createHub`. */
  hubFactory?: (options: Parameters<typeof createHub>[0]) => ReturnType<typeof createHub>;
  /** Structured log sink; defaults to newline-delimited JSON on stderr. */
  logSink?: LogSink;
  /** Explicit broker factory seam for tests and alternate embedded compositions. */
  brokerFactory?: (options: InteractionBrokerOptions) => InteractionBroker;
  /**
   * The host's working directory — the outer bound for session cwd (ADR 0007).
   * Injectable for the same reason `dataRoot` is: a test drives a temp tree, and
   * the alternative is `process.chdir()`, which mutates state the whole process
   * shares.
   */
  hostCwd?: string;
  /**
   * The plugin's own install root, for the host-cwd rule of ADR 0025. The entry
   * module computes it with `installRootFrom(import.meta.url)`; nothing further
   * down knows where the installation is.
   */
  installRoot?: string;
}

export interface RuntimeDiagnostics {
  readonly recovery: readonly RecoveryResult[];
  readonly orphans: readonly OrphanReapOutcome[];
  /** Retention passes deferred because this instance's own scan was in flight. */
  readonly retentionSkips: number;
}

/**
 * Display label for the console's `host` field, derived from the MCP client's
 * self-reported name. The substrings match the client names the supported
 * hosts are expected to report; anything unrecognized is shown verbatim
 * (trimmed, length-capped). This is what the host says about itself, never a
 * verified claim, so it stays display metadata and feeds no support or
 * evidence decision.
 */
export function hostDisplayName(clientName: string | undefined): string | undefined {
  const name = clientName?.trim();
  if (name === undefined || name.length === 0) return undefined;
  const lower = name.toLowerCase();
  if (lower.includes('claude')) return 'claude-code';
  if (lower.includes('codex')) return 'codex';
  if (lower.includes('opencode')) return 'opencode';
  if (lower.includes('kimi')) return 'kimi';
  return name.slice(0, 64);
}

/** Production composition of the registry/scheduler/bridge layers with the install config, recovery and lifecycle wired in. */
export class PluginRuntime {
  /** Settled before the first tool call; every gate below reads it, never the env. */
  readonly delegation: DelegationRecord;
  private readonly delegationDiagnostics: DelegationDiagnostics;

  /**
   * The session-creation half of the recursion boundary. Positive evidence of
   * delegation refuses; `unavailable` still serves, because refusing legitimate
   * work costs more than the residual risk — the console is where this fails
   * closed instead (mvp §5.2).
   *
   * @throws SecurityPolicyError `RECURSION_DENIED` when this instance is delegated.
   */
  private assertDelegationAllowsSessions(): void {
    if (isDelegated(this.delegation)) throw new SecurityPolicyError('nested Realm delegation is denied', 'RECURSION_DENIED');
    // Keeps the marker's own malformed/legacy checks in the path rather than
    // replacing them, so nothing the old gate refused is newly admitted.
    assertSessionCreationAllowed(this.identity);
  }

  readonly registry: SessionRegistry;
  readonly scheduler: TurnScheduler;
  readonly config: PluginConfig;
  readonly dataRoot: string;
  /** The host's working directory; also the identity of the project whose worker-defaults file session_create consults (ADR 0018). */
  readonly hostCwd: string;
  /** Which source produced `hostCwd` (ADR 0025); reported once at start-up. */
  private readonly hostCwdSource: HostCwdSource;
  /**
   * Derived from `hostCwd` once at start-up: the host cwd cannot change for
   * the life of the process, and deriving it per `session_create` would both
   * pay a `realpath` syscall per call and turn a host cwd deleted mid-run into
   * a per-create failure that the error mapper cannot tell from an engine
   * fault. A cwd that does not resolve now fails start-up, matching the
   * install surface's cwd check.
   */
  private readonly projectKey: string;
  readonly instanceId: string;
  /** Literals that must be scrubbed from every outward-facing string. */
  readonly secretLiterals: readonly string[];
  readonly ready: Promise<RuntimeInit>;
  /** Resolves when the crash-recovery/retention/orphan scan finished. */
  private recovered: Promise<void> = Promise.resolve();
  private recoveryScanSettled = true;
  private readonly sessions = new Map<string, RunskeinSession>();
  /**
   * Cancel handles for the observation subscriptions (design §4.2). Owned by
   * the runtime and kept in step with `this.sessions` — never by the
   * InteractionBroker, whose dispose() may run while a live session survives
   * (design §4.2.1: publishSession's failure branch drops the broker but keeps
   * the Realm binding).
   */
  private readonly sessionObservationUnsubs = new Map<string, () => void>();
  private readonly brokers = new Map<string, InteractionBroker>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly descriptors = new Map<EngineId, Record<string, unknown>>();
  private readonly lifecycle: LifecycleManager;
  private readonly retention: RetentionScheduler;
  private readonly launchTokenHash: string;
  private readonly launchToken: string;
  private readonly hubFactory: (options: Parameters<typeof createHub>[0]) => ReturnType<typeof createHub>;
  /** Plugin-owned Runskein boundary; the legacy runtime consumes it during extraction. */
  private agentProvider: RunskeinSessionAdapter | undefined;
  /** Provider-neutral Core composition, backed by the same Plugin registry and scheduler. */
  private coreApplication: CoreApplication | undefined;
  private coreProvider: RunskeinAgentProvider | undefined;
  private logger: PluginLogger;
  private readonly injectedSink: LogSink | undefined;
  private readonly legacyRoots: readonly string[] | undefined;
  private readonly legacyInspector: import('./lifecycle.js').ProcessInspector | undefined;
  private readonly compatReport: CompatReport;
  private readonly brokerFactory: (options: InteractionBrokerOptions) => InteractionBroker;
  private diagnostics: RuntimeDiagnostics = { recovery: [], orphans: [], retentionSkips: 0 };
  private retentionSkips = 0;
  private readonly archiveInstanceIds = new Set<string>();
  private readonly orphanOutcomes: OrphanReapOutcome[] = [];
  private readonly deletedTranscripts = new Set<string>();
  /** Extra registry observers (the console); see addRegistryObserver. */
  private readonly extraObservers = new Set<RegistryObserver>();
  /** Fork children still being built; no tool may observe them (design §6.3). */
  private readonly unpublished = new Set<string>();
  private readonly sessionLanes = new Map<string, Promise<unknown>>();
  /**
   * Turns this instance has dispatched, ever. Monotonic and independent of the
   * registry: a count walked from turn records shrinks the moment any of those
   * records stop being reachable, and shrinking drift reads as progress — the
   * one direction this signal must not fail in. Nothing drops them today (ADR
   * 0013 proposed it and was never implemented), so the independence is a
   * precaution; ADR 0016 froze it as one regardless.
   *
   * This is the single counter, and both writers read it: the anchor record's
   * `turnsAtWrite` and the nanny snapshot's `turnsDispatched` are subtracted by
   * the hook, so they must be two readings of one counter rather than two
   * counters. ADR 0016 fixes the arithmetic and the field names but not the
   * event that increments; this is where that choice lives.
   *
   * It increments when `turn_start` accepts a turn, not on `queued -> running`.
   * Accepting is the earlier event, so the current value reads high and the
   * difference over-counts — the direction this signal is allowed to fail in.
   * Counting the dispatch instead would also drop a turn cancelled while
   * queued: work the orchestrator started and abandoned would leave no trace,
   * which is exactly the drift the signal exists to catch.
   */
  private turnsDispatchedCount = 0;
  private anchor: AnchorStore | undefined;
  /**
   * The shipped worker-defaults template `project_init` generates from. It sits
   * beside the built bundle (dist/default-config.json), so the default is
   * bundle-relative — which from source under tsx resolves to a file that does
   * not exist, the same trap REALM_PLUGIN_LAUNCH_PATH covers for the launcher;
   * the env override serves source-run probes and tests the same way.
   */
  private readonly defaultsTemplatePath: string;
  private acceptMutations = true;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly identity: DelegationIdentity, options: RuntimeOptions = {}) {
    const env = options.env ?? process.env;
    this.hubFactory = options.hubFactory ?? createHub;
    this.brokerFactory = options.brokerFactory ?? createInteractionBroker;
    this.compatReport = options.compatReport ?? createCompatReport();
    this.dataRoot = resolveDataRoot(env, options.dataRoot, undefined, this.compatReport);
    this.legacyRoots = options.legacyRoots ?? (options.dataRoot === undefined ? undefined : []);
    this.legacyInspector = options.legacyInspector;
    // Config comes only from the install surface; an invalid field fails start-up
    // with a field-level error instead of being clamped.
    // One resolution for both readers: the boundary the config narrows and the
    // key the project defaults are filed under have to be the same directory,
    // or a host that spawns us inside our own installation files a project's
    // defaults under the installation (ADR 0025, measured in GZH-36).
    const resolvedHost = resolveHostCwd(env, { ...(options.installRoot === undefined ? {} : { installRoot: options.installRoot }), compatReport: this.compatReport });
    this.hostCwd = options.hostCwd ?? resolvedHost.hostCwd;
    // An injected boundary is its own source: reporting it as `cwd` would put a
    // claim in the log that the process working directory decided something it
    // did not (ADR 0025 implementation notes).
    this.hostCwdSource = options.hostCwd === undefined ? resolvedHost.source : 'option';
    this.config = options.config ?? loadPluginConfig(env, { dataRoot: this.dataRoot, hostCwd: this.hostCwd, compatReport: this.compatReport });
    // After loadPluginConfig, not before: an unresolvable host cwd is the
    // install surface's field-level error to report, and it only gets to do
    // that if the derivation here does not throw a bare errno first.
    this.projectKey = projectKeyFor(this.hostCwd);
    this.defaultsTemplatePath = compatEnv(env, 'TASKSHUTTLE_DEFAULTS_TEMPLATE', 'REALM_PLUGIN_DEFAULTS_TEMPLATE', this.compatReport) ?? fileURLToPath(new URL('./default-config.json', import.meta.url));
    this.instanceId = randomUUID();
    this.launchToken = randomBytes(16).toString('hex');
    this.launchTokenHash = createHash('sha256').update(this.launchToken).digest('hex');
    this.secretLiterals = Object.freeze([this.identity.rootNonce, this.launchToken]);
    this.delegation = options.delegation ?? markerOnlyDelegation(identity);
    // An in-process construction settles nothing, so it reports nothing: the
    // fields are absent rather than zero, which would read as "scanned and
    // found none".
    this.delegationDiagnostics = options.delegationDiagnostics ?? {};
    // The nonce and launch token are the two literals that must never reach a
    // log line even indirectly (design §10.3).
    this.injectedSink = options.logSink;
    this.logger = createLogger({
      instanceId: this.instanceId,
      ...(options.logSink === undefined ? {} : { sink: options.logSink }),
      secretLiterals: this.secretLiterals,
      enabled: options.logSink !== undefined || loggingEnabled(env, this.compatReport),
    });
    this.registry = new SessionRegistry({
      instanceId: this.instanceId,
      interactionTtlMs: this.config.interactionTtlMs,
      limits: {
        maxOpenSessions: this.config.maxOpenSessions,
        maxActiveTurns: this.config.maxActiveTurns,
        maxActiveTurnsPerEngine: this.config.maxActiveTurnsPerEngine,
        maxQueuedTurns: this.config.maxQueuedTurns,
      },
      observer: {
        onSessionTransition: (event) => { this.logger.log({ event: 'session_transition', ...event, errorCode: event.errorCode as never }); this.fanoutObserver((observer) => observer.onSessionTransition?.(event)); },
        onTurnTransition: (event) => { this.logger.log({ event: 'turn_transition', ...event, errorCode: event.errorCode as never }); this.fanoutObserver((observer) => observer.onTurnTransition?.(event)); },
        onInteractionTransition: (event) => { this.logger.log({ event: 'interaction_transition', ...event }); this.fanoutObserver((observer) => observer.onInteractionTransition?.(event)); },
        // §6.1: an out-of-table transition is recorded and mapped to INTERNAL —
        // the plugin's own invariant, no storage involved (ADR 0030). It is
        // never allowed to look like success. The code is stated here because
        // the observer receives the transition, not the error object; the two
        // are kept in step by the test that reads it off the error class.
        onInvalidTransition: (event) => this.logFault(INVALID_TRANSITION_CODE, {
          operation: `registry/transition/${event.kind}:${event.operation}`,
          from: event.from,
          to: event.to,
          ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
          ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
          ...(event.interactionId === undefined ? {} : { interactionId: event.interactionId }),
        }),
      },
    });
    this.scheduler = new TurnScheduler({ registry: this.registry, executor: this.executor(), errorCode: legacyCodeFor, domainErrorCode: domainCodeFor });
    this.ready = this.initialize(env);
    this.ready.catch(() => undefined);
    this.retention = new RetentionScheduler(
      undefined,
      () => this.runRetention(),
      86_400_000,
      // A retention failure is reported, never silently dropped (design §15).
      (error) => this.logFault(mapError(error, { operation: 'retention/run', secretLiterals: this.secretLiterals }).code, { operation: 'retention/run' }),
    );
    this.lifecycle = new LifecycleManager({
      hub: { quit: async (engineId, quitOptions) => callEngine('quit', async () => (await this.ready).hub.quit(engineId, quitOptions)) },
      stopMutations: () => { this.acceptMutations = false; },
      cancelQueuedTurns: () => { this.retention.stop(); this.scheduler.close(); },
      flush: async () => { await this.scheduler.shutdown(5_000); },
      closeStore: async () => (await this.ready).store.close(),
      releaseLock: async () => (await this.ready).instance.close({ retentionDays: this.config.retentionDays }),
      deleteEligible: async () => { await this.runRetention(true); },
    });
  }

  /** Recovery, retention and orphan diagnostics from this instance's start-up scan. */
  async startupDiagnostics(): Promise<RuntimeDiagnostics> {
    await this.ready;
    await this.recovered;
    return this.diagnostics;
  }

  /**
   * Adopt the MCP client's self-reported name as this instance's host label
   * once the initialize handshake has completed. Best-effort: the manifest
   * rewrite runs after start-up settles, and a failure is logged rather than
   * thrown — the console simply keeps the platform label in that case. The
   * returned promise never rejects; it exists so a test can await the rewrite.
   */
  noteHostIdentity(clientName: string | undefined): Promise<void> {
    const host = hostDisplayName(clientName);
    if (host === undefined) return Promise.resolve();
    return this.ready
      .then(({ instance }) => instance.setHost(host))
      .catch((error: unknown) => {
        this.logger.log({
          event: 'host_rewrite_failed',
          errorCode: mapError(error, { operation: 'instance/host-rewrite', secretLiterals: this.secretLiterals }).code,
          operation: 'instance/host-rewrite',
        });
      });
  }

  /**
   * The registry has a single observer slot, which the structured logger owns;
   * additional observers (the console's transition fan-out, console-design
   * §5.2) are composed here. Callbacks still run inside the registry mutation,
   * so an observer must only record what it is handed — never re-enter the
   * registry (registry.ts documents the hazard).
   */
  addRegistryObserver(observer: RegistryObserver): () => void {
    this.extraObservers.add(observer);
    return () => this.extraObservers.delete(observer);
  }

  private fanoutObserver(notify: (observer: RegistryObserver) => void): void {
    for (const observer of this.extraObservers) {
      try { notify(observer); } catch { /* an observer failure never affects the mutation in flight */ }
    }
  }

  /** Compose Plugin-owned effects into the provider-neutral Core ports. */
  private coreEnvironment(provider: RunskeinAgentProvider, store: PluginTranscriptStore, instance: InstanceManager): CoreEnvironment {
    return {
      clock: { now: () => Date.now() },
      ids: { next: () => randomUUID() },
      agents: provider,
      transcripts: {
        append: async (event) => { await store.append(event as unknown as TranscriptEvent); },
        read: (sessionId, options) => store.read(sessionId, options) as unknown as AsyncIterable<import('@taskshuttle/core').TranscriptEvent>,
        canonicalEvent: async (sessionId, seq) => {
          const value = await store.canonicalEvent(sessionId, seq);
          return value === undefined ? undefined : { bytes: value.bytes, sha256: value.sha256 };
        },
      },
      anchors: {
        read: async () => (await this.anchor?.read())?.content,
        write: async (value) => {
          this.anchor ??= new AnchorStore(instance.instanceDir, this.instanceId);
          await this.anchor.write(value, () => this.turnsDispatchedCount);
        },
      },
    };
  }

  private executor(): TurnExecutor {
    return {
      beforePrompt: async (turn) => {
        const { store } = await this.ready;
        // 0 over-reads (drains from earlier boundary), never under-reads; a sick store fails the drain itself which is logged (ADR 0038)
        return store.highWatermark(this.realmTranscriptId(turn.sessionId)).catch(() => 0);
      },
      run: async (turn) => {
        const session = this.sessions.get(turn.sessionId);
        if (session === undefined) fail('SESSION_UNAVAILABLE', 'Realm session is not attached');
        const result = await session.prompt(textFromPrompt([...turn.prompt]) as unknown as Parameters<RunskeinSession['prompt']>[0]);
        return { stopReason: result.stopReason, ...(result.usage === undefined ? {} : { usage: result.usage as Record<string, unknown> }) };
      },
      cancel: async (turn) => { await this.sessions.get(turn.sessionId)?.cancel(); },
      drain: async (turn, result, dispatchBeforeSeq) => {
        // A settled turn is a refresh point, and the only one that catches a
        // token report from an engine whose counts ride its prompt response.
        // Realm persists that report as a synthesized usage_update but does not
        // emit it, so the subscription never sees it; the last event that DID
        // emit is the engine's own window gauge, which arrives before the counts
        // exist. Without this the session carries no usage until it closes —
        // measured on codex, where `session_get` was usage-free while the turn
        // it had just finished reported 23,012 tokens.
        //
        // First, ahead of every store read below: the counts are already in the
        // live session's getters by the time a prompt settles, so this needs
        // nothing from the transcript — and a store that fails mid-drain would
        // otherwise skip it and reproduce the very gap it closes.
        this.syncSessionObservations(turn.sessionId);
        const { store } = await this.ready;
        const realmSessionId = this.realmTranscriptId(turn.sessionId);
        // The turn snapshot predates the watermark this dispatch captured, so
        // the boundary comes from the scheduler, not from the record.
        const beforeSeq = dispatchBeforeSeq;
        // One boundary around everything the drain does with the store, rather
        // than around the one call that was found failing first. A malformed
        // stored event throws while `finalText` reads it, not while the
        // iterator yields it, and the watermark read has its own swallow below
        // — three ways to fail a drain, of which only one was reported.
        const reportDrainFault = (cause: unknown): void => {
          this.logFault(mapError(cause, { operation: 'store/drain', secretLiterals: this.secretLiterals }).code, {
            operation: 'store/drain',
            sessionId: turn.sessionId,
            turnId: turn.id,
          });
        };
        // A watermark this dispatch cannot read is not fatal — the drain simply
        // reports the events it already knows about — but it is still a store
        // failure, and answering `beforeSeq` without a word made it invisible.
        const throughSeq = await store.highWatermark(realmSessionId).catch((cause: unknown) => {
          reportDrainFault(cause);
          return beforeSeq;
        });
        const events: TranscriptEvent[] = [];
        let finalText: string;
        try {
          if (throughSeq > beforeSeq) {
            for await (const event of store.read(realmSessionId, { fromSeq: beforeSeq + 1, toSeq: throughSeq })) events.push(event);
          }
          finalText = events.filter((event) => event.update.sessionUpdate === 'agent_message_chunk').map((event) => {
            const content = (event.update as unknown as { content?: unknown }).content;
            if (typeof content === 'string') return content;
            return typeof content === 'object' && content !== null && (content as { type?: unknown }).type === 'text' && typeof (content as { text?: unknown }).text === 'string' ? (content as { text: string }).text : '';
          }).join('');
        } catch (cause) {
          // The scheduler catches this and turns it into the turn's
          // `drained.error`; until ADR 0030's review no site logged it, and the
          // one that claimed to was reporting the turn's own outcome instead.
          // Rethrown unchanged, so the scheduler's handling is untouched.
          reportDrainFault(cause);
          throw cause;
        }
        // The turn's own outcome, not the drain's: gated on `STORE_ERROR` as it
        // always was, because a failed turn is already an outcome event
        // (`turn_transition` carries its code) and logging every one of them
        // here would deal a second line per failure — behaviour ADR 0030 does
        // not authorize and the first implementation of it introduced.
        if (result.error?.code === 'STORE_ERROR') {
          this.logFault('STORE_ERROR', { operation: 'turn/drain', sessionId: turn.sessionId, turnId: turn.id });
        }
        return {
          // §7.3: the first event actually stored in the closed interval, not
          // the boundary itself — a store that skips a seq must not be guessed.
          fromSeq: events[0]?.seq ?? null,
          throughSeq,
          ...(finalText === '' ? {} : { finalText }),
          ...(result.error === undefined ? {} : { error: result.error }),
        };
      },
    };
  }

  private async initialize(env: NodeJS.ProcessEnv): Promise<RuntimeInit> {
    // Probe the old root before creating any fresh-root directory or lock.
    // A live or uncertain legacy owner must not be hidden by the new root.
    // TASKSHUTTLE_LEGACY_DATA_ROOTS is additive: declaring a custom old root
    // must not hide the default old root. The test-only override exists solely
    // for spawned hermetic processes that cannot receive RuntimeOptions.
    const testRoots = env['TASKSHUTTLE_TEST_LEGACY_PROBE_ROOTS'];
    const candidateRoots = this.legacyRoots ?? resolveLegacyProbeRoots(
      env,
      testRoots === undefined ? {} : { testRoots: testRoots.split(delimiter).map((value) => value.trim()).filter(Boolean) },
    );
    const dataRootReal = await realpath(this.dataRoot).catch(() => resolve(this.dataRoot));
    const roots: string[] = [];
    for (const root of candidateRoots) {
      const normalized = await realpath(root).catch(() => resolve(root));
      if (normalized !== dataRootReal && !roots.includes(normalized)) roots.push(normalized);
    }
    await assertLegacyRootsSafe(roots, env['TASKSHUTTLE_FORCE_LEGACY_PROBE'] === '1', this.legacyInspector);
    // Fail before InstanceManager creates its directory and lock; otherwise an
    // unsupported runtime leaves an identity-indeterminate recovery artifact.
    nodeSqliteDatabase();
    const instance = await InstanceManager.create({
      dataRoot: this.dataRoot,
      instanceId: this.instanceId,
      rootNonce: this.identity.rootNonce,
      launchTokenHash: this.launchTokenHash,
      // Recorded so the state can be diagnosed from disk: this investigation had
      // to reconstruct it from a process tree by hand, and a record that cannot
      // be diagnosed from disk is one that will be diagnosed wrongly (ADR 0031).
      delegation: this.delegation,
    });
    // ADR 0040: constructor created logger before InstanceManager so
    // instanceDir only exists here; injectedSink keeps test ownership
    // exclusive, hence the guard.
    if (this.injectedSink === undefined && loggingEnabled(env, this.compatReport)) {
      try {
        this.logger = createLogger({ instanceId: this.instanceId, instanceDir: instance.instanceDir, secretLiterals: this.secretLiterals });
      } catch { /* best-effort, never break startup */ }
    }
    for (const variable of this.compatReport.entries) this.logger.log({ event: 'compat_fallback', variable, operation: 'compat/read' });

    // Read tools open as soon as the store and hub exist; mutation tools wait
    // for the recovery scan (design §4.1.9), which can take a while when it has
    // to inspect and reap another instance's worker shims.
    this.recoveryScanSettled = false;
    this.recovered = this.runRecoveryScan();
    this.recovered.catch(() => { this.recoveryScanSettled = true; });
    const store = createPluginTranscriptStore(join(instance.instanceDir, STORE_FILE), { dataRoot: this.dataRoot });
    // Fail start-up rather than serving tools over a store that never opened.
    await store.getMeta('bootstrap');
    const policy = await SecurityPolicy.create({ allowedRoots: this.config.allowedRoots, identity: this.identity });
    const workerEnvironment = {
      ...Object.fromEntries(Object.entries(createWorkerEnvironment({}, this.identity)).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      TASKSHUTTLE_DATA_ROOT: this.dataRoot,
      REALM_PLUGIN_DATA_ROOT: this.dataRoot,
      TASKSHUTTLE_MARKER_ROOT: instance.instanceDir,
      // Worker shims mark themselves inside this instance's directory, so a
      // reload never sweeps another instance's markers (§9.1, §14).
      REALM_PLUGIN_MARKER_ROOT: instance.instanceDir,
    };
    const launchPath = compatEnv(env, 'TASKSHUTTLE_LAUNCH_PATH', 'REALM_PLUGIN_LAUNCH_PATH', this.compatReport) ?? fileURLToPath(new URL('./launch.js', import.meta.url));
    const adapters = builtinAdapters.map((adapter) => {
      // Wrapper versions are pinned here: the bundled adapters would otherwise
      // resolve `npx -y <package>` to whatever is newest (§12).
      const pinned = pinWrapperArgs(adapter.launch.args ?? []);
      // Admission, not just a check (ADR 0004). While the engine set was frozen
      // it was enough to rewrite the four known wrappers; with the set open, an
      // adapter carrying a wrapper nobody pinned would quietly widen how much
      // unversioned third-party code a worker runs. Refuse to register it.
      const unpinned = unversionedWrapperPackages(adapter.launch.command, pinned);
      if (unpinned.length > 0 || !wrapperArgsArePinned(pinned)) {
        throw new Error(`adapter '${adapter.id}' launches an unversioned wrapper package (${unpinned.join(', ') || 'known package missing its pin'}); add it to WRAPPER_PINS before this engine can be registered`);
      }
      return {
        ...adapter,
        launch: {
          ...adapter.launch,
          command: process.execPath,
          args: [launchPath, `--realm-instance-token=${this.launchToken}`, adapter.launch.command, ...pinned],
          env: workerEnvironment,
        },
      };
    });
    const hub = this.hubFactory({ adapters, discovery: false, store, defaults: { idleTimeoutMs: 60_000 } });
    // Keep only the actual process-spawning call inside the engine mapper.
    // Cwd canonicalization and verification must remain outside it so a
    // pre-spawn SecurityPolicyError can discard the creating reservation.
    // Looking up `hub.session` at call time also keeps the legacy seam
    // observable to the adjacency tests while preserving engine error mapping.
    this.agentProvider = new RunskeinSessionAdapter({
      session: (options) => callEngine('session', () => hub.session(options)),
    }, policy);
    const coreProvider = new RunskeinAgentProvider({
      hub,
      cwdPolicy: policy,
      prepareSession: (request) => {
        const sessionId = request.sessionId;
        if (sessionId === undefined || this.brokers.has(sessionId)) return;
        this.brokers.set(sessionId, this.brokerFactory({
          registry: this.registry,
          sessionId,
          permissionMode: () => this.registry.getSession(sessionId)?.permissionMode ?? 'deny',
          secretLiterals: this.secretLiterals,
        }));
      },
      permissionPolicy: (request) => {
        const sessionId = request.sessionId;
        if (sessionId === undefined) return policies.denyAll;
        let broker = this.brokers.get(sessionId);
        if (broker === undefined) {
          broker = this.brokerFactory({
            registry: this.registry,
            sessionId,
            permissionMode: () => this.registry.getSession(sessionId)?.permissionMode ?? 'deny',
            secretLiterals: this.secretLiterals,
          });
          this.brokers.set(sessionId, broker);
        }
        return broker.permissionPolicy;
      },
      sessionLifecycle: {
        bound: (sessionId, session) => {
          if (sessionId === undefined) return;
          const record = this.registry.getSession(sessionId);
          if (record === undefined) return;
          let broker = this.brokers.get(sessionId);
          if (broker === undefined) {
            broker = this.brokerFactory({
              registry: this.registry,
              sessionId,
              permissionMode: () => this.registry.getSession(sessionId)?.permissionMode ?? 'deny',
              secretLiterals: this.secretLiterals,
            });
            this.brokers.set(sessionId, broker);
          }
          broker.attachSession(session);
          this.sessions.set(sessionId, session);
          this.sessionObservationUnsubs.set(sessionId, this.subscribeSessionObservations(sessionId, session));
          this.syncSessionObservations(sessionId);
        },
        closed: (providerSessionId) => {
          const sessionId = [...this.sessions.entries()].find(([, session]) => session.id === providerSessionId)?.[0];
          if (sessionId === undefined) return;
          this.syncSessionObservations(sessionId);
          this.sessionObservationUnsubs.get(sessionId)?.();
          this.sessionObservationUnsubs.delete(sessionId);
          this.sessions.delete(sessionId);
          this.brokers.get(sessionId)?.dispose();
          this.brokers.delete(sessionId);
        },
      },
    });
    this.coreProvider = coreProvider;
    this.coreApplication = createCoreApplication(this.coreEnvironment(coreProvider, store, instance), {
      instanceId: this.instanceId,
      registry: this.registry,
      scheduler: this.scheduler,
    });
    let consoleData: ConsoleDataSource | undefined;
    hub.on('engine:crash', ({ engineId }) => {
      this.logger.log({ event: 'engine_crash', engine: String(engineId), errorCode: 'ENGINE_ERROR', operation: 'engine/crash' });
      this.registry.markEngineCrashed(engineId as EngineId, { code: 'provider-failure', message: `engine ${engineId} crashed` });
      consoleData?.notifyEngineCrash(String(engineId));
    });
    this.logger.log({
      event: 'instance_started',
      pid: process.pid,
      hostPlatform: process.platform,
      // Absent depth carries the same meaning here as in the manifest: the
      // verdict was `unavailable`, so the instance does not know and will not
      // guess. A sentinel number would be a guess wearing a fact's clothes.
      ...(this.delegation.depth === undefined ? {} : { delegationDepth: this.delegation.depth }),
      dataRootMode: (lstatSync(this.dataRoot).mode & 0o777).toString(8),
      // Which source the outer boundary came from (ADR 0025). A boundary with
      // three possible origins has to say which one it had, or the next
      // PERMISSION_DENIED is diagnosed by guessing.
      hostCwdSource: this.hostCwdSource,
      operation: 'instance/start',
    });
    // The nanny snapshot is written for every instance, including a delegated
    // worker's. The hook that reads it exits on `depth > 0` before reading
    // anything (ADR 0015 §6), so a worker's own snapshot is normally never
    // consumed — but the hook discovers instances by lock, not by depth, and a
    // writer that skipped nested instances could only ever make the state read
    // emptier than it is. That is the one direction this signal may not fail in.
    const nanny = new NannySnapshotWriter({
      instanceId: this.instanceId,
      instanceDir: instance.instanceDir,
      source: this.registry,
      turnsDispatched: () => this.turnsDispatchedCount,
      onError: (error) => this.logFault(mapError(error, { operation: 'nanny/snapshot', secretLiterals: this.secretLiterals }).code, { operation: 'nanny/snapshot' }),
    });
    this.addRegistryObserver(nanny.observer);
    // The console binds the instance lifecycle (console-design §4): when it is
    // boot-enabled it starts after the security policy, instance lock and store
    // exist, and before the tools open — between steps 8 and 9 of design §4.1. A
    // delegated worker never opens a port, but the plugin itself is unaffected
    // (§7.7). The server object is constructed at depth 0 whether or not the
    // boot start runs: project_init may start it later (ADR 0019), on this same
    // path with this same configuration, so there is one start path, not two.
    let console: ConsoleServer | undefined;
    // Say so rather than vanishing: a console that simply never appears is the
    // state this whole defect hid in. Only worth a line when the operator asked
    // for one — withholding a console nobody enabled is noise, not a diagnosis.
    if (!consoleAllowed(this.delegation) && this.config.console.enabled) {
      this.logger.log({ event: 'console_withheld', provenance: this.delegation.provenance, operation: 'console/boot', ...this.withheldDiagnostics() });
    }
    if (consoleAllowed(this.delegation)) {
      // The read model sees the same registry and store the tools use (§5.1);
      // transitions arrive through the composed observer, transcript events
      // through the store's post-commit fan-out (§5.2).
      consoleData = new ConsoleDataSource({
        config: this.config,
        registry: this.registry,
        store,
        instance: () => instance.getManifest(),
        engines: async () => (await callEngine('engines', () => hub.engines())).map((info) => info.id).filter((id): id is string => id !== undefined),
        isTranscriptDeleted: (realmSessionId) => this.deletedTranscripts.has(realmSessionId),
        isVisible: (sessionId) => !this.unpublished.has(sessionId),
      });
      this.addRegistryObserver(consoleData.observer);
      store.onChange(consoleData.storeListener);
      console = new ConsoleServer({ config: this.config.console, instanceDir: instance.instanceDir, dataSource: consoleData });
      if (this.config.console.enabled) {
        // A start failure (e.g. an explicit port already in use) fails initialize().
        await console.start();
        // The port is all this event carries (console-design §4).
        this.logger.log({ event: 'console_started', port: console.port, operation: 'console/start' });
      }
    }
    // A close that raced start-up must not be re-armed by the timer below.
    if (!this.closed) this.retention.start();
    return { instance, store, policy, hub, console, nanny };
  }

  /**
   * The diagnostic half of a withheld console (ADR 0033): which doubt the
   * verdict reached, how much the scan read and how long it took, and the
   * instance a delegated verdict matched. Absent fields mean "not read", never
   * zero.
   */
  private withheldDiagnostics(): Partial<Pick<DelegationDiagnostics, 'cause' | 'records' | 'scanMs' | 'matchedInstanceId'>> {
    const { cause, records, scanMs, matchedInstanceId } = this.delegationDiagnostics;
    return {
      ...(cause === undefined ? {} : { cause }),
      ...(records === undefined ? {} : { records }),
      ...(scanMs === undefined ? {} : { scanMs }),
      ...(matchedInstanceId === undefined ? {} : { matchedInstanceId }),
    };
  }

  private recoveryHooks() {
    const openInstanceStore = async (workDir: string): Promise<PluginTranscriptStore | undefined> => {
      const path = join(workDir, STORE_FILE);
      const info = await stat(path).catch(() => undefined);
      if (info === undefined || !info.isFile()) return undefined;
      return createPluginTranscriptStore(path, { dataRoot: this.dataRoot });
    };
    return {
      markSessionsAborted: async (_instanceId: string, recoveredAt: string, workDir: string): Promise<void> => {
        const store = await openInstanceStore(workDir);
        if (store === undefined) return;
        try {
          await store.setMeta('sessions_state', 'aborted');
          await store.setMeta('recovered_at', recoveredAt);
        } finally { await store.close().catch(() => undefined); }
      },
      reapInstanceOrphans: async (_instanceId: string, workDir: string, launchTokenHash?: string): Promise<void> => {
        // Bounded: process inspection and TERM/KILL grace are slow, and this
        // runs inside the recovery claim window.
        const sweep = reapOrphans({
          markerRoots: [workDir],
          reapableTokenHashes: launchTokenHash === undefined ? new Set<string>() : new Set([launchTokenHash]),
          killer: createProcessOrphanKiller(),
        }).catch(() => [] as OrphanReapOutcome[]);
        const outcomes = await Promise.race([
          sweep,
          new Promise<OrphanReapOutcome[]>((resolve) => { const timer = setTimeout(() => resolve([]), ORPHAN_SWEEP_BUDGET_MS); timer.unref?.(); }),
        ]);
        this.orphanOutcomes.push(...outcomes);
        this.diagnostics = { ...this.diagnostics, orphans: [...this.orphanOutcomes] };
      },
      deleteSessionsBefore: async (_instanceId: string, cutoffMs: number, workDir: string): Promise<boolean> => {
        const store = await openInstanceStore(workDir);
        if (store === undefined) return false;
        try {
          let remaining = false;
          for (const meta of await store.sessions()) {
            if (meta.updatedAt <= cutoffMs) await store.delete(meta.sessionId);
            else remaining = true;
          }
          return remaining;
        } finally { await store.close().catch(() => undefined); }
      },
    };
  }

  /** Only an instance this process proved dead may be opened as an archive. */
  private rememberArchives(results: readonly RecoveryResult[]): void {
    for (const entry of results) {
      if (entry.lockProvenDead === true && !entry.deleted) this.archiveInstanceIds.add(entry.instanceId);
      if (entry.deleted) this.archiveInstanceIds.delete(entry.instanceId);
    }
  }

  private async runRecoveryScan(): Promise<void> {
    const startedAt = Date.now();
    const before = this.orphanOutcomes.length;
    const recovery = await recoverAndApplyRetention({
      dataRoot: this.dataRoot,
      retentionDays: this.config.retentionDays,
      currentInstanceId: this.instanceId,
      hooks: this.recoveryHooks(),
    }).catch((cause: unknown) => [{ instanceId: 'scan', recovered: false, deleted: false, reason: 'recovery-failed' as const, ...(cause instanceof Error ? { detail: cause.message } : {}) }] as RecoveryResult[]);
    this.rememberArchives(recovery);
    // Orphan sweeps already ran inside the scan, while each proven-dead
    // instance directory (and its markers) still existed.
    this.diagnostics = { recovery, orphans: [...this.orphanOutcomes], retentionSkips: this.retentionSkips };
    this.recoveryScanSettled = true;
    this.logRecovery(recovery, startedAt, before);
  }

  /**
   * A scan over hundreds of instance directories must stay a constant-cost log
   * event, but the entries worth truncating are the boring ones. Anything that
   * changed, and anything anomalous — an unreadable identity, a contended
   * claim, a failed recovery — is always logged; only the benign no-ops are
   * sampled. `retention_result` carries the totals either way.
   */
  private logRecovery(recovery: readonly RecoveryResult[], startedAt: number, orphansBefore: number): void {
    const durationMs = Math.max(0, Date.now() - startedAt);
    let sampled = 0;
    let anomalies = 0;
    for (const entry of recovery) {
      const anomalous = ANOMALOUS_RECOVERY_REASONS.has(entry.reason);
      if (anomalous) anomalies += 1;
      if (!anomalous && !entry.recovered && !entry.deleted) {
        if (sampled >= RECOVERY_LOG_SAMPLE) continue;
        sampled += 1;
      }
      this.logger.log({ event: 'recovery_result', targetInstanceId: entry.instanceId, recovered: entry.recovered, deleted: entry.deleted, reason: entry.reason, operation: 'instance/recovery' });
    }
    this.logger.log({
      event: 'retention_result',
      scanned: recovery.length,
      deleted: recovery.filter((entry) => entry.deleted).length,
      anomalies,
      skipped: false,
      orphansReaped: this.orphanOutcomes.slice(orphansBefore).filter((outcome) => outcome.outcome === 'reaped').length,
      durationMs,
    });
  }

  /**
   * `duringShutdown` keeps the §14.5 retention pass reachable after close().
   * Returns false when the pass was skipped, so the scheduler re-arms soon
   * instead of waiting a full interval.
   */
  private async runRetention(duringShutdown = false): Promise<boolean> {
    if (this.closed && !duringShutdown) return true;
    if (!this.recoveryScanSettled) {
      // Our own start-up scan still holds the recovery claims; a second pass
      // would only report `recovery-contended`. Say so instead of pretending
      // retention ran.
      this.retentionSkips += 1;
      // Publish immediately: the shutdown skip this counter exists for happens
      // when no later pass will run.
      this.diagnostics = { ...this.diagnostics, retentionSkips: this.retentionSkips };
      this.logger.log({ event: 'retention_result', scanned: 0, deleted: 0, anomalies: 0, skipped: true, orphansReaped: 0, durationMs: 0 });
      return false;
    }
    const startedAt = Date.now();
    const orphansBefore = this.orphanOutcomes.length;
    const recovery = await recoverAndApplyRetention({
      dataRoot: this.dataRoot,
      retentionDays: this.config.retentionDays,
      currentInstanceId: this.instanceId,
      hooks: this.recoveryHooks(),
    }).catch(() => [] as RecoveryResult[]);
    this.rememberArchives(recovery);
    this.diagnostics = { ...this.diagnostics, recovery: [...this.diagnostics.recovery, ...recovery], retentionSkips: this.retentionSkips };
    this.logRecovery(recovery, startedAt, orphansBefore);
    return true;
  }

  /**
   * Turns dispatched by this instance so far.
   *
   * Exposed because the nanny hook runs out of process: it cannot read this
   * counter and needs the value carried out to it, which ADR 0016 §5.2 assigns
   * to the snapshot's `turnsDispatched` field.
   */
  get turnsDispatched(): number {
    return this.turnsDispatchedCount;
  }

  handlers(): ToolHandlers {
    const handlers = {
      workers_list: async ({ rescan, requires }) => {
        const { hub } = await this.ready;
        // A rescan starts a new inventory generation, so cached capability
        // snapshots must not survive it (design §12).
        if (rescan) { this.descriptors.clear(); await callEngine('rescan', () => hub.rescan()); }
        const infos = await callEngine('engines', () => hub.engines());
        // The registry is the set (ADR 0004). Earlier this projected onto a
        // frozen list, which silently dropped any engine Realm had registered —
        // the operator could not see it, so could not act on it.
        const byId = new Map(infos.flatMap((info) => (info.id === undefined ? [] : [[info.id, info] as const])));
        // Frozen engines first, in the order mvp §4.2 lists them, then anything
        // else the registry reports. Sorting the whole list would reshuffle the
        // spec's own ordering every time an engine is added.
        const extra = [...byId.keys()].filter((id) => !isFrozenEngine(id)).sort();
        const engines = [...FROZEN_ENGINE_IDS, ...extra];
        // Requirements annotate; they never remove an engine (ADR 0005). A
        // shortened list could not distinguish "does not do fork" from "claims
        // fork and is recorded broken", and mvp §4.2 forbids omitting engines.
        // Only registered engines are described: `hub.describe` on one the
        // registry does not have can only throw, and describing costs a probe.
        const descriptors = requires === undefined ? new Map<string, unknown>() : await this.describeAll(engines.filter((engine) => byId.has(engine)));
        if (requires !== undefined) this.assertCapabilityPathsKnown(requires, descriptors);
        return {
          // ADR 0043: the one channel that can answer "which instance is
          // serving this session" — a tool call reaches exactly the instance
          // that owns it, and no other can reply. Unconditional, and it says
          // nothing about the console beyond the id itself.
          instanceId: this.instanceId,
          workers: engines.map((engine) => {
            const info = byId.get(engine);
            const registered = info && 'installed' in info ? (info as { installed: boolean; authenticated?: boolean; health: string; version?: string }) : undefined;
            const admission = this.admissionFor(engine);
            return {
              engine,
              installed: registered?.installed ?? false,
              authenticated: registered?.authenticated ?? 'unknown',
              available: registered === undefined ? false : registered.health !== 'not-installed' && registered.health !== 'invalid',
              // Reported whatever the flag says: an engine hidden because it is
              // unverified leaves no way to find out why it is missing.
              verification: verificationState(engine),
              // `usable` promises what session_create will accept, which needs
              // both admission and registry membership. Reporting admission
              // alone would say `true` for a frozen engine Realm no longer
              // registers, and the create would then fail anyway.
              usable: registered !== undefined && admission.allowed,
              ...(registered?.version === undefined ? {} : { version: registered.version }),
              ...(requires === undefined
                ? {}
                : {
              requirements: (() => {
                      const evaluation = evaluateRequirements(
                        (descriptors.get(engine) as { capabilities?: unknown } | undefined)?.capabilities,
                        requires,
                        (capability: string) => capabilityIsKnownBroken(engine, capability),
                      );
                      return { met: [...evaluation.met], unmet: [...evaluation.unmet], defective: [...evaluation.defective], satisfied: evaluation.satisfied };
                    })(),
                  }),
            };
          }),
        };
      },
      worker_describe: async ({ engine, rescan }) => {
        const { hub } = await this.ready;
        // A rescan starts a new inventory generation, so cached capability
        // snapshots must not survive it (design §12).
        if (rescan) { this.descriptors.clear(); await callEngine('rescan', () => hub.rescan()); }
        const descriptor = await callEngine('describe', () => hub.describe(engine));
        const info = (await callEngine('engines', () => hub.engines())).find((candidate) => candidate.id === engine);
        const registered = info && 'installed' in info ? (info as { installed: boolean; authenticated?: boolean; health: string }) : undefined;
        return {
          ...descriptor,
          engine,
          installed: registered?.installed ?? false,
          authenticated: registered?.authenticated ?? 'unknown',
          available: registered !== undefined && registered.health !== 'not-installed' && registered.health !== 'invalid',
          verification: verificationState(engine),
          usable: registered !== undefined && this.admissionFor(engine).allowed,
        };
      },
      session_create: async (input) => {
        this.assertAcceptingMutations();
        this.assertDelegationAllowsSessions();
        await this.assertEngineAdmitted(input.engine);
        const { policy } = await this.ready;
        // Resolve and verify before catalog/defaults reads. The profile files
        // are Plugin-owned, but an invalid cwd must not make them observable;
        // Core's reservation below repeats the same boundary check immediately
        // before reserving the record, so the pre-read check cannot be reused
        // after profile/config work has run.
        const safeCwd = await policy.resolveCwd(input.cwd);
        await policy.verifyCwdBeforeSpawn(safeCwd);
        if (input.mcpServerIds !== undefined && input.mcpServerIds.length > 0) {
          policy.validateMcp(input.mcpServerIds, this.config.mcpCatalog);
          // A catalog entry carries no command/url by design, so nothing can
          // resolve it into a Realm MCP server yet. Fail closed instead of
          // reporting servers the worker never received.
          fail('NOT_SUPPORTED', 'this installation has no MCP catalog resolver; create the session without mcpServerIds');
        }
        // ADR 0018/0019: the project's default-config file may fill config keys
        // the caller left unset, in three tiers — the profile's flat `config`,
        // then its `engineConfig` section for this engine, then the caller's
        // explicit `config`; per key, the more specific wins and explicit always
        // wins. The file is read on every create so edits take effect without a
        // restart (the project key is fixed at start-up; only the file is
        // re-read); an invalid file or an undeclared profile fails this call
        // (INVALID_ARGUMENT), never start-up. Fork and configure never consult
        // it: fork inherits the parent verbatim.
        // ADR 0039: when repoDefaults is true, the repo layer (hostCwd/taskshuttle.config.json)
        // and project layer compose with wholesale shadowing (Decision §2); when false, existing path unchanged.
        let defaults: import('./project-config.js').WorkerProfile | undefined;
        if (this.config.repoDefaults) {
          const repo = loadRepoConfig(this.hostCwd);
          const project = loadProjectConfig(this.dataRoot, this.projectKey);
          const survivor = resolveRepoProfile(repo, project, input.profile);
          defaults = survivor.profile;
        } else {
          defaults = resolveProfileDefaults(loadProjectConfig(this.dataRoot, this.projectKey), input.profile);
        }
        const merged = defaults === undefined ? input.config : mergeProfileDefaults(defaults, input.engine, input.config);
        const desiredConfig = merged !== undefined && Object.keys(merged).length > 0 ? merged : undefined;
        const normalizedRequest = {
          ...input,
          cwd: safeCwd.path,
          ...(desiredConfig === undefined ? {} : { desiredConfig }),
        };
        const application = this.coreApplication;
        if (application === undefined) fail('INTERNAL', 'Core application is not initialized');
        const created = await application.sessions.create({
          engine: normalizedRequest.engine,
          cwd: safeCwd.path,
          ...(normalizedRequest.name === undefined ? {} : { name: normalizedRequest.name }),
          ...(normalizedRequest.systemInstructions === undefined ? {} : { systemInstructions: normalizedRequest.systemInstructions }),
          ...(normalizedRequest.mcpServerIds === undefined ? {} : { mcpServerIds: normalizedRequest.mcpServerIds }),
          permissionMode: normalizedRequest.permissionMode,
          ...(normalizedRequest.desiredConfig === undefined ? {} : { desiredConfig: normalizedRequest.desiredConfig }),
        });
        if (!created.ok) failCore(created.error);
        return this.requireSessionOutput(created.value.sessionId);
      },
      // Only sessions still being built are hidden — the `creating` state itself
      // stays observable for a session that has been published (design §5.1).
      session_list: async ({ engine, state }) => {
        const application = this.coreApplication;
        if (application === undefined) fail('INTERNAL', 'Core application is not initialized');
        return {
          sessions: application.sessions.list()
            .filter((session) => !this.unpublished.has(session.sessionId) && (engine === undefined || session.engine === engine) && (state === undefined || session.state === state))
            .map((session) => this.coreSessionOutput(session)),
        };
      },
      session_get: async ({ sessionId }) => {
        const application = this.coreApplication;
        if (application === undefined) fail('INTERNAL', 'Core application is not initialized');
        const session = application.sessions.get(sessionId);
        if (!session.ok) failCore(session.error);
        if (this.unpublished.has(session.value.sessionId)) fail('NOT_FOUND', `session ${sessionId} was not found`);
        return this.coreSessionOutput(session.value);
      },
      session_configure: async ({ sessionId, permissionMode, config }) => this.withSessionLane(sessionId, async () => {
        this.assertAcceptingMutations();
        const record = this.visibleSession(sessionId);
        if (record === undefined) fail('NOT_FOUND', `session ${sessionId} was not found`);
        const realm = this.sessions.get(sessionId);
        if (realm === undefined) fail('SESSION_UNAVAILABLE', `session ${sessionId} has no live Realm session`);
        if (config !== undefined && record.state !== 'idle') fail('CONFLICT', 'engine config may only change while the session is idle');
        if (permissionMode !== undefined && this.registry.listInteractions().some((interaction) => interaction.sessionId === sessionId && interaction.kind === 'permission' && interaction.state === 'pending')) {
          fail('CONFLICT', 'permission mode cannot change while a permission is pending');
        }
        // Realm exposes one key at a time; apply in a stable order and keep each
        // applied key in the local snapshot even if a later key fails on the wire.
        // §4.4: refresh inside the loop, after each setConfig succeeds — a single
        // refresh after the loop would lose every earlier key's observations when
        // a later key throws.
        if (config !== undefined) {
          const sortedKeys = Object.keys(config).sort();
          // Snapshot the observed timestamp for each requested key before any
          // write, resolving aliases (Codex `reasoning_effort` is observed as
          // `reasoning` with `engineOptionId: reasoning_effort`).
          const findObservedAt = (observed: Record<string, { observedAt: string; engineOptionId?: string }> | undefined, requestedKey: string): string | undefined => {
            if (observed === undefined) return undefined;
            if (Object.hasOwn(observed, requestedKey)) return observed[requestedKey]!.observedAt;
            for (const k of Object.keys(observed)) {
              if (observed[k]!.engineOptionId === requestedKey) return observed[k]!.observedAt;
            }
            return undefined;
          };
          const beforeAts = new Map<string, string | undefined>();
          for (const key of sortedKeys) {
            beforeAts.set(key, findObservedAt(this.registry.getSession(sessionId)?.observedConfig as Record<string, { observedAt: string; engineOptionId?: string }> | undefined, key));
          }
          const syncSucceeded = new Map<string, boolean>();
          try {
            for (const key of sortedKeys) {
              const value = config[key]!;
              await callEngine('setConfig', () => realm.setConfig({ [key]: value }));
              const ok = this.syncSessionObservations(sessionId);
              syncSucceeded.set(key, ok);
              this.registry.configureSession(sessionId, { config: { [key]: value } });
            }
          } finally {
            // Drop stale keys after the loop so a later iteration's sync (which
            // replaces the whole observed map from Realm's snapshot) does not
            // resurrect an earlier key's stale entry. The drop must run even
            // when a later key's `setConfig` throws — earlier keys already have
            // their desired values applied and must not keep stale observations.
            // Only drop when the refresh succeeded and the timestamp did not
            // advance — a failed refresh must keep the last real observation
            // (SES-034).
            for (const key of sortedKeys) {
              if (syncSucceeded.get(key) !== true) continue;
              const beforeAt = beforeAts.get(key);
              const afterAt = findObservedAt(this.registry.getSession(sessionId)?.observedConfig as Record<string, { observedAt: string; engineOptionId?: string }> | undefined, key);
              if (afterAt !== undefined && afterAt === beforeAt) {
                this.registry.dropObservedConfigKeys(sessionId, [key]);
              }
            }
          }
        }
        const changed = permissionMode === undefined
          ? this.registry.getSession(sessionId)
          : this.registry.configureSession(sessionId, { permissionMode }).value;
        if (changed === undefined) fail('CONFLICT', 'session is not configurable in its current state');
        return this.sessionOutput(changed);
      }),
      session_fork: async ({ sessionId, name }) => this.withSessionLane(sessionId, async () => {
        this.assertAcceptingMutations();
        this.assertDelegationAllowsSessions();
        const source = this.visibleSession(sessionId);
        const realm = this.sessions.get(sessionId);
        if (source === undefined || realm === undefined) fail('NOT_FOUND', `session ${sessionId} was not found`);
        if (source.state !== 'idle') fail('CONFLICT', 'only an idle session can be forked');
        const sourceCapabilities = (source.descriptor as { capabilities?: unknown }).capabilities;
        const canFork = Array.isArray(sourceCapabilities)
          ? sourceCapabilities.includes('session.fork')
          : (sourceCapabilities as { session?: Record<string, unknown> } | undefined)?.session?.['fork'] === true;
        if (!canFork) {
          fail('NOT_SUPPORTED', `engine ${source.engine} does not support native session fork`);
        }
        // A fork creates a session, so it is bound by the same admission rule as
        // session_create. ADR 0004 lets an existing session on a now-disallowed
        // engine resume and close; it does not let that session spawn new ones.
        await this.assertEngineAdmitted(source.engine);
        const descriptor = await this.describeEngine(source.engine);
        const { policy } = await this.ready;
        const childRequest = {
          engine: source.engine,
          cwd: source.cwd,
          ...(name === undefined ? {} : { name }),
          permissionMode: source.permissionMode,
          mcpServerIds: source.mcpServerIds,
          ...(source.systemInstructions === undefined ? {} : { systemInstructions: source.systemInstructions }),
          desiredConfig: source.desiredConfig,
          parentSessionId: source.id,
        };
        const safeChildCwd = await policy.resolveCwd(childRequest.cwd);
        await policy.verifyCwdBeforeSpawn(safeChildCwd);
        const created = this.registry.createSession({ ...childRequest, cwd: safeChildCwd.path });
        if (!created.ok || created.value === undefined) fail('LIMIT_EXCEEDED', 'open session limit reached', { maxOpenSessions: this.config.maxOpenSessions });
        this.unpublished.add(created.value.id);
        let sibling: RunskeinSession | undefined;
        try {
          sibling = await callEngine('fork', () => realm.fork());
          // The question listener is attached immediately (design §8.2), but the
          // child stays `creating` — invisible to session_list/turn_start —
          // until its config replay finished (design §6.2.5, §6.3).
          const broker = this.attachSession(created.value, sibling);
          this.coreProvider?.adoptSession(created.value.id, sibling);
          for (const key of Object.keys(source.desiredConfig).sort()) await callEngine('setConfig', () => sibling!.setConfig({ [key]: source.desiredConfig[key]! }));
          return this.publishSession(created.value, sibling, descriptor, broker);
        } catch (cause) {
          const childId = created.value.id;
          this.brokers.get(childId)?.dispose();
          this.brokers.delete(childId);
          const child = this.registry.getSession(childId);
          if (child === undefined || child.state === 'creating') {
            // Never published: close the child once and drop it entirely, so
            // no half-built child is ever visible (design §6.3).
            await sibling?.close().catch(() => undefined);
            this.registry.discardCreatingSession(childId);
            this.detachSession(childId);
          }
          // Otherwise the child survives as `failed` (an engine crash claimed it
          // mid-build): keep its Realm binding so the explicit close remains its
          // single cleanup point (design §6.2.7).
          this.unpublished.delete(childId);
          throw cause;
        }
      }),
      session_close: async ({ sessionId }) => {
        // A provider child can be claimed by an engine-crash notification
        // before Core publishes its opaque provider id. The legacy fork path
        // still owns that binding, so let its close coordinator perform the
        // one explicit cleanup rather than asking Core to close an unknown id.
        const record = this.registry.getSession(sessionId);
        if (record?.realmSessionId === undefined && this.sessions.has(sessionId)) {
          return this.closeSession(sessionId);
        }
        const application = this.coreApplication;
        if (application === undefined) fail('INTERNAL', 'Core application is not initialized');
        const result = await application.sessions.close(sessionId);
        if (!result.ok) failCore(result.error);
        return this.coreSessionOutput(result.value);
      },
      turn_start: async ({ sessionId, prompt, priority, timeoutMs }) => {
        this.assertAcceptingMutations();
        const session = this.visibleSession(sessionId);
        if (session === undefined) fail('NOT_FOUND', `session ${sessionId} was not found`);
        if (session.state !== 'idle' && session.state !== 'busy') fail('SESSION_UNAVAILABLE', `session ${sessionId} is ${session.state}`);
        const rawCapabilities = (session.descriptor as { capabilities?: unknown }).capabilities;
        const capabilities: Record<string, boolean> = Array.isArray(rawCapabilities)
          ? Object.fromEntries(rawCapabilities.map((capability) => [capability, true]))
          : (rawCapabilities as { prompt?: Record<string, boolean> } | undefined)?.prompt ?? {};
        for (const block of prompt) {
          const supportsImage = capabilities['image'] === true || capabilities['prompt.image'] === true;
          const supportsEmbeddedContext = capabilities['embeddedContext'] === true || capabilities['prompt.embeddedContext'] === true;
          // mvp §6.4 requires gated refusals to name the engine, block type and
          // required capability. The capability rides in `details` so a caller
          // reads a field rather than parsing the message (ADR 0050 decision 4).
          // ACP resource links are a baseline block, so only images and embedded
          // resources consult the optional prompt capability descriptor.
          if (block.type === 'image' && !supportsImage) {
            fail('NOT_SUPPORTED', `engine ${session.engine} does not accept image prompts`, { engine: session.engine, blockType: block.type, requiredCapability: 'prompt.image' });
          }
          if (block.type === 'resource' && !supportsEmbeddedContext) {
            fail('NOT_SUPPORTED', `engine ${session.engine} does not accept embedded resources`, { engine: session.engine, blockType: block.type, requiredCapability: 'prompt.embeddedContext' });
          }
        }
        const application = this.coreApplication;
        if (application === undefined) fail('INTERNAL', 'Core application is not initialized');
        const result = application.turns.start({ sessionId, prompt, priority, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
        if (!result.ok) failCore(result.error);
        this.turnsDispatchedCount += 1;
        return result.value;
      },
      turn_list: async ({ sessionId, engine, state }) => {
        const application = this.coreApplication;
        if (application === undefined) fail('INTERNAL', 'Core application is not initialized');
        return { turns: application.turns.list(sessionId).filter((turn) => (engine === undefined || turn.engine === engine) && (state === undefined || turn.state === state)).map((turn) => this.coreTurnOutput(turn)) };
      },
      turn_get: async ({ turnId }) => {
        const application = this.coreApplication;
        if (application === undefined) fail('INTERNAL', 'Core application is not initialized');
        const turn = application.turns.get(turnId);
        if (!turn.ok) failCore(turn.error);
        return this.coreTurnOutput(turn.value);
      },
      turn_cancel: async ({ turnId }) => {
        this.assertAcceptingMutations();
        const application = this.coreApplication;
        if (application === undefined) fail('INTERNAL', 'Core application is not initialized');
        const result = await application.turns.cancel(turnId);
        if (!result.ok) {
          const existing = this.registry.getTurn(turnId);
          if (existing === undefined) failCore(result.error);
          return this.turnOutput(existing);
        }
        return this.coreTurnOutput(result.value);
      },
      transcript_list: async ({ engine, kind }) => ({ transcripts: await this.listStoredTranscripts(engine, kind) }),
      transcript_read: async ({ sessionId, afterSeq, limit }) => {
        const target = await this.resolveTranscript(sessionId);
        try {
        const { store, realmSessionId } = target;
        // A live session that has not emitted an event yet is listed by
        // transcript_list, so reading it returns an empty page, not NOT_FOUND.
        // No fault event here: a sick store fails the page read below and that throw is logged by the wrapper; this catch only papers over the honest no-events shape (ADR 0038).
        const highWatermark = await store.highWatermark(realmSessionId).catch(() => {
          // A live session that has produced no event yet reads as an empty
          // page; a deleted transcript stays NOT_FOUND (design §9.5).
          if (target.liveSessionState !== undefined && !this.deletedTranscripts.has(realmSessionId)) return 0;
          return fail('NOT_FOUND', `transcript ${sessionId} was not found`);
        });
        // The pagination core is shared with the console's events endpoint, so
        // the orchestrator and the operator see identical pages (§5.1).
        return await readTranscriptPage(store, realmSessionId, highWatermark, { afterSeq, limit, budgetBytes: this.config.responseByteBudget });
        } finally { await target.release(); }
      },
      transcript_event_get: async ({ sessionId, seq, offset, maxBytes }) => {
        const target = await this.resolveTranscript(sessionId);
        try {
          const canonical = await target.store.canonicalEvent(target.realmSessionId, seq);
          if (canonical === undefined) fail('NOT_FOUND', `transcript event ${seq} was not found`);
          const { bytes, sha256 } = canonical;
          if (offset > bytes.byteLength) fail('INVALID_ARGUMENT', `offset ${offset} is beyond the ${bytes.byteLength} byte event`);
          return { encoding: 'base64' as const, offset, totalBytes: bytes.byteLength, data: bytes.subarray(offset, offset + maxBytes).toString('base64'), sha256 };
        } finally { await target.release(); }
      },
      transcript_delete: async ({ sessionId }) => {
        this.assertAcceptingMutations();
        const target = await this.resolveTranscript(sessionId);
        try {
          // A transcript that belongs to a session this instance still owns is
          // active data: §9.5 requires CONFLICT, never a silent delete.
          if (target.liveSessionState !== undefined && target.liveSessionState !== 'closed') fail('CONFLICT', 'only closed or archived transcripts may be deleted');
          await target.store.delete(target.realmSessionId);
          this.deletedTranscripts.add(target.realmSessionId);
          return { sessionId, deleted: true as const };
        } finally { await target.release(); }
      },
      interaction_list: async ({ turnId, sessionId, kind, state }) => ({ interactions: this.registry.listInteractions(turnId).filter((i) => (sessionId === undefined || i.sessionId === sessionId) && (kind === undefined || i.kind === kind) && i.state === state).map((i) => ({ interactionId: i.id, turnId: i.turnId, sessionId: i.sessionId, kind: i.kind, state: i.state, createdAt: i.createdAt, ...(i.expiresAt === undefined ? {} : { expiresAt: i.expiresAt }), payload: i.payload })) }),
      interaction_respond: async ({ interactionId, response }) => {
        this.assertAcceptingMutations();
        const interaction = this.registry.getInteraction(interactionId);
        if (interaction === undefined) fail('NOT_FOUND', `interaction ${interactionId} was not found`);
        const broker = this.brokers.get(interaction.sessionId);
        if (broker === undefined) fail('SESSION_UNAVAILABLE', `session ${interaction.sessionId} is no longer live`);
        const result = await broker.respond(interactionId, response as InteractionResponse);
        if (!result.ok) throw toPluginException(result.error);
        return { interactionId, state: 'responded' as const };
      },
      // The plugin stores and returns the anchor; it never looks inside it
      // (ADR 0016). Every line here is deliberately content-blind.
      anchor: async ({ content }) => {
        const { instance } = await this.ready;
        this.anchor ??= new AnchorStore(instance.instanceDir, this.instanceId);
        let record;
        if (content === undefined) {
          record = await this.anchor.read();
        } else {
          this.assertAcceptingMutations();
          record = await this.anchor.write(content, () => this.turnsDispatchedCount);
        }
        // No anchor is the common case, not an error: most sessions never write one.
        if (record === undefined) return { turnsSinceUpdate: 0 };
        // The counter only grows and `turnsAtWrite` is one of its past values, so
        // the difference cannot go negative; the clamp keeps a record left behind
        // by some other instance from producing a nonsensical negative signal.
        return { content: record.content, updatedAt: record.updatedAt, turnsSinceUpdate: Math.max(0, this.turnsDispatchedCount - record.turnsAtWrite) };
      },
      // ADR 0019: generate the project's worker-defaults file from the live
      // registry and start the console. The file side is idempotent and never
      // destroys (an existing valid file is returned untouched; refresh merges,
      // never rewrites; an invalid file is a field-level error, never
      // overwritten); the console start is attempted on every call. The file is
      // the primary artifact and the console the satellite — a file-write
      // failure fails the whole call before the console is touched, while a
      // console start failure only marks console.state 'start-failed'.
      project_init: async ({ refresh }) => {
        this.assertAcceptingMutations();
        // Initialisation is the orchestrator's duty, and the content-return
        // premise (the caller is the principal the file exists for) does not
        // hold for a delegated worker — so the refusal is whole-tool: neither
        // the file nor the console side happens (ADR 0019 Decision-2, same
        // direction as ADR 0003's depth clause).
        if (isDelegated(this.delegation)) fail('NOT_SUPPORTED', 'project_init is not available to a delegated instance; initialising the project is the orchestrator\u2019s duty');
        const { hub, console: consoleServer } = await this.ready;
        // The registry is rescanned up front — install state and descriptors are
        // "right now", not the boot snapshot, so an engine installed mid-run is
        // seen by this very call. A rescan starts a new inventory generation, so
        // cached descriptors must not survive it (same rule as workers_list).
        this.descriptors.clear();
        await callEngine('rescan', () => hub.rescan());
        const infos = await callEngine('engines', () => hub.engines());
        const known = [...new Set(infos.map((info) => info.id).filter((id): id is string => typeof id === 'string'))].sort();
        const installed = known.filter((id) => {
          const info = infos.find((candidate) => candidate.id === id);
          return info !== undefined && 'installed' in info && info.installed === true;
        });
        // Validate-before-anything: an existing invalid file is a field-level
        // error whether or not refresh was given — never returned, never
        // overwritten. Existence alone is the "has init run" test; there is no
        // marker file.
        const existing = readProjectConfigFile(this.dataRoot, this.projectKey);
        let content: string;
        let created = false;
        if (existing !== undefined && !refresh) {
          content = existing.content;
        } else {
          // Sections are generated for installed engines only, copied from each
          // engine's own descriptor; uninstalled engines have no descriptor and
          // land in enginesOmitted without ever entering the file.
          const sections: Record<string, Record<string, string | boolean>> = {};
          for (const engine of installed) {
            const descriptor = await callEngine('describe', () => hub.describe(engine)) as { configOptions?: unknown };
            const options: readonly ConfigOptionLike[] = Array.isArray(descriptor.configOptions) ? descriptor.configOptions as ConfigOptionLike[] : [];
            sections[engine] = engineConfigSection(options);
          }
          if (existing === undefined) {
            // The skeleton (profile names, purpose texts) comes from the shipped
            // template; the engine sections are generated fresh, never copied
            // from the template's example values.
            const template: unknown = JSON.parse(await readFile(this.defaultsTemplatePath, 'utf8'));
            content = generateProjectConfig(template, sections);
          } else {
            content = mergeProjectConfig(existing.config, sections);
          }
          const writtenPath = await writeProjectConfigFile(this.dataRoot, this.projectKey, content);
          this.logger.log({ event: 'project_init', operation: 'project/init', path: writtenPath, created: true, engines: Object.keys(sections).sort() });
          created = true;
        }
        // The lists describe the returned content, independent of `created`:
        // included = engines with a section in it, omitted = engines the live
        // registry knows that have none — including installed-but-undeclared
        // ones, which is the caller's signal to consider refresh.
        const included = declaredEngines(validateProjectConfig(JSON.parse(content)));
        const omitted = known.filter((id) => !included.includes(id));
        const consoleOutcome = await this.tryStartConsole(consoleServer);
        return {
          path: join(this.dataRoot, this.projectKey, 'config.json'),
          created,
          content,
          enginesIncluded: included,
          enginesOmitted: omitted,
          console: consoleOutcome,
        };
      },
    } as ToolHandlers;
    return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async (input: unknown) => {
      await this.ready;
      if (!READ_ONLY_TOOLS.has(name)) await this.recovered;
      try {
        return await (handler as (value: unknown) => unknown)(input);
      } catch (cause) {
        // A fault the plugin attributes to the store, to itself, or to the
        // engine gets its own log line; a caller's error does not, being an
        // answer rather than a fault (ADR 0030). The gate used to be
        // `STORE_ERROR` only, which after the producer changes would have left
        // a malformed interaction payload logged nowhere at all.
        const mapped = mapError(cause, { operation: `tool/${name}`, secretLiterals: this.secretLiterals });
        // Log the resolved registry id, never the caller's raw string. The
        // resolution is itself a registry read, and the registry is exactly
        // what may be unwell when a fault is being logged — so a failure to
        // resolve costs the id, never the log line.
        const requested = typeof input === 'object' && input !== null ? (input as { sessionId?: unknown }).sessionId : undefined;
        let resolved: string | undefined;
        try { resolved = typeof requested === 'string' ? this.visibleSession(requested)?.id : undefined; }
        catch { resolved = undefined; }
        this.logFault(mapped.code, { operation: `tool/${name}`, ...(resolved === undefined ? {} : { sessionId: resolved }) });
        throw cause;
      }
    }])) as ToolHandlers;
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closePromise = (async () => {
      if (this.closed) return;
      this.closed = true;
      this.acceptMutations = false;
      this.retention.stop();
      for (const broker of this.brokers.values()) broker.dispose();
      // The observation handles are torn down beside every this.sessions.delete()
      // (design §4.2.1), and shutdown abandons that map wholesale rather than
      // deleting from it — so drop them here too. Nothing observes a runtime
      // that is closing, and a listener left on a session the hub still owns
      // keeps this runtime reachable: the hub outlives us and is quit once, by
      // the host.
      for (const unsubscribe of this.sessionObservationUnsubs.values()) unsubscribe();
      this.sessionObservationUnsubs.clear();
      let init: RuntimeInit;
      try { init = await this.ready; } catch { this.retention.stop(); return; }
      this.retention.stop();
      // Stop taking transitions and let the last flagged write land. The file
      // is deliberately left on disk: it describes work this instance still had
      // outstanding, and removing it would read as "nothing to report" to a
      // hook that fires after us.
      await init.nanny.close().catch(() => undefined);
      // The console's SSE backfill reads the store, so the listener closes
      // before the store does (console-design §4); a close failure here is
      // reported, never allowed to abort the rest of shutdown.
      if (init.console !== undefined) {
        try { await init.console.close(); }
        catch (error) { this.logFault(mapError(error, { operation: 'console/close', secretLiterals: this.secretLiterals }).code, { operation: 'console/close' }); }
      }
      // Let the start-up scan finish so the shutdown retention pass is not
      // contended by our own recovery claims; a scan that outlives this budget
      // simply leaves retention to the next start.
      await Promise.race([
        this.recovered.catch(() => undefined),
        new Promise<void>((resolve) => { const timer = setTimeout(resolve, SHUTDOWN_SCAN_WAIT_MS); timer.unref?.(); }),
      ]);
      const startedAt = Date.now();
      const result = await this.lifecycle.shutdown();
      this.logger.log({
        event: 'shutdown_result',
        status: result.status,
        quitCalls: result.quitCalls,
        durationMs: Math.max(0, Date.now() - startedAt),
        ...(result.error === undefined ? {} : { errorCode: mapError(result.error, { operation: 'lifecycle/shutdown', secretLiterals: this.secretLiterals }).code }),
      });
    })();
    return this.closePromise;
  }

  /** Descriptors for every engine, tolerating the ones that cannot be described. */
  private async describeAll(engines: readonly string[]): Promise<Map<string, unknown>> {
    const entries = await Promise.all(engines.map(async (engine) => {
      // An engine that is registered but not installed has no descriptor. That
      // is reported as unmet alongside `available: false` rather than failing
      // the whole call — one absent engine must not deny the answer.
      try { return [engine, await this.describeEngine(engine)] as const; }
      catch { return [engine, undefined] as const; }
    }));
    return new Map(entries);
  }

  /**
   * Reject a capability path no registered engine exposes.
   *
   * A typo would otherwise mark every engine unqualified and look like a real
   * answer. Checked against the live descriptors for the same reason engine ids
   * are checked against the live registry: there is no fixed list to check.
   */
  private assertCapabilityPathsKnown(required: readonly string[], descriptors: ReadonlyMap<string, unknown>): void {
    const known = new Set<string>();
    for (const descriptor of descriptors.values()) {
      for (const path of capabilityPaths((descriptor as { capabilities?: unknown } | undefined)?.capabilities)) known.add(path);
    }
    // Nothing described at all (every engine uninstalled) is not evidence that a
    // path is wrong, so there is nothing to reject.
    if (known.size === 0) return;
    const unknown = required.filter((path) => !known.has(path));
    if (unknown.length > 0) {
      fail('INVALID_ARGUMENT', `unknown capability ${unknown.length > 1 ? 'paths' : 'path'} ${unknown.join(', ')}`, { known: [...known].sort() });
    }
  }

  private admissionFor(engine: string): EngineAdmission {
    return engineAdmission(engine, { isFrozen: isFrozenEngine(engine), allowUnverified: this.config.allowUnverifiedEngines });
  }

  /**
   * The console half of `project_init` (ADR 0019 §Decision-4): the same start
   * path and configuration as the boot-time start, with the outcome reported as
   * the bounded disclosure the amendment allows — a state word and, where a
   * listener exists, the loopback port. `disabled` has exactly one cause: the
   * install surface's `allowInitStart: false`; `enabled: false` keeps its
   * boot-time meaning only and does not block this path. A start failure is
   * logged by category (never with a stack) and reported as 'start-failed' —
   * it does not fail the tool call.
   */
  private async tryStartConsole(consoleServer: ConsoleServer | undefined): Promise<{ state: 'started' | 'already-running' | 'start-failed' | 'disabled' | 'withheld'; port?: number }> {
    // The order is fixed by ADR 0031 rather than left to the reading order of
    // this function, because several conditions can hold at once. A delegated
    // verdict never reaches here — the tool is refused first.
    //
    // `already-running` deliberately outranks the install-surface veto: the boot
    // start is governed by `console.enabled`, so a listener can legitimately be
    // running while `allowInitStart` is false, and answering `disabled` about a
    // console the operator can watch running would be a lie. The veto governs
    // *this* start, not whether a console exists.
    if (consoleServer !== undefined && consoleServer.running) return { state: 'already-running', port: consoleServer.port };
    if (!this.config.console.allowInitStart) return { state: 'disabled' };
    // Below the veto, the verdict decides. `unavailable` means this instance
    // could not establish that it is a root, so the console fails closed while
    // the tools keep serving — and it has not *failed* at anything.
    if (!consoleAllowed(this.delegation)) {
      this.logger.log({ event: 'console_withheld', provenance: this.delegation.provenance, operation: 'console/start', ...this.withheldDiagnostics() });
      return { state: 'withheld' };
    }
    // An absent server at a root verdict means initialize() failed before
    // constructing it — a server that failed to construct *is* a failed start,
    // which is the case this branch was written about.
    if (consoleServer === undefined) return { state: 'start-failed' };
    try {
      await consoleServer.start();
      // The port is all this event carries (console-design §4).
      this.logger.log({ event: 'console_started', port: consoleServer.port, operation: 'console/start' });
      return { state: 'started', port: consoleServer.port };
    } catch (cause) {
      const mapped = mapError(cause, { operation: 'console/start', secretLiterals: this.secretLiterals });
      // The category only — never the stack; the caller sees the bounded
      // 'start-failed' state.
      this.logger.log({ event: 'console_start_failed', errorCode: mapped.code, operation: 'console/start' });
      return { state: 'start-failed' };
    }
  }

  /**
   * Engine ids are open, so existence is checked here rather than by a schema
   * enum — and the error can distinguish "no such engine" from "registered but
   * not admitted", which an enum could never express.
   */
  private async assertEngineAdmitted(engine: string): Promise<void> {
    const { hub } = await this.ready;
    const registered = (await callEngine('engines', () => hub.engines())).map((info) => info.id).filter((id): id is string => id !== undefined);
    if (!registered.includes(engine)) {
      fail('INVALID_ARGUMENT', `unknown engine '${engine}'`, { available: [...registered].sort() });
    }
    if (!this.admissionFor(engine).allowed) {
      fail('PERMISSION_DENIED', `engine '${engine}' is not admitted by the current verification state (${verificationState(engine)}); set allowUnverifiedEngines in the install configuration to use it`, {
        engine,
        verification: verificationState(engine),
      });
    }
  }

  private async openSession(record: SessionRecord) {
    let broker: InteractionBroker | undefined;
    let spawnAttempted = false;
    try {
      // Everything that can fail lives inside this try: a validation or
      // descriptor failure must release the reservation, never strand the
      // record (design §6.2.7).
      await this.ready;
      // ADR 0037: describeEngine + broker are cwd-independent, so they run
      // before the verify; the verify must stay adjacent to hub.session —
      // anything inserted between them reopens the TOCTOU window.
      const descriptor = await this.describeEngine(record.engine);
      broker = this.brokerFactory({ registry: this.registry, sessionId: record.id, permissionMode: () => this.registry.getSession(record.id)?.permissionMode ?? 'deny' });
      spawnAttempted = true;
      const provider = this.agentProvider;
      if (provider === undefined) throw new Error('Runskein adapter is not initialized');
      const realm = await provider.openSession({
        engine: record.engine,
        cwd: record.cwd,
        mcpServerIds: record.mcpServerIds,
        permissionMode: record.permissionMode,
        ...(record.systemInstructions === undefined ? {} : { systemInstructions: record.systemInstructions }),
        config: record.desiredConfig,
      }, broker!.permissionPolicy);
      return this.attachCreated(record, realm, descriptor, broker);
    } catch (cause) {
      broker?.dispose();
      this.brokers.get(record.id)?.dispose();
      this.brokers.delete(record.id);
      // Only failures that provably precede any spawn release the reservation.
      // EngineStartError is NOT one of them: Realm raises it after a spawn
      // whose cleanup may have failed, which is exactly the case design §6.2.7
      // keeps live+failed until an explicit close.
      const name = cause instanceof Error ? cause.name : '';
      if (!spawnAttempted || cause instanceof SecurityPolicyError || ['NotInstalledError', 'UnauthenticatedError', 'ConfigError'].includes(name)) {
        this.registry.discardCreatingSession(record.id);
      } else {
        const failure = mapError(cause, { operation: 'session/create', secretLiterals: this.secretLiterals });
        const failed = this.registry.markSessionFailed(record.id, failure);
        if (!failed.ok && this.registry.getSession(record.id)?.state !== 'failed') this.registry.discardCreatingSession(record.id);
      }
      // A record that survives as `failed` keeps its Realm binding: the explicit
      // close is its single cleanup point (§6.2.7). One that is gone keeps
      // nothing. There is deliberately no `realm.close()` here: a discard needs
      // `creating` + no realmSessionId, which cannot coincide with a live
      // binding, so a discarded record never has a session to close.
      if (this.registry.getSession(record.id) === undefined) this.detachSession(record.id);
      throw cause;
    } finally {
      // Whatever happened, the record is either published, failed, or gone —
      // none of which may stay hidden.
      this.unpublished.delete(record.id);
    }
  }

  /**
   * Capability snapshot for a session, taken from the public engine descriptor.
   * Realm's `Session` does not expose a descriptor, so it is read from the hub
   * and cached per inventory generation.
   */
  private async describeEngine(engine: EngineId): Promise<Record<string, unknown>> {
    const cached = this.descriptors.get(engine);
    if (cached !== undefined) return cached;
    const { hub } = await this.ready;
    const descriptor = await callEngine('describe', () => hub.describe(engine)) as unknown as Record<string, unknown>;
    this.descriptors.set(engine, descriptor);
    return descriptor;
  }

  /**
   * §6.3 close: claim, release the queue, one `Session.close()`, then the
   * execution/drain barrier — inside the session lane and a single flight.
   */
  private closeSession(sessionId: string) {
    return this.withSessionLane(sessionId, async () => {
      const current = this.visibleSession(sessionId);
      if (current === undefined) fail('NOT_FOUND', `session ${sessionId} was not found`);
      if (current.state === 'closed') return this.sessionOutput(current);
      const existing = this.closing.get(sessionId);
      if (existing !== undefined) {
        // The same single-flight operation already ran. Retry only the
        // completion — never a second Realm close — and report a stall instead
        // of returning `closing` as a success.
        await existing;
        if (this.registry.getSession(sessionId)?.state !== 'closed') {
          this.registry.completeCloseSession(sessionId);
          if (this.registry.getSession(sessionId)?.state !== 'closed') {
            fail('CONFLICT', `session ${sessionId} is still closing: a turn has not reached a terminal state`);
          }
          this.closing.delete(sessionId);
        }
        return this.requireSessionOutput(sessionId);
      }
      const record = this.registry.beginCloseSession(sessionId);
      if (!record.ok || record.value === undefined) fail('CONFLICT', 'session cannot be closed in its current state');
      const closing = (async () => {
        this.scheduler.releaseSessionQueue(sessionId);
        try { await callEngine('close', async () => this.sessions.get(sessionId)?.close()); }
        finally {
          await this.scheduler.drainSession(sessionId);
          this.brokers.get(sessionId)?.dispose();
          // §4.3 point 3: the closing snapshot is taken immediately before the
          // binding is dropped, or the final observations never land — after
          // this, the live object is gone.
          this.syncSessionObservations(sessionId);
          this.sessionObservationUnsubs.get(sessionId)?.();
          this.sessionObservationUnsubs.delete(sessionId);
          this.sessions.delete(sessionId); this.brokers.delete(sessionId);
          this.registry.completeCloseSession(sessionId);
        }
      })();
      const tracked = closing.catch(() => undefined).finally(() => {
        if (this.registry.getSession(sessionId)?.state === 'closed') this.closing.delete(sessionId);
      });
      this.closing.set(sessionId, tracked);
      await closing;
      return this.requireSessionOutput(sessionId);
    });
  }

  /** Bind the Realm session and its question listener; the record stays `creating`. */
  private attachSession(record: SessionRecord, realm: RunskeinSession, broker = this.brokerFactory({ registry: this.registry, sessionId: record.id, permissionMode: () => this.registry.getSession(record.id)?.permissionMode ?? 'deny' })): InteractionBroker {
    broker.attachSession(realm);
    this.sessions.set(record.id, realm); this.brokers.set(record.id, broker);
    this.sessionObservationUnsubs.set(record.id, this.subscribeSessionObservations(record.id, realm));
    return broker;
  }

  /**
   * The two observation subscriptions (design §4.2). Both only trigger
   * `syncSessionObservations` — they are refresh triggers, not a second
   * transcript path: no payload is parsed, no event is written, nothing is
   * projected. `on('update')` filters to the three engine-reported
   * discriminators (names from Realm's vocabulary.d.ts) and ignores the rest;
   * `on('reactivated')` cannot be dropped because resume/load writes its
   * creation state on `adoptBinding` and then emits `reactivated`, not an
   * `update`.
   */
  private subscribeSessionObservations(sessionId: string, realm: RunskeinSession): () => void {
    const offUpdate = realm.on('update', (event) => {
      const kind = event?.update?.sessionUpdate;
      if (kind !== 'current_mode_update' && kind !== 'config_option_update' && kind !== 'usage_update') return;
      this.syncSessionObservations(sessionId);
    });
    const offReactivated = realm.on('reactivated', () => this.syncSessionObservations(sessionId));
    return () => { offUpdate(); offReactivated(); };
  }

  /**
   * The only writer of a session's observation fields (design §4.1). Reads the
   * live Realm session's synchronous getters and folds them into the registry
   * record, converting each observedAt to ISO 8601 once, on entry (design
   * §5.2). Silent when no live session exists: "cannot read" is not a failure
   * — the record's old values are still the last real observations (design
   * §4.1). An empty usage/observed map folds to an absent field: the engine has
   * not reported anything, which is not the same as reporting zero (mvp §10.6).
   */
   private syncSessionObservations(sessionId: string): boolean {
    const realm = this.sessions.get(sessionId);
    if (realm === undefined) return false;
    try {
      const usage = realm.usage();
      const usageRecord = usage === undefined || Object.keys(usage).length === 0 ? undefined : usage as Record<string, unknown>;
      const observed = realm.configState().observed;
      // An entry whose timestamp cannot be expressed is dropped rather than
      // carried undated: `new Date(NaN).toISOString()` throws, and an absent key
      // already has a defined meaning — the engine did not say (mvp §10.6).
      // Presenting an observation we cannot date would be the weaker answer.
      const entries = Object.entries(observed).filter(([, observation]) => Number.isFinite(observation.observedAt));
      const observedRecord = entries.length === 0
        ? undefined
        : Object.fromEntries(entries.map(([key, observation]) => [
            key,
            {
              value: observation.value,
              source: observation.source,
              observedAt: new Date(observation.observedAt).toISOString(),
              ...(observation.engineOptionId === undefined ? {} : { engineOptionId: observation.engineOptionId }),
            },
          ]));
      this.registry.updateSessionObservations(sessionId, {
        ...(usageRecord === undefined ? {} : { usage: usageRecord }),
        ...(observedRecord === undefined ? {} : { observedConfig: observedRecord }),
      });
      return true;
    } catch (cause) {
      // This runs on two paths that must not inherit its failure. From a Realm
      // subscription it would escape into the engine's dispatch; from inside
      // session_configure it would reject a call whose `setConfig` already
      // succeeded on the wire, telling the caller the configure failed after
      // the engine had applied it. Bookkeeping is not allowed to do either, so
      // a refresh that cannot complete leaves the record at its last real
      // observation — the same outcome as no live session (design §4.1) — and
      // says so in the log rather than silently.
      this.logger.log({
        event: 'observation_refresh_failed',
        sessionId,
        engine: this.registry.getSession(sessionId)?.engine ?? 'unknown',
        reason: cause instanceof Error ? cause.name : 'unknown',
        operation: 'session/observe',
      });
      return false;
    }
  }

  /** Publish a fully prepared session: `creating -> idle` with its capability snapshot. */
  private publishSession(record: SessionRecord, realm: RunskeinSession, descriptor: Record<string, unknown>, _broker: InteractionBroker) {
    // §4.4 ordering: refresh BEFORE taking the record the response is built
    // from. markSessionReady returns a clone captured at that instant; a
    // refresh after it would write into the registry but never reach the
    // response.
    this.syncSessionObservations(record.id);
    const ready = this.registry.markSessionReady(record.id, realm.id, descriptor);
    this.unpublished.delete(record.id);
    if (!ready.ok || ready.value === undefined) {
      // The record left `creating` while the Realm session was being built —
      // an engine crash projected it to `failed` (design §6.2). Never report
      // that as a successful create with a stale snapshot. The Realm binding is
      // kept: §6.2.7 makes the explicit `session_close` the single cleanup
      // point for a session that may still own an engine child.
      this.brokers.get(record.id)?.dispose();
      this.brokers.delete(record.id);
      const current = this.registry.getSession(record.id);
      throw toPluginException(mapError(current?.failure ?? { code: 'ENGINE_ERROR', message: `session ${record.id} could not be published: it is ${current?.state ?? 'gone'}` }, {
        operation: 'session/publish',
        secretLiterals: this.secretLiterals,
      }));
    }
    return this.sessionOutput(ready.value);
  }

  /** Drop the in-memory Realm binding for a session that will not be published. */
  private detachSession(sessionId: string): void {
    this.brokers.get(sessionId)?.dispose();
    this.brokers.delete(sessionId);
    this.sessionObservationUnsubs.get(sessionId)?.();
    this.sessionObservationUnsubs.delete(sessionId);
    this.sessions.delete(sessionId);
  }

  private attachCreated(record: SessionRecord, realm: RunskeinSession, descriptor: Record<string, unknown>, broker?: InteractionBroker) {
    const bound = this.attachSession(record, realm, broker);
    return this.publishSession(record, realm, descriptor, bound);
  }

  private sessionOutput(record: SessionRecord) { return { sessionId: record.id, engine: record.engine, ...(record.name === undefined ? {} : { name: record.name }), cwd: record.cwd, ...(record.systemInstructions === undefined ? {} : { systemInstructions: record.systemInstructions }), permissionMode: record.permissionMode, mcpServerIds: [...record.mcpServerIds], ...(Object.keys(record.desiredConfig).length ? { config: { ...record.desiredConfig } } : {}), ...(record.usage === undefined ? {} : { usage: record.usage }), ...(record.observedConfig === undefined ? {} : { observedConfig: record.observedConfig }), state: record.state, ...(record.activeTurnId === undefined ? {} : { activeTurnId: record.activeTurnId }), createdAt: record.createdAt, updatedAt: record.updatedAt, ...(record.closedAt === undefined ? {} : { closedAt: record.closedAt }), ...(record.failure === undefined ? {} : { failure: record.failure }) }; }
  private realmTranscriptId(sessionId: string): string { return this.visibleSession(sessionId)?.realmSessionId ?? sessionId; }

  /**
   * Serialize the mutations design §6.1 makes mutually exclusive per session:
   * configure, fork and close never interleave their awaits on one session.
   * Close holds this lane across the transcript drain — ADR 0002 records the
   * invariant that keeps that safe.
   */
  private withSessionLane<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionLanes.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.sessionLanes.set(sessionId, settled);
    void settled.finally(() => {
      if (this.sessionLanes.get(sessionId) === settled) this.sessionLanes.delete(sessionId);
    });
    return result;
  }

  /** Archive databases this instance proved dead during its own recovery scan. */
  private async archiveDatabases(): Promise<Array<{ instanceId: string; database: string }>> {
    await this.ready;
    const result: Array<{ instanceId: string; database: string }> = [];
    for (const instanceId of this.archiveInstanceIds) {
      const database = join(this.dataRoot, 'instances', instanceId, STORE_FILE);
      if (await stat(database).then((info) => info.isFile(), () => false)) result.push({ instanceId, database });
    }
    return result;
  }

  /**
   * Resolve a plugin session id (or an archived Realm session id) to the store
   * that actually owns its events. Archives from other instances are opened
   * only when this process proved that instance's lock dead (design §9.2).
   */
  private async resolveTranscript(sessionId: string): Promise<{ store: PluginTranscriptStore; realmSessionId: string; liveSessionState?: string; release(): Promise<void> }> {
    const init = await this.ready;
    const noop = async (): Promise<void> => undefined;
    const record = this.visibleSession(sessionId);
    if (record !== undefined) return { store: init.store, realmSessionId: record.realmSessionId ?? sessionId, liveSessionState: record.state, release: noop };
    const owning = this.registry.listSessions().find((session) => !this.unpublished.has(session.id) && session.realmSessionId === sessionId);
    if (owning !== undefined) return { store: init.store, realmSessionId: sessionId, liveSessionState: owning.state, release: noop };
    if (await init.store.highWatermark(sessionId).then(() => true, () => false)) {
      return { store: init.store, realmSessionId: sessionId, release: noop };
    }
    for (const archive of await this.archiveDatabases()) {
      const store = createPluginTranscriptStore(archive.database, { dataRoot: this.dataRoot });
      if (await store.highWatermark(sessionId).then(() => true, () => false)) {
        return { store, realmSessionId: sessionId, release: () => store.close().catch(() => undefined) };
      }
      await store.close().catch(() => undefined);
    }
    fail('NOT_FOUND', `transcript ${sessionId} was not found`);
  }

  /**
   * Inventory: this instance's own sessions (live inventory keyed by plugin
   * session id) plus the archives of instances proven dead at start-up.
   */
  private async listStoredTranscripts(engine: EngineId | undefined, kind: 'live' | 'archive' | undefined) {
    const init = await this.ready;
    type Entry = { sessionId: string; engine: EngineId; name?: string; kind: 'live' | 'archive'; state: 'creating' | 'idle' | 'busy' | 'failed' | 'closing' | 'closed' | 'aborted'; createdAt: string; closedAt?: string; recoveredAt?: string; highWatermark: number };
    const output: Entry[] = [];
    for (const session of this.registry.listSessions()) {
      if (engine !== undefined && session.engine !== engine) continue;
      // Unpublished sessions are invisible; a deleted transcript is gone even
      // though its session record survives (design §6.3, §9.5).
      if (this.unpublished.has(session.id)) continue;
      const realmSessionId = session.realmSessionId ?? session.id;
      if (this.deletedTranscripts.has(realmSessionId)) continue;
      const transcriptKind = session.state === 'closed' ? 'archive' as const : 'live' as const;
      if (kind !== undefined && kind !== transcriptKind) continue;
      output.push({
        sessionId: session.id,
        engine: session.engine,
        ...(session.name === undefined ? {} : { name: session.name }),
        kind: transcriptKind,
        state: session.state,
        createdAt: session.createdAt,
        ...(session.closedAt === undefined ? {} : { closedAt: session.closedAt }),
        highWatermark: await init.store.highWatermark(realmSessionId).catch((cause: unknown) => {
          if (cause instanceof NotFoundError) return 0; // no events yet: honest zero (ADR 0038)
          throw cause;
        }),
      });
    }
    if (kind !== 'live') {
      for (const archive of await this.archiveDatabases()) {
        const store = createPluginTranscriptStore(archive.database, { dataRoot: this.dataRoot });
        try {
          // Sessions of a recovered instance are `aborted`, and the recovery
          // timestamp is their closedAt (design §9.5).
          const recoveredAt = await store.getMeta('recovered_at');
          const aborted = (await store.getMeta('sessions_state')) === 'aborted';
          for (const meta of await store.sessions()) {
            // No frozen-list filter: an archived session from an engine that is
            // no longer registered is still history the operator may read.
            if (engine !== undefined && meta.engineId !== engine) continue;
            const closed = meta.status === 'closed';
            output.push({
              sessionId: meta.sessionId,
              engine: meta.engineId as EngineId,
              kind: 'archive',
              state: closed ? 'closed' : aborted ? 'aborted' : 'closed',
              createdAt: new Date(meta.createdAt).toISOString(),
              closedAt: !closed && recoveredAt !== undefined ? recoveredAt : new Date(meta.updatedAt).toISOString(),
              ...(!closed && recoveredAt !== undefined ? { recoveredAt } : {}),
              highWatermark: await store.highWatermark(meta.sessionId),
            });
          }
        } catch { /* an unreadable archive is skipped rather than failing the inventory */ }
        finally { await store.close().catch(() => undefined); }
      }
    }
    return output.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  /**
   * Emit the classified-fault event a code is due, and nothing when it is due
   * none (ADR 0030, design §15).
   *
   * The one place a fault event's name is chosen. Six sites used to name
   * `store_error` for themselves — including `console/close`, which never
   * touches the store — which is how an event that says a subsystem came to
   * describe faults that subsystem had no part in.
   *
   * @param code - the mapped error code; the name follows from it.
   * @param fields - operation, plus whichever stable ids the site holds.
   */
  private logFault(
    code: ErrorCode,
    fields: { operation: string; sessionId?: string; turnId?: string; interactionId?: string; from?: string; to?: string },
  ): void {
    const head = faultEvent(code);
    if (head === undefined) return;
    // The head carries name and code together, so this site cannot pair a name
    // with a code of its own choosing — the union would refuse it anyway.
    if (head.event === 'store_error') this.logger.log({ ...head, ...fields });
    else if (head.event === 'internal_error') this.logger.log({ ...head, ...fields });
    else this.logger.log({ ...head, ...fields });
  }

  private assertAcceptingMutations(): void {
    if (this.closed || !this.acceptMutations || !this.lifecycle.acceptsMutations) fail('SESSION_UNAVAILABLE', 'the plugin runtime is shutting down');
  }
  /** The only session accessor tools may use: an unpublished record does not exist. */
  private visibleSession(id: string): SessionRecord | undefined {
    if (this.unpublished.has(id)) return undefined;
    return this.registry.getSession(id);
  }
  /** Project an immutable Core session view into the frozen Plugin result shape. */
  private coreSessionOutput(session: CoreSessionView) {
    const failure = session.failure === undefined ? undefined : {
      code: ({
        'invalid-input': 'INVALID_ARGUMENT',
        'resource-not-found': 'NOT_FOUND',
        'session-unavailable': 'SESSION_UNAVAILABLE',
        'state-conflict': 'CONFLICT',
        'stale-resource': 'GONE',
        'capacity-exceeded': 'LIMIT_EXCEEDED',
        'operation-unsupported': 'NOT_SUPPORTED',
        'turn-timeout': 'TURN_TIMEOUT',
        'interaction-timeout': 'INTERACTION_TIMEOUT',
        'payload-too-large': 'PAYLOAD_TOO_LARGE',
        'workspace-forbidden': 'PERMISSION_DENIED',
        'recursion-denied': 'RECURSION_DENIED',
        'provider-failure': 'ENGINE_ERROR',
        'storage-failure': 'STORE_ERROR',
        internal: 'INTERNAL',
      } as Record<string, ErrorCode>)[session.failure.code],
      message: session.failure.message,
      ...(session.failure.details === undefined ? {} : { details: { ...session.failure.details } }),
      ...(session.failure.cause === undefined ? {} : { cause: session.failure.cause }),
    };
    return {
      sessionId: session.sessionId,
      engine: session.engine,
      ...(session.name === undefined ? {} : { name: session.name }),
      cwd: session.cwd,
      ...(session.systemInstructions === undefined ? {} : { systemInstructions: session.systemInstructions }),
      permissionMode: session.permissionMode,
      mcpServerIds: [...session.mcpServerIds],
      ...(Object.keys(session.config).length === 0 ? {} : { config: { ...session.config } }),
      ...(session.usage === undefined ? {} : { usage: { ...session.usage } }),
      ...(session.observedConfig === undefined ? {} : { observedConfig: { ...session.observedConfig } }),
      state: session.state,
      ...(session.activeTurnId === undefined ? {} : { activeTurnId: session.activeTurnId }),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(session.closedAt === undefined ? {} : { closedAt: session.closedAt }),
      ...(failure === undefined ? {} : { failure }),
    };
  }
  /** Project an immutable Core turn view into the Plugin result shape. */
  private coreTurnOutput(turn: CoreTurnView) {
    const pending = turn.pendingInteractionIds.map((interactionId) => this.registry.getInteraction(interactionId)).filter((interaction): interaction is NonNullable<typeof interaction> => interaction !== undefined);
    const error = turn.error === undefined ? undefined : {
      code: ({
        'invalid-input': 'INVALID_ARGUMENT',
        'resource-not-found': 'NOT_FOUND',
        'session-unavailable': 'SESSION_UNAVAILABLE',
        'state-conflict': 'CONFLICT',
        'stale-resource': 'GONE',
        'capacity-exceeded': 'LIMIT_EXCEEDED',
        'operation-unsupported': 'NOT_SUPPORTED',
        'turn-timeout': 'TURN_TIMEOUT',
        'interaction-timeout': 'INTERACTION_TIMEOUT',
        'payload-too-large': 'PAYLOAD_TOO_LARGE',
        'workspace-forbidden': 'PERMISSION_DENIED',
        'recursion-denied': 'RECURSION_DENIED',
        'provider-failure': 'ENGINE_ERROR',
        'storage-failure': 'STORE_ERROR',
        internal: 'INTERNAL',
      } as Record<string, ErrorCode>)[turn.error.code],
      message: turn.error.message,
      ...(turn.error.details === undefined ? {} : { details: { ...turn.error.details } }),
      ...(turn.error.cause === undefined ? {} : { cause: turn.error.cause }),
    };
    return {
      turnId: turn.turnId,
      sessionId: turn.sessionId,
      engine: turn.engine,
      priority: turn.priority,
      state: turn.state,
      enqueuedAt: turn.enqueuedAt,
      ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
      ...(turn.finishedAt === undefined ? {} : { finishedAt: turn.finishedAt }),
      pendingPermissionCount: pending.filter((interaction) => interaction.kind === 'permission').length,
      pendingQuestionCount: pending.filter((interaction) => interaction.kind === 'question').length,
      pendingInteractionIds: [...turn.pendingInteractionIds],
      ...(turn.fromSeq === undefined ? {} : { fromSeq: turn.fromSeq }),
      ...(turn.throughSeq === undefined ? {} : { throughSeq: turn.throughSeq }),
      ...(turn.finalText === undefined ? {} : { finalText: turn.finalText }),
      ...(turn.stopReason === undefined ? {} : { stopReason: turn.stopReason }),
      ...(turn.usage === undefined ? {} : { usage: { ...turn.usage } }),
      ...(error === undefined ? {} : { error }),
    };
  }
  private requireSessionOutput(id: string) { const record = this.visibleSession(id); if (record === undefined) fail('NOT_FOUND', `session ${id} was not found`); return this.sessionOutput(record); }
  private turnOutput(turn: TurnRecord) { const interactions = this.registry.listInteractions(turn.id).filter((i) => i.state === 'pending'); return { turnId: turn.id, sessionId: turn.sessionId, engine: turn.engine, priority: turn.priority, state: turn.state, enqueuedAt: turn.enqueuedAt, ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }), ...(turn.finishedAt === undefined ? {} : { finishedAt: turn.finishedAt }), pendingPermissionCount: interactions.filter((i) => i.kind === 'permission').length, pendingQuestionCount: interactions.filter((i) => i.kind === 'question').length, pendingInteractionIds: interactions.map((i) => i.id), ...(turn.fromSeq === undefined ? {} : { fromSeq: turn.fromSeq }), ...(turn.throughSeq === undefined ? {} : { throughSeq: turn.throughSeq }), ...(turn.finalText === undefined ? {} : { finalText: turn.finalText }), ...(turn.stopReason === undefined ? {} : { stopReason: turn.stopReason }), ...(turn.usage === undefined ? {} : { usage: turn.usage }), ...(turn.error === undefined ? {} : { error: turn.error }) }; }
  private requireTurnOutput(id: string) { const turn = this.registry.getTurn(id); if (turn === undefined) fail('NOT_FOUND', `turn ${id} was not found`); return this.turnOutput(turn); }
}
