import { describe, expect, it } from 'vitest';

import {
  assertTransition,
  canTransition,
  interactionTransitions,
  INVALID_TRANSITION_CODE,
  InvalidStateTransitionError,
  sessionTransitions,
  type StateKind,
  transition,
  turnTransitions,
} from '../../packages/core/src/state-machine.js';

const expectedTransitions: Readonly<Record<StateKind, Readonly<Record<string, readonly string[]>>>> = {
  session: {
    creating: ['idle', 'failed'],
    idle: ['busy', 'failed', 'closing'],
    busy: ['idle', 'failed', 'closing'],
    failed: ['closing'],
    closing: ['closed'],
    closed: [],
  },
  turn: {
    queued: ['running', 'failed', 'cancelled'],
    running: ['awaiting-interaction', 'completed', 'failed', 'cancelled'],
    'awaiting-interaction': ['running', 'completed', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
  },
  interaction: {
    pending: ['responded', 'expired', 'invalidated'],
    responded: [],
    expired: [],
    invalidated: [],
  },
};

describe('state transition tables', () => {
  it('accepts every declared transition', () => {
    for (const [kind, table] of [
      ['session', sessionTransitions],
      ['turn', turnTransitions],
      ['interaction', interactionTransitions],
    ] as const) {
      for (const [from, targets] of Object.entries(expectedTransitions[kind])) {
        for (const to of targets) {
          expect(canTransition(kind, from, to)).toBe(true);
          expect(transition(kind, from, to)).toBe(to);
        }
      }
      expect(table).toEqual(expectedTransitions[kind]);
    }
  });

  it('rejects terminal reversals and unknown states without mutating caller state', () => {
    for (const [kind, table] of [
      ['session', sessionTransitions],
      ['turn', turnTransitions],
      ['interaction', interactionTransitions],
    ] as const) {
      const states = Object.keys(expectedTransitions[kind]);
      for (const from of states) {
        for (const to of states) {
          const allowed = expectedTransitions[kind][from] ?? [];
          if (allowed.includes(to)) continue;
          expect(canTransition(kind, from, to)).toBe(false);
          expect(() => assertTransition(kind, from, to)).toThrow(InvalidStateTransitionError);
        }
      }
    }
    expect(() => assertTransition('interaction', 'missing', 'pending')).toThrow(InvalidStateTransitionError);
  });
});

describe('an off-table transition names no subsystem (ADR 0030, API-017)', () => {
  it('reports INTERNAL, and the log site reads the same constant', () => {
    const error = new InvalidStateTransitionError('session', 'creating', 'closed');
    // The caller-facing half of API-017. Asserting only the log event would
    // leave this producer free to say `STORE_ERROR` — a transition has no
    // storage in it, and the log site hardcodes its own name, so nothing else
    // in the suite would notice.
    expect(error.code).toBe('INTERNAL');
    expect(error.code).toBe(INVALID_TRANSITION_CODE);
  });
});
