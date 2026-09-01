import { realpath } from 'node:fs/promises';

/**
 * Resolve a workspace path the way the runtime did before comparing it.
 *
 * The snapshot records the cwd the runtime resolved; a host reports the one it
 * was given — `/var` against `/private/var` on darwin, or any symlinked
 * checkout. Comparing them literally matches nothing, the workspace filter
 * drops every turn, and the nanny falls silent — which reads to the
 * orchestrator as "nothing is running", the one direction this signal may not
 * fail in.
 *
 * It lives here rather than in either caller because both the Stop hook and the
 * opencode injection compare the same two values, and the second one was
 * written without this and silently reported nothing.
 *
 * @param cwd - the path a host supplied, if it supplied one.
 * @returns the resolved path, the original when it cannot be resolved (a
 *   deleted directory is still worth comparing literally), or `undefined`.
 */
export async function resolveWorkspace(cwd: string | undefined): Promise<string | undefined> {
  if (cwd === undefined) return undefined;
  return realpath(cwd).catch(() => cwd);
}
