import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { ConsoleServer, CONSOLE_CSP } from '../../packages/plugin/src/console/server.js';
import { ConsoleNotFoundError } from '../../packages/plugin/src/console/data-source.js';
import { InstanceManager } from '../../packages/plugin/src/lifecycle.js';
import type { ConsoleConfig } from '../../packages/plugin/src/plugin-config.js';
import type { LogRecord } from '../../packages/plugin/src/logger.js';
import { createTaskShuttleServer, type TaskShuttleServer } from '../../packages/plugin/src/server.js';

interface ConsoleResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function request(port: number, options: { method?: string; path?: string; headers?: Record<string, string> } = {}): Promise<ConsoleResponse> {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path ?? '/', ...(options.headers === undefined ? {} : { headers: options.headers }) },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolveRequest({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', rejectRequest);
    req.end();
  });
}

/** Headers identical for both sides of an indistinguishability check, minus Date. */
function comparableHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const { date: _date, ...rest } = headers;
  return rest;
}

/** A request Node's client cannot express (e.g. HTTP/1.0 without a Host header). */
function rawRequest(port: number, bytes: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(bytes));
    let received = '';
    socket.on('data', (chunk) => { received += chunk.toString('latin1'); });
    socket.on('end', () => {
      const [head, ...rest] = received.split('\r\n\r\n');
      const status = Number(/^HTTP\/\d\.\d (\d+)/.exec(head ?? '')?.[1]);
      resolveRequest({ status, body: rest.join('\r\n\r\n') });
    });
    socket.on('error', rejectRequest);
  });
}

const dirs: string[] = [];
const servers: ConsoleServer[] = [];
const plugins: TaskShuttleServer[] = [];
const logs = new Map<TaskShuttleServer, LogRecord[]>();

async function tempInstanceDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'taskshuttle-console-'));
  dirs.push(dir);
  return dir;
}

function consoleConfig(overrides: Partial<ConsoleConfig> = {}): ConsoleConfig {
  return { enabled: true, port: 0, exposeTranscripts: true, maxConsoleStreams: 8, allowInitStart: true, ...overrides };
}

async function startConsole(config: ConsoleConfig = consoleConfig()): Promise<{ server: ConsoleServer; dir: string }> {
  const dir = await tempInstanceDir();
  const server = new ConsoleServer({ config, instanceDir: dir });
  servers.push(server);
  await server.start();
  return { server, dir };
}

async function startPlugin(dataRoot: string, config: Record<string, unknown> = {}, extraEnv: NodeJS.ProcessEnv = {}): Promise<TaskShuttleServer> {
  const sink: LogRecord[] = [];
  const plugin = createTaskShuttleServer({
    dataRoot,
    hostCwd: tmpdir(),
    env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [tmpdir()], ...config }), ...extraEnv } as NodeJS.ProcessEnv,
    logSink: (record) => { sink.push(record); },
  });
  plugins.push(plugin);
  logs.set(plugin, sink);
  await plugin.runtime.ready;
  return plugin;
}

afterEach(async () => {
  while (plugins.length > 0) await plugins.pop()!.close().catch(() => undefined);
  while (servers.length > 0) await servers.pop()!.close().catch(() => undefined);
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
});

