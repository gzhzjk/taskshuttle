import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  NotFoundError,
  StoreError,
  type DigestOptions,
  type DigestResult,
  type SessionFilter,
  type SessionMeta,
  type SessionStatus,
  type StructuredDigest,
  type StructuredDigestOptions,
  type TextDigestOptions,
  type TranscriptDigest,
  type TranscriptEvent,
  type TranscriptStore,
} from 'runskein';

const requireBuiltin = createRequire(import.meta.url);
/**
 * The session-metadata marker runskein writes, held as the plugin's own literal.
 *
 * `design.md` §12 forbids implementations importing `@runskein/core/internal`,
 * which is where the producer's constant is exported from — the public entry
 * does not export it — so nothing type-checks this string against the producer.
 * A **producer-driven test** is what establishes they agree; a fixture carrying
 * this same literal would test one half of the pair against itself.
 *
 * The pre-rename spelling `realm.dev/sessionMeta` is **not** read. ADR 0041
 * decision 2 makes the rename a clean break: a transcript recorded under the
 * old dependency keeps its events and projects nothing, because reading the
 * legacy key here while the two markers bundled libraries fold stayed
 * unreadable would render such a transcript with a correct session header and
 * no usage — which reads as a session that used no tokens rather than as one
 * that is unsupported.
 */
const SESSION_META_KEY = 'runskein.dev/sessionMeta';
const DIGEST_TRUNCATION_MARKER = '[...earlier context truncated...]\n';
const DEFAULT_DIGEST_MAX_CHARS = 32_000;
const TOOL_OUTPUT_MAX_CHARS = 400;

type StoreOperation = 'append' | 'read' | 'sessions' | 'digest' | 'delete';

interface StoredRow {
  session_id: string;
  seq: number;
  ts: number;
  engine_id: string;
  event_json: Uint8Array | Buffer;
  byte_len: number;
  sha256: string;
}

/**
 * Returns the Node SQLite constructor required by the transcript store.
 *
 * @returns The synchronous SQLite constructor supplied by Node.
 * @throws An error with code `INVALID_ARGUMENT` when `node:sqlite` is unavailable.
 */
