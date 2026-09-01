import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { parentProcessId, processStartTime, startTimeFamily } from './lifecycle.js';
import type { DelegationIdentity } from './security-policy.js';

/**
 * Where a delegation verdict came from (ADR 0031). `malformed` is deliberately
 * not a member: a malformed marker throws before the runtime is constructed, so
 * no manifest exists to record it in.
 */
export type DelegationProvenance = 'root' | 'marker' | 'ancestry' | 'unavailable';

/**
 * The verdict as `instance.json` records it. A root records `depth: 0` — that
 * zero is established, unlike the one `unavailable` would be guessing — and
 * only `unavailable` omits the field.
 */
export type DelegationRecord =
  /** A zero the instance established, not one it guessed. */
  | { readonly provenance: 'root'; readonly depth: 0 }
  | { readonly provenance: 'marker' | 'ancestry'; readonly depth: number }
  /** The only outcome without a depth: it does not know, and will not guess. */
  | { readonly provenance: 'unavailable'; readonly depth?: undefined };

/**
 * A chain longer than this is not a delegation tree, and an unbounded walk in a
 * boot path is a hang waiting for a pathological process table (mvp §5.2).
 */
export const MAX_ANCESTRY_HOPS = 32;

/** The real process table, through the one canonical identity source. */
export const defaultAncestryProbe: AncestryProbe = {
  parentOf: (pid) => parentProcessId(pid),
  startedAt: (pid) => processStartTime(pid),
};

/** The process-table reads the walk needs, injectable so tests can drive it. */
export interface AncestryProbe {
  /** Parent pid, or `undefined` when it cannot be read — which is doubt, not a root. */
  parentOf(pid: number): Promise<number | undefined>;
  /** Canonical start time, or `undefined` when the identity cannot be read. */
  startedAt(pid: number): Promise<string | undefined>;
}

/** What the file that supplied a matched record — its manifest, or its lock — could tell us about its own depth. */
export type AncestorDelegation =
  | { readonly kind: 'recorded'; readonly record: DelegationRecord }
  /** No `delegation` object at all — a file written before the field existed. */
  | { readonly kind: 'legacy' }
  /**
   * Present but invalid. A file that could not be read no longer lands here:
   * after ADR 0033 the delegation object comes from whichever file supplied the
   * record, so an unreadable manifest yields the lock's object rather than an
   * unreadable kind.
   */
  | { readonly kind: 'unreadable' };

/**
 * Every place the settle can answer `unavailable`, named so a withheld console
 * can say which one it hit (ADR 0033). Without this the operator sees the same
 * silence for a corrupt manifest, a lapsed budget and a pid collision.
 */
export type DoubtCause =
  | 'scan-unreadable' | 'scan-enumeration' | 'parent-pid' | 'ancestor-identity'
  | 'start-time-family' | 'cycle' | 'hop-bound' | 'matched-record-unusable'
  | 'walk-error' | 'budget-lapsed' | 'no-scan';

/**
 * Filled in by the scan and the walk when a caller passes one. An
 * out-parameter rather than a changed return type: `settleDelegation` has two
 * production callers and two more in the gates, and only one of them wants
 * this.
 */
export interface DelegationDiagnostics {
  cause?: DoubtCause;
  records?: number;
  scanMs?: number;
  matchedInstanceId?: string;
}

export interface InstanceRecord {
  readonly instanceId: string;
  readonly pid: number;
  readonly processStartedAt: string;
  readonly delegation: AncestorDelegation;
}

/** Positive evidence of delegation — the two provenances that assert it. */
export function isDelegated(record: DelegationRecord): boolean {
  return record.provenance === 'marker' || record.provenance === 'ancestry';
}

/**
 * The console starts only on `root`. `unavailable` keeps it down because an
 * unreadable data root is not evidence of being a root, while the tools keep
 * serving because refusing legitimate work costs more (mvp §5.2, §9.6).
 */
