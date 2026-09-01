import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import { PluginConfigError, type ConsoleConfig } from '../plugin-config.js';
import { ConsoleNotFoundError, type ConsoleDataSource, type ConsoleStreamFrame } from './data-source.js';
import { UI_APP_CSS, UI_APP_JS, UI_FONT_WOFF2_BASE64, UI_INDEX_HTML } from './ui-assets.js';

/**
 * The loopback observation console (console-design §4/§6/§7, ADR 0003). This
 * module is the security shell (§12 step 2): Host validation, the GET-only
 * method check and the security headers. Route handlers call the
 * {@link ConsoleDataSource} read model; `/` and the UI assets serve the
 * embedded self-contained UI (§7.5, step 7) — static strings, no dynamic
 * data, so §7.8 needs nothing extra on them.
 *
 * There is no credential (ADR 0032): whoever can open a TCP connection to
 * `127.0.0.1:<port>` can read this instance's console, and `<instanceDir>/console.json`
 * records `{ port, startedAt }` at mode 0600 because the port it names *is* the
 * access. The `Host` check below is therefore the sole DNS-rebinding defence
 * rather than a second line behind a token (§7.3, §7.4).
 */

/** Bind address is fixed at loopback and deliberately not configurable (§7.2). */
const LOOPBACK = '127.0.0.1';

/** §7.5: the exact CSP every response carries; `Access-Control-Allow-Origin` is never emitted. */
export const CONSOLE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'";

// Error bodies are stable enum-like strings: they carry no instance content,
// which §7.8 requires of every response even with exposeTranscripts: false.
const FORBIDDEN_BODY = '{"error":"forbidden"}';
const METHOD_NOT_ALLOWED_BODY = '{"error":"method_not_allowed"}';
const NOT_FOUND_BODY = '{"error":"not_found"}';
const NOT_IMPLEMENTED_BODY = '{"error":"not_implemented"}';
const INTERNAL_ERROR_BODY = '{"error":"internal_error"}';
const INVALID_ARGUMENT_BODY = '{"error":"invalid_argument"}';
const STREAM_LIMIT_BODY = '{"error":"stream_limit"}';

/** How often an idle SSE connection gets a comment line (dead-client detection). */
const SSE_HEARTBEAT_MS = 30_000;

/** Decoded once at module load; served byte-identical on every request. */
const UI_FONT = Buffer.from(UI_FONT_WOFF2_BASE64, 'base64');

export interface ConsoleServerOptions {
  readonly config: ConsoleConfig;
  readonly instanceDir: string;
  /** The read model; absent only in tests of the bare security shell (501 stubs). */
  readonly dataSource?: ConsoleDataSource;
  /** Test seam; production uses the wall clock, matching instance.json's createdAt. */
  readonly now?: () => string;
}

interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
}

/** A response; a handler that takes the response over (SSE) returns undefined.
 *  `contentType` marks a non-JSON asset body (string or Buffer), sent as-is. */
type RouteResult = { status: number; body: unknown; contentType?: string } | undefined;

interface ConsoleRoute {
  /** Returns extracted path parameters, or undefined when the path does not match. */
  readonly match: (pathname: string) => Record<string, string> | undefined;
  readonly handle: (context: RouteContext) => RouteResult | Promise<RouteResult>;
}

/**
 * A seq in a query string is decimal digits and nothing else.
 *
 * `Number()` alone is not that test: it reads `0x10` as 16, `1e3` as 1000,
 * ` 5 ` as 5 and the empty string as 0 — so `?afterSeq=` silently meant "from
 * the beginning" and `?afterSeq=0x10` silently meant a cursor the caller never
 * wrote. A cursor the server invents from a malformed one is worse than a 400:
 * the client gets a page it did not ask for and cannot tell.
 * @param raw - the query value, or null when the parameter is absent.
 * @returns the parsed seq, or undefined when the text is not a plain seq.
 */
