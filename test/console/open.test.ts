import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { asInstanceIdentity, narrowToCallerTree, runConsoleOpen, findConsoleCandidates, KINSHIP_BUDGET_MS } from '../../packages/plugin/src/console/open.js';
import type { ConsoleCandidate } from '../../packages/plugin/src/console/open.js';
import { InstanceManager } from '../../packages/plugin/src/lifecycle.js';
import type { ProcessInspector } from '../../packages/plugin/src/lifecycle.js';

/**
 * `console open` candidate selection (console-design §8.2, CONSOLE-021).
 * The opener is always a stub here — a test must never spawn a real browser.
 */

const dirs: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'taskshuttle-console-open-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

/**
 * An instance whose lock is alive under the §4 rules: the current process owns
 * it. The manifest deliberately keeps a pre-ADR-0030 `token` field: §7.3 says
 * a reader meeting one ignores the field rather than rejecting the file, and a
 * fixture written in the new shape would never exercise that.
 */
async function liveInstance(dataRoot: string, instanceId: string, port: number, legacyToken: string): Promise<InstanceManager> {
  const manager = await InstanceManager.create({ dataRoot, instanceId, rootNonce: 'a'.repeat(32), pid: process.pid });
  await writeFile(join(manager.instanceDir, 'console.json'), JSON.stringify({ port, token: legacyToken, startedAt: '2026-01-01T00:00:00.000Z' }) + '\n', { mode: 0o600 });
  return manager;
}

/** A crashed instance: lock present, owner pid beyond the platform's pid range. */
async function deadInstance(dataRoot: string, instanceId: string, port: number): Promise<void> {
  const manager = await InstanceManager.create({ dataRoot, instanceId, rootNonce: 'b'.repeat(32), pid: 999_999_999, processStartedAt: 'old', exePath: '/old' });
  await writeFile(join(manager.instanceDir, 'console.json'), JSON.stringify({ port, token: 'deadbeef'.repeat(4), startedAt: '2026-01-01T00:00:00.000Z' }) + '\n', { mode: 0o600 });
}

