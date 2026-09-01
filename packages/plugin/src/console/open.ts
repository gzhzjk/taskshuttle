import { spawn } from 'node:child_process';
import { type ClientRequest, request as httpRequest } from 'node:http';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { MAX_ANCESTRY_HOPS } from '../delegation-evidence.js';
import { lockAlive, readInstanceJson } from '../instance-discovery.js';
import type { InstanceManifest, ProcessInspector } from '../lifecycle.js';
import { defaultProcessInspector, parentProcessId } from '../lifecycle.js';
import { resolveDataRoot } from '../plugin-config.js';

/** The console binds loopback and nothing else (§7.2); the probe must match. */
const LOOPBACK_HOST = '127.0.0.1';

/**
 * One deadline over connect, headers and body together, because this runs
 * between an operator's command and their browser opening: a probe that waits
 * on a peer which never finishes answering is indistinguishable from a hung
 * command.
 */
const PROBE_DEADLINE_MS = 1_000;

/**
 * The most of an answer that is worth reading before concluding it is not our
 * console. Octets, not characters — a multibyte body is larger than its length,
 * by up to four times in UTF-8 — and a bound at all so that a peer which
 * streams forever cannot make this process grow without limit.
 */
const PROBE_BODY_CAP = 65_536;

/**
 * How long the kinship narrowing (ADR 0042) has to decide. It runs only on the
 * path that would otherwise print a listing and exit 1, so the operator is
 * already waiting on an answer they cannot act on; what they must not wait on
 * is a process table that never answers. On darwin every parent read is a `ps`
 * with a five-second timeout of its own, so the bound has to be here.
 *
 * The budget bounds when the answer is *decided*: a read already issued cannot
 * be cancelled and may outlive the decision by its own timeout, delaying only
 * the command's exit. No further read is issued once the budget has lapsed.
 */
export const KINSHIP_BUDGET_MS = 2_000;

/**
 * `taskshuttle console open` (console-design §8.2). The subcommand exists so
 * the agent never has to assemble a console address itself: it runs one
 * command, this process reads console.json, confirms the port really is the
 * instance it names, and hands the URL to the browser (§7.9). Candidate
 * selection is §4 lock liveness only — the port is never probed to decide
 * liveness, only identity.
 */

interface ConsoleManifest {
  readonly port: number;
  readonly startedAt: string;
}

export interface ConsoleCandidate {
  readonly instanceId: string;
  readonly createdAt: string;
  readonly host: string;
  readonly port: number;
}

/**
 * What one scan of the data root found. `owners` maps an instance id to the pid
 * its manifest names, for ADR 0042's kinship narrowing only. It is deliberately
 * a sibling of the candidates rather than a field on them: `ConsoleCandidate`
 * is what the ambiguous listing prints and what `ConsoleOpenResult` carries, so
 * a pid on it would be one refactor from an operator's terminal — §9 keeps pid
 * off `/api/instance` for that reason. Here it is read, walked, and dropped.
 */
export interface ConsoleScan {
  readonly candidates: ConsoleCandidate[];
  readonly stale: number;
  readonly owners: ReadonlyMap<string, number>;
}

export type ConsoleOpenResult =
  | { readonly kind: 'opened'; readonly exitCode: 0; readonly instanceId: string; readonly port: number }
  | { readonly kind: 'open-degraded'; readonly exitCode: 0; readonly instanceId: string; readonly port: number }
  | { readonly kind: 'ambiguous'; readonly exitCode: 1; readonly candidates: readonly ConsoleCandidate[] }
  | { readonly kind: 'none-enabled'; readonly exitCode: 1 }
  | { readonly kind: 'not-listening'; readonly exitCode: 1; readonly stale: number };

/**
 * The console.json fields a candidate needs — a port in the TCP range — or
 * undefined if the file cannot supply them.
 *
 * A `token` field left in a manifest written before ADR 0032 is **ignored**
 * rather than rejected. A stale credential beside the port says nothing about
 * the port, so rejecting the file over it would discard a candidate for the
 * wrong reason — and it establishes nothing either: whether anything is
 * listening there, and whether it is this instance, is decided by the identity
 * probe below and by nothing here (ADR 0032).
 */
function asConsoleManifest(value: unknown): ConsoleManifest | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const manifest = value as Record<string, unknown>;
  const port = manifest['port'];
  // A port outside the range is not openable and must not be listed as a
  // candidate: the probe would refuse it anyway, by throwing inside the http
  // client rather than by deciding, and the ambiguous listing would have shown
  // it to the operator as a choice.
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return { port, startedAt: String(manifest['startedAt'] ?? '') };
}

