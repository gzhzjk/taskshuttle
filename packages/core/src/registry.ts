import { randomUUID } from 'node:crypto';

import type {
  EngineId,
  InteractionState,
  PermissionMode,
  Priority,
  PromptBlock,
  SessionState,
  TurnState,
} from './types.js';
import type { RegistryError } from './errors.js';
import { GlobalMutationGate, type MutationGateLimits, type Reservation } from './mutation-gate.js';
import { canTransition, transition } from './state-machine.js';

export interface WorkerDescriptorSnapshot {
  readonly [key: string]: unknown;
}

/**
 * One config key as the engine reported it (ADR 0020, design §5.1).
 * `observedAt` is ISO 8601: Realm hands over epoch milliseconds, but the
 * tool face carries every timestamp as ISO 8601, and the conversion happens
 * when the observation enters the registry (design §5.2), not on every
 * projection — a projection is a read path, multiplied by N by `session_list`.
 */
export interface SessionConfigObservation {
  value: string | boolean;
  source: 'session/new' | 'session/resume' | 'session/load' | 'current_mode_update' | 'config_option_update';
  observedAt: string;
  engineOptionId?: string;
}

export interface SessionRecord {
  readonly id: string;
  readonly instanceId: string;
  readonly engine: EngineId;
  readonly cwd: string;
  readonly name?: string;
  readonly systemInstructions?: string;
  readonly mcpServerIds: readonly string[];
  /**
   * Fork lineage (console-design §5.5), three-valued:
   * `string` — forked from that plugin session id; `null` — known root
   * (created by session_create); `undefined` — lineage unknown (records that
   * predate the field). A null never renders as "unknown" (§10.1).
   */
  readonly parentSessionId?: string | null;
  permissionMode: PermissionMode;
  desiredConfig: Record<string, string | boolean>;
  /** Engine-reported cumulative usage (mvp §10.6). Carries no timestamp: Realm's `UsageSummary` has none and this record adds none (ADR 0020). */
  usage?: Record<string, unknown>;
  /** What the engine reported it is running on, parallel to `desiredConfig` and never merged with it (ADR 0020, design §5.1). */
  observedConfig?: Record<string, SessionConfigObservation>;
  descriptor: WorkerDescriptorSnapshot;
  state: SessionState;
  realmSessionId?: string;
  activeTurnId?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  failure?: RegistryError;
  version: number;
}

export interface TurnRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly engine: EngineId;
  readonly prompt: readonly PromptBlock[];
  readonly priority: Priority;
  readonly enqueueSeq: bigint;
  readonly acceptedAt: string;
  readonly enqueuedAt: string;
  readonly timeoutMs?: number;
  readonly timeoutAt?: string;
  state: TurnState;
  startedAt?: string;
  finishedAt?: string;
  beforeSeq?: number;
  fromSeq?: number | null;
  throughSeq?: number;
  readonly pendingPermissionIds: Set<string>;
  readonly pendingQuestionIds: Set<string>;
  realmCancelIssued: boolean;
  terminalClaim?: TerminalClaim;
  stopReason?: string;
  usage?: Record<string, unknown>;
  finalText?: string;
  error?: RegistryError;
  version: number;
  promptSubmitted: boolean;
  promptSettled: boolean;
  storeDrained: boolean;
}

export interface TerminalClaim {
  readonly state: Extract<TurnState, 'completed' | 'failed' | 'cancelled'>;
  readonly error?: RegistryError;
  readonly source?: string;
}

export interface InteractionRecord {
  readonly id: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly kind: 'permission' | 'question';
  state: InteractionState;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly payload: unknown;
  readonly realmQuestionRequestId?: string;
  readonly permissionModeSnapshot?: PermissionMode;
  resolvedAt?: string;
  version: number;
}

export interface SessionInput {
  id?: string;
  /** Optional compatibility field; the registry instance is authoritative. */
  instanceId?: string;
  engine: EngineId;
  cwd: string;
  name?: string;
  systemInstructions?: string;
  mcpServerIds?: readonly string[];
  /** Fork lineage (§5.5): omit for a root, pass the parent's plugin id from session_fork. */
  parentSessionId?: string | null;
  permissionMode?: PermissionMode;
  desiredConfig?: Record<string, string | boolean>;
  descriptor?: WorkerDescriptorSnapshot;
}

export interface TurnInput {
  id?: string;
  prompt: readonly PromptBlock[];
  priority?: Priority;
  timeoutMs?: number;
}

export interface InteractionInput {
  id?: string;
  kind: InteractionRecord['kind'];
  payload: unknown;
  expiresAt?: string;
  realmQuestionRequestId?: string;
  permissionModeSnapshot?: PermissionMode;
}

/**
 * Transition notifications for observability (design §15); never domain logic.
 *
 * Callbacks run synchronously **inside** the mutation that produced them, so a
 * consumer that reads registry state from one sees a half-applied mutation
 * (pending sets and `resolvedAt` are updated after the announcement), and
 * re-entering the registry from a callback would corrupt the operation in
 * flight. Observers must only record what they are handed.
 */