export function consoleAllowed(record: DelegationRecord): record is { readonly provenance: 'root'; readonly depth: 0 } {
  return record.provenance === 'root';
}

/**
 * Compose the two kinds of evidence into one verdict, so that no call site
 * invents its own rule (mvp §5.2).
 *
 * @param marker parsed marker; a malformed one has already thrown by here.
 * @param ancestry what the walk concluded — `root`, `ancestry` or `unavailable`.
 * @returns the composed verdict.
 */
export function composeDelegation(marker: DelegationIdentity, ancestry: DelegationRecord): DelegationRecord {
  // A marker that says delegated is never downgraded by an ancestry read that
  // failed: evidence of delegation is not withdrawn by the absence of other
  // evidence. It is also the stronger statement, so it takes the provenance.
  if (markerSaysDelegated(marker)) return { provenance: 'marker', depth: marker.depth };
  return ancestry;
}

function depthBelow(ancestor: AncestorDelegation): DelegationRecord {
  switch (ancestor.kind) {
    // A legacy root records nothing, so the instance under it is depth 1 —
    // what the boundary needs is ">= 1", and the exact number is diagnostic.
    case 'legacy': return { provenance: 'ancestry', depth: 1 };
    case 'unreadable': return { provenance: 'unavailable' };
    case 'recorded': {
      // An ancestor that did not know its own depth cannot tell us ours, and a
      // corrupt file must not be allowed to manufacture a root.
      const depth = ancestor.record.depth;
      if (depth === undefined || !Number.isSafeInteger(depth) || depth < 0) return { provenance: 'unavailable' };
      return { provenance: 'ancestry', depth: depth + 1 };
    }
  }
}

/**
 * Walk this process's ancestry against one snapshot of the instance records and
 * settle the verdict. The nearest matching ancestor wins: with a chain crossing
 * two instances, the depth that applies is the closest one's.
 *
 * @param options `pid` is the process to walk up from; `instances` is the
 *   snapshot, or `undefined` when the snapshot itself could not be taken.
 * @returns `ancestry` with a depth, `root`, or `unavailable`; never a throw —
 *   every failure is already a defined outcome.
 */
