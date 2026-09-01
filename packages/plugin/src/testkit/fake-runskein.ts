import type {
  Answer,
  ContentBlock,
  EngineInfo,
  EngineDescriptor,
  Hub,
  PermissionDecision,
  PermissionPolicy,
  PermissionRequest,
  QuestionRequest,
  ReactivationInfo,
  SessionStatus,
  TurnResult,
} from 'runskein';

import type { TranscriptEventLike, WorkerHub, WorkerSession } from '../task-manager.js';

export type FakePromptInput = string | readonly ContentBlock[];

export interface FakePromptCall {
  readonly input: FakePromptInput;
  readonly startedAt: number;
}

export interface FakeRunskeinSessionOptions {
  readonly id: string;
  readonly engine: string;
  readonly permissionPolicy?: PermissionPolicy;
  readonly autoResolve?: TurnResult;
  readonly closeResolvesPrompt?: boolean;
  /** Inject FakeClock.now (or another deterministic source) for call timestamps. */
  readonly now?: () => number;
  readonly callLog?: string[];
  readonly registerSession?: (session: FakeRunskeinSession) => void;
  /** NEGATIVE-TEST seam: seed the child's observed config (copy-parent behaviour). */
  readonly initialObservedConfig?: Record<string, unknown>;
  /** NEGATIVE-TEST seam: seed the child's usage (copy-parent behaviour). */
  readonly initialUsage?: Record<string, unknown>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function cloneInput(input: FakePromptInput): FakePromptInput {
  return typeof input === 'string' ? input : input.map((block) => ({ ...block }));
}

/**
 * A one-active-prompt Realm session. It intentionally rejects a second prompt
 * while the first is pending, catching accidental use of Realm's own queue.
 */
export class FakeRunskeinSession implements WorkerSession {
  readonly id: string;
  readonly engine: string;
  readonly promptCalls: FakePromptCall[] = [];
  readonly cancelCalls: number[] = [];
  readonly closeCalls: number[] = [];
  readonly setConfigCalls: Array<Record<string, string | boolean>> = [];
  readonly forkCalls: number[] = [];
  readonly crashCalls: unknown[] = [];
  readonly permissionRequests: PermissionRequest[] = [];
  readonly questionRequests: QuestionRequest[] = [];
  readonly responses: Array<{ requestId: string; answer: Answer }> = [];

  private readonly updateListeners = new Set<(event: TranscriptEventLike) => void>();
  private readonly permissionListeners = new Set<(request: PermissionRequest) => void>();
  private readonly questionListeners = new Set<(request: QuestionRequest) => void>();
  private readonly statusListeners = new Set<(status: SessionStatus) => void>();
  private readonly reactivatedListeners = new Set<(info: ReactivationInfo) => void>();
  private readonly questionDeferreds = new Map<string, Deferred<Answer | { action: 'cancel' }>>();
  private readonly permissionPolicy: PermissionPolicy | undefined;
  private readonly autoResolve: TurnResult | undefined;
  private readonly closeResolvesPrompt: boolean;
  private readonly now: () => number;
  private readonly callLog: string[] | undefined;
  private readonly registerSession: ((session: FakeRunskeinSession) => void) | undefined;
  private readonly configFailures: Array<{ error: unknown }> = [];
  private readonly forkFailures: Array<{ error: unknown }> = [];
  private currentPrompt: Deferred<TurnResult> | undefined;
  private currentUsage: Record<string, unknown>;
  private desiredConfig: Record<string, string | boolean> = {};
  private observedConfig: Record<string, unknown>;
  private usageReadFailure: { error: unknown } | undefined;
  private closed = false;

  constructor(options: FakeRunskeinSessionOptions) {
    this.id = options.id;
    this.engine = options.engine;
    this.permissionPolicy = options.permissionPolicy;
    this.autoResolve = options.autoResolve;
    this.closeResolvesPrompt = options.closeResolvesPrompt ?? true;
    this.now = options.now ?? Date.now;
    this.callLog = options.callLog;
    this.registerSession = options.registerSession;
    this.currentUsage = options.initialUsage === undefined ? {} : { ...options.initialUsage };
    this.observedConfig = options.initialObservedConfig === undefined ? {} : { ...options.initialObservedConfig };
  }

