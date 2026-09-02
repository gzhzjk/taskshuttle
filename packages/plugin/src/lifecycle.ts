import { randomUUID, createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readdir, lstat, rename, rm, unlink, writeFile, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface LifecycleClock { now(): number; setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void; }
const realClock: LifecycleClock = { now: () => Date.now(), setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

export interface InstanceManifest {
  instanceId: string;
  createdAt: string;
  host: string;
  pid: number;
  /**
   * Canonical OS process start time, written through `processStartTime` — the
   * same helper the recursion boundary's ancestry walk reads (mvp §5.2). It is
   * **optional on purpose**: an identity that cannot be read is recorded absent
   * rather than defaulted to the current time, because a manufactured
   * timestamp makes the writer and the walker incomparable and the boundary
   * silently inert. An instance without it is simply never matched.
   */
  processStartedAt?: string;
  /**
   * The process that started this instance — its host — and that process's
   * canonical start time (ADR 0057).
   *
   * The nanny Stop hook is spawned by the same host, so the instance serving a
   * host session and that session's hook are siblings under this pid. It is the
   * only identity available to a hook that cannot call a tool, and §12's
   * sentence about one instance per host session is what it establishes.
   *
   * **Both fields or neither.** A pid without a start time can never be matched
   * — the match requires both, because a bare pid is reused — so recording one
   * alone would put a half-identity on disk that reads like evidence. Written
   * through the same `processStartTime` helper as `processStartedAt`, and for
   * the same reason: a manufactured timestamp makes writer and reader
   * incomparable and the boundary silently inert.
   */
  hostPid?: number;
  hostProcessStartedAt?: string;
  tokenHash: string;
  exePath: string;
  /** The delegation verdict this instance settled at boot (ADR 0031). */
  delegation?: { provenance: 'root' | 'marker' | 'ancestry' | 'unavailable'; depth?: number | undefined };
  /** SHA-256 of the instance launch token carried in worker shim argv. */
  launchTokenHash?: string;
  closedAt?: string;
  recoveredAt?: string;
}

export interface ProcessIdentity { exists: boolean; processStartedAt?: string; exePath?: string; }
export type ProcessInspector = (pid: number) => Promise<ProcessIdentity>;

async function defaultInspect(pid: number): Promise<ProcessIdentity> {
  try { process.kill(pid, 0); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ESRCH') return { exists: false }; return { exists: true }; }
  // One canonical start time on every platform (mvp §5.2): before this the
  // darwin path reported none at all, so no lock could ever be judged active
  // there and no ancestry match could ever fire.
  const processStartedAt = await processStartTime(pid);
  const exePath = await currentExePath(pid);
  if (processStartedAt !== undefined && exePath !== undefined) return { exists: true, processStartedAt, exePath };
  return { exists: true };
}

/** Resolved executable, by the same two platform paths as the start time. */
async function currentExePath(pid: number): Promise<string | undefined> {
  if (process.platform === 'linux') {
    try { return await realpath(`/proc/${pid}/exe`); } catch { return undefined; }
  }
  const command = (await ps(['-p', String(pid), '-o', 'comm=']))?.trim();
  return command !== undefined && command.length > 0 ? command : undefined;
}

/**
 * The host process's identity, for the manifest (ADR 0057).
 *
 * @param pid - the process that started this instance, normally `process.ppid`.
 * @param known - a start time the caller already has; tests supply it so no
 *   real process has to exist.
 * @returns both fields, or an empty object. Never one of the two: the hook's
 *   match needs the pid *and* the start time, so a pid on its own can never be
 *   matched, and writing it alone would leave a half-identity on disk that
 *   reads like evidence. A pid that is not a plausible process — 0 or 1, which
 *   is what `ppid` becomes once a parent has exited — records nothing, because
 *   nothing under it is a host session.
 */
async function hostIdentity(pid: number, known?: string): Promise<{ hostPid?: number; hostProcessStartedAt?: string }> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return {};
  const startedAt = known ?? await processStartTime(pid);
  if (startedAt === undefined || startedAt.length === 0) return {};
  return { hostPid: pid, hostProcessStartedAt: startedAt };
}

/** The default inspector, exported for the console-open liveness check (console-design §8.2). */
export const defaultProcessInspector: ProcessInspector = defaultInspect;

function json(value: unknown): string { return JSON.stringify(value) + '\n'; }
async function ensureMode(path: string, mode: number, directory: boolean): Promise<void> {
  const info = await lstat(path);
  if ((directory && !info.isDirectory()) || (!directory && !info.isFile()) || (info.mode & 0o777) !== mode) throw new Error(`unsafe instance path: ${path}`);
}

interface PathIdentity { readonly dev: number; readonly ino: number; }
async function directoryIdentity(path: string): Promise<PathIdentity> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700) throw new Error(`unsafe instance directory: ${path}`);
  return { dev: info.dev, ino: info.ino };
}
async function assertDirectoryIdentity(path: string, expected: PathIdentity): Promise<void> {
  const actual = await directoryIdentity(path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error(`instance directory identity changed: ${path}`);
}

interface StableJson { readonly value: unknown; readonly identity: PathIdentity; readonly handle: Awaited<ReturnType<typeof open>>; }
async function readStableJson(path: string): Promise<StableJson> {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600) throw new Error(`unsafe instance file: ${path}`);
    const text = await handle.readFile('utf8');
    return { value: JSON.parse(text) as unknown, identity: { dev: info.dev, ino: info.ino }, handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temp, json(value), { mode: 0o600, flag: 'wx' });
    await ensureMode(temp, 0o600, false);
    await rename(temp, path);
    await ensureMode(path, 0o600, false);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function removeOwnedDirectory(path: string, expected: PathIdentity): Promise<void> {
  const parent = resolve(path, '..');
  const quarantine = join(parent, `.delete-${randomUUID()}`);
  await rename(path, quarantine);
  try {
    const info = await lstat(quarantine);
    if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== expected.dev || info.ino !== expected.ino || (info.mode & 0o777) !== 0o700) throw new Error('instance directory identity changed during delete');
    await rm(quarantine, { recursive: true, force: false });
  } catch (error) {
    await rename(quarantine, path).catch(() => undefined);
    throw error;
  }
}

