// SEC-REC-018 end to end (ADR 0031): an ordinary root spawns a worker whose
// engine strips the environment. The child plugin is the real stdio server —
// `dist/cli.js`, the production entry that settles its own verdict before
// serving — spawned as a descendant of this process, which holds a live
// instance lock. The child must match that lock through the real process
// table, refuse session_create with no marker anywhere in its environment, and
// record provenance 'ancestry' at depth 1 in a manifest an operator can read.
// This is the case that exists because an earlier manifest shape answered
// `unavailable` here, failing the mechanism on the only path it was built for.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { InstanceManager, parentProcessId, processStartTime } from '../../packages/plugin/src/lifecycle.js';
import { DELEGATION_ENV } from '../../packages/plugin/src/security-policy.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');

interface Spawned {
  readonly child: ReturnType<typeof spawn>;
  readonly stdout: Promise<string>;
  readonly exit: Promise<number>;
}

/** One JSON-RPC line at a time; MCP stdio is newline-delimited JSON. */
function spawnCli(dataRoot: string, workRoot: string): Spawned & { readonly waitForResponse: (id: number) => Promise<void> } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The measured defect is the engine that sanitizes: scrub all three markers,
  // whatever the outer environment carries.
  for (const variable of Object.values(DELEGATION_ENV)) delete env[variable];
  for (const key of Object.keys(env)) if (key.startsWith('REALM_DELEGATION_')) delete env[key];
  env['REALM_PLUGIN_DATA_ROOT'] = dataRoot;
  // The production default probes ~/.realm-plugin. This isolated child case
  // owns its complete probe set, so it must not consult an operator's home.
  env['TASKSHUTTLE_TEST_LEGACY_PROBE_ROOTS'] = '';
  env['REALM_PLUGIN_CONFIG'] = JSON.stringify({ allowedRoots: [workRoot] });
  // The child inherits this process's cwd (the repository), and configuration
  // may only narrow the boundary it finds there — a /tmp work root would be
  // rejected as outside it, killing the server before a single tool call.
  env['REALM_PLUGIN_HOST_CWD'] = workRoot;
  env['REALM_PLUGIN_LOG'] = 'off';
  const child = spawn(process.execPath, [CLI], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  let text = '';
  let ended = false;
  const waiters: Array<() => void> = [];
  const wake = () => { while (waiters.length > 0) waiters.pop()!(); };
  child.stdout.on('data', (chunk: Buffer) => { chunks.push(chunk); text = Buffer.concat(chunks).toString('utf8'); wake(); });
  child.stdout.on('end', () => { ended = true; wake(); });
  child.stderr.resume();
  const stdout = new Promise<string>((resolve, reject) => {
    child.stdout.on('end', () => resolve(text));
    child.stdout.on('error', reject);
  });
  const exit = new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)));
  return {
    child,
    stdout,
    exit,
    // The stdio transport ends the session on stdin EOF, so each request must
    // be ANSWERED before the input side closes — closing both in one breath
    // races the shutdown against the handler.
    async waitForResponse(id: number): Promise<void> {
      for (;;) {
        if (responseForOrNull(text, id) !== undefined) return;
        if (ended) throw new Error(`stdout ended before response ${id}:\n${text.slice(0, 2000)}`);
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

function request(child: ReturnType<typeof spawn>, id: number, method: string, params?: Record<string, unknown>): void {
  child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
}

/** Notifications carry no id — one with an id would demand a response. */
function notify(child: ReturnType<typeof spawn>, method: string): void {
  child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
}

function responseForOrNull(stdout: string, id: number): Record<string, unknown> | undefined {
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const message = JSON.parse(line) as { id?: number };
      if (message.id === id) return message as unknown as Record<string, unknown>;
    } catch { /* a server line that is not the answer yet */ }
  }
  return undefined;
}

function responseFor(stdout: string, id: number): Record<string, unknown> {
  const found = responseForOrNull(stdout, id);
  if (found === undefined) throw new Error(`no JSON-RPC response with id ${id} in:\n${stdout.slice(0, 2000)}`);
  return found;
}

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe('a worker under an ordinary root (SEC-REC-018)', () => {
  it('is delegated at depth 1 by ancestry and refuses to delegate further', { timeout: 120_000 }, async () => {
    if (!existsSync(CLI)) throw new Error('dist/cli.js is missing; run pnpm build before this case');
    const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-delegation-spawn-'));
    roots.push(dataRoot);
    const workRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-delegation-work-'));
    roots.push(workRoot);

    // The root instance: this very process. Its lock must carry the canonical
    // start time the walker will read back through ps//proc — one helper, or
    // the two never compare equal and the boundary is silently inert.
    const startedAt = await processStartTime(process.pid);
    if (startedAt === undefined) throw new Error('this platform cannot read its own start time; ADR 0014 matrix only');
    if ((await parentProcessId(process.pid)) === undefined) throw new Error('ppid unreadable; the walk cannot be exercised here');
    const root = await InstanceManager.create({
      dataRoot,
      pid: process.pid,
      processStartedAt: startedAt,
      exePath: process.execPath,
      rootNonce: randomBytes(16).toString('hex'),
      // No delegation object: an ordinary root whose manifest predates nothing
      // but simply need not say more than root-at-zero — left legacy on
      // purpose, so the depth-1 answer below also covers the legacy rule.
    });

    const spawned = spawnCli(dataRoot, workRoot);
    request(spawned.child, 1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gate', version: '0.0.0' } });
    await spawned.waitForResponse(1);
    notify(spawned.child, 'notifications/initialized');
    request(spawned.child, 3, 'tools/call', { name: 'session_create', arguments: { engine: 'kimi', cwd: workRoot } });
    await spawned.waitForResponse(3);
    // EOF is the stdio server's shutdown signal; without it the process never
    // exits and awaiting its stdout would hang past any timeout.
    spawned.child.stdin!.end();
    const deadline = setTimeout(() => spawned.child.kill('SIGKILL'), 90_000);
    const stdout = await spawned.stdout;
    clearTimeout(deadline);

    // Refused, by recursion rather than anything else. The tool face frames a
    // refusal as an isError result; a JSON-RPC error object says the same
    // thing through the transport — either way the code must be named.
    const call = responseFor(stdout, 3) as { result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean }; error?: { message?: string } };
    const refused = call.result?.isError === true || call.error !== undefined;
    const text = JSON.stringify(call.result?.content ?? call.error ?? call);
    expect(refused, stdout.slice(0, 2000)).toBe(true);
    expect(text).toContain('RECURSION_DENIED');

    // The verdict is diagnosed from disk: the child matched this process's
    // live lock and read this manifest's implicit zero as its floor.
    const instanceDirs = (await readdir(join(dataRoot, 'instances'))).filter((entry) => entry !== root.instanceId && !entry.startsWith('.'));
    expect(instanceDirs.length).toBe(1);
    const manifest = JSON.parse(await readFile(join(dataRoot, 'instances', instanceDirs[0]!, 'instance.json'), 'utf8')) as { delegation?: { provenance: string; depth?: number } };
    expect(manifest.delegation).toEqual({ provenance: 'ancestry', depth: 1 });
  });

  it('the same child with no ancestor lock serves instead — the check refuses nothing else', { timeout: 120_000 }, async () => {
    if (!existsSync(CLI)) throw new Error('dist/cli.js is missing; run pnpm build before this case');
    const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-delegation-spawn-control-'));
    roots.push(dataRoot);
    const workRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-delegation-work-control-'));
    roots.push(workRoot);

    const spawned = spawnCli(dataRoot, workRoot);
    request(spawned.child, 1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gate', version: '0.0.0' } });
    await spawned.waitForResponse(1);
    notify(spawned.child, 'notifications/initialized');
    // Read-only inventory: proves the server settled a root verdict and opened,
    // without spawning a real worker engine, which no hermetic gate may do.
    request(spawned.child, 3, 'tools/call', { name: 'workers_list', arguments: { rescan: true } });
    await spawned.waitForResponse(3);
    spawned.child.stdin!.end();
    const deadline = setTimeout(() => spawned.child.kill('SIGKILL'), 90_000);
    const stdout = await spawned.stdout;
    clearTimeout(deadline);

    const call = responseFor(stdout, 3) as { result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean } };
    expect(call.result?.isError ?? false, stdout.slice(0, 2000)).toBe(false);
    const instanceDirs = (await readdir(join(dataRoot, 'instances'))).filter((entry) => !entry.startsWith('.'));
    expect(instanceDirs.length).toBe(1);
    const manifest = JSON.parse(await readFile(join(dataRoot, 'instances', instanceDirs[0]!, 'instance.json'), 'utf8')) as { delegation?: { provenance: string; depth?: number } };
    expect(manifest.delegation).toEqual({ provenance: 'root', depth: 0 });
  });
});
