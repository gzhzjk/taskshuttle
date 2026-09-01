import { writeSync, openSync, closeSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import type { DoubtCause } from './delegation-evidence.js';

import type { HostCwdSource } from './plugin-config.js';
import type { ErrorCode } from './schemas.js';
import { compatEnv, type CompatReport } from './plugin-config.js';

// This is the Plugin-only logger: Core's domain-event DTOs and sink port live
// in the dependency-free Core package. Redaction, rate limiting, stderr/file
// sinks, and progress-journal formatting stay on this side.

/**
 * Structured observability (design §15). Fields are per event and allowlisted:
 * every event carries the instance id and its own operation, most carry the
 * stable ids they are about, and only some carry an error code or a duration —
 * this union is where that is decided. Prompts, transcript events, environment,
 * headers and the delegation nonce never reach a log line: fields are built
 * from the typed shapes below (an allowlist by construction) and every string
 * value is passed through the secret redactor before it is emitted.
 */
export type LogEvent =
  | { event: 'compat_fallback'; variable: string; operation: string }
  | { event: 'instance_started'; pid: number; hostPlatform: string; delegationDepth?: number; dataRootMode: string; hostCwdSource: HostCwdSource; operation: string }
  | { event: 'session_transition'; sessionId: string; engine: string; from: string; to: string; operation: string; errorCode?: ErrorCode }
  | { event: 'turn_transition'; turnId: string; sessionId: string; engine: string; from: string; to: string; priority?: string; operation: string; durationMs?: number; queuedMs?: number; errorCode?: ErrorCode }
  | { event: 'interaction_transition'; interactionId: string; turnId: string; sessionId: string; kind: string; to: string; operation: string; durationMs?: number }
  | { event: 'engine_crash'; engine: string; errorCode: ErrorCode; operation: string }
  /** Console listener up; the only instance datum it carries is the port (console-design §4). */
  | { event: 'console_started'; port: number; operation: string }
  /** project_init wrote the project file: the path and the generated engine list, never the content (init-design §8). */
  | { event: 'project_init'; path: string; created: boolean; engines: string[]; operation: string }
  /** project_init's console start failed: the error category only, never the stack. */
  | { event: 'console_start_failed'; errorCode: ErrorCode; operation: string }
  // Separate from console_start_failed because nothing failed: the recursion
  // boundary declined the start. Reporting a failure that did not happen is the
  // defect ADR 0030 removed from this vocabulary (ADR 0031).
  | { event: 'console_withheld'; provenance: 'marker' | 'ancestry' | 'unavailable'; operation: string;
      // Which doubt the verdict reached, what the scan read, and — on a
      // delegated verdict — what matched. A withheld console said only
      // `unavailable` before ADR 0033, which is the same word for a corrupt
      // manifest, a lapsed budget and a pid collision.
      cause?: DoubtCause; records?: number; scanMs?: number; matchedInstanceId?: string }
  /** The post-initialize host-label rewrite failed; the console keeps the platform label. */
  | { event: 'host_rewrite_failed'; errorCode: ErrorCode; operation: string }
  /** A session observation refresh failed; the record keeps its last real values (design §4.1). */
  | { event: 'observation_refresh_failed'; sessionId: string; engine: string; reason: string; operation: string }
  /**
   * The three classified-fault events (ADR 0030). Unlike every other member of
   * this union, their names are not chosen by the site that emits them: the
   * name IS the classification, so an event never points at a subsystem the
   * fault did not touch. `faultEvent` is the only place that mapping
   * exists; a site picking a name for itself is the defect the record fixes.
   *
   * Three variants rather than one with a union of names: a single variant
   * would type-check `internal_error` carrying `STORE_ERROR`, which is the
   * mismatch the whole record exists to prevent, and no test can be relied on
   * to catch what the type could have refused.
   */
  | { event: 'store_error'; operation: string; errorCode: 'STORE_ERROR'; sessionId?: string; turnId?: string; interactionId?: string; from?: string; to?: string }
  | { event: 'internal_error'; operation: string; errorCode: 'INTERNAL'; sessionId?: string; turnId?: string; interactionId?: string; from?: string; to?: string }
  | { event: 'engine_error'; operation: string; errorCode: 'ENGINE_ERROR'; sessionId?: string; turnId?: string; interactionId?: string; from?: string; to?: string }
  /** Emitted by the stderr sink itself when it had to skip records. */
  | { event: 'logs_dropped'; dropped: number }
  | { event: 'shutdown_result'; status: string; quitCalls: number; durationMs: number; errorCode?: ErrorCode }
  | { event: 'recovery_result'; targetInstanceId: string; recovered: boolean; deleted: boolean; reason: string; operation: string }
  | { event: 'retention_result'; scanned: number; deleted: number; anomalies: number; skipped: boolean; orphansReaped: number; durationMs: number };

export type LogEventName = LogEvent['event'];

export interface LogRecord {
  readonly ts: string;
  readonly instanceId: string;
  readonly event: LogEventName;
  readonly [field: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

export interface PluginLogger {
  log(event: LogEvent): void;
}

/** Stop writing once this many bytes are waiting in an asynchronous stderr stream. */
export const STDERR_BUFFER_LIMIT_BYTES = 262_144;
/** Volume cap, which is the only guard available on a synchronous stderr. */
export const STDERR_WINDOW_MS = 1_000;
export const STDERR_RECORDS_PER_WINDOW = 500;

export interface StderrSinkOptions {
  readonly bufferLimitBytes?: number;
  readonly recordsPerWindow?: number;
  /** Budget for the non-transition, non-scan events; defaults to a fifth of `recordsPerWindow`. */
  readonly otherRecordsPerWindow?: number;
  /** Budget for `recovery_result`; defaults to `otherRecordsPerWindow`. */
  readonly scanRecordsPerWindow?: number;
  readonly windowMs?: number;
  readonly now?: () => number;
  /** Test seam; production writes to `process.stderr` / fd 2. */
  readonly write?: (line: string) => void;
  readonly writableLength?: () => number;
  readonly onDrop?: (flush: () => void) => void;
}

/**
 * Stderr only: stdout belongs to the stdio MCP transport.
 *
 * A host that never drains stderr must not be able to stall the plugin. Pipe
 * writes are synchronous on Linux and Windows (and for files/TTYs on POSIX), so
 * `writableLength` stays at zero there and buffer depth cannot be the guard —
 * the rate cap is. On an asynchronous stderr (a macOS pipe) the buffer check
 * bounds memory as well. Dropped records are counted and reported: on the next
 * write that passes both guards, when the stream drains, and — because a burst
 * at shutdown may have no "next write" — synchronously at process exit.
 *
 * Residual: a bounded rate still fills a pipe eventually, so a host that pipes
 * stderr and never reads it can still block a synchronous write. Removing that
 * entirely needs a non-blocking dup of fd 2 with EAGAIN treated as a drop;
 * until then `REALM_PLUGIN_LOG=off` is the escape.
 */
/**
 * Two buckets, not one exempt class. The per-transition events burst hardest
 * (a busy instance emits ~8-10 per turn), so they get their own budget and can
 * never starve the rest; but `recovery_result` scales with the number of
 * instance directories and `store_error` with a caller's retry loop, so the
 * others need a budget too — on a synchronous stderr the byte bound cannot fire
 * and the rate cap is the only guard against blocking the event loop.
 */
const RATE_LIMITED_EVENTS: ReadonlySet<string> = new Set(['session_transition', 'turn_transition', 'interaction_transition']);
/**
 * `recovery_result` is the other high-cardinality event: it scales with the
 * number of instance directories, and a degraded data root is exactly when it
 * bursts. It gets its own budget so a scan can never crowd out the bounded
 * failure events (`engine_crash`, `store_error`, `shutdown_result`, …) — which
 * is the very state the scan is reporting.
 */
const SCAN_EVENTS: ReadonlySet<string> = new Set(['recovery_result']);
/** Budget for everything else, as a fraction of the transition budget. */
export const STDERR_OTHER_RECORDS_DIVISOR = 5;

export function createStderrSink(options: StderrSinkOptions = {}): LogSink {
  const bufferLimit = options.bufferLimitBytes ?? STDERR_BUFFER_LIMIT_BYTES;
  const windowMs = options.windowMs ?? STDERR_WINDOW_MS;
  const perWindow = options.recordsPerWindow ?? STDERR_RECORDS_PER_WINDOW;
  // Monotonic by default: a backwards wall-clock step must not wedge the window
  // shut, which would silence logging until real time caught up.
  const now = options.now ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  const write = options.write ?? ((line: string) => { process.stderr.write(line); });
  const writableLength = options.writableLength ?? (() => process.stderr.writableLength ?? 0);

  const otherPerWindow = options.otherRecordsPerWindow ?? Math.max(1, Math.ceil(perWindow / STDERR_OTHER_RECORDS_DIVISOR));
  const scanPerWindow = options.scanRecordsPerWindow ?? otherPerWindow;
  let dropped = 0;
  let windowStart = now();
  let inWindow = 0;
  let othersInWindow = 0;
  let scanInWindow = 0;
  let lastInstanceId = '';
  let exitHookInstalled = false;
  let drainArmed = false;

  const notice = (): string => JSON.stringify({ ts: new Date().toISOString(), instanceId: lastInstanceId, event: 'logs_dropped', dropped });
  const flush = (): void => {
    if (dropped === 0) return;
    const line = `${notice()}\n`;
    dropped = 0;
    try { write(line); } catch { /* nothing left to do */ }
  };
  const armDrain = (): void => {
    if (drainArmed) return;
    drainArmed = true;
    try { process.stderr.once('drain', () => { drainArmed = false; flush(); }); }
    catch { drainArmed = false; /* stream has no events */ }
  };
  const installFlushHooks = (): void => {
    armDrain();
    options.onDrop?.(flush);
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    // The exit hook is the one that survives a burst with no later record. It
    // is skipped when the pipe is still backed up: a blocking writeSync on a
    // full pipe would turn the shutdown path into the new stall.
    try {
      process.once('exit', () => {
        if (dropped === 0 || writableLength() > bufferLimit) return;
        try { writeSync(2, `${notice()}\n`); } catch { /* fd is gone */ }
      });
    } catch { /* no process hooks available */ }
  };

  return (record) => {
    try {
      lastInstanceId = record.instanceId;
      const current = now();
      // A backwards step opens a fresh window rather than wedging the old one
      // shut until wall time catches up.
      if (current < windowStart || current - windowStart >= windowMs) { windowStart = current; inWindow = 0; othersInWindow = 0; scanInWindow = 0; }
      const rateLimited = RATE_LIMITED_EVENTS.has(record.event);
      const scan = SCAN_EVENTS.has(record.event);
      const overBudget = rateLimited ? inWindow >= perWindow : scan ? scanInWindow >= scanPerWindow : othersInWindow >= otherPerWindow;
      if (overBudget || writableLength() > bufferLimit) {
        dropped += 1;
        installFlushHooks();
        return;
      }
      // The notice comes first and is deliberately exempt from both budgets:
      // it is at most one line per burst, and it is the line that explains the
      // gap. A window therefore emits at most perWindow + otherPerWindow + 1.
      flush();
      if (rateLimited) inWindow += 1; else if (scan) scanInWindow += 1; else othersInWindow += 1;
      write(`${JSON.stringify(record)}\n`);
    } catch { /* a broken log pipe must never break the plugin */ }
  };
}

/** Convenience default for a single-runtime process; each runtime builds its own. */
export const stderrSink: LogSink = createStderrSink();

export const noopLogger: PluginLogger = { log: () => undefined };

function redact(value: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
}

function sanitizeValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redact(value, secrets);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  return undefined;
}

/** Events that the progress journal carries (ADR 0040). */
export const JOURNAL_EVENTS: ReadonlySet<string> = new Set(['turn_transition', 'interaction_transition']);

/**
 * Create a file sink that appends NDJSON without rate limiting (ADR 0040).
 * Uses O_NOFOLLOW to avoid following symlinks.
 * @param instanceDir - instance directory containing progress.ndjson
 * @returns sink that appends journal events
 */
export function createJournalSink(instanceDir: string): LogSink {
  return (record) => {
    if (!JOURNAL_EVENTS.has(record.event)) return;
    try {
      const file = join(instanceDir, 'progress.ndjson');
      const fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW, 0o600);
      try { writeSync(fd, `${JSON.stringify(record)}\n`); } finally { closeSync(fd); }
    } catch { /* best-effort, never break plugin */ }
  };
}

/**
 * Fan-out sink for stderr + journal.
 * @param sinks - sinks to forward to
 * @returns combined sink
 */
export function createFanoutSink(sinks: LogSink[]): LogSink {
  return (record) => { for (const s of sinks) try { s(record); } catch { /* ignore */ } };
}

export interface LoggerOptions {
  readonly instanceId: string;
  readonly sink?: LogSink;
  /** Instance directory for journal sink; when set a file sink is added. */
  readonly instanceDir?: string;
  /** Literals that must never appear in a log line (delegation nonce, launch token). */
  readonly secretLiterals?: readonly string[];
  readonly now?: () => string;
  readonly enabled?: boolean;
}

/**
 * Build the logger. Only scalar fields survive: an object or array smuggled
 * into an event field is dropped rather than serialized.
 */
export function createLogger(options: LoggerOptions): PluginLogger {
  if (options.enabled === false) return noopLogger;
  // Each logger owns its sink, so one runtime's volume can never consume
  // another's rate window or be reported under its instance id.
  let sink: LogSink;
  if (options.sink !== undefined) sink = options.sink;
  else {
    const stderr = createStderrSink();
    if (options.instanceDir) {
      const journal = createJournalSink(options.instanceDir);
      sink = createFanoutSink([stderr, journal]);
    } else sink = stderr;
  }
  const secrets = options.secretLiterals ?? [];
  const now = options.now ?? (() => new Date().toISOString());
  return {
    log(event: LogEvent): void {
      // Redaction covers the envelope too: no field is exempt.
      const record: Record<string, unknown> = { ts: now(), instanceId: redact(options.instanceId, secrets), event: event.event };
      for (const [field, value] of Object.entries(event)) {
        if (field === 'event') continue;
        const safe = sanitizeValue(value, secrets);
        if (safe !== undefined) record[field] = safe;
      }
      try { sink(record as LogRecord); }
      catch { /* a failing sink must never break the plugin */ }
    },
  };
}

export const LOG_ENV = 'TASKSHUTTLE_LOG';

/** `REALM_PLUGIN_LOG=off` disables structured logging; anything else enables it. */
export function loggingEnabled(env: NodeJS.ProcessEnv = process.env, report?: CompatReport): boolean {
  return (compatEnv(env, LOG_ENV, 'REALM_PLUGIN_LOG', report) ?? '').trim().toLowerCase() !== 'off';
}

export type FaultEventHead =
  | { readonly event: 'store_error'; readonly errorCode: 'STORE_ERROR' }
  | { readonly event: 'internal_error'; readonly errorCode: 'INTERNAL' }
  | { readonly event: 'engine_error'; readonly errorCode: 'ENGINE_ERROR' };

/**
 * The classified-fault event a code is reported under, or `undefined` when the
 * code earns none (ADR 0030, design §15).
 *
 * Returns the name **and** the code as one value, so a caller cannot pair them
 * itself: the two are one decision, and a site free to combine them is a site
 * that can log `internal_error` for a store fault.
 *
 * Only the three attribution codes name a fault. The rest are answers to the
 * caller, or are produced inside the plugin and already ride an outcome event —
 * `TURN_TIMEOUT` on `turn_transition`, for one. Returning `undefined` for those
 * is the rule, not a gap: a site that logged them would be claiming a fault
 * where the plugin has an answer.
 *
 * @param code - the mapped error code.
 * @returns the event head, or `undefined` when no classified-fault event is due.
 */
export function faultEvent(code: ErrorCode): FaultEventHead | undefined {
  switch (code) {
    case 'STORE_ERROR':
      return { event: 'store_error', errorCode: 'STORE_ERROR' };
    case 'INTERNAL':
      return { event: 'internal_error', errorCode: 'INTERNAL' };
    case 'ENGINE_ERROR':
      return { event: 'engine_error', errorCode: 'ENGINE_ERROR' };
    default:
      return undefined;
  }
}
