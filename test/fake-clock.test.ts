import { describe, expect, it } from 'vitest';

import { FakeClock } from '../packages/plugin/src/testkit/fake-clock.js';

describe('FakeClock', () => {
  it('runs due timers in due-time then insertion order without sleeping', async () => {
    const clock = new FakeClock(1_000);
    const calls: string[] = [];
    clock.setTimeout(() => { calls.push('late'); }, 20);
    clock.setTimeout(() => { calls.push('first'); }, 10);
    clock.setTimeout(() => { calls.push('second'); }, 10);

    await clock.advanceBy(9);
    expect(calls).toEqual([]);
    await clock.advanceBy(1);
    expect(calls).toEqual(['first', 'second']);
    expect(clock.now()).toBe(1_010);
    await clock.advanceBy(10);
    expect(calls).toEqual(['first', 'second', 'late']);
  });

  it('supports cancellation and intervals, including cancellation from a callback', async () => {
    const clock = new FakeClock();
    const calls: string[] = [];
    const cancelled = clock.setTimeout(() => { calls.push('cancelled'); }, 5);
    clock.clearTimeout(cancelled);
    let interval = 0;
    const handle = clock.setInterval(() => {
      calls.push('interval');
      if (++interval === 2) clock.clearInterval(handle);
    }, 3);

    await clock.advanceBy(20);
    expect(calls).toEqual(['interval', 'interval']);
    expect(clock.pendingCount()).toBe(0);
  });

  it('protects runAll from unbounded intervals', async () => {
    const clock = new FakeClock();
    clock.setInterval(() => undefined, 1);
    await expect(clock.runAll(2)).rejects.toThrow('unbounded interval');
  });

  it('cleans up after callback failure and rejects reentrant advancement', async () => {
    const clock = new FakeClock();
    clock.setTimeout(() => { throw new Error('boom'); }, 1);
    await expect(clock.advanceBy(1)).rejects.toThrow('boom');
    expect(clock.pendingCount()).toBe(0);
    expect(clock.now()).toBe(1);

    const reentrant = new FakeClock();
    reentrant.setTimeout(async () => { await reentrant.advanceBy(1); }, 1);
    await expect(reentrant.advanceBy(1)).rejects.toThrow('reentrant');
    expect(reentrant.now()).toBe(1);
  });
});