export async function walkAncestry(options: {
  pid: number;
  instances: readonly InstanceRecord[] | undefined;
  probe: AncestryProbe;
  maxHops?: number;
  diagnostics?: DelegationDiagnostics;
}): Promise<DelegationRecord> {
  const { instances, probe, diagnostics } = options;
  // Every doubt below records why, so `console_withheld` can name it; the scan
  // has already recorded its own cause when the snapshot is undefined.
  const doubt = (cause: DoubtCause): DelegationRecord => {
    if (diagnostics !== undefined && diagnostics.cause === undefined) diagnostics.cause = cause;
    return { provenance: 'unavailable' };
  };
  if (instances === undefined) return { provenance: 'unavailable' };
  const byPid = new Map<number, InstanceRecord[]>();
  for (const instance of instances) {
    const bucket = byPid.get(instance.pid);
    if (bucket === undefined) byPid.set(instance.pid, [instance]); else bucket.push(instance);
  }

  // The probe reads the process table, which can fail in ways a caller cannot
  // enumerate — EACCES under a sandbox, a `ps` that times out. A rejection here
  // is doubt like any other, and letting it escape would take down a boot path
  // whose whole contract is that every failure has an answer.
  const parentOf = async (pid: number): Promise<number | undefined> => {
    try { return await probe.parentOf(pid); } catch { return undefined; }
  };
  const startedAt = async (pid: number): Promise<string | undefined> => {
    try {
      const value = await probe.startedAt(pid);
      // An empty reading is not a reading; treating it as one would let a walk
      // continue past an ancestor it never actually identified.
      return value === undefined || value.length === 0 ? undefined : value;
    } catch { return undefined; }
  };

  const limit = options.maxHops ?? MAX_ANCESTRY_HOPS;
  const seen = new Set<number>([options.pid]);
  let current = options.pid;
  for (let hop = 0; hop < limit; hop += 1) {
    const parent = await parentOf(current);
    // A parent that cannot be read is a reason to doubt. Reaching pid 1 — or
    // anything at or below it, which no live parent is — is the walk finishing,
    // not failing.
    if (parent === undefined) return doubt('parent-pid');
    if (parent <= 1) return { provenance: 'root', depth: 0 };
    // A pid seen twice is a cycle, which no real process tree has; treating it
    // as a finished walk would answer "root" on a broken reading.
    if (seen.has(parent)) return doubt('cycle');
    seen.add(parent);

    const candidates = byPid.get(parent);
    if (candidates !== undefined) {
      const identity = await startedAt(parent);
      // Without a start time there is no exact match to make, and a pid alone
      // is a coincidence rather than a fact.
      if (identity === undefined) return doubt('ancestor-identity');
      const match = candidates.find((instance) => instance.processStartedAt === identity);
      if (match !== undefined) {
        const below = depthBelow(match.delegation);
        if (diagnostics !== undefined) {
          if (below.provenance === 'unavailable') diagnostics.cause ??= 'matched-record-unusable';
          else diagnostics.matchedInstanceId = match.instanceId;
        }
        return below;
      }
      // No exact match is only a *proven* non-match within one format family.
      // A lock written before the identity helpers converged carries an ISO
      // creation timestamp on darwin; comparing it with a `ps` date is unequal
      // for a reason that is not "a different process". Walking on from here
      // would pass a real ancestor and answer `root` at pid 1 — reopening, for
      // the whole migration window, exactly the hole this record closes. The
      // recovery scan and `lockAlive` resolve the same ambiguity toward "do not
      // touch"; here the safe direction is doubt.
      const readFamily = startTimeFamily(identity);
      if (candidates.some((instance) => startTimeFamily(instance.processStartedAt) !== readFamily)) {
        return doubt('start-time-family');
      }
    }
    current = parent;
  }
  // A traversal that exceeds its bound has not established anything.
  return doubt('hop-bound');
}

function parseDelegation(value: unknown): AncestorDelegation {
  if (value === undefined) return { kind: 'legacy' };
  if (typeof value !== 'object' || value === null) return { kind: 'unreadable' };
  const object = value as { provenance?: unknown; depth?: unknown };
  const provenance = object.provenance;
  if (provenance !== 'root' && provenance !== 'marker' && provenance !== 'ancestry' && provenance !== 'unavailable') {
    return { kind: 'unreadable' };
  }
  const depth = object.depth;
  if (provenance === 'unavailable') {
    return depth === undefined ? { kind: 'recorded', record: { provenance } } : { kind: 'unreadable' };
  }
  if (typeof depth !== 'number' || !Number.isSafeInteger(depth) || depth < 0) return { kind: 'unreadable' };
  // A root is depth 0 by definition; a manifest claiming otherwise is corrupt,
  // and a corrupt file must not be able to place an instance in the tree.
  if (provenance === 'root') return depth === 0 ? { kind: 'recorded', record: { provenance, depth: 0 } } : { kind: 'unreadable' };
  return { kind: 'recorded', record: { provenance, depth } };
}

/**
 * The name recovery renames a claimed directory to for the duration of its
 * claim: `.recovery-<instanceId>-<uuid>`. Matched by its uuid suffix rather
 * than by a prefix, because an instance id contains hyphens of its own and a
 * prefix match would cut one id's name in the middle of another's.
 */