export interface RegistryObserver {
  onSessionTransition?(event: { sessionId: string; engine: EngineId; from: SessionState; to: SessionState; operation: string; errorCode?: string }): void;
  onTurnTransition?(event: { turnId: string; sessionId: string; engine: EngineId; priority: Priority; from: TurnState; to: TurnState; operation: string; errorCode?: string; durationMs?: number; queuedMs?: number }): void;
  onInteractionTransition?(event: { interactionId: string; turnId: string; sessionId: string; kind: InteractionRecord['kind']; to: InteractionState; operation: string; durationMs?: number }): void;
  /** An out-of-table transition: recorded, then the invariant error is rethrown. */
  onInvalidTransition?(event: { kind: 'session' | 'turn' | 'interaction'; from: string; to: string; operation: string; sessionId?: string; turnId?: string; interactionId?: string }): void;
}

export interface RegistryOptions {
  instanceId: string;
  limits?: Partial<MutationGateLimits>;
  now?: () => string;
  gate?: GlobalMutationGate;
  /** Default interaction TTL; null disables the default TTL. */
  interactionTtlMs?: number | null;
  observer?: RegistryObserver;
  /** Injected clock and id source; the legacy `now` option remains a compatibility seam. */
  clock?: { readonly now: () => number };
  ids?: { readonly next: (kind: string) => string };
}

export interface CasResult<T> {
  readonly ok: boolean;
  readonly reason?: 'not-found' | 'version-mismatch' | 'already-claimed' | 'invalid-state' | 'not-ready';
  readonly value?: T;
}

export interface TurnOutcome {
  beforeSeq?: number;
  fromSeq?: number | null;
  throughSeq?: number;
  stopReason?: string;
  finalText?: string;
  usage?: Record<string, unknown>;
}

export interface RegistryDiagnostics {
  readonly lateTerminalClaims: number;
  readonly storeDrainFailures: number;
}

function cloneDescriptor(descriptor: WorkerDescriptorSnapshot): WorkerDescriptorSnapshot {
  return structuredClone(descriptor);
}

function cloneError(error: RegistryError): RegistryError {
  return structuredClone(error);
}

function validTurnOutcome(outcome: TurnOutcome): boolean {
  if (outcome.beforeSeq !== undefined && (!Number.isInteger(outcome.beforeSeq) || outcome.beforeSeq < 0)) return false;
  if (outcome.throughSeq !== undefined && (!Number.isInteger(outcome.throughSeq) || outcome.throughSeq < 0)) return false;
  if (outcome.fromSeq !== undefined && outcome.fromSeq !== null && (!Number.isInteger(outcome.fromSeq) || outcome.fromSeq < 1)) return false;
  if (outcome.fromSeq !== undefined && outcome.fromSeq !== null && outcome.throughSeq !== undefined && outcome.fromSeq > outcome.throughSeq) return false;
  if (outcome.beforeSeq !== undefined && outcome.throughSeq !== undefined && outcome.beforeSeq > outcome.throughSeq) return false;
  if (outcome.beforeSeq !== undefined && outcome.fromSeq !== undefined && outcome.fromSeq !== null && outcome.fromSeq <= outcome.beforeSeq) return false;
  if (outcome.beforeSeq !== undefined && outcome.fromSeq === null && outcome.throughSeq !== undefined && outcome.throughSeq !== outcome.beforeSeq) return false;
  return true;
}

function cloneSession(record: SessionRecord): SessionRecord {
  const clone: SessionRecord = {
    ...record,
    mcpServerIds: [...record.mcpServerIds],
    desiredConfig: { ...record.desiredConfig },
    descriptor: cloneDescriptor(record.descriptor),
  };
  // The observation fields hold nested objects; a shallow spread would copy
  // references, letting a caller rewrite the registry's internals. structuredClone,
  // as TurnRecord.usage already does (design §5.4).
  if (record.usage !== undefined) clone.usage = structuredClone(record.usage);
  if (record.observedConfig !== undefined) clone.observedConfig = structuredClone(record.observedConfig);
  if (record.failure !== undefined) clone.failure = cloneError(record.failure);
  return clone;
}

function cloneTurn(record: TurnRecord): TurnRecord {
  const clone: TurnRecord = {
    ...record,
    prompt: structuredClone(record.prompt),
    pendingPermissionIds: new Set(record.pendingPermissionIds),
    pendingQuestionIds: new Set(record.pendingQuestionIds),
  };
  if (record.usage !== undefined) clone.usage = structuredClone(record.usage);
  if (record.error !== undefined) clone.error = cloneError(record.error);
  if (record.terminalClaim !== undefined) {
    clone.terminalClaim = {
      ...record.terminalClaim,
      ...(record.terminalClaim.error === undefined ? {} : { error: cloneError(record.terminalClaim.error) }),
    };
  }
  return clone;
}

function cloneInteraction(record: InteractionRecord): InteractionRecord {
  return { ...record, payload: structuredClone(record.payload) };
}

/** In-memory registry with serialized session mutations and CAS terminal claims. */
export class SessionRegistry {
  readonly instanceId: string;
  readonly gate: GlobalMutationGate;
  private readonly now: () => string;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly turns = new Map<string, TurnRecord>();
  private readonly interactions = new Map<string, InteractionRecord>();
  private readonly sessionReservations = new Map<string, Reservation>();
  private readonly queuedReservations = new Map<string, Reservation>();
  private readonly executionReservations = new Map<string, Reservation>();
  private readonly sessionTails = new Map<string, Promise<void>>();
  private readonly interactionListeners = new Set<(interaction: InteractionRecord) => void>();
  private readonly interactionTtlMs: number | null;
  private readonly observer: RegistryObserver | undefined;
  private readonly nextId: (kind: string) => string;
  private enqueueSequence = 0n;
  private lateTerminalClaims = 0;
  private storeDrainFailures = 0;

