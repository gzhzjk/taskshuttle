import { describe, expect, it, vi } from 'vitest';
import type { TranscriptEvent } from 'runskein';

import { TaskManager, type TranscriptEventLike, type WorkerHub, type WorkerSession } from '../packages/plugin/src/task-manager.js';

function fixture(stopReason: 'end_turn' | 'cancelled' = 'end_turn') {
  let listener: ((event: TranscriptEventLike) => void) | undefined;
  const session: WorkerSession = {
    id: 'session-1',
    engine: 'codex',
    on: vi.fn((_event, next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    }),
    prompt: vi.fn(async () => {
      const event: TranscriptEvent = {
        seq: 1,
        ts: Date.now(),
        sessionId: 'session-1',
        engineId: 'codex',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
      };
      listener?.(event);
      return { stopReason, durationMs: 3 };
    }),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    usage: vi.fn(() => ({ total: 7 })),
  };
  const hub: WorkerHub = {
    session: vi.fn(async () => session),
    engines: vi.fn(async () => []),
    describe: vi.fn(async () => { throw new Error('not implemented'); }),
    quit: vi.fn(async () => undefined),
  };
  return { hub, session };
}

describe('TaskManager', () => {
  it('runs a delegated task and captures agent text', async () => {
    const { hub, session } = fixture();
    const manager = new TaskManager(hub, () => ({ outcome: 'allow' }));

    const started = manager.delegate({ engine: 'codex', task: 'inspect it', cwd: '.' });
    const completed = await manager.wait(started.id, 1_000);

    expect(completed).toMatchObject({
      engine: 'codex',
      status: 'completed',
      sessionId: 'session-1',
      output: 'done',
      usage: { total: 7 },
    });
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('surfaces engine start failures as failed tasks', async () => {
    const hub: WorkerHub = {
      session: vi.fn(async () => {
        throw new Error('not installed');
      }),
      engines: vi.fn(async () => []),
      describe: vi.fn(async () => { throw new Error('not implemented'); }),
      quit: vi.fn(async () => undefined),
    };
    const manager = new TaskManager(hub, () => ({ outcome: 'deny' }));

    const started = manager.delegate({ engine: 'missing', task: 'work' });
    const failed = await manager.wait(started.id, 1_000);

    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('not installed');
  });

  it('rejects unknown task ids', () => {
    const { hub } = fixture();
    const manager = new TaskManager(hub, () => ({ outcome: 'allow' }));
    expect(() => manager.get('missing')).toThrow('Unknown task id');
  });
});