/**
 * The three instance.json fields a candidate needs, or undefined if any is
 * missing or the wrong type.
 *
 * The read this guards is the second of two — `lockAlive` has already read and
 * validated the same file — so the obvious reading is that nothing broken can
 * reach here without a race. That reading is wrong, and an earlier version of
 * this comment asserted it: `lockAlive` checks the pid and that the lock
 * restates the manifest, and looks at neither `createdAt` nor `host`. A
 * manifest missing `host` passes it and arrives here intact, no timing
 * involved. Exported so both that path and this validation can be asserted.
 */
export function asInstanceIdentity(value: unknown): Pick<InstanceManifest, 'instanceId' | 'createdAt' | 'host'> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const manifest = value as Record<string, unknown>;
  const { instanceId, createdAt, host } = manifest;
  if (typeof instanceId !== 'string' || instanceId.length === 0) return undefined;
  if (typeof createdAt !== 'string' || typeof host !== 'string') return undefined;
  return { instanceId, createdAt, host };
}

/**
 * All live-instance consoles under the data root. Malformed entries are
 * skipped, never guessed at, and counted in `stale` — which means "found and
 * unusable" rather than any one cause: a console.json that is present and will
 * not parse, one that parses without a usable port, a dead owning lock, and an
 * instance.json that is gone or cannot supply an identity all reach it. A
 * console.json that is simply absent does not: that is a console that is off.
 */
export async function findConsoleCandidates(
  dataRoot: string,
  inspect: ProcessInspector = defaultProcessInspector,
): Promise<ConsoleScan> {
  const root = join(dataRoot, 'instances');
  let entries: string[];
  try { entries = await readdir(root); } catch { return { candidates: [], stale: 0, owners: new Map() }; }
  const candidates: ConsoleCandidate[] = [];
  const owners = new Map<string, number>();
  let stale = 0;
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const dir = join(root, entry);
    const consolePath = join(dir, 'console.json');
    const raw = await readInstanceJson(consolePath);
    if (raw === undefined) {
      // `readInstanceJson` answers `undefined` for a file that is absent and
      // for one that will not parse, and those are different facts to an
      // operator: absent means the console is off, unparseable means it is on
      // and this entry is wreckage. Counting only the first left the second
      // reported as "no console is enabled", which sends them to change a
      // setting that was never the problem.
      if (await lstat(consolePath).then(() => true, () => false)) stale += 1;
      continue;
    }
    const consoleManifest = asConsoleManifest(raw);
    if (consoleManifest === undefined) { stale += 1; continue; }
    if (!(await lockAlive(dir, inspect))) { stale += 1; continue; }
    // Read again after the liveness check, and validated rather than cast: the
    // instance can close in between, which makes this `undefined`, and a
    // manifest whose `instanceId` is not a string would reach `--instance`'s
    // `startsWith` and throw there instead. A stale entry is skipped and
    // counted, which is what the caller already knows how to report; a crash
    // is not.
    const manifest = await readInstanceJson(join(dir, 'instance.json'));
    const identity = asInstanceIdentity(manifest);
    if (identity === undefined) { stale += 1; continue; }
    candidates.push({
      instanceId: identity.instanceId,
      createdAt: identity.createdAt,
      host: identity.host,
      port: consoleManifest.port,
    });
    // Kept out of `ConsoleCandidate` for the reason stated on `ConsoleScan`. A
    // pid that cannot be read costs the *whole* narrowing, not just this
    // candidate's kinship: `narrowToCallerTree` cannot claim one instance is
    // the only one in the tree while one it was handed went unclassified. The
    // candidate itself loses nothing — it is still listed, still openable by
    // `--instance`. `lockAlive` above required a usable pid, so reaching this
    // with none means the manifest changed between the two reads.
    const pid = ownerPid(manifest);
    if (pid !== undefined) owners.set(identity.instanceId, pid);
  }
  return { candidates, stale, owners };
}

/** The owning pid an `instance.json` supports, or undefined when it supports none. */
function ownerPid(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const pid = (value as Record<string, unknown>)['pid'];
  // The same predicate `lockAlive` applies to this field, so one manifest is
  // not usable to one reader and not the other. pid 1 is excluded by the walk
  // rather than here, because that is where the reason for excluding it lives.
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid >= 1 ? pid : undefined;
}