  constructor(options: RegistryOptions) {
    this.instanceId = options.instanceId;
    this.gate = options.gate ?? new GlobalMutationGate(options.limits);
    this.now = options.now ?? (() => new Date(options.clock?.now() ?? Date.now()).toISOString());
    this.nextId = options.ids?.next ?? (() => randomUUID());
    const ttl = options.interactionTtlMs === undefined ? 1_800_000 : options.interactionTtlMs;
    if (ttl !== null && (!Number.isInteger(ttl) || ttl < 60_000 || ttl > 86_400_000)) {
      throw new RangeError('interactionTtlMs must be null or an integer in 60000..86400000');
    }
    this.interactionTtlMs = ttl;
    this.observer = options.observer;
  }

  /**
   * Apply and announce a state change. The enum table still validates it; the
   * observer only sees what already happened and can never veto or throw into
   * the mutation (design §15 is observability, not control).
   */
  /** Validate a transition and report an out-of-table one before rethrowing (design §6.1). */
  private applyTransition(kind: 'session' | 'turn' | 'interaction', from: string, to: string, operation: string, ids: { sessionId?: string; turnId?: string; interactionId?: string }): string {
    try {
      return transition(kind, from, to);
    } catch (cause) {
      try { this.observer?.onInvalidTransition?.({ kind, from, to, operation, ...ids }); }
      catch { /* an observer failure never masks the invariant error */ }
      throw cause;
    }
  }

  private setSessionState(record: SessionRecord, to: SessionState, operation: string): void {
    const from = record.state;
    record.state = this.applyTransition('session', from, to, operation, { sessionId: record.id }) as SessionState;
    try {
      this.observer?.onSessionTransition?.({
        sessionId: record.id,
        engine: record.engine,
        from,
        to: record.state,
        operation,
        // The code describes the transition into `failed`, not every later one.
        ...(record.state === 'failed' && record.failure !== undefined ? { errorCode: record.failure.code } : {}),
      });
    } catch { /* an observer failure never affects the state machine */ }
  }

  private setTurnState(turn: TurnRecord, to: TurnState, operation: string): void {
    const from = turn.state;
    turn.state = this.applyTransition('turn', from, to, operation, { turnId: turn.id, sessionId: turn.sessionId }) as TurnState;
    const startedAt = turn.startedAt === undefined ? undefined : Date.parse(turn.startedAt);
    const terminal = turn.state === 'completed' || turn.state === 'failed' || turn.state === 'cancelled';
    const durationMs = !terminal || startedAt === undefined || !Number.isFinite(startedAt) ? undefined : Math.max(0, Date.parse(this.now()) - startedAt);
    // Dispatch carries the queue wait — the scheduler metric §7.2 is written against.
    const enqueuedAt = Date.parse(turn.enqueuedAt);
    const queuedMs = from === 'queued' && turn.state === 'running' && Number.isFinite(enqueuedAt) ? Math.max(0, Date.parse(this.now()) - enqueuedAt) : undefined;
    try {
      this.observer?.onTurnTransition?.({
        turnId: turn.id,
        sessionId: turn.sessionId,
        engine: turn.engine,
        priority: turn.priority,
        from,
        to: turn.state,
        operation,
        // Only a terminal transition carries the claim's error code; the
        // awaiting→running normalization is not a failure.
        ...(terminal && turn.terminalClaim?.error !== undefined ? { errorCode: turn.terminalClaim.error.code } : {}),
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(queuedMs === undefined ? {} : { queuedMs }),
      });
    } catch { /* an observer failure never affects the state machine */ }
  }

  private setInteractionState(interaction: InteractionRecord, to: InteractionState, operation: string): void {
    interaction.state = this.applyTransition('interaction', interaction.state, to, operation, { interactionId: interaction.id, turnId: interaction.turnId, sessionId: interaction.sessionId }) as InteractionState;
    this.announceInteraction(interaction, operation);
  }

  private announceInteraction(interaction: InteractionRecord, operation: string): void {
    const createdAt = Date.parse(interaction.createdAt);
    const durationMs = Number.isFinite(createdAt) ? Math.max(0, Date.parse(this.now()) - createdAt) : undefined;
    try {
      this.observer?.onInteractionTransition?.({
        interactionId: interaction.id,
        turnId: interaction.turnId,
        sessionId: interaction.sessionId,
        kind: interaction.kind,
        to: interaction.state,
        operation,
        ...(durationMs === undefined ? {} : { durationMs }),
      });
    } catch { /* an observer failure never affects the state machine */ }
  }

