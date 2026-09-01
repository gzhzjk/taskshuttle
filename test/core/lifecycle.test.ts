import { mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { InstanceManager, LifecycleManager, OrphanReaper, RetentionScheduler, recoverAndApplyRetention } from '../../packages/plugin/src/lifecycle.js';

describe('instance lifecycle', () => {
  it('creates a private instance manifest and lock, then closes idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-life-'));
    const manager = await InstanceManager.create({ dataRoot: root, rootNonce: 'a'.repeat(32), now: () => '2026-01-01T00:00:00.000Z' });
    expect((await stat(manager.instanceDir)).mode & 0o777).toBe(0o700);
    expect((await stat(manager.manifestPath)).mode & 0o777).toBe(0o600);
    expect((await stat(manager.lockPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(manager.manifestPath, 'utf8')).tokenHash).not.toContain('a'.repeat(32));
    await manager.close({ now: () => '2026-01-01T00:01:00.000Z' });
    await manager.close();
    await expect(stat(manager.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rewrites the display-only host label without touching the lock copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-life-host-'));
    const manager = await InstanceManager.create({ dataRoot: root, rootNonce: 'a'.repeat(32), now: () => '2026-01-01T00:00:00.000Z' });
    const lockBefore = await readFile(manager.lockPath, 'utf8');
    await manager.setHost('claude-code');
    expect(manager.getManifest().host).toBe('claude-code');
    const onDisk = JSON.parse(await readFile(manager.manifestPath, 'utf8'));
    expect(onDisk.host).toBe('claude-code');
    expect((await stat(manager.manifestPath)).mode & 0o777).toBe(0o600);
    // Host is display metadata, not recovery identity: the lock copy keeps the
    // original label, and recovery's lock/manifest comparison must not see a
    // mismatch (it never compares host).
    expect(await readFile(manager.lockPath, 'utf8')).toBe(lockBefore);
    await manager.close({ now: () => '2026-01-01T00:01:00.000Z' });
    expect(JSON.parse(await readFile(manager.manifestPath, 'utf8')).host).toBe('claude-code');
  });

  it('rejects host labels that are empty, overlong, or path/hostile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-life-host-bad-'));
    const manager = await InstanceManager.create({ dataRoot: root, rootNonce: 'a'.repeat(32) });
    for (const bad of ['', 'a'.repeat(65), 'bad/name', 'evil\nname', '../escape']) {
      await expect(manager.setHost(bad)).rejects.toThrow('invalid host label');
    }
    expect(manager.getManifest().host).toBe(process.platform);
    await manager.close();
  });

  it('recovers only a demonstrably dead lock and applies age-based retention', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-recovery-'));
    const old = await InstanceManager.create({ dataRoot: root, instanceId: '11111111-1111-4111-8111-111111111111', rootNonce: 'b'.repeat(32), pid: 999999, processStartedAt: 'old', exePath: '/old', now: () => '2020-01-01T00:00:00.000Z' });
    await writeFile(old.manifestPath, JSON.stringify({ ...old.getManifest(), closedAt: '2020-01-01T00:00:00.000Z' }) + '\n');
    const live = await InstanceManager.create({ dataRoot: root, instanceId: '22222222-2222-4222-8222-222222222222', rootNonce: 'c'.repeat(32), pid: 123, processStartedAt: 'live', exePath: '/live', now: () => '2026-01-01T00:00:00.000Z' });
    const results = await recoverAndApplyRetention({ dataRoot: root, now: Date.parse('2026-02-01T00:00:00.000Z'), retentionDays: 30, inspectProcess: async (pid) => pid === 999999 ? { exists: false } : { exists: true, processStartedAt: 'live', exePath: '/live' }, hooks: { deleteSessionsBefore: () => false } });
    expect(results.find((entry) => entry.instanceId === old.instanceId)).toMatchObject({ recovered: false, deleted: true });
    expect(results.find((entry) => entry.instanceId === live.instanceId)).toMatchObject({ recovered: false, reason: 'active' });
    await expect(stat(old.instanceDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await live.close();
  });

  it('does not recover when a lock and manifest disagree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-lock-mismatch-'));
    const manager = await InstanceManager.create({ dataRoot: root, instanceId: '33333333-3333-4333-8333-333333333333', rootNonce: 'd'.repeat(32), pid: 999998, processStartedAt: 'old', exePath: '/old', now: () => '2020-01-01T00:00:00.000Z' });
    await writeFile(manager.manifestPath, JSON.stringify({ ...manager.getManifest(), pid: 999997 }) + '\n');
    const results = await recoverAndApplyRetention({ dataRoot: root, now: Date.parse('2026-01-01T00:00:00.000Z'), retentionDays: 0, inspectProcess: async () => ({ exists: false }) });
    expect(results[0]).toMatchObject({ recovered: false, deleted: false, reason: 'identity-uncertain' });
    await manager.close();
  });

  it('uses one shutdown flight, calls Realm quit once, and never starts a second kill chain', async () => {
    const quit = vi.fn(async () => undefined);
    const events: string[] = [];
    const lifecycle = new LifecycleManager({
      hub: { quit },
      stopMutations: () => { events.push('stop'); },
      cancelQueuedTurns: () => { events.push('cancel'); },
      flush: () => { events.push('flush'); },
      closeStore: () => { events.push('store'); },
      releaseLock: () => { events.push('lock'); },
      deleteEligible: () => { events.push('delete'); },
    });
    const [first, second] = await Promise.all([lifecycle.shutdown(), lifecycle.shutdown()]);
    expect(first).toEqual(second);
    expect(first.status).toBe('closed');
    expect(quit).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledWith(undefined, { timeoutMs: 3_000 });
    expect(events).toEqual(['stop', 'cancel', 'flush', 'store', 'lock', 'delete']);
    expect(lifecycle.quitCount).toBe(1);
    expect(lifecycle.acceptsMutations).toBe(false);
  });

  it('still calls quit when an early shutdown step fails and reports the failure', async () => {
    const quit = vi.fn(async () => undefined);
    const lifecycle = new LifecycleManager({ hub: { quit }, stopMutations: () => { throw new Error('stop failed'); } });
    const result = await lifecycle.shutdown();
    expect(result.status).toBe('failed');
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('keeps ownership cleanup gated when Realm quit fails', async () => {
    const events: string[] = [];
    const lifecycle = new LifecycleManager({
      hub: { quit: async () => { throw new Error('quit failed'); } },
      releaseLock: () => { events.push('lock'); },
      deleteEligible: () => { events.push('delete'); },
    });
    const result = await lifecycle.shutdown();
    expect(result.status).toBe('failed');
    expect(events).toEqual([]);
  });

  it('reaps only an exactly identified orphan with one TERM then at most one KILL', async () => {
    const identity = { exists: true, processStartedAt: 't', instanceTokenHash: 'h', exePath: '/shim', processGroupId: 7 };
    const killer = { inspect: vi.fn(async () => identity), inspectGroup: vi.fn(async () => ({ exists: true, processGroupId: 7, leaderPid: 7 })), termGroup: vi.fn(async () => undefined), killGroup: vi.fn(async () => undefined), waitGroup: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true) };
    const reaper = new OrphanReaper(3_000);
    const record = { pid: 7, processGroupId: 7, processStartedAt: 't', instanceTokenHash: 'h', exePath: '/shim' };
    await expect(reaper.reap(record, { exists: true, processStartedAt: 'wrong', instanceTokenHash: 'h', exePath: '/shim' }, true, killer)).resolves.toBe('skipped');
    await expect(reaper.reap(record, identity, true, killer)).resolves.toBe('reaped');
    expect(killer.termGroup).toHaveBeenCalledTimes(1); expect(killer.killGroup).toHaveBeenCalledTimes(1);
  });

  it('takes over a recovery claim left behind by a crashed scanner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-recovery-lock-'));
    const dead = await InstanceManager.create({ dataRoot: root, instanceId: '88888888-8888-4888-8888-888888888888', rootNonce: 'e'.repeat(32), pid: 999_996, processStartedAt: 'old', exePath: '/old' });
    await writeFile(join(dead.instanceDir, 'recovery.lock'), JSON.stringify({ pid: 999_995, createdAt: new Date(0).toISOString() }) + '\n', { mode: 0o600 });
    const results = await recoverAndApplyRetention({
      dataRoot: root,
      now: Date.parse('2026-01-01T00:00:00.000Z'),
      retentionDays: null,
      inspectProcess: async () => ({ exists: false }),
      hooks: { markSessionsAborted: () => undefined },
    });
    expect(results[0]).toMatchObject({ instanceId: dead.instanceId, recovered: true, deleted: false, lockProvenDead: true });
    await expect(stat(join(dead.instanceDir, 'recovery.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a recovery claim whose owner is still alive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-recovery-contended-'));
    const dead = await InstanceManager.create({ dataRoot: root, instanceId: '99999999-9999-4999-8999-999999999999', rootNonce: 'f'.repeat(32), pid: 999_994, processStartedAt: 'old', exePath: '/old' });
    await writeFile(join(dead.instanceDir, 'recovery.lock'), JSON.stringify({ pid: 4242, createdAt: '2026-01-01T00:00:00.000Z' }) + '\n', { mode: 0o600 });
    const results = await recoverAndApplyRetention({
      dataRoot: root,
      now: Date.parse('2026-01-01T00:01:00.000Z'),
      retentionDays: null,
      inspectProcess: async (pid) => pid === 4242 ? { exists: true, processStartedAt: 'x', exePath: '/x' } : { exists: false },
      hooks: { markSessionsAborted: () => undefined },
    });
    expect(results[0]).toMatchObject({ recovered: false, reason: 'recovery-contended' });
    expect((await stat(join(dead.instanceDir, 'recovery.lock'))).isFile()).toBe(true);
  });

  it('restores an instance quarantined by a crashed recovery instead of losing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-recovery-quarantine-'));
    const instanceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const manager = await InstanceManager.create({ dataRoot: root, instanceId, rootNonce: '1'.repeat(32), pid: 999_993, processStartedAt: 'old', exePath: '/old' });
    const quarantine = join(root, 'instances', `.recovery-${instanceId}-abcd`);
    await rename(manager.instanceDir, quarantine);
    await writeFile(join(quarantine, 'recovery.lock'), JSON.stringify({ pid: 999_992, createdAt: new Date(0).toISOString() }) + '\n', { mode: 0o600 });
    const results = await recoverAndApplyRetention({
      dataRoot: root,
      now: Date.parse('2026-01-01T00:00:00.000Z'),
      retentionDays: null,
      inspectProcess: async () => ({ exists: false }),
      hooks: { markSessionsAborted: () => undefined },
    });
    expect(results.map((entry) => entry.instanceId)).toContain(instanceId);
    expect((await stat(join(root, 'instances', instanceId))).isDirectory()).toBe(true);
    await expect(stat(quarantine)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves a quarantined instance alone while its recovery claim is still held', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-recovery-quarantine-live-'));
    const instanceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const manager = await InstanceManager.create({ dataRoot: root, instanceId, rootNonce: '2'.repeat(32), pid: 999_991, processStartedAt: 'old', exePath: '/old' });
    const quarantine = join(root, 'instances', `.recovery-${instanceId}-live`);
    await rename(manager.instanceDir, quarantine);
    await writeFile(join(quarantine, 'recovery.lock'), JSON.stringify({ pid: 4242, createdAt: '2026-01-01T00:00:00.000Z' }) + '\n', { mode: 0o600 });
    const marks: string[] = [];
    const results = await recoverAndApplyRetention({
      dataRoot: root,
      now: Date.parse('2026-01-01T00:01:00.000Z'),
      retentionDays: null,
      inspectProcess: async (pid) => pid === 4242 ? { exists: true, processStartedAt: 'x', exePath: '/x' } : { exists: false },
      hooks: { markSessionsAborted: (id) => { marks.push(id); } },
    });
    expect(results).toEqual([]);
    expect(marks).toEqual([]);
    expect((await stat(join(quarantine, 'recovery.lock'))).isFile()).toBe(true);
    await expect(stat(join(root, 'instances', instanceId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('schedules retention at a fixed 24 hour cadence without duplicate timers', async () => {
    let now = 0; const timers = new Map<number, () => void>(); let next = 0; let runs = 0; const delays: number[] = [];
    const clock = { now: () => now, setTimeout: (cb: () => void, ms: number) => { delays.push(ms); const id = ++next; timers.set(id, cb); return id; }, clearTimeout: (id: unknown) => { timers.delete(id as number); } };
    const scheduler = new RetentionScheduler(clock, () => { runs += 1; }); scheduler.start(); scheduler.start();
    const firstEntry = timers.entries().next().value as [number, () => void]; timers.delete(firstEntry[0]); firstEntry[1](); now += 86_400_000;
    for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
    expect(runs).toBe(1); expect(timers.size).toBe(1); expect(delays).toEqual([86_400_000, 86_400_000]);
    scheduler.stop(); expect(timers.size).toBe(0);
  });

  it('re-arms soon when a retention pass reports it was skipped', async () => {
    const timers = new Map<number, () => void>(); let next = 0; const delays: number[] = [];
    const clock = { now: () => 0, setTimeout: (cb: () => void, ms: number) => { delays.push(ms); const id = ++next; timers.set(id, cb); return id; }, clearTimeout: (id: unknown) => { timers.delete(id as number); } };
    const scheduler = new RetentionScheduler(clock, () => false, 86_400_000, () => undefined, 60_000);
    scheduler.start();
    const firstEntry = timers.entries().next().value as [number, () => void]; timers.delete(firstEntry[0]); firstEntry[1]();
    for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
    expect(delays).toEqual([86_400_000, 60_000]);
    scheduler.stop();
  });
});
