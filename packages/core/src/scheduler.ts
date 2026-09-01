import { isCoreErrorCode, type CoreErrorCode, type RegistryError } from './errors.js';
import type { Priority } from './types.js';
import {
  SessionRegistry,
  type CasResult,
  type InteractionRecord,
  type TurnInput,
  type TurnRecord,
} from './registry.js';

export interface SchedulerClock {
  now(): number;
  setTimeout(callback: () => void | Promise<void>, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Result produced when Realm prompt settles; transcript-derived fields are not accepted here. */
export interface TurnExecutionResult {
  stopReason?: string;
  usage?: Record<string, unknown>;
  error?: RegistryError;
}

/** Result produced only after the transcript lane barrier has drained. */
export interface TurnDrainResult {
  fromSeq: number | null;
  throughSeq: number;
  finalText?: string;
  error?: RegistryError;
}

export interface TurnExecutor {
  beforePrompt(turn: TurnRecord): number | Promise<number>;
  run(turn: TurnRecord, beforeSeq: number): Promise<TurnExecutionResult>;
  cancel(turn: TurnRecord): Promise<void>;
  /**
   * Resolves after transcript appends for this prompt have drained. `beforeSeq`
   * is the watermark this dispatch captured: the turn snapshot predates it.
   */
  drain(turn: TurnRecord, result: TurnExecutionResult, beforeSeq: number): Promise<TurnDrainResult>;
}

export interface SchedulerOptions {
  registry: SessionRegistry;
  executor: TurnExecutor;
  clock?: SchedulerClock;
  /** Optional adapter projection for consumers that still expose a wire vocabulary. */
  errorCode?: (domainCode: CoreErrorCode) => string;
  /** Optional adapter decoder for an upstream provider's error spelling. */
  domainErrorCode?: (candidate: string) => CoreErrorCode | undefined;
}

export interface SchedulerError extends RegistryError {}

function error(code: CoreErrorCode, message: string, project: (code: CoreErrorCode) => string): SchedulerError {
  return { code: project(code), message };
}

function internalFailure(operation: string, cause: unknown, project: (code: CoreErrorCode) => string, decode: (candidate: string) => CoreErrorCode | undefined): RegistryError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const candidate = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  const domainCandidate = typeof candidate === 'string' ? decode(candidate) : undefined;
  const code = domainCandidate
    ?? (operation === 'turn/run' ? 'provider-failure' : operation.startsWith('store/') || operation.startsWith('transcript/') ? 'storage-failure' : 'internal');
  const projected = project(code);
  return { code: projected, message, cause: { name: cause instanceof Error ? cause.name : 'Error', message, operation } };
}

interface QueueNode {
  readonly id: string;
  readonly priority: Priority;
  prev: QueueNode | undefined;
  next: QueueNode | undefined;
}

/** Priority/FIFO dispatcher with total timeout, interaction TTL, and cancel races. */
export class TurnScheduler {
  readonly registry: SessionRegistry;
  private readonly executor: TurnExecutor;
  private readonly clock: SchedulerClock;
  private readonly errorCode: (code: CoreErrorCode) => string;
  private readonly domainErrorCode: (candidate: string) => CoreErrorCode | undefined;
  private readonly turnTimers = new Map<string, unknown>();
  private readonly interactionTimers = new Map<string, unknown>();
  private readonly executions = new Map<string, Promise<void>>();
  private readonly queueNodes = new Map<string, QueueNode>();
  private readonly queueHeads: Record<Priority, QueueNode | undefined> = { high: undefined, normal: undefined, low: undefined };
  private readonly queueTails: Record<Priority, QueueNode | undefined> = { high: undefined, normal: undefined, low: undefined };
  private readonly unsubscribeInteraction: () => void;
  private dispatching = false;
  private dispatchAgain = false;
  private closed = false;

