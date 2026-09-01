import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import type { Hub, PermissionPolicy, Session, TranscriptEvent, TurnResult } from 'runskein';

export type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** Ports are derived from Realm's public classes; no internal adapter surface is accepted. */
export type WorkerSession = Pick<Session, 'id' | 'engine' | 'on' | 'prompt' | 'cancel' | 'close' | 'usage'>;
export interface WorkerHub {
  session(options: Parameters<Hub['session']>[0]): Promise<WorkerSession>;
  engines(...args: Parameters<Hub['engines']>): ReturnType<Hub['engines']>;
  describe(...args: Parameters<Hub['describe']>): ReturnType<Hub['describe']>;
  quit(...args: Parameters<Hub['quit']>): ReturnType<Hub['quit']>;
}

export type TranscriptEventLike = TranscriptEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export interface DelegateInput {
  engine: string;
  task: string;
  cwd?: string;
  systemInstructions?: string;
  config?: Record<string, string | boolean>;
}

export interface TaskSnapshot {
  id: string;
  engine: string;
  cwd: string;
  status: TaskStatus;
  sessionId?: string;
  createdAt: string;
  completedAt?: string;
  output?: string;
  error?: string;
  turn?: TurnResult;
  usage?: Record<string, unknown>;
}

interface TaskRecord extends TaskSnapshot {
  session?: WorkerSession;
  completion: Promise<void>;
}

const DEFAULT_SYSTEM_INSTRUCTIONS = `You are a worker delegated one bounded task by another coding agent.
Work autonomously inside the supplied working directory. Inspect relevant files, make changes when the task asks for them, and verify your work.
End with a concise report of the outcome, files changed, verification performed, and any remaining risk.`;

/** Manages delegated Realm sessions for the lifetime of one MCP connection. */
export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>();

  /**
   * Create a task manager.
   * @param hub - Realm-compatible hub used to start worker sessions.
   * @param permissionPolicy - Policy applied to every worker tool request.
   * @param maxOutputChars - Maximum captured agent-message characters per task.
   */
  constructor(
    private readonly hub: WorkerHub,
    private readonly permissionPolicy: PermissionPolicy,
    private readonly maxOutputChars = 100_000,
  ) {}

  /**
   * Start a worker without blocking until its turn completes.
   * @param input - Engine, task, working directory, and optional session settings.
   * @returns A snapshot containing the new task id.
   */
  delegate(input: DelegateInput): TaskSnapshot {
    const id = randomUUID();
    const record: TaskRecord = {
      id,
      engine: input.engine,
      cwd: resolve(input.cwd ?? process.cwd()),
      status: 'running',
      createdAt: new Date().toISOString(),
      completion: Promise.resolve(),
    };
    this.tasks.set(id, record);
    record.completion = this.run(record, input);
    return this.snapshot(record, false);
  }

  /**
   * Read the latest task state.
   * @param id - Task id returned by delegate().
   * @param includeOutput - Whether completed or partial output should be included.
   * @returns The current immutable task snapshot.
   * @throws Error when the task id is unknown.
   */
  get(id: string, includeOutput = true): TaskSnapshot {
    const record = this.requireTask(id);
    return this.snapshot(record, includeOutput);
  }

  /**
   * List task snapshots, newest first.
   * @returns Current task snapshots without their potentially large output.
   */
  list(): TaskSnapshot[] {
    return [...this.tasks.values()].reverse().map((record) => this.snapshot(record, false));
  }

  /**
   * Wait for a task to settle or for a bounded polling interval to expire.
   * @param id - Task id returned by delegate().
   * @param timeoutMs - Maximum wait before returning the still-running snapshot.
   * @returns The latest task snapshot.
   * @throws Error when the task id is unknown.
   */
  async wait(id: string, timeoutMs: number): Promise<TaskSnapshot> {
    const record = this.requireTask(id);
    if (record.status === 'running') {
      await Promise.race([
        record.completion,
        new Promise<void>((done) => setTimeout(done, Math.max(0, timeoutMs))),
      ]);
    }
    return this.snapshot(record, true);
  }

  /**
   * Cancel a running worker turn.
   * @param id - Task id returned by delegate().
   * @returns The latest task snapshot after cancellation was requested.
   * @throws Error when the task id is unknown or its session has not started.
   */
  async cancel(id: string): Promise<TaskSnapshot> {
    const record = this.requireTask(id);
    if (record.status !== 'running') return this.snapshot(record, true);
    if (record.session === undefined) throw new Error(`Task ${id} is still starting; retry cancellation shortly`);
    await record.session.cancel();
    return this.wait(id, 5_000);
  }

  /** Close all sessions and release child engine processes owned by tasks. */
  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.tasks.values()].map(async (record) => {
        if (record.status === 'running' && record.session !== undefined) await record.session.cancel();
        await record.session?.close();
      }),
    );
  }

  private async run(record: TaskRecord, input: DelegateInput): Promise<void> {
    let unsubscribe: (() => void) | undefined;
    try {
      const session = await this.hub.session({
        engine: input.engine,
        cwd: record.cwd,
        systemInstructions: input.systemInstructions ?? DEFAULT_SYSTEM_INSTRUCTIONS,
        permissionPolicy: this.permissionPolicy,
        ...(input.config === undefined ? {} : { config: input.config }),
      });
      record.session = session;
      record.sessionId = session.id;
      unsubscribe = session.on('update', (event) => this.captureAgentText(record, event));
      const turn = await session.prompt(input.task);
      record.turn = turn;
      const usage = session.usage();
      if (isRecord(usage)) record.usage = usage;
      record.status = turn.stopReason === 'cancelled' ? 'cancelled' : 'completed';
    } catch (error) {
      record.status = 'failed';
      record.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    } finally {
      unsubscribe?.();
      record.completedAt = new Date().toISOString();
      try {
        await record.session?.close();
      } catch (error) {
        if (record.error === undefined) {
          record.error = `Session close failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
  }

  private captureAgentText(record: TaskRecord, event: TranscriptEventLike): void {
    const update = event.update;
    if (update.sessionUpdate !== 'agent_message_chunk' || update.content?.type !== 'text') return;
    const text = update.content.text;
    if (text.length === 0) return;
    const combined = `${record.output ?? ''}${text}`;
    record.output = combined.length <= this.maxOutputChars ? combined : combined.slice(-this.maxOutputChars);
  }

  private requireTask(id: string): TaskRecord {
    const task = this.tasks.get(id);
    if (task === undefined) throw new Error(`Unknown task id: ${id}`);
    return task;
  }

  private snapshot(record: TaskRecord, includeOutput: boolean): TaskSnapshot {
    return {
      id: record.id,
      engine: record.engine,
      cwd: record.cwd,
      status: record.status,
      ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
      createdAt: record.createdAt,
      ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
      ...(!includeOutput || record.output === undefined ? {} : { output: record.output }),
      ...(record.error === undefined ? {} : { error: record.error }),
      ...(record.turn === undefined ? {} : { turn: record.turn }),
      ...(record.usage === undefined ? {} : { usage: record.usage }),
    };
  }
}
