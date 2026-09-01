/** Stable, transport-independent failure categories owned by Core. */
export type CoreErrorCode =
  | 'invalid-input' | 'resource-not-found' | 'session-unavailable' | 'state-conflict' | 'stale-resource'
  | 'capacity-exceeded' | 'operation-unsupported' | 'turn-timeout' | 'interaction-timeout'
  | 'payload-too-large' | 'workspace-forbidden' | 'recursion-denied' | 'provider-failure'
  | 'storage-failure' | 'internal';

export interface CoreErrorCause {
  readonly name: string;
  readonly message: string;
  readonly operation?: string;
  readonly kind?: string;
}

export interface CoreError {
  readonly code: CoreErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: CoreErrorCause;
}

/** Error-shaped state retained by the registry compatibility seam. The plugin
 * adapter may still supply its wire code while the application API uses the
 * domain-only CoreError above. */
export interface RegistryError {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: CoreErrorCause;
}

export function isCoreErrorCode(value: string): value is CoreErrorCode {
  return new Set<CoreErrorCode>([
    'invalid-input', 'resource-not-found', 'session-unavailable', 'state-conflict', 'stale-resource',
    'capacity-exceeded', 'operation-unsupported', 'turn-timeout', 'interaction-timeout',
    'payload-too-large', 'workspace-forbidden', 'recursion-denied', 'provider-failure',
    'storage-failure', 'internal',
  ]).has(value as CoreErrorCode);
}

/** Every application API returns a domain result that the Plugin may project. */
export type CoreResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: CoreError }>;

/** Error raised by the pure transcript pager before Plugin error mapping. */
export class TranscriptPageError extends Error {
  readonly code: 'payload-too-large' = 'payload-too-large';

  constructor(message: string, readonly details: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'TranscriptPageError';
  }
}