  on(event: 'update', listener: (event: TranscriptEventLike) => void): () => void;
  on(event: 'permission', listener: (request: PermissionRequest) => void): () => void;
  on(event: 'question', listener: (request: QuestionRequest) => void): () => void;
  on(event: 'status', listener: (status: SessionStatus) => void): () => void;
  // Realm gained `reactivated` (idle-release then re-attach). The fake never
  // emits it — nothing here releases an engine — but it must accept the
  // subscription, or the double stops satisfying WorkerSession.
  on(event: 'reactivated', listener: (info: ReactivationInfo) => void): () => void;
  on(event: 'update' | 'permission' | 'question' | 'status' | 'reactivated', listener: (...args: never[]) => void): () => void {
    if (event === 'update') this.updateListeners.add(listener as (event: TranscriptEventLike) => void);
    else if (event === 'permission') this.permissionListeners.add(listener as (request: PermissionRequest) => void);
    else if (event === 'question') this.questionListeners.add(listener as (request: QuestionRequest) => void);
    else if (event === 'reactivated') this.reactivatedListeners.add(listener as (info: ReactivationInfo) => void);
    else this.statusListeners.add(listener as (status: SessionStatus) => void);
    return () => {
      if (event === 'update') return this.updateListeners.delete(listener as (event: TranscriptEventLike) => void);
      if (event === 'permission') return this.permissionListeners.delete(listener as (request: PermissionRequest) => void);
      if (event === 'question') return this.questionListeners.delete(listener as (request: QuestionRequest) => void);
      if (event === 'reactivated') return this.reactivatedListeners.delete(listener as (info: ReactivationInfo) => void);
      return this.statusListeners.delete(listener as (status: SessionStatus) => void);
    };
  }

  prompt(input: string): Promise<TurnResult>;
  prompt(input: readonly ContentBlock[]): Promise<TurnResult>;
  prompt(input: FakePromptInput): Promise<TurnResult> {
    if (this.closed) return Promise.reject(new Error('fake session is closed'));
    if (this.currentPrompt !== undefined) return Promise.reject(new Error('fake session received a second active prompt'));
    const pending = deferred<TurnResult>();
    this.currentPrompt = pending;
    this.promptCalls.push({ input: cloneInput(input), startedAt: this.now() });
    if (this.autoResolve !== undefined) {
      queueMicrotask(() => {
        if (this.currentPrompt === pending) this.resolvePrompt(this.autoResolve);
      });
    }
    return pending.promise.finally(() => {
      if (this.currentPrompt === pending) this.currentPrompt = undefined;
    });
  }

  async cancel(): Promise<void> {
    this.callLog?.push(`cancel:${this.id}`);
    this.cancelCalls.push(this.now());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closeCalls.push(this.now());
    this.callLog?.push(`close:${this.id}`);
    this.closed = true;
    if (this.closeResolvesPrompt && this.currentPrompt !== undefined) this.resolvePrompt({ stopReason: 'cancelled', durationMs: 0 });
  }

  usage(): Record<string, unknown> {
    const failure = this.usageReadFailure;
    if (failure !== undefined) { this.usageReadFailure = undefined; throw failure.error; }
    return { ...this.currentUsage };
  }

  emitUpdate(event: TranscriptEventLike): void {
    for (const listener of this.updateListeners) listener(event);
  }

  emitPermission(request: PermissionRequest): void {
    for (const listener of this.permissionListeners) listener(request);
  }

  emitQuestion(request: QuestionRequest): void {
    for (const listener of this.questionListeners) listener(request);
  }

  emitStatus(status: SessionStatus): void {
    for (const listener of this.statusListeners) listener(status);
  }

  setUsage(usage: Record<string, unknown>): void {
    this.currentUsage = { ...usage };
  }

  /**
   * Make the next `usage()` read throw, as a Realm getter would if the session
   * were torn down under it. Used to pin that a refresh which cannot complete
   * is contained rather than escaping into the caller (SES-034).
   */
  failNextUsageRead(error: unknown): void {
    this.usageReadFailure = { error };
  }