  constructor(options: SchedulerOptions) {
    this.registry = options.registry;
    this.executor = options.executor;
    this.clock = options.clock ?? realClock;
    this.errorCode = options.errorCode ?? ((code) => code);
    this.domainErrorCode = options.domainErrorCode ?? ((candidate) => isCoreErrorCode(candidate) ? candidate : undefined);
    this.unsubscribeInteraction = this.registry.onInteraction((interaction) => this.observeInteraction(interaction));
    for (const turn of this.registry.listTurns()) {
      if (turn.state === 'queued') {
        this.enqueueQueued(turn);
        this.scheduleTurnTimeout(turn);
      }
    }
    for (const interaction of this.registry.listInteractions()) this.observeInteraction(interaction);
  }

  enqueue(sessionId: string, input: TurnInput): CasResult<TurnRecord> {
    if (this.closed) return { ok: false, reason: 'not-ready' };
    const result = this.registry.createTurn(sessionId, input);
    if (!result.ok || result.value === undefined) return result;
    this.enqueueQueued(result.value);
    this.scheduleTurnTimeout(result.value);
    this.dispatch();
    return result;
  }

  dispatch(): void {
    if (this.closed) return;
    if (this.dispatching) {
      this.dispatchAgain = true;
      return;
    }
    this.dispatching = true;
    try {
      do {
        this.dispatchAgain = false;
        let started = false;
        for (const priority of ['high', 'normal', 'low'] as const) {
          let node = this.queueHeads[priority];
          while (node !== undefined) {
            const next = node.next;
            const turn = this.registry.getTurn(node.id);
            if (turn === undefined || turn.state !== 'queued' || turn.terminalClaim !== undefined) {
              this.removeQueued(node.id);
              node = next;
              continue;
            }
            if (this.isTurnTimedOut(turn)) {
              this.timeoutTurn(turn.id);
              this.removeQueued(turn.id);
              started = true;
              node = next;
              continue;
            }
            const session = this.registry.getSession(turn.sessionId);
            if (session === undefined || session.state === 'failed' || session.state === 'closing' || session.state === 'closed') {
              this.failQueued(turn.id, error('session-unavailable', 'session is unavailable', this.errorCode));
              started = true;
              node = next;
              continue;
            }
            const startedTurn = this.registry.startTurn(turn.id);
            if (!startedTurn.ok) {
              if (startedTurn.reason === 'invalid-state' && this.registry.getTurn(turn.id)?.terminalClaim !== undefined) {
                this.finishIfReady(turn.id);
                this.removeQueued(turn.id);
                started = true;
              }
              node = next;
              continue;
            }
            this.removeQueued(turn.id);
            started = true;
            const execution = this.runTurn(startedTurn.value!);
            this.executions.set(turn.id, execution);
            void execution.finally(() => {
              if (this.executions.get(turn.id) === execution) this.executions.delete(turn.id);
            });
            break;
          }
          if (started) break;
        }
        if (!started && !this.dispatchAgain) break;
      } while (true);
    } finally {
      this.dispatching = false;
    }
  }

  async cancelTurn(id: string): Promise<CasResult<TurnRecord>> {
    const turn = this.registry.getTurn(id);
    if (turn === undefined) return { ok: false, reason: 'not-found' };
    if (turn.state === 'completed' || turn.state === 'failed' || turn.state === 'cancelled') {
      return { ok: true, value: turn };
    }
    const claim = this.registry.claimTerminalCAS(id, { state: 'cancelled', source: 'cancel' });
    if (!claim.ok && claim.reason !== 'already-claimed') return claim;
    this.clearInteractionTimersForTurn(id);
    const current = this.registry.getTurn(id);
    if (current?.state === 'queued') {
      this.finishIfReady(id);
      this.clearTurnTimer(id);
      this.removeQueued(id);
      this.dispatch();
      const finished = this.registry.getTurn(id);
      return finished === undefined ? { ok: false, reason: 'not-found' } : { ok: true, value: finished };
    }
    if (
      current !== undefined &&
      current.terminalClaim?.state === 'cancelled' &&
      (current.terminalClaim.source === 'cancel' || current.terminalClaim.source === 'timeout' || current.terminalClaim.source === 'interaction-timeout') &&
      !current.realmCancelIssued
    ) {
      await this.issueCancel(current);
    }
    const execution = this.executions.get(id);
    if (execution !== undefined) await execution;
    const finished = this.registry.getTurn(id);
    return finished === undefined ? { ok: false, reason: 'not-found' } : { ok: true, value: finished };
  }

