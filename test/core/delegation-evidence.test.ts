// SEC-REC-007..018 unit half (ADR 0031): the bounded ancestry walk, the one
// composition rule, and the record snapshot ([ADR 0033] replaced the live-lock
// snapshot with it, and owns SEC-REC-019..027 in delegation-records.test.ts), driven through the injected
// AncestryProbe so a whole synthetic process tree is exercised without
// spawning anything. Consumer-level behaviour lives in
// delegation-consumers.test.ts and delegation-spawned.test.ts.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  MAX_ANCESTRY_HOPS,
  composeDelegation,
  consoleAllowed,
  isDelegated,
  readInstanceRecords,
  settleDelegation,
  walkAncestry,
  type AncestryProbe,
  type InstanceRecord,
} from '../../packages/plugin/src/delegation-evidence.js';
import { startTimeFamily, processStartTime, parentProcessId } from '../../packages/plugin/src/lifecycle.js';
import { readDelegationIdentity, type DelegationIdentity } from '../../packages/plugin/src/security-policy.js';

const ROOT_MARKER: DelegationIdentity = readDelegationIdentity({} as NodeJS.ProcessEnv);

describe('SEC-REC-028 renamed delegation marker', () => {
  it('accepts the TaskShuttle marker before the legacy compatibility read', () => {
    const identity = readDelegationIdentity({
      TASKSHUTTLE_DELEGATION_VERSION: '1',
      TASKSHUTTLE_DELEGATION_DEPTH: '1',
      TASKSHUTTLE_DELEGATION_ROOT: 'a'.repeat(32),
    } as NodeJS.ProcessEnv);
    expect(identity).toMatchObject({ depth: 1, recursionDenied: true });
  });
});

interface ProbeNode { readonly parent: number | undefined; readonly startedAt?: string }

/** A synthetic process table; counts parentOf calls so the cycle rule stays observable. */
function probe(nodes: Readonly<Record<number, ProbeNode>>): AncestryProbe & { parentOfCalls(): number } {
  let parentOfCalls = 0;
  return {
    parentOfCalls: () => parentOfCalls,
    async parentOf(pid) { parentOfCalls += 1; return nodes[pid]?.parent; },
    async startedAt(pid) { return nodes[pid]?.startedAt; },
  };
}

function instance(pid: number, startedAt: string, delegation: InstanceRecord['delegation']): InstanceRecord {
  return { instanceId: `inst-${pid}`, pid, processStartedAt: startedAt, delegation };
}

const recordedRoot = { kind: 'recorded', record: { provenance: 'root' as const, depth: 0 } } as const;

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'taskshuttle-delegation-evidence-'));
}

/** Writes one instance directory the way `readInstanceRecords` reads it back. */
async function writeInstanceDir(dataRoot: string, name: string, lock: Record<string, unknown>, manifest?: string): Promise<void> {
  const dir = join(dataRoot, 'instances', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'instance.lock'), `${JSON.stringify(lock)}\n`);
  if (manifest !== undefined) await writeFile(join(dir, 'instance.json'), manifest);
}

