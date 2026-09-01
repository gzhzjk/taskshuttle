import { readTranscriptPage, type TranscriptPage, type TranscriptPageOptions } from './transcript-page.js';
import { SessionRegistry, type InteractionInput, type RegistryObserver, type SessionConfigObservation, type SessionInput, type SessionRecord, type TurnInput, type TurnRecord } from './registry.js';
import { TurnScheduler, type SchedulerClock, type TurnExecutor } from './scheduler.js';
import type { CoreEnvironment } from './ports.js';
import { isCoreErrorCode, type CoreError, type CoreResult, type RegistryError } from './errors.js';
import { validateAnchorContent } from './anchor-policy.js';
import type {
  AgentDescriptor,
  AgentFailure,
  AgentInteractionResponse,
  AgentSessionRequest,
  EngineId,
  PermissionMode,
  Priority,
  PromptBlock,
} from './types.js';

/** Public immutable session projection returned by the Core application API. */
export interface CoreSessionView {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly engine: EngineId;
  readonly cwd: string;
  readonly name?: string;
  readonly systemInstructions?: string;
  readonly mcpServerIds: readonly string[];
  readonly parentSessionId?: string | null;
  readonly permissionMode: PermissionMode;
  readonly config: Readonly<Record<string, string | boolean>>;
  readonly descriptor: Readonly<Record<string, unknown>>;
  readonly state: SessionRecord['state'];
  readonly providerSessionId?: string;
  readonly activeTurnId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt?: string;
  readonly failure?: CoreError;
  readonly usage?: Readonly<Record<string, unknown>>;
  readonly observedConfig?: Readonly<Record<string, SessionConfigObservation>>;
}

/** Public immutable turn projection returned by the Core application API. */
export interface CoreTurnView {
  readonly turnId: string;
  readonly sessionId: string;
  readonly engine: EngineId;
  readonly prompt: readonly PromptBlock[];
  readonly priority: Priority;
  readonly state: TurnRecord['state'];
  readonly enqueuedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly pendingInteractionIds: readonly string[];
  readonly beforeSeq?: number;
  readonly fromSeq?: number | null;
  readonly throughSeq?: number;
  readonly stopReason?: string;
  readonly finalText?: string;
  readonly usage?: Readonly<Record<string, unknown>>;
  readonly error?: CoreError;
}

/** Public immutable interaction projection returned by the Core API. */
export interface CoreInteractionView {
  readonly interactionId: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly kind: 'permission' | 'question';
  readonly state: 'pending' | 'responded' | 'expired' | 'invalidated';
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly payload: unknown;
}

export interface CoreSessionRequest extends Omit<SessionInput, 'id' | 'descriptor'> {
  readonly id?: string;
}

export interface CoreForkRequest {
  readonly sessionId: string;
  readonly name?: string;
}

export interface CoreTurnRequest {
  readonly sessionId: string;
  readonly prompt: readonly PromptBlock[];
  readonly priority?: Priority;
  readonly timeoutMs?: number;
}

export interface CoreInventoryOptions {
  readonly allowUnverified?: boolean;
  /** Engine IDs declared by the composition layer as part of its frozen support set. */
  readonly frozenEngines?: ReadonlySet<string>;
  readonly verifiedEngines?: ReadonlySet<string>;
}

export interface CoreWorkerView extends AgentDescriptor {
  readonly admission: 'frozen' | 'verified' | 'operator-allowed' | 'unverified';
  readonly usable: boolean;
}

export interface WorkerCatalogService {
  inventory(options?: CoreInventoryOptions): Promise<CoreResult<readonly CoreWorkerView[]>>;
  describe(engine: EngineId): Promise<CoreResult<AgentDescriptor>>;
}

export interface SessionService {
  create(input: CoreSessionRequest): Promise<CoreResult<CoreSessionView>>;
  get(sessionId: string): CoreResult<CoreSessionView>;
  list(): readonly CoreSessionView[];
  configure(sessionId: string, patch: { readonly permissionMode?: PermissionMode; readonly config?: Readonly<Record<string, string | boolean>> }): Promise<CoreResult<CoreSessionView>>;
  fork(input: CoreForkRequest): Promise<CoreResult<CoreSessionView>>;
  close(sessionId: string): Promise<CoreResult<CoreSessionView>>;
}