export function nodeSqliteDatabase(): new (path: string) => DatabaseSync {
  try {
    return (requireBuiltin('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync }).DatabaseSync;
  } catch (cause) {
    const error = new Error('Realm requires Node >= 22 with node:sqlite; configure OpenCode to use the Realm stdio MCP server.', { cause }) as Error & { code: string };
    error.code = 'INVALID_ARGUMENT';
    throw error;
  }
}

interface SessionMetaProjection {
  cwd?: string;
  status?: SessionStatus;
}

function asStoreError(
  operation: StoreOperation,
  cause: unknown,
  sessionId?: string,
  engineId?: string,
): StoreError | NotFoundError {
  if (cause instanceof NotFoundError) return cause;
  if (cause instanceof StoreError && cause.operation === operation) return cause;
  return new StoreError({ operation, cause, ...(sessionId === undefined ? {} : { sessionId }), ...(engineId === undefined ? {} : { engineId }) });
}

/** What a malformed marker reports: enough to find the producer that wrote it. */
export interface MalformedMetaReport {
  readonly sessionId: string;
  readonly seq: number;
}

function readMeta(event: TranscriptEvent, onMalformed?: (report: MalformedMetaReport) => void): SessionMetaProjection | undefined {
  if (event.update.sessionUpdate !== 'session_info_update') return undefined;
  const meta = event.update._meta;
  // Presence, then shape. `_meta` without this key is the ordinary case — every
  // pre-upgrade transcript is one, and so is every event that simply carries no
  // marker — so reporting on absence would fire on the supported path. What is
  // worth reporting is a marker that is *there* and unusable, which otherwise
  // leaves the projection at its default with nothing said (ADR 0041).
  // `_meta` is optional *and* nullable on the wire — `in` throws on null, so
  // both absences are excluded before the key test rather than only the one
  // the happy path produces.
  if (meta === undefined || meta === null || !(SESSION_META_KEY in meta)) return undefined;
  const raw = meta[SESSION_META_KEY];
  if (typeof raw !== 'object' || raw === null) {
    onMalformed?.({ sessionId: event.sessionId, seq: event.seq });
    return undefined;
  }
  const candidate = raw as Record<string, unknown>;
  const result: SessionMetaProjection = {};
  if (typeof candidate['cwd'] === 'string') result.cwd = candidate['cwd'];
  const status = candidate['status'];
  if (status === 'idle' || status === 'running' || status === 'awaiting-input' || status === 'closed' || status === 'failed') {
    result.status = status;
  }
  return result;
}

/** Public-only equivalent of Realm's session metadata fold. */
export function foldSessionMeta(
  events: Iterable<TranscriptEvent>,
  onMalformed?: (report: MalformedMetaReport) => void,
): SessionMeta | undefined {
  let meta: SessionMeta | undefined;
  // At most once per fold, not once per store: a second console refresh
  // reporting the same malformed marker repeats a true statement, where a
  // store-lifetime latch would go quiet on a session that is still broken.
  let reported = false;
  const reportOnce = (report: MalformedMetaReport): void => {
    if (reported) return;
    reported = true;
    onMalformed?.(report);
  };
  for (const event of events) {
    if (meta === undefined) {
      meta = {
        sessionId: event.sessionId,
        engineId: event.engineId,
        cwd: '',
        status: 'idle',
        createdAt: event.ts,
        updatedAt: event.ts,
      };
    } else {
      meta.updatedAt = event.ts;
    }
    const realmMeta = readMeta(event, onMalformed === undefined ? undefined : reportOnce);
    if (realmMeta?.cwd !== undefined) meta.cwd = realmMeta.cwd;
    if (realmMeta?.status !== undefined) meta.status = realmMeta.status;
  }
  return meta;
}

function matchesFilter(meta: SessionMeta, filter: SessionFilter | undefined): boolean {
  if (filter === undefined) return true;
  if (filter.engineId !== undefined && meta.engineId !== filter.engineId) return false;
  if (filter.status !== undefined && meta.status !== filter.status) return false;
  if (filter.cwd !== undefined && meta.cwd !== filter.cwd) return false;
  if (filter.since !== undefined && meta.updatedAt < filter.since) return false;
  if (filter.until !== undefined && meta.createdAt > filter.until) return false;
  return true;
}

function canonicalBytes(event: TranscriptEvent): Buffer {
  return Buffer.from(JSON.stringify(event), 'utf8');
}

function digestText(sessionId: string, events: Iterable<TranscriptEvent>, maxChars = DEFAULT_DIGEST_MAX_CHARS): TranscriptDigest {
  const tailLimit = Math.max(0, maxChars - DIGEST_TRUNCATION_MARKER.length);
  let throughSeq = 0;
  let text = '';
  let lastRole: string | undefined;
  let truncated = false;
  const append = (value: string): void => {
    text += value;
    if ((!truncated && text.length > maxChars) || (truncated && text.length > tailLimit)) {
      text = tailLimit === 0 ? '' : text.slice(-tailLimit);
      truncated = true;
    }
  };
  const push = (role: string, value: string): void => {
    if (role === lastRole && text.length > 0) append(value);
    else {
      append(`${text.length > 0 ? '\n' : ''}${role}: ${value}`);
      lastRole = role;
    }
  };
  for (const event of events) {
    throughSeq = Math.max(throughSeq, event.seq);
    const update = event.update;
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        if (update.content.type === 'text') push('User', update.content.text);
        break;
      case 'agent_message_chunk':
        if (update.content.type === 'text') push('Assistant', update.content.text);
        break;
      case 'tool_call':
        append(`${text.length > 0 ? '\n' : ''}Tool: ${update.title ?? update.toolCallId} (${update.kind ?? 'other'})`);
        lastRole = undefined;
        break;
      case 'tool_call_update': {
        if (update.status !== 'completed' && update.status !== 'failed') break;
        const parts: string[] = [];
        for (const item of update.content ?? []) {
          if (item.type === 'content' && item.content.type === 'text') parts.push(item.content.text);
        }
        if (parts.length === 0 && typeof update.rawOutput === 'string') parts.push(update.rawOutput);
        const output = parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, TOOL_OUTPUT_MAX_CHARS);
        append(`${text.length > 0 ? '\n' : ''}Tool result (${update.toolCallId}): ${update.status}${output.length > 0 ? ` — ${output}` : ''}`);
        lastRole = undefined;
        break;
      }
      default:
        break;
    }
  }
  return { sessionId, throughSeq, text: truncated ? DIGEST_TRUNCATION_MARKER + text : text };
}

