import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { InstanceManifest, ProcessInspector } from './lifecycle.js';
import { defaultProcessInspector, startTimeFamily } from './lifecycle.js';

/**
 * Finding the live instances under a data root.
 *
 * This lived inside `console/open.ts` until the nanny hook needed the same
 * answer. It moved rather than being copied: "is this instance alive" is one
 * judgement, and two implementations of it would disagree the first time either
 * changed. The console still owns everything about consoles — this owns only
 * liveness and the directory walk.
 */

/** Reads JSON, treating anything unreadable as absent — never repaired, never guessed at. */
export async function readInstanceJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) as unknown; } catch { return undefined; }
}

/**
 * console-design §4 lock liveness: the lock must restate the manifest identity
 * and the owning process must exist; when the OS cannot supply identity fields
 * — a `/proc` read that fails and a `ps` that does are both this case, not
 * "non-Linux" as this note used to say — the scan fails closed toward "do not
 * touch", which here means the instance still counts as alive. The port is
 * never connected to.
 *
 * @param instanceDir - the instance directory to judge.
 * @param inspect - process identity lookup; injected so tests need no real pid.
 * @returns whether the instance's owning process is still believed to be alive.
 */
export async function lockAlive(instanceDir: string, inspect: ProcessInspector): Promise<boolean> {
  const manifest = (await readInstanceJson(join(instanceDir, 'instance.json'))) as InstanceManifest | undefined;
  const lock = (await readInstanceJson(join(instanceDir, 'instance.lock'))) as Partial<InstanceManifest> | undefined;
  if (manifest === undefined || lock === undefined) return false;
  if (typeof manifest.pid !== 'number' || !Number.isSafeInteger(manifest.pid) || manifest.pid < 1) return false;
  if (lock.instanceId !== manifest.instanceId || lock.pid !== manifest.pid
    || lock.processStartedAt !== manifest.processStartedAt || lock.exePath !== manifest.exePath
    || lock.tokenHash !== manifest.tokenHash) return false;
  const identity = await inspect(manifest.pid);
  if (!identity.exists) return false;
  if (identity.processStartedAt === undefined || identity.exePath === undefined) return true;
  // A manifest that never recorded a start time cannot be compared with one
  // that can now be read; that is missing identity, not a mismatch.
  if (manifest.processStartedAt === undefined) return true;
  // Unequal is "proven PID reuse" only within one format family. A lock written
  // before the identity helpers converged carries an ISO creation timestamp on
  // darwin, and comparing that with a `ps` date is unequal for a reason that is
  // not PID reuse — which here would hide a **live** instance from `console
  // open` and from the nanny's discovery (ADR 0031).
  if (startTimeFamily(identity.processStartedAt) !== startTimeFamily(manifest.processStartedAt)) return true;
  // A positive mismatch is proven PID reuse: the lock describes a dead process.
  return identity.processStartedAt === manifest.processStartedAt && identity.exePath === manifest.exePath;
}

export interface LiveInstance {
  readonly instanceId: string;
  readonly instanceDir: string;
  readonly createdAt: string;
  /**
   * The host process this instance was started by, and that process's start
   * time — both or neither (ADR 0057). Carried here because the walk already
   * reads the manifest to establish liveness, so the nanny's identity match
   * costs no second read. Absent on every instance written before ADR 0057, and
   * such an instance is never matched.
   */
  readonly hostPid?: number;
  readonly hostProcessStartedAt?: string;
}

/**
 * Every live instance under a data root, newest first.
 *
 * Unlike the console's candidate scan this does not require `console.json` —
 * the console is off by default, and a nanny that only worked where someone had
 * turned it on would be no nanny at all.
 *
 * @param dataRoot - the plugin data root; a missing `instances/` answers empty.
 * @param inspect - process identity lookup, passed through to {@link lockAlive}.
 * @returns live instances, newest `createdAt` first; malformed entries are skipped.
 */
export async function findLiveInstances(
  dataRoot: string,
  inspect: ProcessInspector = defaultProcessInspector,
): Promise<LiveInstance[]> {
  const root = join(dataRoot, 'instances');
  let entries: string[];
  try { entries = await readdir(root); } catch { return []; }
  const live: LiveInstance[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const instanceDir = join(root, entry);
    if (!(await lockAlive(instanceDir, inspect))) continue;
    const manifest = (await readInstanceJson(join(instanceDir, 'instance.json'))) as InstanceManifest | undefined;
    if (manifest === undefined || typeof manifest.instanceId !== 'string') continue;
    // Both or neither, read the way the writer wrote them: a manifest carrying
    // only one of the pair is not a usable identity and is treated as absent.
    const host = typeof manifest.hostPid === 'number' && Number.isSafeInteger(manifest.hostPid) && manifest.hostPid > 1
      && typeof manifest.hostProcessStartedAt === 'string' && manifest.hostProcessStartedAt.length > 0
      ? { hostPid: manifest.hostPid, hostProcessStartedAt: manifest.hostProcessStartedAt }
      : {};
    live.push({ instanceId: manifest.instanceId, instanceDir, createdAt: String(manifest.createdAt ?? ''), ...host });
  }
  return live.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
