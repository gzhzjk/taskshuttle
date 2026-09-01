import { readAnchorRecord, anchorPath } from './anchor-store.js';
import { findLiveInstances, type LiveInstance } from './instance-discovery.js';
import { readNannySnapshot, nannySnapshotPath, type NannySnapshot } from './nanny-snapshot.js';
import { resolveDataRoot } from './plugin-config.js';
import { settleDelegation, type DelegationRecord } from './delegation-evidence.js';
import { readDelegationIdentity, type DelegationIdentity } from './security-policy.js';
import { decide, type NannyHookInput, type NannyState } from './nanny/decide.js';
import { resolveWorkspace } from './nanny/workspace.js';

/**
 * The nanny Stop hook (ADR 0015).
 *
 * A host spawns this when its orchestrator stops, hands it a JSON payload on
 * stdin and reads a JSON decision from stdout. It is not an MCP client and
 * cannot call a single one of the plugin's tools — that constraint is the whole
 * reason the runtime writes a snapshot file at all.
 *
 * Everything here fails toward silence. The design's §6 is blunt about why: a
 * nanny that blocks when it cannot read state would trap users in the
 * overwhelming majority of sessions, which never start a worker at all. The
 * benefit is an occasional reminder, so the worst case has to cost nothing.
 */

/** Nothing here is worth a second of a user's time; past this the hook lets them go. */
const BUDGET_MS = 1_000;

/**
 * Normalise the host payloads into the one shape the decision needs.
 *
 * The loop-guard flag is spelled `stop_hook_active` by claude-code and codex
 * and `stopHookActive` by kimi. Reading only one spelling would silently
 * disable the guard on the other hosts — and the symptom of a missing guard is
 * a user locked in a session, which is the worst failure this design has.
 */
export function normaliseHookInput(raw: unknown): NannyHookInput {
  const payload = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const active = payload['stop_hook_active'] ?? payload['stopHookActive'];
  const cwd = payload['cwd'];
  return {
    ...(typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {}),
    // Anything that is not an explicit `false` is treated as "already blocked".
    // A host that stops sending the field would otherwise let the hook block
    // forever; erring toward the guard costs one reminder, erring away from it
    // costs the session.
    stopHookActive: active !== false,
  };
}

/**
 * Pick the instance this stop belongs to.
 *
 * Several instances can be alive under one data root, and their anchors are
 * private plans — handing back the wrong one would be worse than handing back
 * none. So: the instance that has a turn running in this workspace, else the
 * only instance if there is exactly one, else nothing.
 *
 * @param instances - live instances with their snapshots already read.
 * @param cwd - the workspace the host stopped in, when it supplied one.
 * @returns the chosen instance, or `undefined` when the answer is ambiguous.
 */
export function selectInstance<T extends { instance: LiveInstance; snapshot: NannySnapshot | undefined }>(
  instances: readonly T[],
  cwd: string | undefined,
): T | undefined {
  if (cwd !== undefined) {
    const owning = instances.filter((entry) => entry.snapshot?.active.some((turn) => turn.cwd === cwd) === true);
    if (owning.length === 1) return owning[0];
    // More than one instance running work in the same directory is a real
    // configuration, and there is no fact here that says which one stopped.
    if (owning.length > 1) return undefined;
  }
  return instances.length === 1 ? instances[0] : undefined;
}

async function readPayload(stdin: AsyncIterable<unknown>): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { return undefined; }
}

export interface NannyHookOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: AsyncIterable<unknown>;
  /** Where the decision goes; the default is the host's pipe. */
  readonly write?: (text: string) => void;
  /** Where a kimi block's reason goes; the default is stderr. */
  readonly writeError?: (text: string) => void;
  readonly now?: () => number;
}

