import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertGenericKitSource,
  assertSupportAlignment as alignDiscoveredHosts,
  discoverHostManifests,
  validateHostDriver,
  validateHostManifest,
  type HostManifest,
} from '../../packages/host-kit/src/index.js';

export { assertGenericKitSource, discoverHostManifests, validateHostDriver, validateHostManifest };
export type { HostManifest };

export const SUPPORTED_HOST_IDS = ['claude-code', 'codex', 'kimi', 'opencode'] as const;
export const HOST_KITS = new Set(['stdio-mcp', 'shared-skill', 'stop-hook', 'marketplace', 'managed-copy']);

export function assertSupportAlignment(manifests: readonly HostManifest[]): void {
  alignDiscoveredHosts(manifests, SUPPORTED_HOST_IDS);
}

/** Create a small valid fixture used by HOSTCFG mutation tests. */
export async function createHostFixture(parent: string, id = 'fixture'): Promise<string> {
  const directory = join(parent, id);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, 'driver.ts'), `import { createHostDriver } from '@taskshuttle/host-kit'; export default createHostDriver('${id}');`),
    writeFile(join(directory, 'plugin.json'), '{}'),
    writeFile(join(directory, 'host.json'), JSON.stringify({ schemaVersion: 1, id, kind: 'stdio-config', baseline: '1.0.0', scopes: ['user'], kits: ['stdio-mcp'], driver: 'driver.ts', versionedManifest: 'plugin.json', artifacts: [{ role: 'plugin-manifest', path: 'plugin.json', generated: false }] })),
  ]);
  return directory;
}