/** Owns one instance directory and lock. It never infers stale ownership from PID alone when identity is uncertain. */
export class InstanceManager {
  readonly instanceDir: string;
  readonly instanceId: string;
  readonly manifestPath: string;
  readonly lockPath: string;
  private lockHandle: Awaited<ReturnType<typeof open>> | undefined;
  private manifest: InstanceManifest;
  private readonly dirIdentity: PathIdentity;
  private readonly lockIdentity: PathIdentity;
  private closePromise: Promise<void> | undefined;

  private constructor(instanceDir: string, manifest: InstanceManifest, dirIdentity: PathIdentity, lockIdentity: PathIdentity) {
    this.instanceDir = instanceDir; this.instanceId = manifest.instanceId; this.manifest = manifest;
    this.dirIdentity = dirIdentity; this.lockIdentity = lockIdentity;
    this.manifestPath = join(instanceDir, 'instance.json'); this.lockPath = join(instanceDir, 'instance.lock');
  }

  static async create(options: { dataRoot: string; instanceId?: string; host?: string; pid?: number; processStartedAt?: string; exePath?: string; hostPid?: number; hostProcessStartedAt?: string; rootNonce: string; launchTokenHash?: string; delegation?: InstanceManifest['delegation']; now?: () => string }): Promise<InstanceManager> {
    const dataRoot = resolve(options.dataRoot);
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    await ensureMode(dataRoot, 0o700, true);
    const instances = join(dataRoot, 'instances'); await mkdir(instances, { recursive: true, mode: 0o700 }); await ensureMode(instances, 0o700, true);
    const id = options.instanceId ?? randomUUID();
    if (!/^[0-9a-f-]{20,64}$/i.test(id)) throw new Error('invalid instance id');
    const temp = join(instances, `.tmp-${randomUUID()}`); const finalDir = join(instances, id);
    await mkdir(temp, { recursive: false, mode: 0o700 });
    const now = options.now ?? (() => new Date().toISOString());
    const pid = options.pid ?? process.pid;
    const ownIdentity = options.processStartedAt === undefined || options.exePath === undefined ? await defaultInspect(pid) : undefined;
    if (options.launchTokenHash !== undefined && !/^[a-f0-9]{64}$/i.test(options.launchTokenHash)) throw new Error('invalid launch token hash');
    const host = await hostIdentity(options.hostPid ?? process.ppid, options.hostProcessStartedAt);
    const manifest: InstanceManifest = { instanceId: id, createdAt: now(), host: options.host ?? process.platform, pid, ...(((): { processStartedAt?: string } => { const started = options.processStartedAt ?? ownIdentity?.processStartedAt; return started === undefined ? {} : { processStartedAt: started }; })()), ...host, tokenHash: createHash('sha256').update(options.rootNonce).digest('hex'), exePath: options.exePath ?? ownIdentity?.exePath ?? process.execPath, ...(options.launchTokenHash === undefined ? {} : { launchTokenHash: options.launchTokenHash.toLowerCase() }), ...(options.delegation === undefined ? {} : { delegation: options.delegation }) };
    await writeFile(join(temp, 'instance.json'), json(manifest), { mode: 0o600, flag: 'wx' });
    await ensureMode(join(temp, 'instance.json'), 0o600, false);
    // Acquire the lock while the directory is still private, then publish the
    // complete manifest+lock directory in one rename. This prevents recovery
    // scanners from observing a published instance without an owner lock.
    const tempLock = join(temp, 'instance.lock');
    let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
    let published = false;
    try {
      lockHandle = await open(tempLock, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
      await lockHandle.writeFile(json(manifest)); await lockHandle.sync(); await ensureMode(tempLock, 0o600, false);
      await rename(temp, finalDir); published = true;
      const manager = new InstanceManager(finalDir, manifest, await directoryIdentity(finalDir), (await lstat(join(finalDir, 'instance.lock')))); manager.lockHandle = lockHandle;
      return manager;
    } catch (error) {
      await lockHandle?.close().catch(() => undefined);
      if (!published) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
      // A published directory with a failed post-publish identity check is
      // intentionally left for conservative next-start recovery.
      throw error;
    }
  }

  async close(options: { now?: () => string; retentionDays?: number | null } = {}): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closePromise = this.performClose(options);
    return this.closePromise;
  }
  private async performClose(options: { now?: () => string; retentionDays?: number | null }): Promise<void> {
    if (this.lockHandle === undefined) return;
    await assertDirectoryIdentity(this.instanceDir, this.dirIdentity);
    this.manifest = { ...this.manifest, closedAt: (options.now ?? (() => new Date().toISOString()))() };
    await atomicJsonWrite(this.manifestPath, this.manifest);
    await assertDirectoryIdentity(this.instanceDir, this.dirIdentity);
    // Backstop for the ConsoleServer's own removal: a console manifest must not
    // outlive its listener (console-design §4).
    await unlink(join(this.instanceDir, 'console.json')).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== 'ENOENT') throw cause; });
    const lockInfo = await lstat(this.lockPath);
    if (lockInfo.isSymbolicLink() || lockInfo.dev !== this.lockIdentity.dev || lockInfo.ino !== this.lockIdentity.ino || (lockInfo.mode & 0o777) !== 0o600) throw new Error('instance lock identity changed');
    await this.lockHandle.close(); this.lockHandle = undefined;
    await unlink(this.lockPath).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== 'ENOENT') throw cause; });
    if (options.retentionDays === 0) { await assertDirectoryIdentity(this.instanceDir, this.dirIdentity); await removeOwnedDirectory(this.instanceDir, this.dirIdentity); }
  }

  getManifest(): InstanceManifest { return structuredClone(this.manifest); }

  /**
   * Rewrite the display-only `host` label, in memory and in instance.json.
   * Host is operator-facing metadata (the console top bar shows it), not part
   * of recovery identity: the lock/manifest comparison deliberately excludes
   * it, so the lock copy is left untouched.
   * @throws {Error} when the label is empty, overlong, or carries characters
   *   that would break a log line or path.
   */
  async setHost(host: string): Promise<void> {
    if (host.length === 0 || host.length > 64 || !/^[\w.() -]+$/u.test(host)) throw new Error('invalid host label');
    this.manifest = { ...this.manifest, host };
    await atomicJsonWrite(this.manifestPath, this.manifest);
  }
}