describe('console server security shell', () => {
  // ADR 0032: there is no credential to present, and the whole 401/302/cookie
  // exchange is gone with it. A credential-free request gets the route's own
  // answer — the step-2 stub's 501 here — rather than a challenge.
  it('answers a credential-free request with the route\'s own answer, never a 401', async () => {
    const { server } = await startConsole();
    const bare = await request(server.port, {});
    expect(bare.status).toBe(501);
    expect(bare.headers['set-cookie']).toBeUndefined();
  });

  // §7.3: a bookmarked `/?token=…` and a stale `realm_console` cookie are an
  // unrecognised query and an unread header, so nothing needs clearing on the
  // browser side — and no redirect exists to strip either of them.
  it('ignores a legacy token query and a stale cookie, and redirects neither', async () => {
    const { server } = await startConsole();
    const legacy = `${'f'.repeat(32)}`;
    const query = await request(server.port, { path: `/api/sessions?token=${legacy}&afterSeq=3` });
    const cookie = await request(server.port, { path: '/api/sessions?afterSeq=3', headers: { cookie: `realm_console=${legacy}` } });
    const plain = await request(server.port, { path: '/api/sessions?afterSeq=3' });
    // Pin the answer, not merely the agreement. Equality alone passes against
    // the pre-fix server, which answered all three with the same 401 and no
    // Set-Cookie: what distinguishes the two servers is that this one serves
    // the route (the step-2 stub's 501) without being asked for anything.
    expect(plain.status).toBe(501);
    for (const response of [query, cookie]) {
      expect(response.status).toBe(plain.status);
      expect(response.body).toBe(plain.body);
      expect(comparableHeaders(response.headers)).toEqual(comparableHeaders(plain.headers));
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.headers['location']).toBeUndefined();
    }
  });

  it('rejects a non-loopback Host header with 403', async () => {
    const { server } = await startConsole();
    const denied = await request(server.port, { path: '/', headers: { host: 'attacker.example.com' } });
    expect(denied.status).toBe(403);
    // HTTP/1.1 without Host is rejected by Node itself; an HTTP/1.0 request
    // without one reaches the pipeline and must fail the same check.
    expect((await rawRequest(server.port, 'GET / HTTP/1.0\r\n\r\n')).status).toBe(403);
    // The other accepted loopback authority passes the Host check and is served.
    const localhost = await request(server.port, { headers: { host: `localhost:${server.port}` } });
    expect(localhost.status).toBe(501);
  });

  it('returns 405 for a non-GET method and 404 for an unknown path', async () => {
    const { server } = await startConsole();
    const posted = await request(server.port, { method: 'POST', path: '/api/sessions' });
    expect(posted.status).toBe(405);
    expect(posted.headers['allow']).toBe('GET');
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      expect((await request(server.port, { method, path: '/' })).status).toBe(405);
    }
    expect((await request(server.port, { path: '/api/nope' })).status).toBe(404);
    // The route table's stubs answer 501 (content lands in later steps).
    for (const path of ['/', '/api/instance', '/api/sessions', '/api/sessions/s-1', '/api/sessions/s-1/events?afterSeq=4', '/api/turns', '/api/interactions', '/api/topology', '/api/stream']) {
      expect((await request(server.port, { path })).status).toBe(501);
    }
  });

  it('carries no-store and the exact CSP on every response, and never an ACAO header', async () => {
    const { server } = await startConsole();
    const responses = [
      await request(server.port, {}),
      await request(server.port, { headers: { host: 'nope' } }),
      await request(server.port, { method: 'POST', path: '/' }),
      await request(server.port, { path: '/nope' }),
      await request(server.port, { path: '/' }),
    ];
    for (const res of responses) {
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-security-policy']).toBe(CONSOLE_CSP);
      expect(res.headers['content-security-policy']).toBe("default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'");
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('fails start-up on an explicit port already in use, and accepts an ephemeral port', async () => {
    const blocker = createHttpServer();
    await new Promise<void>((ready) => blocker.listen(0, '127.0.0.1', ready));
    const taken = (blocker.address() as AddressInfo).port;
    try {
      const dir = await tempInstanceDir();
      const server = new ConsoleServer({ config: consoleConfig({ port: taken }), instanceDir: dir });
      servers.push(server);
      await expect(server.start()).rejects.toThrow(/console\.port/);
      // No manifest is left behind by a failed start.
      await expect(stat(join(dir, 'console.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await new Promise<void>((done) => blocker.close(() => done()));
    }

    const { server } = await startConsole();
    expect(server.port).toBeGreaterThan(0);
  });

  it('writes console.json at mode 0600 and removes it on close', async () => {
    const { server, dir } = await startConsole();
    const manifestPath = join(dir, 'console.json');
    expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { port: number; startedAt: string };
    // §7.3: exactly these two keys — a credential must not reappear here.
    expect(manifest).toEqual({ port: server.port, startedAt: manifest.startedAt });
    expect(Object.keys(manifest).sort()).toEqual(['port', 'startedAt']);
    // Same clock format as instance.json's createdAt.
    expect(manifest.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    await server.close();
    await expect(stat(manifestPath)).rejects.toMatchObject({ code: 'ENOENT' });
    // close() is idempotent.
    await server.close();
  });

  it('counts SSE stream slots up to maxConsoleStreams', async () => {
    const { server } = await startConsole(consoleConfig({ maxConsoleStreams: 2 }));
    expect(server.tryAcquireStream()).toBe(true);
    expect(server.tryAcquireStream()).toBe(true);
    expect(server.tryAcquireStream()).toBe(false);
    expect(server.activeStreamCount).toBe(2);
    server.releaseStream();
    expect(server.tryAcquireStream()).toBe(true);
  });

  it('supports the init path: start after boot, and start again after close (ADR 0019)', async () => {
    // Constructed-but-never-started is the init case: the server object exists
    // from boot while the listener only appears when project_init asks for it.
    const dir = await tempInstanceDir();
    const server = new ConsoleServer({ config: consoleConfig(), instanceDir: dir });
    servers.push(server);
    expect(server.running).toBe(false);
    await server.close();
    // A close() before any start must not bar the later start — that was the
    // one-shot closePromise behaviour ADR 0019 removes.
    await server.start();
    expect(server.running).toBe(true);
    const first = { port: server.port };
    expect(first.port).toBeGreaterThan(0);

    // A second start while running is still refused — the init path's
    // already-running test is what prevents a second listener.
    await expect(server.start()).rejects.toThrow(/already started/);

    // After a real close the same object starts again, with a rewritten
    // manifest — one start path, boot and init alike.
    await server.close();
    expect(server.running).toBe(false);
    await server.start();
    expect(server.running).toBe(true);
    const manifest = JSON.parse(await readFile(join(dir, 'console.json'), 'utf8')) as { port: number };
    expect(manifest).toMatchObject({ port: server.port });
  });
});

describe('runtime console wiring', () => {
  it('opens no port when console.enabled is absent or false', async () => {
    for (const config of [{}, { console: { enabled: false } }]) {
      const root = await tempInstanceDir();
      const plugin = await startPlugin(root, config);
      const instanceDir = join(root, 'instances', plugin.runtime.instanceId);
      // §8.2: console.json is the only authoritative record of the port;
      // no file means no listener.
      await expect(stat(join(instanceDir, 'console.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(logs.get(plugin)!.some((record) => record.event === 'console_started')).toBe(false);
    }
  });

  it('skips the console at delegation depth >= 1 while the plugin runs normally', async () => {
    const root = await tempInstanceDir();
    const plugin = await startPlugin(
      root,
      { console: { enabled: true } },
      { REALM_DELEGATION_VERSION: '1', REALM_DELEGATION_DEPTH: '1', REALM_DELEGATION_ROOT: 'a'.repeat(32) },
    );
    // §7.7: a delegated worker opens no port, but its ordinary duties are unaffected.
    const listed = await plugin.invoke('session_list', {});
    expect(listed.ok).toBe(true);
    await expect(stat(join(root, 'instances', plugin.runtime.instanceId, 'console.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(logs.get(plugin)!.some((record) => record.event === 'console_started')).toBe(false);
  });

  it('fails start-up when the configured console port is already in use', async () => {
    const blocker = createHttpServer();
    await new Promise<void>((ready) => blocker.listen(0, '127.0.0.1', ready));
    const taken = (blocker.address() as AddressInfo).port;
    try {
      const root = await tempInstanceDir();
      const plugin = createTaskShuttleServer({
        dataRoot: root,
        env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [tmpdir()], console: { enabled: true, port: taken } }) } as NodeJS.ProcessEnv,
    hostCwd: tmpdir(),
        logSink: () => undefined,
      });
      plugins.push(plugin);
      logs.set(plugin, []);
      await expect(plugin.runtime.ready).rejects.toThrow(/console\.port/);
    } finally {
      await new Promise<void>((done) => blocker.close(() => done()));
    }
  });

  it('writes console.json in the instance dir and serves the UI without a credential', async () => {
    const root = await tempInstanceDir();
    const plugin = await startPlugin(root, { console: { enabled: true } });
    const manifestPath = join(root, 'instances', plugin.runtime.instanceId, 'console.json');
    expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { port: number; startedAt: string };
    expect(Object.keys(manifest).sort()).toEqual(['port', 'startedAt']);

    const allowed = await request(manifest.port, {});
    // Step 7: `/` serves the embedded UI; it is static, so the wiring test only
    // proves the route is live and non-JSON.
    expect(allowed.status).toBe(200);
    expect(allowed.headers['content-type']).toBe('text/html; charset=utf-8');

    // §4: the start line carries the port only.
    const records = logs.get(plugin)!;
    const started = records.find((record) => record.event === 'console_started');
    expect(started).toMatchObject({ port: manifest.port, operation: 'console/start' });

    await plugin.close();
    await expect(stat(manifestPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('deletes a stale console.json only for instances whose lock is proven dead', async () => {
    const root = await tempInstanceDir();
    const dead = await InstanceManager.create({ dataRoot: root, instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', rootNonce: '9'.repeat(32), pid: 999_996, processStartedAt: 'old', exePath: '/old' });
    const staleManifest = join(dead.instanceDir, 'console.json');
    await writeFile(staleManifest, '{"port":1,"token":"stale","startedAt":"2020-01-01T00:00:00.000Z"}\n', { mode: 0o600 });
    // A live peer's console.json is identity-uncertain territory: never touched.
    const alive = await InstanceManager.create({ dataRoot: root, instanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', rootNonce: '8'.repeat(32) });
    const liveManifest = join(alive.instanceDir, 'console.json');
    await writeFile(liveManifest, '{"port":2,"token":"live","startedAt":"2020-01-01T00:00:00.000Z"}\n', { mode: 0o600 });

    const plugin = await startPlugin(root, { retentionDays: 30 });
    await plugin.runtime.startupDiagnostics();
    await expect(stat(staleManifest)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(liveManifest)).isFile()).toBe(true);
    await alive.close();
  });

  it('removes console.json on normal instance close when the ConsoleServer did not', async () => {
    const root = await tempInstanceDir();
    const manager = await InstanceManager.create({ dataRoot: root, instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', rootNonce: '7'.repeat(32) });
    const manifestPath = join(manager.instanceDir, 'console.json');
    await writeFile(manifestPath, '{"port":3,"token":"leftover","startedAt":"2020-01-01T00:00:00.000Z"}\n', { mode: 0o600 });
    await manager.close();
    await expect(stat(manifestPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('console server request-order guarantees', () => {
  // The GET-only route table is the only structural guarantee of read-only
  // (§5.2/§6), and since ADR 0032 nothing precedes it that could answer first.
  it('answers a non-GET with 405, legacy token query or not', async () => {
    const { server } = await startConsole();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await request(server.port, { method, path: `/api/sessions?token=${'f'.repeat(32)}` });
      expect(response.status, method).toBe(405);
      expect(response.headers['set-cookie'], method).toBeUndefined();
    }
  });

  it('answers a GET carrying a legacy token query normally, with no redirect', async () => {
    const { server } = await startConsole();
    const response = await request(server.port, { path: `/api/sessions?token=${'f'.repeat(32)}` });
    expect(response.status).toBe(501);
    expect(response.headers['location']).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});

describe('console SSE failure after the head is committed', () => {
  /**
   * A session can be deleted between streamTarget() and openStream(), so
   * openStream throws with SSE headers already sent. Nothing fallible may have
   * created a timer before that point: an interval writing to a dead response
   * would hold the event loop open past shutdown, which HOST-COMMON-001
   * asserts against.
   */
  function racingDataSource(): { dataSource: unknown; opened: number } {
    const state = { opened: 0 };
    const dataSource = {
      instanceInfo: async () => ({}),
      listSessions: () => [],
      getSession: () => ({}),
      listTurns: () => [],
      listInteractions: () => [],
      topology: () => ({ nodes: [], edges: [] }),
      readEvents: async () => ({ events: [], nextSeq: 0, highWatermark: 0, hasMore: false }),
      // start() warms the read model; a stub that omits this is not a read
      // model and the server throws before the case gets to its own subject.
      prewarm: async () => undefined,
      // The pre-check passes; the subscribe then loses the race.
      streamTarget: () => 'taskshuttle-session',
      openStream: async () => { state.opened += 1; throw new ConsoleNotFoundError(); },
    };
    return { dataSource, opened: state.opened };
  }

  it('closes the stream with an invalidated frame instead of hanging, and leaks no timer', async () => {
    const dir = await tempInstanceDir();
    const { dataSource } = racingDataSource();
    const server = new ConsoleServer({ config: consoleConfig(), instanceDir: dir, dataSource: dataSource as never });
    servers.push(server);
    await server.start();

    const response = await request(server.port, { path: '/api/stream?sessionId=s-1' });
    // The request completes rather than hanging, and says why.
    expect(response.body).toContain('"type":"invalidated"');
    // The slot is returned, so the cap is not permanently consumed.
    expect(server.activeStreamCount).toBe(0);
  });
});

describe('console SSE backfill failure', () => {
  /**
   * A store read can fail mid-backfill — `store_error` is an expected event
   * class (design §15). The response head is already on the wire by then, so
   * the only question is who ends it. Two owners is the dangerous answer: a
   * write after end on a ServerResponse raises an *uncaught*
   * ERR_STREAM_WRITE_AFTER_END, which takes the process down.
   */
  it('ends the stream once, without a second writer', async () => {
    const dir = await tempInstanceDir();
    const dataSource = {
      instanceInfo: async () => ({}),
      listSessions: () => [],
      getSession: () => ({}),
      listTurns: () => [],
      listInteractions: () => [],
      topology: () => ({ nodes: [], edges: [] }),
      readEvents: async () => ({ events: [], nextSeq: 0, highWatermark: 0, hasMore: false }),
      // As above: start() warms the read model, so the stub must offer it.
      prewarm: async () => undefined,
      streamTarget: () => ({ realmSessionId: 'taskshuttle-1' }),
      // Reproduces the shape the data source used to have: a store failure
      // during backfill ended the sink and then reported success, so the
      // caller wrote to a response that was already closed.
      openStream: async (options: { sink: { end: () => void } }) => {
        options.sink.end();
        return () => undefined;
      },
    };
    const server = new ConsoleServer({ config: consoleConfig(), instanceDir: dir, dataSource: dataSource as never });
    servers.push(server);
    await server.start();

    const uncaught: Error[] = [];
    const onUncaught = (error: Error): void => { uncaught.push(error); };
    process.on('uncaughtException', onUncaught);
    try {
      const response = await request(server.port, { path: '/api/stream?sessionId=s-1' });
      expect(response.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    expect(uncaught.map((error) => (error as NodeJS.ErrnoException).code)).toEqual([]);
    expect(server.activeStreamCount).toBe(0);
  });
});

describe('console SSE client disconnect during backfill', () => {
  it('releases the slot and subscription when the client disconnects while openStream is pending', async () => {
    const dir = await tempInstanceDir();
    let unsubscribed = false;
    let resolveOpen!: (unsub: () => void) => void;
    const openDeferred = new Promise<() => void>((resolve) => { resolveOpen = resolve; });
    const dataSource = {
      instanceInfo: async () => ({}),
      listSessions: () => [],
      getSession: () => ({}),
      listTurns: () => [],
      listInteractions: () => [],
      topology: () => ({ nodes: [], edges: [] }),
      readEvents: async () => ({ events: [], nextSeq: 0, highWatermark: 0, hasMore: false }),
      prewarm: async () => undefined,
      streamTarget: () => ({ realmSessionId: 'taskshuttle-1' }),
      openStream: () => openDeferred,
    };
    const server = new ConsoleServer({ config: consoleConfig(), instanceDir: dir, dataSource: dataSource as never });
    servers.push(server);
    await server.start();

    // Start SSE request and destroy client socket while openStream is still pending.
    const req = httpRequest({ host: '127.0.0.1', port: server.port, method: 'GET', path: '/api/stream' });
    req.on('error', () => undefined);
    req.end();
    // Let the server accept and enter openStream await.
    await new Promise((r) => setTimeout(r, 50));
    expect(server.activeStreamCount).toBe(1);
    req.destroy();

    // Give the server's 'close' (or lack thereof) time to propagate.
    await new Promise((r) => setTimeout(r, 50));

    // Resolve backfill now — the server should detect the dead socket and clean up.
    resolveOpen(() => { unsubscribed = true; });

    // Poll for cleanup (unsubscribe + release).
    for (let i = 0; i < 20; i++) {
      if (server.activeStreamCount === 0 && unsubscribed) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(unsubscribed).toBe(true);
    expect(server.activeStreamCount).toBe(0);

    // Heartbeat interval must not survive: destroyed interval holds event loop open.
    // If leaked, the slot would also still be held, already asserted above.
    // Verify a new stream can be acquired (slot not leaked).
    expect(server.tryAcquireStream()).toBe(true);
    server.releaseStream();
  });
});