describe('walkAncestry (SEC-REC-001/009/010/011)', () => {
  // SEC-REC-011, the migration half. The whole boundary fails **open** without
  // this: a lock written before the identity helpers converged carries an ISO
  // timestamp on darwin, the live reading is a `ps` date, the strict compare
  // finds no match, and the walk sails past a real ancestor to pid 1 and answers
  // `root` — the console opens and session_create is admitted, which is the
  // defect ADR 0031 exists to close. No mutation in the acceptance battery
  // covered this branch, so it went in with the rest of the guard untested.
  it('an ancestor whose stored start time is in another format is doubt, not a miss', async () => {
    const p = probe({ 100: { parent: 50 }, 50: { parent: 1, startedAt: 'Wed Aug 26 10:00:00 2026' } });
    const legacy = [instance(50, '2026-08-26T08:00:00.000Z', recordedRoot)];
    expect(await walkAncestry({ pid: 100, instances: legacy, probe: p })).toEqual({ provenance: 'unavailable' });
  });

  it('a same-format mismatch is a proven different process, so the walk goes on', async () => {
    const p = probe({ 100: { parent: 50 }, 50: { parent: 1, startedAt: 'Wed Aug 26 10:00:00 2026' } });
    // Same family, different value: pid 50 really is not that instance, and
    // answering `unavailable` here would withhold every console on a recycled
    // pid. The guard has to be narrow enough to still let this reach root.
    const other = [instance(50, 'Tue Aug 25 09:00:00 2026', recordedRoot)];
    expect(await walkAncestry({ pid: 100, instances: other, probe: p })).toEqual({ provenance: 'root', depth: 0 });
  });

  it('a chain that reaches pid 1 with no matching lock answers root at depth 0', async () => {
    const p = probe({ 100: { parent: 50 }, 50: { parent: 1 } });
    const verdict = await walkAncestry({ pid: 100, instances: [], probe: p });
    expect(verdict).toEqual({ provenance: 'root', depth: 0 });
    // Termination is reaching pid 1, not exhausting hops: both parents were read.
    expect(p.parentOfCalls()).toBe(2);
  });

  it('the bound is the exported 32 hops, and exceeding it is unavailable — never root', async () => {
    expect(MAX_ANCESTRY_HOPS).toBe(32);
    // A chain longer than any bound the case can set: every step readable, no
    // match, terminating at pid 1 so only the bound can stop it early.
    const nodes: Record<number, ProbeNode> = {};
    for (let pid = 1000; pid > 901; pid -= 1) nodes[pid] = { parent: pid - 1 };
    nodes[901] = { parent: 1 };
    const bounded = await walkAncestry({ pid: 1000, instances: [], probe: probe(nodes), maxHops: 3 });
    expect(bounded).toEqual({ provenance: 'unavailable' });
    // The same chain, given enough hops, finishes normally — so the verdict
    // above came from the bound and not from the chain's shape.
    const unbounded = await walkAncestry({ pid: 1000, instances: [], probe: probe(nodes), maxHops: 200 });
    expect(unbounded).toEqual({ provenance: 'root', depth: 0 });
  });

  it('an ancestor matches only on pid AND start time; a recycled pid is a coincidence (SEC-REC-010)', async () => {
    // The lock says T1; the live process answers T2 — the pid was reused.
    const p = probe({ 100: { parent: 50 }, 50: { parent: 1, startedAt: 'T2' } });
    const instances = [instance(50, 'T1', recordedRoot)];
    const verdict = await walkAncestry({ pid: 100, instances, probe: p });
    expect(verdict).toEqual({ provenance: 'root', depth: 0 });
  });

  it('the nearest matching ancestor wins (ADR 0031 decision 2)', async () => {
    const p = probe({ 100: { parent: 60 }, 60: { parent: 50, startedAt: 'T60' }, 50: { parent: 1, startedAt: 'T50' } });
    const instances = [
      instance(50, 'T50', { kind: 'recorded', record: { provenance: 'root', depth: 0 } }),
      instance(60, 'T60', { kind: 'recorded', record: { provenance: 'marker', depth: 5 } }),
    ];
    const verdict = await walkAncestry({ pid: 100, instances, probe: p });
    // The closest instance (60) applies: its depth plus one.
    expect(verdict).toEqual({ provenance: 'ancestry', depth: 6 });
  });

  it('a matched ancestor whose start time cannot be read yields unavailable, not a pid-only match', async () => {
    const p = probe({ 100: { parent: 50 }, 50: { parent: 1 } });
    const instances = [instance(50, 'T1', recordedRoot)];
    // startedAt(50) returns undefined: no exact match is possible.
    const verdict = await walkAncestry({
      pid: 100,
      instances,
      probe: { parentOf: p.parentOf, async startedAt() { return undefined; } },
    });
    expect(verdict).toEqual({ provenance: 'unavailable' });
  });

  it('a parent that dies between its ppid read and its identity read is doubt (SEC-REC-011)', async () => {
    const p = probe({ 100: { parent: 50 }, 50: { parent: undefined } });
    const verdict = await walkAncestry({ pid: 100, instances: [], probe: p });
    expect(verdict).toEqual({ provenance: 'unavailable' });
  });

  it('a failed snapshot itself is unavailable — never evidence of being a root', async () => {
    const p = probe({ 100: { parent: 1 } });
    const verdict = await walkAncestry({ pid: 100, instances: undefined, probe: p });
    expect(verdict).toEqual({ provenance: 'unavailable' });
  });

  it('a cycle is refused before the hop bound burns, which is what makes the refusal observable', async () => {
    // 101 -> 102 -> 101 forever. With the seen-check the walk visits two pids;
    // without it the bound consumes all hops answering the same verdict, and
    // only the probe-call count tells the difference.
    const p = probe({ 100: { parent: 101 }, 101: { parent: 102 }, 102: { parent: 101 } });
    const verdict = await walkAncestry({ pid: 100, instances: [], probe: p });
    expect(verdict).toEqual({ provenance: 'unavailable' });
    expect(p.parentOfCalls()).toBeLessThanOrEqual(4);
  });

  it('an ancestor whose own verdict was unavailable cannot lend a depth (ADR 0031 decision 7)', async () => {
    const p = probe({ 100: { parent: 50 }, 50: { parent: 1 } });
    const instances = [instance(50, 'T1', { kind: 'recorded', record: { provenance: 'unavailable' } })];
    const verdict = await walkAncestry({ pid: 100, instances, probe: p });
    expect(verdict).toEqual({ provenance: 'unavailable' });
  });
});