  resolvePrompt(result: TurnResult = { stopReason: 'end_turn', durationMs: 0 }): void {
    const pending = this.currentPrompt;
    if (pending === undefined) throw new Error('no active fake prompt');
    pending.resolve(result);
  }

  rejectPrompt(error: unknown): void {
    const pending = this.currentPrompt;
    if (pending === undefined) throw new Error('no active fake prompt');
    pending.reject(error);
  }

  pendingPromptCount(): number {
    return this.currentPrompt === undefined ? 0 : 1;
  }

  async requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    this.permissionRequests.push(request);
    for (const listener of this.permissionListeners) listener(request);
    if (this.permissionPolicy === undefined) return { outcome: 'deny' };
    return this.permissionPolicy(request);
  }

  requestQuestion(request: QuestionRequest): Promise<Answer | { action: 'cancel' }> {
    this.questionRequests.push(request);
    const pending = deferred<Answer | { action: 'cancel' }>();
    this.questionDeferreds.set(request.requestId, pending);
    if (this.questionListeners.size === 0) {
      pending.resolve({ action: 'cancel' });
    } else {
      for (const listener of this.questionListeners) listener(request);
    }
    return pending.promise.finally(() => this.questionDeferreds.delete(request.requestId));
  }

  async respond(requestId: string, answer: Answer): Promise<void> {
    const pending = this.questionDeferreds.get(requestId);
    if (pending === undefined) throw new Error(`unknown fake question request ${requestId}`);
    this.responses.push({ requestId, answer });
    pending.resolve(answer);
  }

  failNextConfig(error: unknown): void {
    this.configFailures.push({ error });
  }

  async setConfig(config: Record<string, string | boolean>): Promise<void> {
    this.setConfigCalls.push({ ...config });
    this.callLog?.push(`setConfig:${this.id}`);
    this.desiredConfig = { ...this.desiredConfig, ...config };
    const failure = this.configFailures.shift();
    if (failure !== undefined) throw failure.error;
  }

  configState(): { desired: Record<string, string | boolean>; observed: Record<string, unknown> } {
    return { desired: { ...this.desiredConfig }, observed: { ...this.observedConfig } };
  }

  /** Replace the engine-reported observed config map (each entry carries Realm's epoch-ms `observedAt`). */
  setObservedConfig(observed: Record<string, unknown>): void {
    this.observedConfig = observed;
  }

  /** Fire the reactivated listeners, as `adoptBinding` does after writing a resume's creation state. */
  emitReactivated(info: ReactivationInfo = { tier: 'native' }): void {
    for (const listener of this.reactivatedListeners) listener(info);
  }

  failNextFork(error: unknown): void {
    this.forkFailures.push({ error });
  }

  async fork(): Promise<FakeRunskeinSession> {
    this.forkCalls.push(this.now());
    this.callLog?.push(`fork:${this.id}`);
    const failure = this.forkFailures.shift();
    if (failure !== undefined) throw failure.error;
    const child = new FakeRunskeinSession({
      id: `${this.id}-fork-${this.forkCalls.length}`,
      engine: this.engine,
      ...(this.permissionPolicy === undefined ? {} : { permissionPolicy: this.permissionPolicy }),
      ...(this.autoResolve === undefined ? {} : { autoResolve: this.autoResolve }),
      closeResolvesPrompt: this.closeResolvesPrompt,
      now: this.now,
      ...(this.callLog === undefined ? {} : { callLog: this.callLog }),
      // NEGATIVE-TEST seam: the child inherits the parent's observations.
    });
    this.registerSession?.(child);
    return child;
  }

  crash(error: unknown = new Error(`fake engine ${this.engine} crashed`)): void {
    this.crashCalls.push(error);
    this.callLog?.push(`crash:${this.id}`);
    if (this.currentPrompt !== undefined) this.currentPrompt.reject(error);
    this.emitStatus('failed');
  }

  answerQuestion(requestId: string, answer: Answer | { action: 'cancel' }): void {
    const pending = this.questionDeferreds.get(requestId);
    if (pending === undefined) throw new Error(`unknown fake question request ${requestId}`);
    pending.resolve(answer);
  }

