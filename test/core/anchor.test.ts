import { lstat, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AnchorStore, ANCHOR_FILE } from '../../packages/plugin/src/anchor-store.js';
import { ANCHOR_MAX_BYTES } from '../../packages/plugin/src/schemas.js';
import { createTaskShuttleServer, type TaskShuttleServer } from '../../packages/plugin/src/server.js';
import { FakeRunskeinHub } from '../../packages/plugin/src/testkit/fake-runskein.js';

const open: TaskShuttleServer[] = [];

const descriptor = {
  engine: 'codex',
  installed: true,
  authenticated: true,
  available: true,
  capabilities: { loadSession: true, session: { fork: true }, prompt: { image: true, embeddedContext: true }, mcp: {}, providers: false },
  models: [],
  modes: [],
  providers: [],
  configOptions: [],
  source: 'builtin',
};

const engineInfos = [{ id: 'codex', installed: true, authenticated: true, health: 'ready', version: '1.0.0' }];

async function startPlugin(): Promise<TaskShuttleServer> {
  const hub = new FakeRunskeinHub({ closeResolvesPrompt: true, engineInfos: engineInfos as never, descriptors: { codex: descriptor } as never });
  const plugin = createTaskShuttleServer({
    dataRoot: await mkdtemp(join(tmpdir(), 'taskshuttle-anchor-')),
    env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [tmpdir()] }), REALM_PLUGIN_LOG: 'off' } as NodeJS.ProcessEnv,
    hostCwd: tmpdir(),
    hubFactory: () => Object.assign(hub, { on: () => () => undefined, rescan: async () => undefined }) as never,
  });
  open.push(plugin);
  await plugin.runtime.ready;
  return plugin;
}

async function instanceDir(plugin: TaskShuttleServer): Promise<string> {
  return (await plugin.runtime.ready).instance.instanceDir;
}

/** A Chinese string whose UTF-8 size is `bytes`; every character costs three. */
function chineseOfBytes(bytes: number): string {
  const characters = Math.floor(bytes / 3);
  const padding = bytes - characters * 3;
  return '锚'.repeat(characters) + 'x'.repeat(padding);
}

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close().catch(() => undefined);
});

