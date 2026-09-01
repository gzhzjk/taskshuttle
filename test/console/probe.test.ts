import { createServer, type Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runConsoleOpen } from '../../packages/plugin/src/console/open.js';
import { InstanceManager } from '../../packages/plugin/src/lifecycle.js';

/**
 * CONSOLE-044 — `console open`'s identity probe (console-design §8.2, ADR 0032).
 *
 * A unit case rather than a live one, and it drives the *production* probe
 * against real loopback fixtures: the `probe` seam on `ConsoleOpenOptions`
 * would test the caller and never the parsing, which is where every refuse
 * condition lives. Only the opener is stubbed, so "launches no browser" is
 * observable without a browser ever being at risk.
 */

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'taskshuttle-probe-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
  return dir;
}

/**
 * A live instance whose console.json points at `port`, in the **2.0.0** shape:
 * `{ port, startedAt }` and no credential. That is deliberate — a manifest
 * reader that still requires a `token` never reaches the probe at all, and
 * every refusal fixture below would then pass without the probe having been
 * issued once. The `observed` assertions are what catch that.
 */
async function instanceAt(dataRoot: string, instanceId: string, port: number): Promise<void> {
  const manager = await InstanceManager.create({ dataRoot, instanceId, rootNonce: 'a'.repeat(32), pid: process.pid });
  // Registered before the write, not after: a throw here would otherwise leave
  // the lock handle open while the temp root is removed underneath it.
  cleanups.push(async () => { await manager.close(); });
  await writeFile(join(manager.instanceDir, 'console.json'), JSON.stringify({ port, startedAt: '2026-01-01T00:00:00.000Z' }) + '\n', { mode: 0o600 });
}

interface Fixture {
  readonly port: number;
  /**
   * Every request the probe actually made, so a case can assert it was made —
   * and when it arrived, so a case can time the probe rather than the command.
   * `runConsoleOpen` scans the data root before it probes, and a stopwatch
   * around the whole call measures that scan too: it cannot then tell a
   * deadline from a slow filesystem.
   */
  readonly seen: Array<{ path: string; host: string; method: string; credentials: string[]; at: number }>;
}