/** Closed set of recovery outcomes; log lines never carry free-form text. */
export type RecoveryReason =
  | 'identity-uncertain'
  /** The owner is alive and its identity matches: nothing to do. */
  | 'active'
  /** The OS would not confirm the owner's identity, so nothing may be touched. */
  | 'identity-indeterminate'
  | 'recovery-contended'
  | 'crash-recovered'
  | 'closed-archive'
  | 'retention-expired'
  | 'recovery-failed';

export interface RecoveryResult {
  instanceId: string;
  recovered: boolean;
  deleted: boolean;
  reason: RecoveryReason;
  /** Diagnostic detail for humans; never logged (design §10.3 allowlist). */
  detail?: string;
  /** Present once the manifest was read; identifies worker shims launched by that instance. */
  launchTokenHash?: string;
  /** True only when this scan proved the instance lock dead and claimed the directory. */
  lockProvenDead?: boolean;
}
export interface RecoveryHooks {
  /** Called after the instance directory is claimed; use workDir to open the store under the same archive lane. */
  markSessionsAborted?: (instanceId: string, recoveredAt: string, workDir: string) => Promise<void> | void;
  /** Implementations must perform metadata/event deletion in their transcript lane and one transaction. */
  /** Returns true when non-eligible sessions remain and the instance directory must be retained. */
  deleteSessionsBefore?: (instanceId: string, cutoffMs: number, workDir: string) => Promise<boolean> | boolean;
  /**
   * Called for every instance whose lock this scan proved dead, while its
   * directory (and therefore its orphan markers) still exists — retention may
   * delete that directory moments later.
   */
  reapInstanceOrphans?: (instanceId: string, workDir: string, launchTokenHash?: string) => Promise<void> | void;
}

/** A recovery claim older than this, or whose owner is gone, is taken over. */
export const RECOVERY_LOCK_STALE_MS = 900_000;

/**
 * Claim the per-instance recovery lock. A claim left behind by a process that
 * crashed mid-recovery would otherwise strand the instance forever, so a lock
 * whose owner is provably gone (or that is unreadable/too old) is taken over.
 */
async function recoveryClaimIsStale(recoveryLock: string, inspect: ProcessInspector, now: number): Promise<boolean> {
  let value: { pid?: unknown; createdAt?: unknown };
  try {
    value = JSON.parse(await readFile(recoveryLock, 'utf8')) as { pid?: unknown; createdAt?: unknown };
  } catch (cause) {
    // An absent claim is trivially takeable. An unreadable one is only taken
    // over once it is older than the stale window: a partial write or a
    // permission error must not hand a live scanner's work to a second writer.
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return true;
    const info = await lstat(recoveryLock).catch(() => undefined);
    return info !== undefined && now - info.mtimeMs > RECOVERY_LOCK_STALE_MS;
  }
  const hasPid = typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0;
  // A claim whose owner is still running is never stale, however old it is:
  // a slow retention pass over a large archive must not be stolen (§9.2/§9.3).
  if (hasPid && (await inspect(value.pid as number)).exists) return false;
  if (hasPid) return true;
  const age = typeof value.createdAt === 'string' ? now - Date.parse(value.createdAt) : Number.NaN;
  return !Number.isFinite(age) || age > RECOVERY_LOCK_STALE_MS;
}

async function claimRecoveryLock(recoveryLock: string, inspect: ProcessInspector, now: number): Promise<Awaited<ReturnType<typeof open>> | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(recoveryLock, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      await handle.writeFile(json({ pid: process.pid, createdAt: new Date(now).toISOString() }));
      return handle;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
    }
    if (!(await recoveryClaimIsStale(recoveryLock, inspect, now))) return undefined;
    await unlink(recoveryLock).catch(() => undefined);
  }
  return undefined;
}

/**
 * Return quarantined directories from a crashed recovery to their instance
 * name. Without this the data is invisible to both this scan and the transcript
 * inventory, and can never be retention-deleted.
 */
