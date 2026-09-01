import { rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';

const exec = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, '..');
const packageRoot = resolve(repositoryRoot, 'packages', 'plugin');

/**
 * Build the public Plugin bundle after removing any hidden files left by an
 * older TypeScript or bundler invocation.
 * @returns A promise settled after the package-owned dist tree is complete.
 * @throws If the package bundler fails.
 */
export async function buildPluginPackage(): Promise<void> {
  await rm(join(packageRoot, 'dist'), { recursive: true, force: true });
  await exec('pnpm', ['exec', 'tsup', '--config', 'tsup.config.ts'], { cwd: packageRoot, maxBuffer: 20 * 1024 * 1024 });
  // The package build must be safe to invoke on its own. Runtime assets are
  // copied from repository-level dependency/configuration sources, so invoke
  // that script from the repository root while targeting this package's dist.
  await exec('pnpm', ['tsx', 'scripts/copy-runtime-assets.ts', '--dist', 'packages/plugin/dist'], { cwd: repositoryRoot, maxBuffer: 20 * 1024 * 1024 });
}

await buildPluginPackage();
