import { describe, expect, it } from 'vitest';

import type { AnchorRecord } from '../../packages/plugin/src/anchor-store.js';
import type { NannySnapshot } from '../../packages/plugin/src/nanny-snapshot.js';
import { ANCHOR_HANDBACK_MAX_BYTES, MAX_LISTED_TURNS, NANNY_PREFIX, decide, truncateUtf8 } from '../../packages/plugin/src/nanny/decide.js';

const NOW = Date.parse('2026-08-21T12:00:00.000Z');
const CWD = '/tmp/workspace-a';

function snapshot(overrides: Partial<NannySnapshot> = {}): NannySnapshot {
  return {
    instanceId: 'instance-1',
    updatedAt: '2026-08-21T11:59:00.000Z',
    seq: 1,
    turnsDispatched: 0,
    active: [],
    pendingInteractions: [],
    ...overrides,
  };
}

function turn(id: string, cwd = CWD, startedAt = '2026-08-21T11:58:00.000Z'): NannySnapshot['active'][number] {
  return { turnId: id, sessionId: `s-${id}`, engine: 'codex', state: 'running', cwd, startedAt };
}

function anchor(content: string, turnsAtWrite = 0, instanceId = 'instance-1'): AnchorRecord {
  return { content, updatedAt: '2026-08-21T11:00:00.000Z', instanceId, turnsAtWrite };
}

