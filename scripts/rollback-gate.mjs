#!/usr/bin/env node
/**
 * STO-018 release gate. Artifact acquisition is source-neutral: a caller may
 * provide a registry/cache artifact, otherwise this gate performs the pinned
 * reproducible rebuild. The verified old package is then driven through its
 * public MCP tools against a complete instance directory produced by the
 * production transcript/lifecycle adapters.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const manifestPath = resolve(root, 'test/fixtures/rollback/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const required = ['package', 'version', 'sourceCommit', 'byteLength', 'sha256', 'toolchain', 'recipe'];
for (const field of required) {
  if (manifest[field] === undefined) throw new Error(`STO-018: rollback manifest is missing ${field}`);
}
if (manifest.package !== 'taskshuttle') throw new Error(`STO-018: rollback package must be taskshuttle, got ${String(manifest.package)}`);
if (!/^[0-9a-f]{64}$/u.test(manifest.sha256) || !Number.isSafeInteger(manifest.byteLength)) throw new Error('STO-018: rollback manifest has invalid byte identity');

const temporaryRoot = mkdtempSync(join(tmpdir(), 'taskshuttle-sto018-'));
let candidate;
try {
  candidate = process.env['TASKSHUTTLE_STO018_ARTIFACT'];
  if (candidate !== undefined) {
    candidate = resolve(candidate);
    if (!existsSync(candidate)) throw new Error(`STO-018: supplied candidate artifact is unavailable: ${candidate}`);
  } else {
    // The current repository publishes by installation, while ADR 0046
    // authorizes a future npm publisher. A clean rebuild is the third source
    // and keeps this gate runnable before either distribution path exists.
    const source = join(temporaryRoot, 'source');
    const output = join(temporaryRoot, 'output');
    mkdirSync(source);
    mkdirSync(output);
    const archive = execFileSync('git', ['archive', manifest.sourceCommit], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', source], { input: archive, cwd: root, stdio: ['pipe', 'inherit', 'inherit'] });
    execFileSync('pnpm', ['--dir', source, 'install', '--frozen-lockfile'], { cwd: root, stdio: 'inherit' });
    execFileSync('pnpm', ['--dir', source, 'build'], { cwd: root, stdio: 'inherit' });
    const packed = JSON.parse(execFileSync('npm', ['pack', '--pack-destination', output, '--json'], { cwd: source, encoding: 'utf8' }));
    const filename = packed[0]?.filename;
    if (typeof filename !== 'string') throw new Error('STO-018: reproducible rebuild produced no tarball');
    candidate = join(output, filename);
  }

  const bytes = readFileSync(candidate);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== manifest.byteLength || digest !== manifest.sha256) {
    throw new Error(`STO-018: candidate bytes do not match pinned identity (length ${bytes.byteLength}, sha256 ${digest})`);
  }
  let packageJson;
  try {
    packageJson = JSON.parse(execFileSync('tar', ['-xOzf', candidate, 'package/package.json'], { encoding: 'utf8' }));
  } catch (cause) {
    throw new Error(`STO-018: candidate package identity cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (packageJson.name !== manifest.package || packageJson.version !== manifest.version) {
    throw new Error(`STO-018: candidate package identity is ${packageJson.name}@${packageJson.version}, expected ${manifest.package}@${manifest.version}`);
  }

  const packageRoot = join(temporaryRoot, 'candidate');
  mkdirSync(packageRoot);
  execFileSync('tar', ['-xzf', candidate, '-C', packageRoot], { cwd: root, stdio: 'inherit' });
  const entry = join(packageRoot, 'package', 'dist', 'cli.js');
  if (!existsSync(entry)) throw new Error('STO-018: verified candidate has no public stdio entry');

  const dataRoot = join(temporaryRoot, 'data');
  mkdirSync(dataRoot, { mode: 0o700 });
  execFileSync('pnpm', ['exec', 'tsx', 'scripts/rollback-fixture.ts', dataRoot], { cwd: root, stdio: 'inherit' });
  const expected = JSON.parse(readFileSync(join(dataRoot, 'sto-018-expected.json'), 'utf8'));
  const workRoot = join(temporaryRoot, 'work');
  mkdirSync(workRoot);
  const child = spawn(process.execPath, [entry], {
    cwd: workRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TASKSHUTTLE_DATA_ROOT: dataRoot,
      REALM_PLUGIN_DATA_ROOT: dataRoot,
      REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [workRoot] }),
      REALM_PLUGIN_LOG: 'off',
    },
  });
  const pending = new Map();
  let buffer = '';
  let nextId = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (!Number.isInteger(message.id)) continue;
      const waiter = pending.get(message.id);
      if (waiter === undefined) continue;
      pending.delete(message.id);
      if (message.error !== undefined) waiter.reject(new Error(message.error.message ?? 'MCP error'));
      else waiter.resolve(message.result ?? {});
    }
  });
  child.stderr.resume();
  const request = (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); rejectRequest(new Error(`STO-018: ${method} timed out`)); }, 30_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolveRequest(value); },
      reject: (cause) => { clearTimeout(timer); rejectRequest(cause); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const callTool = async (name, args) => {
    const result = await request('tools/call', { name, arguments: args });
    if (result.isError === true) {
      const text = Array.isArray(result.content) ? result.content.find((entry) => entry?.type === 'text')?.text : undefined;
      throw new Error(`STO-018: old artifact rejected ${name}${typeof text === 'string' ? `: ${text}` : ''}`);
    }
    if (result.structuredContent !== undefined) return result.structuredContent;
    const text = Array.isArray(result.content) ? result.content.find((entry) => entry?.type === 'text')?.text : undefined;
    if (typeof text !== 'string') throw new Error(`STO-018: ${name} returned no structured result`);
    return JSON.parse(text);
  };
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sto-018', version: '1.0.0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const listed = await callTool('transcript_list', { kind: 'archive' });
    const archive = listed.transcripts?.find((item) => item.sessionId === expected.sessionId && item.kind === 'archive');
    if (archive === undefined) throw new Error('STO-018: old artifact recovery did not expose the candidate session as kind archive');
    const page = await callTool('transcript_read', { sessionId: expected.sessionId, afterSeq: 0, limit: 100 });
    if (JSON.stringify(page.events) !== JSON.stringify(expected.events)) throw new Error('STO-018: old transcript_read changed an event field or opaque update');
    const event = await callTool('transcript_event_get', { sessionId: expected.sessionId, seq: 2, offset: 0, maxBytes: 262144 });
    const eventBytes = Buffer.from(event.data, 'base64');
    const expectedBytes = Buffer.from(JSON.stringify(expected.events[1]), 'utf8');
    if (!eventBytes.equals(expectedBytes) || event.sha256 !== createHash('sha256').update(expectedBytes).digest('hex')) throw new Error('STO-018: old transcript_event_get changed canonical event bytes');
  } finally {
    for (const waiter of pending.values()) waiter.reject(new Error('STO-018: old artifact stopped'));
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolveExit) => {
        if (child.exitCode !== null || child.signalCode !== null) resolveExit();
        else child.once('exit', resolveExit);
      });
    }
  }
  console.log(`STO-018 passed: ${manifest.package}@${manifest.version} recovered ${expected.sessionId} through transcript_list/read/event_get`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
