import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readOrphanRecords, reapOrphans, type OrphanIdentity, type OrphanKiller } from '../../packages/plugin/src/lifecycle.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

async function writeMarker(root: string, name: string, value: Record<string, unknown>): Promise<void> {
  const directory = join(root, 'orphans');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, name), JSON.stringify(value), { mode: 0o600 });
}

function killer(identity: OrphanIdentity, log: string[]): OrphanKiller {
  return {
    inspect: async () => identity,
    inspectGroup: async (processGroupId) => ({ exists: true, processGroupId, leaderPid: processGroupId }),
    termGroup: async (pgid) => { log.push(`term:${pgid}`); },
    killGroup: async (pgid) => { log.push(`kill:${pgid}`); },
    waitGroup: async () => true,
  };
}

describe('orphan markers', () => {
  it('ignores partial or malformed markers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-orphan-read-'));
    await writeMarker(root, 'complete.orphan.json', { pid: 4242, processGroupId: 4242, processStartedAt: 'start', exePath: '/usr/bin/node', instanceTokenHash: HASH_A });
    await writeMarker(root, 'no-identity.orphan.json', { pid: 99, processGroupId: 99, exePath: '/usr/bin/node', instanceTokenHash: HASH_A });
    await writeMarker(root, 'bad-hash.orphan.json', { pid: 98, processGroupId: 98, processStartedAt: 'start', exePath: '/usr/bin/node', instanceTokenHash: 'nope' });
    await writeMarker(root, 'ignored.json', { pid: 97, processGroupId: 97, processStartedAt: 'start', exePath: '/usr/bin/node', instanceTokenHash: HASH_A });
    const records = await readOrphanRecords(root);
    expect(records.map((entry) => entry.record.pid)).toEqual([4242]);
  });

  it('returns nothing when no orphan directory exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-orphan-empty-'));
    expect(await readOrphanRecords(root)).toEqual([]);
  });
});

describe('orphan reaping', () => {
  const record = { pid: 4242, processGroupId: 4242, processStartedAt: 'start', exePath: '/usr/bin/node', instanceTokenHash: HASH_A };

  it('reaps only shims owned by an instance whose lock was proven dead', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-orphan-reap-'));
    await writeMarker(root, 'worker.orphan.json', record);
    const log: string[] = [];
    const outcomes = await reapOrphans({
      markerRoots: [root],
      reapableTokenHashes: new Set([HASH_A]),
      killer: killer({ exists: true, processGroupId: 4242, processStartedAt: 'start', exePath: '/usr/bin/node', instanceTokenHash: HASH_A }, log),
    });
    expect(outcomes).toEqual([{ pid: 4242, outcome: 'reaped', markerRemoved: true }]);
    expect(log).toEqual(['term:4242']);
    await expect(stat(join(root, 'orphans', 'worker.orphan.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never touches a shim owned by a live instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-orphan-live-'));
    await writeMarker(root, 'worker.orphan.json', record);
    const log: string[] = [];
    const outcomes = await reapOrphans({
      markerRoots: [root],
      reapableTokenHashes: new Set([HASH_B]),
      killer: killer({ exists: true, processGroupId: 4242, processStartedAt: 'start', exePath: '/usr/bin/node', instanceTokenHash: HASH_A }, log),
    });
    expect(outcomes).toEqual([]);
    expect(log).toEqual([]);
    expect((await stat(join(root, 'orphans', 'worker.orphan.json'))).isFile()).toBe(true);
  });

  it('skips a process whose OS identity no longer matches the marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-orphan-mismatch-'));
    await writeMarker(root, 'worker.orphan.json', record);
    const log: string[] = [];
    const outcomes = await reapOrphans({
      markerRoots: [root],
      reapableTokenHashes: new Set([HASH_A]),
      killer: killer({ exists: true, processGroupId: 4242, processStartedAt: 'recycled', exePath: '/usr/bin/node', instanceTokenHash: HASH_A }, log),
    });
    expect(outcomes).toEqual([{ pid: 4242, outcome: 'skipped', markerRemoved: false }]);
    expect(log).toEqual([]);
  });

  it('skips when the OS cannot supply a full identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-orphan-unknown-'));
    await writeMarker(root, 'worker.orphan.json', record);
    const log: string[] = [];
    const outcomes = await reapOrphans({
      markerRoots: [root],
      reapableTokenHashes: new Set([HASH_A]),
      killer: killer({ exists: true }, log),
    });
    expect(outcomes[0]?.outcome).toBe('skipped');
    expect(log).toEqual([]);
  });
});