describe('ancestor manifests (SEC-REC-016)', () => {
  it('a legacy manifest — no delegation object at all — makes this instance depth 1', async () => {
    const verdict = await walkAncestry({
      pid: 100,
      instances: [instance(50, 'T1', { kind: 'legacy' })],
      probe: probe({ 100: { parent: 50 }, 50: { parent: 1, startedAt: 'T1' } }),
    });
    expect(verdict).toEqual({ provenance: 'ancestry', depth: 1 });
  });

  it('a corrupt delegation object is unavailable — a corrupt file may not manufacture a root', async () => {
    for (const bad of [
      { kind: 'unreadable' },
      { kind: 'recorded', record: { provenance: 'root' } }, // root-shaped but depthless: fails validation upstream
    ] as InstanceRecord['delegation'][]) {
      const verdict = await walkAncestry({ pid: 100, instances: [instance(50, 'T1', bad)], probe: probe({ 100: { parent: 50 }, 50: { parent: 1, startedAt: 'T1' } }) });
      expect(verdict).toEqual({ provenance: 'unavailable' });
    }
  });
});

describe('composeDelegation (SEC-REC-012)', () => {
  const delegatedMarker: DelegationIdentity = { ...ROOT_MARKER, depth: 3, recursionDenied: true };

  it('a marker that says delegated is not downgraded by an ancestry read that failed', () => {
    expect(composeDelegation(delegatedMarker, { provenance: 'unavailable' })).toEqual({ provenance: 'marker', depth: 3 });
    expect(composeDelegation(delegatedMarker, { provenance: 'root', depth: 0 })).toEqual({ provenance: 'marker', depth: 3 });
  });

  it('with a root marker the ancestry record stands as concluded', () => {
    expect(composeDelegation(ROOT_MARKER, { provenance: 'ancestry', depth: 2 })).toEqual({ provenance: 'ancestry', depth: 2 });
    expect(composeDelegation(ROOT_MARKER, { provenance: 'unavailable' })).toEqual({ provenance: 'unavailable' });
    expect(composeDelegation(ROOT_MARKER, { provenance: 'root', depth: 0 })).toEqual({ provenance: 'root', depth: 0 });
  });

  it('settleDelegation short-circuits on positive marker evidence — the walk never runs', async () => {
    let probeCalls = 0;
    const verdict = await settleDelegation({
      marker: delegatedMarker,
      dataRoot: await tempRoot(),
      // A worker told by its marker should not pay a process-table scan. A
      // thrown probe cannot witness this — settleDelegation belts the walk in
      // its own catch — so the observation is a call count instead.
      probe: {
        async parentOf() { probeCalls += 1; return undefined; },
        async startedAt() { probeCalls += 1; return undefined; },
      },
    });
    expect(probeCalls).toBe(0);
    expect(verdict).toEqual({ provenance: 'marker', depth: 3 });
  });

  it('settleDelegation integrates the real snapshot reader with the injected walk', async () => {
    const dataRoot = await tempRoot();
    await writeInstanceDir(dataRoot, 'aaaa-bbbb', { instanceId: 'aaaa-bbbb', pid: 50, processStartedAt: 'T1' }, JSON.stringify({ instanceId: 'aaaa-bbbb' }));
    const verdict = await settleDelegation({
      marker: ROOT_MARKER,
      dataRoot,
      pid: 100,
      probe: probe({ 100: { parent: 50 }, 50: { parent: 1, startedAt: 'T1' } }),
    });
    // The ancestor's manifest carries no delegation object: legacy root, so depth 1.
    expect(verdict).toEqual({ provenance: 'ancestry', depth: 1 });
  });
});

