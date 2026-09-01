import { EngineOperationError } from 'runskein';
import { errorCodeSchema, type ErrorCode } from './schemas.js';
import type { CoreErrorCode } from '@taskshuttle/core';

export interface PluginErrorCause {
  name: string;
  message: string;
  operation?: string;
  /**
   * Realm's own classification of an engine failure, absent when it made none.
   * Deliberately a bounded string rather than a union of today's four values:
   * the vocabulary is Realm's and can gain a member in a patch release, so a
   * closed type here would turn an upstream addition into a violation (ADR 0029).
   */
  kind?: string;
}

export interface PluginError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  cause?: PluginErrorCause;
}

export interface PluginException extends Error {
  code: ErrorCode;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export interface ErrorMappingContext {
  operation?: string;
  details?: Record<string, unknown>;
  /** Values that must never be present in public message/details/cause fields. */
  secretLiterals: readonly string[];
}

/** Frozen MCP projection used only at the Plugin boundary, never by Core. */
const legacyCodes: Readonly<Record<string, string>> = {
  'invalid-input': 'INVALID_ARGUMENT',
  'resource-not-found': 'NOT_FOUND',
  'session-unavailable': 'SESSION_UNAVAILABLE',
  'state-conflict': 'CONFLICT',
  'stale-resource': 'GONE',
  'capacity-exceeded': 'LIMIT_EXCEEDED',
  'operation-unsupported': 'NOT_SUPPORTED',
  'turn-timeout': 'TURN_TIMEOUT',
  'interaction-timeout': 'INTERACTION_TIMEOUT',
  'payload-too-large': 'PAYLOAD_TOO_LARGE',
  'workspace-forbidden': 'PERMISSION_DENIED',
  'recursion-denied': 'RECURSION_DENIED',
  'provider-failure': 'ENGINE_ERROR',
  'storage-failure': 'STORE_ERROR',
  internal: 'INTERNAL',
};

/** Project a Core domain code into the Plugin's frozen wire vocabulary. */
export function legacyCodeFor(code: string): string {
  return legacyCodes[code] ?? code;
}

/** Decode a frozen Plugin error code at the Core scheduler adapter seam. */
const domainByLegacyCode: ReadonlyMap<string, CoreErrorCode> = new Map(
  Object.entries(legacyCodes).map(([domain, legacy]) => [legacy, domain as CoreErrorCode]),
);

export function domainCodeFor(code: string): CoreErrorCode | undefined {
  const known = new Set(Object.values(legacyCodes));
  if (known.has(code)) return domainByLegacyCode.get(code);
  return Object.hasOwn(legacyCodes, code) ? code as CoreErrorCode : undefined;
}

const realmNameToCode: Record<string, ErrorCode> = {
  NotFoundError: 'NOT_FOUND',
  NotSupportedError: 'NOT_SUPPORTED',
  ConfigError: 'INVALID_ARGUMENT',
  CancelledError: 'GONE',
  StoreError: 'STORE_ERROR',
  EngineCrashError: 'ENGINE_ERROR',
  EngineStartError: 'ENGINE_ERROR',
  EngineOperationError: 'ENGINE_ERROR',
  NotInstalledError: 'ENGINE_ERROR',
  UnauthenticatedError: 'ENGINE_ERROR',
  TimeoutError: 'TURN_TIMEOUT',
  InteractionTimeoutError: 'INTERACTION_TIMEOUT',
  PermissionDeniedError: 'PERMISSION_DENIED',
  RecursionDeniedError: 'RECURSION_DENIED',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (isRecord(value) && typeof value.message === 'string') return value.message;
  return String(value);
}

function nameOf(value: unknown): string {
  if (value instanceof Error && value.name.length > 0) return value.name;
  if (isRecord(value) && typeof value.name === 'string' && value.name.length > 0) return value.name;
  return 'Error';
}

function operationOf(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.operation !== 'string') return undefined;
  return value.operation;
}

function detailsOf(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value.details)) return undefined;
  return value.details;
}

/**
 * The shape a projected `kind` must have: a short lowercase slug. It bounds how
 * much can cross and keeps engine prose out; it is not a proof that a value
 * carries no secret, which is why sanitization runs first (ADR 0029).
 */
const kindSlug = /^[a-z][a-z0-9-]*$/;
const KIND_MAX_LENGTH = 32;

/**
 * Normalize a candidate `kind` the same way on every projection path.
 *
 * The type check comes first because `sanitizeText` is string-only: a `kind` of
 * `42` reaching it would throw with any secret literal configured, turning a
 * projection into a failed mapping. Sanitization comes before validation
 * because a secret literal may appear anywhere in the value, and a substitution
 * that leaves the value non-conforming means the field is dropped rather than
 * emitted as `[REDACTED]`.
 * @param value - the raw candidate, from a Realm error or an already-mapped cause.
 * @param secretLiterals - values that must never leave in a public field.
 * @returns the value to project, or undefined when there is nothing safe to project.
 */
function normalizeKind(value: unknown, secretLiterals: readonly string[]): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sanitized = sanitizeText(value, secretLiterals);
  if (sanitized.length > KIND_MAX_LENGTH || !kindSlug.test(sanitized)) return undefined;
  return sanitized;
}

function sanitizeText(value: string, secretLiterals: readonly string[]): string {
  const literals = [...secretLiterals].filter((secret) => secret.length > 0).sort((a, b) => b.length - a.length);
  return literals.reduce((result, secret) => {
    if (secret.length === 0) return result;
    return result.split(secret).join('[REDACTED]');
  }, value);
}