async function restoreQuarantinedInstances(root: string, entries: readonly string[], inspect: ProcessInspector, now: number): Promise<boolean> {
  let restored = false;
  for (const entry of entries) {
    if (!entry.startsWith('.recovery-')) continue;
    const quarantine = join(root, entry);
    try {
      const stable = await readStableJson(join(quarantine, 'instance.json'));
      let instanceId: unknown;
      try { instanceId = (stable.value as InstanceManifest).instanceId; } finally { await stable.handle.close(); }
      if (typeof instanceId !== 'string' || !/^[0-9a-f-]{20,64}$/i.test(instanceId)) continue;
      const target = join(root, instanceId);
      if (await lstat(target).then(() => true, () => false)) continue;
      // A quarantine whose claim is still held by a live scanner belongs to
      // that scanner: taking it would create a second writer (§9.2/§9.3).
      const claim = join(quarantine, 'recovery.lock');
      if (!(await recoveryClaimIsStale(claim, inspect, now))) continue;
      await unlink(claim).catch(() => undefined);
      await rename(quarantine, target);
      restored = true;
    } catch { /* an unreadable leftover stays for manual diagnosis */ }
  }
  return restored;
}

export async function recoverAndApplyRetention(options: { dataRoot: string; now?: number; retentionDays?: number | null; inspectProcess?: ProcessInspector; currentInstanceId?: string; hooks?: RecoveryHooks }): Promise<RecoveryResult[]> {
  const dataRoot = resolve(options.dataRoot); await directoryIdentity(dataRoot);
  const root = join(dataRoot, 'instances'); await directoryIdentity(root);
  let entries: string[]; try { entries = await readdir(root); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []; throw cause; }
  const inspect = options.inspectProcess ?? defaultInspect; const now = options.now ?? Date.now(); const result: RecoveryResult[] = [];
  if (await restoreQuarantinedInstances(root, entries, inspect, now)) entries = await readdir(root);
  for (const entry of entries) {
    if (entry.startsWith('.tmp-') || entry.startsWith('.recovery-') || entry === options.currentInstanceId) continue;
    const dir = join(root, entry); const info = await lstat(dir).catch(() => undefined); if (info === undefined || info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700) continue;
    const dirIdentity = { dev: info.dev, ino: info.ino };
    const lock = join(dir, 'instance.lock'); const manifestPath = join(dir, 'instance.json');
    let manifest: InstanceManifest; try {
      const stable = await readStableJson(manifestPath);
      try { const manifestInfo = await lstat(manifestPath); if (manifestInfo.dev !== stable.identity.dev || manifestInfo.ino !== stable.identity.ino) throw new Error('manifest identity changed'); manifest = stable.value as InstanceManifest; }
      finally { await stable.handle.close(); }
      if (manifest.instanceId !== entry || typeof manifest.pid !== 'number' || !Number.isSafeInteger(manifest.pid) || manifest.pid < 1 || (manifest.processStartedAt !== undefined && typeof manifest.processStartedAt !== 'string') || typeof manifest.exePath !== 'string' || typeof manifest.tokenHash !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.tokenHash) || Number.isNaN(Date.parse(manifest.createdAt))) throw new Error('invalid instance manifest');
    } catch { result.push({ instanceId: entry, recovered: false, deleted: false, reason: 'identity-uncertain' }); continue; }
    const alreadyClosed = manifest.closedAt !== undefined;
    let lockPresent = true; let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const stable = await readStableJson(lock); const lockValue = stable.value as Partial<InstanceManifest>; lockHandle = stable.handle;
      if (lockValue.instanceId !== manifest.instanceId || lockValue.pid !== manifest.pid || lockValue.processStartedAt !== manifest.processStartedAt || lockValue.exePath !== manifest.exePath || lockValue.tokenHash !== manifest.tokenHash) throw new Error('lock/manifest identity mismatch');
      if (stable.identity.dev !== (await lstat(lock)).dev || stable.identity.ino !== (await lstat(lock)).ino) throw new Error('lock identity changed');
    } catch (cause) { await lockHandle?.close().catch(() => undefined); lockHandle = undefined; if ((cause as NodeJS.ErrnoException).code === 'ENOENT') lockPresent = false; else { result.push({ instanceId: entry, recovered: false, deleted: false, reason: 'identity-uncertain' }); continue; } }
    if (lockPresent || !alreadyClosed) {
      const identity = await inspect(manifest.pid);
      if (identity.exists) {
        // A manifest that never recorded a start time cannot be compared, and
        // two absences must not read as a match.
        if (identity.processStartedAt === undefined || identity.exePath === undefined || manifest.processStartedAt === undefined) { await lockHandle?.close(); result.push({ instanceId: entry, recovered: false, deleted: false, reason: 'identity-indeterminate', ...(manifest.launchTokenHash === undefined ? {} : { launchTokenHash: manifest.launchTokenHash }) }); continue; }
        if (identity.processStartedAt === manifest.processStartedAt && identity.exePath === manifest.exePath) { await lockHandle?.close(); result.push({ instanceId: entry, recovered: false, deleted: false, reason: 'active', ...(manifest.launchTokenHash === undefined ? {} : { launchTokenHash: manifest.launchTokenHash }) }); continue; }
        // Unequal is "proven PID reuse" only when both readings are in the same
        // format. A lock written before the two identity helpers converged
        // carries an ISO creation timestamp on darwin, and comparing that with
        // a `ps` date is unequal for a reason that is not PID reuse — treating
        // it as stale would recover a **live** instance. Cross-format is
        // uncertain identity: no recovery, no cleanup, the rule this scan
        // already applies to every other indeterminate reading.
        if (startTimeFamily(identity.processStartedAt) !== startTimeFamily(manifest.processStartedAt)) { await lockHandle?.close(); result.push({ instanceId: entry, recovered: false, deleted: false, reason: 'identity-indeterminate', ...(manifest.launchTokenHash === undefined ? {} : { launchTokenHash: manifest.launchTokenHash }) }); continue; }
        // A positive identity mismatch is a proven PID reuse, so the old lock
        // is stale and may be recovered. Missing identity data remains fail-closed above.
      }
    }
    const identityFields = manifest.launchTokenHash === undefined ? {} : { launchTokenHash: manifest.launchTokenHash };
    const recoveryLock = join(dir, 'recovery.lock');
    const handle = await claimRecoveryLock(recoveryLock, inspect, now);
    if (handle === undefined) { await lockHandle?.close().catch(() => undefined); result.push({ instanceId: entry, recovered: false, deleted: false, reason: 'recovery-contended', ...identityFields }); continue; }
    const quarantine = join(root, `.recovery-${entry}-${randomUUID()}`);
    try {
      // Atomically move the already-identified directory to a private name.
      // All writes/deletes happen under that name; if a pathname swap won the
      // race, the post-rename inode check fails closed and we never delete it.
      await rename(dir, quarantine);
      const movedInfo = await lstat(quarantine);
      if (movedInfo.dev !== dirIdentity.dev || movedInfo.ino !== dirIdentity.ino || (movedInfo.mode & 0o777) !== 0o700) throw new Error('instance directory changed during recovery claim');
      const workDir = quarantine;
      const workManifestPath = join(workDir, 'instance.json');
      const workLockPath = join(workDir, 'instance.lock');
      // The lock was proven dead by the identity rules above, so this
      // instance's console.json is stale: delete it here, without ever probing
      // the port — something else may hold it now (console-design §4).
      await unlink(join(workDir, 'console.json')).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== 'ENOENT') throw cause; });
      // Reap this instance's shims while its markers still exist: retention may
      // delete the whole directory below (§14).
      if (options.hooks?.reapInstanceOrphans !== undefined) {
        await options.hooks.reapInstanceOrphans(entry, workDir, manifest.launchTokenHash);
        await assertDirectoryIdentity(workDir, dirIdentity);
      }
      const recoveredAt = new Date(now).toISOString(); const recovered = alreadyClosed ? manifest : { ...manifest, recoveredAt, closedAt: recoveredAt };
      if (!alreadyClosed) {
        if (options.hooks?.markSessionsAborted === undefined) throw new Error('recovery session hook is not configured');
        await options.hooks.markSessionsAborted(entry, recoveredAt, workDir); await assertDirectoryIdentity(workDir, dirIdentity); await atomicJsonWrite(workManifestPath, recovered);
      }
      const retentionDays = options.retentionDays === undefined ? 30 : options.retentionDays;
      const closedAt = Date.parse(recovered.closedAt!);
      const cutoff = retentionDays === null ? Number.POSITIVE_INFINITY : now - retentionDays * 86_400_000;
      const eligible = retentionDays !== null && retentionDays >= 0 && Number.isFinite(closedAt) && closedAt <= cutoff;
      const remaining = eligible ? (options.hooks?.deleteSessionsBefore === undefined ? true : await options.hooks.deleteSessionsBefore(entry, cutoff, workDir)) : false;
      const canDeleteDirectory = eligible && remaining !== true;
      await assertDirectoryIdentity(workDir, dirIdentity);
      if (canDeleteDirectory) { await lockHandle?.close(); await handle.close(); await assertDirectoryIdentity(workDir, dirIdentity); await rm(workDir, { recursive: true, force: false }); result.push({ instanceId: entry, recovered: !alreadyClosed, deleted: true, reason: 'retention-expired', lockProvenDead: true, ...identityFields }); }
      else {
        await lockHandle?.close(); if (lockPresent) await unlink(workLockPath).catch(() => undefined); await handle.close(); await unlink(join(workDir, 'recovery.lock')).catch(() => undefined);
        try { await lstat(dir); throw new Error('instance path was recreated during recovery'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await rename(workDir, dir);
        result.push({ instanceId: entry, recovered: !alreadyClosed, deleted: false, reason: alreadyClosed ? 'closed-archive' : 'crash-recovered', lockProvenDead: true, ...identityFields });
      }
    } catch (cause) {
      await lockHandle?.close().catch(() => undefined); await handle.close().catch(() => undefined);
      // The rename may not have happened; clear the claim wherever it lives.
      await unlink(join(quarantine, 'recovery.lock')).catch(() => undefined);
      await unlink(recoveryLock).catch(() => undefined);
      try { await lstat(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') await rename(quarantine, dir).catch(() => undefined); }
      result.push({ instanceId: entry, recovered: false, deleted: false, reason: 'recovery-failed', ...(cause instanceof Error ? { detail: cause.message } : {}), ...identityFields });
    }
  }
  return result;
}

export interface LifecycleHub { quit(engineId?: undefined, options?: { timeoutMs?: number }): Promise<unknown>; }
export interface LifecycleResult { status: 'closed' | 'failed'; error?: unknown; quitCalls: number; }

/** Shutdown orchestration with a single-flight quit and no second kill chain. */
export class LifecycleManager {
  private shutdownPromise: Promise<LifecycleResult> | undefined;
  private quitCalls = 0;
  private acceptingMutations = true;
  constructor(private readonly options: { hub: LifecycleHub; stopMutations?: () => void | Promise<void>; cancelQueuedTurns?: () => void | Promise<void>; flush?: () => void | Promise<void>; closeStore?: () => void | Promise<void>; releaseLock?: () => void | Promise<void>; deleteEligible?: () => void | Promise<void>; clock?: LifecycleClock; maxWaitMs?: number }) {}
  shutdown(): Promise<LifecycleResult> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.acceptingMutations = false;
    this.shutdownPromise = this.runShutdown();
    return this.shutdownPromise;
  }
  get acceptsMutations(): boolean { return this.acceptingMutations; }
  get quitCount(): number { return this.quitCalls; }
  private async runShutdown(): Promise<LifecycleResult> {
    const clock = this.options.clock ?? realClock; const maxWait = this.options.maxWaitMs ?? 15_000;
    const failures: unknown[] = [];
    const step = async (operation: (() => void | Promise<void>) | undefined): Promise<boolean> => { if (operation === undefined) { failures.push(new Error('lifecycle ownership hook is not configured')); return false; } try { await operation(); return true; } catch (error) { failures.push(error); return false; } };
    const mutationsStopped = await step(this.options.stopMutations);
    // Step 2 of §14: queued turns cancelled and timers stopped — before quit,
    // and cheap enough to stay inside the shutdown budget.
    const queuedCancelled = await step(this.options.cancelQueuedTurns);
    this.quitCalls += 1;
    // §14.4 bounds the whole post-quit wait at 15 s: quit and the drain that
    // follows it share one deadline instead of each getting a fresh budget.
    const startedAt = clock.now();
    const remaining = (): number => Math.max(0, maxWait - (clock.now() - startedAt));
    const withDeadline = async <T>(work: Promise<T>, message: string): Promise<T> => {
      let timer: unknown;
      const deadline = new Promise<never>((_, reject) => { timer = clock.setTimeout(() => reject(new Error(message)), remaining()); });
      try { return await Promise.race([work, deadline]); } finally { if (timer !== undefined) clock.clearTimeout(timer); }
    };
    let quitSucceeded = false;
    try {
      await withDeadline(Promise.resolve(this.options.hub.quit(undefined, { timeoutMs: 3_000 })), 'Realm shutdown timed out');
      quitSucceeded = true;
    } catch (error) { failures.push(error); }
    // Drain in-flight executions after quit: Realm rejects/cancels the prompts,
    // so this settles instead of racing the quit budget (§14.3-4).
    const flushed = this.options.flush === undefined
      ? await step(undefined)
      : await (async () => {
          try { await withDeadline(Promise.resolve(this.options.flush!()), 'shutdown drain timed out'); return true; }
          catch (error) { failures.push(error); return false; }
        })();
    // Ownership-bearing cleanup is gated by a settled Realm quit and a closed
    // store. If either barrier fails, keep lock/data for next-start recovery.
    if (quitSucceeded && mutationsStopped && queuedCancelled && flushed) {
      const storeClosed = await step(this.options.closeStore);
      if (storeClosed) {
        const lockReleased = await step(this.options.releaseLock);
        if (lockReleased) await step(this.options.deleteEligible);
      }
    }
    return failures.length === 0 ? { status: 'closed', quitCalls: this.quitCalls } : { status: 'failed', error: failures[0], quitCalls: this.quitCalls };
  }
}