function parseSeqText(raw: string): number | undefined {
  if (!/^\d+$/u.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** An afterSeq cursor: absent → 0; malformed → undefined (the route answers 400). */
function parseSeq(raw: string | null): number | undefined {
  if (raw === null) return 0;
  return parseSeqText(raw);
}

/** An optional seq bound: absent → undefined; malformed → null (the route answers 400). */
function parseOptionalSeq(raw: string | null): number | null | undefined {
  if (raw === null) return undefined;
  return parseSeqText(raw) ?? null;
}

export class ConsoleServer {
  private server: Server | undefined;
  private closePromise: Promise<void> | undefined;
  private boundPort = 0;
  private readonly manifestPath: string;
  private readonly routes: ConsoleRoute[];
  /** Concurrent SSE subscribers; step 5 (§5.2) acquires one slot per stream. */
  private activeStreams = 0;

  constructor(private readonly options: ConsoleServerOptions) {
    this.manifestPath = join(options.instanceDir, 'console.json');
    this.routes = this.buildRoutes();
  }

  /** The bound port; 0 until start() has listened. */
  get port(): number {
    return this.boundPort;
  }

  /** True while the listener is bound — the init path's already-running test (ADR 0019). */
  get running(): boolean {
    return this.server !== undefined;
  }

  get activeStreamCount(): number {
    return this.activeStreams;
  }

  async start(): Promise<void> {
    if (this.server !== undefined) throw new Error('console server already started');
    // Re-arm after a close(): the server once could not be started again because
    // closePromise stayed set forever, but the init path (ADR 0019) starts the
    // console after boot — potentially after a never-started close() — on the
    // same code path as the boot-time start, manifest included.
    this.closePromise = undefined;
    this.boundPort = 0;
    const server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        // Last-resort guard: as content-free as every other error response.
        try {
          this.applySecurityHeaders(res);
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(INTERNAL_ERROR_BODY);
        } catch { /* the socket is already gone */ }
      });
    });
    this.server = server;
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (cause: NodeJS.ErrnoException): void => {
          // §7.2: an explicit port already in use fails start-up with a
          // field-level error; there is no fallback to an ephemeral port.
          rejectListen(cause.code === 'EADDRINUSE'
            ? new PluginConfigError('console.port', `port ${this.options.config.port} is already in use`)
            : cause);
        };
        server.once('error', onError);
        server.listen(this.options.config.port, LOOPBACK, () => {
          server.removeListener('error', onError);
          resolveListen();
        });
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('console server has no TCP address');
      this.boundPort = address.port;
      await this.writeManifest();
      // The manifest is what `console open` discovers, so from this line on the
      // port can be probed under that command's deadline. Get the read model
      // able to answer inside it (ConsoleDataSource.prewarm explains what would
      // otherwise be paid for by the probe itself). Deliberately not awaited:
      // both callers of start() — boot, and a `project_init` that starts the
      // console — are waiting on it, and this work takes seconds. It never
      // rejects, so `void` leaves nothing unhandled.
      void this.options.dataSource?.prewarm();
    } catch (error) {
      await new Promise<void>((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections(); }).catch(() => undefined);
      this.server = undefined;
      throw error;
    }
  }

  /** Stops the listener, drops open connections and removes console.json. Idempotent. */
  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closePromise = (async () => {
      const server = this.server;
      if (server !== undefined) {
        await new Promise<void>((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections(); }).catch(() => undefined);
        this.server = undefined;
      }
      // Best-effort: InstanceManager.close repeats this removal as a backstop.
      await unlink(this.manifestPath).catch(() => undefined);
    })();
    return this.closePromise;
  }

  /** Step 5 (§5.2) caps concurrent SSE subscribers; over the cap the answer is 503. */
  tryAcquireStream(): boolean {
    if (this.activeStreams >= this.options.config.maxConsoleStreams) return false;
    this.activeStreams += 1;
    return true;
  }

  releaseStream(): void {
    this.activeStreams = Math.max(0, this.activeStreams - 1);
  }

  /** Same idiom as core/lifecycle.ts: exclusive no-follow create at mode 0600, then an atomic rename. */
  private async writeManifest(): Promise<void> {
    const now = this.options.now ?? (() => new Date().toISOString());
    // §7.3: the port and when it started, and nothing to authenticate with.
    const manifest = { port: this.boundPort, startedAt: now() };
    const temp = `${this.manifestPath}.tmp-${randomUUID()}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
      await handle.writeFile(JSON.stringify(manifest) + '\n');
      await handle.sync();
      await handle.close();
      handle = undefined;
      const tempInfo = await lstat(temp);
      if (tempInfo.isSymbolicLink() || !tempInfo.isFile() || (tempInfo.mode & 0o777) !== 0o600) throw new Error('unsafe console manifest');
      await rename(temp, this.manifestPath);
      const info = await lstat(this.manifestPath);
      if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600) throw new Error('unsafe console manifest');
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
    }
  }

  /**
   * Request pipeline, in the fixed order of §12 step 2: Host validation
   * (§7.4), the GET-only method check (§6), then routing. There is no
   * authentication step: since ADR 0032 the answer to a request that would
   * once have been unauthenticated is the answer to the request itself.
   */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.applySecurityHeaders(res);
    // 1. DNS-rebinding defence: only the loopback authority may be named.
    const host = req.headers.host ?? '';
    if (host !== `${LOOPBACK}:${this.boundPort}` && host !== `localhost:${this.boundPort}`) {
      this.json(res, 403, FORBIDDEN_BODY);
      return;
    }
    // A `?token=` left over in a bookmark, and a stale `realm_console` cookie,
    // are an unrecognised query and an unread header (§7.3) — neither is an
    // error and neither needs clearing on the browser side.
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}`);
    // 2. The route table contains GET and only GET (§6) — read-only by
    // construction.
    if (req.method !== 'GET') {
      this.json(res, 405, METHOD_NOT_ALLOWED_BODY, { allow: 'GET' });
      return;
    }
    // 3. Route resolution.
    for (const route of this.routes) {
      const params = route.match(url.pathname);
      if (params === undefined) continue;
      try {
        const result = await route.handle({ req, res, url, params });
        if (result !== undefined) {
          if (typeof result.contentType === 'string') {
            res.writeHead(result.status, { 'content-type': result.contentType });
            res.end(result.body as string | Buffer);
          } else {
            this.json(res, result.status, JSON.stringify(result.body));
          }
        }
      } catch (error) {
        this.routeError(res, error);
      }
      return;
    }
    this.json(res, 404, NOT_FOUND_BODY);
  }

  /** Content-free error mapping (§7.8): codes and the §9.4 reference fields only. */
  private routeError(res: ServerResponse, error: unknown): void {
    if (res.headersSent) return;
    if (error instanceof ConsoleNotFoundError) {
      this.json(res, 404, NOT_FOUND_BODY);
      return;
    }
    const code = (error as { code?: unknown }).code;
    if (code === 'NOT_FOUND') {
      this.json(res, 404, NOT_FOUND_BODY);
      return;
    }
    if (code === 'PAYLOAD_TOO_LARGE') {
      // Same oversized-event reference the orchestrator gets (design §9.4):
      // seq/totalBytes/sha256 are a count, an ID and a digest — whitelist-safe.
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      const reference: Record<string, unknown> = { error: 'payload_too_large' };
      for (const field of ['seq', 'responseByteBudget', 'totalBytes', 'sha256']) {
        if (details[field] !== undefined) reference[field] = details[field];
      }
      this.json(res, 413, JSON.stringify(reference));
      return;
    }
    // HTTP 500 is already the operator signal; crossing into the runtime logger would couple the two processes for no new information (ADR 0038)
    this.json(res, 500, INTERNAL_ERROR_BODY);
  }

  private applySecurityHeaders(res: ServerResponse): void {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-security-policy', CONSOLE_CSP);
  }

  private json(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(body);
  }

  /** The route table of §6: GET only, and nothing else exists. */
  private buildRoutes(): ConsoleRoute[] {
    const stub = (): RouteResult => ({ status: 501, body: JSON.parse(NOT_IMPLEMENTED_BODY) as unknown });
    const exact = (path: string): ConsoleRoute['match'] => (pathname) => (pathname === path ? {} : undefined);
    const sessionEvents: ConsoleRoute['match'] = (pathname) => {
      const match = /^\/api\/sessions\/([^/]+)\/events$/.exec(pathname);
      return match === null ? undefined : { id: match[1] as string };
    };
    const sessionDiffs: ConsoleRoute['match'] = (pathname) => {
      const match = /^\/api\/sessions\/([^/]+)\/diffs$/.exec(pathname);
      return match === null ? undefined : { id: match[1] as string };
    };
    const sessionDetail: ConsoleRoute['match'] = (pathname) => {
      const match = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
      return match === null ? undefined : { id: match[1] as string };
    };
    const data = this.options.dataSource;
    if (data === undefined) {
      // Bare security shell (step-2 shape): everything is a stub.
      return [
        { match: exact('/'), handle: stub },
        { match: exact('/api/instance'), handle: stub },
        { match: exact('/api/sessions'), handle: stub },
        { match: sessionEvents, handle: stub },
        { match: sessionDiffs, handle: stub },
        { match: sessionDetail, handle: stub },
        { match: exact('/api/turns'), handle: stub },
        { match: exact('/api/interactions'), handle: stub },
        { match: exact('/api/topology'), handle: stub },
        { match: exact('/api/stream'), handle: stub },
      ];
    }
    return [
      // The UI and its assets (§7.5): static embedded strings, identical for
      // every requester — no dynamic data, so the §7.8 whitelist has nothing
      // to suppress on them.
      { match: exact('/'), handle: () => ({ status: 200, body: UI_INDEX_HTML, contentType: 'text/html; charset=utf-8' }) },
      { match: exact('/app.css'), handle: () => ({ status: 200, body: UI_APP_CSS, contentType: 'text/css; charset=utf-8' }) },
      { match: exact('/app.js'), handle: () => ({ status: 200, body: UI_APP_JS, contentType: 'text/javascript; charset=utf-8' }) },
      { match: exact('/fonts/PTMono-Regular.woff2'), handle: () => ({ status: 200, body: UI_FONT, contentType: 'font/woff2' }) },
      { match: exact('/api/instance'), handle: async () => ({ status: 200, body: await data.instanceInfo() }) },
      { match: exact('/api/sessions'), handle: () => ({ status: 200, body: { sessions: data.listSessions() } }) },
      {
        match: sessionEvents,
        handle: async ({ url, params }) => {
          const afterSeq = parseSeq(url.searchParams.get('afterSeq'));
          const toSeq = parseOptionalSeq(url.searchParams.get('toSeq'));
          const projection = url.searchParams.get('projection') ?? 'raw';
          if (afterSeq === undefined || toSeq === null || (projection !== 'raw' && projection !== 'folded')) {
            return { status: 400, body: JSON.parse(INVALID_ARGUMENT_BODY) as unknown };
          }
          if (projection === 'folded') {
            // §3.2: toSeq belongs to the raw projection (single-event fetch);
            // folded pages continue by event cursor alone.
            if (toSeq !== undefined) return { status: 400, body: JSON.parse(INVALID_ARGUMENT_BODY) as unknown };
            return { status: 200, body: await data.readEventsFolded(params['id'] as string, afterSeq) };
          }
          return { status: 200, body: await data.readEvents(params['id'] as string, afterSeq, toSeq) };
        },
      },
      {
        // console-v2 §3.1: the diff index; content stays on the events routes.
        match: sessionDiffs,
        handle: async ({ url, params }) => {
          const afterSeq = parseSeq(url.searchParams.get('afterSeq'));
          if (afterSeq === undefined) return { status: 400, body: JSON.parse(INVALID_ARGUMENT_BODY) as unknown };
          return { status: 200, body: await data.readDiffs(params['id'] as string, afterSeq) };
        },
      },
      { match: sessionDetail, handle: ({ params }) => ({ status: 200, body: data.getSession(params['id'] as string) }) },
      { match: exact('/api/turns'), handle: () => ({ status: 200, body: { turns: data.listTurns() } }) },
      { match: exact('/api/interactions'), handle: () => ({ status: 200, body: { interactions: data.listInteractions() } }) },
      { match: exact('/api/topology'), handle: () => ({ status: 200, body: data.topology() }) },
      { match: exact('/api/stream'), handle: (context) => this.handleStream(context) },
    ];
  }

  /**
   * SSE (§5.2): the instance summary form carries state transitions only —
   * never transcript events (CONSOLE-020); the session form backfills from the
   * store, then lives off the append fan-out. Both forms count against
   * maxConsoleStreams; over the cap the answer is 503 (CONSOLE-015).
   */
  private async handleStream(context: RouteContext): Promise<RouteResult> {
    const data = this.options.dataSource;
    if (data === undefined) return { status: 501, body: JSON.parse(NOT_IMPLEMENTED_BODY) as unknown };
    const { req, res, url } = context;
    const sessionId = url.searchParams.get('sessionId') ?? undefined;
    let afterSeq = 0;
    // EventSource resume (§5.1): Last-Event-ID is the last frame the client
    // actually received, so on a reconnect it wins over the URL's afterSeq —
    // which stays the *initial* cursor the page opened with (the console UI
    // opens the stream right after its folded backfill, console-v2 §3.2).
    const lastEventId = req.headers['last-event-id'];
    const afterSeqParam = url.searchParams.get('afterSeq');
    if (typeof lastEventId === 'string' && /^\d+$/u.test(lastEventId)) {
      // Same discipline as the URL cursor below: a numeric-but-unsafe id is a
      // 400, not a silently rounded resume point.
      const resume = parseSeqText(lastEventId);
      if (resume === undefined) return { status: 400, body: JSON.parse(INVALID_ARGUMENT_BODY) as unknown };
      afterSeq = resume;
    } else if (afterSeqParam !== null) {
      const cursor = parseSeqText(afterSeqParam);
      if (cursor === undefined) return { status: 400, body: JSON.parse(INVALID_ARGUMENT_BODY) as unknown };
      afterSeq = cursor;
    }
    // Unknown or deleted sessionId: 404, and no connection is established.
    if (sessionId !== undefined && data.streamTarget(sessionId) === undefined) return { status: 404, body: JSON.parse(NOT_FOUND_BODY) as unknown };
    if (!this.tryAcquireStream()) return { status: 503, body: JSON.parse(STREAM_LIMIT_BODY) as unknown };
    let released = false;
    const release = (): void => {
      if (!released) {
        released = true;
        this.releaseStream();
      }
    };
    try {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
      const sink = {
        send: (frame: ConsoleStreamFrame): void => {
          // Only event frames carry an id: it is the resume cursor (the seq),
          // and a transition id would corrupt Last-Event-ID.
          const id = frame.type === 'event' || frame.type === 'event_ref' ? `id: ${frame.seq}\n` : '';
          res.write(`${id}data: ${JSON.stringify(frame)}\n\n`);
        },
        end: (): void => {
          res.end();
        },
      };
      // `openStream` can still fail after the head is committed: the session may
      // be deleted between streamTarget() and here. Nothing may be created
      // before it that would outlive that failure — an interval started first
      // would keep writing to a dead response, and would hold the event loop
      // open past shutdown, which HOST-COMMON-001 asserts against.
      const unsubscribe = await data.openStream({ ...(sessionId === undefined ? {} : { sessionId }), afterSeq, sink });
      // A data source that ended the sink and still returned would leave two
      // owners of this response, and a write after end on a ServerResponse is an
      // *uncaught* ERR_STREAM_WRITE_AFTER_END — it takes the process down rather
      // than failing the request. The contract says openStream throws instead,
      // but the cost of being wrong is too high to rely on it.
      // If the client disconnected while openStream (backfill) was pending,
      // the 'close' event fired with no listener installed. Node sets
      // res.destroyed synchronously when the socket is destroyed, so it is
      // already true when this await resumes, while writableEnded stays false
      // on client disconnect. Catch the missed close here to avoid leaking the
      // slot, heartbeat, and subscription.
      if (res.writableEnded || res.destroyed) {
        unsubscribe();
        release();
        return undefined;
      }
      const heartbeat = setInterval(() => {
        if (res.writableEnded) return;
        res.write(': ping\n\n');
      }, SSE_HEARTBEAT_MS);
      // One cleanup point: the socket closing — by the client, by the server's
      // own end(), or by closeAllConnections() at shutdown.
      res.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        release();
      });
      // An immediate comment tells the client the subscription is live — SSE
      // has no other handshake, and the first frame may be far away.
      res.write(': subscribed\n\n');
    } catch (error) {
      release();
      // The head is already sent, so `routeError` cannot answer and rethrowing
      // would leave the client on a silent open socket. Say why, then close:
      // a session that vanished mid-subscribe is the same fact §5.4 defines.
      if (error instanceof ConsoleNotFoundError && sessionId !== undefined) {
        res.write(`data: ${JSON.stringify({ type: 'invalidated', sessionId })}\n\n`);
        res.end();
        return undefined;
      }
      res.end();
      return undefined;
    }
    return undefined;
  }
}