/**
 * Post-commit change notification (console-design §5.2). Listeners run
 * synchronously inside the serialized append/delete lane, right after COMMIT,
 * so they must only record what they are handed — socket writes and other
 * slow work are the listener's job to defer, never to do here.
 */
export interface TranscriptStoreListener {
  onAppend?(sessionId: string, event: TranscriptEvent): void;
  onDelete?(sessionId: string): void;
}

/** SQLite-backed Realm TranscriptStore with canonical event bytes and hashes. */
export class PluginTranscriptStore implements TranscriptStore {
  private readonly ready: Promise<void>;
  private db: DatabaseSync | undefined;
  private readonly appendChains = new Map<string, Promise<void>>();
  private readonly highWatermarks = new Map<string, number>();
  private appendEpoch = 0;
  private readonly eventEpochs = new Map<string, Map<number, number>>();
  private readonly changeListeners = new Set<TranscriptStoreListener>();

  private readonly databasePath: string;
  private readonly dataRoot: string | undefined;

  private readonly onMalformedMeta: ((report: MalformedMetaReport) => void) | undefined;

  constructor(databasePath: string, options: { dataRoot?: string; onMalformedMeta?: (report: MalformedMetaReport) => void } = {}) {
    this.onMalformedMeta = options.onMalformedMeta;
    this.databasePath = resolve(databasePath);
    this.dataRoot = options.dataRoot === undefined ? undefined : resolve(options.dataRoot);
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      const parent = dirname(this.databasePath);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const parentPathInfo = await lstat(parent);
      if (parentPathInfo.isSymbolicLink() || !parentPathInfo.isDirectory()) throw new Error('transcript database parent must be a real directory');
      const parentInfo = await stat(parent);
      if ((parentInfo.mode & 0o777) !== 0o700) throw new Error('transcript database directory must be mode 0700');
      if (this.dataRoot !== undefined) {
        const rootInfo = await lstat(this.dataRoot);
        if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('transcript data root must be a real directory');
        const root = await realpath(this.dataRoot);
        const canonicalParent = await realpath(parent);
        const escaped = relative(root, canonicalParent).startsWith('..') || resolve(root, relative(root, canonicalParent)) !== canonicalParent;
        if (escaped) throw new Error('transcript database is outside the configured data root');
      }
      const journalPath = `${this.databasePath}-journal`;
      const walPath = `${this.databasePath}-wal`;
      const shmPath = `${this.databasePath}-shm`;
      for (const sidecar of [walPath, shmPath]) {
        try {
          const sidecarInfo = await lstat(sidecar);
          if (sidecarInfo.isSymbolicLink()) throw new Error(`unsafe SQLite sidecar symlink: ${sidecar}`);
          throw new Error(`unexpected SQLite sidecar exists: ${sidecar}`);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        }
      }
      try {
        const journalInfo = await lstat(journalPath);
        if (journalInfo.isSymbolicLink() || !journalInfo.isFile() || (journalInfo.mode & 0o777) !== 0o600) {
          throw new Error('pre-existing SQLite rollback journal is unsafe');
        }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      }
      const descriptor = await open(
        this.databasePath,
        fsConstants.O_CREAT | fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await descriptor.chmod(0o600);
      const info = await descriptor.stat();
      if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
        await descriptor.close();
        throw new Error('transcript database must be a regular file with mode 0600');
      }
      const openedIdentity = { dev: info.dev, ino: info.ino };
      await descriptor.close();
      const pathInfo = await lstat(this.databasePath);
      if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || (pathInfo.mode & 0o777) !== 0o600) {
        throw new Error('transcript database path changed or has unsafe mode');
      }
      const Database = nodeSqliteDatabase();
      this.db = new Database(this.databasePath);
      const openedPathInfo = await lstat(this.databasePath);
      if (openedPathInfo.isSymbolicLink() || openedPathInfo.dev !== openedIdentity.dev || openedPathInfo.ino !== openedIdentity.ino) {
        this.db.close();
        this.db = undefined;
        throw new Error('transcript database path identity changed during open');
      }
      this.db.exec('PRAGMA journal_mode=PERSIST; PRAGMA temp_store=MEMORY;');
      const journalMode = (this.db.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown }).journal_mode;
      const tempStore = (this.db.prepare('PRAGMA temp_store').get() as { temp_store?: unknown }).temp_store;
      if (journalMode !== 'persist' || tempStore !== 2) throw new Error('SQLite journal/temp_store policy was not applied');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS transcript_events (
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          ts INTEGER NOT NULL,
          engine_id TEXT NOT NULL,
          event_json BLOB NOT NULL,
          byte_len INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          PRIMARY KEY (session_id, seq)
        );
        CREATE INDEX IF NOT EXISTS transcript_events_session_seq ON transcript_events(session_id, seq);
      `);
      this.db.exec('BEGIN IMMEDIATE; INSERT OR IGNORE INTO store_meta (key, value) VALUES (\'bootstrap\', \'1\'); COMMIT;');
      try {
        const journalInfo = await lstat(journalPath);
        if (journalInfo.isSymbolicLink() || !journalInfo.isFile() || (journalInfo.mode & 0o777) !== 0o600) {
          throw new Error('SQLite rollback journal must be a regular file with mode 0600');
        }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      }
      for (const sidecar of [walPath, shmPath]) {
        try {
          await lstat(sidecar);
          throw new Error(`SQLite WAL/SHM sidecar is not permitted: ${sidecar}`);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        }
      }
      const rows = this.db.prepare('SELECT session_id, MAX(seq) AS max_seq FROM transcript_events GROUP BY session_id').all() as Array<{ session_id: string; max_seq: number }>;
      for (const row of rows) this.highWatermarks.set(row.session_id, row.max_seq);
    } catch (cause) {
      try { this.db?.close(); } catch { /* preserve initialization failure */ }
      this.db = undefined;
      throw new StoreError({ operation: 'append', cause });
    }
  }

  private database(operation: StoreOperation): DatabaseSync {
    if (this.db === undefined) throw new StoreError({ operation, cause: new Error('store is not initialized') });
    return this.db;
  }

  private serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.appendChains.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.appendChains.set(sessionId, settled);
    void settled.finally(() => {
      if (this.appendChains.get(sessionId) === settled) this.appendChains.delete(sessionId);
    });
    return result;
  }

  async append(event: TranscriptEvent): Promise<void> {
    const epoch = ++this.appendEpoch;
    return this.serialize(event.sessionId, async () => {
      await this.ready;
      try {
        const db = this.database('append');
        const bytes = canonicalBytes(event);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const current = this.highWatermarks.get(event.sessionId) ?? 0;
        if (event.seq <= current) throw new Error(`event seq ${event.seq} is not greater than high watermark ${current}`);
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('INSERT INTO transcript_events (session_id, seq, ts, engine_id, event_json, byte_len, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
            event.sessionId,
            event.seq,
            event.ts,
            event.engineId,
            bytes,
            bytes.byteLength,
            sha256,
          );
          db.exec('COMMIT');
        } catch (cause) {
          try { db.exec('ROLLBACK'); } catch { /* preserve original failure */ }
          throw cause;
        }
        this.highWatermarks.set(event.sessionId, event.seq);
        const epochs = this.eventEpochs.get(event.sessionId) ?? new Map<number, number>();
        epochs.set(event.seq, epoch);
        this.eventEpochs.set(event.sessionId, epochs);
        // Post-commit fan-out (console-design §5.2): the console sees exactly
        // what the store durably accepted — never an event a read would miss.
        for (const listener of this.changeListeners) {
          try { listener.onAppend?.(event.sessionId, event); } catch { /* a listener failure must never fail the append path */ }
        }
      } catch (cause) {
        throw asStoreError('append', cause, event.sessionId, event.engineId);
      }
    });
  }

  read(sessionId: string, opts?: { fromSeq?: number; toSeq?: number }): AsyncIterable<TranscriptEvent> {
    // Capture the currently known write tail and chain at invocation time. The
    // returned iterable therefore cannot observe appends accepted afterwards.
    const capturedChain = this.appendChains.get(sessionId);
    const capturedEpoch = this.appendEpoch;
    const store = this;
    return (async function* readSnapshot(): AsyncIterable<TranscriptEvent> {
      try {
        await store.ready;
        await capturedChain;
        const db = store.database('read');
        const allSeqs = db.prepare('SELECT seq FROM transcript_events WHERE session_id = ? ORDER BY seq ASC').all(sessionId) as unknown as Array<{ seq: number }>;
        const hasSnapshotSession = allSeqs.some((row) => (store.eventEpochs.get(sessionId)?.get(row.seq) ?? 0) <= capturedEpoch);
        if (!hasSnapshotSession) throw new NotFoundError({ resource: 'transcript', resourceId: sessionId, sessionId });
        const rows = db.prepare('SELECT session_id, seq, ts, engine_id, event_json, byte_len, sha256 FROM transcript_events WHERE session_id = ? AND seq >= ? AND seq <= ? ORDER BY seq ASC').all(
          sessionId,
          opts?.fromSeq ?? 0,
          opts?.toSeq ?? Number.MAX_SAFE_INTEGER,
        ) as unknown as StoredRow[];
        const acceptedRows = rows.filter((row) => (store.eventEpochs.get(sessionId)?.get(row.seq) ?? 0) <= capturedEpoch);
        for (const row of acceptedRows) yield store.decodeRow(row, 'read');
      } catch (cause) {
        throw asStoreError('read', cause, sessionId);
      }
    })();
  }

  async highWatermark(sessionId: string): Promise<number> {
    await this.ready;
    await this.appendChains.get(sessionId);
    const value = this.highWatermarks.get(sessionId);
    if (value === undefined) throw new NotFoundError({ resource: 'transcript', resourceId: sessionId, sessionId });
    return value;
  }

  async sessions(filter?: SessionFilter): Promise<SessionMeta[]> {
    await this.ready;
    try {
      const db = this.database('sessions');
      const ids = (db.prepare('SELECT DISTINCT session_id FROM transcript_events ORDER BY session_id').all() as Array<{ session_id: string }>).map((row) => row.session_id);
      const result: SessionMeta[] = [];
      for (const sessionId of ids) {
        await this.appendChains.get(sessionId);
        const rows = db.prepare('SELECT session_id, seq, ts, engine_id, event_json, byte_len, sha256 FROM transcript_events WHERE session_id = ? ORDER BY seq ASC').all(sessionId) as unknown as StoredRow[];
        const meta = foldSessionMeta(rows.map((row) => this.decodeRow(row, 'sessions')), this.onMalformedMeta);
        if (meta !== undefined && matchesFilter(meta, filter)) result.push(meta);
      }
      return result.sort((a, b) => a.createdAt - b.createdAt);
    } catch (cause) {
      throw asStoreError('sessions', cause);
    }
  }

  /**
   * Realm widened `TranscriptStore.digest` to three overloads, but publishes
   * only the renderers — `buildDigest`, the one thing that produces a
   * `StructuredDigest`, is exported from `@runskein/core/internal`, which
   * design §12 forbids this implementation from importing.
   *
   * Reimplementing segment extraction and bounding here would be a second,
   * silently diverging copy of upstream logic. So the structured form fails
   * closed instead, per ADR 0001: the plugin does not fabricate a capability it
   * cannot honestly provide. Nothing regresses — Realm's resume path calls the
   * single-argument text form (`session/resume.ts`), which is unchanged, and
   * the structured form is reachable only through a Hub API the plugin never
   * calls. It lifts as soon as Realm exports `buildDigest` publicly.
   */
  digest(sessionId: string): Promise<TranscriptDigest>;
  digest(sessionId: string, opts: TextDigestOptions): Promise<TranscriptDigest>;
  digest(sessionId: string, opts: StructuredDigestOptions): Promise<StructuredDigest>;
  digest(sessionId: string, opts: DigestOptions): Promise<DigestResult>;
  async digest(sessionId: string, opts?: DigestOptions): Promise<DigestResult> {
    if (opts?.format === 'structured') {
      throw new StoreError({
        operation: 'digest',
        sessionId,
        cause: new Error('structured digests require buildDigest from @runskein/core/internal, which design §12 forbids this implementation from importing; request the text form'),
      });
    }
    return this.textDigest(sessionId);
  }

  private async textDigest(sessionId: string): Promise<TranscriptDigest> {
    await this.ready;
    await this.appendChains.get(sessionId);
    try {
      const db = this.database('digest');
      const rows = db.prepare('SELECT session_id, seq, ts, engine_id, event_json, byte_len, sha256 FROM transcript_events WHERE session_id = ? ORDER BY seq ASC').all(sessionId) as unknown as StoredRow[];
      if (rows.length === 0) throw new NotFoundError({ resource: 'transcript', resourceId: sessionId, sessionId });
      return digestText(sessionId, rows.map((row) => this.decodeRow(row, 'digest')));
    } catch (cause) {
      throw asStoreError('digest', cause, sessionId);
    }
  }

  async delete(sessionId: string): Promise<void> {
    return this.serialize(sessionId, async () => {
      await this.ready;
      try {
        const db = this.database('delete');
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = db.prepare('DELETE FROM transcript_events WHERE session_id = ?').run(sessionId);
          if (result.changes === 0) throw new NotFoundError({ resource: 'session', resourceId: sessionId, sessionId });
          db.exec('COMMIT');
        } catch (cause) {
          try { db.exec('ROLLBACK'); } catch { /* preserve original failure */ }
          throw cause;
        }
        this.highWatermarks.delete(sessionId);
        this.eventEpochs.delete(sessionId);
        // §5.4: observers must follow a deletion immediately — no cached view
        // may keep serving what was explicitly removed.
        for (const listener of this.changeListeners) {
          try { listener.onDelete?.(sessionId); } catch { /* a listener failure must never fail the delete path */ }
        }
      } catch (cause) {
        throw asStoreError('delete', cause, sessionId);
      }
    });
  }

  /** Stored canonical bytes of one event; the SHA is the one written at append time. */
  async canonicalEvent(sessionId: string, seq: number): Promise<{ bytes: Buffer; sha256: string } | undefined> {
    await this.ready;
    await this.appendChains.get(sessionId);
    try {
      const row = this.database('read').prepare('SELECT session_id, seq, ts, engine_id, event_json, byte_len, sha256 FROM transcript_events WHERE session_id = ? AND seq = ?').get(sessionId, seq) as unknown as StoredRow | undefined;
      if (row === undefined) return undefined;
      this.decodeRow(row, 'read');
      return { bytes: Buffer.from(row.event_json), sha256: row.sha256 };
    } catch (cause) {
      throw asStoreError('read', cause, sessionId);
    }
  }

  /** Instance-scoped control metadata. It is never folded into public session state. */
  async setMeta(key: string, value: string): Promise<void> {
    await this.ready;
    try {
      this.database('append').prepare('INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    } catch (cause) {
      throw asStoreError('append', cause);
    }
  }

  async getMeta(key: string): Promise<string | undefined> {
    await this.ready;
    try {
      const row = this.database('read').prepare('SELECT value FROM store_meta WHERE key = ?').get(key) as { value?: string } | undefined;
      return row?.value;
    } catch (cause) {
      throw asStoreError('read', cause);
    }
  }

  /** Subscribe to post-commit appends/deletes; returns the unsubscribe function. */
  onChange(listener: TranscriptStoreListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  async close(): Promise<void> {
    await this.ready;
    await Promise.allSettled([...this.appendChains.values()]);
    this.db?.close();
    this.db = undefined;
  }

  private decodeRow(row: StoredRow, operation: StoreOperation): TranscriptEvent {
    try {
      const bytes = Buffer.from(row.event_json);
      if (bytes.byteLength !== row.byte_len || createHash('sha256').update(bytes).digest('hex') !== row.sha256) {
        throw new Error(`canonical event bytes failed integrity check at seq ${row.seq}`);
      }
      const event = JSON.parse(bytes.toString('utf8')) as TranscriptEvent;
      if (event.sessionId !== row.session_id || event.seq !== row.seq || event.ts !== row.ts || event.engineId !== row.engine_id) {
        throw new Error(`event envelope does not match indexed columns at seq ${row.seq}`);
      }
      return event;
    } catch (cause) {
      throw asStoreError(operation, cause, row.session_id, row.engine_id);
    }
  }
}

export function createPluginTranscriptStore(databasePath: string, options: { dataRoot?: string; onMalformedMeta?: (report: MalformedMetaReport) => void } = {}): PluginTranscriptStore {
  return new PluginTranscriptStore(databasePath, options);
}
