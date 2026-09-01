/**
 * Known defects: capabilities an engine advertises but does not deliver at a
 * recorded component version.
 *
 * The record lives in `release/metadata.json` under `verification.knownDefects`
 * and is written by hand, because that is the point — an engine's own
 * description of itself is evidence of intent, not of behaviour. claude-code
 * reports `capabilities.session.fork` at `claude-agent-acp@0.70.0` and then
 * answers `session/fork` with `Resource not found`; nothing derivable from the
 * descriptor would ever say so.
 *
 * This module exists because the record is about to have three readers (the
 * artifact gate, the console, and capability-filtered discovery). Three ad-hoc
 * parses would disagree about field names, missing-value fallbacks, and whether
 * capability matching is exact — and those disagreements only surface when a
 * defect actually fires, which is the worst possible moment to find them.
 *
 * Two things it deliberately is not:
 *
 * - **Not a runtime policy.** Nothing here may cause a call to be refused. A
 *   hand-maintained JSON file is not rigorous enough to act as an implicit
 *   behaviour switch; `session_fork` fails because the engine failed it, not
 *   because of this record.
 * - **Not an edit to the capability matrix.** `worker_describe` keeps reporting
 *   what the engine claims (design §12). A defect sits beside that claim. Merging
 *   the two would erase the most important fact — that the engine is wrong about
 *   itself.
 */

/** One recorded defect, after shape validation. */
export interface KnownDefect {
  readonly id: string;
  readonly engine: string;
  /** Dotted descriptor path, e.g. `session.fork` — same naming as the capability matrix. */
  readonly capability: string;
  readonly component: string;
  readonly componentVersion: string;
  /** The Realm version the defect was last observed under (ADR 0026). */
  readonly realmVersion: string;
  readonly owner?: string;
  readonly summary?: string;
  readonly impact?: string;
  readonly evidence: string;
}

export interface KnownDefectProblem {
  readonly id: string;
  readonly message: string;
}

const REQUIRED = ['id', 'engine', 'capability', 'component', 'componentVersion', 'realmVersion', 'evidence'] as const;

function readEntries(verification: unknown): readonly Record<string, unknown>[] {
  if (typeof verification !== 'object' || verification === null) return [];
  const defects = (verification as { knownDefects?: unknown }).knownDefects;
  if (typeof defects !== 'object' || defects === null) return [];
  const entries = (defects as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
}

/**
 * Parse and validate the record.
 *
 * A malformed entry becomes a problem rather than being skipped: a defect that
 * silently disappears because a field was misspelled is worse than no record,
 * since the matrix would then read as "no known defects".
 */
export function loadKnownDefects(verification: unknown): { defects: readonly KnownDefect[]; problems: readonly KnownDefectProblem[] } {
  const defects: KnownDefect[] = [];
  const problems: KnownDefectProblem[] = [];
  for (const entry of readEntries(verification)) {
    const id = typeof entry['id'] === 'string' ? entry['id'] : '<unnamed>';
    const missing = REQUIRED.filter((field) => typeof entry[field] !== 'string' || (entry[field] as string).length === 0);
    if (missing.length > 0) {
      problems.push({ id, message: `known defect ${id} must record ${REQUIRED.join(', ')}; missing or empty: ${missing.join(', ')}` });
      continue;
    }
    defects.push(entry as unknown as KnownDefect);
  }
  return { defects, problems };
}



/** One entry past its baseline, carrying which dimensions moved (ADR 0026). */
export interface StaleDefect {
  readonly defect: KnownDefect;
  /** The entry's `componentVersion` no longer matches the component baseline. */
  readonly componentExpired: boolean;
  /** The entry's `realmVersion` no longer matches this release's Realm version. */
  readonly realmExpired: boolean;
}

/**
 * Which freshness dimensions have moved for one entry.
 *
 * Internal to {@link staleDefects}: the gate is the only caller, because the
 * runtime reads the mirrored constant rather than this parse (see
 * `engine-support.ts`). Exporting it would offer an API with nobody on the
 * other end.
 */
function expiredDimensions(defect: KnownDefect, componentVersions: Readonly<Record<string, unknown>>, realmVersion: string): { component: boolean; realm: boolean } {
  return {
    // ADR 0026 decision 4: an entry whose `component` appears in neither
    // baseline stays permanently fresh on this dimension. Closing that hole is
    // owned by ADR 0012 §2 and must not happen here by side effect.
    component: Object.hasOwn(componentVersions, defect.component) && componentVersions[defect.component] !== defect.componentVersion,
    realm: defect.realmVersion !== realmVersion,
  };
}

/**
 * Entries past their baseline on either freshness dimension, each returned once.
 *
 * The Realm dimension (ADR 0026) is independent of the component one: a bump of
 * the top-level `realmVersion` expires an entry even when its component sat
 * still. The reasons travel with the entry so the gate can emit one message per
 * expired dimension when both have moved — collapsing them loses which run is
 * needed.
 */
export function staleDefects(defects: readonly KnownDefect[], componentVersions: Readonly<Record<string, unknown>>, realmVersion: string): readonly StaleDefect[] {
  const stale: StaleDefect[] = [];
  for (const defect of defects) {
    const { component, realm } = expiredDimensions(defect, componentVersions, realmVersion);
    if (component || realm) stale.push({ defect, componentExpired: component, realmExpired: realm });
  }
  return stale;
}

/**
 * Read `verification.engines`.
 *
 * This answers "has the matrix been run", **not** "may this engine be used".
 * Usability is ADR 0004's `allowUnverifiedEngines` combined with the frozen
 * §4.2 set, and belongs to the caller: folding the two together here would make
 * a spec-level guarantee indistinguishable from gate evidence, and no caller
 * could tell them apart afterwards.
 *
 * It is also orthogonal to {@link loadKnownDefects}. An engine can be verified
 * and still carry a recorded defect — claude-code becomes exactly that once its
 * matrix is run — so neither result may mask the other.
 */
export function engineVerification(verification: unknown): Readonly<Record<string, 'verified' | 'unverified'>> {
  if (typeof verification !== 'object' || verification === null) return {};
  const engines = (verification as { engines?: unknown }).engines;
  if (typeof engines !== 'object' || engines === null || Array.isArray(engines)) return {};
  const states: Record<string, 'verified' | 'unverified'> = {};
  for (const [engine, value] of Object.entries(engines as Record<string, unknown>)) {
    if (typeof value === 'boolean') states[engine] = value ? 'verified' : 'unverified';
  }
  return states;
}
