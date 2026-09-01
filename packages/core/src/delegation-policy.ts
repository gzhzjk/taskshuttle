import type { CoreResult } from './errors.js';

/** Evidence collected by Plugin; Core only composes the settled verdict. */
export type DelegationEvidence = Readonly<{ provenance: 'root' | 'marker' | 'ancestry' | 'unavailable'; depth?: number }>;

/** Refuse mutation when the already-collected delegation verdict is positive. */
export function assertRootMutation(evidence: DelegationEvidence): CoreResult<void> {
  return evidence.provenance === 'root'
    ? { ok: true, value: undefined }
    : { ok: false, error: { code: 'recursion-denied', message: 'mutation is not allowed from a delegated or uncertain instance' } };
}
