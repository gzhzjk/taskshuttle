import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptEvent, TranscriptStore } from 'runskein';
import { NotFoundError, StoreError } from 'runskein';

import { createPluginTranscriptStore } from '../../packages/plugin/src/store/plugin-transcript-store.js';
import { createTaskShuttleServer, type TaskShuttleServer } from '../../packages/plugin/src/server.js';
import { simulatedHubFactory } from '../../packages/plugin/src/testkit/simulated-engines.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => any };

function metaEvent(seq: number, status: 'idle' | 'closed' = 'idle'): TranscriptEvent {
  return markerEvent(seq, 'runskein.dev/sessionMeta', { cwd: '/tmp/project', status });
}

/**
 * A `session_info_update` carrying whatever marker the case is about.
 *
 * The key is a parameter because the cases that matter here are about *which*
 * key was written: a fixture that hard-codes the one the code reads tests one
 * half of a pair against itself, which is how the legacy spelling survived a
 * green suite for a whole release (§3.1 of the migration document).
 */
function markerEvent(seq: number, key: string, value: unknown): TranscriptEvent {
  return {
    seq,
    ts: seq * 1_000,
    sessionId: 'session-1',
    engineId: 'codex',
    update: {
      sessionUpdate: 'session_info_update',
      _meta: { [key]: value },
    },
  };
}

function textEvent(seq: number, text: string, sessionId = 'session-1'): TranscriptEvent {
  return {
    seq,
    ts: seq * 1_000,
    sessionId,
    engineId: 'codex',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  };
}

