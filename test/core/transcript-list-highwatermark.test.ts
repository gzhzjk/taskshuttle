import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { StoreError } from 'runskein';
import { FakeRunskeinHub } from '../../packages/plugin/src/testkit/fake-runskein.js';
import { createTaskShuttleServer } from '../../packages/plugin/src/server.js';
import type { LogRecord } from '../../packages/plugin/src/logger.js';
function fakeHub(hub: FakeRunskeinHub){ return Object.assign(hub, { on: ()=>()=>undefined, rescan: async ()=>undefined }); }
const descriptor = { engine: 'codex', installed: true, authenticated: true, available: true, capabilities: { loadSession: true, session: { fork: true }, prompt: { image: true, embeddedContext: true }, mcp: {}, providers: false }, models: [], modes: [], providers: [], configOptions: [], source: 'builtin' };
const engineInfos = [{ id: 'codex', installed: true, authenticated: true, health: 'ready', version: '1.0.0' }];

const open: Array<{ close: () => Promise<void> }> = [];

async function startWithFakeHub() {
  const root = await mkdtemp(join(tmpdir(), 'taskshuttle-tlhw-'));
  const hub = new FakeRunskeinHub({ closeResolvesPrompt: true, engineInfos: engineInfos as never, descriptors: { codex: descriptor as never } as never });
  const logs: LogRecord[] = [];
  const plugin = createTaskShuttleServer({
    dataRoot: root, env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [tmpdir()] }) } as NodeJS.ProcessEnv,
    hostCwd: tmpdir(), hubFactory: () => fakeHub(hub) as never, logSink: (r) => logs.push(r),
  });
  open.push(plugin);
  await plugin.runtime.ready;
  return { plugin, hub, logs };
}
afterEach(async () => { while (open.length) await open.pop()!.close().catch(()=>undefined); vi.restoreAllMocks(); });

describe('GZH-45 transcript_list highWatermark', () => {
  it('fresh session with no events -> highWatermark 0', async () => {
    const { plugin } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-tlhw-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd }) as any;
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const listed = await plugin.invoke('transcript_list', {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const entry = (listed.output as { transcripts: Array<{ sessionId: string; highWatermark: number }> }).transcripts.find(t=>t.sessionId===created.output.sessionId);
    expect(entry).toBeDefined();
    expect(entry!.highWatermark).toBe(0);
  });
  it('store fault -> STORE_ERROR + store_error log', async () => {
    const { plugin, logs } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-tlhw-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { store } = await plugin.runtime.ready;
    vi.spyOn(store, 'highWatermark').mockRejectedValue(new StoreError({ operation: 'read', cause: new Error('store is sick') }));
    const listed = await plugin.invoke('transcript_list', {});
    expect(listed.ok).toBe(false);
    if (listed.ok) return;
    expect(listed.error.code).toBe('STORE_ERROR');
    expect(logs.filter(r=>r.event==='store_error').length).toBe(1);
  });
});