  /**
   * Drop the scheduler bookkeeping for a session the registry already claimed
   * (session close). Active executions are untouched: they settle when the
   * Realm session closes, and `drainSession` waits for them.
   */
  releaseSessionQueue(sessionId: string): void {
    for (const id of [...this.queueNodes.keys()]) {
      if (this.registry.getTurn(id)?.sessionId !== sessionId) continue;
      this.finishIfReady(id);
      this.clearInteractionTimersForTurn(id);
      this.clearTurnTimer(id);
      this.removeQueued(id);
    }
    this.dispatch();
  }

  /** Await every execution still in flight for one session. */
  async drainSession(sessionId: string): Promise<void> {
    const pending = [...this.executions.entries()]
      .filter(([id]) => this.registry.getTurn(id)?.sessionId === sessionId)
      .map(([, execution]) => execution.catch(() => undefined));
    await Promise.all(pending);
  }

  close(): void {
    this.closed = true;
    for (const id of [...this.queueNodes.keys()]) {
      this.registry.claimTerminalCAS(id, { state: 'cancelled', source: 'scheduler-close' });
      this.finishIfReady(id);
      this.clearTurnTimer(id);
      this.removeQueued(id);
    }
    this.unsubscribeInteraction();
    for (const handle of this.turnTimers.values()) this.clock.clearTimeout(handle);
    for (const handle of this.interactionTimers.values()) this.clock.clearTimeout(handle);
    this.turnTimers.clear();
    this.interactionTimers.clear();
    this.queueNodes.clear();
    for (const priority of ['high', 'normal', 'low'] as const) {
      this.queueHeads[priority] = undefined;
      this.queueTails[priority] = undefined;
    }
  }

  /** Cancel queued and active executions, then release scheduler resources. */
  async shutdown(maxWaitMs = 10_000): Promise<void> {
    const active = this.registry.listTurns().filter((turn) => !['completed', 'failed', 'cancelled'].includes(turn.state));
    const drain = Promise.all(active.map((turn) => this.cancelTurn(turn.id).catch(() => undefined))).then(() => Promise.all([...this.executions.values()].map((execution) => execution.catch(() => undefined))));
    let timeoutHandle: unknown;
    const timeout = new Promise<void>((resolve) => { timeoutHandle = this.clock.setTimeout(resolve, maxWaitMs); });
    await Promise.race([drain, timeout]);
    if (timeoutHandle !== undefined) this.clock.clearTimeout(timeoutHandle);
    this.close();
  }

