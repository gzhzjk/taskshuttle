/** Filesystem identity captured by the Plugin before Core reserves a session. */
export interface CwdEvidence {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

/** The only filesystem operations the Plugin adapter needs for cwd security. */
export interface CwdPolicy {
  readonly resolveCwd: (cwd: string) => Promise<CwdEvidence>;
  readonly verifyCwdBeforeSpawn: (cwd: CwdEvidence) => Promise<void>;
}

/** Core reservation seam used by the composition root during the split. */
export interface CoreSessionReservation<Request extends { readonly cwd: string } = { readonly cwd: string }> {
  readonly createSession: (request: Request) => Promise<unknown> | unknown;
}

/**
 * Normalize a host request before it reaches Core's reservation boundary.
 *
 * The initial identity check is intentionally performed before the callback.
 * Core receives only the canonical path and cannot discover the host cwd or
 * perform filesystem work. The Runskein adapter repeats the identity check in
 * its final verify-before-spawn window.
 *
 * @param request - provider-neutral session request from the Plugin handler
 * @param policy - Plugin-owned cwd resolver and verifier
 * @param core - Core reservation callback
 * @returns the domain result returned by Core
 * @throws the policy's typed refusal when cwd cannot be trusted
 */
export async function createSessionWithNormalizedCwd<Request extends { readonly cwd: string }, T>(
  request: Request,
  policy: CwdPolicy,
  core: CoreSessionReservation<Request>,
): Promise<T> {
  const safe = await policy.resolveCwd(request.cwd);
  await policy.verifyCwdBeforeSpawn(safe);
  return await core.createSession({ ...request, cwd: safe.path }) as T;
}