export interface OrphanRecord { pid: number; processGroupId: number; processStartedAt: string; instanceTokenHash: string; exePath: string; }
export interface OrphanIdentity { exists: boolean; processStartedAt?: string; instanceTokenHash?: string; exePath?: string; processGroupId?: number; }
export interface OrphanGroupIdentity { exists: boolean; leaderPid?: number; processGroupId?: number; }
export interface OrphanKiller { inspect(pid: number): Promise<OrphanIdentity>; inspectGroup(processGroupId: number): Promise<OrphanGroupIdentity>; termGroup(processGroupId: number): Promise<void>; killGroup(processGroupId: number): Promise<void>; waitGroup(processGroupId: number, timeoutMs: number): Promise<boolean>; }

/** Reaps only a fully identified orphan after its owning instance lock is known dead. */
export class OrphanReaper {
  constructor(private readonly graceMs = 3_000) {}
  async reap(record: OrphanRecord, identity: OrphanIdentity, ownerLockDead: boolean, killer: OrphanKiller): Promise<'reaped' | 'skipped' | 'survived'> {
    if (!Number.isSafeInteger(record.pid) || record.pid < 2 || !Number.isSafeInteger(record.processGroupId) || record.processGroupId < 2 || record.processGroupId !== record.pid) return 'skipped';
    const matches = (candidate: OrphanIdentity): boolean => candidate.exists && candidate.processGroupId === record.processGroupId && record.processGroupId === record.pid && candidate.processStartedAt === record.processStartedAt && candidate.instanceTokenHash === record.instanceTokenHash && candidate.exePath === record.exePath;
    const groupMatches = async (): Promise<boolean> => { const group = await killer.inspectGroup(record.processGroupId); return group.exists && group.processGroupId === record.processGroupId && group.leaderPid === record.pid; };
    if (!ownerLockDead || !matches(identity) || !matches(await killer.inspect(record.pid)) || !(await groupMatches())) return 'skipped';
    await killer.termGroup(record.processGroupId);
    if (await killer.waitGroup(record.processGroupId, this.graceMs)) return 'reaped';
    if (!matches(await killer.inspect(record.pid)) || !(await groupMatches())) return 'skipped';
    await killer.killGroup(record.processGroupId);
    return (await killer.waitGroup(record.processGroupId, this.graceMs)) ? 'reaped' : 'survived';
  }
}

