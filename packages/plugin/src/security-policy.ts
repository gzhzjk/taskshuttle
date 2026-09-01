import { createHash, randomBytes } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';

export const DELEGATION_VERSION = '1';
export const DELEGATION_ENV = {
  version: 'TASKSHUTTLE_DELEGATION_VERSION',
  depth: 'TASKSHUTTLE_DELEGATION_DEPTH',
  root: 'TASKSHUTTLE_DELEGATION_ROOT',
} as const;
const LEGACY_DELEGATION_ENV = { version: 'REALM_DELEGATION_VERSION', depth: 'REALM_DELEGATION_DEPTH', root: 'REALM_DELEGATION_ROOT' } as const;

export interface DelegationIdentity {
  readonly version: 1;
  readonly depth: number;
  readonly rootNonce: string;
  readonly rootNonceHash: string;
  readonly recursionDenied: boolean;
}

export class SecurityPolicyError extends Error {
  readonly code: 'RECURSION_DENIED' | 'PERMISSION_DENIED' | 'INVALID_ARGUMENT';
  constructor(message: string, code: 'RECURSION_DENIED' | 'PERMISSION_DENIED' | 'INVALID_ARGUMENT' = 'PERMISSION_DENIED') {
    super(message);
    this.code = code;
    this.name = 'SecurityPolicyError';
  }
}

function nonceHash(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex').slice(0, 16);
}

function parseNonce(value: string): string {
  if (!/^[a-f0-9]{32,}$/i.test(value) || value.length % 2 !== 0) throw new SecurityPolicyError('delegation root nonce is invalid', 'RECURSION_DENIED');
  return value.toLowerCase();
}

/** Parse the marker inherited by a plugin instance. Partial or malformed markers fail closed. */
export function readDelegationIdentity(env: NodeJS.ProcessEnv = process.env): DelegationIdentity {
  const current = [env[DELEGATION_ENV.version], env[DELEGATION_ENV.depth], env[DELEGATION_ENV.root]];
  const legacy = [env[LEGACY_DELEGATION_ENV.version], env[LEGACY_DELEGATION_ENV.depth], env[LEGACY_DELEGATION_ENV.root]];
  if (current.every((value) => value === undefined) && legacy.every((value) => value === undefined)) {
    const rootNonce = randomBytes(16).toString('hex');
    return { version: 1, depth: 0, rootNonce, rootNonceHash: nonceHash(rootNonce), recursionDenied: false };
  }
  type ParsedMarker = DelegationIdentity | { readonly partial: true; readonly depth: number };
  const isPartial = (marker: ParsedMarker | undefined): marker is { readonly partial: true; readonly depth: number } => marker !== undefined && 'partial' in marker;
  const parse = (values: readonly (string | undefined)[]): ParsedMarker | undefined => {
    if (values.every((value) => value === undefined)) return undefined;
    const [version, depthText, root] = values;
    if (version !== undefined && version !== DELEGATION_VERSION) throw new SecurityPolicyError('delegation marker is malformed', 'RECURSION_DENIED');
    if (depthText !== undefined && (!/^\d+$/.test(depthText) || !Number.isSafeInteger(Number(depthText)) || Number(depthText) < 1 || Number(depthText) > 1024)) {
      throw new SecurityPolicyError('delegation depth is invalid', 'RECURSION_DENIED');
    }
    if (root !== undefined && (!/^[a-f0-9]{32,}$/i.test(root) || root.length % 2 !== 0)) {
      throw new SecurityPolicyError('delegation marker is malformed', 'RECURSION_DENIED');
    }
    const depth = depthText === undefined ? 1 : Number(depthText);
    if (version === undefined || depthText === undefined || root === undefined) return { partial: true, depth };
    const parsedRoot = parseNonce(root);
    return { version: 1, depth, rootNonce: parsedRoot, rootNonceHash: nonceHash(parsedRoot), recursionDenied: true };
  };
  const parsedCurrent = parse(current); const parsedLegacy = parse(legacy);
  if (parsedCurrent === undefined && isPartial(parsedLegacy)) throw new SecurityPolicyError('delegation marker is incomplete', 'RECURSION_DENIED');
  if (parsedLegacy === undefined && isPartial(parsedCurrent)) throw new SecurityPolicyError('delegation marker is incomplete', 'RECURSION_DENIED');
  if (parsedCurrent === undefined) return parsedLegacy! as DelegationIdentity;
  if (parsedLegacy === undefined) return parsedCurrent as DelegationIdentity;
  const depth = Math.max(parsedCurrent.depth, parsedLegacy.depth);
  const identity = [parsedCurrent, parsedLegacy]
    .filter((marker): marker is DelegationIdentity => !('partial' in marker))
    .sort((left, right) => right.depth - left.depth)[0];
  if (identity === undefined) throw new SecurityPolicyError('delegation marker is incomplete', 'RECURSION_DENIED');
  const rootNonce = identity.rootNonce;
  return { version: 1, depth, rootNonce, rootNonceHash: nonceHash(rootNonce), recursionDenied: true };
}

