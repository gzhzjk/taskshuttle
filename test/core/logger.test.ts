import { describe, expect, it } from 'vitest';

import { createLogger, createStderrSink, faultEvent, loggingEnabled, noopLogger, STDERR_BUFFER_LIMIT_BYTES, type LogRecord } from '../../packages/plugin/src/logger.js';
import type { ErrorCode } from '../../packages/plugin/src/schemas.js';

function collect(): { records: LogRecord[]; sink: (record: LogRecord) => void } {
  const records: LogRecord[] = [];
  return { records, sink: (record) => { records.push(record); } };
}

describe('structured logging', () => {
  it('stamps every record with the instance id, timestamp and event name', () => {
    const { records, sink } = collect();
    const logger = createLogger({ instanceId: 'instance-1', sink, now: () => '2026-01-01T00:00:00.000Z' });
    logger.log({ event: 'engine_crash', engine: 'codex', errorCode: 'ENGINE_ERROR', operation: 'engine/crash' });
    expect(records).toEqual([{ ts: '2026-01-01T00:00:00.000Z', instanceId: 'instance-1', event: 'engine_crash', engine: 'codex', errorCode: 'ENGINE_ERROR', operation: 'engine/crash' }]);
  });

  it('redacts secret literals wherever they appear', () => {
    const { records, sink } = collect();
    const nonce = 'a'.repeat(32);
    const logger = createLogger({ instanceId: `instance-${nonce}`, sink, secretLiterals: [nonce] });
    logger.log({ event: 'recovery_result', targetInstanceId: `dead-${nonce}`, recovered: true, deleted: false, reason: 'crash-recovered', operation: `scan ${nonce}` });
    const record = records[0]!;
    expect(JSON.stringify(record)).not.toContain(nonce);
    expect(record['targetInstanceId']).toBe('dead-[REDACTED]');
    expect(record['operation']).toBe('scan [REDACTED]');
  });

  it('drops non-scalar fields instead of serializing them', () => {
    const { records, sink } = collect();
    const logger = createLogger({ instanceId: 'instance-1', sink });
    // A caller that smuggles a prompt or event body into a field gets nothing.
    logger.log({ event: 'store_error', operation: 'tool/transcript_read', errorCode: 'STORE_ERROR', sessionId: { secret: 'prompt text' } as unknown as string });
    expect(records[0]).toEqual({ ts: expect.any(String), instanceId: 'instance-1', event: 'store_error', operation: 'tool/transcript_read', errorCode: 'STORE_ERROR' });
  });

  it('never lets a failing sink escape into the caller', () => {
    const logger = createLogger({ instanceId: 'instance-1', sink: () => { throw new Error('sink is broken'); } });
    expect(() => logger.log({ event: 'engine_crash', engine: 'codex', errorCode: 'ENGINE_ERROR', operation: 'engine/crash' })).not.toThrow();
  });

  it('drops records instead of buffering an undrained stderr, then reports the gap', () => {
    const written: string[] = [];
    let backlog = 0;
    const stream = { get writableLength() { return backlog; }, write: (line: string) => { written.push(line); return true; } };
    const original = Object.getOwnPropertyDescriptor(process, 'stderr')!;
    Object.defineProperty(process, 'stderr', { configurable: true, get: () => stream as unknown as NodeJS.WriteStream });
    try {
      const logger = createLogger({ instanceId: 'instance-1', now: () => '2026-01-01T00:00:00.000Z' });
      backlog = STDERR_BUFFER_LIMIT_BYTES + 1;
      for (let index = 0; index < 3; index += 1) logger.log({ event: 'turn_transition', turnId: 't1', sessionId: 's1', engine: 'codex', from: 'running', to: 'completed', operation: 'turn/finish' });
      expect(written).toEqual([]);
      backlog = 0;
      logger.log({ event: 'engine_crash', engine: 'codex', errorCode: 'ENGINE_ERROR', operation: 'engine/crash' });
      expect(written).toHaveLength(2);
      expect(JSON.parse(written[0]!)).toMatchObject({ event: 'logs_dropped', dropped: 3, instanceId: 'instance-1' });
      expect(JSON.parse(written[1]!)).toMatchObject({ event: 'engine_crash' });
    } finally {
      Object.defineProperty(process, 'stderr', original);
    }
  });

  it('caps volume on a synchronous stderr, where nothing is ever buffered', () => {
    const written: string[] = [];
    let clock = 0;
    // A synchronous stream (Linux/Windows pipe, or a file) never queues, so
    // writableLength stays 0 and only the rate cap can protect the event loop.
    const sink = createStderrSink({ recordsPerWindow: 2, windowMs: 1_000, now: () => clock, write: (line) => { written.push(line); }, writableLength: () => 0 });
    const logger = createLogger({ instanceId: 'instance-1', sink, now: () => '2026-01-01T00:00:00.000Z' });
    for (let index = 0; index < 5; index += 1) logger.log({ event: 'turn_transition', turnId: 't1', sessionId: 's1', engine: 'codex', from: 'running', to: 'completed', operation: 'turn/finish' });
    expect(written).toHaveLength(2);

    clock += 1_000;
    logger.log({ event: 'engine_crash', engine: 'codex', errorCode: 'ENGINE_ERROR', operation: 'engine/crash' });
    expect(JSON.parse(written[2]!)).toMatchObject({ event: 'logs_dropped', dropped: 3, instanceId: 'instance-1' });
    expect(JSON.parse(written[3]!)).toMatchObject({ event: 'engine_crash' });
  });

  it('never lets a transition burst starve the events that explain a failure', () => {
    const written: string[] = [];
    const sink = createStderrSink({ recordsPerWindow: 1, otherRecordsPerWindow: 10, windowMs: 1_000, now: () => 0, write: (line) => { written.push(line); }, writableLength: () => 0 });
    const logger = createLogger({ instanceId: 'instance-1', sink });
    for (let index = 0; index < 5; index += 1) {
      logger.log({ event: 'turn_transition', turnId: 't1', sessionId: 's1', engine: 'codex', from: 'running', to: 'completed', operation: 'turn/finish' });
    }
    logger.log({ event: 'store_error', operation: 'tool/transcript_read', errorCode: 'STORE_ERROR' });
    logger.log({ event: 'engine_crash', engine: 'codex', errorCode: 'ENGINE_ERROR', operation: 'engine/crash' });
    logger.log({ event: 'shutdown_result', status: 'closed', quitCalls: 1, durationMs: 3 });
    // The bounded, high-value events are exempt from the cap.
    const events = written.map((line) => JSON.parse(line).event as string);
    expect(events.filter((event) => event === 'turn_transition')).toHaveLength(1);
    expect(events).toContain('store_error');
    expect(events).toContain('engine_crash');
    expect(events).toContain('shutdown_result');
    expect(events).toContain('logs_dropped');
  });

  it('also bounds the non-transition events, which a scan or a retry loop can burst', () => {
    const written: string[] = [];
    const sink = createStderrSink({ recordsPerWindow: 100, otherRecordsPerWindow: 3, scanRecordsPerWindow: 3, windowMs: 1_000, now: () => 0, write: (line) => { written.push(line); }, writableLength: () => 0 });
    const logger = createLogger({ instanceId: 'instance-1', sink });
    // A recovery scan over many stale instance directories, on a synchronous
    // stderr where the byte bound can never fire.
    for (let index = 0; index < 50; index += 1) {
      logger.log({ event: 'recovery_result', targetInstanceId: `dead-${index}`, recovered: false, deleted: false, reason: 'identity-uncertain', operation: 'instance/recovery' });
    }
    expect(written.filter((line) => JSON.parse(line).event === 'recovery_result')).toHaveLength(3);
    // The other budgets are independent: a scan flood is exactly when the
    // failure events matter most.
    logger.log({ event: 'turn_transition', turnId: 't1', sessionId: 's1', engine: 'codex', from: 'running', to: 'completed', operation: 'turn/finish' });
    logger.log({ event: 'store_error', operation: 'tool/transcript_read', errorCode: 'STORE_ERROR' });
    logger.log({ event: 'engine_crash', engine: 'codex', errorCode: 'ENGINE_ERROR', operation: 'engine/crash' });
    logger.log({ event: 'shutdown_result', status: 'closed', quitCalls: 1, durationMs: 4 });
    const events = written.map((line) => JSON.parse(line).event as string);
    expect(events).toContain('turn_transition');
    expect(events).toContain('store_error');
    expect(events).toContain('engine_crash');
    expect(events).toContain('shutdown_result');
  });

  it('reopens the window after a backwards clock step instead of wedging shut', () => {
    const written: string[] = [];
    let clock = 1_000_000;
    const sink = createStderrSink({ recordsPerWindow: 1, windowMs: 1_000, now: () => clock, write: (line) => { written.push(line); }, writableLength: () => 0 });
    const logger = createLogger({ instanceId: 'instance-1', sink });
    const transition = { event: 'turn_transition', turnId: 't1', sessionId: 's1', engine: 'codex', from: 'running', to: 'completed', operation: 'turn/finish' } as const;
    logger.log(transition);
    logger.log(transition);
    expect(written).toHaveLength(1);

    clock -= 60_000; // an NTP step or a VM resume moves the clock backwards
    logger.log(transition);
    // A fresh window opens immediately; the old one is not held shut for a minute.
    expect(written.filter((line) => JSON.parse(line).event === 'turn_transition')).toHaveLength(2);
    expect(written.map((line) => JSON.parse(line).event)).toContain('logs_dropped');
  });

  it('flushes the drop notice when nothing else is ever logged', () => {
    const written: string[] = [];
    let flushDrops: (() => void) | undefined;
    const sink = createStderrSink({ recordsPerWindow: 0, now: () => 0, write: (line) => { written.push(line); }, writableLength: () => 0, onDrop: (flush) => { flushDrops = flush; } });
    const logger = createLogger({ instanceId: 'instance-1', sink });
    logger.log({ event: 'turn_transition', turnId: 't1', sessionId: 's1', engine: 'codex', from: 'running', to: 'completed', operation: 'turn/finish' });
    expect(written).toEqual([]);
    // Stand-in for the drain/exit hooks: the count is not lost with the burst.
    flushDrops!();
    expect(JSON.parse(written[0]!)).toMatchObject({ event: 'logs_dropped', dropped: 1, instanceId: 'instance-1' });
  });

  it("keeps each sink's drop count to itself", () => {
    const first: string[] = [];
    const second: string[] = [];
    const sinkA = createStderrSink({ recordsPerWindow: 0, now: () => 0, write: (line) => { first.push(line); }, writableLength: () => 0 });
    const sinkB = createStderrSink({ recordsPerWindow: 10, now: () => 0, write: (line) => { second.push(line); }, writableLength: () => 0 });
    createLogger({ instanceId: 'instance-A', sink: sinkA }).log({ event: 'turn_transition', turnId: 't1', sessionId: 's1', engine: 'codex', from: 'running', to: 'completed', operation: 'turn/finish' });
    createLogger({ instanceId: 'instance-B', sink: sinkB }).log({ event: 'turn_transition', turnId: 't1', sessionId: 's1', engine: 'codex', from: 'running', to: 'completed', operation: 'turn/finish' });
    expect(second.map((line) => JSON.parse(line).event)).toEqual(['turn_transition']);
    expect(first).toEqual([]);
  });

  it('can be disabled entirely', () => {
    const { records, sink } = collect();
    const logger = createLogger({ instanceId: 'instance-1', sink, enabled: false });
    logger.log({ event: 'engine_crash', engine: 'codex', errorCode: 'ENGINE_ERROR', operation: 'engine/crash' });
    expect(records).toEqual([]);
    expect(logger).toBe(noopLogger);
    expect(loggingEnabled({ REALM_PLUGIN_LOG: 'off' } as NodeJS.ProcessEnv)).toBe(false);
    expect(loggingEnabled({} as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('classified-fault event names (ADR 0030, API-021/022)', () => {
  it('names each attribution code and stays silent for every other one', () => {
    // API-021's half that a rename cannot fake: the store still has its event.
    expect(faultEvent('STORE_ERROR')).toEqual({ event: 'store_error', errorCode: 'STORE_ERROR' });
    expect(faultEvent('INTERNAL')).toEqual({ event: 'internal_error', errorCode: 'INTERNAL' });
    expect(faultEvent('ENGINE_ERROR')).toEqual({ event: 'engine_error', errorCode: 'ENGINE_ERROR' });

    // Everything else earns none. `TURN_TIMEOUT` and `INTERACTION_TIMEOUT` are
    // produced inside the plugin and already ride `turn_transition`; the rest
    // are answers to the caller. A site that logged them would claim a fault
    // where the plugin has an answer.
    const silent: ErrorCode[] = [
      'INVALID_ARGUMENT',
      'NOT_FOUND',
      'SESSION_UNAVAILABLE',
      'CONFLICT',
      'GONE',
      'LIMIT_EXCEEDED',
      'NOT_SUPPORTED',
      'TURN_TIMEOUT',
      'INTERACTION_TIMEOUT',
      'PAYLOAD_TOO_LARGE',
      'PERMISSION_DENIED',
      'RECURSION_DENIED',
    ];
    for (const code of silent) expect(faultEvent(code)).toBeUndefined();
  });

});
