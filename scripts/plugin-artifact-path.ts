import { join, resolve } from 'node:path';

/**
 * Resolve the public Plugin package root for a repository checkout. The
 * package-local tree is authoritative even when its `dist/` is missing;
 * callers must not fall back to the generated root compatibility mirror.
 * @param rootDirectory Repository or synthetic artifact root.
 * @returns The directory whose `package.json` and `dist/` are public.
 */
export function resolvePluginPackageRoot(rootDirectory: string): string {
  const root = resolve(rootDirectory);
  return join(root, 'packages', 'plugin');
}

/**
 * Resolve the public Plugin bundle directory.
 * @param rootDirectory Repository or synthetic artifact root.
 * @returns The `dist/` directory packed and installed for the Plugin.
 */
export function resolvePluginDist(rootDirectory: string): string {
  return join(resolvePluginPackageRoot(rootDirectory), 'dist');
}
