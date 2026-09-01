import { probeLegacyInstances, resolveLegacyProbeRoots } from '../packages/plugin/src/legacy-preflight.js';
import type { ProcessInspector } from '../packages/plugin/src/lifecycle.js';

/** Run the deploy safety gate before any package or host mutation. */
export async function runDeployPreflight(inspect?: ProcessInspector, roots = resolveLegacyProbeRoots(process.env)): Promise<void> {
  for (const result of await probeLegacyInstances(roots, inspect)) {
    // Deploy preserves the legacy active-only refusal contract: uncertainty is
    // reported for the operator but never widened into a destructive refusal
    // and never bypassed by the runtime force override.
    if (result.state === 'active') throw new Error(`legacy instance ${result.instanceId ?? 'unknown'} is active under ${result.root}; stop it before deploying`);
    if (result.state === 'indeterminate') console.warn(`legacy deploy probe indeterminate under ${result.root}: ${result.cause ?? 'unknown cause'}`);
  }
}
