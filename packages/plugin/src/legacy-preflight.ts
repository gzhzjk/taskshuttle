import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import { defaultProcessInspector, startTimeFamily, type ProcessInspector } from './lifecycle.js';
import { readInstanceRecords } from './delegation-evidence.js';

export type LegacyProbeState = 'clear' | 'active' | 'indeterminate';

export interface LegacyProbeResult {
  readonly state: LegacyProbeState;
  readonly root: string;
  readonly instanceId?: string;
  readonly cause?: string;
}

/** Resolve the additive operator root list used by runtime and deploy. */
export function resolveLegacyProbeRoots(
  env: NodeJS.ProcessEnv,
  options: { home?: string; testRoots?: readonly string[] } = {},
): readonly string[] {
  if (options.testRoots !== undefined) return options.testRoots;
  const configured = (env['TASKSHUTTLE_LEGACY_DATA_ROOTS'] ?? '')
    .split(delimiter).map((value) => value.trim()).filter(Boolean);
  return [defaultLegacyRoot(options.home), ...configured];
}

/** Probe legacy instance records without opening transcripts or mutating roots. */
export async function probeLegacyInstances(
  roots: readonly string[],
  inspect: ProcessInspector = defaultProcessInspector,
): Promise<readonly LegacyProbeResult[]> {
  const results: LegacyProbeResult[] = [];
  for (const root of roots) {
    let records;
    try { records = await readInstanceRecords(root); }
    catch (cause) { results.push({ state: 'indeterminate', root, cause: cause instanceof Error ? cause.message : String(cause) }); continue; }
    if (records === undefined) { results.push({ state: 'indeterminate', root, cause: 'instance records could not be read' }); continue; }
    let active;
    for (const record of records) {
      const identity = await inspect(record.pid);
      if (!identity.exists) continue;
      if (identity.processStartedAt === undefined) {
        results.push({ state: 'indeterminate', root, instanceId: record.instanceId, cause: 'process identity unavailable' });
        active = undefined;
        break;
      }
      if (startTimeFamily(identity.processStartedAt) !== startTimeFamily(record.processStartedAt)) {
        results.push({ state: 'indeterminate', root, instanceId: record.instanceId, cause: 'process identity formats differ' });
        active = undefined;
        break;
      }
      if (identity.processStartedAt !== record.processStartedAt) continue;
      active = record;
      break;
    }
    if (results.at(-1)?.root === root && results.at(-1)?.state === 'indeterminate') continue;
    results.push(active === undefined ? { state: 'clear', root } : { state: 'active', root, instanceId: active.instanceId });
  }
  return results;
}

/** Enforce the fresh-root legacy-live boundary before creating new state. */
export async function assertLegacyRootsSafe(
  roots: readonly string[],
  forceIndeterminate = process.env.TASKSHUTTLE_FORCE_LEGACY_PROBE === '1',
  inspect: ProcessInspector = defaultProcessInspector,
): Promise<void> {
  for (const result of await probeLegacyInstances(roots, inspect)) {
    if (result.state === 'active') throw new Error(`legacy instance ${result.instanceId ?? 'unknown'} is active under ${result.root}; stop it before starting TaskShuttle`);
    if (result.state === 'indeterminate' && !forceIndeterminate) throw new Error(`legacy instance state is indeterminate under ${result.root}; inspect it or set TASKSHUTTLE_FORCE_LEGACY_PROBE=1`);
    if (result.state === 'indeterminate') console.warn(`legacy probe override: skipped ${result.root}: ${result.cause ?? 'unknown cause'}`);
  }
}

export function defaultLegacyRoot(home = homedir()): string { return join(home, '.realm-plugin'); }