const sensitiveKeyPattern = /(?:authorization|cookie|token|password|api[-_]?key|secret|header|env(?:ironment)?|credential|private[-_]?key)/i;

function sanitizeValue(value: unknown, secretLiterals: readonly string[], seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return sanitizeText(value, secretLiterals);
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeValue(item, secretLiterals, seen) ?? null);
    }
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const safeKey = sanitizeText(key, secretLiterals);
      if (safeKey.includes('[REDACTED]')) continue;
      if (sensitiveKeyPattern.test(key)) {
        output[safeKey] = '[REDACTED]';
        continue;
      }
      const safeValue = sanitizeValue(nested, secretLiterals, seen);
      if (safeValue !== undefined) output[safeKey] = safeValue;
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function sanitizeDetails(
  details: Record<string, unknown> | undefined,
  secretLiterals: readonly string[],
): Record<string, unknown> | undefined {
  if (details === undefined) return undefined;
  return sanitizeValue(details, secretLiterals, new WeakSet<object>()) as Record<string, unknown>;
}

/**
 * Operations that are a Realm round trip without carrying an `engine/` prefix.
 * They are mapped where the failure surfaces rather than where the call is
 * made, and they predate ADR 0027's call-site wrapping.
 */
const ENGINE_OPERATIONS = new Set(['turn/run', 'session/create', 'session/respond']);

function classifyCode(error: unknown, operation: string | undefined): ErrorCode {
  if (isRecord(error) && typeof error.code === 'string' && errorCodeSchema.safeParse(error.code).success) {
    return error.code as ErrorCode;
  }
  const byName = realmNameToCode[nameOf(error)];
  if (byName !== undefined) return byName;
  if (operation?.startsWith('store/')) return 'STORE_ERROR';
  if (operation?.includes('timeout')) return 'TURN_TIMEOUT';
  // ADR 0027: an engine round trip is classified from the operation of the
  // call that made it. An explicit list, not a `session/` prefix, because
  // `session/observe` is not a round trip and must not be swept in.
  if (operation !== undefined && (ENGINE_OPERATIONS.has(operation) || operation.startsWith('engine/'))) return 'ENGINE_ERROR';
  // Nothing above could place the fault, so say that rather than name a
  // subsystem. `ENGINE_ERROR` here would be a claim, not a classification.
  return 'INTERNAL';
}

/**
 * Convert Realm/host/unknown failures to the stable plugin error envelope.
 * Only a safe cause projection crosses the tool boundary; stack and raw error
 * objects never do.
 */
export function mapError(error: unknown, context: ErrorMappingContext): PluginError {
  const secrets = context.secretLiterals;
  const existing = isPluginError(error) ? error : undefined;
  const operation = context.operation ?? operationOf(error);
  const code = classifyCode(error, operation);
  const message = sanitizeText(textOf(error), secrets);
  // `kind` is read from the class that declares it, never from a `name` field:
  // this file inspects errors structurally, so a name comparison would believe
  // any object claiming to be one (ADR 0029). Re-projection runs the same
  // normalization rather than copying: the secret literals can differ between
  // the two mappings, and the field must not survive a mapping it would fail.
  const kind = existing?.cause === undefined
    ? normalizeKind(error instanceof EngineOperationError ? error.kind : undefined, secrets)
    : normalizeKind(existing.cause.kind, secrets);
  const cause: PluginErrorCause = existing?.cause === undefined
    ? {
        name: sanitizeText(nameOf(error), secrets),
        message,
        ...(operation === undefined ? {} : { operation: sanitizeText(operation, secrets) }),
        ...(kind === undefined ? {} : { kind }),
      }
    : {
        name: sanitizeText(existing.cause.name, secrets),
        message: sanitizeText(existing.cause.message, secrets),
        ...(existing.cause.operation === undefined
          ? {}
          : { operation: sanitizeText(existing.cause.operation, secrets) }),
        ...(kind === undefined ? {} : { kind }),
      };
  const details = sanitizeDetails(context.details ?? existing?.details ?? detailsOf(error), secrets);
  return {
    code,
    message,
    ...(details === undefined ? {} : { details }),
    cause,
  };
}

export function isPluginError(value: unknown): value is PluginError {
  if (!isRecord(value)) return false;
  if (!errorCodeSchema.safeParse(value.code).success || typeof value.message !== 'string') return false;
  if (value.details !== undefined && !isRecord(value.details)) return false;
  if (value.cause !== undefined) {
    if (!isRecord(value.cause) || typeof value.cause.name !== 'string' || typeof value.cause.message !== 'string') return false;
    if (value.cause.operation !== undefined && typeof value.cause.operation !== 'string') return false;
    // Type only: whether the value is a conforming slug is the projection's
    // question, and `mapError` re-asks it on re-projection. Rejecting a
    // non-string here keeps a hand-built envelope from reaching that path with
    // something the normalizer would have to guess about.
    if (value.cause.kind !== undefined && typeof value.cause.kind !== 'string') return false;
  }
  return true;
}

/** Convert the public envelope to an Error for APIs that require throwing. */
export function toPluginException(error: PluginError): PluginException {
  const exception = new Error(error.message) as PluginException;
  exception.name = `TaskShuttle${error.code}Error`;
  exception.code = error.code;
  if (error.details !== undefined) exception.details = error.details;
  if (error.cause !== undefined) exception.cause = error.cause;
  return exception;
}
