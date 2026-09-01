import { describe, expect, it } from 'vitest';

import { GlobalMutationGate } from '../../packages/core/src/mutation-gate.js';

describe('GlobalMutationGate', () => {
  it('enforces global, per-engine, queue, and open-session limits atomically', () => {
    const gate = new GlobalMutationGate({ maxOpenSessions: 1, maxActiveTurns: 2, maxActiveTurnsPerEngine: 1, maxQueuedTurns: 1 });
    const session = gate.tryReserveOpenSession();
    expect(session).toBeDefined();
    expect(gate.tryReserveOpenSession()).toBeUndefined();
    const queued = gate.tryEnqueueTurn();
    expect(queued).toBeDefined();
    expect(gate.tryEnqueueTurn()).toBeUndefined();
    const first = gate.tryAcquireExecution('codex', 's1');
    expect(first).toBeDefined();
    expect(gate.tryAcquireExecution('codex', 's2')).toBeUndefined();
    const second = gate.tryAcquireExecution('claude-code', 's3');
    expect(second).toBeDefined();
    expect(gate.tryAcquireExecution('opencode', 's4')).toBeUndefined();
    expect(gate.snapshot()).toEqual({ openSessions: 1, activeTurns: 2, queuedTurns: 1, activeByEngine: { codex: 1, 'claude-code': 1 } });
    expect(gate.release(first!)).toBe(true);
    expect(gate.release(first!)).toBe(false);
    expect(gate.release(second!)).toBe(true);
    expect(gate.release(queued!)).toBe(true);
    expect(gate.release(session!)).toBe(true);
    expect(gate.snapshot()).toEqual({ openSessions: 0, activeTurns: 0, queuedTurns: 0, activeByEngine: {} });
  });

  it('rejects invalid limits', () => {
    expect(() => new GlobalMutationGate({ maxOpenSessions: 0 })).toThrow(RangeError);
    expect(() => new GlobalMutationGate({ maxActiveTurns: 1, maxActiveTurnsPerEngine: 2 })).toThrow(RangeError);
    expect(() => new GlobalMutationGate({ maxQueuedTurns: 4097 })).toThrow(RangeError);
  });

  it('does not accept forged or cross-gate leases', () => {
    const first = new GlobalMutationGate({ maxOpenSessions: 1 });
    const second = new GlobalMutationGate({ maxOpenSessions: 1 });
    const lease = first.tryReserveOpenSession()!;
    expect(second.release(lease)).toBe(false);
    expect(first.snapshot().openSessions).toBe(1);
    expect(first.release(lease)).toBe(true);
    expect(second.release({ kind: 'open-session', released: false } as never)).toBe(false);
  });

  it('freezes validated limits so callers cannot bypass accounting', () => {
    const gate = new GlobalMutationGate({ maxOpenSessions: 1 });
    expect(() => { (gate.limits as { maxOpenSessions: number }).maxOpenSessions = 3; }).toThrow(TypeError);
    const first = gate.tryReserveOpenSession();
    expect(first).toBeDefined();
    expect(gate.tryReserveOpenSession()).toBeUndefined();
  });
});
