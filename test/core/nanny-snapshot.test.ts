import { chmod, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { NannySnapshotWriter, nannySnapshotPath, readNannySnapshot } from '../../packages/plugin/src/nanny-snapshot.js';
import { SessionRegistry } from '../../packages/core/src/registry.js';

const prompt = [{ type: 'text' as const, text: 'secret plan the snapshot must never carry' }];

interface Harness {
  readonly dir: string;
  readonly registry: SessionRegistry;
  readonly writer: NannySnapshotWriter;
  readonly errors: unknown[];
  /** Advances the stand-in runtime counter, as `turn_start` does. */
  readonly dispatch: () => void;
  readonly path: string;
}

async function harness(instanceId = 'instance-1'): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'taskshuttle-nanny-'));
  const errors: unknown[] = [];
  let tick = 0;
  // The runtime owns the registry's single observer slot and fans out to extra
  // observers; the same indirection is what lets the writer be built after the
  // registry it reads.
  let writer: NannySnapshotWriter | undefined;
  const registry = new SessionRegistry({
    instanceId,
    now: () => `2026-01-01T00:00:0${tick++}.000Z`,
    observer: {
      onSessionTransition: (event) => writer?.observer.onSessionTransition?.(event),
      onTurnTransition: (event) => writer?.observer.onTurnTransition?.(event),
      onInteractionTransition: (event) => writer?.observer.onInteractionTransition?.(event),
    },
  });
  // Stands in for the runtime's counter, which increments when `turn_start`
  // accepts a turn — before the registry transition the observer sees.
  let dispatched = 0;
  writer = new NannySnapshotWriter({
    instanceId,
    instanceDir: dir,
    source: registry,
    turnsDispatched: () => dispatched,
    now: () => '2026-01-01T00:00:00.000Z',
    onError: (error) => errors.push(error),
  });
  const dispatch = (): void => { dispatched += 1; };
  return { dir, registry, writer, errors, dispatch, path: nannySnapshotPath(dir) };
}

function readySession(registry: SessionRegistry, id: string, cwd = '/tmp/project'): void {
  expect(registry.createSession({ id, engine: 'codex', cwd }).ok).toBe(true);
  expect(registry.markSessionReady(id, `taskshuttle-${id}`).ok).toBe(true);
}

function finishTurn(registry: SessionRegistry, id: string): void {
  expect(registry.claimTerminalCAS(id, { state: 'completed' }).ok).toBe(true);
  expect(registry.markPromptSettled(id).ok).toBe(true);
  expect(registry.markStoreDrained(id).ok).toBe(true);
  expect(registry.finishTurnCAS(id).ok).toBe(true);
}