/**
 * Does this host read a block from the exit code rather than from stdout?
 *
 * kimi does, and it is the only one of the four that does. Its hook runner maps
 * exit code 2 to `{ action: 'block', reason: <stderr> }`; the JSON it *does*
 * parse recognises only `message` and `hookSpecificOutput`, and the sole
 * blocking path there is `permissionDecision: "deny"` — permission semantics,
 * not "the orchestrator still has work". A `{"decision":"block"}` object with
 * exit 0, which is exactly right for claude-code and codex, is read by kimi as
 * a hook that allowed the stop.
 *
 * Two signals are required, and getting this wrong has been measured in both
 * directions:
 *
 * - The **payload** must lack `transcript_path` and `permission_mode`. kimi
 *   sends only `hook_event_name`, `session_id`, `cwd` and `stop_hook_active`;
 *   claude-code and codex both carry a transcript path, and codex's schema
 *   makes `permission_mode` required.
 * - The **environment** must look like kimi's, which is how its plugin hooks
 *   are launched.
 *
 * The environment alone is not enough: `KIMI_CODE_HOME` is exported by kimi's
 * installation and is inherited by anything started from the same shell, so a
 * claude-code session took the exit-code path and the user saw
 * `Stop hook error: …` — a *non-blocking* warning, because claude-code turns a
 * non-zero hook into `hook_non_blocking_error` and only a stdout decision into
 * a real block. That failure is worse than silence: noisy and ineffective at
 * once. So the JSON form is the default and the exit-code form needs both
 * signals to agree.
 */
function blocksByExitCode(env: NodeJS.ProcessEnv, payload: Record<string, unknown>): boolean {
  const looksLikeKimi = payload['transcript_path'] === undefined && payload['permission_mode'] === undefined;
  const kimiEnvironment = env['KIMI_PLUGIN_ROOT'] !== undefined || env['KIMI_CODE_HOME'] !== undefined;
  return looksLikeKimi && kimiEnvironment;
}

/** Everything that touches the filesystem, so the budget can race the whole of it. */
async function readState(dataRoot: string, cwd: string | undefined): Promise<NannyState> {
  const live = await findLiveInstances(dataRoot);
  const withSnapshots = await Promise.all(live.map(async (instance) => ({
    instance,
    snapshot: await readNannySnapshot(nannySnapshotPath(instance.instanceDir)),
  })));
  const chosen = selectInstance(withSnapshots, cwd);
  if (chosen === undefined) return {};
  const anchor = await readAnchorRecord(anchorPath(chosen.instance.instanceDir));
  return {
    ...(chosen.snapshot === undefined ? {} : { snapshot: chosen.snapshot }),
    ...(anchor === undefined ? {} : { anchor }),
  };
}

/**
 * Run the hook: read the payload, decide, print at most one JSON object.
 *
 * @param options - process seams, injected so the whole hook — recursion guard
 *   included — can be driven from a test without spawning a host.
 * @returns the process exit code. 0 everywhere except a block on kimi, where 2
 *   *is* the block protocol rather than a failure. Nothing else ever exits
 *   non-zero: a hook that fails interferes with a host it was only observing.
 */
