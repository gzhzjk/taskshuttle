/**
 * Which engines have been through the live ENG matrix.
 *
 * Mirrors `verification.engines` in `release/metadata.json`, the same way
 * {@link WRAPPER_PINS} mirrors `wrappers`: the runtime needs the value, and
 * reading the metadata file from a bundled `dist/` entry is not a path worth
 * depending on. The artifact gate asserts the two agree, so the copy cannot
 * drift silently.
 *
 * `true` is positive live-matrix evidence for admission; an individual
 * required round-trip failure leaves the engine `unverified`. It is distinct
 * from an absent record, which is reported as `unknown`, and known capability
 * defects remain visible through the separate defect channel.
 */
export const VERIFIED_ENGINES: Readonly<Record<string, boolean>> = Object.freeze({
  codex: true,
  'claude-code': true,
  opencode: true,
  kimi: false,
  pi: true,
});

/**
 * Capabilities an engine advertises and does not deliver, mirrored from
 * `verification.knownDefects` for the same reason as {@link VERIFIED_ENGINES}:
 * a bundled `dist/` entry cannot resolve a path back to the metadata file. The
 * artifact gate asserts the two agree, so the copy cannot drift.
 *
 * Only the fields the runtime needs are mirrored. The full records — evidence,
 * owner, impact — stay in `release/metadata.json`, which is where a human reads
 * them; duplicating prose here would only create a second thing to keep in sync.
 *
 * `componentVersion` is deliberately absent, so this is not a stale-entry check.
 * It does not need to be: the gate fails the build when a recorded defect names
 * a version the wrapper baseline no longer carries, and fails it again when this
 * mirror and the metadata disagree. A stale entry therefore cannot reach a
 * build, and by the time the runtime reads this the record is fresh by
 * construction. The reasoning is transitive rather than local, which is exactly
 * why it is written down.
 */
export const KNOWN_BROKEN_CAPABILITIES: readonly { readonly engine: string; readonly capability: string }[] = Object.freeze([
  Object.freeze({ engine: 'claude-code', capability: 'session.fork' }),
  Object.freeze({ engine: 'pi', capability: 'session.fork' }),
]);

/** Whether a capability is recorded as broken for an engine at the pinned component version. */
export function capabilityIsKnownBroken(engine: string, capability: string): boolean {
  return KNOWN_BROKEN_CAPABILITIES.some((entry) => entry.engine === engine && entry.capability === capability);
}

export type VerificationState = 'verified' | 'unverified' | 'unknown';

/**
 * Verification state for one engine.
 *
 * `unknown` is not `unverified`: a missing record means nobody ran the matrix,
 * which is a different answer from running it and failing. `workers_list`
 * already applies that reasoning to `authenticated`.
 */
export function verificationState(engine: string): VerificationState {
  if (!Object.hasOwn(VERIFIED_ENGINES, engine)) return 'unknown';
  return VERIFIED_ENGINES[engine] === true ? 'verified' : 'unverified';
}

/**
 * Flatten a capability matrix to dotted paths.
 *
 * The vocabulary is the descriptor's own — `session.fork`, `prompt.image`,
 * `loadSession` — which is also what `knownDefects.capability` records. A second
 * naming scheme for the same concept would need a mapping between them, and a
 * mapping can disagree with itself.
 */
export function capabilityPaths(capabilities: unknown): readonly string[] {
  if (typeof capabilities !== 'object' || capabilities === null) return [];
  const paths: string[] = [];
  for (const [group, value] of Object.entries(capabilities as Record<string, unknown>)) {
    if (typeof value === 'boolean') paths.push(group);
    else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const [leaf, flag] of Object.entries(value as Record<string, unknown>)) {
        if (typeof flag === 'boolean') paths.push(`${group}.${leaf}`);
      }
    }
  }
  return paths;
}

/** Whether a dotted path is advertised as `true`. A missing key reads as false (design §12). */
export function capabilityAdvertised(capabilities: unknown, path: string): boolean {
  if (typeof capabilities !== 'object' || capabilities === null) return false;
  const [group, leaf] = path.split('.', 2);
  const value = (capabilities as Record<string, unknown>)[group ?? ''];
  if (leaf === undefined) return value === true;
  if (typeof value !== 'object' || value === null) return false;
  return (value as Record<string, unknown>)[leaf] === true;
}

export interface RequirementEvaluation {
  /** Advertised, with no defect recorded against it. */
  readonly met: readonly string[];
  /** Not advertised. */
  readonly unmet: readonly string[];
  /** Advertised, but `knownDefects` records it broken at the pinned component version. */
  readonly defective: readonly string[];
  readonly satisfied: boolean;
}

/**
 * Measure one engine against a set of required capabilities.
 *
 * `defective` is kept separate from `unmet` on purpose. Collapsing them would
 * lose the fact this project keeps insisting on: an engine that says it can do
 * something and cannot is a different situation from one that never claimed to,
 * and only the first is a defect somebody should chase upstream.
 */
export function evaluateRequirements(
  capabilities: unknown,
  required: readonly string[],
  isBroken: (capability: string) => boolean,
): RequirementEvaluation {
  const met: string[] = [];
  const unmet: string[] = [];
  const defective: string[] = [];
  for (const path of required) {
    if (!capabilityAdvertised(capabilities, path)) unmet.push(path);
    else if (isBroken(path)) defective.push(path);
    else met.push(path);
  }
  return { met, unmet, defective, satisfied: unmet.length === 0 && defective.length === 0 };
}

export type EngineAdmission =
  | { readonly allowed: true; readonly reason: 'frozen' | 'verified' | 'operator-allowed' }
  | { readonly allowed: false; readonly reason: 'unverified' };

/**
 * Whether a session may be created on an engine.
 *
 * Three sources of authority, deliberately not collapsed into one flag:
 *
 * - **frozen** — mvp §4.2 requires codex, claude-code, opencode and kimi. They
 *   are usable because the frozen spec says so, which is an earlier and stronger
 *   authorization than gate evidence. Their matrix entries may be false, but
 *   that is a fact about this run, not a rule: gating on evidence alone would
 *   drop a required engine from a default install the moment its claim lapses.
 * - **verified** — the live matrix established positive evidence for this
 *   engine; case-level known defects remain a separate channel.
 * - **operator-allowed** — the install surface set `allowUnverifiedEngines`.
 *
 * `unknown` verification is not an error here: an engine Realm registered that
 * nobody has tested yet is exactly what the flag exists to govern.
 */
export function engineAdmission(
  engine: string,
  options: { readonly isFrozen: boolean; readonly allowUnverified: boolean },
): EngineAdmission {
  if (options.isFrozen) return { allowed: true, reason: 'frozen' };
  if (VERIFIED_ENGINES[engine] === true) return { allowed: true, reason: 'verified' };
  if (options.allowUnverified) return { allowed: true, reason: 'operator-allowed' };
  return { allowed: false, reason: 'unverified' };
}