describe('nanny snapshot writer', () => {
  it('reports non-terminal turns with their session cwd, and drops them once terminal', async () => {
    const { registry, writer, dispatch, path } = await harness('runtime-instance');
    readySession(registry, 's1', '/tmp/workspace-a');
    dispatch();
    registry.createTurn('s1', { id: 't1', prompt });
    registry.startTurn('t1');
    await writer.settled();

    const running = await readNannySnapshot(path);
    expect(running).toMatchObject({
      instanceId: 'runtime-instance',
      updatedAt: '2026-01-01T00:00:00.000Z',
      turnsDispatched: 1,
      pendingInteractions: [],
    });
    expect(running?.active).toEqual([
      { turnId: 't1', sessionId: 's1', engine: 'codex', state: 'running', cwd: '/tmp/workspace-a', startedAt: expect.any(String) },
    ]);

    finishTurn(registry, 't1');
    await writer.settled();
    // Both directions matter: a writer that only ever appends would pass the
    // first assertion and still leave the hook blocking forever.
    expect((await readNannySnapshot(path))?.active).toEqual([]);
  });

  it('lists pending interactions with expiry and forgets them once resolved', async () => {
    const { registry, writer, path } = await harness();
    readySession(registry, 's1');
    registry.createTurn('s1', { id: 't1', prompt });
    registry.startTurn('t1');
    const interaction = registry.addInteraction('t1', { id: 'i1', kind: 'permission', payload: { tool: 'write' }, expiresAt: '2026-01-01T00:05:00.000Z' });
    expect(interaction.ok).toBe(true);
    await writer.settled();
    expect((await readNannySnapshot(path))?.pendingInteractions).toEqual([
      { interactionId: 'i1', turnId: 't1', kind: 'permission', expiresAt: '2026-01-01T00:05:00.000Z' },
    ]);

    expect(registry.resolveInteractionCAS('i1', 'responded').ok).toBe(true);
    await writer.settled();
    expect((await readNannySnapshot(path))?.pendingInteractions).toEqual([]);
  });

  it('publishes the runtime counter rather than one of its own, and never decreases', async () => {
    const { registry, writer, dispatch, path } = await harness();
    readySession(registry, 's1');
    dispatch();
    registry.createTurn('s1', { id: 't1', prompt });
    registry.startTurn('t1');
    // An interaction round-trip re-enters `running`; it is not a new dispatch.
    registry.addInteraction('t1', { id: 'i1', kind: 'question', payload: {} });
    registry.resolveInteractionCAS('i1', 'responded');
    finishTurn(registry, 't1');
    dispatch();
    registry.createTurn('s1', { id: 't2', prompt });
    registry.startTurn('t2');
    finishTurn(registry, 't2');
    await writer.settled();

    // Both turns are terminal, so a count derived from the turn records would
    // still be right here — it is the eviction of those records that would
    // silently deflate it (ADR 0016), which is why the count comes from a
    // counter and not from the registry.
    expect(writer.turnsDispatched).toBe(2);
    expect((await readNannySnapshot(path))?.turnsDispatched).toBe(2);
    expect((await readNannySnapshot(path))?.active).toEqual([]);
  });

  it('publishes a turn accepted but not yet dispatched, so the difference cannot read low', async () => {
    const { registry, writer, dispatch, path } = await harness();
    readySession(registry, 's1');
    // The anchor captured `turnsAtWrite` here. A turn is then accepted and sits
    // queued: the hook must see 1, not 0. A writer counting `queued -> running`
    // would report 0 while the anchor's reading had already moved on, and
    // `turnsDispatched - turnsAtWrite` would go negative — forbidden outright.
    const atWrite = writer.turnsDispatched;
    dispatch();
    registry.createTurn('s1', { id: 't1', prompt });
    await writer.settled();

    expect((await readNannySnapshot(path))?.turnsDispatched).toBe(atWrite + 1);
  });

  it('carries no prompt text, and leaves the file private with no temp files behind', async () => {
    const { dir, registry, writer, path } = await harness();
    readySession(registry, 's1');
    registry.createTurn('s1', { id: 't1', prompt });
    registry.startTurn('t1');
    await writer.settled();

    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('secret plan');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['nanny.json']);
  });

  it('merges transitions that arrive during a write, so the newest state lands last', async () => {
    const { registry, writer, path } = await harness();
    readySession(registry, 's1');
    registry.createTurn('s1', { id: 't1', prompt });
    registry.startTurn('t1');
    // Let the first write start, then transition again while it is in flight:
    // this is the interleaving where an unserialised writer can rename a stale
    // snapshot over a fresh one.
    await Promise.resolve();
    finishTurn(registry, 't1');
    await writer.settled();

    const snapshot = await readNannySnapshot(path);
    expect(snapshot?.active).toEqual([]);
    // Merged, not queued: far fewer writes than transitions.
    expect(snapshot?.seq).toBeLessThanOrEqual(2);
  });

  it('keeps the previous snapshot when a write fails, and reports the failure', async () => {
    const { dir, registry, writer, errors, path } = await harness();
    readySession(registry, 's1');
    registry.createTurn('s1', { id: 't1', prompt });
    registry.startTurn('t1');
    await writer.settled();
    const before = await readFile(path, 'utf8');

    await chmod(dir, 0o500);
    try {
      finishTurn(registry, 't1');
      await writer.settled();
      // Stale beats empty: an unreadable or truncated snapshot makes the hook
      // fail open, so a failed write must not destroy what was there.
      expect(await readFile(path, 'utf8')).toBe(before);
      expect(errors).toHaveLength(1);
    } finally {
      await chmod(dir, 0o700);
    }

    // The lane recovers: the next transition writes again.
    registry.createTurn('s1', { id: 't2', prompt });
    registry.startTurn('t2');
    await writer.settled();
    expect((await readNannySnapshot(path))?.active).toEqual([
      { turnId: 't2', sessionId: 's1', engine: 'codex', state: 'running', cwd: '/tmp/project', startedAt: expect.any(String) },
    ]);
  });

  it('reports a projection failure instead of rejecting the write lane', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskshuttle-nanny-project-'));
    const errors: unknown[] = [];
    const writer = new NannySnapshotWriter({
      instanceId: 'i1',
      instanceDir: dir,
      // `listInteractions()` clones engine-supplied payloads and can throw; the
      // lane is awaited by close(), so a rejection here would surface as an
      // unhandled one far from its cause.
      source: {
        listTurns: () => [],
        listInteractions: () => { throw new Error('unclonable payload'); },
        getSession: () => undefined,
      },
      turnsDispatched: () => 0,
      onError: (error) => errors.push(error),
    });
    writer.observer.onTurnTransition?.({ turnId: 't1', sessionId: 's1', engine: 'codex', priority: 'normal', from: 'queued', to: 'running', operation: 'turn/dispatch' });
    await expect(writer.settled()).resolves.toBeUndefined();
    expect(errors).toEqual([expect.objectContaining({ message: 'unclonable payload' })]);
    expect(await readNannySnapshot(nannySnapshotPath(dir))).toBeUndefined();
  });

  it('treats a missing, truncated or foreign snapshot as absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskshuttle-nanny-read-'));
    const path = nannySnapshotPath(dir);
    expect(await readNannySnapshot(path)).toBeUndefined();

    await writeFile(path, '{"instanceId":"i","updatedAt":"t","seq":1,"turnsDis', { mode: 0o600 });
    expect(await readNannySnapshot(path)).toBeUndefined();

    // Well-formed JSON of the wrong shape is corruption too — the hook must
    // not act on a snapshot whose fields it cannot trust.
    await writeFile(path, JSON.stringify({ instanceId: 'i', updatedAt: 't', seq: 1, active: [], pendingInteractions: [] }), { mode: 0o600 });
    expect(await readNannySnapshot(path)).toBeUndefined();
  });

  it('stops writing after close, but still lands the work already flagged', async () => {
    const { registry, writer, path } = await harness();
    readySession(registry, 's1');
    registry.createTurn('s1', { id: 't1', prompt });
    registry.startTurn('t1');
    finishTurn(registry, 't1');
    await writer.close();
    const closed = await readNannySnapshot(path);
    expect(closed?.active).toEqual([]);

    registry.createTurn('s1', { id: 't2', prompt });
    registry.startTurn('t2');
    await writer.settled();
    expect((await readNannySnapshot(path))?.seq).toBe(closed?.seq);
  });
});