  private async runTurn(turn: TurnRecord): Promise<void> {
    let beforeSeq: number | undefined;
    try {
      const watermark = this.executor.beforePrompt(turn);
      beforeSeq = typeof watermark === 'number' ? watermark : await watermark;
      if (!Number.isInteger(beforeSeq) || beforeSeq < 0) throw new Error('invalid beforeSeq watermark');
    } catch (cause) {
      const failure = internalFailure('transcript/highWatermark', cause, this.errorCode, this.domainErrorCode);
      const current = this.registry.getTurn(turn.id);
      if (this.closed && current?.terminalClaim === undefined) {
        this.registry.claimTerminalCAS(turn.id, { state: 'cancelled', source: 'scheduler-close' });
      } else {
        this.registry.claimTerminalCAS(turn.id, { state: 'failed', error: failure, source: 'store' });
      }
      this.registry.markPromptSettled(turn.id);
      this.registry.markStoreDrained(turn.id);
      this.finishIfReady(turn.id);
      this.clearTurnTimer(turn.id);
      this.dispatch();
      return;
    }
    const claimedBeforeSubmit = this.registry.getTurn(turn.id);
    if (this.closed && claimedBeforeSubmit?.terminalClaim === undefined) {
      this.registry.claimTerminalCAS(turn.id, { state: 'cancelled', source: 'scheduler-close' });
    }
    const currentBeforeSubmit = this.registry.getTurn(turn.id);
    if (currentBeforeSubmit?.terminalClaim !== undefined) {
      this.clearInteractionTimersForTurn(turn.id);
      this.registry.setTurnOutcome(turn.id, { beforeSeq, fromSeq: null, throughSeq: beforeSeq });
      this.registry.markPromptSettled(turn.id);
      this.registry.markStoreDrained(turn.id);
      this.finishIfReady(turn.id);
      this.clearTurnTimer(turn.id);
      this.dispatch();
      return;
    }
    this.registry.markPromptSubmitted(turn.id);
    let result: TurnExecutionResult;
    try {
      result = await this.executor.run(turn, beforeSeq);
    } catch (cause) {
      result = { error: internalFailure('turn/run', cause, this.errorCode, this.domainErrorCode) };
    }
    this.clearInteractionTimersForTurn(turn.id);
    const appliedPrompt = this.registry.setTurnOutcome(turn.id, { beforeSeq, ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }), ...(result.usage === undefined ? {} : { usage: result.usage }) });
    if (!appliedPrompt.ok) result = { ...result, error: internalFailure('store/drain', new Error('invalid prompt outcome boundary'), this.errorCode, this.domainErrorCode) };
    this.registry.claimTerminalCAS(
      turn.id,
      result.error === undefined ? { state: 'completed', source: 'executor' } : { state: 'failed', error: result.error, source: 'executor' },
    );
    this.registry.markPromptSettled(turn.id);
    let drained: TurnDrainResult = { fromSeq: null, throughSeq: beforeSeq };
    try {
      drained = await this.executor.drain(turn, result, beforeSeq);
    } catch (cause) {
      drained = { fromSeq: null, throughSeq: beforeSeq, error: internalFailure('store/drain', cause, this.errorCode, this.domainErrorCode) };
    }
    if (drained.error !== undefined) this.registry.recordStoreDrainFailure();
    const appliedDrain = this.registry.setTurnOutcome(turn.id, {
      fromSeq: drained.fromSeq,
      throughSeq: drained.throughSeq,
      ...(drained.finalText === undefined ? {} : { finalText: drained.finalText }),
    });
    if (!appliedDrain.ok) {
      this.registry.recordStoreDrainFailure();
    }
    this.registry.markStoreDrained(turn.id);
    this.finishIfReady(turn.id);
    this.clearTurnTimer(turn.id);
    this.dispatch();
  }

  private finishIfReady(id: string): void {
    this.registry.finishTurnCAS(id);
  }

  private failQueued(id: string, failure: SchedulerError): void {
    const claim = this.registry.claimTerminalCAS(id, { state: 'failed', error: failure, source: 'scheduler' });
    if (claim.ok || claim.reason === 'already-claimed') this.finishIfReady(id);
    this.clearInteractionTimersForTurn(id);
    this.clearTurnTimer(id);
    this.removeQueued(id);
  }

  private timeoutTurn(id: string): void {
    const turn = this.registry.getTurn(id);
    if (turn === undefined) return;
    const failure = error('turn-timeout', 'turn exceeded its timeout', this.errorCode);
    if (turn.terminalClaim !== undefined) {
      this.clearTurnTimer(id);
      this.registry.claimTerminalCAS(id, { state: 'failed', error: failure, source: 'timeout-late' });
      return;
    }
    const claim = this.registry.claimTerminalCAS(id, { state: 'failed', error: failure, source: 'timeout' });
    if (!claim.ok) return;
    this.clearInteractionTimersForTurn(id);
    if (turn.state === 'queued') {
      this.finishIfReady(id);
      this.clearTurnTimer(id);
      this.removeQueued(id);
      this.dispatch();
      return;
    }
    const latest = this.registry.getTurn(id);
    if (latest !== undefined) void this.issueCancel(latest);
  }

  private observeInteraction(interaction: InteractionRecord): void {
    const existing = this.interactionTimers.get(interaction.id);
    if (existing !== undefined) this.clock.clearTimeout(existing);
    this.interactionTimers.delete(interaction.id);
    if (interaction.state !== 'pending' || interaction.expiresAt === undefined) return;
    const due = Date.parse(interaction.expiresAt);
    if (!Number.isFinite(due)) return;
    const handle = this.clock.setTimeout(() => this.timeoutInteraction(interaction.id), Math.max(0, due - this.clock.now()));
    this.interactionTimers.set(interaction.id, handle);
  }

  private timeoutInteraction(interactionId: string): void {
    this.interactionTimers.delete(interactionId);
    const interaction = this.registry.getInteraction(interactionId);
    if (interaction === undefined || interaction.state !== 'pending') return;
    const turn = this.registry.getTurn(interaction.turnId);
    if (turn === undefined) return;
    if (turn.terminalClaim !== undefined) {
      this.registry.claimTerminalCAS(turn.id, { state: 'failed', error: error('interaction-timeout', 'interaction expired', this.errorCode), source: 'interaction-timeout-late' });
      return;
    }
    const claim = this.registry.claimTerminalCAS(turn.id, { state: 'failed', error: error('interaction-timeout', 'interaction expired', this.errorCode), source: 'interaction-timeout' });
    if (!claim.ok) return;
    this.clearInteractionTimersForTurn(turn.id);
    const latest = this.registry.getTurn(turn.id);
    if (latest?.state === 'queued') {
      this.finishIfReady(turn.id);
      this.removeQueued(turn.id);
      this.dispatch();
    } else if (latest !== undefined) {
      void this.issueCancel(latest);
    }
  }

  private async issueCancel(turn: TurnRecord): Promise<void> {
    const issued = this.registry.issueRunskeinCancel(turn.id);
    if (!issued.ok) return;
    try { await this.executor.cancel(turn); } catch { /* no fault event: the turn running on is visible via timeout/drain, which is the source of truth (ADR 0038) */ }
  }

  private isTurnTimedOut(turn: TurnRecord): boolean {
    return turn.timeoutAt !== undefined && Date.parse(turn.timeoutAt) <= this.clock.now();
  }

  private scheduleTurnTimeout(turn: TurnRecord): void {
    if (turn.timeoutAt === undefined) return;
    const due = Date.parse(turn.timeoutAt);
    if (!Number.isFinite(due)) return;
    this.clearTurnTimer(turn.id);
    this.turnTimers.set(turn.id, this.clock.setTimeout(() => this.timeoutTurn(turn.id), Math.max(0, due - this.clock.now())));
  }

  private clearTurnTimer(id: string): void {
    const handle = this.turnTimers.get(id);
    if (handle !== undefined) {
      this.clock.clearTimeout(handle);
      this.turnTimers.delete(id);
    }
  }

  private enqueueQueued(turn: TurnRecord): void {
    if (this.queueNodes.has(turn.id)) return;
    const tail = this.queueTails[turn.priority];
    const node: QueueNode = { id: turn.id, priority: turn.priority, prev: tail, next: undefined };
    if (tail === undefined) this.queueHeads[turn.priority] = node;
    else tail.next = node;
    this.queueTails[turn.priority] = node;
    this.queueNodes.set(turn.id, node);
  }

  private removeQueued(id: string): void {
    const node = this.queueNodes.get(id);
    if (node === undefined) return;
    if (node.prev === undefined) this.queueHeads[node.priority] = node.next;
    else node.prev.next = node.next;
    if (node.next === undefined) this.queueTails[node.priority] = node.prev;
    else node.next.prev = node.prev;
    this.queueNodes.delete(id);
  }

  private clearInteractionTimersForTurn(turnId: string): void {
    if (turnId.length === 0) return;
    for (const interaction of this.registry.listInteractions(turnId)) {
      if (interaction.state === 'pending') continue;
      const handle = this.interactionTimers.get(interaction.id);
      if (handle !== undefined) this.clock.clearTimeout(handle);
      this.interactionTimers.delete(interaction.id);
    }
  }

}
