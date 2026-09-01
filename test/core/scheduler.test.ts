import { describe, expect, it } from 'vitest';

import { SessionRegistry } from '../../packages/core/src/registry.js';
import { TurnScheduler, type TurnDrainResult, type TurnExecutionResult, type TurnExecutor } from '../../packages/core/src/scheduler.js';
import { FakeClock } from '../../packages/plugin/src/testkit/fake-clock.js';

const prompt = [{ type: 'text' as const, text: 'work' }];

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(cause: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function ready(registry: SessionRegistry, id: string, engine: 'codex' | 'claude-code' = 'codex'): void {
  expect(registry.createSession({ id, engine, cwd: '/tmp/project' }).ok).toBe(true);
  expect(registry.markSessionReady(id, `taskshuttle-${id}`).ok).toBe(true);
}

function harness(options: ConstructorParameters<typeof SessionRegistry>[0]['limits'] = {}, drainResult?: Deferred<TurnDrainResult>, beforeSeq = 0, beforePrompt?: Deferred<number>) {
  const clock = new FakeClock(0);
  const registry = new SessionRegistry({
    instanceId: 'scheduler-test',
    limits: { maxActiveTurns: 8, maxActiveTurnsPerEngine: 2, ...options },
    now: () => clock.date().toISOString(),
  });
  const runs = new Map<string, Deferred<TurnExecutionResult>>();
  const runOrder: string[] = [];
  const cancelCalls: string[] = [];
  const drainCalls: Array<{ id: string; beforeSeq: number }> = [];
  const executor: TurnExecutor = {
    beforePrompt: () => beforePrompt?.promise ?? beforeSeq,
    run: (turn) => {
      const pending = deferred<TurnExecutionResult>();
      runs.set(turn.id, pending);
      runOrder.push(turn.id);
      return pending.promise;
    },
    cancel: async (turn) => { cancelCalls.push(turn.id); },
    drain: async (turn, _result, dispatchBeforeSeq) => {
      drainCalls.push({ id: turn.id, beforeSeq: dispatchBeforeSeq });
      return drainResult?.promise ?? { fromSeq: null, throughSeq: dispatchBeforeSeq };
    },
  };
  const scheduler = new TurnScheduler({ registry, executor, clock });
  return { clock, registry, scheduler, runs, runOrder, cancelCalls, drainCalls };
}

async function complete(h: ReturnType<typeof harness>, id: string, result: TurnExecutionResult = {}): Promise<void> {
  h.runs.get(id)!.resolve(result);
  await Promise.resolve();
  await Promise.resolve();
}

describe('TurnScheduler', () => {
  it('dispatches strict priority/FIFO and skips blocked engine candidates', async () => {
    const h = harness({ maxActiveTurns: 2, maxActiveTurnsPerEngine: 1 });
    ready(h.registry, 'codex-active', 'codex');
    ready(h.registry, 'codex-queued', 'codex');
    ready(h.registry, 'claude', 'claude-code');
    const active = h.scheduler.enqueue('codex-active', { id: 'active', prompt, priority: 'low' }).value!;
    expect(h.runOrder).toEqual(['active']);
    h.scheduler.enqueue('codex-queued', { id: 'blocked-high', prompt, priority: 'high' });
    h.scheduler.enqueue('claude', { id: 'runnable-high', prompt, priority: 'high' });
    expect(h.runOrder).toEqual(['active', 'runnable-high']);
    await complete(h, 'runnable-high');
    await complete(h, active.id);
    expect(h.registry.getTurn('blocked-high')?.state).toBe('running');
    h.scheduler.enqueue('codex-queued', { id: 'second', prompt, priority: 'high' });
    expect(h.runOrder.at(-1)).toBe('blocked-high');
    await complete(h, 'blocked-high');
    await complete(h, 'second');
    expect(h.runOrder).toEqual(['active', 'runnable-high', 'blocked-high', 'second']);
    h.scheduler.close();
  });

  it('cancels queued turns without touching Realm and active turns exactly once', async () => {
    const h = harness({ maxActiveTurns: 1, maxActiveTurnsPerEngine: 1 });
    ready(h.registry, 's1');
    const active = h.scheduler.enqueue('s1', { id: 'active', prompt }).value!;
    const queued = h.scheduler.enqueue('s1', { id: 'queued', prompt }).value!;
    const queuedResult = await h.scheduler.cancelTurn(queued.id);
    expect(queuedResult.value?.state).toBe('cancelled');
    expect(h.cancelCalls).toEqual([]);
    const cancelOne = h.scheduler.cancelTurn(active.id);
    const cancelTwo = h.scheduler.cancelTurn(active.id);
    await Promise.resolve();
    expect(h.cancelCalls).toEqual(['active']);
    await complete(h, active.id);
    await expect(cancelOne).resolves.toMatchObject({ ok: true, value: { state: 'cancelled' } });
    await expect(cancelTwo).resolves.toMatchObject({ ok: true, value: { state: 'cancelled' } });
    expect(h.registry.getTurn(active.id)?.finalText).toBeUndefined();
    expect(h.registry.diagnostics().lateTerminalClaims).toBeGreaterThan(0);
    expect(h.registry.gate.snapshot()).toMatchObject({ activeTurns: 0, queuedTurns: 0 });
  });

  it('applies queued and active total timeouts from accepted time', async () => {
    const h = harness({ maxActiveTurns: 1, maxActiveTurnsPerEngine: 1 });
    ready(h.registry, 'active');
    ready(h.registry, 'queued');
    const active = h.scheduler.enqueue('active', { id: 'active-turn', prompt, timeoutMs: 2_000 }).value!;
    const queued = h.scheduler.enqueue('queued', { id: 'queued-turn', prompt, timeoutMs: 1_000 }).value!;
    await h.clock.advanceBy(1_000);
    expect(h.registry.getTurn(queued.id)).toMatchObject({ state: 'failed', error: { code: 'turn-timeout' } });
    expect(h.cancelCalls).toEqual([]);
    await h.clock.advanceBy(1_000);
    expect(h.cancelCalls).toEqual(['active-turn']);
    await complete(h, active.id);
    expect(h.registry.getTurn(active.id)).toMatchObject({ state: 'failed', error: { code: 'turn-timeout' } });
  });

  it('does not create a business timeout when timeoutMs is omitted', async () => {
    const h = harness({ maxActiveTurns: 1, maxActiveTurnsPerEngine: 1 });
    ready(h.registry, 's1');
    const turn = h.scheduler.enqueue('s1', { id: 'turn', prompt }).value!;
    await h.clock.advanceBy(86_400_000);
    expect(h.registry.getTurn(turn.id)?.state).toBe('running');
    await complete(h, turn.id);
    expect(h.registry.getTurn(turn.id)?.state).toBe('completed');
  });

  it('atomically cancels queued work when the scheduler closes', () => {
    const h = harness({ maxActiveTurns: 1, maxActiveTurnsPerEngine: 1 });
    ready(h.registry, 's1');
    const active = h.scheduler.enqueue('s1', { id: 'active', prompt }).value!;
    const queued = h.scheduler.enqueue('s1', { id: 'queued', prompt }).value!;
    h.scheduler.close();
    expect(h.registry.getTurn(queued.id)?.state).toBe('cancelled');
    expect(h.registry.getTurn(active.id)?.state).toBe('running');
    expect(h.registry.gate.snapshot().queuedTurns).toBe(0);
  });

  it('lets prompt completion win before a delayed transcript drain', async () => {
    const drain = deferred<TurnDrainResult>();
    const h = harness({ maxActiveTurns: 1, maxActiveTurnsPerEngine: 1 }, drain, 4);
    ready(h.registry, 's1');
    const turn = h.scheduler.enqueue('s1', { id: 'turn', prompt }).value!;
    h.runs.get(turn.id)!.resolve({});
    await Promise.resolve();
    await Promise.resolve();
    expect(h.registry.getTurn(turn.id)).toMatchObject({ state: 'running', terminalClaim: { state: 'completed' } });
    const lateCancel = h.scheduler.cancelTurn(turn.id);
    expect(h.cancelCalls).toEqual([]);
    drain.resolve({ fromSeq: 5, throughSeq: 6, finalText: 'done' });
    await expect(lateCancel).resolves.toMatchObject({ ok: true, value: { state: 'completed', beforeSeq: 4, fromSeq: 5, throughSeq: 6, finalText: 'done' } });
    expect(h.registry.diagnostics().lateTerminalClaims).toBeGreaterThan(0);
  });

  it('expires pending interactions and preserves the timeout winner through prompt drain', async () => {
    const h = harness({ maxActiveTurns: 1, maxActiveTurnsPerEngine: 1 });
    ready(h.registry, 's1');
    const turn = h.scheduler.enqueue('s1', { id: 'turn', prompt }).value!;
    const interaction = h.registry.addInteraction(turn.id, { id: 'permission', kind: 'permission', payload: { tool: 'read' } }).value!;
    expect(interaction.expiresAt).toBeDefined();
    await h.clock.advanceBy(1_800_000);
    expect(h.cancelCalls).toEqual(['turn']);
    expect(h.registry.getInteraction(interaction.id)?.state).toBe('invalidated');
    await complete(h, turn.id);
    expect(h.registry.getTurn(turn.id)).toMatchObject({ state: 'failed', error: { code: 'interaction-timeout' } });
  });

  it('uses the real transcript high-watermark when prompt rejects', async () => {
    const h = harness({ maxActiveTurns: 1, maxActiveTurnsPerEngine: 1 }, undefined, 9);
    ready(h.registry, 's1');
    const turn = h.scheduler.enqueue('s1', { id: 'rejecting', prompt }).value!;
    h.runs.get(turn.id)!.reject(new Error('realm prompt failed'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.registry.getTurn(turn.id)).toMatchObject({
      state: 'failed',
      beforeSeq: 9,
      fromSeq: null,
      throughSeq: 9,
      error: { code: 'provider-failure' },
    });
  });

  it('does not submit or cancel Realm while waiting for the transcript watermark', async () => {
    const beforePrompt = deferred<number>();
    const h = harness({ maxActiveTurns: 1, maxActiveTurnsPerEngine: 1 }, undefined, 0, beforePrompt);
    ready(h.registry, 's1');
    const turn = h.scheduler.enqueue('s1', { id: 'cancel-before-submit', prompt }).value!;
    const cancellation = h.scheduler.cancelTurn(turn.id);
    expect(h.runOrder).toEqual([]);
    expect(h.cancelCalls).toEqual([]);
    beforePrompt.resolve(12);
    await expect(cancellation).resolves.toMatchObject({ ok: true, value: { state: 'cancelled', beforeSeq: 12, fromSeq: null, throughSeq: 12 } });
    expect(h.runOrder).toEqual([]);
    expect(h.cancelCalls).toEqual([]);
  });

  it('does not submit or cancel Realm when timeout wins during watermark lookup', async () => {
    const beforePrompt = deferred<number>();
    const h = harness({ maxActiveTurns: 1, maxActiveTurnsPerEngine: 1 }, undefined, 0, beforePrompt);
    ready(h.registry, 's1');
    const turn = h.scheduler.enqueue('s1', { id: 'timeout-before-submit', prompt, timeoutMs: 1_000 }).value!;
    await h.clock.advanceBy(1_000);
    expect(h.cancelCalls).toEqual([]);
    beforePrompt.resolve(17);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.registry.getTurn(turn.id)).toMatchObject({ state: 'failed', beforeSeq: 17, fromSeq: null, throughSeq: 17, error: { code: 'turn-timeout' } });
    expect(h.runOrder).toEqual([]);
    expect(h.cancelCalls).toEqual([]);
  });

  it('does not submit or cancel Realm when scheduler closes during watermark lookup', async () => {
    const beforePrompt = deferred<number>();
    const h = harness({ maxActiveTurns: 1, maxActiveTurnsPerEngine: 1 }, undefined, 0, beforePrompt);
    ready(h.registry, 's1');
    const turn = h.scheduler.enqueue('s1', { id: 'close-before-submit', prompt }).value!;
    h.scheduler.close();
    beforePrompt.resolve(21);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.registry.getTurn(turn.id)).toMatchObject({ state: 'cancelled', beforeSeq: 21, fromSeq: null, throughSeq: 21 });
    expect(h.runOrder).toEqual([]);
    expect(h.cancelCalls).toEqual([]);
    expect(h.registry.gate.snapshot()).toMatchObject({ activeTurns: 0, queuedTurns: 0 });
  });

  it('keeps close as the winner when watermark lookup rejects after shutdown', async () => {
    const beforePrompt = deferred<number>();
    const h = harness({ maxActiveTurns: 1, maxActiveTurnsPerEngine: 1 }, undefined, 0, beforePrompt);
    ready(h.registry, 's1');
    const turn = h.scheduler.enqueue('s1', { id: 'close-reject-before-submit', prompt }).value!;
    h.scheduler.close();
    beforePrompt.reject(new Error('watermark unavailable'));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.registry.getTurn(turn.id)).toMatchObject({ state: 'cancelled' });
    expect(h.runOrder).toEqual([]);
    expect(h.cancelCalls).toEqual([]);
    expect(h.registry.gate.snapshot()).toMatchObject({ activeTurns: 0, queuedTurns: 0 });
  });

  it('hands the drain the watermark this dispatch captured, not the turn snapshot', async () => {
    const h = harness({ maxActiveTurns: 1, maxActiveTurnsPerEngine: 1 }, undefined, 7);
    ready(h.registry, 's1');
    const turn = h.scheduler.enqueue('s1', { id: 'drain-boundary', prompt }).value!;
    // The snapshot passed to the executor predates setTurnOutcome, so a drain
    // that read `turn.beforeSeq` would compute the wrong interval and its
    // outcome would be rejected as invalid.
    expect(turn.beforeSeq).toBeUndefined();
    await complete(h, 'drain-boundary');
    expect(h.drainCalls).toEqual([{ id: 'drain-boundary', beforeSeq: 7 }]);
    expect(h.registry.getTurn('drain-boundary')).toMatchObject({ state: 'completed', beforeSeq: 7 });
  });

  it('closes a busy session without waiting for the blocked prompt first (design §6.3 order)', async () => {
    const h = harness({ maxActiveTurns: 1, maxActiveTurnsPerEngine: 1 });
    ready(h.registry, 's1');
    const active = h.scheduler.enqueue('s1', { id: 'blocking', prompt }).value!;
    const queued = h.scheduler.enqueue('s1', { id: 'queued', prompt }).value!;
    expect(h.runOrder).toEqual(['blocking']);

    // Exactly the runtime's session_close sequence: claim, release the queue,
    // let Realm close (which settles the prompt), then drain.
    expect(h.registry.beginCloseSession('s1').ok).toBe(true);
    h.scheduler.releaseSessionQueue('s1');
    expect(h.registry.getTurn(queued.id)?.state).toBe('cancelled');

    const realmClose = (async () => { h.runs.get('blocking')!.resolve({}); })();
    const closed = (async () => { await realmClose; await h.scheduler.drainSession('s1'); return h.registry.completeCloseSession('s1'); })();
    const outcome = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve('stuck'), 500))]);
    expect(outcome).not.toBe('stuck');
    expect(h.registry.getTurn(active.id)?.state).toBe('cancelled');
    // §6.3: Realm close terminates the prompt, so no separate cancel is issued.
    expect(h.cancelCalls).toEqual([]);
    expect(h.registry.getSession('s1')?.state).toBe('closed');
    expect(h.registry.gate.snapshot()).toMatchObject({ openSessions: 0, activeTurns: 0, queuedTurns: 0 });
  });
});