describe('plan anchor (ADR 0016)', () => {
  it('ANCHOR-001/003: stores an opaque blob byte for byte and replaces it wholesale', async () => {
    const plugin = await startPlugin();
    // Invalid JSON, leading/trailing whitespace and CRLF line endings all at
    // once: a parser, a trim or a newline fix would each show up here.
    const content = '  {"step": 3, "unclosed": [1,2 \r\n\t next: "计划"  ';
    const written = await plugin.invoke('anchor', { content });
    expect(written.ok).toBe(true);
    if (written.ok) expect(written.output.content).toBe(content);

    const read = await plugin.invoke('anchor', {});
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.output.content).toBe(content);
      expect(Buffer.from(read.output.content ?? '', 'utf8')).toEqual(Buffer.from(content, 'utf8'));
    }

    const replacement = 'plan v2';
    await plugin.invoke('anchor', { content: replacement });
    const after = await plugin.invoke('anchor', {});
    // Wholesale replacement: nothing of the first write survives.
    if (after.ok) expect(after.output.content).toBe(replacement);
  });

  it('ANCHOR-004/006: the ceiling is UTF-8 bytes — 16384 passes, 16385 is rejected, not truncated', async () => {
    const plugin = await startPlugin();
    const atLimit = chineseOfBytes(ANCHOR_MAX_BYTES);
    const overLimit = chineseOfBytes(ANCHOR_MAX_BYTES + 1);
    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(16_384);
    expect(Buffer.byteLength(overLimit, 'utf8')).toBe(16_385);
    // Both are far below the limit when counted as code points, which is what
    // makes this the case a `maxLength` implementation would silently pass.
    expect(Array.from(overLimit).length).toBeLessThan(ANCHOR_MAX_BYTES);

    const accepted = await plugin.invoke('anchor', { content: atLimit });
    expect(accepted.ok).toBe(true);

    const rejected = await plugin.invoke('anchor', { content: overLimit });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('INVALID_ARGUMENT');
      // The caller has to be able to trim it themselves, so the actual size and
      // the limit both have to be in the error.
      expect(JSON.stringify(rejected.error)).toContain('16385');
      expect(JSON.stringify(rejected.error)).toContain('16384');
    }

    // Refused, not truncated, and the previous anchor is untouched.
    const read = await plugin.invoke('anchor', {});
    if (read.ok) expect(read.output.content).toBe(atLimit);
  });

  it('ANCHOR-007: session_close does not touch the anchor', async () => {
    const plugin = await startPlugin();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-anchor-cwd-'));
    await plugin.invoke('anchor', { content: 'the plan' });
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await plugin.invoke('session_close', { sessionId: created.output.sessionId });
    const read = await plugin.invoke('anchor', {});
    // The anchor is instance-scoped: a workflow outlives any one session, which
    // is why it was not hung off `session_configure`.
    if (read.ok) expect(read.output.content).toBe('the plan');
  });

  it('ANCHOR-008: turnsSinceUpdate counts dispatches, never reads the content', async () => {
    const plugin = await startPlugin();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-anchor-turns-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.output.sessionId;

    await plugin.invoke('turn_start', { sessionId, prompt: [{ type: 'text', text: 'before' }] });
    const written = await plugin.invoke('anchor', { content: 'plan' });
    // Quiet period: nothing was dispatched between the write and this read.
    if (written.ok) expect(written.output.turnsSinceUpdate).toBe(0);
    const quiet = await plugin.invoke('anchor', {});
    if (quiet.ok) expect(quiet.output.turnsSinceUpdate).toBe(0);

    for (let i = 0; i < 3; i += 1) {
      await plugin.invoke('turn_start', { sessionId, prompt: [{ type: 'text', text: `after ${i}` }] });
      const read = await plugin.invoke('anchor', {});
      if (read.ok) {
        expect(read.output.turnsSinceUpdate).toBe(i + 1);
        expect(read.output.turnsSinceUpdate).toBeGreaterThanOrEqual(0);
      }
    }
  });

  // What this pins is the property itself: the count comes from the runtime's
  // own monotonic counter, not from the turn records. It does not need an
  // eviction to bite — every turn below is terminal, so an implementation
  // reading live records reads 0 where this reads 4. ADR 0013 proposed evicting
  // terminal records, stayed `proposed`, and its tracking issue (GZH-15) was
  // closed as not planned, so the eviction half of ANCHOR-009/010 is not
  // pending work rather than work someone still owes.
  it('ANCHOR-009: the count comes from a monotonic counter, not from the turn records', async () => {
    const plugin = await startPlugin();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-anchor-evict-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.output.sessionId;

    await plugin.invoke('anchor', { content: 'plan' });
    for (let i = 0; i < 4; i += 1) {
      const started = await plugin.invoke('turn_start', { sessionId, prompt: [{ type: 'text', text: `t${i}` }] });
      if (started.ok) await plugin.invoke('turn_cancel', { turnId: started.output.turnId });
    }
    const before = await plugin.invoke('anchor', {});
    if (before.ok) expect(before.output.turnsSinceUpdate).toBe(4);

    // The counter is its own fact, independent of what the registry retains.
    expect(plugin.runtime.turnsDispatched).toBe(4);
    const nonTerminal = plugin.runtime.registry.listTurns(sessionId).filter((turn) => turn.state !== 'cancelled');
    expect(nonTerminal).toHaveLength(0);
    // Every turn is terminal, so any implementation that counted live turn
    // records would already read 0 here.
    const after = await plugin.invoke('anchor', {});
    if (after.ok) expect(after.output.turnsSinceUpdate).toBe(4);
  });

  it('ANCHOR-011: the on-disk record is exactly four fields at 0600 in the instance directory', async () => {
    const plugin = await startPlugin();
    await plugin.invoke('anchor', { content: '计划' });
    const dir = await instanceDir(plugin);
    const path = join(dir, ANCHOR_FILE);
    const info = await lstat(path);
    expect(info.isFile()).toBe(true);
    expect(info.mode & 0o777).toBe(0o600);
    const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(['content', 'instanceId', 'turnsAtWrite', 'updatedAt']);
    expect(record['content']).toBe('计划');
    expect(record['instanceId']).toBe(plugin.runtime.instanceId);
    expect(record['turnsAtWrite']).toBe(0);
    // No temp file survives a successful write.
    expect((await readdir(dir)).filter((name) => name.startsWith(`${ANCHOR_FILE}.tmp-`))).toHaveLength(0);
  });

  it('ANCHOR-013: a failure before the rename leaves the previous anchor readable', async () => {
    const plugin = await startPlugin();
    await plugin.invoke('anchor', { content: 'the old plan' });
    const store = new AnchorStore(await instanceDir(plugin), plugin.runtime.instanceId);
    await expect(store.write('the new plan', () => { throw new Error('counter unavailable'); })).rejects.toThrow('counter unavailable');
    const read = await plugin.invoke('anchor', {});
    // A stale anchor still reminds; an empty one is the same as never written.
    if (read.ok) expect(read.output.content).toBe('the old plan');
  });

  it('ANCHOR-014: a corrupt record reads as absent, without repair or partial parsing', async () => {
    const plugin = await startPlugin();
    await plugin.invoke('anchor', { content: 'the plan' });
    await writeFile(join(await instanceDir(plugin), ANCHOR_FILE), '{"content": "half', { mode: 0o600 });
    const read = await plugin.invoke('anchor', {});
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.output.content).toBeUndefined();
      expect(read.output.turnsSinceUpdate).toBe(0);
    }
  });

  it('ANCHOR-018: a session that never wrote an anchor reads as absent, not as an error', async () => {
    const plugin = await startPlugin();
    const read = await plugin.invoke('anchor', {});
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.output.content).toBeUndefined();
      expect(read.output.updatedAt).toBeUndefined();
    }
  });

  it('serializes concurrent writes on the anchor lane and never reports a negative count', async () => {
    const plugin = await startPlugin();
    const results = await Promise.all(['a', 'b', 'c', 'd'].map((content) => plugin.invoke('anchor', { content })));
    for (const result of results) {
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output.turnsSinceUpdate).toBeGreaterThanOrEqual(0);
    }
    const read = await plugin.invoke('anchor', {});
    // One of the four won; none of them left a torn file behind.
    if (read.ok) expect(['a', 'b', 'c', 'd']).toContain(read.output.content);
  });
});