const QUARANTINE_NAME = /^\.recovery-(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What one file read produced, kept apart because the three failures mean different things. */
type FileRead =
  | { readonly state: 'ok'; readonly value: unknown }
  /** ENOENT/ENOTDIR — the file, or the directory holding it, is not there. */
  | { readonly state: 'absent' }
  /** Present and read, but not JSON: content that can never yield an identity. */
  | { readonly state: 'unusable' }
  /** The filesystem refused the read: EACCES, EISDIR, EIO. The one doubt. */
  | { readonly state: 'failed' };

async function readInstanceFile(path: string): Promise<FileRead> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { state: 'absent' } : { state: 'failed' };
  }
  try { return { state: 'ok', value: JSON.parse(text) as unknown }; }
  catch { return { state: 'unusable' }; }
}

/**
 * The identity a record needs (mvp §5.2): the two fields the match compares
 * plus the one that names what matched. `exePath` and `tokenHash` belong to the
 * lock's own discipline and to recovery, not to this comparison.
 *
 * @param value parsed `instance.json` or `instance.lock` content; anything at
 *   all, including `null` and an array, which must yield undefined rather than
 *   throw.
 * @returns the record that file supports, or undefined when it supports none.
 */
function recordFrom(value: unknown): InstanceRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { instanceId, pid, processStartedAt, delegation } = value as Record<string, unknown>;
  if (typeof instanceId !== 'string' || instanceId.length === 0) return undefined;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) return undefined;
  if (typeof processStartedAt !== 'string' || processStartedAt.length === 0) return undefined;
  return { instanceId, pid, processStartedAt, delegation: parseDelegation(delegation) };
}

/** How much a record refuses, for rule 6's tie-break: only `ancestry` refuses session creation. */
function refusalRank(record: InstanceRecord): number {
  const below = depthBelow(record.delegation);
  if (below.provenance !== 'ancestry') return 0;
  return 1 + (below.depth ?? 0);
}

/**
 * Read every instance record under the data root, once, before the walk (ADR
 * 0033). The evidence is `instance.json`'s identity, with `instance.lock` as a
 * fallback: both files are written from one object, and a cleanly closed
 * instance keeps the manifest and drops the lock, so reading the lock alone
 * made the steady state of a data root read as doubt.
 *
 * An entry that yields no identity is **skipped** — it can never be matched,
 * and one damaged directory anywhere in the retention history must not withhold
 * every console on the machine. Doubt is reserved for an entry whose lock the
 * filesystem refused, and for an enumeration that could not be completed.
 *
 * @param dataRoot the resolved data root, whose `instances/` holds the records.
 * @param diagnostics optional out-parameter: filled with the record count, the
 *   scan duration, and the doubt's cause when the answer is `undefined`.
 * @returns one record per identity, or `undefined` for doubt.
 */
