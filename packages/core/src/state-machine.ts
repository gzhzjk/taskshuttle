import type { InteractionState, SessionState, TurnState } from './types.js';

export type StateKind = 'session' | 'turn' | 'interaction';

/**
 * The code an off-table transition is reported under, named once so the error
 * class and the log site cannot drift: the observer that logs the fault
 * receives the transition, not the error object, so without a shared constant
 * the two would state the same decision twice (ADR 0030).
 */
export const INVALID_TRANSITION_CODE = 'INTERNAL' as const;

export class InvalidStateTransitionError extends Error {
  // An off-table transition is the plugin's own invariant breaking: not the
  // caller's fault, not the engine's, and not the store's — which is what
  // `INTERNAL` means (mvp §12, ADR 0030). It carried `STORE_ERROR` until then,
  // naming a subsystem that takes no part in a transition.
  readonly code = INVALID_TRANSITION_CODE;
  constructor(readonly kind: StateKind, readonly from: string, readonly to: string) {
    super(`invalid ${kind} transition: ${from} -> ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

export const sessionTransitions: Readonly<Record<SessionState, readonly SessionState[]>> = {
  creating: ['idle', 'failed'],
  idle: ['busy', 'failed', 'closing'],
  busy: ['idle', 'failed', 'closing'],
  failed: ['closing'],
  closing: ['closed'],
  closed: [],
};

export const turnTransitions: Readonly<Record<TurnState, readonly TurnState[]>> = {
  queued: ['running', 'failed', 'cancelled'],
  running: ['awaiting-interaction', 'completed', 'failed', 'cancelled'],
  'awaiting-interaction': ['running', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export const interactionTransitions: Readonly<Record<InteractionState, readonly InteractionState[]>> = {
  pending: ['responded', 'expired', 'invalidated'],
  responded: [],
  expired: [],
  invalidated: [],
};

function tableFor(kind: StateKind): Readonly<Record<string, readonly string[]>> {
  if (kind === 'session') return sessionTransitions;
  if (kind === 'turn') return turnTransitions;
  return interactionTransitions;
}

export function canTransition(kind: StateKind, from: string, to: string): boolean {
  return tableFor(kind)[from]?.includes(to) ?? false;
}

export function assertTransition<K extends StateKind>(kind: K, from: string, to: string): void {
  if (!canTransition(kind, from, to)) throw new InvalidStateTransitionError(kind, from, to);
}

export function transition<K extends StateKind>(kind: K, from: string, to: string): string {
  assertTransition(kind, from, to);
  return to;
}
