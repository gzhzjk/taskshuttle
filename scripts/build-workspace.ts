import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const pluginRoot = join(root, 'packages', 'plugin');

/** Run one package-local build command and preserve its diagnostics. */
async function run(command: string, args: string[]): Promise<void> {
  await exec(command, args, { cwd: root, maxBuffer: 20 * 1024 * 1024 });
}

/**
 * Build the workspace in dependency order and materialize compatibility outputs.
 * The Plugin package owns the bundle; root `dist/` is only a generated mirror
 * for the current development and gate entry points until those consumers move.
 * @returns A promise settled after all package and compatibility outputs exist.
 * @throws If any package build or staging command fails.
 */
export async function buildWorkspace(): Promise<void> {
  // TypeScript build-info is kept in the repository's ignored .build/ tree,
  // never beside public runtime files. Clearing package dist first also removes
  // stale hidden files left by an older pre-split build.
  for (const packageName of ['core', 'host-kit', 'plugin']) {
    await rm(join(root, 'packages', packageName, 'dist'), { recursive: true, force: true });
  }
  for (const buildInfo of ['core.tsbuildinfo', 'host-kit.tsbuildinfo', 'plugin.tsbuildinfo']) {
    await rm(join(root, '.build', buildInfo), { force: true });
  }
  await run('pnpm', ['gen:ui-assets']);
  await run('pnpm', ['--filter', '@taskshuttle/core', 'build']);
  await run('pnpm', ['--filter', '@taskshuttle/host-kit', 'build']);
  await run('pnpm', ['--filter', 'taskshuttle', 'build']);
  await run('pnpm', ['gen:notice']);
  await run('pnpm', ['tsx', 'scripts/copy-runtime-assets.ts', '--dist', 'packages/plugin/dist']);
  await run('pnpm', ['tsx', 'scripts/sync-host-baselines.ts']);
  await run('pnpm', ['tsx', 'scripts/stage-host-bundles.ts', '--plugin-dist', 'packages/plugin/dist']);
  await run('pnpm', ['tsx', 'scripts/stage-plugin-package.ts']);

  const rootDist = join(root, 'dist');
  await rm(rootDist, { recursive: true, force: true });
  await mkdir(rootDist, { recursive: true });
  for (const entry of await readdir(join(pluginRoot, 'dist'), { withFileTypes: true })) {
    await cp(join(pluginRoot, 'dist', entry.name), join(rootDist, entry.name), { recursive: entry.isDirectory() });
  }
}

await buildWorkspace();
