import { describe, expect, it } from 'vitest';

import { EngineOperationError, UnauthenticatedError } from 'runskein';

import { isPluginError, mapError, toPluginException } from '../packages/plugin/src/error-mapper.js';

describe('error mapper', () => {
  it('maps Realm typed names to stable plugin codes and preserves safe cause context', () => {
    const mapped = mapError(
      Object.assign(new Error('engine is not installed'), { name: 'NotInstalledError', operation: 'session/create' }),
      { operation: 'session/create', details: { engine: 'codex' }, secretLiterals: [] },
    );
    expect(mapped).toEqual({
      code: 'ENGINE_ERROR',
      message: 'engine is not installed',
      details: { engine: 'codex' },
      cause: { name: 'NotInstalledError', message: 'engine is not installed', operation: 'session/create' },
    });
    expect(isPluginError(mapped)).toBe(true);
  });

  it('never exposes secrets, nested values, stacks, or raw error objects', () => {
    const details: Record<string, unknown> = { nested: { token: 'root-secret' }, list: ['root-secret/value'] };
    details.self = details;
    const mapped = mapError(new Error('failed with root-secret'), {
      operation: 'store/append',
      secretLiterals: ['root-secret'],
      details,
    });
    expect(mapped.code).toBe('STORE_ERROR');
    expect(JSON.stringify(mapped)).not.toContain('root-secret');
    expect(JSON.stringify(mapped)).not.toContain('stack');
    expect(mapped.details).toEqual({ nested: { token: '[REDACTED]' }, list: ['[REDACTED]/value'], self: '[Circular]' });
  });

  it('preserves an existing plugin error without widening its code', () => {
    const mapped = mapError({ code: 'NOT_SUPPORTED', message: 'image unsupported' }, { operation: 'turn/start', secretLiterals: [] });
    expect(mapped.code).toBe('NOT_SUPPORTED');
    expect(toPluginException(mapped)).toMatchObject({ name: 'TaskShuttleNOT_SUPPORTEDError', code: 'NOT_SUPPORTED' });
  });

  it('uses operation context for unknown store failures', () => {
    expect(mapError(new Error('disk full'), { operation: 'store/append', secretLiterals: [] }).code).toBe('STORE_ERROR');
    // API-015. `session/prompt` is not an operation any call site produces —
    // asserting through it tested the fallback while appearing to test the
    // engine rule. The real ones are named, and by name: `cause.operation`
    // reaches the caller, so a rename is a contract change, not a refactor.
    for (const operation of ['turn/run', 'session/create', 'session/respond', 'engine/engines', 'engine/describe', 'engine/rescan', 'engine/session', 'engine/quit', 'engine/setConfig', 'engine/fork', 'engine/close']) {
      expect(mapError(new Error('unexpected worker failure'), { operation, secretLiterals: [] }).code).toBe('ENGINE_ERROR');
    }
    // Everything the rules could not place says so instead of naming the
    // engine. `session/observe` is deliberately here and not above: it is an
    // observation refresh, not a round trip.
    for (const operation of [undefined, 'tool/session_get', 'session/observe', 'console/start', 'lifecycle/shutdown']) {
      expect(mapError(new Error('unexpected worker failure'), { ...(operation === undefined ? {} : { operation }), secretLiterals: [] }).code).toBe('INTERNAL');
    }
  });

  it('does not throw when a hostile error has a malformed cause', () => {
    const mapped = mapError({ code: 'ENGINE_ERROR', message: 'bad', cause: {} }, { secretLiterals: [] });
    expect(mapped).toMatchObject({ code: 'ENGINE_ERROR', message: 'bad' });
  });

  it('redacts sensitive fields even when no literal list was supplied', () => {
    const mapped = mapError({
      name: 'EngineOperationError',
      message: 'failed',
      details: { authorization: 'Bearer abc', token: 'abc', env: { SECRET: 'x' }, engine: 'codex' },
    }, { secretLiterals: [] });
    expect(mapped.details).toEqual({ authorization: '[REDACTED]', token: '[REDACTED]', env: '[REDACTED]', engine: 'codex' });
  });

  // API-017: the mapper's `kind` projection (ADR 0029).
  describe('the failure kind Realm classified', () => {
    const engineError = (kind?: string): EngineOperationError =>
      new EngineOperationError({
        engineId: 'kimi',
        operation: 'session/prompt',
        ...(kind === undefined ? {} : { kind: kind as 'rate-limit' }),
        cause: new Error('engine refused'),
      });

    it('projects a classified kind and leaves an unclassified failure without one', () => {
      expect(mapError(engineError('rate-limit'), { secretLiterals: [] })).toMatchObject({
        code: 'ENGINE_ERROR',
        cause: { name: 'EngineOperationError', kind: 'rate-limit' },
      });
      expect(mapError(engineError(), { secretLiterals: [] }).cause).not.toHaveProperty('kind');
      expect(mapError(new UnauthenticatedError('kimi'), { secretLiterals: [] }).cause).not.toHaveProperty('kind');
    });

    it('reads the field from the class, not from anything claiming its name', () => {
      // `kind` is an ordinary in-process property here — `Reservation.kind` in
      // src/core/mutation-gate.ts is a real one — so the test attaches one to an
      // otherwise ordinary error. A name comparison in place of `instanceof`
      // makes this assertion red.
      const impostor = Object.assign(new Error('engine refused'), { name: 'EngineOperationError', kind: 'rate-limit' });
      expect(mapError(impostor, { secretLiterals: [] }).cause).not.toHaveProperty('kind');
    });

    it('drops a value that is not a bounded slug, and never throws on one that is not a string', () => {
      const kinds: unknown[] = ['RATE LIMIT', 'x'.repeat(200), 42, {}, ''];
      for (const kind of kinds) {
        const error = Object.assign(engineError(), { kind });
        // The secret literal matters: `sanitizeText` is string-only, so a
        // non-string reaching it throws instead of being omitted.
        expect(() => mapError(error, { secretLiterals: ['root-secret'] })).not.toThrow();
        expect(mapError(error, { secretLiterals: ['root-secret'] }).cause).not.toHaveProperty('kind');
      }
    });

    it('passes an unknown but conforming kind through, so an upstream addition is not a violation', () => {
      expect(mapError(engineError('future-kind'), { secretLiterals: [] }).cause).toMatchObject({ kind: 'future-kind' });
    });

    it('drops a kind whose value is a configured secret rather than emitting a redaction', () => {
      const mapped = mapError(engineError('root-secret'), { secretLiterals: ['root-secret'] });
      expect(mapped.cause).not.toHaveProperty('kind');
      expect(JSON.stringify(mapped)).not.toContain('root-secret');
      expect(JSON.stringify(mapped)).not.toContain('REDACTED');
    });
  });

  // API-018's re-projection half: the same normalization on both paths.
  describe('re-projecting an envelope this mapper already produced', () => {
    const envelope = (kind: unknown) => ({
      code: 'ENGINE_ERROR' as const,
      message: 'engine refused',
      cause: { name: 'EngineOperationError', message: 'engine refused', kind },
    });

    it('keeps a conforming kind through toPluginException and a second mapping', () => {
      const first = mapError(
        new EngineOperationError({ engineId: 'kimi', operation: 'session/prompt', kind: 'rate-limit' }),
        { secretLiterals: [] },
      );
      const again = mapError(toPluginException(first), { secretLiterals: [] });
      expect(again.cause).toMatchObject({ name: 'EngineOperationError', kind: 'rate-limit' });
    });

    it('applies the whole normalization, not only the slug rule', () => {
      // The literal is configured for this mapping only, which is the case that
      // separates sanitize-then-validate from a regex test on its own.
      expect(mapError(envelope('root-secret'), { secretLiterals: ['root-secret'] }).cause).not.toHaveProperty('kind');
      expect(mapError(envelope('RATE LIMIT'), { secretLiterals: [] }).cause).not.toHaveProperty('kind');
      expect(mapError(envelope(42), { secretLiterals: ['root-secret'] }).cause).not.toHaveProperty('kind');
    });

    it('rejects a non-string kind at the envelope guard', () => {
      expect(isPluginError(envelope('rate-limit'))).toBe(true);
      expect(isPluginError(envelope(42))).toBe(false);
      expect(isPluginError({ code: 'ENGINE_ERROR', message: 'x', cause: { name: 'E', message: 'x' } })).toBe(true);
    });
  });

  it('keeps cause and details when converting to a native exception', () => {
    const mapped = mapError(new Error('failure'), { details: { engine: 'codex' }, secretLiterals: [] });
    expect(toPluginException(mapped)).toMatchObject({ cause: mapped.cause, details: mapped.details });
  });
});