/** A parent-pid read; injected so a test can drive a synthetic process tree. */
export type ParentOf = (pid: number) => Promise<number | undefined>;

/**
 * The candidates whose instance was started inside the caller's process tree
 * (ADR 0042).
 *
 * A candidate is *kin* on either of two grounds, and they are not the same
 * rule. **Direct lineage** — the owner is the calling process, an ancestor of
 * it, or a descendant of it — is kinship at any depth. **A shared ancestor**
 * is kinship only below the session root. Sharing is what makes this work at
 * all: on three of the four hosts the plugin is a separate MCP server process
 * — a sibling of the shell this command runs in, not an ancestor of it — and a
 * strict-ancestry rule would never fire there.
 *
 * The session root is the top of a chain: the process whose parent is pid 1.
 * It is excluded from the shared-ancestor test because on a desktop it is a
 * terminal application, a login session or a GUI launcher, and *everything the
 * operator ever started* descends from one. Measured on darwin, 2026-08-28:
 * eight live consoles, seven of them sharing one `Orca Helper` whose parent
 * was pid 1, and the narrowing answered "seven" where the honest answer — the
 * nearest shared ancestor, the `claude` process — was one. Excluding pid 1
 * alone is not enough, and the earlier claim that it made "two unrelated trees
 * on one machine never kin" was false: unrelated trees meet at the app that
 * launched both.
 *
 * Direct lineage is deliberately not bounded the same way. Where the plugin
 * runs inside the host process (OpenCode), the owner *is* an ancestor of the
 * shell, and a host started directly by init would put that owner at the
 * session root — the one place the shared-ancestor rule refuses to look.
 *
 * This is **evidence, not identity**: a reused pid can manufacture a link, and
 * nothing here compares process start times. The caller's contract bounds what
 * that can cost — narrowing only ever chooses among candidates that were
 * already openable, and the identity probe still runs on whichever one is
 * chosen.
 *
 * @param options `candidates` and `owners` come from one {@link ConsoleScan};
 *   `callerPid` is this process; `parentOf` reads the process table; `budgetMs`
 *   and `now` are the deadline's seams.
 * @returns the kin candidates — possibly none of them, possibly all — or
 *   `undefined` when nothing could be established: an unreadable process table,
 *   a chain that could not be walked, a candidate with no readable owning pid,
 *   or a lapsed budget. The two are kept apart in the type rather than
 *   collapsed into "the whole list", so that a doubt can never be read as a
 *   decision by a caller holding one candidate.
 */