/** A loopback listener answering however the fixture says, recording what it is asked. */
async function listener(handler: (path: string) => { status: number; headers?: Record<string, string>; body?: string } | 'hang'): Promise<Fixture> {
  const seen: Fixture['seen'] = [];
  const server: Server = createServer((req, res) => {
    seen.push({
      path: req.url ?? '/',
      host: String(req.headers.host ?? ''),
      method: req.method ?? 'GET',
      credentials: ['cookie', 'authorization', 'proxy-authorization'].filter((name) => req.headers[name] !== undefined),
      at: performance.now(),
    });
    const answer = handler(req.url ?? '/');
    if (answer === 'hang') return; // never responds: exercises the deadline
    res.writeHead(answer.status, { 'content-type': 'application/json; charset=utf-8', ...answer.headers });
    res.end(answer.body ?? '');
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  cleanups.push(async () => { await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { port: address.port, seen };
}

/** Runs `console open` against a fixture, with the opener stubbed and recorded. */
async function open(dataRoot: string, instanceId: string): Promise<{ kind: string; exitCode: number; opened: string[]; out: string[] }> {
  const opened: string[] = [];
  const out: string[] = [];
  const result = await runConsoleOpen({
    dataRoot,
    instance: instanceId,
    opener: async (url) => { opened.push(url); },
    out: (line) => out.push(line),
  });
  return { kind: result.kind, exitCode: result.exitCode, opened, out };
}

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/**
 * §8.2 fixes the shape of a refusal, and it is the same shape for every
 * condition: exit 1 and exactly one line naming the instance and the port it
 * declined. A case that asserts only `not-listening` would pass a refusal that
 * says nothing, which fails the operator exactly as GZH-44's silent 401 did.
 */
function expectRefusalShape(result: { exitCode: number; opened: string[]; out: string[] }, instanceId: string, port: number): void {
  expect(result.exitCode).toBe(1);
  expect(result.opened).toEqual([]);
  expect(result.out).toHaveLength(1);
  expect(result.out[0]).toContain(instanceId);
  expect(result.out[0]).toContain(String(port));
}

const ok = (body: unknown, headers?: Record<string, string>) => () => ({ status: 200, body: JSON.stringify(body), ...(headers === undefined ? {} : { headers }) });

describe('CONSOLE-044: the identity probe', () => {
  it('opens when /api/instance reports this candidate instanceId', async () => {
    const dataRoot = await tempRoot();
    const fixture = await listener(ok({ instanceId: ID, createdAt: 'x', host: 'darwin', alive: true }));
    await instanceAt(dataRoot, ID, fixture.port);
    const result = await open(dataRoot, ID);
    expect(result.kind).toBe('opened');
    expect(result.opened).toEqual([`http://127.0.0.1:${fixture.port}/`]);
  });

  // §8.2 fixes what is asked and where. A probe that fetches `/`, dials
  // `localhost`, or presents a credential would satisfy a fixture that ignores
  // its request — so the fixture does not ignore it.
  it('asks GET /api/instance at the literal loopback authority, with no credentials', async () => {
    const dataRoot = await tempRoot();
    const fixture = await listener(ok({ instanceId: ID }));
    await instanceAt(dataRoot, ID, fixture.port);
    await open(dataRoot, ID);
    expect(fixture.seen).not.toHaveLength(0);
    for (const request of fixture.seen) {
      expect(request.path).toBe('/api/instance');
      expect(request.method).toBe('GET');
      expect(request.host).toBe(`127.0.0.1:${fixture.port}`);
      expect(request.credentials).toEqual([]);
    }
  });

  it('tolerates unknown fields, since this route gains them over time', async () => {
    const dataRoot = await tempRoot();
    const fixture = await listener(ok({ instanceId: ID, somethingAddedLater: { nested: true } }));
    await instanceAt(dataRoot, ID, fixture.port);
    expect((await open(dataRoot, ID)).kind).toBe('opened');
  });

  it('accepts the media type case-insensitively and ignores its parameters', async () => {
    const dataRoot = await tempRoot();
    const fixture = await listener(ok({ instanceId: ID }, { 'content-type': 'APPLICATION/JSON; charset=UTF-8' }));
    await instanceAt(dataRoot, ID, fixture.port);
    expect((await open(dataRoot, ID)).kind).toBe('opened');
  });

  // The case the old 401-plus-CSP fingerprint could not see at all: a console
  // that is genuinely ours, and genuinely the wrong one.
  it('refuses a different instanceId, and launches no browser', async () => {
    const dataRoot = await tempRoot();
    const fixture = await listener(ok({ instanceId: OTHER, createdAt: 'x' }));
    await instanceAt(dataRoot, ID, fixture.port);
    const result = await open(dataRoot, ID);
    expect(result.kind).toBe('not-listening');
    expect(fixture.seen).not.toHaveLength(0);
    expectRefusalShape(result, ID, fixture.port);
  });

  it.each([
    ['a not-yet-upgraded instance answering 401', () => ({ status: 401, body: '{"error":"unauthorized"}' })],
    ['the bare security shell answering 501', () => ({ status: 501, body: '{"error":"not_implemented"}' })],
    ['malformed JSON', () => ({ status: 200, body: '{not json' })],
    ['a JSON array rather than an object', () => ({ status: 200, body: `[{"instanceId":"${ID}"}]` })],
    ['a JSON null', () => ({ status: 200, body: 'null' })],
    ['a non-string instanceId', () => ({ status: 200, body: JSON.stringify({ instanceId: 123 }) })],
    ['a missing instanceId', () => ({ status: 200, body: JSON.stringify({ createdAt: 'x' }) })],
    ['a wrong media type', () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: JSON.stringify({ instanceId: ID }) })],
    ['a redirect', () => ({ status: 302, headers: { location: '/elsewhere' }, body: '' })],
    ['a body past the 65536-octet cap', () => ({ status: 200, body: JSON.stringify({ instanceId: ID, pad: 'x'.repeat(70_000) }) })],
    // Octets, not characters: 'あ' is three bytes in UTF-8, so 30k of them
    // exceed the cap while a length-based check sees only 30k.
    ['a body past the cap in octets but not in characters', () => ({ status: 200, body: JSON.stringify({ instanceId: ID, pad: 'あ'.repeat(30_000) }) })],
    ['a content-length declaring more than the cap', () => ({ status: 200, headers: { 'content-length': '99999' }, body: JSON.stringify({ instanceId: ID }) })],
  ])('refuses %s', async (_label, answer) => {
    const dataRoot = await tempRoot();
    const fixture = await listener(answer as () => { status: number; headers?: Record<string, string>; body?: string });
    await instanceAt(dataRoot, ID, fixture.port);
    const result = await open(dataRoot, ID);
    expect(result.kind).toBe('not-listening');
    expect(result.exitCode).toBe(1);
    expect(result.opened).toEqual([]);
    // Every refusal is reported, not only the wrong-instanceId one: a
    // correct-but-mute refusal fails the operator exactly as GZH-44 did.
    expect(result.out).toHaveLength(1);
    expect(result.out[0]).toContain(ID);
    expect(result.out[0]).toContain(String(fixture.port));
    // Without this the case passes when the probe was never issued — which is
    // exactly what a manifest reader that rejects the 2.0.0 shape produces.
    expect(fixture.seen.filter((request) => request.path === '/api/instance')).not.toHaveLength(0);
  });

  it('does not follow the redirect it refuses', async () => {
    const dataRoot = await tempRoot();
    const fixture = await listener(() => ({ status: 302, headers: { location: '/elsewhere' }, body: '' }));
    await instanceAt(dataRoot, ID, fixture.port);
    const result = await open(dataRoot, ID);
    expect(fixture.seen.map((request) => request.path)).toEqual(['/api/instance']);
    // Not following it is half the rule; refusing is the other half. Without
    // this the case passes against a probe that follows the redirect, likes
    // what it finds and opens a browser, as long as the second request
    // happens to go somewhere this fixture does not see.
    expect(result.kind).toBe('not-listening');
    expectRefusalShape(result, ID, fixture.port);
  });

  it('refuses when nothing is listening on the recorded port', async () => {
    const dataRoot = await tempRoot();
    const fixture = await listener(ok({ instanceId: ID }));
    await instanceAt(dataRoot, ID, fixture.port);
    // Close the fixture before probing: the port is now dead.
    await cleanups.splice(cleanups.length - 2, 1)[0]!();
    const result = await open(dataRoot, ID);
    expect(result.kind).toBe('not-listening');
    expectRefusalShape(result, ID, fixture.port);
  });

  it('refuses on the absolute deadline rather than hanging on a silent peer', async () => {
    const dataRoot = await tempRoot();
    const fixture = await listener(() => 'hang');
    await instanceAt(dataRoot, ID, fixture.port);
    const result = await open(dataRoot, ID);
    const finished = performance.now();
    expect(result.kind).toBe('not-listening');
    expect(fixture.seen).not.toHaveLength(0);
    // Timed from the moment the request reached the fixture, not from the
    // start of the command: the discovery scan runs before the probe, and a
    // stopwatch that includes it cannot tell a 1000 ms deadline from a slow
    // filesystem. What is left in this window is the deadline and nothing else.
    const waited = finished - fixture.seen[0]!.at;
    // Both sides earn their place. The lower bound is what proves the refusal
    // came from the deadline rather than from some other condition firing
    // early; the upper catches a timeout set to a larger wrong value — a
    // four-second one fails it — while leaving room for ordinary jitter. The
    // clock is monotonic, so a wall-clock adjustment cannot move either. What
    // no bound survives is the process being suspended for longer than the
    // headroom: the residual cost of asserting a deadline at all, accepted
    // here rather than hidden behind a bound so wide it tests nothing.
    expect(waited).toBeGreaterThanOrEqual(900);
    expect(waited).toBeLessThan(2_000);
    expectRefusalShape(result, ID, fixture.port);
  });

  // The deadline is absolute, covering connect, headers AND body. A
  // socket-inactivity timeout — which is what Node's `timeout` option gives,
  // and what the old probe used — never fires against a peer that keeps
  // dripping, so it would hang here forever.
  it('refuses a slow-drip body on the same deadline', async () => {
    const dataRoot = await tempRoot();
    const timers: NodeJS.Timeout[] = [];
    const seen: Array<{ path: string; at: number }> = [];
    const server: Server = createServer((req, res) => {
      seen.push({ path: req.url ?? '/', at: performance.now() });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.write('{"instanceId":"');
      // A byte every 100 ms: always active, never finished.
      const timer = setInterval(() => res.write('x'), 100);
      timers.push(timer);
      res.on('close', () => clearInterval(timer));
    });
    await new Promise<void>((ready, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', ready);
    });
    cleanups.push(async () => {
      for (const timer of timers) clearInterval(timer);
      await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    await instanceAt(dataRoot, ID, address.port);
    const result = await open(dataRoot, ID);
    const finished = performance.now();
    expect(result.kind).toBe('not-listening');
    // Without this the case passes when the probe was never issued, and a
    // deadline that is never reached looks exactly like one that works.
    expect(seen.map((request) => request.path)).toContain('/api/instance');
    // Timed from the request's arrival, and bounded on both sides, for the
    // same reasons as the silent-peer case above.
    const waited = finished - seen[0]!.at;
    expect(waited).toBeGreaterThanOrEqual(900);
    expect(waited).toBeLessThan(2_000);
    expectRefusalShape(result, ID, address.port);
  });

  // §8.2 says an over-declared content-length refuses BEFORE the body is read.
  // This case asserts the half of that which is observable, and its name says
  // which half rather than borrowing the rule's wording.
  //
  // It CAN see the difference between refusing on the declared length and not
  // having the check at all: without it the same fixture still refuses, but
  // only at the deadline, so a case asserting `not-listening` alone passes
  // against an implementation that never looks at `content-length`.
  // It CANNOT separate "refuses at the headers" from "consumes the first chunk
  // and then refuses on the declared length" — both return at once, and across
  // a loopback socket the first chunk is in the receive buffer either way, so
  // no observation on the fixture side distinguishes them. That finer ordering
  // is unasserted here and is recorded as unasserted in console-design §8.2.
  //
  // The bound is therefore a DIFFERENCE between two windows measured in the
  // same run, each starting when its own request reached its fixture. Neither
  // window contains the discovery scan, so what separates them is the deadline
  // the pre-check skipped and nothing else. A ratio would not do: it does not
  // cancel a shared overhead, so on a slow machine a correct pre-check fails
  // it while still refusing the moment the headers arrive.
  it('refuses on an over-declared content-length rather than reading to the deadline', async () => {
    const deadlineRoot = await tempRoot();
    const silent = await listener(() => 'hang');
    await instanceAt(deadlineRoot, ID, silent.port);
    expect((await open(deadlineRoot, ID)).kind).toBe('not-listening');
    // The deadline as this machine actually served it, measured from the
    // request's arrival so the discovery scan is outside the window.
    const deadlineWaited = performance.now() - silent.seen[0]!.at;
    // And bounded, because the comparison below uses it as the yardstick: a
    // baseline inflated by a stall would leave room for an implementation with
    // no pre-check at all to satisfy the difference. An anomalous baseline
    // must fail this case, not quietly weaken it.
    expect(deadlineWaited).toBeGreaterThanOrEqual(900);
    expect(deadlineWaited).toBeLessThan(2_000);

    const dataRoot = await tempRoot();
    const seen: Array<{ path: string; at: number }> = [];
    // Declares far more than the cap and then sends nothing. A reader that
    // consumes first has no way to finish and waits out the deadline.
    const server: Server = createServer((req, res) => {
      seen.push({ path: req.url ?? '/', at: performance.now() });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': '99999' });
      res.write('{');
    });
    await new Promise<void>((ready, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', ready);
    });
    cleanups.push(async () => { await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }); });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    await instanceAt(dataRoot, ID, address.port);
    const result = await open(dataRoot, ID);
    const finished = performance.now();
    expect(result.kind).toBe('not-listening');
    expect(seen.map((request) => request.path)).toContain('/api/instance');
    // Both windows start at their own request's arrival, so neither carries
    // the discovery scan and the difference is the deadline the pre-check
    // skipped. Half of it leaves room for jitter while a missing pre-check —
    // which skips nothing — fails.
    const waited = finished - seen[0]!.at;
    expect(deadlineWaited - waited).toBeGreaterThan(500);
    expectRefusalShape(result, ID, address.port);
  });

  // The other half of the cap: a body comfortably under it must be ACCEPTED.
  // Without this, a mistaken 1 KiB cap refuses every oversized fixture above
  // and passes, while rejecting real consoles.
  it('accepts a large body that stays under the cap', async () => {
    const dataRoot = await tempRoot();
    const fixture = await listener(ok({ instanceId: ID, pad: 'x'.repeat(60_000) }));
    await instanceAt(dataRoot, ID, fixture.port);
    expect((await open(dataRoot, ID)).kind).toBe('opened');
  });

  // A response that dies mid-body is neither a status nor a clean parse.
  it('refuses a response that closes mid-body', async () => {
    const dataRoot = await tempRoot();
    const seen: string[] = [];
    const server: Server = createServer((req, res) => {
      seen.push(req.url ?? '/');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': '400' });
      res.write('{"instanceId":"');
      res.destroy();
    });
    await new Promise<void>((ready, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ready); });
    cleanups.push(async () => { await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }); });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    await instanceAt(dataRoot, ID, address.port);
    const result = await open(dataRoot, ID);
    expect(result.kind).toBe('not-listening');
    expect(seen).toContain('/api/instance');
    expectRefusalShape(result, ID, address.port);
  });

  // A refusal that says nothing fails the operator exactly as GZH-44's silent
  // 401 did, so the reported line is part of the contract, not decoration.
  it('reports every refusal in exactly one line naming instance and port', async () => {
    const dataRoot = await tempRoot();
    const fixture = await listener(ok({ instanceId: OTHER }));
    await instanceAt(dataRoot, ID, fixture.port);
    const result = await open(dataRoot, ID);
    expect(result.out).toHaveLength(1);
    expect(result.out[0]).toContain(ID);
    expect(result.out[0]).toContain(String(fixture.port));
  });
});
