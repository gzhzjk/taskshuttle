import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { createLogger } from '../packages/plugin/src/logger.js';
import { createTaskShuttleServer, type TaskShuttleServer } from '../packages/plugin/src/server.js';
import { FakeRunskeinHub } from '../packages/plugin/src/testkit/fake-runskein.js';

const open: TaskShuttleServer[] = [];
afterEach(async () => { while (open.length) await open.pop()!.close().catch(() => undefined); });

const descriptor = { engine: 'codex', installed: true, authenticated: true, available: true, capabilities: { loadSession: true, session: { fork: true }, prompt: { image: true, embeddedContext: true }, mcp: {}, providers: false }, models: [], modes: [], providers: [], configOptions: [], source: 'builtin' };
const engineInfos = [{ id: 'codex', installed: true, authenticated: true, health: 'ready', version: '1.0.0' }];
function fakeHub(hub: FakeRunskeinHub) { return Object.assign(hub, { on: () => () => undefined, rescan: async () => undefined }); }
async function settled(cond: () => boolean | Promise<boolean>, ms = 5000) { const d = Date.now() + ms; for (;;) { if (await cond()) return; if (Date.now() > d) throw new Error('not settled'); await new Promise(r => setTimeout(r, 5)); } }

describe('WAIT proof (M7)', () => {
  it('logger with instanceDir writes progress.ndjson, enabled:false creates none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'journal-proof-'));
    const logger = createLogger({ instanceId: 'id1', instanceDir: dir });
    logger.log({ event: 'turn_transition', turnId: 't1', sessionId: 's1', engine: 'e', from: 'running', to: 'completed', operation: 'op', durationMs: 1 });
    expect(existsSync(join(dir, 'progress.ndjson'))).toBe(true);
    expect(readFileSync(join(dir, 'progress.ndjson'), 'utf8')).toContain('t1');
    const dir2 = await mkdtemp(join(tmpdir(), 'journal-proof-off-'));
    const offLogger = createLogger({ instanceId: 'id1', instanceDir: dir2, enabled: false });
    offLogger.log({ event: 'turn_transition', turnId: 't1', sessionId: 's1', engine: 'e', from: 'a', to: 'completed', operation: 'op' });
    expect(existsSync(join(dir2, 'progress.ndjson'))).toBe(false);
  });

  it('real runtime wiring writes progress.ndjson with turnId', async () => {
    const root = await mkdtemp(join(tmpdir(), 'journal-runtime-'));
    const hub = new FakeRunskeinHub({ closeResolvesPrompt: true, engineInfos: engineInfos as never, descriptors: { codex: descriptor } as never });
    const plugin = createTaskShuttleServer({ dataRoot: root, env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [tmpdir()] }) } as NodeJS.ProcessEnv, hostCwd: tmpdir(), hubFactory: () => fakeHub(hub) as never });
    open.push(plugin);
    await plugin.runtime.ready;
    const cwd = await mkdtemp(join(tmpdir(), 'journal-cwd-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true); if (!created.ok) return;
    const started = await plugin.invoke('turn_start', { sessionId: created.output.sessionId, prompt: [{ type: 'text', text: 'hello' }] });
    expect(started.ok).toBe(true); if (!started.ok) return;
    await settled(() => hub.sessions.size > 0 && plugin.runtime.registry.getTurn(started.output.turnId)?.promptSubmitted === true);
    ;[...hub.sessions.values()][0]!.resolvePrompt({ stopReason: 'end_turn', durationMs: 5 });
    await settled(() => plugin.runtime.registry.getTurn(started.output.turnId)?.state === 'completed');
    const insts = await readdir(join(root, 'instances'));
    const journal = join(root, 'instances', insts[0]!, 'progress.ndjson');
    expect(existsSync(journal)).toBe(true);
    const text = await readFile(journal, 'utf8');
    expect(text).toContain(started.output.turnId);
    expect(text).toContain('"to":"completed"');
  });

  it('REALM_PLUGIN_LOG=off — no journal file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'journal-off-runtime-'));
    const hub = new FakeRunskeinHub({ closeResolvesPrompt: true, engineInfos: engineInfos as never, descriptors: { codex: descriptor } as never });
    const plugin = createTaskShuttleServer({ dataRoot: root, env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [tmpdir()] }), REALM_PLUGIN_LOG: 'off' } as NodeJS.ProcessEnv, hostCwd: tmpdir(), hubFactory: () => fakeHub(hub) as never });
    open.push(plugin);
    await plugin.runtime.ready;
    const cwd = await mkdtemp(join(tmpdir(), 'journal-off-cwd-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true); if (!created.ok) return;
    const started = await plugin.invoke('turn_start', { sessionId: created.output.sessionId, prompt: [{ type: 'text', text: 'hi' }] });
    expect(started.ok).toBe(true); if (!started.ok) return;
    await settled(() => hub.sessions.size > 0 && plugin.runtime.registry.getTurn(started.output.turnId)?.promptSubmitted === true);
    ;[...hub.sessions.values()][0]!.resolvePrompt({ stopReason: 'end_turn', durationMs: 5 });
    await settled(() => plugin.runtime.registry.getTurn(started.output.turnId)?.state === 'completed');
    const insts = await readdir(join(root, 'instances'));
    await expect(stat(join(root, 'instances', insts[0]!, 'progress.ndjson'))).rejects.toThrow();
  });
});