describe('readInstanceRecords', () => {
  it('a missing or empty instances directory is an empty answer: nothing is running', async () => {
    const absent = await tempRoot();
    expect(await readInstanceRecords(absent)).toEqual([]);
    const dataRoot = await tempRoot();
    await mkdir(join(dataRoot, 'instances'), { recursive: true }); // present but empty
    expect(await readInstanceRecords(dataRoot)).toEqual([]);
  });

  it('temp and removal directories are filtering, not partial enumeration', async () => {
    const dataRoot = await tempRoot();
    await mkdir(join(dataRoot, 'instances', '.tmp-garbage'), { recursive: true });
    await writeFile(join(dataRoot, 'instances', '.tmp-garbage', 'instance.lock'), 'not json');
    expect(await readInstanceRecords(dataRoot)).toEqual([]);
  });

  it('entries that yield no identity are skipped, not treated as records or doubt', async () => {
    const dataRoot = await tempRoot();
    await writeInstanceDir(dataRoot, 'pid-zero', { instanceId: 'pid-zero', pid: 0, processStartedAt: 'T1' });
    await writeInstanceDir(dataRoot, 'no-start-time', { instanceId: 'no-start-time', pid: 51 });
    await writeInstanceDir(dataRoot, 'empty-start-time', { instanceId: 'empty-start-time', pid: 52, processStartedAt: '' });
    await writeInstanceDir(dataRoot, 'idless', { pid: 53, processStartedAt: 'T3' });
    expect(await readInstanceRecords(dataRoot)).toEqual([]);
  });

  it('the manifest that supplied the record decides its delegation kind', async () => {
    const dataRoot = await tempRoot();
    const identity = (name: string): Record<string, unknown> => ({ instanceId: name, pid: 60, processStartedAt: 'T' });
    const cases: Array<[string, Record<string, unknown>, InstanceRecord['delegation']]> = [
      // Legacy means the manifest exists but predates the field entirely — not
      // a missing manifest file, which after ADR 0033 falls back to the lock.
      ['legacy-one', {}, { kind: 'legacy' }],
      ['recorded-one', { delegation: { provenance: 'root', depth: 0 } }, { kind: 'recorded', record: { provenance: 'root', depth: 0 } }],
      ['unavail-one', { delegation: { provenance: 'unavailable' } }, { kind: 'recorded', record: { provenance: 'unavailable' } }],
      ['unknown-provenance', { delegation: { provenance: 'malformed' } }, { kind: 'unreadable' }],
      ['depth-on-unavailable', { delegation: { provenance: 'unavailable', depth: 0 } }, { kind: 'unreadable' }],
      ['negative-depth', { delegation: { provenance: 'marker', depth: -1 } }, { kind: 'unreadable' }],
    ];
    for (const [name, extra] of cases) {
      // The manifest carries the identity, so it is the file that supplies the
      // record and therefore the file whose delegation object is read.
      await writeInstanceDir(dataRoot, name, identity(name), JSON.stringify({ ...identity(name), ...extra }));
    }
    const snapshot = await readInstanceRecords(dataRoot);
    expect(snapshot).toBeDefined();
    const byName = new Map(snapshot!.map((entry) => [entry.instanceId, entry]));
    expect(byName.size).toBe(cases.length);
    for (const [name, , expected] of cases) expect(byName.get(name)?.delegation).toEqual(expected);
  });
});

describe('verdict predicates and the canonical identity helpers', () => {
  it('isDelegated accepts exactly the two provenances that assert delegation', () => {
    expect(isDelegated({ provenance: 'marker', depth: 1 })).toBe(true);
    expect(isDelegated({ provenance: 'ancestry', depth: 1 })).toBe(true);
    expect(isDelegated({ provenance: 'root', depth: 0 })).toBe(false);
    expect(isDelegated({ provenance: 'unavailable' })).toBe(false);
  });

  it('consoleAllowed is root-only: unavailable keeps the console down while tools serve', () => {
    expect(consoleAllowed({ provenance: 'root', depth: 0 })).toBe(true);
    expect(consoleAllowed({ provenance: 'marker', depth: 1 })).toBe(false);
    expect(consoleAllowed({ provenance: 'ancestry', depth: 1 })).toBe(false);
    expect(consoleAllowed({ provenance: 'unavailable' })).toBe(false);
  });

  it('startTimeFamily separates the formats whose comparison would otherwise lie', () => {
    expect(startTimeFamily('4811027')).toBe('ticks');
    expect(startTimeFamily('2026-08-26T10:00:00.000Z')).toBe('legacy-iso');
    expect(startTimeFamily('Wed Aug 26 10:00:00 2026')).toBe('lstart');
    expect(startTimeFamily(undefined)).toBeUndefined();
    expect(startTimeFamily('')).toBeUndefined();
  });

  it('the canonical start-time helper answers for a live pid in the family its platform produces', async () => {
    // darwin/linux matrix only (ADR 0014); elsewhere this would be undefined
    // and the boundary records absent rather than manufacturing a value.
    const started = await processStartTime(process.pid);
    if (!['linux', 'darwin'].includes(process.platform)) return;
    expect(started).toBeDefined();
    expect(['ticks', 'lstart']).toContain(startTimeFamily(started));
    const parent = await parentProcessId(process.pid);
    expect(parent === undefined || parent > 0).toBe(true);
  });
});