  get pendingQuestionCount(): number {
    return this.questionDeferreds.size;
  }
}

export interface FakeRunskeinHubOptions {
  readonly autoResolve?: TurnResult;
  readonly closeResolvesPrompt?: boolean;
  readonly now?: () => number;
  readonly engineInfos?: readonly EngineInfo[];
  readonly descriptors?: Readonly<Record<string, EngineDescriptor>>;
  readonly quitResult?: unknown;
  readonly quitGate?: Promise<void>;
}

/** A controllable Hub implementation for TaskManager and future scheduler tests. */
export class FakeRunskeinHub implements WorkerHub {
  readonly sessionCalls: Array<Parameters<WorkerHub['session']>[0]> = [];
  readonly sessions = new Map<string, FakeRunskeinSession>();
  readonly engineCalls: number[] = [];
  readonly quitArguments: Array<Parameters<Hub['quit']>> = [];
  readonly callLog: string[] = [];
  quitCalls = 0;
  private readonly failures: Array<{ error: unknown }> = [];
  private readonly engineFailures = new Map<string, Array<{ error: unknown }>>();
  private readonly descriptorFailures = new Map<string, Array<{ error: unknown }>>();
  private nextSessionNumber = 1;
  private readonly options: FakeRunskeinHubOptions;

  constructor(options: FakeRunskeinHubOptions = {}) {
    this.options = options;
  }

  failNextSession(error: unknown): void {
    this.failures.push({ error });
  }

  failNextSessionFor(engine: string, error: unknown): void {
    const failures = this.engineFailures.get(engine) ?? [];
    failures.push({ error });
    this.engineFailures.set(engine, failures);
  }

  failNextDescribe(engine: string, error: unknown): void {
    const failures = this.descriptorFailures.get(engine) ?? [];
    failures.push({ error });
    this.descriptorFailures.set(engine, failures);
  }

  async session(options: Parameters<WorkerHub['session']>[0]): Promise<FakeRunskeinSession> {
    this.callLog.push(`session:${options.engine}`);
    this.sessionCalls.push(options);
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure.error;
    const engineFailure = this.engineFailures.get(options.engine)?.shift();
    if (engineFailure !== undefined) throw engineFailure.error;
    const id = `fake-session-${this.nextSessionNumber++}`;
    const session = new FakeRunskeinSession({
      id,
      engine: options.engine,
      ...(options.permissionPolicy === undefined ? {} : { permissionPolicy: options.permissionPolicy }),
      ...(this.options.autoResolve === undefined ? {} : { autoResolve: this.options.autoResolve }),
      ...(this.options.closeResolvesPrompt === undefined
        ? {}
        : { closeResolvesPrompt: this.options.closeResolvesPrompt }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      callLog: this.callLog,
      registerSession: (child) => this.sessions.set(child.id, child),
    });
    this.sessions.set(id, session);
    return session;
  }

  async engines(..._args: Parameters<Hub['engines']>): Promise<EngineInfo[]> {
    this.engineCalls.push(1);
    return [...(this.options.engineInfos ?? [])];
  }

  async describe(engine: string): Promise<EngineDescriptor> {
    this.callLog.push(`describe:${engine}`);
    const failure = this.descriptorFailures.get(engine)?.shift();
    if (failure !== undefined) throw failure.error;
    const descriptor = this.options.descriptors?.[engine];
    if (descriptor === undefined) throw new Error(`no fake descriptor configured for ${engine}`);
    return structuredClone(descriptor);
  }

  crashEngine(engine: string, error: unknown = new Error(`fake engine ${engine} crashed`)): void {
    this.callLog.push(`crash-engine:${engine}`);
    for (const session of this.sessions.values()) {
      if (session.engine === engine) session.crash(error);
    }
  }

  async quit(...args: Parameters<Hub['quit']>): Promise<void> {
    this.quitCalls += 1;
    this.quitArguments.push(args);
    this.callLog.push(`quit:${args.length === 0 ? 'omitted' : String(args[0])}`);
    if (this.options.quitGate !== undefined) await this.options.quitGate;
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
    if (this.options.quitResult !== undefined) throw this.options.quitResult;
  }
}
