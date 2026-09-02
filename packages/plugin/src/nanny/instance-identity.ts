import { MAX_ANCESTRY_HOPS, type AncestryProbe } from '../delegation-evidence.js';

/**
 * Which live instance is serving the host session this process belongs to
 * (ADR 0057).
 *
 * A host starts its MCP servers and its hooks from the same process, so the
 * instance serving a session and that session's Stop hook are **siblings under
 * the host**. Each instance records the pid and start time of the process that
 * started it; this walks the caller's own ancestry and looks for the instance
 * that names one of those ancestors as its host.
 *
 * **Why this is not `walkAncestry`.** That walk asks a different question — am
 * I a *descendant* of an instance — and its answers have different weights:
 * there, "no match" is a root and "could not read" is doubt, and conflating
 * them would manufacture a root out of a failed read. Here every negative
 * outcome is the same outcome, `undefined`, which the caller turns into
 * silence. Sharing a loop would mean carrying that distinction into a function
 * that has no use for it.
 */

/** The half of a live instance this match needs; kept minimal so tests need no directory. */
export interface HostIdentified {
  readonly hostPid?: number;
  readonly hostProcessStartedAt?: string;
}

/**
 * The single instance started by one of this process's ancestors.
 *
 * @param candidates - live instances, each carrying its own record.
 * @param options - `pid` is the process to walk up from (the hook's own);
 *   `probe` reads the process table; `maxHops` bounds the walk, defaulting to
 *   the same 32 the delegation boundary uses.
 * @returns the one matching candidate, or `undefined` — which covers every way
 *   this can fail to establish an identity: an unreadable parent, a cycle, a
 *   walk that reached pid 1 without a match, an ancestor whose start time could
 *   not be read, and **two candidates naming the same host**, where no fact
 *   present says which of them stopped.
 */
export async function selectByHostAncestry<T extends { readonly instance: HostIdentified }>(
  candidates: readonly T[],
  options: { pid: number; probe: AncestryProbe; maxHops?: number },
): Promise<T | undefined> {
  const byHostPid = new Map<number, T[]>();
  for (const candidate of candidates) {
    const { hostPid, hostProcessStartedAt } = candidate.instance;
    // Both halves or the record is not an identity. What refuses a half record
    // is the start-time comparison below — `undefined` equals no reading — so
    // this is not the check; it keeps the map to records that *can* match, so
    // that a data root holding only those short-circuits before the walk
    // instead of paying for a process table that cannot change the answer.
    if (hostPid === undefined || hostProcessStartedAt === undefined) continue;
    const bucket = byHostPid.get(hostPid);
    if (bucket === undefined) byHostPid.set(hostPid, [candidate]); else bucket.push(candidate);
  }
  if (byHostPid.size === 0) return undefined;

  // A probe that throws is a failure to establish identity like any other. The
  // hook must not die on a process table it was only consulting.
  const parentOf = async (pid: number): Promise<number | undefined> => {
    try { return await options.probe.parentOf(pid); } catch { return undefined; }
  };
  const startedAt = async (pid: number): Promise<string | undefined> => {
    try {
      const value = await options.probe.startedAt(pid);
      return value === undefined || value.length === 0 ? undefined : value;
    } catch { return undefined; }
  };

  const limit = options.maxHops ?? MAX_ANCESTRY_HOPS;
  const seen = new Set<number>([options.pid]);
  let current = options.pid;
  for (let hop = 0; hop < limit; hop += 1) {
    const parent = await parentOf(current);
    if (parent === undefined) return undefined;
    // pid 1 is the walk finishing. Nothing above it is a host session.
    if (parent <= 1) return undefined;
    // A pid seen twice is a cycle, which no real process tree has.
    if (seen.has(parent)) return undefined;
    seen.add(parent);

    const claiming = byHostPid.get(parent);
    if (claiming !== undefined) {
      const identity = await startedAt(parent);
      // A pid alone is a coincidence: pids are reused, and the start time is
      // what makes a match a match. **The walk stops here rather than going
      // on**: something claims this ancestor, and passing an ancestor we could
      // not identify to look for a farther one is how a nested host would be
      // answered with its outer session's instance.
      if (identity === undefined) return undefined;
      // String equality is the whole test, and it subsumes the format-family
      // question the delegation walk has to ask separately: two equal strings
      // are in the same family by construction. That walk needs the family
      // because a *non*-match there decides between doubt and answering "root";
      // here a non-match just keeps walking, and the walk ending decides
      // nothing but silence.
      const matches = claiming.filter((candidate) => candidate.instance.hostProcessStartedAt === identity);
      // One host process that started the plugin twice is a real configuration,
      // and nothing here says which of the two stopped.
      if (matches.length > 1) return undefined;
      if (matches.length === 1) return matches[0];
    }
    current = parent;
  }
  // A walk that exceeded its bound has established nothing.
  return undefined;
}
