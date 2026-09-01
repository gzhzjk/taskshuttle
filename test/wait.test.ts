import { describe, it, expect } from 'vitest';
import { runWait } from '../packages/plugin/src/cli/wait.js';

function makeJournal(lines: string[]): { content: string; size: number } {
  const content = lines.join('');
  return { content, size: Buffer.byteLength(content) };
}

describe('WAIT', () => {
  it('WAIT-001 timely terminal wake', async () => {
    const line = JSON.stringify({ event: 'turn_transition', turnId: 't1', sessionId: 's1', engine: 'e', from: 'running', to: 'completed', operation: 'op' }) + '\n';
    const j = makeJournal([line]);
    const out: string[] = [];
    const discover = async () => [{ instanceId: 'inst1', instanceDir: '/tmp/inst1', createdAt: 'now' }];
    const stat = async () => ({ size: j.size });
    const read = async (_p: string, off: number) => j.content.slice(off);
    const res = await runWait({ discover, stat, read, alive: async () => true, out: l => out.push(l), sleep: async () => {}, now: () => 0, timeoutMs: 1000 });
    expect(res.exitCode).toBe(0);
    expect(res.wake).toBe('terminal');
    expect(res.cursor).toBe(j.size);
    expect(out.join('\n')).toContain('wake=terminal');
    expect(out.join('\n')).toContain('turnId=t1');
    expect(out.join('\n')).toContain(`cursor=${j.size}`);
  });

  it('WAIT-002 negative: no journal → timeout, no terminal wake', async () => {
    const out: string[] = [];
    const discover = async () => [{ instanceId: 'inst1', instanceDir: '/tmp/inst1', createdAt: 'now' }];
    // stat returns null = no file, alive true so waiter sleeps until deadline
    let t = 0;
    const now = () => (t += 300);
    const res = await runWait({ discover, stat: async () => null, read: async () => '', alive: async () => true, out: l => out.push(l), sleep: async () => {}, now, timeoutMs: 500 });
    expect(res.exitCode).toBe(0);
    expect(res.wake).toBeUndefined();
    expect(out.join('\n')).toContain('timeout');
    expect(out.join('\n')).not.toContain('wake=terminal');
  });

  it('WAIT-003 cursor resume', async () => {
    // Proves offset read resumes after timeout: first waiter times out on
    // non-terminal, second waiter with its cursor wakes on the appended terminal.
    const l2 = JSON.stringify({ event: 'turn_transition', turnId: 't2', sessionId: 's1', engine: 'e', from: 'running', to: 'completed', operation: 'op' }) + '\n';
    const discover = async () => [{ instanceId: 'inst1', instanceDir: '/tmp/inst1', createdAt: 'now' }];
    const midLine = JSON.stringify({ event: 'turn_transition', turnId: 't1', sessionId: 's1', engine: 'e', from: 'running', to: 'running', operation: 'op' }) + '\n';
    const jMid = makeJournal([midLine]);
    let t = 0;
    const now1 = () => (t += 300);
    const out1: string[] = [];
    const res1 = await runWait({ discover, stat: async () => ({ size: jMid.size }), read: async (_p, off) => jMid.content.slice(off), alive: async () => true, out: l => out1.push(l), sleep: async () => {}, now: now1, timeoutMs: 500 });
    expect(res1.exitCode).toBe(0);
    expect(res1.wake).toBeUndefined();
    const cursor = res1.cursor; // should be jMid.size
    expect(cursor).toBe(jMid.size);
    // Phase 2: file now has l2 appended, read from cursor should wake on t2
    const out2: string[] = [];
    const read2 = async (_p: string, off: number) => (jMid.content + l2).slice(off);
    const stat2 = async () => ({ size: Buffer.byteLength(jMid.content + l2) });
    const res2 = await runWait({ discover, stat: stat2, read: read2, alive: async () => true, out: l => out2.push(l), sleep: async () => {}, now: () => 0, timeoutMs: 1000, cursor });
    expect(res2.exitCode).toBe(0);
    expect(res2.wake).toBe('terminal');
    expect(out2.join('\n')).toContain('turnId=t2');
    expect(out2.join('\n')).not.toContain('turnId=t1');
  });

  it('WAIT-004 negative: no cursor → in-between turn not observed', async () => {
    // Proves --cursor is required: with cursor wakes t2, without wakes stale t1.
    const l2 = JSON.stringify({ event: 'turn_transition', turnId: 't2', sessionId: 's1', engine: 'e', from: 'running', to: 'completed', operation: 'op' }) + '\n';
    const lt1 = JSON.stringify({ event: 'turn_transition', turnId: 't1', sessionId: 's1', engine: 'e', from: 'running', to: 'completed', operation: 'op' }) + '\n';
    const j = lt1 + l2;
    const mid = Buffer.byteLength(lt1);
    const discover = async () => [{ instanceId: 'inst1', instanceDir: '/tmp/inst1', createdAt: 'now' }];
    const stat = async () => ({ size: Buffer.byteLength(j) });
    const readFromMid = async (_p: string, off: number) => j.slice(off);
    const outWith: string[] = [];
    const resWith = await runWait({ discover, stat, read: readFromMid, alive: async () => true, out: l => outWith.push(l), sleep: async () => {}, now: () => 0, timeoutMs: 1000, cursor: mid });
    expect(outWith.join('\n')).toContain('turnId=t2');
    const outWithout: string[] = [];
    const resWithout = await runWait({ discover, stat, read: readFromMid, alive: async () => true, out: l => outWithout.push(l), sleep: async () => {}, now: () => 0, timeoutMs: 1000 }); // cursor 0
    expect(outWithout.join('\n')).toContain('turnId=t1');
    expect(outWithout.join('\n')).not.toContain('turnId=t2');
    expect(resWith.wake).toBe('terminal');
  });

  it('WAIT-005 pending wake', async () => {
    const line = JSON.stringify({ event: 'interaction_transition', interactionId: 'i1', turnId: 't1', sessionId: 's1', kind: 'permission', to: 'pending', operation: 'op' }) + '\n';
    const j = makeJournal([line]);
    const out: string[] = [];
    const discover = async () => [{ instanceId: 'inst1', instanceDir: '/tmp/inst1', createdAt: 'now' }];
    let t5 = 0;
    const res = await runWait({ discover, stat: async () => ({ size: j.size }), read: async (_p, off) => j.content.slice(off), alive: async () => true, out: l => out.push(l), sleep: async () => {}, now: () => t5++, timeoutMs: 500 });
    expect(res.exitCode).toBe(0);
    expect(res.wake).toBe('pending');
    expect(out.join('\n')).toContain('wake=pending');
    expect(out.join('\n')).not.toContain('wake=terminal');
  });

  it('WAIT-007 journal absent → timeout exit 0', async () => {
    const out: string[] = [];
    const discover = async () => [{ instanceId: 'inst1', instanceDir: '/tmp/inst1', createdAt: 'now' }];
    let t = 0;
    const res = await runWait({ discover, stat: async () => null, read: async () => '', alive: async () => true, out: l => out.push(l), sleep: async () => {}, now: () => (t += 300), timeoutMs: 500 });
    expect(res.exitCode).toBe(0);
    expect(res.wake).toBeUndefined();
    expect(out.join('\n')).toContain('timeout');
  });
});