export interface TurnService {
  start(input: CoreTurnRequest): CoreResult<Readonly<{ turnId: string; status: 'queued' }>>;
  get(turnId: string): CoreResult<CoreTurnView>;
  list(sessionId?: string): readonly CoreTurnView[];
  cancel(turnId: string): Promise<CoreResult<CoreTurnView>>;
}

export interface InteractionService {
  list(turnId?: string): readonly CoreInteractionView[];
  add(turnId: string, input: InteractionInput): CoreResult<CoreInteractionView>;
  resolve(interactionId: string, state: 'responded' | 'expired' | 'invalidated'): CoreResult<CoreInteractionView>;
  respond(response: AgentInteractionResponse): Promise<CoreResult<CoreInteractionView>>;
}

export interface TranscriptService {
  read(sessionId: string, highWatermark: number, options: TranscriptPageOptions): Promise<CoreResult<TranscriptPage>>;
  event(sessionId: string, seq: number): Promise<CoreResult<{ readonly bytes: Uint8Array; readonly sha256: string }>>;
}

export interface AnchorService {
  read(): Promise<CoreResult<string | undefined>>;
  write(value: string): Promise<CoreResult<void>>;
}

export interface CoreApplicationOptions {
  readonly instanceId?: string;
  readonly limits?: ConstructorParameters<typeof SessionRegistry>[0]['limits'];
  readonly interactionTtlMs?: number | null;
  readonly observer?: RegistryObserver;
  readonly executor?: TurnExecutor;
  readonly schedulerClock?: SchedulerClock;
  /** Inject the composition root's registry while the Plugin extraction is in progress. */
  readonly registry?: SessionRegistry;
  /** Inject the composition root's scheduler so queued work has one owner. */
  readonly scheduler?: TurnScheduler;
}

function failure(code: CoreError['code'], message: string, details?: Readonly<Record<string, unknown>>): CoreResult<never> {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } };
}

function domainError(error: RegistryError): CoreError {
  // The Plugin's recovery/crash bridge still supplies its frozen wire code
  // while the package boundary is being extracted. Normalize that one legacy
  // spelling here so a state-machine failure cannot surface as INTERNAL.
  const code = isCoreErrorCode(error.code) ? error.code
    : error.code === 'ENGINE_ERROR' ? 'provider-failure'
      : error.code === 'PERMISSION_DENIED' ? 'workspace-forbidden'
        : error.code === 'RECURSION_DENIED' ? 'recursion-denied'
          : error.code === 'INVALID_ARGUMENT' ? 'invalid-input'
            : 'internal';
  return {
    code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: structuredClone(error.details) }),
    ...(error.cause === undefined ? {} : { cause: structuredClone(error.cause) }),
  };
}

function providerFailure(operation: string, value: AgentFailure): CoreError {
  const code = value.code === 'permission-denied' || value.kind === 'permission-denied' ? 'workspace-forbidden'
    : value.code === 'recursion-denied' || value.kind === 'recursion-denied' ? 'recursion-denied'
      : value.code === 'invalid-input' || value.kind === 'invalid-input' ? 'invalid-input'
        : value.code === 'provider-failure' ? 'provider-failure'
    : value.kind === 'recursion-denied' ? 'recursion-denied'
      : value.kind === 'invalid-input' ? 'invalid-input'
        : 'provider-failure';
  return { code, message: value.message, cause: { name: 'AgentFailure', message: value.message, operation, ...(value.kind === undefined ? {} : { kind: value.kind }) } };
}

function isFailure(value: unknown): value is AgentFailure {
  return typeof value === 'object' && value !== null && typeof (value as { operation?: unknown }).operation === 'string' && typeof (value as { message?: unknown }).message === 'string';
}

function viewSession(record: SessionRecord): CoreSessionView {
  return Object.freeze({
    sessionId: record.id,
    instanceId: record.instanceId,
    engine: record.engine,
    cwd: record.cwd,
    ...(record.name === undefined ? {} : { name: record.name }),
    ...(record.systemInstructions === undefined ? {} : { systemInstructions: record.systemInstructions }),
    mcpServerIds: Object.freeze([...record.mcpServerIds]),
    ...(record.parentSessionId === undefined ? {} : { parentSessionId: record.parentSessionId }),
    permissionMode: record.permissionMode,
    config: Object.freeze({ ...record.desiredConfig }),
    descriptor: Object.freeze(structuredClone(record.descriptor)),
    state: record.state,
    ...(record.realmSessionId === undefined ? {} : { providerSessionId: record.realmSessionId }),
    ...(record.activeTurnId === undefined ? {} : { activeTurnId: record.activeTurnId }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.closedAt === undefined ? {} : { closedAt: record.closedAt }),
    ...(record.failure === undefined ? {} : { failure: domainError(record.failure) }),
    ...(record.usage === undefined ? {} : { usage: Object.freeze(structuredClone(record.usage)) }),
    ...(record.observedConfig === undefined ? {} : { observedConfig: Object.freeze(structuredClone(record.observedConfig)) }),
  });
}

