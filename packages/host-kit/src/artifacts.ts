import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverHostManifests, type HostManifest } from './manifest.js';

/** Compatibility projection consumed by release and live-host orchestrators. */
export interface HostArtifactSpec {
  readonly host: string;
  readonly directory: string;
  readonly manifest: string;
  readonly transport: 'stdio-mcp';
  readonly supportedScopes: readonly string[];
  readonly kind: HostManifest['kind'];
  readonly hostManifest: HostManifest;
}

/** Runtime entry registered by every staged host bundle's stop hook. */
export const NANNY_HOOK_ENTRY = 'dist/nanny.js';

/** Runtime entries that must remain byte-identical across host projections. */
export const STAGED_RUNTIME_ENTRIES = ['dist/cli.js', 'dist/launch.js', NANNY_HOOK_ENTRY] as const;

/** Shared orchestration skill copied into every host package. */
export const SHARED_SKILL = 'skills/delegate-workers/SKILL.md';

/**
 * Discover host manifests and project them into the release-gate shape.
 *
 * Invalid manifests are left for the per-host validator to report. The
 * fallback preserves the gate's ability to enumerate a malformed directory so
 * a missing or invalid host cannot disappear merely because strict parsing
 * failed.
 * @param root - repository root containing `hosts/`.
 * @returns discovered host artifact projections in manifest order.
 */
export async function discoverHostArtifactSpecs(root: string): Promise<HostArtifactSpec[]> {
  let manifests: HostManifest[];
  try {
    manifests = await discoverHostManifests(root);
  } catch {
    manifests = [];
    for (const entry of await readdir(join(root, 'hosts'), { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      try {
        const value = JSON.parse(await readFile(join(root, 'hosts', entry.name, 'host.json'), 'utf8')) as Partial<HostManifest>;
        if (value.id === entry.name && Array.isArray(value.artifacts) && typeof value.kind === 'string') manifests.push(value as HostManifest);
      } catch {
        // Strict discovery reports the malformed entry; this fallback only
        // keeps a parseable sibling visible to the aggregate gate.
      }
    }
  }
  return manifests.map((manifest) => ({
    host: manifest.id,
    directory: `hosts/${manifest.id}`,
    // Only the explicit field is a version owner. A free-form artifact role
    // is descriptive metadata and must never become release authority by
    // inference (ADR 0049).
    manifest: manifest.versionedManifest ?? '',
    transport: 'stdio-mcp',
    supportedScopes: manifest.scopes,
    kind: manifest.kind,
    hostManifest: manifest,
  }));
}