describe('console open (§8.2)', () => {
  it('opens the single live console at a credential-free URL, ignoring a legacy token', async () => {
    const root = await tempRoot();
    await liveInstance(root, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 51111, 't0ken'.repeat(6));
    const opened: string[] = [];
    const lines: string[] = [];
    const result = await runConsoleOpen({
      probe: async () => true,
      dataRoot: root,
      opener: async (url) => { opened.push(url); },
      out: (line) => lines.push(line),
    });
    expect(result).toMatchObject({ kind: 'opened', exitCode: 0, instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', port: 51111 });
    // §7.3: the URL is the bare address — the legacy field reaches neither it
    // nor the reported line.
    expect(opened).toEqual(['http://127.0.0.1:51111/']);
    expect(lines.join('\n')).not.toContain('t0ken');
    expect(lines.join('\n')).toContain('127.0.0.1:51111');
  });

  it('ignores instances whose lock is dead, without probing the port', async () => {
    const root = await tempRoot();
    await deadInstance(root, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 52222);
    const { candidates, stale } = await findConsoleCandidates(root);
    expect(candidates).toEqual([]);
    expect(stale).toBe(1);
  });

  it('distinguishes "not enabled" (no console.json) from "not listening" (stale manifests)', async () => {
    const empty = await tempRoot();
    const none = await runConsoleOpen({ dataRoot: empty, opener: async () => { throw new Error('must not open'); }, out: () => undefined });
    expect(none).toMatchObject({ kind: 'none-enabled', exitCode: 1 });

    const crashed = await tempRoot();
    await deadInstance(crashed, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 53333);
    const lines: string[] = [];
    const notListening = await runConsoleOpen({ dataRoot: crashed, opener: async () => { throw new Error('must not open'); }, out: (line) => lines.push(line) });
    expect(notListening).toMatchObject({ kind: 'not-listening', exitCode: 1, stale: 1 });
    // The wording may not assert a cause — several conditions reach `stale` —
    // so what is asserted is that the operator is told which state they are in
    // and how many entries are involved.
    expect(lines.join('\n')).toContain('not listening');
    expect(lines.join('\n')).toContain('1 console.json');
    expect(lines.join('\n')).not.toContain('deadbeef');
  });

  it('lists candidates and demands --instance when several consoles are live', async () => {
    const root = await tempRoot();
    await liveInstance(root, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 54444, 'first-token-aaaa');
    await liveInstance(root, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 55555, 'second-token-bbb');
    const lines: string[] = [];
    const result = await runConsoleOpen({ dataRoot: root, opener: async () => { throw new Error('must not open'); }, out: (line) => lines.push(line) });
    expect(result.kind).toBe('ambiguous');
    expect(result.exitCode).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    expect(text).toContain('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    expect(text).toContain('--instance=');
    expect(text).not.toContain('first-token');
    expect(text).not.toContain('second-token');
    // The ambiguous listing carries metadata only.
    if (result.kind === 'ambiguous') {
      expect(JSON.stringify(result.candidates)).not.toContain('token');
      expect(result.candidates.map((candidate) => candidate.port).sort()).toEqual([54444, 55555]);
    }
  });

  it('opens the instance named by --instance, by full id or unambiguous prefix', async () => {
    const root = await tempRoot();
    await liveInstance(root, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 54444, 'first-token-aaaa');
    await liveInstance(root, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 55555, 'second-token-bbb');
    const opened: string[] = [];
    const probed: Array<{ port: number; instanceId: string }> = [];
    const result = await runConsoleOpen({
      dataRoot: root,
      instance: 'eeeeeeee',
      probe: async (port, instanceId) => { probed.push({ port, instanceId }); return true; },
      opener: async (url) => { opened.push(url); },
      out: () => undefined,
    });
    expect(result).toMatchObject({ kind: 'opened', exitCode: 0, port: 55555 });
    expect(opened).toEqual(['http://127.0.0.1:55555/']);
    // §8.2 compares the id of the candidate whose console.json named the port,
    // so the probe is asked about that pair and not merely about the port.
    expect(probed).toEqual([{ port: 55555, instanceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }]);
  });

  it('fails clearly when --instance matches nothing live', async () => {
    const root = await tempRoot();
    await liveInstance(root, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 54444, 'first-token-aaaa');
    const lines: string[] = [];
    const result = await runConsoleOpen({ dataRoot: root, instance: 'ffffffff', opener: async () => { throw new Error('must not open'); }, out: (line) => lines.push(line) });
    expect(result.exitCode).toBe(1);
    expect(lines.join('\n')).toContain('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    expect(lines.join('\n')).not.toContain('first-token');
  });

  // `lockAlive` reads and validates instance.json, and the candidate scan then
  // reads it a SECOND time. A candidate built from an unusable second read
  // reaches `--instance`'s `startsWith` and throws, so `console open` crashes
  // instead of reporting what it found.
  //
  // An earlier version of this comment said the path could only be reached by
  // a race and so could not be staged. That was wrong: `lockAlive` checks the
  // pid and that the lock restates the manifest, and looks at neither
  // `createdAt` nor `host` — so a manifest missing `host` passes it and
  // arrives at the second read intact. The case below stages exactly that.
  it('rejects every instance identity that would break the candidate scan', () => {
    for (const bad of [
      undefined, null, 42, 'a string',
      {},
      { instanceId: 42, createdAt: 'x', host: 'darwin' },
      { instanceId: '', createdAt: 'x', host: 'darwin' },
      { instanceId: 'i-1', createdAt: null, host: 'darwin' },
      { instanceId: 'i-1', createdAt: 'x' },
    ]) {
      expect(asInstanceIdentity(bad), JSON.stringify(bad) ?? 'undefined').toBeUndefined();
    }
    expect(asInstanceIdentity({ instanceId: 'i-1', createdAt: 'x', host: 'darwin', extra: 1 }))
      .toEqual({ instanceId: 'i-1', createdAt: 'x', host: 'darwin' });
  });

  // The same rule end to end, through the scan rather than through the helper:
  // a manifest that satisfies `lockAlive` and not the candidate scan is skipped
  // and counted, and the command still answers instead of throwing.
  it('skips a live instance whose manifest cannot supply a candidate', async () => {
    const root = await tempRoot();
    const broken = await liveInstance(root, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 51111, 'legacy');
    const good = await liveInstance(root, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 52222, 'legacy');
    // `host` is dropped and everything `lockAlive` inspects is left intact, so
    // the entry is alive by its rules and unusable by the scan's.
    const manifestPath = join(broken.instanceDir, 'instance.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    delete manifest['host'];
    await writeFile(manifestPath, JSON.stringify(manifest) + '\n', { mode: 0o600 });

    const { candidates, stale } = await findConsoleCandidates(root);
    expect(candidates.map((candidate) => candidate.instanceId)).toEqual(['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
    expect(stale).toBe(1);
    // And the command built on it answers rather than throwing.
    const result = await runConsoleOpen({ dataRoot: root, instance: 'aaaaaaaa', opener: async () => { throw new Error('must not open'); }, out: () => undefined });
    expect(result).toMatchObject({ kind: 'not-listening', exitCode: 1 });
    await good.close();
  });

  // "Absent" and "present but unreadable" are different facts to an operator:
  // the first means the console is off, the second means it is on and this
  // entry is wreckage. Reporting the second as the first sends them to change
  // a setting that was never the problem.
  it('counts a console.json that will not parse, and does not count one that is absent', async () => {
    const corrupt = await tempRoot();
    const manager = await liveInstance(corrupt, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 51111, 'legacy');
    await writeFile(join(manager.instanceDir, 'console.json'), '{not json', { mode: 0o600 });
    const seen = await findConsoleCandidates(corrupt);
    expect(seen).toMatchObject({ candidates: [], stale: 1 });
    const lines: string[] = [];
    const result = await runConsoleOpen({ dataRoot: corrupt, opener: async () => { throw new Error('must not open'); }, out: (line) => lines.push(line) });
    expect(result.kind).toBe('not-listening');
    expect(lines.join('\n')).not.toContain('no console is enabled');

    // And an instance with no console.json at all is the console being off.
    const off = await tempRoot();
    const quiet = await InstanceManager.create({ dataRoot: off, instanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', rootNonce: 'c'.repeat(32), pid: process.pid });
    const none = await runConsoleOpen({ dataRoot: off, opener: async () => { throw new Error('must not open'); }, out: () => undefined });
    expect(none).toMatchObject({ kind: 'none-enabled' });
    await quiet.close();
  });

  it('a closed instance (lock and console.json removed by close) is not a candidate', async () => {
    const root = await tempRoot();
    const manager = await liveInstance(root, '99999999-9999-4999-8999-999999999999', 56666, 'closed-token');
    await manager.close();
    const { candidates, stale } = await findConsoleCandidates(root);
    expect(candidates).toEqual([]);
    // close() removed console.json itself, so this reads as "not enabled", not stale.
    expect(stale).toBe(0);
  });
});

  it('degrades to one line plus URL when the browser opener rejects after a successful probe', async () => {
    const root = await tempRoot();
    await liveInstance(root, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 45999, 'sekrit'.repeat(5));
    const lines: string[] = [];
    const result = await runConsoleOpen({
      dataRoot: root,
      probe: async () => true,
      opener: async () => { throw new Error('xdg-open: command not found'); },
      out: (line) => lines.push(line),
    });
    expect(result).toEqual({ kind: 'open-degraded', exitCode: 0, instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', port: 45999 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('http://127.0.0.1:45999/');
    expect(lines[0]).not.toContain('sekrit');
  });

describe('console open pre-flight identity probe', () => {
  /**
   * `defaultInspect` only supplies process identity on Linux, so elsewhere a
   * surviving PID is taken as proof the instance is alive. In orphan reaping
   * that direction is safe — "uncertain, so do not kill". Here the same answer
   * means "hand over the URL", and a reused PID plus a reused port would open
   * whatever now holds it.
   */
  it('refuses to open, and never builds the URL, when the port is not our console', async () => {
    const root = await tempRoot();
    await liveInstance(root, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 45999, 'sekrit'.repeat(5));
    const lines: string[] = [];
    const result = await runConsoleOpen({
      dataRoot: root,
      // Something answers, but it is not us.
      probe: async () => false,
      opener: async () => { throw new Error('no browser may be opened on a refusal'); },
      out: (line) => lines.push(line),
    });
    expect(result.kind).toBe('not-listening');
    // §8.2: exactly one line, naming the instance and the port it declined.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(lines[0]).toContain('45999');
    expect(lines[0]).not.toContain('sekrit');
  });
});


/**
 * ADR 0042's kinship narrowing. The walk is exercised against a synthetic
 * process tree — a real one cannot be arranged from a test, and reading the
 * machine's own would make the assertions depend on how the suite was started.
 *
 * The shape every case is built from was measured on Claude Code and inferred
 * for the other three hosts — ADR 0042 says which is which, and this comment
 * does not upgrade an inference by restating it. The caller is a shell the host
 * agent spawned, and the instance's owner is either that host (OpenCode, in
 * process) or another child of it (Claude Code, Codex, Kimi — a separate MCP
 * server process, so a *sibling* of the caller).
 *
 * 300 and 800 are *session roots*: their parent is pid 1, so on a desktop they
 * are the terminal application or login session everything else descends from.
 * 900's branch is what the narrowing measured wrong on 2026-08-28 — a second
 * host session under the *same* terminal as the caller, sharing 300 and nothing
 * below it.
 *
 * 550 is the shape the *descendant* arm of direct lineage serves: an instance
 * the caller itself started, whose owner is below the caller rather than beside
 * or above it. 300 doubles as the shape the arm's exemption serves — an owner
 * sitting at the caller's own session root, which the shared-ancestor test is
 * forbidden to look at.
 *
 *   1 ── 300 terminal ── 400 host ── 500 caller ── 550 owner of instance D
 *                     │          └─ 600 owner of instance A
 *                     └─ 950 second host ── 900 owner of instance C
 *   1 ── 800 other terminal ── 700 owner of instance B
 */
const TREE: ReadonlyMap<number, number> = new Map([
  [500, 400], [600, 400], [400, 300], [300, 1],
  [700, 800], [800, 1],
  [900, 950], [950, 300],
  [550, 500],
]);

const treeParentOf = async (pid: number): Promise<number | undefined> => TREE.get(pid);

function candidate(instanceId: string, port: number): ConsoleCandidate {
  return { instanceId, createdAt: '2026-01-01T00:00:00.000Z', host: 'darwin', port };
}

const A = candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 51111);
const B = candidate('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 52222);
const C = candidate('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 53333);
const D = candidate('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 54444);

/** A and B as the scan would report them, owned by 600 and 700 respectively. */
const OWNERS: ReadonlyMap<string, number> = new Map([[A.instanceId, 600], [B.instanceId, 700]]);

describe('console open kinship narrowing (ADR 0042)', () => {
  it('keeps the candidate whose owner shares an ancestor with the caller, and drops the one that does not', async () => {
    const kin = await narrowToCallerTree({ candidates: [A, B], owners: OWNERS, callerPid: 500, parentOf: treeParentOf });
    expect(kin?.map((entry) => entry.instanceId)).toEqual([A.instanceId]);
  });

  it('keeps an owner that is the caller itself, and one that is an ancestor of it (the in-process host shape)', async () => {
    const self = await narrowToCallerTree({
      candidates: [A], owners: new Map([[A.instanceId, 500]]), callerPid: 500, parentOf: treeParentOf,
    });
    expect(self).toEqual([A]);
    const ancestor = await narrowToCallerTree({
      candidates: [A], owners: new Map([[A.instanceId, 400]]), callerPid: 500, parentOf: treeParentOf,
    });
    expect(ancestor).toEqual([A]);
  });

  it('does not make pid 1 a link: two trees that meet only at init are not kin', async () => {
    // 700's chain is 700 → 800 → 1 and the caller's is 500 → 400 → 300 → 1.
    // Admitting 1 would make every process on the machine kin to every other,
    // which is the failure this excludes.
    const kin = await narrowToCallerTree({
      candidates: [B], owners: new Map([[B.instanceId, 700]]), callerPid: 500, parentOf: treeParentOf,
    });
    expect(kin).toEqual([]);
  });

  it('keeps an owner that is a descendant of the caller', async () => {
    // The third arm of direct lineage. In the ordinary shape it is not what
    // decides — 550's chain is 550 → 500 → 400 → 300, and 400 is a shared
    // ancestor below the session root, so sharing reaches it too. Asserted
    // anyway, because it is the behaviour the rule promises.
    const kin = await narrowToCallerTree({
      candidates: [D], owners: new Map([[D.instanceId, 550]]), callerPid: 500, parentOf: treeParentOf,
    });
    expect(kin).toEqual([D]);

    // Where the arm is the only route, and so where deleting it goes red: the
    // *caller* is a session root — a shell init started directly — and its own
    // chain is one element long, which `slice(0, -1)` empties. Nothing can be
    // shared with a caller in that position; only lineage can reach the
    // instance that caller started.
    const rootedCaller = await narrowToCallerTree({
      candidates: [D],
      owners: new Map([[D.instanceId, 550]]),
      callerPid: 500,
      parentOf: async (pid) => (pid === 500 ? 1 : TREE.get(pid)),
    });
    expect(rootedCaller).toEqual([D]);
  });

  it('keeps an owner sitting at the caller\'s own session root', async () => {
    // The shape decision 1 leaves direct lineage unbounded *for*: a host that
    // init started directly owns the instance, and every shell it spawns has
    // that owner at the top of its chain — the one position the shared-ancestor
    // test is forbidden to look at. Exempting the session root from lineage as
    // well as from sharing loses this candidate entirely.
    const kin = await narrowToCallerTree({
      candidates: [A], owners: new Map([[A.instanceId, 300]]), callerPid: 500, parentOf: treeParentOf,
    });
    expect(kin).toEqual([A]);
  });

  it('does not make a shared session root a link: two hosts under one terminal are not kin', async () => {
    // The defect this replaces, measured on darwin on 2026-08-28: eight live
    // consoles, seven of whose owners shared one `Orca Helper` process whose
    // parent was pid 1, and the narrowing answered "seven" and listed. C's
    // owner meets the caller only at 300, which is where every window of one
    // terminal application meets every other, so it is not evidence of
    // anything and must not be kin.
    const kin = await narrowToCallerTree({
      candidates: [C], owners: new Map([[C.instanceId, 900]]), callerPid: 500, parentOf: treeParentOf,
    });
    expect(kin).toEqual([]);

    // And the point of the bound: the caller's own instance is still found
    // among candidates that only share the session root with it.
    const narrowed = await narrowToCallerTree({
      candidates: [A, B, C],
      owners: new Map([[A.instanceId, 600], [B.instanceId, 700], [C.instanceId, 900]]),
      callerPid: 500,
      parentOf: treeParentOf,
    });
    expect(narrowed?.map((entry) => entry.instanceId)).toEqual([A.instanceId]);
  });

  it('narrows nothing when a chain cannot be walked — unreadable parent, cycle, or hop bound', async () => {
    const unreadable = await narrowToCallerTree({
      candidates: [A, B], owners: OWNERS, callerPid: 500, parentOf: async () => undefined,
    });
    expect(unreadable).toBeUndefined();

    // A cycle decides nothing. What this asserts is that answer, not the line
    // that produces it: with the cycle guard removed the hop bound reaches the
    // same `undefined`, and no observation distinguishes them.
    const cycle = new Map([[500, 400], [400, 500], [600, 400]]);
    const cycled = await narrowToCallerTree({
      candidates: [A, B], owners: OWNERS, callerPid: 500, parentOf: async (pid) => cycle.get(pid),
    });
    expect(cycled).toBeUndefined();

    // A chain longer than the 32-hop bound is unbounded as far as this walk is
    // concerned, and an unbounded walk decides nothing. The read count is
    // asserted, not just the answer: without it a 64-hop bound passes this
    // case, and 32 is a number ADR 0042 states.
    const hops: number[] = [];
    const long = await narrowToCallerTree({
      candidates: [A, B],
      owners: OWNERS,
      callerPid: 500,
      parentOf: async (pid) => { hops.push(pid); return pid + 1; },
    });
    expect(long).toBeUndefined();
    expect(hops).toHaveLength(32);
  });

  it('narrows nothing when one owner chain is unreadable, even if another matched', async () => {
    // A partial answer would be worse than none: the chain that could not be
    // walked may be the caller's own, and dropping it silently is how "the only
    // one in this tree" becomes a false statement.
    const kin = await narrowToCallerTree({
      candidates: [A, B],
      owners: OWNERS,
      callerPid: 500,
      parentOf: async (pid) => (pid === 700 ? undefined : TREE.get(pid)),
    });
    expect(kin).toBeUndefined();
  });

  it('narrows nothing once the budget has lapsed, and issues no further read', async () => {
    let clock = 0;
    const reads: number[] = [];
    const kin = await narrowToCallerTree({
      candidates: [A, B],
      owners: OWNERS,
      callerPid: 500,
      parentOf: async (pid) => { reads.push(pid); return TREE.get(pid); },
      budgetMs: 10,
      // The first read is inside the budget; the clock passes the deadline
      // before the second is issued.
      now: () => { clock += 6; return clock; },
    });
    expect(kin).toBeUndefined();
    expect(reads).toEqual([500]);
  });

  it('applies the recorded 2000 ms budget when the caller passes none', async () => {
    // Two assertions, because they fail for different reasons. The first ties
    // the constant to the number ADR 0042 decision 6 states, so changing one
    // without the other goes red. The second is what the earlier budget case
    // could not show: that the *default* is consulted at all — it passes no
    // `budgetMs`, and a clock stepping 1200 ms lapses the walk after one read
    // under a 2000 ms budget while completing it under anything much larger.
    expect(KINSHIP_BUDGET_MS).toBe(2_000);

    let clock = 0;
    const reads: number[] = [];
    const kin = await narrowToCallerTree({
      candidates: [A, B],
      owners: OWNERS,
      callerPid: 500,
      parentOf: async (pid) => { reads.push(pid); return TREE.get(pid); },
      now: () => { clock += 1_200; return clock; },
    });
    expect(kin).toBeUndefined();
    expect(reads).toEqual([500]);
  });

  it('reads each pid once across every chain it walks', async () => {
    // Not a performance nicety: on darwin each miss is a `ps` spawn with a
    // five-second timeout, and the chains of several candidates converge on the
    // same terminal and login processes. 500, 600 and 700 are walked; 400 and
    // 800 are reached from two chains each and must be read once.
    const reads: number[] = [];
    const kin = await narrowToCallerTree({
      candidates: [A, B],
      owners: OWNERS,
      callerPid: 500,
      parentOf: async (pid) => { reads.push(pid); return TREE.get(pid); },
    });
    expect(kin?.map((entry) => entry.instanceId)).toEqual([A.instanceId]);
    expect([...reads].sort((a, b) => a - b)).toEqual([300, 400, 500, 600, 700, 800]);
  });

  it('narrows nothing when a candidate has no readable owning pid', async () => {
    // B was admitted by the scan and then found to carry no usable pid, so it
    // was never classified. Skipping it would leave A as the sole kin and the
    // caller would be told A is "the only one started inside this process
    // tree" — a claim about a set this walk did not finish reading. Doubt,
    // like an unreadable chain, and for the same reason.
    //
    // Unit-level only, and deliberately. The scan reads `instance.json` twice
    // and `lockAlive` validates the pid on the first read, so a fixture whose
    // manifest lacks a pid is counted stale and never becomes a candidate at
    // all — the state this asserts is reachable only if a live instance's
    // manifest loses its `pid` between the two reads. Whether anything in the
    // product does that is not established here; what is established is that
    // `narrowToCallerTree` refuses to answer when handed it.
    const kin = await narrowToCallerTree({
      candidates: [A, B], owners: new Map([[A.instanceId, 600]]), callerPid: 500, parentOf: treeParentOf,
    });
    expect(kin).toBeUndefined();
  });
});

/**
 * The same narrowing through `runConsoleOpen`, where the rule that only a set
 * of exactly one decides anything lives. The instances are made live by an
 * injected inspector, because a live lock otherwise requires a real pid and
 * these cases need two owners that differ.
 */
describe('console open chooses among several by kinship (ADR 0042)', () => {
  const aliveInspector: ProcessInspector = async (pid) => ({ exists: true, processStartedAt: `start-${pid}`, exePath: `/proc/${pid}` });

  async function ownedInstance(dataRoot: string, instanceId: string, port: number, pid: number): Promise<void> {
    const manager = await InstanceManager.create({
      dataRoot, instanceId, rootNonce: 'c'.repeat(32), pid,
      processStartedAt: `start-${pid}`, exePath: `/proc/${pid}`,
    });
    await writeFile(join(manager.instanceDir, 'console.json'), JSON.stringify({ port, startedAt: '2026-01-01T00:00:00.000Z' }) + '\n', { mode: 0o600 });
  }

  /**
   * ADR 0042 decision 5: where narrowing does not decide, the candidates are
   * printed as they were before it existed. Asserting the whole line rather
   * than the absence of one phrase is what makes that checkable — a per-
   * candidate `kin` marker appended to these lines passes any test that only
   * greps for what the narrowing's own sentence says.
   */
  function expectUnannotatedListing(lines: readonly string[], ids: readonly string[]): void {
    expect(lines[0]).toBe('more than one live console; re-run with --instance=<id>:');
    const listed = lines.slice(1);
    expect(listed).toHaveLength(ids.length);
    for (const id of ids) {
      const line = listed.find((entry) => entry.includes(id));
      expect(line).toBeDefined();
      expect(line).toMatch(new RegExp(`^ {2}${id} {2}host \\S+ {2}created \\S+ {2}port \\d+$`));
    }
  }

  it('opens the only live console started inside this process tree, and says that it did', async () => {
    const root = await tempRoot();
    await ownedInstance(root, A.instanceId, 51111, 600);
    await ownedInstance(root, B.instanceId, 52222, 700);
    const probed: string[] = [];
    const opened: string[] = [];
    const lines: string[] = [];
    const result = await runConsoleOpen({
      dataRoot: root,
      inspect: aliveInspector,
      callerPid: 500,
      parentOf: treeParentOf,
      probe: async (_port, instanceId) => { probed.push(instanceId); return true; },
      opener: async (url) => { opened.push(url); },
      out: (line) => lines.push(line),
    });
    expect(result).toMatchObject({ kind: 'opened', exitCode: 0, instanceId: A.instanceId, port: 51111 });
    // The probe is not relaxed by the narrowing: the chosen candidate is the
    // only one it is asked about, and it is asked.
    expect(probed).toEqual([A.instanceId]);
    expect(opened).toEqual(['http://127.0.0.1:51111/']);
    // The caller is told it was narrowed, and from how many.
    expect(lines[0]).toContain('2 live consoles');
    expect(lines[0]).toContain('this process tree');
    expect(lines[0]).toContain(A.instanceId);
  });

  it('lists both when both are kin, saying nothing about the tree', async () => {
    const root = await tempRoot();
    await ownedInstance(root, A.instanceId, 51111, 600);
    await ownedInstance(root, B.instanceId, 52222, 400);
    const lines: string[] = [];
    const result = await runConsoleOpen({
      dataRoot: root,
      inspect: aliveInspector,
      callerPid: 500,
      parentOf: treeParentOf,
      probe: async () => { throw new Error('must not probe'); },
      opener: async () => { throw new Error('must not open'); },
      out: (line) => lines.push(line),
    });
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') expect(result.candidates).toHaveLength(2);
    expectUnannotatedListing(lines, [A.instanceId, B.instanceId]);
    expect(lines.join('\n')).not.toContain('this process tree');
  });

  it('lists both when neither is kin', async () => {
    const root = await tempRoot();
    await ownedInstance(root, A.instanceId, 51111, 700);
    await ownedInstance(root, B.instanceId, 52222, 800);
    const lines: string[] = [];
    const result = await runConsoleOpen({
      dataRoot: root,
      inspect: aliveInspector,
      callerPid: 500,
      parentOf: treeParentOf,
      probe: async () => { throw new Error('must not probe'); },
      opener: async () => { throw new Error('must not open'); },
      out: (line) => lines.push(line),
    });
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') expect(result.candidates).toHaveLength(2);
    expectUnannotatedListing(lines, [A.instanceId, B.instanceId]);
    expect(lines.join('\n')).not.toContain('this process tree');
  });

  it('lists all when the only thing two hosts share is the caller\'s session root', async () => {
    // The end-to-end shape of the 2026-08-28 measurement: a second host session
    // under the same terminal application. Before the session-root bound this
    // listed for the opposite reason — both were kin — and with the bound and
    // no third instance it would open A. Three candidates keep the case about
    // C not being kin rather than about how many survive.
    const root = await tempRoot();
    await ownedInstance(root, A.instanceId, 51111, 600);
    await ownedInstance(root, B.instanceId, 52222, 700);
    await ownedInstance(root, C.instanceId, 53333, 900);
    const lines: string[] = [];
    const probed: string[] = [];
    const result = await runConsoleOpen({
      dataRoot: root,
      inspect: aliveInspector,
      callerPid: 500,
      parentOf: treeParentOf,
      probe: async (_port, instanceId) => { probed.push(instanceId); return true; },
      opener: async () => {},
      out: (line) => lines.push(line),
    });
    // A is the only kin, so the narrowing decides and opens it. What this
    // asserts is that C never joined it: with the session root admitted, A and
    // C are both kin, the set is not of size one, and the command lists all
    // three instead of opening anything.
    expect(result).toMatchObject({ kind: 'opened', instanceId: A.instanceId });
    expect(probed).toEqual([A.instanceId]);
    expect(lines[0]).toContain('3 live consoles');
  });

  it('lists all when the kinship budget lapses', async () => {
    // Decision 6 end to end: a lapse narrows nothing and the caller gets the
    // listing it would have got before ADR 0042, not an error and not a
    // half-read answer.
    const root = await tempRoot();
    await ownedInstance(root, A.instanceId, 51111, 600);
    await ownedInstance(root, B.instanceId, 52222, 700);
    const lines: string[] = [];
    const result = await runConsoleOpen({
      dataRoot: root,
      inspect: aliveInspector,
      callerPid: 500,
      // Every parent read outlasts the 2000 ms budget, so the deadline is past
      // before the second one is issued.
      parentOf: async (pid) => { await new Promise((resolve) => setTimeout(resolve, 1_100)); return TREE.get(pid); },
      probe: async () => { throw new Error('must not probe'); },
      opener: async () => { throw new Error('must not open'); },
      out: (line) => lines.push(line),
    });
    expect(result.kind).toBe('ambiguous');
    expectUnannotatedListing(lines, [A.instanceId, B.instanceId]);
  });

  it('does not answer an ambiguous --instance from the process tree', async () => {
    const root = await tempRoot();
    // Both ids start with the prefix the caller types, and only one is kin;
    // the caller asked in their own terms and gets their own question back.
    await ownedInstance(root, 'cccccccc-1111-4ccc-8ccc-cccccccccccc', 51111, 600);
    await ownedInstance(root, 'cccccccc-2222-4ccc-8ccc-cccccccccccc', 52222, 700);
    const lines: string[] = [];
    const walked: number[] = [];
    const result = await runConsoleOpen({
      dataRoot: root,
      instance: 'cccccccc-',
      inspect: aliveInspector,
      callerPid: 500,
      // Counted rather than thrown: the walk treats a throwing process table as
      // doubt, so a throw here would be swallowed and prove nothing.
      parentOf: async (pid) => { walked.push(pid); return TREE.get(pid); },
      probe: async () => { throw new Error('must not probe'); },
      opener: async () => { throw new Error('must not open'); },
      out: (line) => lines.push(line),
    });
    expect(result.kind).toBe('ambiguous');
    expect(walked).toEqual([]);
    expect(lines.join('\n')).not.toContain('this process tree');
  });

  it('does not read the process table when there is only one candidate', async () => {
    const root = await tempRoot();
    await ownedInstance(root, A.instanceId, 51111, 700);
    const walked: number[] = [];
    const result = await runConsoleOpen({
      dataRoot: root,
      inspect: aliveInspector,
      callerPid: 500,
      parentOf: async (pid) => { walked.push(pid); return TREE.get(pid); },
      probe: async () => true,
      opener: async () => undefined,
      out: () => undefined,
    });
    // 700 is not kin to 500, and it is opened anyway: with one candidate there
    // is nothing to narrow, and kinship is not a permission.
    expect(result).toMatchObject({ kind: 'opened', instanceId: A.instanceId });
    expect(walked).toEqual([]);
  });
});