function viewTurn(record: TurnRecord, interactions: readonly CoreInteractionView[]): CoreTurnView {
  return Object.freeze({
    turnId: record.id,
    sessionId: record.sessionId,
    engine: record.engine,
    prompt: Object.freeze(structuredClone(record.prompt) as PromptBlock[]),
    priority: record.priority,
    state: record.state,
    enqueuedAt: record.enqueuedAt,
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    pendingInteractionIds: Object.freeze(interactions.filter((item) => item.state === 'pending').map((item) => item.interactionId)),
    ...(record.beforeSeq === undefined ? {} : { beforeSeq: record.beforeSeq }),
    ...(record.fromSeq === undefined ? {} : { fromSeq: record.fromSeq }),
    ...(record.throughSeq === undefined ? {} : { throughSeq: record.throughSeq }),
    ...(record.stopReason === undefined ? {} : { stopReason: record.stopReason }),
    ...(record.finalText === undefined ? {} : { finalText: record.finalText }),
    ...(record.usage === undefined ? {} : { usage: Object.freeze(structuredClone(record.usage)) }),
    ...(record.error === undefined ? {} : { error: domainError(record.error) }),
  });
}

function viewInteraction(record: ReturnType<SessionRegistry['getInteraction']>): CoreInteractionView | undefined {
  if (record === undefined) return undefined;
  return Object.freeze({
    interactionId: record.id,
    turnId: record.turnId,
    sessionId: record.sessionId,
    kind: record.kind,
    state: record.state,
    createdAt: record.createdAt,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    payload: structuredClone(record.payload),
  });
}

function casError(reason: string | undefined): CoreError {
  if (reason === 'not-found') return { code: 'resource-not-found', message: 'resource was not found' };
  if (reason === 'not-ready') return { code: 'capacity-exceeded', message: 'resource is not ready or a configured limit was reached' };
  if (reason === 'already-claimed' || reason === 'version-mismatch') return { code: 'stale-resource', message: 'resource has already changed' };
  return { code: 'state-conflict', message: 'resource is not in a state that accepts this operation' };
}

function defaultAdmission(engine: string, options: CoreInventoryOptions): CoreWorkerView['admission'] {
  if (options.frozenEngines?.has(engine)) return 'frozen';
  if (options.verifiedEngines?.has(engine)) return 'verified';
  return options.allowUnverified === true ? 'operator-allowed' : 'unverified';
}

/**
 * Compose the provider-neutral Core application capabilities.
 *
 * The composition function allocates only in-memory domain state. All process,
 * filesystem, transport, persistence, and presentation effects arrive through
 * the injected ports and remain owned by the caller.
 * @param environment - explicit clock, id, provider, repository, and event ports
 * @param options - instance and scheduling seams for the composition root
 * @returns application services with immutable domain-result projections
 */