export async function narrowToCallerTree(options: {
  candidates: readonly ConsoleCandidate[];
  owners: ReadonlyMap<string, number>;
  callerPid: number;
  parentOf?: ParentOf;
  budgetMs?: number;
  now?: () => number;
}): Promise<readonly ConsoleCandidate[] | undefined> {
  const { candidates, owners, callerPid } = options;
  const parentOf = options.parentOf ?? parentProcessId;
  // Monotonic, not wall-clock: the budget is an elapsed-time bound, and
  // `Date.now()` can be stepped by NTP or a timezone-independent clock
  // adjustment mid-walk, which would either lapse a walk that had time left or
  // extend one that did not.
  const now = options.now ?? (() => performance.now());
  const deadline = now() + (options.budgetMs ?? KINSHIP_BUDGET_MS);
  // One cache across every walk: the chains converge on the same terminal,
  // login and init processes, and on darwin each miss is a `ps` spawn.
  const parents = new Map<number, number | undefined>();

  const readParent = async (pid: number): Promise<number | undefined> => {
    const cached = parents.get(pid);
    if (cached !== undefined || parents.has(pid)) return cached;
    let parent: number | undefined;
    // A process table that throws is a table that could not be read: doubt,
    // like an unreadable one, and never an escaping rejection — this runs on
    // the path whose whole job is to print a usable listing.
    try { parent = await parentOf(pid); } catch { parent = undefined; }
    if (parent !== undefined && (!Number.isSafeInteger(parent) || parent < 1)) parent = undefined;
    parents.set(pid, parent);
    return parent;
  };

  /**
   * The chain from `pid` upward, nearest first, excluding pid 1 and anything
   * below it, or undefined when the walk could not be completed — a parent that
   * could not be read, a cycle, the hop bound, or the budget.
   *
   * Ordered rather than a set because the last element is the session root, and
   * the shared-ancestor test has to be able to name it. A completed walk always
   * ends because the next parent was pid 1 or below, so "last" and "session
   * root" are the same element and no caller has to check.
   */
  const chainFrom = async (pid: number): Promise<number[] | undefined> => {
    if (pid <= 1) return [];
    const chain: number[] = [pid];
    const seen = new Set<number>([pid]);
    let current = pid;
    for (let hop = 0; hop < MAX_ANCESTRY_HOPS; hop += 1) {
      // Checked before the read rather than after it, so a lapse leaves at most
      // one read in flight rather than issuing one more.
      if (now() >= deadline) return undefined;
      const parent = await readParent(current);
      if (parent === undefined) return undefined;
      // Reaching pid 1 is the walk finishing, not failing: 1 is where every
      // chain ends and is never itself a link.
      if (parent <= 1) return chain;
      // An early exit, not the thing that makes a cycle safe: the hop bound
      // above already ends one, at the same answer. It is kept because a pid
      // seen twice is a broken reading of the process table and there is
      // nothing further up such a chain worth paying for. **No test can tell
      // this line from its absence** — both reach `undefined` — so it is not
      // claimed as covered.
      if (seen.has(parent)) return undefined;
      chain.push(parent);
      seen.add(parent);
      current = parent;
    }
    return undefined;
  };

  const callerChain = await chainFrom(callerPid);
  if (callerChain === undefined) return undefined;
  const callerLineage = new Set(callerChain);
  // The caller's chain with its session root dropped — see the session-root
  // paragraph above. `slice(0, -1)` on an empty chain is empty, which is the
  // right answer for a caller directly under init: it has no shared ancestor
  // anyone could stand in, and only direct lineage can make a candidate kin.
  const callerShared = new Set(callerChain.slice(0, -1));

  const kin: ConsoleCandidate[] = [];
  for (const candidate of candidates) {
    const owner = owners.get(candidate.instanceId);
    // Doubt, not "not kin". A candidate the scan admitted but could not put an
    // owning pid on was never classified, so "the only one in this tree" would
    // be a claim about a set this walk did not finish reading. Skipping it here
    // and letting one *other* candidate be the sole kin is exactly how that
    // sentence becomes false — the same failure the unreadable-chain branch
    // below refuses. The two were handled opposite ways until ADR 0042's
    // independent review found it.
    if (owner === undefined) return undefined;
    const ownerChain = await chainFrom(owner);
    // One unreadable chain and the whole narrowing stops. A partial answer here
    // would be worse than none: the candidate that could not be walked may be
    // the caller's own, and dropping it silently is how "the only one in this
    // tree" becomes a false statement.
    if (ownerChain === undefined) return undefined;
    // Direct lineage, at any depth and including the session root: the owner
    // is an ancestor of the caller, or the caller an ancestor of it.
    const lineage = callerLineage.has(owner) || ownerChain.includes(callerPid);
    // Or a shared ancestor that is neither chain's session root. Dropping the
    // last element of each is enough — a session root's parent is pid 1, so it
    // can only ever appear last.
    const shared = ownerChain.slice(0, -1).some((pid) => callerShared.has(pid));
    if (lineage || shared) kin.push(candidate);
  }
  return kin;
}

/**
 * Confirm the port is still the console of *this* instance (§8.2).
 *
 * §4 decides liveness from the instance lock and never from the port, because a
 * connection proves only that something is listening. That rule is right for
 * deciding whether an instance is alive — but it fails in the wrong direction
 * here. `defaultInspect` supplies process identity on Linux only, so everywhere
 * else `lockAlive` treats any surviving PID as the owner (see its `return true`
 * when identity is unavailable). In orphan reaping "uncertain → still alive"
 * means "do not kill", which is safe. Here it means "hand over the URL", and a
 * reused PID plus a reused port would open a stranger's page — or, on a machine
 * running several instances, another instance's transcripts.
 *
 * So identity is asked for and compared exactly: `GET /api/instance` at the
 * literal loopback authority with no credentials, and the `instanceId` it
 * reports must equal the candidate's. Anything else — a non-200, a redirect, a
 * wrong media type, an unparseable or oversized body, a different id, no
 * listener, the deadline — refuses.
 *
 * @param port - the port this candidate's console.json names.
 * @param instanceId - the id that answer must carry, compared for exact equality.
 * @returns true only when the port answered as this instance.
 */