export function createWorkerEnvironment(base: NodeJS.ProcessEnv, identity: DelegationIdentity): NodeJS.ProcessEnv {
  return {
    ...base,
    [DELEGATION_ENV.version]: DELEGATION_VERSION,
    [DELEGATION_ENV.depth]: String(identity.depth + 1),
    [DELEGATION_ENV.root]: identity.rootNonce,
  };
}

export function assertSessionCreationAllowed(identity: DelegationIdentity): void {
  if (identity.recursionDenied || identity.depth >= 1) throw new SecurityPolicyError('nested Realm delegation is denied', 'RECURSION_DENIED');
}

export interface McpCatalogEntry {
  readonly id: string;
  readonly transport: 'stdio' | 'sse' | 'streamable-http';
  readonly startupTimeoutMs: number;
  readonly connectionTimeoutMs: number;
  readonly permissionDescription: string;
  readonly secretReference?: string;
}

// ADR 0041 decision 1: this set **grows** when the dependency renames — it does
// not move. A name that stops being ours does not stop being confusable, so
// `realm-node` stays refused alongside `runskein`.
//
// It moved once, by accident, and the accident is worth a line here: step 10 of
// the runskein migration rewrote quoted `'realm-node'` occurrences to rename
// import specifiers, and this string literal matched. The result read as a
// rename — `realm-node` out, `runskein` in — while actually releasing a name
// the security policy is supposed to refuse. A `Set` swallowed the duplicate
// that gave it away.
const REALM_ALIASES = new Set(['realm-plugin', 'realm-agent-plugin', 'taskshuttle', 'realm', 'realm-node', 'runskein']);
const ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

export function validateMcpCatalog(catalog: Readonly<Record<string, McpCatalogEntry>>): void {
  for (const [key, entry] of Object.entries(catalog)) {
    if (!ID_PATTERN.test(key) || REALM_ALIASES.has(key.toLowerCase()) || entry === undefined || entry.id !== key) throw new SecurityPolicyError(`invalid MCP catalog id: ${key}`, 'INVALID_ARGUMENT');
    const allowedFields = new Set(['id', 'transport', 'startupTimeoutMs', 'connectionTimeoutMs', 'permissionDescription', 'secretReference']);
    if (Object.keys(entry).some((field) => !allowedFields.has(field))) throw new SecurityPolicyError(`raw MCP command/url/header/env is not allowed for ${key}`, 'INVALID_ARGUMENT');
    if (!['stdio', 'sse', 'streamable-http'].includes(entry.transport)) throw new SecurityPolicyError(`invalid MCP transport for ${key}`, 'INVALID_ARGUMENT');
    if (!Number.isInteger(entry.startupTimeoutMs) || entry.startupTimeoutMs < 100 || entry.startupTimeoutMs > 120_000) throw new SecurityPolicyError(`invalid MCP startup timeout for ${key}`, 'INVALID_ARGUMENT');
    if (!Number.isInteger(entry.connectionTimeoutMs) || entry.connectionTimeoutMs < 100 || entry.connectionTimeoutMs > 120_000) throw new SecurityPolicyError(`invalid MCP connection timeout for ${key}`, 'INVALID_ARGUMENT');
    if (typeof entry.permissionDescription !== 'string' || entry.permissionDescription.length === 0 || entry.permissionDescription.length > 1_000) throw new SecurityPolicyError(`invalid MCP permission description for ${key}`, 'INVALID_ARGUMENT');
    if (entry.secretReference !== undefined && !/^secret:[a-zA-Z0-9._/-]{1,160}$/.test(entry.secretReference)) throw new SecurityPolicyError(`invalid MCP secret reference for ${key}`, 'INVALID_ARGUMENT');
  }
}