export function createCoreApplication(environment: CoreEnvironment, options: CoreApplicationOptions = {}): CoreApplication {
  const instanceId = options.instanceId ?? 'core-instance';
  const registry = options.registry ?? new SessionRegistry({
    instanceId,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.interactionTtlMs === undefined ? {} : { interactionTtlMs: options.interactionTtlMs }),
    ...(options.observer === undefined ? {} : { observer: options.observer }),
    clock: environment.clock,
    ids: environment.ids,
  });
  const scheduler = options.scheduler ?? (options.executor === undefined ? undefined : new TurnScheduler({ registry, executor: options.executor, ...(options.schedulerClock === undefined ? {} : { clock: options.schedulerClock }) }));
  const emit = (type: string, data: Readonly<Record<string, unknown>>): void => {
    try { environment.events?.emit({ type, at: environment.clock.now(), data }); } catch { /* observers never veto a domain mutation */ }
  };

  // Close is a session-lane operation. A second caller must join the first
  // close rather than racing the provider and attempting a second transition.
  const closeFlights = new Map<string, Promise<CoreResult<CoreSessionView>>>();
  const closeSession = (sessionId: string): Promise<CoreResult<CoreSessionView>> => {
    const existing = closeFlights.get(sessionId);
    if (existing !== undefined) return existing;
    const operation = (async (): Promise<CoreResult<CoreSessionView>> => {
      const current = registry.getSession(sessionId);
      if (current === undefined) return failure('resource-not-found', `session '${sessionId}' was not found`);
      if (current.state === 'closed') return { ok: true, value: viewSession(current) };
      const closing = registry.beginCloseSession(sessionId);
      if (!closing.ok || closing.value === undefined) return { ok: false, error: casError(closing.reason) };
      scheduler?.releaseSessionQueue(sessionId);
      try {
        if (current.realmSessionId !== undefined && environment.agents.closeSession !== undefined) {
          const result = await environment.agents.closeSession({ providerSessionId: current.realmSessionId });
          if (isFailure(result)) return { ok: false, error: providerFailure('session/close', result) };
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return { ok: false, error: { code: 'provider-failure', message, cause: { name: cause instanceof Error ? cause.name : 'Error', message, operation: 'session/close' } } };
      }
      try {
        await scheduler?.drainSession(sessionId);
        await environment.transcripts.drain?.(sessionId);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return { ok: false, error: { code: 'storage-failure', message, cause: { name: cause instanceof Error ? cause.name : 'Error', message, operation: 'session/close-drain' } } };
      }
      const done = registry.completeCloseSession(sessionId);
      if (!done.ok || done.value === undefined) return { ok: false, error: casError(done.reason) };
      emit('session.closed', { sessionId });
      return { ok: true, value: viewSession(done.value) };
    })();
    closeFlights.set(sessionId, operation);
    void operation.then(() => {
      if (closeFlights.get(sessionId) === operation) closeFlights.delete(sessionId);
    }, () => {
      if (closeFlights.get(sessionId) === operation) closeFlights.delete(sessionId);
    });
    return operation;
  };

  const interactions: InteractionService = {
    list: (turnId) => registry.listInteractions(turnId).flatMap((record) => { const item = viewInteraction(record); return item === undefined ? [] : [item]; }),
    add: (turnId, input) => {
      const result = registry.addInteraction(turnId, input);
      if (!result.ok || result.value === undefined) return { ok: false, error: casError(result.reason) };
      emit('interaction.created', { interactionId: result.value.id, turnId });
      return { ok: true, value: viewInteraction(result.value)! };
    },
    resolve: (interactionId, state) => {
      const result = registry.resolveInteractionCAS(interactionId, state);
      if (!result.ok || result.value === undefined) return { ok: false, error: casError(result.reason) };
      emit('interaction.resolved', { interactionId, state });
      return { ok: true, value: viewInteraction(result.value)! };
    },
    respond: async (response) => {
      if (environment.agents.respondInteraction === undefined) return failure('operation-unsupported', 'the provider does not accept interaction responses');
      const result = await environment.agents.respondInteraction(response);
      if (isFailure(result)) return { ok: false, error: providerFailure('interaction/respond', result) };
      const matching = response.interactionId === undefined
        ? registry.listInteractions().find((item) => item.realmQuestionRequestId === response.providerRequestId)
        : registry.getInteraction(response.interactionId);
      if (matching === undefined) return failure('resource-not-found', 'interaction was not found');
      return interactions.resolve(matching.id, 'responded');
    },
  };

  const sessions: SessionService = {
    create: async (input) => {
      const created = registry.createSession(input);
      if (!created.ok || created.value === undefined) return { ok: false, error: casError(created.reason) };
      const request: AgentSessionRequest = {
        sessionId: created.value.id,
        engine: input.engine,
        cwd: input.cwd,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.systemInstructions === undefined ? {} : { systemInstructions: input.systemInstructions }),
        mcpServerIds: [...(input.mcpServerIds ?? [])],
        permissionMode: input.permissionMode ?? 'ask-orchestrator',
        config: { ...(input.desiredConfig ?? {}) },
      };
      try {
        const provider = await environment.agents.createSession(request);
        if (isFailure(provider)) {
          const error = providerFailure('session/create', provider);
          if (provider.preSpawn === true || provider.kind === 'not-created') registry.discardCreatingSession(created.value.id);
          else registry.markSessionFailed(created.value.id, error);
          return { ok: false, error };
        }
        const descriptor = environment.agents.describe === undefined ? undefined : await environment.agents.describe(input.engine);
        const ready = registry.markSessionReady(created.value.id, provider.providerSessionId, isFailure(descriptor) || descriptor === undefined ? undefined : { ...descriptor });
        if (!ready.ok || ready.value === undefined) {
          const current = registry.getSession(created.value.id);
          if (current?.failure !== undefined) return { ok: false, error: domainError(current.failure) };
          return { ok: false, error: casError(ready.reason) };
        }
        emit('session.created', { sessionId: created.value.id, engine: input.engine });
        return { ok: true, value: viewSession(ready.value) };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const error: CoreError = { code: 'provider-failure', message, cause: { name: cause instanceof Error ? cause.name : 'Error', message, operation: 'session/create' } };
        registry.markSessionFailed(created.value.id, error);
        return { ok: false, error };
      }
    },
    get: (sessionId) => { const record = registry.getSession(sessionId); return record === undefined ? failure('resource-not-found', `session '${sessionId}' was not found`) : { ok: true, value: viewSession(record) }; },
    list: () => Object.freeze(registry.listSessions().map(viewSession)),
    configure: async (sessionId, patch) => {
      const current = registry.getSession(sessionId);
      if (current === undefined) return failure('resource-not-found', `session '${sessionId}' was not found`);
      if (patch.config !== undefined && (Object.keys(patch.config).length === 0 || current.state !== 'idle')) {
        return failure('state-conflict', 'session configuration can only change a non-empty patch while the session is idle');
      }
      if (patch.config !== undefined && environment.agents.configureSession !== undefined && current.realmSessionId !== undefined) {
        const configured = await environment.agents.configureSession({ providerSessionId: current.realmSessionId }, patch.config);
        if (isFailure(configured)) return { ok: false, error: providerFailure('session/configure', configured) };
      }
      const changed = registry.configureSession(sessionId, patch);
      if (!changed.ok || changed.value === undefined) return { ok: false, error: casError(changed.reason) };
      emit('session.configured', { sessionId });
      return { ok: true, value: viewSession(changed.value) };
    },
    fork: async ({ sessionId, name }) => {
      const source = registry.getSession(sessionId);
      if (source === undefined) return failure('resource-not-found', `session '${sessionId}' was not found`);
      if (source.realmSessionId === undefined || environment.agents.forkSession === undefined) return failure('operation-unsupported', 'the provider does not support session fork');
      const created = registry.createSession({ engine: source.engine, cwd: source.cwd, ...(name === undefined ? {} : { name }), ...(source.systemInstructions === undefined ? {} : { systemInstructions: source.systemInstructions }), mcpServerIds: source.mcpServerIds, permissionMode: source.permissionMode, desiredConfig: source.desiredConfig, parentSessionId: source.id });
      if (!created.ok || created.value === undefined) return { ok: false, error: casError(created.reason) };
      try {
        const child = await environment.agents.forkSession({ providerSessionId: source.realmSessionId }, created.value.id);
        if (isFailure(child)) { registry.markSessionFailed(created.value.id, providerFailure('session/fork', child)); return { ok: false, error: providerFailure('session/fork', child) }; }
        if (Object.keys(source.desiredConfig).length > 0 && environment.agents.configureSession !== undefined) {
          const configured = await environment.agents.configureSession({ providerSessionId: child.providerSessionId }, source.desiredConfig);
          if (isFailure(configured)) {
            const error = providerFailure('session/fork-configure', configured);
            registry.markSessionFailed(created.value.id, error);
            return { ok: false, error };
          }
        }
        const ready = registry.markSessionReady(created.value.id, child.providerSessionId, source.descriptor);
        if (!ready.ok || ready.value === undefined) return { ok: false, error: casError(ready.reason) };
        emit('session.forked', { sessionId: created.value.id, parentSessionId: source.id });
        return { ok: true, value: viewSession(ready.value) };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const error: CoreError = { code: 'provider-failure', message, cause: { name: cause instanceof Error ? cause.name : 'Error', message, operation: 'session/fork' } };
        registry.markSessionFailed(created.value.id, error);
        return { ok: false, error };
      }
    },
    close: closeSession,
  };

  const turns: TurnService = {
    start: (input) => {
      if (scheduler === undefined) return failure('session-unavailable', 'turn scheduling is not configured');
      const result = scheduler.enqueue(input.sessionId, { prompt: input.prompt, ...(input.priority === undefined ? {} : { priority: input.priority }), ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) });
      if (!result.ok || result.value === undefined) return { ok: false, error: casError(result.reason) };
      emit('turn.queued', { turnId: result.value.id, sessionId: input.sessionId });
      return { ok: true, value: Object.freeze({ turnId: result.value.id, status: 'queued' as const }) };
    },
    get: (turnId) => { const record = registry.getTurn(turnId); return record === undefined ? failure('resource-not-found', `turn '${turnId}' was not found`) : { ok: true, value: viewTurn(record, interactions.list(turnId)) }; },
    list: (sessionId) => Object.freeze(registry.listTurns(sessionId).map((record) => viewTurn(record, interactions.list(record.id)))),
    cancel: async (turnId) => {
      if (scheduler === undefined) return failure('session-unavailable', 'turn scheduling is not configured');
      const result = await scheduler.cancelTurn(turnId);
      if (!result.ok || result.value === undefined) return { ok: false, error: casError(result.reason) };
      emit('turn.cancelled', { turnId });
      return { ok: true, value: viewTurn(result.value, interactions.list(turnId)) };
    },
  };

  const catalog: WorkerCatalogService = {
    inventory: async (inventoryOptions = {}) => {
      try {
        const result = await environment.agents.inventory();
        return { ok: true, value: Object.freeze(result.agents.map((agent) => { const admission = defaultAdmission(agent.id, inventoryOptions); return Object.freeze({ ...agent, admission, usable: admission !== 'unverified' }); })) };
      } catch (cause) {
        return { ok: false, error: { code: 'provider-failure', message: cause instanceof Error ? cause.message : String(cause), cause: { name: cause instanceof Error ? cause.name : 'Error', message: cause instanceof Error ? cause.message : String(cause), operation: 'agents/inventory' } } };
      }
    },
    describe: async (engine) => {
      if (environment.agents.describe === undefined) return failure('operation-unsupported', 'the provider does not expose engine descriptors');
      try {
        const result = await environment.agents.describe(engine);
        return isFailure(result) ? { ok: false, error: providerFailure('agents/describe', result) } : { ok: true, value: Object.freeze({ ...result }) };
      } catch (cause) {
        return { ok: false, error: { code: 'provider-failure', message: cause instanceof Error ? cause.message : String(cause), cause: { name: cause instanceof Error ? cause.name : 'Error', message: cause instanceof Error ? cause.message : String(cause), operation: 'agents/describe' } } };
      }
    },
  };

  const transcript: TranscriptService = {
    read: async (sessionId, highWatermark, pageOptions) => {
      try { return { ok: true, value: await readTranscriptPage(environment.transcripts, sessionId, highWatermark, pageOptions) }; }
      catch (cause) { return { ok: false, error: { code: cause instanceof Error && 'code' in cause && (cause as { code?: unknown }).code === 'payload-too-large' ? 'payload-too-large' : 'storage-failure', message: cause instanceof Error ? cause.message : String(cause), cause: { name: cause instanceof Error ? cause.name : 'Error', message: cause instanceof Error ? cause.message : String(cause), operation: 'transcript/read' } } }; }
    },
    event: async (sessionId, seq) => {
      if (environment.transcripts.canonicalEvent === undefined) return failure('operation-unsupported', 'the transcript repository does not expose canonical events');
      const value = await environment.transcripts.canonicalEvent(sessionId, seq);
      return value === undefined ? failure('resource-not-found', `transcript event ${seq} was not found`) : { ok: true, value };
    },
  };

  const anchors: AnchorService = {
    read: async () => ({ ok: true, value: await environment.anchors.read() }),
    write: async (value) => {
      const valid = validateAnchorContent(value);
      if (!valid.ok) return valid;
      await environment.anchors.write(valid.value);
      emit('anchor.updated', {});
      return { ok: true, value: undefined };
    },
  };

  return {
    environment,
    catalog,
    sessions,
    turns,
    interactions,
    transcript,
    anchors,
    async close() { await scheduler?.shutdown(); await environment.agents.shutdown?.(); },
  };
}

export interface CoreApplication {
  readonly environment: CoreEnvironment;
  readonly catalog: WorkerCatalogService;
  readonly sessions: SessionService;
  readonly turns: TurnService;
  readonly interactions: InteractionService;
  readonly transcript: TranscriptService;
  readonly anchors: AnchorService;
  readonly close: () => Promise<void>;
}
