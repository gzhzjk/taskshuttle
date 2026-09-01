#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

import { captureSelfOrphanRecord } from './lifecycle.js';

process.umask(0o077);
for (const [current, legacy] of [['TASKSHUTTLE_LAUNCH_PATH', 'REALM_PLUGIN_LAUNCH_PATH'], ['TASKSHUTTLE_DATA_ROOT', 'REALM_PLUGIN_DATA_ROOT']] as const) {
  if (process.env[current] === undefined && process.env[legacy] !== undefined) process.stderr.write(`taskshuttle compatibility: using legacy ${legacy}\n`);
}

if (process.argv[2] === 'wait') {
  function flag(name: string): string | undefined {
    const eq = process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length+3);
    if (eq !== undefined) return eq;
    const idx = process.argv.indexOf(`--${name}`);
    if (idx !== -1) return process.argv[idx+1];
    return undefined;
  }
  const inst = flag('instance');
  const cur = flag('cursor');
  const to = flag('timeout');
  const { runWait } = await import('./cli/wait.js');
  try {
    const result = await runWait({ ...(inst===undefined?{}:{instance:inst}), ...(cur===undefined?{}:{cursor:Number(cur)}), ...(to===undefined?{}:{timeoutMs:Number(to)}) });
    process.exitCode = result.exitCode;
  } catch (cause) { process.stderr.write(String(cause instanceof Error?cause.message:String(cause))+'\n'); process.exitCode = 1; }
} else if (process.argv[2] === 'console' && process.argv[3] === 'open') {
  // `taskshuttle console open [--instance=<id>]` (console-design §8.2): the
  // command the operator (or an agent) runs. The console has no credential
  // (ADR 0032), so this exists to pick the right instance among several and to
  // confirm the port still answers as that instance before opening a browser
  // at it — not to keep a secret out of the conversation, which is what it was
  // originally for.
  const instance = process.argv.find((argument) => argument.startsWith('--instance='))?.slice('--instance='.length);
  const { runConsoleOpen } = await import('./console/open.js');
  const result = await runConsoleOpen({ ...(instance === undefined ? {} : { instance }) });
  process.exitCode = result.exitCode;
} else {
  const suppliedToken = process.argv[2]?.startsWith('--realm-instance-token=') ? process.argv[2].slice('--realm-instance-token='.length) : undefined;
  const token = suppliedToken ?? randomBytes(16).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const workerCommand = suppliedToken === undefined ? process.argv[2] : process.argv[3];
  const workerArgs = suppliedToken === undefined ? process.argv.slice(3) : process.argv.slice(4);
  // The marker name carries the launch token as well as the pid: a recycled pid
  // must never make a fresh shim collide with a stale marker.
  const markerRoot = process.env['TASKSHUTTLE_MARKER_ROOT'] ?? process.env['REALM_PLUGIN_MARKER_ROOT'] ?? process.env['TASKSHUTTLE_DATA_ROOT'] ?? process.env['REALM_PLUGIN_DATA_ROOT'] ?? tmpdir();
  const orphanPath = workerCommand === undefined
    ? (process.env['TASKSHUTTLE_ORPHAN_FILE'] ?? process.env['REALM_PLUGIN_ORPHAN_FILE'] ?? join(tmpdir(), `taskshuttle-${process.pid}-${tokenHash.slice(0, 16)}.orphan.json`))
    : join(markerRoot, 'orphans', `taskshuttle-worker-${process.pid}-${tokenHash.slice(0, 16)}.orphan.json`);

  async function writeMarker(extra: Record<string, unknown> = {}): Promise<boolean> {
    // The marker carries the identity the reaper re-verifies later. When the OS
    // cannot supply a complete identity we write nothing: a partial marker would
    // only ever resolve to "skipped" and reads as a reap candidate to a human.
    // A marker is diagnostics, never a start-up precondition: any failure here
    // must not take down the shim (and orphan the engine it just spawned).
    try {
      await mkdir(join(orphanPath, '..'), { recursive: true, mode: 0o700 });
      const record = await captureSelfOrphanRecord(tokenHash);
      if (record === undefined) return false;
      const handle = await open(orphanPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ ...record, ...extra }), 'utf8');
      await handle.close();
      process.once('exit', () => { try { unlinkSync(orphanPath); } catch { /* process crashes leave the marker */ } });
      return true;
    } catch (cause) {
      process.stderr.write(`taskshuttle: orphan marker unavailable (${cause instanceof Error ? cause.message : String(cause)})\n`);
      return false;
    }
  }

  if (workerCommand !== undefined) {
    const child = spawn(workerCommand, workerArgs, { stdio: 'inherit', env: process.env });
    if (child.pid === undefined) throw new Error('worker shim did not receive a child pid');
    await writeMarker();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => child.kill(signal));
    child.once('exit', (code) => process.exitCode = code ?? 1);
  } else {
    const written = await writeMarker({ tokenHash });
    process.env['TASKSHUTTLE_ORPHAN_FILE'] = orphanPath;
    if (written) process.env['TASKSHUTTLE_ORPHAN_OWNER'] = tokenHash;
    process.env['TASKSHUTTLE_LAUNCH_TOKEN_HASH'] = tokenHash;
    await import('./cli.js');
  }
}
