export interface MutationGateLimits {
  maxOpenSessions: number;
  maxActiveTurns: number;
  maxActiveTurnsPerEngine: number;
  maxQueuedTurns: number;
}

export interface MutationGateSnapshot {
  openSessions: number;
  activeTurns: number;
  queuedTurns: number;
  activeByEngine: Record<string, number>;
}

const markReleased = Symbol('markReleased');

/** Opaque lease returned by a single gate; leases cannot be transferred across gates. */
export class Reservation {
  readonly kind: 'open-session' | 'queued-turn' | 'execution';
  readonly engine?: string;
  readonly sessionId?: string;
  private isReleased = false;

  constructor(kind: Reservation['kind'], engine?: string, sessionId?: string) {
    this.kind = kind;
    if (engine !== undefined) this.engine = engine;
    if (sessionId !== undefined) this.sessionId = sessionId;
  }

  get released(): boolean {
    return this.isReleased;
  }

  [markReleased](): void {
    this.isReleased = true;
  }
}

const DEFAULT_LIMITS: MutationGateLimits = {
  maxOpenSessions: 32,
  maxActiveTurns: 8,
  maxActiveTurnsPerEngine: 2,
  maxQueuedTurns: 256,
};

function validateLimits(limits: MutationGateLimits): MutationGateLimits {
  if (!Number.isInteger(limits.maxOpenSessions) || limits.maxOpenSessions < 1 || limits.maxOpenSessions > 256) {
    throw new RangeError('maxOpenSessions must be an integer in 1..256');
  }
  if (!Number.isInteger(limits.maxActiveTurns) || limits.maxActiveTurns < 1 || limits.maxActiveTurns > 64) {
    throw new RangeError('maxActiveTurns must be an integer in 1..64');
  }
  if (
    !Number.isInteger(limits.maxActiveTurnsPerEngine) ||
    limits.maxActiveTurnsPerEngine < 1 ||
    limits.maxActiveTurnsPerEngine > 16 ||
    limits.maxActiveTurnsPerEngine > limits.maxActiveTurns
  ) {
    throw new RangeError('maxActiveTurnsPerEngine must be an integer in 1..16 and <= maxActiveTurns');
  }
  if (!Number.isInteger(limits.maxQueuedTurns) || limits.maxQueuedTurns < 1 || limits.maxQueuedTurns > 4096) {
    throw new RangeError('maxQueuedTurns must be an integer in 1..4096');
  }
  return { ...limits };
}

/** Synchronous atomic counters for reservations and execution leases. */
export class GlobalMutationGate {
  readonly limits: Readonly<MutationGateLimits>;
  private openSessions = 0;
  private activeTurns = 0;
  private queuedTurns = 0;
  private readonly activeByEngine = new Map<string, number>();
  private readonly ownedReservations = new WeakSet<Reservation>();

  private reservation(kind: Reservation['kind'], engine?: string, sessionId?: string): Reservation {
    const result = new Reservation(kind, engine, sessionId);
    this.ownedReservations.add(result);
    return result;
  }

  constructor(limits: Partial<MutationGateLimits> = {}) {
    this.limits = Object.freeze(validateLimits({ ...DEFAULT_LIMITS, ...limits }));
  }

  tryReserveOpenSession(): Reservation | undefined {
    if (this.openSessions >= this.limits.maxOpenSessions) return undefined;
    this.openSessions += 1;
    return this.reservation('open-session');
  }

  tryEnqueueTurn(): Reservation | undefined {
    if (this.queuedTurns >= this.limits.maxQueuedTurns) return undefined;
    this.queuedTurns += 1;
    return this.reservation('queued-turn');
  }

  tryAcquireExecution(engine: string, sessionId: string): Reservation | undefined {
    if (this.activeTurns >= this.limits.maxActiveTurns) return undefined;
    if ((this.activeByEngine.get(engine) ?? 0) >= this.limits.maxActiveTurnsPerEngine) return undefined;
    this.activeTurns += 1;
    this.activeByEngine.set(engine, (this.activeByEngine.get(engine) ?? 0) + 1);
    return this.reservation('execution', engine, sessionId);
  }

  release(reservation: Reservation): boolean {
    if (!this.ownedReservations.has(reservation)) return false;
    if (reservation.released) return false;
    if (reservation.kind === 'open-session') {
      if (this.openSessions === 0) throw new Error('open-session reservation underflow');
      this.openSessions -= 1;
      reservation[markReleased]();
      return true;
    }
    if (reservation.kind === 'queued-turn') {
      if (this.queuedTurns === 0) throw new Error('queued-turn reservation underflow');
      this.queuedTurns -= 1;
      reservation[markReleased]();
      return true;
    }
    if (this.activeTurns === 0 || reservation.engine === undefined) throw new Error('execution lease underflow');
    const engineCount = this.activeByEngine.get(reservation.engine) ?? 0;
    if (engineCount === 0) throw new Error(`execution lease underflow for engine ${reservation.engine}`);
    this.activeTurns -= 1;
    if (engineCount === 1) this.activeByEngine.delete(reservation.engine);
    else this.activeByEngine.set(reservation.engine, engineCount - 1);
    reservation[markReleased]();
    return true;
  }

  snapshot(): MutationGateSnapshot {
    return {
      openSessions: this.openSessions,
      activeTurns: this.activeTurns,
      queuedTurns: this.queuedTurns,
      activeByEngine: Object.fromEntries(this.activeByEngine),
    };
  }
}