async function collect(events: AsyncIterable<TranscriptEvent>): Promise<TranscriptEvent[]> {
  const result: TranscriptEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('PluginTranscriptStore', () => {
  it('conforms to the public Realm TranscriptStore contract and preserves canonical bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-plugin-store-'));
    const path = join(root, 'taskshuttle.sqlite');
    const store: TranscriptStore = createPluginTranscriptStore(path);
    await store.append(metaEvent(1));
    await store.append(textEvent(2, 'hello'));
    await store.append(metaEvent(3, 'closed'));

    await expect(collect(store.read('session-1'))).resolves.toEqual([metaEvent(1), textEvent(2, 'hello'), metaEvent(3, 'closed')]);
    await expect(collect(store.read('session-1', { fromSeq: 2, toSeq: 2 }))).resolves.toEqual([textEvent(2, 'hello')]);
    await expect(collect(store.read('session-1', { fromSeq: 99 }))).resolves.toEqual([]);
    await expect(store.sessions()).resolves.toEqual([
      {
        sessionId: 'session-1',
        engineId: 'codex',
        cwd: '/tmp/project',
        status: 'closed',
        createdAt: 1_000,
        updatedAt: 3_000,
      },
    ]);
    await expect(store.digest('session-1')).resolves.toMatchObject({ sessionId: 'session-1', throughSeq: 3, text: 'Assistant: hello' });

    const db = new DatabaseSync(path);
    const row = db.prepare('SELECT event_json, byte_len, sha256 FROM transcript_events WHERE session_id = ? AND seq = ?').get('session-1', 2) as {
      event_json: Uint8Array;
      byte_len: number;
      sha256: string;
    };
    const bytes = Buffer.from(row.event_json);
    expect(bytes.toString('utf8').endsWith('\n')).toBe(false);
    expect(row.byte_len).toBe(bytes.byteLength);
    expect(row.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    db.close();
    await createPluginTranscriptStore(path).close();
    await rm(root, { recursive: true, force: true });
  });

  it('serializes appends, rejects duplicate/out-of-order seq, and does not advance watermark on failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-plugin-store-'));
    const store = createPluginTranscriptStore(join(root, 'taskshuttle.sqlite'));
    await Promise.all([store.append(metaEvent(1)), store.append(textEvent(2, 'second'))]);
    await expect(store.highWatermark('session-1')).resolves.toBe(2);
    await expect(store.append(textEvent(2, 'duplicate'))).rejects.toBeInstanceOf(StoreError);
    await expect(store.append(textEvent(1, 'older'))).rejects.toBeInstanceOf(StoreError);
    await expect(store.highWatermark('session-1')).resolves.toBe(2);
    await rm(root, { recursive: true, force: true });
  });

  it('captures the read high-watermark at invocation time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-plugin-store-'));
    const store = createPluginTranscriptStore(join(root, 'taskshuttle.sqlite'));
    await store.append(metaEvent(1));
    const page = store.read('session-1');
    await store.append(textEvent(2, 'late'));
    await expect(collect(page)).resolves.toHaveLength(1);
    await rm(root, { recursive: true, force: true });
  });

  it('does not make an invocation-time missing session appear after a later append', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-plugin-store-'));
    const store = createPluginTranscriptStore(join(root, 'taskshuttle.sqlite'));
    const page = store.read('future');
    await store.append({ ...metaEvent(1), sessionId: 'future' });
    await expect(collect(page)).rejects.toBeInstanceOf(NotFoundError);
    await rm(root, { recursive: true, force: true });
  });

  it('supports filters, not-found semantics, delete, and restrictive file mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-plugin-store-'));
    const path = join(root, 'nested', 'taskshuttle.sqlite');
    const store = createPluginTranscriptStore(path);
    await store.append(metaEvent(1));
    await store.append(metaEvent(2, 'closed'));
    await expect(store.sessions({ status: 'closed', since: 2_000 })).resolves.toHaveLength(1);
    await expect(collect(store.read('missing'))).rejects.toBeInstanceOf(NotFoundError);
    await expect(store.digest('missing')).rejects.toBeInstanceOf(NotFoundError);
    await expect(store.delete('missing')).rejects.toBeInstanceOf(NotFoundError);
    await store.delete('session-1');
    await expect(collect(store.read('session-1'))).rejects.toBeInstanceOf(NotFoundError);
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  it('detects persisted corruption instead of returning altered events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-plugin-store-'));
    const path = join(root, 'taskshuttle.sqlite');
    const store = createPluginTranscriptStore(path);
    await store.append(metaEvent(1));
    await store.close();
    const db = new DatabaseSync(path);
    db.prepare('UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = ?').run(Buffer.from('{"bad":true}'), 'session-1', 1);
    db.close();
    const reopened = createPluginTranscriptStore(path);
    await expect(collect(reopened.read('session-1'))).rejects.toBeInstanceOf(StoreError);
    await reopened.close();
    await rm(root, { recursive: true, force: true });
  });

  it('rejects a symlink database target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-plugin-store-'));
    const target = join(root, 'target.sqlite');
    const link = join(root, 'link.sqlite');
    await symlink(target, link);
    const store = createPluginTranscriptStore(link);
    await expect(store.sessions()).rejects.toBeInstanceOf(StoreError);
    await rm(root, { recursive: true, force: true });
  });

  it('enforces canonical data-root containment across symlinked components', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-plugin-store-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'taskshuttle-plugin-store-outside-'));
    const linked = join(root, 'linked');
    await symlink(outside, linked);
    const store = createPluginTranscriptStore(join(linked, 'taskshuttle.sqlite'), { dataRoot: root });
    await expect(store.sessions()).rejects.toBeInstanceOf(StoreError);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('projects nothing from a transcript written under the old dependency, and reports nothing', async () => {
    // ADR 0041 decision 2: the rename is a clean break. A pre-upgrade
    // transcript keeps its events and loses its projection — uniformly
    // unsupported rather than half-supported, because a session header with no
    // usage reads as a session that used no tokens.
    //
    // The second assertion is what pins decision 2's *presence* rule: under
    // the new spelling this event is the absent-key case, and an implementation
    // that reports without testing presence would fire here — on every
    // pre-upgrade session, which is the supported case, not a fault.
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-plugin-store-'));
    const reported: unknown[] = [];
    const store = createPluginTranscriptStore(join(root, 'taskshuttle.sqlite'), { onMalformedMeta: (info) => reported.push(info) });
    try {
      await store.append(markerEvent(1, 'realm.dev/sessionMeta', { cwd: '/tmp/project', status: 'closed' }));
      const sessions = await store.sessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.cwd).toBe('');
      expect(sessions[0]!.status).toBe('idle');
      expect(reported).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports a malformed marker once, with the session and sequence, and keeps the default', async () => {
    // `readMeta` returns undefined for an absent key and a present-but-broken
    // one alike, so silence here would leave a producer bug looking exactly
    // like an empty session. The projection still stays at its default: a
    // malformed marker is not a reason to invent a value.
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-plugin-store-'));
    const reported: { sessionId: string; seq: number }[] = [];
    const store = createPluginTranscriptStore(join(root, 'taskshuttle.sqlite'), { onMalformedMeta: (info) => reported.push(info) });
    try {
      // Two appends, not one call with two arguments: `append` takes a single
      // event, and passing a second silently drops it — which made an earlier
      // version of this case assert "reported once" against a store that had
      // only ever seen one malformed marker.
      await store.append(markerEvent(1, 'runskein.dev/sessionMeta', 'not-an-object'));
      await store.append(markerEvent(2, 'runskein.dev/sessionMeta', 42));
      const sessions = await store.sessions();
      expect(sessions[0]!.cwd).toBe('');
      expect(reported).toHaveLength(1);
      expect(reported[0]).toEqual({ sessionId: 'session-1', seq: 1 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

/**
 * Step 10b of the runskein migration: the half of the pair a fixture cannot
 * establish.
 *
 * `SESSION_META_KEY` is the plugin's own literal, because `design.md` §12
 * forbids importing the producer's constant from `@runskein/core/internal`.
 * Nothing type-checks the two against each other, so a fixture built with the
 * same string tests one half against itself — and would stay green against a
 * store reading a marker no producer emits. That is not hypothetical: it is
 * how the pre-rename spelling survived a green suite.
 *
 * So this drives a real session over the testkit's scripted adapter, lets
 * runskein record whatever it records, and asserts against that. It cannot
 * exist before the bump: on the previous release the producer emits the legacy
 * key, and this case would be asserting the wrong agreement.
 */
describe('the session-meta marker the producer actually writes', () => {
  const open: TaskShuttleServer[] = [];
  afterEach(async () => { while (open.length > 0) await open.pop()!.close().catch(() => undefined); });

  it('projects the metadata a real session recorded, through the plugin-owned literal', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-r5-'));
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-r5-cwd-'));
    const plugin = createTaskShuttleServer({
      dataRoot,
      env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [tmpdir()] }), REALM_PLUGIN_LOG: 'off' } as NodeJS.ProcessEnv,
      hostCwd: tmpdir(),
      hubFactory: simulatedHubFactory({}),
    });
    open.push(plugin);
    await plugin.runtime.ready;

    // The runtime records the resolved path — on darwin `/var` is a symlink to
    // `/private/var`, so comparing against the unresolved one fails for a
    // reason that has nothing to do with markers.
    const resolvedCwd = await realpath(cwd);
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.output.sessionId as string;

    // Close first: the projection has to be read back from the *file*, and the
    // plugin holds the connection.
    await open.pop()!.close();

    const instances = await readdir(join(dataRoot, 'instances'));
    expect(instances).toHaveLength(1);
    const storePath = join(dataRoot, 'instances', instances[0]!, 'taskshuttle.sqlite');

    // The consumer half, and the reason this case is not `session_get`: that
    // tool answers from live runtime state, so it reports the right cwd
    // whatever marker the store reads — an earlier version of this case
    // asserted through it and stayed green with the store reading the legacy
    // key, which is precisely the hole 10b exists to close. `sessions()` is
    // the path that goes through `foldSessionMeta` and the plugin-owned
    // literal, against bytes runskein wrote.
    const reader = createPluginTranscriptStore(storePath);
    const projected = await reader.sessions();
    // One session, whatever id the engine gave it: the plugin's session id and
    // the engine's need not be the same string, and this case is about the
    // marker rather than about id mapping.
    expect(projected).toHaveLength(1);
    expect(projected[0]!.cwd).toBe(resolvedCwd);

    // And the producer half, which is the whole point: the key on disk is the
    // one this repository hard-codes. Asserted by *finding* it in a recorded
    // event rather than by writing it — if runskein renames the marker again,
    // this fails and the projection above fails with it, which is the pair
    // being checked rather than one side of it.
    const db = new DatabaseSync(storePath);
    try {
      // The column holds the canonical *bytes*, not a string — decoded the way
      // `decodeRow` does, because those bytes are what the digest covers and
      // what any other reader would see.
      const rows = db.prepare('SELECT event_json FROM transcript_events').all() as Array<{ event_json: Uint8Array }>;
      const metaKeys = new Set<string>();
      for (const row of rows) {
        const event = JSON.parse(Buffer.from(row.event_json).toString('utf8')) as { update?: { _meta?: Record<string, unknown> | null } };
        for (const key of Object.keys(event.update?._meta ?? {})) metaKeys.add(key);
      }
      expect([...metaKeys].some((key) => key.endsWith('/sessionMeta'))).toBe(true);
      expect(metaKeys).toContain('runskein.dev/sessionMeta');
      expect([...metaKeys].filter((key) => key.startsWith('realm.dev/'))).toEqual([]);
    } finally { db.close(); }
  }, 30_000);
});