async function isOurConsole(port: number, instanceId: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    let settled = false;
    // Assigned below; `settle` may run before that on a port the http client
    // rejects outright, which is a refusal like any other rather than a throw
    // out of `console open`.
    let request: ClientRequest | undefined;
    const settle = (ours: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      request?.destroy();
      resolveProbe(ours);
    };
    // Started before the request is issued, and covering the body as well:
    // Node's `timeout` option is a socket-inactivity timeout, so a peer that
    // keeps dripping bytes would never trip it (§8.2).
    const deadline = setTimeout(() => settle(false), PROBE_DEADLINE_MS);
    try {
      request = httpRequest({
        host: LOOPBACK_HOST,
        port,
        path: '/api/instance',
        method: 'GET',
        // The destination is part of the probe's identity, so the authority is
        // the literal address rather than a name resolved at probe time.
        headers: { host: `${LOOPBACK_HOST}:${port}`, accept: 'application/json' },
      }, (response) => {
        // A redirect is precisely how a listener that is not ours would send
        // the probe to one that is, so it refuses rather than being followed.
        if (response.statusCode !== 200 || !isJsonMediaType(response.headers['content-type'])) { settle(false); return; }
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > PROBE_BODY_CAP) { settle(false); return; }
        const chunks: Buffer[] = [];
        let octets = 0;
        response.on('data', (chunk: Buffer) => {
          octets += chunk.length;
          if (octets > PROBE_BODY_CAP) { settle(false); return; }
          chunks.push(chunk);
        });
        // 'end' fires only on a complete body; a socket that dies mid-body
        // reaches 'error'/'aborted' instead and refuses through settle(false).
        response.on('end', () => { settle(reportsThisInstance(Buffer.concat(chunks), instanceId)); });
        response.on('error', () => settle(false));
        response.on('aborted', () => settle(false));
      });
      request.once('error', () => settle(false));
      request.end();
    } catch {
      settle(false);
    }
  });
}

/** `application/json`, matched case-insensitively with parameters ignored (§8.2). */
function isJsonMediaType(header: string | undefined): boolean {
  if (header === undefined) return false;
  return header.split(';')[0]!.trim().toLowerCase() === 'application/json';
}

/**
 * Whether a probe body is a JSON object reporting exactly this instanceId.
 * Unknown fields are tolerated: this route's field set grows with the product,
 * and a strict schema would refuse our own console after the next addition.
 */
function reportsThisInstance(body: Buffer, instanceId: string): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { return false; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const reported = (parsed as Record<string, unknown>)['instanceId'];
  return typeof reported === 'string' && reported === instanceId;
}

/** macOS `open`, Linux `xdg-open`, Windows `start` — the URL goes to the browser invocation only. */
function systemOpener(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  return new Promise((resolveOpen, rejectOpen) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.once('error', rejectOpen);
    child.once('spawn', () => { child.unref(); resolveOpen(); });
  });
}

export interface ConsoleOpenOptions {
  /** Explicit data root; else resolveDataRoot(env) — the same rule the server uses. */
  readonly dataRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** --instance=<id>, required when more than one console is live (§8.2). */
  readonly instance?: string;
  /** Test seam; production opens the system browser. */
  readonly opener?: (url: string) => Promise<void>;
  /** User-facing lines; defaults to stdout. */
  readonly out?: (line: string) => void;
  /** Test seam for the pre-open identity probe; production asks the port who it is. */
  readonly probe?: (port: number, instanceId: string) => Promise<boolean>;
  /** Test seam for ADR 0042's kinship walk; production reads the process table. */
  readonly parentOf?: ParentOf;
  /** Test seam for §4 lock liveness; production asks the real process table. */
  readonly inspect?: ProcessInspector;
  /** This process, for the same walk; overridden only so a test can be a synthetic pid. */
  readonly callerPid?: number;
}

