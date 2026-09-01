import type { ScopedFilesystem } from './scoped-fs.js';

/** The host-neutral stdio MCP configuration consumed by supported hosts. */
export interface StdioMcpEntry {
  readonly type: 'local';
  readonly command: readonly string[];
}

/** Create a typed stdio MCP entry without embedding host policy. */
export function createStdioMcpEntry(command: string, args: readonly string[] = []): StdioMcpEntry {
  if (command.length === 0 || command.includes('\0') || args.some((arg) => arg.includes('\0'))) throw new Error('stdio MCP command contains an invalid value');
  return Object.freeze({ type: 'local', command: [command, ...args] });
}

/**
 * Synchronize one declared directory through two canonical filesystem roots.
 * Source names are copied through the destination root and every copied path
 * is re-checked by `ScopedFilesystem` before mutation. Shared projections use
 * merge semantics by default so an operator's unrelated files survive; an
 * exclusive managed projection opts into stale-name removal with `prune`.
 */
export async function syncDirectory(
  source: ScopedFilesystem,
  destination: ScopedFilesystem,
  sourcePath: string,
  destinationPath: string,
  options: { readonly mode?: number; readonly filter?: (name: string) => boolean; readonly prune?: boolean } = {},
): Promise<readonly string[]> {
  const filter = options.filter ?? (() => true);
  const sourceNames = (await source.list(sourcePath)).filter(filter);
  const destinationNames = await destination.list(destinationPath).catch(() => [] as readonly string[]);
  const plan = options.prune === true
    ? managedCopyPlan(sourceNames, destinationNames)
    : { copy: sourceNames, remove: [] as readonly string[] };
  await destination.ensureDirectory(destinationPath, options.mode ?? 0o700);
  for (const name of plan.remove) await destination.remove(`${destinationPath}/${name}`, { missingOk: true });
  for (const name of plan.copy) {
    await destination.remove(`${destinationPath}/${name}`, { missingOk: true });
    await destination.copy(source, `${sourcePath}/${name}`, `${destinationPath}/${name}`);
  }
  return sourceNames;
}

/** Build a host-neutral marketplace copy plan from a source relative path. */
export interface MarketplaceProjection {
  readonly sourcePath: string;
  readonly destinationPath: string;
}

/** Describe a marketplace projection without naming a host or invoking I/O. */
export function marketplaceProjection(sourcePath: string, destinationPath: string): MarketplaceProjection {
  if (sourcePath.length === 0 || destinationPath.length === 0) throw new Error('marketplace projection paths are required');
  return Object.freeze({ sourcePath, destinationPath });
}

/** Return whether a host-neutral stop registration names the staged hook. */
export function hasStopHookTarget(targets: readonly string[], hookEntry: string): boolean {
  return hookEntry.length > 0 && targets.some((target) => target.includes(hookEntry));
}

/** Describe a managed-copy synchronization without deciding its host policy. */
export interface ManagedCopyPlan {
  readonly copy: readonly string[];
  readonly remove: readonly string[];
}

/** Compute the copy/remove sets used by a managed-copy kit. */
export function managedCopyPlan(sourceNames: readonly string[], destinationNames: readonly string[]): ManagedCopyPlan {
  const source = [...new Set(sourceNames)].sort();
  const destination = [...new Set(destinationNames)].sort();
  return Object.freeze({
    copy: source,
    remove: destination.filter((name) => !source.includes(name)),
  });
}