export async function readInstanceRecords(
  dataRoot: string,
  diagnostics?: DelegationDiagnostics,
): Promise<readonly InstanceRecord[] | undefined> {
  const root = join(resolve(dataRoot), 'instances');
  const startedAt = Date.now();
  const finish = <T>(answer: T, cause?: DoubtCause, count?: number): T => {
    if (diagnostics !== undefined) {
      diagnostics.scanMs = Date.now() - startedAt;
      if (count !== undefined) diagnostics.records = count;
      if (cause !== undefined) diagnostics.cause = cause;
    }
    return answer;
  };

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (cause) {
    // No instances directory at all is a complete answer: nothing is running,
    // so nothing can be an ancestor. Any other failure is doubt.
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return finish([], undefined, 0);
    return finish(undefined, 'scan-enumeration');
  }

  // The re-listing follows a directory recovery renamed between the listing and
  // the read. It is taken at most once per scan, lazily: per entry it would be
  // O(entries²) readdirs exactly when many entries move at once.
  let relisted: string[] | undefined;
  let relistFailed = false;
  const relist = async (): Promise<string[] | undefined> => {
    if (relisted === undefined && !relistFailed) {
      try { relisted = await readdir(root); } catch { relistFailed = true; }
    }
    return relisted;
  };

  /**
   * One entry's place in rule 3's chain. `absent` is kept apart from `skip`
   * because only a manifest that is *gone* earns the re-listing: an entry that
   * is there and yields nothing has nowhere else to be looked for.
   */
  const readEntry = async (entry: string): Promise<InstanceRecord | 'absent' | 'skip' | 'doubt'> => {
    const manifest = await readInstanceFile(join(root, entry, 'instance.json'));
    if (manifest.state === 'ok') {
      const record = recordFrom(manifest.value);
      if (record !== undefined) return record;
    }
    const lock = await readInstanceFile(join(root, entry, 'instance.lock'));
    if (lock.state === 'ok') {
      const record = recordFrom(lock.value);
      if (record !== undefined) return record;
    }
    if (manifest.state === 'absent') return 'absent';
    return lock.state === 'failed' ? 'doubt' : 'skip';
  };

  const found: InstanceRecord[] = [];
  const missing: string[] = [];
  for (const entry of entries) {
    const quarantined = QUARANTINE_NAME.exec(entry);
    // Every other dot-prefixed name is a directory that is not a published
    // instance — `.tmp-` staging, `.delete-` removal — and admitting those
    // would rebuild the accumulation this scan exists to survive.
    if (entry.startsWith('.') && quarantined === null) continue;
    const outcome = await readEntry(entry);
    if (outcome === 'doubt') {
      // A dot entry never puts the whole scan in doubt: where a published entry
      // would doubt, a quarantine name skips.
      if (quarantined !== null) continue;
      return finish(undefined, 'scan-unreadable');
    }
    if (outcome === 'skip') continue;
    if (outcome !== 'absent') { found.push(outcome); continue; }
    // The manifest was gone. Either recovery renamed the directory between the
    // listing and this read, or the removal completed; the re-listing decides.
    missing.push(entry);
  }

  for (const entry of missing) {
    const names = await relist();
    if (names === undefined) return finish(undefined, 'scan-enumeration');
    const quarantined = QUARANTINE_NAME.exec(entry);
    // A published entry may have moved to its quarantine name, and a quarantine
    // may have been renamed back; recovery does both, so the search runs both
    // ways rather than assuming a direction.
    const candidates = quarantined === null
      ? names.filter((name) => QUARANTINE_NAME.exec(name)?.[1] === entry)
      : names.filter((name) => name === quarantined[1]);
    for (const candidate of candidates) {
      const outcome = await readEntry(candidate);
      if (outcome !== 'absent' && outcome !== 'skip' && outcome !== 'doubt') { found.push(outcome); break; }
    }
  }

  // One identity contributes one record: an interrupted restore can leave a
  // quarantine beside the directory it was taken from, and two records of one
  // identity that disagree would otherwise let listing order pick the verdict.
  const byIdentity = new Map<string, InstanceRecord>();
  for (const record of found) {
    const key = `${record.instanceId}\u0000${record.pid}\u0000${record.processStartedAt}`;
    const held = byIdentity.get(key);
    if (held === undefined || refusalRank(record) > refusalRank(held)) byIdentity.set(key, record);
  }
  const records = [...byIdentity.values()];
  return finish(records, undefined, records.length);
}

/**
 * The verdict a caller gets when it never settled one: the marker alone, which
 * is exactly today's behaviour. Named rather than inlined so that every place
 * choosing it is greppable — an unsettled verdict is a deliberate fallback for
 * in-process construction, never something a production entry point should
 * reach.
 *
 * @param marker the parsed marker.
 * @returns `marker` with its depth, or `root` at depth 0.
 */
export function markerOnlyDelegation(marker: DelegationIdentity): DelegationRecord {
  if (markerSaysDelegated(marker)) return { provenance: 'marker', depth: marker.depth };
  return { provenance: 'root', depth: 0 };
}

/**
 * The one place that decides whether the marker alone already answers. It was
 * written out four times — the composition rule, the walk's short-circuit, the
 * marker-only fallback and the nanny's own guard — and four copies of one
 * judgement is three chances to drift.
 *
 * @param marker the parsed marker.
 * @returns whether the marker by itself establishes delegation.
 */