export function validateMcpSelection(ids: readonly string[], catalog: Readonly<Record<string, McpCatalogEntry>>): void {
  if (ids.length > 8 || new Set(ids).size !== ids.length) throw new SecurityPolicyError('at most eight unique MCP server ids may be selected', 'INVALID_ARGUMENT');
  validateMcpCatalog(catalog);
  for (const id of ids) if (!Object.hasOwn(catalog, id)) throw new SecurityPolicyError(`unknown MCP server id: ${id}`, 'INVALID_ARGUMENT');
}

export interface CwdSnapshot { readonly path: string; readonly dev: number; readonly ino: number; }

/**
 * The single refusal `resolveCwd` gives for anything it could not place inside
 * the boundary (ADR 0027, mvp §12). One code with several distinguishable
 * messages withholds nothing, so every such refusal carries exactly this text:
 * it states what the plugin failed to establish, not what the path is.
 *
 * `verifyCwdBeforeSpawn` deliberately does **not** use it. By the time that
 * runs the path has already been shown to be inside an allowed root, so its
 * four messages distinguish what happened to a location the caller is entitled
 * to know about. They are distinguishable only to someone who can replace that
 * location mid-check — a concurrent writer already inside the boundary, which
 * is the adversary ADR 0027's threat model excludes for the same reason: per
 * ADR 0007 the roots are not a filesystem sandbox, so such a writer can read
 * outside them directly and has no use for an oracle.
 */
export const CWD_DENIED = 'cwd could not be validated as an allowed working directory';

function errnoOf(cause: unknown): string | undefined {
  return typeof cause === 'object' && cause !== null && typeof (cause as { code?: unknown }).code === 'string' ? (cause as { code: string }).code : undefined;
}

export function isContainedPath(path: string, root: string, platform: 'posix' | 'win32' = process.platform === 'win32' ? 'win32' : 'posix'): boolean {
  const rel = platform === 'win32' ? win32.relative(root, path) : relative(root, path);
  const first = rel.split(/[\\/]/u)[0];
  return rel === '' || (first !== '..' && !isAbsolute(rel) && !(platform === 'win32' && win32.isAbsolute(rel)));
}
function contained(path: string, root: string): boolean { return isContainedPath(path, root); }

/** Filesystem-bound policy. Roots are canonicalized once and cwd identity is rechecked before spawn. */
export class SecurityPolicy {
  private constructor(private readonly allowedRoots: readonly string[], readonly identity: DelegationIdentity) {}

  static async create(options: { allowedRoots: readonly string[]; identity?: DelegationIdentity }): Promise<SecurityPolicy> {
    if (options.allowedRoots.length === 0) throw new SecurityPolicyError('at least one allowed root is required', 'PERMISSION_DENIED');
    const roots: string[] = [];
    for (const root of options.allowedRoots) {
      const info = await lstat(root);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new SecurityPolicyError('allowed roots must be real directories', 'PERMISSION_DENIED');
      roots.push(await realpath(root));
    }
    return new SecurityPolicy([...new Set(roots)], options.identity ?? readDelegationIdentity());
  }