async function ps(args: readonly string[]): Promise<string | undefined> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolvePs) => {
    execFile('ps', [...args], { timeout: 5_000 }, (error, stdout) => resolvePs(error ? undefined : stdout));
  });
}

/**
 * The one canonical process start time (mvp §5.2). Every writer and every
 * reader goes through this, so the lock a root writes and the identity a
 * booting descendant reads are comparable; two helpers with two formats would
 * never compare equal and the recursion boundary would be silently inert.
 *
 * @param pid process to inspect.
 * @returns `/proc` start ticks on Linux, `ps -o lstart=` elsewhere, or
 *   `undefined` when the identity cannot be read — never a substitute value.
 */
export async function processStartTime(pid: number): Promise<string | undefined> {
  if (process.platform === 'linux') {
    try {
      const statText = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = statText.slice(statText.lastIndexOf(')') + 2).split(' ');
      return fields[19];
    } catch { return undefined; }
  }
  const started = (await ps(['-p', String(pid), '-o', 'lstart=']))?.trim();
  return started !== undefined && started.length > 0 ? started : undefined;
}

/**
 * Parent pid, for the ancestry walk.
 *
 * @param pid process to inspect.
 * @returns the parent pid, or `undefined` when it cannot be read — which the
 *   walk treats as doubt rather than as the end of the chain.
 */
