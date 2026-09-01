// SEC-REC-019..027 (ADR 0033): what makes an instance directory a record, and
// which readings of a data root are doubt rather than a skip. ADR 0031's walk
// is unchanged and is exercised in delegation-evidence.test.ts; what changes
// here is the snapshot the walk is given.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  readInstanceRecords,
  walkAncestry,
  type AncestryProbe,
  type DelegationDiagnostics,
  type InstanceRecord,
} from '../../packages/plugin/src/delegation-evidence.js';

interface ProbeNode { readonly parent: number | undefined; readonly startedAt?: string }

function probe(nodes: Readonly<Record<number, ProbeNode>>): AncestryProbe {
  return {
    async parentOf(pid) { return nodes[pid]?.parent; },
    async startedAt(pid) { return nodes[pid]?.startedAt; },
  };
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'taskshuttle-delegation-records-'));
}

/**
 * Writes one instance directory. `manifest`/`lock` are written verbatim when a
 * string is given, from the object when one is given, and omitted when
 * undefined — the three shapes every case below needs.
 */
async function writeDir(
  dataRoot: string,
  name: string,
  files: { manifest?: Record<string, unknown> | string; lock?: Record<string, unknown> | string },
): Promise<string> {
  const dir = join(dataRoot, 'instances', name);
  await mkdir(dir, { recursive: true });
  const write = async (file: string, value: Record<string, unknown> | string | undefined): Promise<void> => {
    if (value === undefined) return;
    await writeFile(join(dir, file), typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
  };
  await write('instance.json', files.manifest);
  await write('instance.lock', files.lock);
  return dir;
}

/** A closed instance: manifest with an identity, no lock — the steady state ADR 0033 is about. */
function closed(id: string, pid: number, startedAt: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { instanceId: id, pid, processStartedAt: startedAt, closedAt: '2026-08-20T00:00:00.000Z', ...extra };
}

function ids(records: readonly InstanceRecord[] | undefined): string[] {
  return [...(records ?? [])].map((record) => record.instanceId).sort();
}

describe('SEC-REC-019: closed instances are records, not doubt', () => {
  it('a data root of one live instance and many closed ones yields every record, and root', async () => {
    const dataRoot = await tempRoot();
    await writeDir(dataRoot, 'live-one', {
      manifest: { instanceId: 'live-one', pid: 50, processStartedAt: 'T-live' },
      lock: { instanceId: 'live-one', pid: 50, processStartedAt: 'T-live' },
    });
    for (let n = 0; n < 5; n += 1) {
      await writeDir(dataRoot, `closed-${n}`, { manifest: closed(`closed-${n}`, 900 + n, `T-closed-${n}`) });
    }

    const records = await readInstanceRecords(dataRoot);
    expect(ids(records)).toEqual(['closed-0', 'closed-1', 'closed-2', 'closed-3', 'closed-4', 'live-one']);

    // No ancestor matches any of them: the walk must reach pid 1 and answer root.
    const verdict = await walkAncestry({
      pid: 100,
      instances: records,
      probe: probe({ 100: { parent: 40, startedAt: 'T-other' }, 40: { parent: 1, startedAt: 'T-other' } }),
    });
    expect(verdict).toEqual({ provenance: 'root', depth: 0 });
  });
});

describe('SEC-REC-020: the lock is a fallback identity source, and the last doubt', () => {
  it('an unparseable manifest beside a readable lock yields the lock’s identity and delegation object', async () => {
    const dataRoot = await tempRoot();
    await writeDir(dataRoot, 'lock-sourced', {
      manifest: '{not json',
      lock: { instanceId: 'lock-sourced', pid: 60, processStartedAt: 'T6', delegation: { provenance: 'root', depth: 0 } },
    });

    const records = await readInstanceRecords(dataRoot);
    expect(ids(records)).toEqual(['lock-sourced']);

    // The discriminator is the verdict, not the record's presence: taking the
    // lock's delegation object gives ancestry depth 1, where an `unreadable`
    // kind would give unavailable.
    const verdict = await walkAncestry({
      pid: 10,
      instances: records,
      probe: probe({ 10: { parent: 60, startedAt: 'T6' }, 60: { parent: 1, startedAt: 'T6' } }),
    });
    expect(verdict).toEqual({ provenance: 'ancestry', depth: 1 });
  });

  it('an unparseable manifest beside a lock that cannot be opened is doubt', async () => {
    const dataRoot = await tempRoot();
    const dir = await writeDir(dataRoot, 'both-unreadable', { manifest: '{not json' });
    // A directory in the lock's place fails the read with EISDIR rather than
    // ENOENT: the filesystem-level failure rule 3 reserves doubt for.
    await mkdir(join(dir, 'instance.lock'), { recursive: true });

    expect(await readInstanceRecords(dataRoot)).toBeUndefined();
  });

  it('an unparseable manifest with no lock is skipped, and the walk continues', async () => {
    const dataRoot = await tempRoot();
    await writeDir(dataRoot, 'no-identity', { manifest: '{not json' });
    await writeDir(dataRoot, 'live-one', { manifest: { instanceId: 'live-one', pid: 70, processStartedAt: 'T7' } });

    const records = await readInstanceRecords(dataRoot);
    expect(ids(records)).toEqual(['live-one']);
    const verdict = await walkAncestry({
      pid: 11,
      instances: records,
      probe: probe({ 11: { parent: 41, startedAt: 'T-x' }, 41: { parent: 1, startedAt: 'T-x' } }),
    });
    expect(verdict).toEqual({ provenance: 'root', depth: 0 });
  });
});

describe('SEC-REC-021: an exact match against a closed record settles delegation', () => {
  const cases: Array<[string, Record<string, unknown> | undefined, unknown]> = [
    ['recorded root', { provenance: 'root', depth: 0 }, { provenance: 'ancestry', depth: 1 }],
    ['recorded ancestry', { provenance: 'ancestry', depth: 3 }, { provenance: 'ancestry', depth: 4 }],
    ['recorded marker', { provenance: 'marker', depth: 1 }, { provenance: 'ancestry', depth: 2 }],
    ['recorded unavailable', { provenance: 'unavailable' }, { provenance: 'unavailable' }],
    ['invalid depth', { provenance: 'ancestry', depth: -1 }, { provenance: 'unavailable' }],
    ['malformed object', { provenance: 'nonsense' }, { provenance: 'unavailable' }],
    ['no delegation object', undefined, { provenance: 'ancestry', depth: 1 }],
  ];

  for (const [name, delegation, expected] of cases) {
    it(`${name} → ${JSON.stringify(expected)}`, async () => {
      const dataRoot = await tempRoot();
      const manifest = closed('closing-root', 80, 'T8', delegation === undefined ? {} : { delegation });
      await writeDir(dataRoot, 'closing-root', { manifest });
      // A sibling that must not match, so an `unavailable` expectation cannot
      // pass on an empty snapshot: it proves the record was read.
      await writeDir(dataRoot, 'other', { manifest: closed('other', 81, 'T81') });

      const records = await readInstanceRecords(dataRoot);
      expect(ids(records)).toEqual(['closing-root', 'other']);
      const verdict = await walkAncestry({
        pid: 12,
        instances: records,
        probe: probe({ 12: { parent: 80, startedAt: 'T8' }, 80: { parent: 1, startedAt: 'T8' } }),
      });
      expect(verdict).toEqual(expected);
    });
  }
});

describe('SEC-REC-022: the start-time-family doubt is untouched by a larger population', () => {
  // Every fixture is a control against today's code, which answers unavailable
  // because the snapshot is undefined. Each therefore asserts the snapshot
  // first, so the doubt is shown to come from the branch under test.
  const legacy = '2026-08-25T06:24:04.734Z';
  const lstart = 'Wed Aug 26 13:55:36 2026';

  it('a cross-family collision doubts whether or not the record predates the helpers', async () => {
    for (const extra of [{}, { delegation: { provenance: 'root', depth: 0 } }]) {
      const dataRoot = await tempRoot();
      await writeDir(dataRoot, 'legacy-one', { manifest: closed('legacy-one', 90, legacy, extra) });
      const records = await readInstanceRecords(dataRoot);
      expect(ids(records)).toEqual(['legacy-one']);
      const verdict = await walkAncestry({
        pid: 13,
        instances: records,
        probe: probe({ 13: { parent: 90, startedAt: lstart }, 90: { parent: 1, startedAt: lstart } }),
      });
      expect(verdict).toEqual({ provenance: 'unavailable' });
    }
  });

  it('an ancestor whose own identity cannot be read doubts', async () => {
    const dataRoot = await tempRoot();
    await writeDir(dataRoot, 'same-family', { manifest: closed('same-family', 91, lstart) });
    const records = await readInstanceRecords(dataRoot);
    expect(ids(records)).toEqual(['same-family']);
    const verdict = await walkAncestry({
      pid: 14,
      instances: records,
      probe: probe({ 14: { parent: 91 }, 91: { parent: 1 } }),
    });
    expect(verdict).toEqual({ provenance: 'unavailable' });
  });
});

describe('SEC-REC-023: an entry that is gone when it is read', () => {
  it('is resolved through the re-listing to its quarantine name', async () => {
    const dataRoot = await tempRoot();
    await writeDir(dataRoot, '.recovery-claimed-one-3f2a1c44-9b21-4e77-8c10-5d6e7f801234', { manifest: closed('claimed-one', 95, 'T95') });
    const records = await readInstanceRecords(dataRoot);
    expect(ids(records)).toEqual(['claimed-one']);
    const verdict = await walkAncestry({
      pid: 15,
      instances: records,
      probe: probe({ 15: { parent: 95, startedAt: 'T95' }, 95: { parent: 1, startedAt: 'T95' } }),
    });
    expect(verdict).toEqual({ provenance: 'ancestry', depth: 1 });
  });

  it('a directory holding neither file is skipped, not doubted', async () => {
    const dataRoot = await tempRoot();
    await mkdir(join(dataRoot, 'instances', 'gone-one'), { recursive: true });
    await writeDir(dataRoot, 'live-one', { manifest: { instanceId: 'live-one', pid: 96, processStartedAt: 'T96' } });
    expect(ids(await readInstanceRecords(dataRoot))).toEqual(['live-one']);
  });
});

describe('SEC-REC-024: dot-entry admission is exactly one pattern', () => {
  it('admits a quarantine name and refuses staging and removal names', async () => {
    const dataRoot = await tempRoot();
    await writeDir(dataRoot, '.recovery-quarantined-one-3f2a1c44-9b21-4e77-8c10-5d6e7f801234', { manifest: closed('quarantined-one', 200, 'T200') });
    await writeDir(dataRoot, '.tmp-abcd', { manifest: { instanceId: 'staged-one', pid: 201, processStartedAt: 'T201' } });
    await writeDir(dataRoot, '.delete-abcd', { manifest: closed('removing-one', 202, 'T202') });
    expect(ids(await readInstanceRecords(dataRoot))).toEqual(['quarantined-one']);
  });

  it('never doubts, whatever a dot entry holds', async () => {
    const dataRoot = await tempRoot();
    const dir = await writeDir(dataRoot, '.recovery-broken-one-7c5b2d90-1a44-4f02-9e63-0b8d4a6c1122', { manifest: '{not json' });
    await mkdir(join(dir, 'instance.lock'), { recursive: true });
    await writeDir(dataRoot, 'live-one', { manifest: { instanceId: 'live-one', pid: 203, processStartedAt: 'T203' } });
    expect(ids(await readInstanceRecords(dataRoot))).toEqual(['live-one']);
  });
});

describe('SEC-REC-025: the identity predicate', () => {
  const rejected: Array<[string, unknown]> = [
    ['pid zero', { instanceId: 'a', pid: 0, processStartedAt: 'T' }],
    ['non-integer pid', { instanceId: 'a', pid: 1.5, processStartedAt: 'T' }],
    ['empty processStartedAt', { instanceId: 'a', pid: 5, processStartedAt: '' }],
    ['empty instanceId', { instanceId: '', pid: 5, processStartedAt: 'T' }],
    ['non-string instanceId', { instanceId: 7, pid: 5, processStartedAt: 'T' }],
    ['not an object', 'null'],
  ];

  for (const [name, manifest] of rejected) {
    it(`${name} yields no identity, and reading it throws nothing`, async () => {
      const dataRoot = await tempRoot();
      await writeDir(dataRoot, 'rejected-one', {
        manifest: typeof manifest === 'string' ? manifest : (manifest as Record<string, unknown>),
      });
      await writeDir(dataRoot, 'live-one', { manifest: { instanceId: 'live-one', pid: 300, processStartedAt: 'T300' } });
      expect(ids(await readInstanceRecords(dataRoot))).toEqual(['live-one']);
    });
  }
});

describe('SEC-REC-026: the scan reports what it read', () => {
  it('fills the diagnostics with the record count and no doubt', async () => {
    const dataRoot = await tempRoot();
    await writeDir(dataRoot, 'live-one', { manifest: { instanceId: 'live-one', pid: 400, processStartedAt: 'T400' } });
    const diagnostics: DelegationDiagnostics = {};
    await readInstanceRecords(dataRoot, diagnostics);
    expect(diagnostics.records).toBe(1);
    expect(typeof diagnostics.scanMs).toBe('number');
    expect(diagnostics.cause).toBeUndefined();
  });

  it('names the scan’s own doubt', async () => {
    const dataRoot = await tempRoot();
    const dir = await writeDir(dataRoot, 'both-unreadable', { manifest: '{not json' });
    await mkdir(join(dir, 'instance.lock'), { recursive: true });
    const diagnostics: DelegationDiagnostics = {};
    expect(await readInstanceRecords(dataRoot, diagnostics)).toBeUndefined();
    expect(diagnostics.cause).toBe('scan-unreadable');
  });
});

describe('SEC-REC-027: one identity contributes one record', () => {
  // Both arrangements, because the tie-break must decide rather than listing
  // order: with the refusing record written under one name and then the other,
  // an implementation that simply keeps the first read passes one and fails the
  // other, whichever way `readdir` happens to answer.
  for (const refusingIsQuarantine of [true, false]) {
    it(`collapses two entries of one identity, keeping the one that refuses more (refusing under ${refusingIsQuarantine ? 'the quarantine' : 'its own'} name)`, async () => {
      const dataRoot = await tempRoot();
      const identity = { instanceId: 'twice-one', pid: 500, processStartedAt: 'T500' };
      const refusing = { ...identity, delegation: { provenance: 'ancestry', depth: 2 } };
      const yielding = { ...identity, delegation: { provenance: 'unavailable' } };
      await writeDir(dataRoot, 'twice-one', { manifest: refusingIsQuarantine ? yielding : refusing });
      await writeDir(dataRoot, '.recovery-twice-one-3f2a1c44-9b21-4e77-8c10-5d6e7f801234', { manifest: refusingIsQuarantine ? refusing : yielding });

      const records = await readInstanceRecords(dataRoot);
      expect(ids(records)).toEqual(['twice-one']);
      const verdict = await walkAncestry({
        pid: 16,
        instances: records,
        probe: probe({ 16: { parent: 500, startedAt: 'T500' }, 500: { parent: 1, startedAt: 'T500' } }),
      });
      // ancestry refuses session creation where unavailable does not, so it wins.
      expect(verdict).toEqual({ provenance: 'ancestry', depth: 3 });
    });
  }

  it('keeps two records that share an instanceId but not an identity', async () => {
    const dataRoot = await tempRoot();
    await writeDir(dataRoot, 'restored-one', { manifest: closed('same-id', 600, 'T600') });
    await writeDir(dataRoot, 'live-one', { manifest: { instanceId: 'same-id', pid: 601, processStartedAt: 'T601' } });
    const records = await readInstanceRecords(dataRoot);
    expect(records).toHaveLength(2);
    for (const pid of [600, 601]) {
      const verdict = await walkAncestry({
        pid: 17,
        instances: records,
        probe: probe({ 17: { parent: pid, startedAt: `T${pid}` }, [pid]: { parent: 1, startedAt: `T${pid}` } }),
      });
      expect(verdict).toEqual({ provenance: 'ancestry', depth: 1 });
    }
  });

});