  async resolveCwd(cwd: string): Promise<CwdSnapshot> {
    let candidate: string;
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      candidate = await realpath(resolve(cwd));
      info = await stat(candidate);
    } catch (cause) {
      // ADR 0027 decision 5: the syscalls failed, so the path could not be
      // placed by resolving it. Classify without saying why.
      throw await this.classifyUnresolvableCwd(cwd, cause);
    }
    // ADR 0027 decision 4: both syscalls succeeded, so the path is placed.
    // Inside the roots, a non-directory is the caller's mistake and may be
    // named; outside them, nothing is named at all.
    if (!this.allowedRoots.some((root) => contained(candidate, root))) throw new SecurityPolicyError(CWD_DENIED, 'PERMISSION_DENIED');
    if (!info.isDirectory()) throw new SecurityPolicyError('cwd is not a directory', 'INVALID_ARGUMENT');
    return { path: candidate, dev: info.dev, ino: info.ino };
  }

  /**
   * Decide which refusal an unresolvable cwd earns (ADR 0027 decision 5).
   *
   * The property: for any path whose resolved location is outside the allowed
   * roots — or that could not be resolved far enough to place — the answer is
   * `PERMISSION_DENIED` carrying one message that names neither the reason,
   * nor the failing component, nor whether anything is there.
   *
   * @param cwd the caller's spelling, resolved against the *plugin process's*
   *   working directory when relative — not the host cwd of ADR 0025.
   * @param cause the failure from `realpath`/`stat`, consulted only for EACCES.
   * @returns the error to throw; never returns normally.
   */
  private async classifyUnresolvableCwd(cwd: string, cause: unknown): Promise<SecurityPolicyError> {
    const denied = new SecurityPolicyError(CWD_DENIED, 'PERMISSION_DENIED');
    // Access denied means we could not look, and a boundary that guesses under
    // that condition is not a boundary. **No test distinguishes this line**:
    // every EACCES reachable here also denies through the parent walk below,
    // so removing it leaves the suite green. It stays because the guarantee
    // must not rest on that coincidence — the walk denies EACCES today by the
    // shape of its fall-through, and a later edit to the fall-through would
    // silently take the guarantee with it.
    if (errnoOf(cause) === 'EACCES') return denied;
    try {
      // One level, never a walk: how far to walk past an unresolvable
      // component is the question an implementation answers wrongly, and a
      // dangling intermediate link is where it does. `resolve()` itself can
      // throw when the process cwd is gone, which the outer catch covers.
      const target = resolve(cwd);
      const parent = await realpath(dirname(target));
      const before = await stat(parent);
      if (!this.allowedRoots.some((root) => contained(parent, root))) return denied;
      const entry = join(parent, basename(target));
      const named = await this.nameTheProblem(entry);
      // Replacing the parent between the containment decision and the lookup
      // would make the lookup observe an outside path while the decision rests
      // on the stale inside one — the race yields exactly the bit withheld
      // above. Same dev/ino idiom `verifyCwdBeforeSpawn` uses. It narrows the
      // window rather than closing it: both readings can observe the same
      // swapped object, which ADR 0027 accepts against a concurrent writer who
      // is already inside the boundary.
      const after = await stat(parent);
      if (after.dev !== before.dev || after.ino !== before.ino) return denied;
      return named;
    } catch {
      return denied;
    }
  }

  /**
   * Name what is wrong with an entry whose parent is already known to resolve
   * inside an allowed root. Every answer here is about the caller's own
   * argument, which is why it may be specific (ADR 0027 decision 5).
   *
   * @param entry the resolved parent joined with the caller's basename.
   * @returns an `INVALID_ARGUMENT` error naming the condition, or the single
   *   denial when the entry is a link that does not resolve.
   */
  private async nameTheProblem(entry: string): Promise<SecurityPolicyError> {
    try {
      const link = await lstat(entry);
      // Something is there and `realpath` still failed: a link that does not
      // resolve. It must not report on what its target is or is not.
      if (link.isSymbolicLink()) return new SecurityPolicyError(CWD_DENIED, 'PERMISSION_DENIED');
      if (!link.isDirectory()) return new SecurityPolicyError('cwd is not a directory', 'INVALID_ARGUMENT');
      return new SecurityPolicyError(CWD_DENIED, 'PERMISSION_DENIED');
    } catch (cause) {
      const errno = errnoOf(cause);
      if (errno === 'ENOENT') return new SecurityPolicyError('cwd does not exist', 'INVALID_ARGUMENT');
      if (errno === 'ENOTDIR') return new SecurityPolicyError('cwd is not a directory', 'INVALID_ARGUMENT');
      return new SecurityPolicyError(CWD_DENIED, 'PERMISSION_DENIED');
    }
  }

  async verifyCwdBeforeSpawn(snapshot: CwdSnapshot): Promise<void> {
    let current: string;
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      current = await realpath(snapshot.path);
      info = await stat(current);
    } catch {
      // ADR 0027 decision 6: the input was accepted; what changed is the
      // world, and the spawn is refused rather than blamed on the caller.
      throw new SecurityPolicyError('cwd disappeared before worker spawn', 'PERMISSION_DENIED');
    }
    if (current !== snapshot.path) throw new SecurityPolicyError('cwd changed before worker spawn', 'PERMISSION_DENIED');
    if (!info.isDirectory() || info.dev !== snapshot.dev || info.ino !== snapshot.ino) throw new SecurityPolicyError('cwd identity changed before worker spawn', 'PERMISSION_DENIED');
    if (!this.allowedRoots.some((root) => contained(current, root))) throw new SecurityPolicyError('cwd escaped allowed roots', 'PERMISSION_DENIED');
  }

  assertSessionCreationAllowed(): void { assertSessionCreationAllowed(this.identity); }
  workerEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv { return createWorkerEnvironment(base, this.identity); }
  validateMcp(ids: readonly string[], catalog: Readonly<Record<string, McpCatalogEntry>>): void { validateMcpSelection(ids, catalog); }
}
