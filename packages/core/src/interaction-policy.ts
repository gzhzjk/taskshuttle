import type { CoreResult } from './errors.js';
import type { InteractionState, PermissionMode } from './types.js';

/** Return whether a pending interaction's injected expiry has elapsed. */
export function interactionExpired(expiresAt: string | undefined, nowMs: number): boolean {
  return expiresAt !== undefined && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) <= nowMs;
}

/** Permission mode changes are legal only when no permission is awaiting an answer. */
export function canChangePermissionMode(current: PermissionMode, next: PermissionMode, pendingPermissionCount: number): CoreResult<PermissionMode> {
  if (pendingPermissionCount > 0) return { ok: false, error: { code: 'state-conflict', message: 'permission mode cannot change while a permission is pending' } };
  return { ok: true, value: next === current ? current : next };
}

/** Domain-only interaction transition check used by adapters before I/O. */
export function canResolveInteraction(state: InteractionState): boolean {
  return state === 'pending';
}