export async function parentProcessId(pid: number): Promise<number | undefined> {
  if (process.platform === 'linux') {
    try {
      const statText = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = statText.slice(statText.lastIndexOf(')') + 2).split(' ');
      const parent = fields[1];
      return parent !== undefined && /^\d+$/.test(parent) ? Number(parent) : undefined;
    } catch { return undefined; }
  }
  const parent = (await ps(['-p', String(pid), '-o', 'ppid=']))?.trim();
  return parent !== undefined && /^\d+$/.test(parent) ? Number(parent) : undefined;
}

/**
 * Which format a stored `processStartedAt` is in. Locks written before the two
 * helpers converged carry an ISO creation timestamp on darwin, and comparing
 * one of those against a `ps` date yields "unequal" for a reason that is not
 * PID reuse — which would license recovering a **live** instance. Callers
 * compare families first and treat a cross-family reading as uncertain.
 *
 * @param value the stored or freshly read start time.
 * @returns the family, or `undefined` for an empty or unrecognised value.
 */
export function startTimeFamily(value: string | undefined): 'ticks' | 'lstart' | 'legacy-iso' | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (/^\d+$/.test(value)) return 'ticks';
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return 'legacy-iso';
  return 'lstart';
}

const TOKEN_ARG = '--realm-instance-token=';

function tokenHashFromArgs(args: string | undefined): string | undefined {
  if (args === undefined) return undefined;
  const index = args.indexOf(TOKEN_ARG);
  if (index < 0) return undefined;
  const token = args.slice(index + TOKEN_ARG.length).split(/\s/u)[0];
  if (token === undefined || token.length === 0) return undefined;
  return createHash('sha256').update(token).digest('hex');
}