export async function runConsoleOpen(options: ConsoleOpenOptions = {}): Promise<ConsoleOpenResult> {
  const out = options.out ?? ((line: string) => console.log(line));
  const dataRoot = resolveDataRoot(options.env ?? process.env, options.dataRoot);
  const opener = options.opener ?? systemOpener;
  const { candidates, stale, owners } = await findConsoleCandidates(dataRoot, options.inspect ?? defaultProcessInspector);

  const wanted = options.instance;
  let picked = wanted === undefined
    ? candidates
    // An unambiguous prefix is accepted, like git's short hashes.
    : candidates.filter((candidate) => candidate.instanceId === wanted || candidate.instanceId.startsWith(wanted));

  if (wanted !== undefined && picked.length === 0) {
    out(`no live console matches --instance=${wanted}`);
    if (candidates.length > 0) out(`live instances: ${candidates.map((candidate) => candidate.instanceId).join(', ')}`);
    // The real count, like every other branch: `stale` means "found and
    // unusable", and reporting 0 here made one branch's field say something
    // the scan had not found.
    return { kind: 'not-listening', exitCode: 1, stale };
  }
  if (picked.length === 0) {
    if (stale === 0) {
      out('no console is enabled: no instances/*/console.json under ' + dataRoot);
      out('enable it in the install surface (console.enabled: true) and restart the host');
      return { kind: 'none-enabled', exitCode: 1 };
    }
    // Names no cause: several different things land in `stale`, and asserting
    // any one of them for all of them puts a false explanation in front of the
    // operator. The follow-up line is likewise about what to do, not why.
    out(`console is not listening: ${stale} console.json ${stale === 1 ? 'file' : 'files'} left behind by an instance that is no longer usable`);
    // Not "the next start cleans them up": one of the paths into `stale` is a
    // live instance whose instance.json cannot supply an identity, and nothing
    // cleans that up or needs a restart to.
    out('start a fresh host session if you expected a console here; otherwise these are leftovers');
    return { kind: 'not-listening', exitCode: 1, stale };
  }
  // ADR 0042: before listing, ask the one question the caller can answer with
  // evidence rather than preference — which of these instances was started
  // inside this process tree. Only an answer of exactly one decides; anything
  // else, including an unreadable process table, falls through to the listing
  // below. A sole candidate never pays the walk, and neither does an
  // `--instance` the caller typed: an ambiguous prefix is an ambiguous
  // *instruction*, and answering it from the process tree would resolve a
  // question the caller asked in their own terms by evidence they did not cite.
  if (wanted === undefined && picked.length > 1) {
    const kin = await narrowToCallerTree({
      candidates: picked,
      owners,
      callerPid: options.callerPid ?? process.pid,
      ...(options.parentOf === undefined ? {} : { parentOf: options.parentOf }),
    });
    if (kin?.length === 1) {
      // §8.2 requires the caller to be told: a command that silently picks one
      // of eight has taught its reader that it always knew which was theirs.
      out(`${picked.length} live consoles; opening ${kin[0]!.instanceId}, the only one started inside this process tree`);
      picked = [...kin];
    }
  }
  if (picked.length > 1) {
    // §8.2: never guess by cwd or recency — list metadata and ask for --instance.
    out('more than one live console; re-run with --instance=<id>:');
    for (const candidate of picked) {
      out(`  ${candidate.instanceId}  host ${candidate.host}  created ${candidate.createdAt}  port ${candidate.port}`);
    }
    return {
      kind: 'ambiguous',
      exitCode: 1,
      candidates: picked,
    };
  }

  const candidate = picked[0]!;
  const probe = options.probe ?? isOurConsole;
  if (!(await probe(candidate.port, candidate.instanceId))) {
    // §8.2: exactly one line, and it names no condition — not the manifest
    // being stale, which is false for the case CONSOLE-046 writes down, and
    // not "it is not this instance's" either, which is equally a condition and
    // one the probe cannot establish: a refused connection and an expired
    // deadline reach here too, and in neither is there an "it" to be wrong
    // about. The line says what was observed and stops.
    out(`instance ${candidate.instanceId} records port ${candidate.port}, but nothing there answers as that instance's console`);
    return { kind: 'not-listening', exitCode: 1, stale: stale + 1 };
  }
  const url = `http://${LOOPBACK_HOST}:${candidate.port}/`;
  try {
    await opener(url);
  } catch {
    // The probe already confirmed this URL is the console for this instance,
    // so a browser-launch failure is not a console-open failure: degrade to
    // one explanatory line plus the URL the operator can paste themselves.
    out(`could not open browser automatically — open ${url} manually`);
    return { kind: 'open-degraded', exitCode: 0, instanceId: candidate.instanceId, port: candidate.port };
  }
  out(`opened console for instance ${candidate.instanceId} at http://127.0.0.1:${candidate.port}/`);
  return { kind: 'opened', exitCode: 0, instanceId: candidate.instanceId, port: candidate.port };
}
