/** Stable capability identifiers claimed by host manifests. */
export const HOST_KIT_IDS = ['stdio-mcp', 'shared-skill', 'stop-hook', 'marketplace', 'managed-copy'] as const;
export type HostKitCapabilityId = (typeof HOST_KIT_IDS)[number];

/** A host-neutral relative path rooted in a build context. */
export type ScopedPath = string;

/** A command represented as a binary plus argv, never a shell string. */
export interface ArgvCommand {
  readonly binary: string;
  readonly argv: readonly string[];
}

/** Generic host-kit marker used by package consumers. */
export interface HostKitCapability {
  readonly id: HostKitCapabilityId;
}

export * from './manifest.js';
export * from './driver.js';
export * from './build-host.js';
export * from './scoped-fs.js';
export * from './argv-runner.js';
export * from './kits.js';
export * from './artifacts.js';