describe('nanny decision', () => {
  it('NANNY-001: reports a non-terminal turn, and says nothing once everything is terminal', () => {
    const running = decide({ cwd: CWD, stopHookActive: false }, { snapshot: snapshot({ active: [turn('t1')] }) }, NOW);
    expect(running.kind).toBe('block');
    if (running.kind !== 'block') return;
    expect(running.reason).toContain('t1');
    expect(running.reason).toContain('s-t1');
    expect(running.reason).toContain('codex');
    // Elapsed, not a wall-clock timestamp the hook never observed.
    expect(running.reason).toContain('2m00s');

    // Both directions: an implementation that only ever appends would pass the
    // assertion above and still hold the user forever.
    expect(decide({ cwd: CWD, stopHookActive: false }, { snapshot: snapshot() }, NOW)).toEqual({ kind: 'pass' });
  });

  it('NANNY-002: an unreadable state is silence, never a block', () => {
    expect(decide({ cwd: CWD, stopHookActive: false }, {}, NOW)).toEqual({ kind: 'pass' });
  });

  it('NANNY-027: every decision names itself first, identically in block and note', () => {
    const state = { snapshot: snapshot({ active: [turn('t1')] }) };
    const blocked = decide({ cwd: CWD, stopHookActive: false }, state, NOW);
    const noted = decide({ cwd: CWD, stopHookActive: true }, state, NOW);
    if (blocked.kind !== 'block' || noted.kind !== 'note') { expect(blocked.kind).toBe('block'); return; }
    // A host renders a successful block as `Stop hook error: <reason>`, so the
    // first line is the only thing telling a reader this is a check rather
    // than a crash of one of the other hooks a stop fires.
    expect(blocked.reason.split('\n')[0]).toBe(NANNY_PREFIX);
    expect(noted.message.split('\n')[0]).toBe(NANNY_PREFIX);
    expect(blocked.reason).toContain('still running');
  });

  it('NANNY-006: the loop guard degrades a block to a note without dropping anything', () => {
    const state = { snapshot: snapshot({ active: [turn('t1')] }) };
    const first = decide({ cwd: CWD, stopHookActive: false }, state, NOW);
    const second = decide({ cwd: CWD, stopHookActive: true }, state, NOW);
    expect(first.kind).toBe('block');
    expect(second.kind).toBe('note');
    if (first.kind !== 'block' || second.kind !== 'note') return;
    expect(second.message).toBe(first.reason);
  });

  it('NANNY-007: a pending interaction under the guard is a note, and still names the TTL consequence', () => {
    const state = {
      snapshot: snapshot({
        active: [turn('t1')],
        pendingInteractions: [{ interactionId: 'i1', turnId: 't1', kind: 'permission', expiresAt: '2026-08-21T12:05:00.000Z' }],
      }),
    };
    // The guard outranks every block condition, pending included: repeated
    // blocking cannot stop the TTL, but it can lock the user in.
    const guarded = decide({ cwd: CWD, stopHookActive: true }, state, NOW);
    expect(guarded.kind).toBe('note');
    if (guarded.kind !== 'note') return;
    expect(guarded.message).toContain('i1');
    expect(guarded.message).toContain('2026-08-21T12:05:00.000Z');
    expect(guarded.message).toContain('INTERACTION_TIMEOUT');
    // Pending comes first: a running turn needs time, this needs the reader.
    expect(guarded.message.indexOf('i1')).toBeLessThan(guarded.message.indexOf('turn t1 ('));
  });

  it('NANNY-008: output is bounded — five listed, the rest folded into a count', () => {
    const active = Array.from({ length: 50 }, (_, i) => turn(`t${i}`));
    const decision = decide({ cwd: CWD, stopHookActive: false }, { snapshot: snapshot({ active }) }, NOW);
    expect(decision.kind).toBe('block');
    if (decision.kind !== 'block') return;
    const listed = decision.reason.split('\n').filter((line) => line.startsWith('  - turn '));
    expect(listed).toHaveLength(MAX_LISTED_TURNS);
    expect(decision.reason).toContain(`and ${50 - MAX_LISTED_TURNS} more`);
  });

  it('NANNY-009: turns in another workspace are not reported here', () => {
    const state = { snapshot: snapshot({ active: [turn('t-other', '/tmp/workspace-b')] }) };
    expect(decide({ cwd: CWD, stopHookActive: false }, state, NOW)).toEqual({ kind: 'pass' });
    // The same state with no cwd to filter on reports rather than drops: an
    // extra line is noise, a missing one reads as "nothing is running".
    expect(decide({ stopHookActive: false }, state, NOW).kind).toBe('block');
  });

  it("NANNY-009: a pending interaction follows its turn's workspace", () => {
    const state = {
      snapshot: snapshot({
        active: [turn('t-other', '/tmp/workspace-b')],
        pendingInteractions: [{ interactionId: 'i1', turnId: 't-other', kind: 'permission' }],
      }),
    };
    expect(decide({ cwd: CWD, stopHookActive: false }, state, NOW)).toEqual({ kind: 'pass' });
  });

  it('NANNY-010: no prompt, transcript or worker output can appear — the shape has no field for it', () => {
    const state = {
      snapshot: snapshot({ active: [turn('t1')], pendingInteractions: [{ interactionId: 'i1', turnId: 't1', kind: 'permission' }] }),
      anchor: anchor('ship the parser'),
    };
    const decision = decide({ cwd: CWD, stopHookActive: false }, state, NOW);
    if (decision.kind !== 'block') { expect(decision.kind).toBe('block'); return; }
    // Everything printed comes from ids, enum states, timestamps and the
    // orchestrator's own anchor text; there is nowhere for a worker's words.
    expect(JSON.stringify(state.snapshot)).not.toContain('prompt');
    expect(decision.reason).toContain('ship the parser');
  });

  it('ANCHOR-018: a session that never wrote an anchor produces no output at all', () => {
    expect(decide({ cwd: CWD, stopHookActive: false }, { snapshot: snapshot() }, NOW)).toEqual({ kind: 'pass' });
  });

  it('ANCHOR-017: the anchor still comes back without a snapshot, and no count is guessed', () => {
    const decision = decide({ cwd: CWD, stopHookActive: false }, { anchor: anchor('ship the parser', 3) }, NOW);
    expect(decision.kind).toBe('block');
    if (decision.kind !== 'block') return;
    expect(decision.reason).toContain('ship the parser');
    expect(decision.reason).not.toContain('dispatched');
  });

  it('ANCHOR-008: the mechanical signal is a subtraction across two files, and never negative', () => {
    const withCount = decide(
      { cwd: CWD, stopHookActive: false },
      { snapshot: snapshot({ turnsDispatched: 7 }), anchor: anchor('plan', 3) },
      NOW,
    );
    if (withCount.kind !== 'block') { expect(withCount.kind).toBe('block'); return; }
    expect(withCount.reason).toContain('dispatched 4 turn(s)');

    // Counters from two different instances have no relation; subtracting them
    // would print a number that looks like a measurement.
    const foreign = decide(
      { cwd: CWD, stopHookActive: false },
      { snapshot: snapshot({ turnsDispatched: 7 }), anchor: anchor('plan', 3, 'instance-2') },
      NOW,
    );
    if (foreign.kind !== 'block') { expect(foreign.kind).toBe('block'); return; }
    expect(foreign.reason).not.toContain('dispatched');
  });

  it('ANCHOR-019: a 16 KiB anchor comes back bounded, cut on a character boundary, and says it was cut', () => {
    // Three-byte characters divide 4096 unevenly, so a byte-wise slice lands
    // inside one — the case that produces a replacement character.
    const content = '锚'.repeat(5_000);
    const decision = decide({ cwd: CWD, stopHookActive: false }, { anchor: anchor(content) }, NOW);
    if (decision.kind !== 'block') { expect(decision.kind).toBe('block'); return; }
    expect(decision.reason).not.toContain('�');
    expect(decision.reason).toContain('truncated');
    expect(Buffer.byteLength(decision.reason, 'utf8')).toBeLessThan(ANCHOR_HANDBACK_MAX_BYTES + 512);
  });
});

describe('utf-8 truncation', () => {
  it('cuts on a character boundary and reports whether it cut', () => {
    expect(truncateUtf8('abc', 10)).toEqual({ text: 'abc', truncated: false });
    // 4 bytes of a 3-byte-per-character string: one whole character survives.
    const cut = truncateUtf8('锚锚', 4);
    expect(cut).toEqual({ text: '锚', truncated: true });
    expect(Buffer.byteLength(cut.text, 'utf8')).toBe(3);
  });
});
