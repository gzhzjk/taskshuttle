export type FakeTimerCallback = () => void | Promise<void>;
export type FakeTimerHandle = number;

interface TimerTask {
  readonly id: FakeTimerHandle;
  readonly sequence: number;
  readonly callback: FakeTimerCallback;
  readonly intervalMs?: number;
  dueMs: number;
  cancelled: boolean;
}

/** A deterministic clock for timeout/TTL tests; it never sleeps the process. */
export class FakeClock {
  private currentMs: number;
  private nextId = 1;
  private nextSequence = 1;
  private readonly tasks = new Map<FakeTimerHandle, TimerTask>();
  private runningTask: TimerTask | undefined;
  private advancing = false;

  constructor(startMs = 0) {
    if (!Number.isFinite(startMs) || startMs < 0) throw new RangeError('startMs must be a finite non-negative number');
    this.currentMs = startMs;
  }

  now(): number {
    return this.currentMs;
  }

  date(): Date {
    return new Date(this.currentMs);
  }

  setTimeout(callback: FakeTimerCallback, delayMs: number): FakeTimerHandle {
    return this.schedule(callback, delayMs, undefined);
  }

  setInterval(callback: FakeTimerCallback, intervalMs: number): FakeTimerHandle {
    return this.schedule(callback, intervalMs, intervalMs);
  }

  clearTimeout(handle: FakeTimerHandle): void {
    this.cancel(handle);
  }

  clearInterval(handle: FakeTimerHandle): void {
    this.cancel(handle);
  }

  pendingCount(): number {
    return this.tasks.size + (this.runningTask === undefined || this.runningTask.cancelled ? 0 : 1);
  }

  async advanceBy(deltaMs: number): Promise<void> {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) throw new RangeError('deltaMs must be a finite non-negative number');
    return this.advanceTo(this.currentMs + deltaMs);
  }

  async advanceTo(targetMs: number): Promise<void> {
    if (!Number.isFinite(targetMs) || targetMs < this.currentMs) {
      throw new RangeError('targetMs must be finite and not earlier than the current time');
    }
    if (this.advancing) throw new Error('FakeClock does not allow reentrant time advancement');
    this.advancing = true;
    try {
      while (true) {
        const next = this.nextDueTask(targetMs);
        if (next === undefined) break;
        this.currentMs = next.dueMs;
        this.tasks.delete(next.id);
        this.runningTask = next;
        try {
          await next.callback();
        } catch (error) {
          next.cancelled = true;
          throw error;
        } finally {
          this.runningTask = undefined;
        }
        if (next.intervalMs !== undefined && !next.cancelled) {
          next.dueMs = this.currentMs + next.intervalMs;
          this.tasks.set(next.id, next);
        }
      }
      this.currentMs = targetMs;
    } finally {
      this.advancing = false;
    }
  }

  async runAll(maxSteps = 10_000): Promise<void> {
    if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new RangeError('maxSteps must be a positive integer');
    let steps = 0;
    while (this.tasks.size > 0) {
      if (++steps > maxSteps) throw new Error(`FakeClock exceeded maxSteps=${maxSteps}; likely an unbounded interval`);
      const next = this.nextDueTask(Number.POSITIVE_INFINITY);
      if (next === undefined) break;
      await this.advanceTo(next.dueMs);
    }
  }

  private schedule(callback: FakeTimerCallback, delayMs: number, intervalMs: number | undefined): FakeTimerHandle {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new RangeError('timer delay must be finite and non-negative');
    if (intervalMs !== undefined && intervalMs <= 0) throw new RangeError('interval must be greater than zero');
    const id = this.nextId++;
    this.tasks.set(id, {
      id,
      sequence: this.nextSequence++,
      callback,
      ...(intervalMs === undefined ? {} : { intervalMs }),
      dueMs: this.currentMs + delayMs,
      cancelled: false,
    });
    return id;
  }

  private cancel(handle: FakeTimerHandle): void {
    const task = this.tasks.get(handle) ?? (this.runningTask?.id === handle ? this.runningTask : undefined);
    if (task !== undefined) task.cancelled = true;
    this.tasks.delete(handle);
  }

  private nextDueTask(targetMs: number): TimerTask | undefined {
    let selected: TimerTask | undefined;
    for (const task of this.tasks.values()) {
      if (task.cancelled || task.dueMs > targetMs) continue;
      if (
        selected === undefined ||
        task.dueMs < selected.dueMs ||
        (task.dueMs === selected.dueMs && task.sequence < selected.sequence)
      ) {
        selected = task;
      }
    }
    return selected;
  }
}
