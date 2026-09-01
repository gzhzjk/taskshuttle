import { mkdtemp, readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ConsoleStreamFrame } from '../../packages/plugin/src/console/data-source.js';
import { createTaskShuttleServer, type TaskShuttleServer } from '../../packages/plugin/src/server.js';
import { simulatedHubFactory } from '../../packages/plugin/src/testkit/simulated-engines.js';

const open: TaskShuttleServer[] = [];

async function startPlugin(dataRoot: string): Promise<TaskShuttleServer> {
  const plugin = createTaskShuttleServer({
    dataRoot,
    env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [tmpdir()], console: { enabled: true } }), REALM_PLUGIN_LOG: 'off' } as NodeJS.ProcessEnv,
    hostCwd: tmpdir(),
    hubFactory: simulatedHubFactory(),
  });
  open.push(plugin);
  await plugin.runtime.ready;
  return plugin;
}

async function consoleManifest(plugin: TaskShuttleServer, dataRoot: string): Promise<{ port: number }> {
  const raw = JSON.parse(await readFile(join(dataRoot, 'instances', plugin.runtime.instanceId, 'console.json'), 'utf8')) as { port: number };
  return { port: raw.port };
}

function httpBody(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolveRequest({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', rejectRequest);
    req.end();
  });
}

interface SseClient {
  readonly frames: Array<{ id?: string; data: ConsoleStreamFrame & Record<string, unknown> }>;
  readonly ready: Promise<void>;
  readonly ended: Promise<void>;
  close(): void;
}

function openSse(port: number, path: string, headers: Record<string, string>): SseClient {
  const frames: SseClient['frames'] = [];
  let buffered = '';
  let endResolve: () => void = () => undefined;
  let readyResolve: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => { endResolve = resolve; });
  const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
  const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
    res.on('data', (chunk: Buffer) => {
      readyResolve();
      buffered += chunk.toString('utf8');
      const blocks = buffered.split('\n\n');
      buffered = blocks.pop() ?? '';
      for (const block of blocks) {
        let id: string | undefined;
        let data: string | undefined;
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) id = line.slice(4);
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (data !== undefined) frames.push({ ...(id === undefined ? {} : { id }), data: JSON.parse(data) as ConsoleStreamFrame & Record<string, unknown> });
      }
    });
    res.on('end', () => endResolve());
    res.on('close', () => endResolve());
  });
  req.on('error', () => endResolve());
  req.end();
  return { frames, ready, ended, close: () => req.destroy() };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function settledTurn(plugin: TaskShuttleServer, turnId: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const result = await plugin.invoke('turn_get', { turnId });
    if (result.ok && ['completed', 'failed', 'cancelled'].includes(result.output.state)) return;
    if (Date.now() > deadline) throw new Error('turn never settled');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close().catch(() => undefined);
});

describe('console against a live runtime (simulated engines)', () => {
  it('streams a real turn, matches transcript_read pages, and invalidates on delete', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-console-e2e-'));
    const plugin = await startPlugin(dataRoot);
    const { port } = await consoleManifest(plugin, dataRoot);
    // No credential since ADR 0032; the seam stays so a case can add a header.
    const headers = {};
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-console-cwd-'));

    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.output.sessionId;
    const started = await plugin.invoke('turn_start', { sessionId, prompt: [{ type: 'text', text: 'say hello' }] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await settledTurn(plugin, started.output.turnId);

    // The events endpoint and transcript_read are the same pagination core (§5.1).
    const read = await plugin.invoke('transcript_read', { sessionId, afterSeq: 0, limit: 200 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.output.events.length).toBeGreaterThan(0);
    const viaHttp = await httpBody(port, `/api/sessions/${sessionId}/events?afterSeq=0`, headers);
    expect(viaHttp.status).toBe(200);
    const page = JSON.parse(viaHttp.body) as { events: unknown[]; highWatermark: number };
    // Same events; the console caps page size, so compare the shared prefix.
    expect(page.highWatermark).toBe(read.output.highWatermark);
    expect(page.events.length).toBe(Math.min(read.output.events.length, 100));

    // The session stream backfills what the turn already produced.
    const sessionStream = openSse(port, `/api/stream?sessionId=${sessionId}`, headers);
    await waitFor(() => sessionStream.frames.filter((frame) => frame.data['type'] === 'event').length >= page.events.length);

    // The instance summary stream carries the composed observer's transitions
    // — through the same registry slot the logger owns — and no events.
    const instanceStream = openSse(port, '/api/stream', headers);
    await instanceStream.ready;
    const second = await plugin.invoke('turn_start', { sessionId, prompt: [{ type: 'text', text: 'again' }] });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await settledTurn(plugin, second.output.turnId);
    await waitFor(() => instanceStream.frames.some((frame) => frame.data['type'] === 'transition' && frame.data['turnId'] === second.output.turnId && frame.data['to'] === 'completed'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(instanceStream.frames.every((frame) => frame.data['type'] !== 'event')).toBe(true);
    instanceStream.close();

    // §5.4 / CONSOLE-013: delete invalidates subscribers, then the route 404s.
    const closed = await plugin.invoke('session_close', { sessionId });
    expect(closed.ok).toBe(true);
    const deleted = await plugin.invoke('transcript_delete', { sessionId });
    expect(deleted.ok).toBe(true);
    await sessionStream.ended;
    expect(sessionStream.frames.at(-1)?.data).toEqual({ type: 'invalidated', sessionId });
    const gone = await httpBody(port, `/api/sessions/${sessionId}/events?afterSeq=0`, headers);
    expect(gone.status).toBe(404);
    expect((await httpBody(port, `/api/stream?sessionId=${sessionId}`, headers)).status).toBe(404);
  }, 60_000);
});