export function markerSaysDelegated(marker: DelegationIdentity): boolean {
  return marker.recursionDenied || marker.depth >= 1;
}

/**
 * Settle the verdict once, before anything is served (mvp §5.2). A marker that
 * already says delegated short-circuits the walk entirely: it is the stronger
 * evidence, and a worker should not pay a process-table scan to be told what it
 * was already told.
 *
 * @param options `marker` is the parsed marker; `dataRoot` is where the
 *   instance records are; `probe` and `pid` exist so a test can drive a
 *   synthetic tree; `diagnostics` is an out-parameter the caller may pass to
 *   learn what the scan read and which doubt the verdict reached.
 * @returns the composed verdict; never throws — a malformed marker has already
 *   thrown while being parsed, and every walk failure is `unavailable`.
 */
export const DEFAULT_SETTLE_BUDGET_MS = 2_000;

export async function settleDelegation(options: {
  marker: DelegationIdentity;
  dataRoot: string;
  pid?: number;
  probe?: AncestryProbe;
  maxHops?: number;
  budgetMs?: number;
  diagnostics?: DelegationDiagnostics;
}): Promise<DelegationRecord> {
  const diagnostics = options.diagnostics;
  if (markerSaysDelegated(options.marker)) {
    // Nothing was read, so the count and the duration have no value to report:
    // absent, rather than a zero that would read as "scanned and found none".
    if (diagnostics !== undefined) diagnostics.cause = 'no-scan';
    return composeDelegation(options.marker, { provenance: 'unavailable' });
  }
  const probe = options.probe ?? defaultAncestryProbe;
  // The hop bound alone does not bound time: on darwin each hop can cost a `ps`
  // that runs to its own five-second timeout, so 32 hops is minutes, in a path
  // that runs before the process serves anything. A lapsed budget is doubt like
  // any other — `unavailable` keeps the tools and withholds the console.
  const budgetMs = options.budgetMs ?? DEFAULT_SETTLE_BUDGET_MS;
  let lapsed = false;
  const deadline = new Promise<'lapsed'>((resolve) => {
    const timer = setTimeout(() => { lapsed = true; resolve('lapsed'); }, budgetMs);
    timer.unref?.();
  });
  let instances: readonly InstanceRecord[] | undefined;
  try {
    instances = await readInstanceRecords(options.dataRoot, diagnostics);
  } catch {
    instances = undefined;
    if (diagnostics !== undefined) diagnostics.cause ??= 'scan-unreadable';
  }
  let ancestry: DelegationRecord;
  try {
    const walked = await Promise.race([
      walkAncestry({
        pid: options.pid ?? process.pid,
        instances,
        probe,
        ...(options.maxHops === undefined ? {} : { maxHops: options.maxHops }),
        ...(diagnostics === undefined ? {} : { diagnostics }),
      }),
      deadline,
    ]);
    // The abandoned walk is not cancelled — `Promise.race` cannot — so it keeps
    // running; what the budget bounds is when the answer is decided, and the
    // caller is free to proceed on it.
    if (walked === 'lapsed' || lapsed) {
      // The scan's own doubt, if it had one, is the earlier cause and stands:
      // it is what made the lapse inevitable.
      if (diagnostics !== undefined) diagnostics.cause ??= 'budget-lapsed';
      ancestry = { provenance: 'unavailable' };
    } else ancestry = walked;
  } catch {
    // `walkAncestry` is total by construction; this is the belt to that
    // braces, because the one caller that matters is a top-level await in the
    // process entry point and a rejection there means no server at all.
    if (diagnostics !== undefined) diagnostics.cause ??= 'walk-error';
    ancestry = { provenance: 'unavailable' };
  }
  return composeDelegation(options.marker, ancestry);
}