export async function runNannyHook(options: NannyHookOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const write = options.write ?? ((text: string) => { process.stdout.write(text); });
  const writeError = options.writeError ?? ((text: string) => { process.stderr.write(text); });
  // The recursion guard is the first thing, not a later filter. This plugin
  // installs into Claude Code, so a claude-code worker is a nested Claude Code
  // whose own stop fires this same hook — and it usually runs in the parent's
  // cwd, so the workspace filter cannot save it. It would read the parent's
  // active turns, find its own among them, and block itself forever:
  // `stop_hook_active` does not help, because the criterion is true every time.
  //
  // The marker is only half of it (ADR 0031): an engine that starts its MCP
  // servers from a sanitized environment strips it, and a worker whose marker
  // was scrubbed should no more nag its operator than it should open a console.
  // So this hook walks its own ancestry too — it is a separate process with no
  // verdict to borrow, and a verdict some instance persisted could be stale in
  // exactly the case that matters, an instance that died without clearing it.
  const dataRoot = resolveDataRoot(env);
  let marker: DelegationIdentity;
  try { marker = readDelegationIdentity(env); } catch { return 0; }
  if (marker.recursionDenied || marker.depth > 0) return 0;
  // One deadline for the whole hook, not one per IO step. An earlier version
  // gave the walk its own `BUDGET_MS` and the state read another, so a slow
  // walk plus a slow read could take twice the budget while the comment beside
  // it claimed they shared one. The hook runs while a person waits for their
  // host to stop; the budget is the promise, and two budgets is not that promise
  // spent twice, it is the promise broken.
  // One budget for the hook's **own** IO, spent down across the steps that use
  // it rather than granted afresh to each. An earlier version gave the walk its
  // own `BUDGET_MS` and the state read another, so the two could cost twice the
  // budget while the comment claimed they shared one.
  //
  // What it does not span is `readPayload`, which waits on the host's stdin, and
  // `resolveWorkspace`. Those are not ours to bound, and a single wall-clock
  // deadline started before them would hand `readState` a spent budget for time
  // the host took — silence caused by the host being slow, not by our disk.
  const clock = options.now ?? Date.now;
  let spent = 0;
  const withinBudget = async <T>(work: Promise<T>, onLapse: T): Promise<T> => {
    const remaining = BUDGET_MS - spent;
    if (remaining <= 0) return onLapse;
    const startedAt = clock();
    try {
      return await Promise.race([
        work,
        new Promise<T>((resolve) => { const timer = setTimeout(() => resolve(onLapse), remaining); timer.unref?.(); }),
      ]);
    } finally { spent += clock() - startedAt; }
  };

  // On `unavailable` — a walk that did not finish inside the budget included —
  // the hook exits silently: its contract is to fail toward silence, and a nanny
  // that cannot establish whether it is a worker may otherwise block a worker
  // against itself. A missed warning is the cost that contract already accepts.
  //
  // The losing promise is not cancelled — `Promise.race` cannot — and this is
  // where the honesty has to be, because the timer bounds only *when the answer
  // is decided*, not when this process exits. An abandoned walk leaves pending
  // `readFile` requests and, on darwin, a `ps` child; neither is `unref`'d, so
  // the event loop stays alive until they finish. A Stop hook's caller waits for
  // the process — on kimi the exit code *is* the protocol — so the wall clock a
  // person waits is the walk's real duration. `settleDelegation`'s own budget is
  // what bounds that; this one bounds the decision.
  const verdict = await withinBudget<DelegationRecord>(
    settleDelegation({ marker, dataRoot, budgetMs: BUDGET_MS }).catch((): DelegationRecord => ({ provenance: 'unavailable' })),
    { provenance: 'unavailable' },
  );
  if (verdict.provenance !== 'root') return 0;

  const payload = await readPayload(options.stdin ?? process.stdin);
  const fields = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
  const raw = normaliseHookInput(payload);
  const resolved = await resolveWorkspace(raw.cwd);
  const input: NannyHookInput = { stopHookActive: raw.stopHookActive, ...(resolved === undefined ? {} : { cwd: resolved }) };
  const state = await withinBudget<NannyState>(readState(dataRoot, input.cwd).catch(() => ({} as NannyState)), {});

  const decision = decide(input, state, (options.now ?? Date.now)());
  // `block` hands the text to the model as the next turn's input; a note is
  // shown to the user and never re-enters the model. Silence is a bare exit,
  // not an empty object: a host that sees no output does nothing at all.
  if (decision.kind === 'block') {
    if (blocksByExitCode(env, fields)) { writeError(decision.reason); return 2; }
    write(JSON.stringify({ decision: 'block', reason: decision.reason }));
  } else if (decision.kind === 'note') {
    // A note has no exit-code form: kimi's only non-zero meaning is "block".
    // Saying it on stdout leaves a host that does not read it silent, which is
    // the fail-open direction §6 asks for.
    write(JSON.stringify({ systemMessage: decision.message }));
  }
  return 0;
}

// Only when spawned as the hook, so tests can import the pieces above.
if (process.argv[1] !== undefined && process.argv[1].endsWith('nanny.js')) {
  // A hook that throws would print a stack trace where the host expects JSON.
  runNannyHook().then((code) => { process.exitCode = code; }, () => { process.exitCode = 0; });
}