/** OS identity of a process, or a fail-closed partial record when unavailable. */
export async function inspectProcessIdentity(pid: number): Promise<OrphanIdentity> {
  try { process.kill(pid, 0); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ESRCH') return { exists: false }; }
  const identity: { exists: true; processStartedAt?: string; exePath?: string; processGroupId?: number; instanceTokenHash?: string } = { exists: true };
  if (process.platform === 'linux') {
    const started = await processStartTime(pid);
    if (started !== undefined) identity.processStartedAt = started;
    try {
      const statText = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = statText.slice(statText.lastIndexOf(')') + 2).split(' ');
      if (fields[2] !== undefined && /^\d+$/.test(fields[2])) identity.processGroupId = Number(fields[2]);
    } catch { /* identity unavailable: fail closed */ }
    try { identity.exePath = await realpath(`/proc/${pid}/exe`); } catch { /* fail closed */ }
    try {
      const hash = tokenHashFromArgs((await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').join(' '));
      if (hash !== undefined) identity.instanceTokenHash = hash;
    } catch { /* fail closed */ }
  } else {
    const started = await processStartTime(pid);
    if (started !== undefined) identity.processStartedAt = started;
    const group = (await ps(['-p', String(pid), '-o', 'pgid=']))?.trim();
    if (group !== undefined && /^\d+$/.test(group)) identity.processGroupId = Number(group);
    const command = (await ps(['-p', String(pid), '-o', 'comm=']))?.trim();
    if (command !== undefined && command.length > 0) identity.exePath = command;
    const hash = tokenHashFromArgs((await ps(['-p', String(pid), '-o', 'args=']))?.trim());
    if (hash !== undefined) identity.instanceTokenHash = hash;
  }
  return identity;
}

/** Snapshot the current process for the orphan marker, using the reaper's format. */
export async function captureSelfOrphanRecord(instanceTokenHash: string): Promise<OrphanRecord | undefined> {
  const identity = await inspectProcessIdentity(process.pid);
  if (!identity.exists || identity.processStartedAt === undefined || identity.exePath === undefined || identity.processGroupId === undefined) return undefined;
  return { pid: process.pid, processGroupId: identity.processGroupId, processStartedAt: identity.processStartedAt, exePath: identity.exePath, instanceTokenHash };
}

/** Real OS killer; every unknown identity resolves to a non-match, never a kill. */
export function createProcessOrphanKiller(): OrphanKiller {
  const alive = async (processGroupId: number): Promise<number[]> => {
    const output = await ps(['-g', String(processGroupId), '-o', 'pid=']);
    if (output === undefined) return [];
    return output.split('\n').map((line) => line.trim()).filter((line) => /^\d+$/.test(line)).map(Number);
  };
  return {
    inspect: (pid) => inspectProcessIdentity(pid),
    async inspectGroup(processGroupId) {
      const pids = await alive(processGroupId);
      if (pids.length === 0) return { exists: false };
      return { exists: true, processGroupId, ...(pids.includes(processGroupId) ? { leaderPid: processGroupId } : {}) };
    },
    async termGroup(processGroupId) { try { process.kill(-processGroupId, 'SIGTERM'); } catch { /* already gone */ } },
    async killGroup(processGroupId) { try { process.kill(-processGroupId, 'SIGKILL'); } catch { /* already gone */ } },
    async waitGroup(processGroupId, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if ((await alive(processGroupId)).length === 0) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((done) => setTimeout(done, 100));
      }
    },
  };
}

/**
 * Read the orphan markers written by the launch shim. Malformed or partial
 * markers are ignored rather than guessed at: an unidentified process is never
 * a reap candidate.
 */
export async function readOrphanRecords(markerRoot: string): Promise<Array<{ path: string; record: OrphanRecord }>> {
  const directory = join(resolve(markerRoot), 'orphans');
  let entries: string[];
  try { entries = await readdir(directory); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []; throw cause; }
  const records: Array<{ path: string; record: OrphanRecord }> = [];
  for (const entry of entries) {
    if (!entry.endsWith('.orphan.json')) continue;
    const path = join(directory, entry);
    try {
      const stable = await readStableJson(path);
      try {
        const value = stable.value as Partial<OrphanRecord>;
        if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid < 2) continue;
        if (typeof value.processGroupId !== 'number' || !Number.isSafeInteger(value.processGroupId) || value.processGroupId < 2) continue;
        if (typeof value.processStartedAt !== 'string' || value.processStartedAt.length === 0) continue;
        if (typeof value.exePath !== 'string' || value.exePath.length === 0) continue;
        if (typeof value.instanceTokenHash !== 'string' || !/^[a-f0-9]{64}$/i.test(value.instanceTokenHash)) continue;
        records.push({ path, record: { pid: value.pid, processGroupId: value.processGroupId, processStartedAt: value.processStartedAt, exePath: value.exePath, instanceTokenHash: value.instanceTokenHash.toLowerCase() } });
      } finally { await stable.handle.close(); }
    } catch { /* an unreadable marker stays for manual diagnosis */ }
  }
  return records;
}

export interface OrphanReapOutcome { pid: number; outcome: 'reaped' | 'skipped' | 'survived'; markerRemoved: boolean }

/**
 * Reap shim process groups whose owning instance lock was proven dead in this
 * start-up scan. Ownership is keyed by the instance launch token hash, so a
 * live instance's workers are never candidates.
 */
export async function reapOrphans(options: {
  /** Marker roots to sweep; each instance owns its own `<instance-dir>/orphans`. */
  markerRoots: readonly string[];
  reapableTokenHashes: ReadonlySet<string>;
  killer: OrphanKiller;
  reaper?: OrphanReaper;
}): Promise<OrphanReapOutcome[]> {
  const reaper = options.reaper ?? new OrphanReaper();
  const outcomes: OrphanReapOutcome[] = [];
  const records = (await Promise.all(options.markerRoots.map((root) => readOrphanRecords(root).catch(() => [])))).flat();
  for (const { path, record } of records) {
    let identity: OrphanIdentity;
    try { identity = await options.killer.inspect(record.pid); }
    catch { outcomes.push({ pid: record.pid, outcome: 'skipped', markerRemoved: false }); continue; }
    // The described process is provably gone, so the marker describes nothing
    // and would otherwise accumulate forever.
    if (!identity.exists) {
      outcomes.push({ pid: record.pid, outcome: 'skipped', markerRemoved: await unlink(path).then(() => true, () => false) });
      continue;
    }
    if (!options.reapableTokenHashes.has(record.instanceTokenHash)) continue;
    let outcome: 'reaped' | 'skipped' | 'survived';
    try { outcome = await reaper.reap(record, identity, true, options.killer); }
    catch { outcome = 'skipped'; }
    let markerRemoved = false;
    if (outcome === 'reaped') { markerRemoved = await unlink(path).then(() => true, () => false); }
    outcomes.push({ pid: record.pid, outcome, markerRemoved });
  }
  return outcomes;
}

export class RetentionScheduler {
  private timer: unknown | undefined;
  private stopped = true;
  /** A run that returns false was skipped and is re-armed after `retryMs`. */
  constructor(
    private readonly clock: LifecycleClock = realClock,
    private readonly run: () => void | boolean | Promise<void | boolean>,
    private readonly intervalMs = 86_400_000,
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly retryMs = 60_000,
  ) {}
  private generation = 0;
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // A run started before a stop()/start() cycle must not arm a timer for the
    // new generation: only the generation that scheduled a tick may re-arm it.
    const generation = ++this.generation;
    const tick = (): void => {
      if (this.stopped || generation !== this.generation) return;
      this.timer = undefined;
      let next = this.intervalMs;
      Promise.resolve().then(() => this.run())
        .then((outcome) => { if (outcome === false) next = this.retryMs; })
        .catch((error) => { this.onError(error); })
        .finally(() => { if (!this.stopped && generation === this.generation) this.timer = this.clock.setTimeout(tick, next); });
    };
    this.timer = this.clock.setTimeout(tick, this.intervalMs);
  }
  stop(): void { this.stopped = true; if (this.timer !== undefined) this.clock.clearTimeout(this.timer); this.timer = undefined; }
}