  createSession(input: SessionInput): CasResult<SessionRecord> {
    const id = input.id ?? this.nextId('session');
    if (this.sessions.has(id)) return { ok: false, reason: 'invalid-state' };
    const reservation = this.gate.tryReserveOpenSession();
    if (reservation === undefined) return { ok: false, reason: 'not-ready' };
    const now = this.now();
    const record: SessionRecord = {
      id,
      instanceId: this.instanceId,
      engine: input.engine,
      cwd: input.cwd,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.systemInstructions === undefined ? {} : { systemInstructions: input.systemInstructions }),
      mcpServerIds: [...(input.mcpServerIds ?? [])],
      // session_create omits this → null (known root); `undefined` stays
      // reserved for "lineage unknown", which no current write path produces
      // (recovered sessions never re-enter the registry — §5.5/CONSOLE-017).
      parentSessionId: input.parentSessionId === undefined ? null : input.parentSessionId,
      permissionMode: input.permissionMode ?? 'ask-orchestrator',
      desiredConfig: { ...(input.desiredConfig ?? {}) },
      descriptor: cloneDescriptor(input.descriptor ?? {}),
      state: 'creating',
      createdAt: now,
      updatedAt: now,
      version: 0,
    };
    this.sessions.set(id, record);
    this.sessionReservations.set(id, reservation);
    return { ok: true, value: cloneSession(record) };
  }

  getSession(id: string): SessionRecord | undefined {
    const record = this.sessions.get(id);
    return record === undefined ? undefined : cloneSession(record);
  }

  listSessions(): SessionRecord[] {
    return [...this.sessions.values()].map(cloneSession);
  }

  markSessionReady(id: string, realmSessionId?: string, descriptor?: WorkerDescriptorSnapshot): CasResult<SessionRecord> {
    const record = this.sessions.get(id);
    if (record === undefined) return { ok: false, reason: 'not-found' };
    if (record.state !== 'creating') return { ok: false, reason: 'invalid-state' };
    this.setSessionState(record, 'idle', 'session/create');
    if (realmSessionId !== undefined) record.realmSessionId = realmSessionId;
    if (descriptor !== undefined) record.descriptor = cloneDescriptor(descriptor);
    record.version += 1;
    record.updatedAt = this.now();
    return { ok: true, value: cloneSession(record) };
  }

  markSessionFailed(id: string, failure: RegistryError): CasResult<SessionRecord> {
    const record = this.sessions.get(id);
    if (record === undefined) return { ok: false, reason: 'not-found' };
    if (record.state === 'failed') return { ok: true, value: cloneSession(record) };
    if (record.state === 'closed' || record.state === 'closing') return { ok: false, reason: 'invalid-state' };
    // The failure is recorded first so the transition it is announced with
    // carries the error code (design §15).
    record.failure = cloneError(failure);
    this.setSessionState(record, 'failed', 'session/failed');
    record.version += 1;
    record.updatedAt = this.now();
    return { ok: true, value: cloneSession(record) };
  }

  /** Discards a failed-before-Realm session so its open-session reservation is released. */
  discardCreatingSession(id: string): CasResult<void> {
    const record = this.sessions.get(id);
    if (record === undefined) return { ok: false, reason: 'not-found' };
    if (record.state !== 'creating' || record.realmSessionId !== undefined) return { ok: false, reason: 'invalid-state' };
    this.sessions.delete(id);
    this.releaseSessionReservation(id);
    return { ok: true };
  }

  beginCloseSession(id: string): CasResult<SessionRecord> {
    const record = this.sessions.get(id);
    if (record === undefined) return { ok: false, reason: 'not-found' };
    if (record.state === 'closed' || record.state === 'closing') return { ok: true, value: cloneSession(record) };
    if (record.state !== 'idle' && record.state !== 'busy' && record.state !== 'failed') {
      return { ok: false, reason: 'invalid-state' };
    }
    this.setSessionState(record, 'closing', 'session/close');
    record.version += 1;
    record.updatedAt = this.now();
    for (const turn of this.turns.values()) {
      if (turn.sessionId !== id || turn.state === 'completed' || turn.state === 'failed' || turn.state === 'cancelled') continue;
      this.claimTerminalCAS(turn.id, { state: 'cancelled', source: 'session-close' });
      if (turn.state === 'queued') this.finishTurnCAS(turn.id);
    }
    return { ok: true, value: cloneSession(record) };
  }

  completeCloseSession(id: string): CasResult<SessionRecord> {
    const record = this.sessions.get(id);
    if (record === undefined) return { ok: false, reason: 'not-found' };
    if (record.state === 'closed') return { ok: true, value: cloneSession(record) };
    if (record.state !== 'closing') return { ok: false, reason: 'invalid-state' };
    for (const turn of this.turns.values()) {
      if (turn.sessionId !== id || turn.state === 'completed' || turn.state === 'failed' || turn.state === 'cancelled') continue;
      return { ok: false, reason: 'not-ready' };
    }
    this.setSessionState(record, 'closed', 'session/close');
    record.closedAt = this.now();
    record.updatedAt = record.closedAt;
    record.version += 1;
    this.releaseSessionReservation(id);
    return { ok: true, value: cloneSession(record) };
  }

  /**
   * The single writer for the observation fields (design §4.1): the runtime's
   * `syncSessionObservations` folds Realm's synchronous getters in here. The
   * registry itself never reads Realm. `undefined` for a field clears it — for a
   * live session that is correct, since cumulative usage never regresses and an
   * empty observed map means the engine has not reported anything.
   */
  updateSessionObservations(id: string, observations: { usage?: Record<string, unknown>; observedConfig?: Record<string, SessionConfigObservation> }): void {
    const record = this.sessions.get(id);
    if (record === undefined) return;
    if (observations.usage === undefined) delete record.usage;
    else record.usage = structuredClone(observations.usage);
    if (observations.observedConfig === undefined) delete record.observedConfig;
    else record.observedConfig = structuredClone(observations.observedConfig);
    record.version += 1;
    record.updatedAt = this.now();
  }

  /**
   * Drop stale observed values after a successful config write.
   *
   * An engine that does not emit `config_option_update` in response to
   * `setConfig` leaves the creation-time snapshot standing as current — the
   * symptom of GZH-37. The write succeeded (otherwise the session would have
   * closed), so presenting the old observation as current is more misleading
   * than presenting nothing. A key absent from `observedConfig` already has a
   * defined meaning (`mvp §10.6`: the engine did not say) and must not be read
   * as the engine agreeing with `config`.
   */
  dropObservedConfigKeys(id: string, keys: readonly string[]): void {
    const record = this.sessions.get(id);
    if (record?.observedConfig === undefined || keys.length === 0) return;
    let changed = false;
    for (const requestedKey of keys) {
      for (const observedKey of Object.keys(record.observedConfig)) {
        const entry = record.observedConfig[observedKey];
        // Realm canonicalizes some keys (e.g. Codex `reasoning_effort` is
        // observed as `reasoning` with `engineOptionId: reasoning_effort`).
        // Drop by either the observed key or the engine's option id, and
        // use an own-property check so prototype keys never bump version.
        if (
          observedKey === requestedKey ||
          (entry !== undefined && Object.hasOwn(record.observedConfig, observedKey) && entry.engineOptionId === requestedKey)
        ) {
          if (Object.hasOwn(record.observedConfig, observedKey)) {
            delete record.observedConfig[observedKey];
            changed = true;
          }
        }
      }
    }
    if (!changed) return;
    if (Object.keys(record.observedConfig).length === 0) delete record.observedConfig;
    record.version += 1;
    record.updatedAt = this.now();
  }

  configureSession(id: string, patch: { permissionMode?: PermissionMode; config?: Record<string, string | boolean> }): CasResult<SessionRecord> {
    const record = this.sessions.get(id);
    if (record === undefined) return { ok: false, reason: 'not-found' };
    if (record.state !== 'idle' && record.state !== 'busy') return { ok: false, reason: 'invalid-state' };
    if (patch.permissionMode === undefined && patch.config === undefined) return { ok: false, reason: 'invalid-state' };
    if (patch.config !== undefined && (Object.keys(patch.config).length === 0 || record.state !== 'idle')) {
      return { ok: false, reason: 'invalid-state' };
    }
    if (patch.permissionMode !== undefined && record.state === 'busy') {
      const active = record.activeTurnId === undefined ? undefined : this.turns.get(record.activeTurnId);
      const pendingPermission = active !== undefined && [...active.pendingPermissionIds].some((interactionId) => {
        return this.interactions.get(interactionId)?.state === 'pending';
      });
      if (pendingPermission) return { ok: false, reason: 'invalid-state' };
    }
    if (patch.permissionMode !== undefined) record.permissionMode = patch.permissionMode;
    if (patch.config !== undefined) record.desiredConfig = { ...record.desiredConfig, ...patch.config };
    record.version += 1;
    record.updatedAt = this.now();
    return { ok: true, value: cloneSession(record) };
  }

  createTurn(sessionId: string, input: TurnInput): CasResult<TurnRecord> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return { ok: false, reason: 'not-found' };
    if (session.state !== 'idle' && session.state !== 'busy') return { ok: false, reason: 'invalid-state' };
    if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 86_400_000)) {
      return { ok: false, reason: 'invalid-state' };
    }
    const reservation = this.gate.tryEnqueueTurn();
    if (reservation === undefined) return { ok: false, reason: 'not-ready' };
    const id = input.id ?? this.nextId('turn');
    if (this.turns.has(id)) {
      this.gate.release(reservation);
      return { ok: false, reason: 'invalid-state' };
    }
    const now = this.now();
    const turn: TurnRecord = {
      id,
      sessionId,
      engine: session.engine,
      prompt: structuredClone(input.prompt),
      priority: input.priority ?? 'normal',
      enqueueSeq: ++this.enqueueSequence,
      acceptedAt: now,
      enqueuedAt: now,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs, timeoutAt: new Date(Date.parse(now) + input.timeoutMs).toISOString() }),
      state: 'queued',
      pendingPermissionIds: new Set(),
      pendingQuestionIds: new Set(),
      realmCancelIssued: false,
      version: 0,
      promptSubmitted: false,
      promptSettled: false,
      storeDrained: false,
    };
    this.turns.set(id, turn);
    this.queuedReservations.set(id, reservation);
    return { ok: true, value: cloneTurn(turn) };
  }

  getTurn(id: string): TurnRecord | undefined {
    const turn = this.turns.get(id);
    return turn === undefined ? undefined : cloneTurn(turn);
  }

  listTurns(sessionId?: string): TurnRecord[] {
    return [...this.turns.values()].filter((turn) => sessionId === undefined || turn.sessionId === sessionId).sort((a, b) => Number(a.enqueueSeq - b.enqueueSeq)).map(cloneTurn);
  }

  startTurn(id: string): CasResult<TurnRecord> {
    const turn = this.turns.get(id);
    if (turn === undefined) return { ok: false, reason: 'not-found' };
    if (turn.state !== 'queued') return { ok: false, reason: 'invalid-state' };
    if (turn.terminalClaim !== undefined) return { ok: false, reason: 'invalid-state' };
    const session = this.sessions.get(turn.sessionId);
    if (session === undefined || session.state === 'failed' || session.state === 'closing' || session.state === 'closed') return { ok: false, reason: 'invalid-state' };
    if (session.state !== 'idle' && session.state !== 'busy') return { ok: false, reason: 'invalid-state' };
    if (session.activeTurnId !== undefined) return { ok: false, reason: 'not-ready' };
    if (session.state === 'busy') return { ok: false, reason: 'invalid-state' };
    const lease = this.gate.tryAcquireExecution(turn.engine, turn.sessionId);
    if (lease === undefined) return { ok: false, reason: 'not-ready' };
    const queueReservation = this.queuedReservations.get(id);
    if (queueReservation !== undefined) {
      this.gate.release(queueReservation);
      this.queuedReservations.delete(id);
    }
    this.executionReservations.set(id, lease);
    this.setTurnState(turn, 'running', 'turn/dispatch');
    turn.startedAt = this.now();
    turn.version += 1;
    if (session.state === 'idle') {
      this.setSessionState(session, 'busy', 'turn/dispatch');
      session.activeTurnId = id;
      session.version += 1;
      session.updatedAt = turn.startedAt;
    }
    return { ok: true, value: cloneTurn(turn) };
  }

  claimTerminalCAS(id: string, claim: TerminalClaim, expectedVersion?: number): CasResult<TurnRecord> {
    const turn = this.turns.get(id);
    if (turn === undefined) return { ok: false, reason: 'not-found' };
    if (expectedVersion !== undefined && expectedVersion !== turn.version) return { ok: false, reason: 'version-mismatch' };
    if (turn.terminalClaim !== undefined) {
      if (this.lateTerminalClaims < Number.MAX_SAFE_INTEGER) this.lateTerminalClaims += 1;
      return { ok: false, reason: 'already-claimed', value: cloneTurn(turn) };
    }
    if (turn.state === 'completed' || turn.state === 'failed' || turn.state === 'cancelled') return { ok: false, reason: 'invalid-state' };
    const claimFrom = turn.state === 'awaiting-interaction' ? 'running' : turn.state;
    if (!canTransition('turn', claimFrom, claim.state)) return { ok: false, reason: 'invalid-state' };
    if (turn.state === 'awaiting-interaction') {
      this.setTurnState(turn, 'running', 'turn/terminal-claim');
      this.invalidateTurnInteractions(turn, 'terminal-claim');
    }
    turn.terminalClaim = {
      ...claim,
      ...(claim.error === undefined ? {} : { error: cloneError(claim.error) }),
    };
    if (turn.state === 'queued') {
      turn.promptSettled = true;
      turn.storeDrained = true;
      const queued = this.queuedReservations.get(id);
      if (queued !== undefined) {
        this.gate.release(queued);
        this.queuedReservations.delete(id);
      }
    }
    turn.version += 1;
    return { ok: true, value: cloneTurn(turn) };
  }

  markPromptSettled(id: string, expectedVersion?: number): CasResult<TurnRecord> {
    const turn = this.turns.get(id);
    if (turn === undefined) return { ok: false, reason: 'not-found' };
    if (expectedVersion !== undefined && expectedVersion !== turn.version) return { ok: false, reason: 'version-mismatch' };
    if (!turn.promptSettled) {
      turn.promptSettled = true;
      turn.version += 1;
    }
    return { ok: true, value: cloneTurn(turn) };
  }

  markPromptSubmitted(id: string, expectedVersion?: number): CasResult<TurnRecord> {
    const turn = this.turns.get(id);
    if (turn === undefined) return { ok: false, reason: 'not-found' };
    if (expectedVersion !== undefined && expectedVersion !== turn.version) return { ok: false, reason: 'version-mismatch' };
    if (!turn.promptSubmitted) {
      turn.promptSubmitted = true;
      turn.version += 1;
    }
    return { ok: true, value: cloneTurn(turn) };
  }

  setTurnOutcome(id: string, outcome: TurnOutcome, expectedVersion?: number): CasResult<TurnRecord> {
    const turn = this.turns.get(id);
    if (turn === undefined) return { ok: false, reason: 'not-found' };
    if (expectedVersion !== undefined && expectedVersion !== turn.version) return { ok: false, reason: 'version-mismatch' };
    if (
      (outcome.beforeSeq !== undefined && turn.beforeSeq !== undefined && outcome.beforeSeq !== turn.beforeSeq) ||
      (outcome.fromSeq !== undefined && turn.fromSeq !== undefined && outcome.fromSeq !== turn.fromSeq) ||
      (outcome.throughSeq !== undefined && turn.throughSeq !== undefined && outcome.throughSeq !== turn.throughSeq)
    ) return { ok: false, reason: 'invalid-state' };
    const candidate: TurnOutcome = {
      ...(turn.beforeSeq === undefined ? {} : { beforeSeq: turn.beforeSeq }),
      ...(turn.fromSeq === undefined ? {} : { fromSeq: turn.fromSeq }),
      ...(turn.throughSeq === undefined ? {} : { throughSeq: turn.throughSeq }),
      ...outcome,
    };
    if (!validTurnOutcome(candidate)) return { ok: false, reason: 'invalid-state' };
    if (turn.state === 'completed' || turn.state === 'failed' || turn.state === 'cancelled') {
      return { ok: false, reason: 'already-claimed', value: cloneTurn(turn) };
    }
    if (outcome.beforeSeq !== undefined) turn.beforeSeq = outcome.beforeSeq;
    if (outcome.fromSeq !== undefined) turn.fromSeq = outcome.fromSeq;
    if (outcome.throughSeq !== undefined) turn.throughSeq = outcome.throughSeq;
    if (outcome.stopReason !== undefined) turn.stopReason = outcome.stopReason;
    if (outcome.finalText !== undefined) turn.finalText = outcome.finalText;
    if (outcome.usage !== undefined) turn.usage = structuredClone(outcome.usage);
    turn.version += 1;
    return { ok: true, value: cloneTurn(turn) };
  }

  issueRunskeinCancel(id: string): CasResult<TurnRecord> {
    const turn = this.turns.get(id);
    if (turn === undefined) return { ok: false, reason: 'not-found' };
    if (turn.realmCancelIssued) return { ok: false, reason: 'already-claimed', value: cloneTurn(turn) };
    if (
      turn.terminalClaim === undefined ||
      turn.terminalClaim.state === 'completed' ||
      !turn.promptSubmitted ||
      (turn.state !== 'running' && turn.state !== 'awaiting-interaction')
    ) {
      return { ok: false, reason: 'invalid-state' };
    }
    turn.realmCancelIssued = true;
    turn.version += 1;
    return { ok: true, value: cloneTurn(turn) };
  }

  markStoreDrained(id: string, expectedVersion?: number): CasResult<TurnRecord> {
    const turn = this.turns.get(id);
    if (turn === undefined) return { ok: false, reason: 'not-found' };
    if (expectedVersion !== undefined && expectedVersion !== turn.version) return { ok: false, reason: 'version-mismatch' };
    if (!turn.storeDrained) {
      turn.storeDrained = true;
      turn.version += 1;
    }
    return { ok: true, value: cloneTurn(turn) };
  }

  finishTurnCAS(id: string, expectedVersion?: number): CasResult<TurnRecord> {
    const turn = this.turns.get(id);
    if (turn === undefined) return { ok: false, reason: 'not-found' };
    if (expectedVersion !== undefined && expectedVersion !== turn.version) return { ok: false, reason: 'version-mismatch' };
    if (turn.terminalClaim === undefined) return { ok: false, reason: 'not-ready' };
    if (!turn.promptSettled || !turn.storeDrained) return { ok: false, reason: 'not-ready' };
    if (turn.state === 'completed' || turn.state === 'failed' || turn.state === 'cancelled') return { ok: true, value: cloneTurn(turn) };
    this.setTurnState(turn, turn.terminalClaim.state, 'turn/finish');
    if (turn.terminalClaim.error === undefined) delete turn.error;
    else turn.error = cloneError(turn.terminalClaim.error);
    turn.finishedAt = this.now();
    turn.version += 1;
    const lease = this.executionReservations.get(id);
    if (lease !== undefined) {
      this.gate.release(lease);
      this.executionReservations.delete(id);
    }
    const queued = this.queuedReservations.get(id);
    if (queued !== undefined) {
      this.gate.release(queued);
      this.queuedReservations.delete(id);
    }
    const session = this.sessions.get(turn.sessionId);
    if (session !== undefined && session.activeTurnId === id) {
      delete session.activeTurnId;
      if (session.state === 'busy') this.setSessionState(session, 'idle', 'turn/finish');
      session.version += 1;
      session.updatedAt = turn.finishedAt;
    }
    return { ok: true, value: cloneTurn(turn) };
  }

  addInteraction(turnId: string, input: InteractionInput): CasResult<InteractionRecord> {
    const turn = this.turns.get(turnId);
    if (turn === undefined) return { ok: false, reason: 'not-found' };
    if (turn.state !== 'running' && turn.state !== 'awaiting-interaction') return { ok: false, reason: 'invalid-state' };
    if (turn.terminalClaim !== undefined) return { ok: false, reason: 'invalid-state' };
    const session = this.sessions.get(turn.sessionId);
    if (session === undefined) return { ok: false, reason: 'not-found' };
    const id = input.id ?? this.nextId('interaction');
    if (this.interactions.has(id)) return { ok: false, reason: 'invalid-state' };
    const createdAt = this.now();
    const interaction: InteractionRecord = {
      id,
      turnId,
      sessionId: turn.sessionId,
      kind: input.kind,
      state: 'pending',
      createdAt,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      ...(input.expiresAt === undefined && this.interactionTtlMs !== null
        ? { expiresAt: new Date(Date.parse(createdAt) + this.interactionTtlMs).toISOString() }
        : {}),
      payload: structuredClone(input.payload),
      ...(input.realmQuestionRequestId === undefined ? {} : { realmQuestionRequestId: input.realmQuestionRequestId }),
      ...(input.permissionModeSnapshot !== undefined
        ? { permissionModeSnapshot: input.permissionModeSnapshot }
        : input.kind === 'permission'
          ? { permissionModeSnapshot: session.permissionMode }
          : {}),
      version: 0,
    };
    this.interactions.set(id, interaction);
    if (input.kind === 'permission') turn.pendingPermissionIds.add(id);
    else turn.pendingQuestionIds.add(id);
    // The interaction is announced before the turn's projection so a consumer
    // never sees a turn awaiting something it has not been told about.
    this.announceInteraction(interaction, 'interaction/create');
    if (turn.state === 'running') this.setTurnState(turn, 'awaiting-interaction', 'interaction/create');
    turn.version += 1;
    const snapshot = cloneInteraction(interaction);
    for (const listener of this.interactionListeners) {
      try { listener(snapshot); } catch { /* observers cannot roll back the registry mutation */ }
    }
    return { ok: true, value: snapshot };
  }

  resolveInteractionCAS(id: string, state: Extract<InteractionState, 'responded' | 'expired' | 'invalidated'>, expectedVersion?: number): CasResult<InteractionRecord> {
    const interaction = this.interactions.get(id);
    if (interaction === undefined) return { ok: false, reason: 'not-found' };
    if (expectedVersion !== undefined && expectedVersion !== interaction.version) return { ok: false, reason: 'version-mismatch' };
    if (interaction.state !== 'pending') return { ok: false, reason: 'invalid-state', value: cloneInteraction(interaction) };
    this.setInteractionState(interaction, state, 'interaction/resolve');
    interaction.resolvedAt = this.now();
    interaction.version += 1;
    const turn = this.turns.get(interaction.turnId);
    if (turn !== undefined) {
      if (interaction.kind === 'permission') turn.pendingPermissionIds.delete(id);
      else turn.pendingQuestionIds.delete(id);
      if (turn.state === 'awaiting-interaction' && turn.pendingPermissionIds.size === 0 && turn.pendingQuestionIds.size === 0) {
        this.setTurnState(turn, 'running', 'interaction/resolve');
      }
      turn.version += 1;
    }
    const snapshot = cloneInteraction(interaction);
    for (const listener of this.interactionListeners) {
      try { listener(snapshot); } catch { /* observers cannot roll back the registry mutation */ }
    }
    return { ok: true, value: snapshot };
  }

  onInteraction(listener: (interaction: InteractionRecord) => void): () => void {
    this.interactionListeners.add(listener);
    return () => this.interactionListeners.delete(listener);
  }

  diagnostics(): RegistryDiagnostics {
    return { lateTerminalClaims: this.lateTerminalClaims, storeDrainFailures: this.storeDrainFailures };
  }

  recordStoreDrainFailure(): void {
    if (this.storeDrainFailures < Number.MAX_SAFE_INTEGER) this.storeDrainFailures += 1;
  }

  getInteraction(id: string): InteractionRecord | undefined {
    const interaction = this.interactions.get(id);
    return interaction === undefined ? undefined : cloneInteraction(interaction);
  }

  listInteractions(turnId?: string): InteractionRecord[] {
    return [...this.interactions.values()].filter((interaction) => turnId === undefined || interaction.turnId === turnId).map(cloneInteraction);
  }

  markEngineCrashed(engine: EngineId, failure: RegistryError): void {
    for (const session of this.sessions.values()) {
      if (session.engine !== engine || session.state === 'closed' || session.state === 'closing' || session.state === 'failed') continue;
      this.markSessionFailed(session.id, failure);
      for (const turn of this.turns.values()) {
        if (turn.sessionId !== session.id || turn.state === 'completed' || turn.state === 'failed' || turn.state === 'cancelled') continue;
        const claim: TerminalClaim = turn.state === 'queued'
          ? { state: 'failed', error: { ...failure, code: 'SESSION_UNAVAILABLE' } }
          : { state: 'failed', error: failure };
        this.claimTerminalCAS(turn.id, claim);
        this.finishTurnCAS(turn.id);
      }
    }
  }

  async withSessionLane<T>(sessionId: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.sessionTails.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.sessionTails.set(sessionId, settled);
    void settled.finally(() => {
      if (this.sessionTails.get(sessionId) === settled) this.sessionTails.delete(sessionId);
    });
    return result;
  }

  private invalidateTurnInteractions(turn: TurnRecord, _reason: string): void {
    for (const id of [...turn.pendingPermissionIds, ...turn.pendingQuestionIds]) {
      const interaction = this.interactions.get(id);
      if (interaction?.state === 'pending') {
        this.setInteractionState(interaction, 'invalidated', 'interaction/invalidate');
        interaction.resolvedAt = this.now();
        interaction.version += 1;
        const snapshot = cloneInteraction(interaction);
        for (const listener of this.interactionListeners) {
          try { listener(snapshot); } catch { /* observers cannot roll back the registry mutation */ }
        }
      }
    }
    turn.pendingPermissionIds.clear();
    turn.pendingQuestionIds.clear();
  }

  private releaseSessionReservation(id: string): void {
    const reservation = this.sessionReservations.get(id);
    if (reservation !== undefined) {
      this.gate.release(reservation);
      this.sessionReservations.delete(id);
    }
  }
}
