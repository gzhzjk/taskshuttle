import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageRoot = join(root, 'packages', 'plugin');

async function copyTree(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    await cp(join(source, entry.name), join(target, entry.name), { recursive: entry.isDirectory() });
  }
}

/**
 * Stage the public Plugin package from generated compatibility outputs.
 * Committed prior-release tarballs are deliberately excluded: they are
 * rollback fixtures, never a runtime dependency of the public package.
 * @returns A promise settled after package-local release trees are refreshed.
 * @throws If a required generated source tree is unavailable.
 */
export async function stagePluginPackage(): Promise<void> {
  for (const directory of ['hosts', 'marketplaces', 'release', 'skills']) {
    await rm(join(packageRoot, directory), { recursive: true, force: true });
  }
  for (const directory of ['hosts', 'marketplaces', 'skills']) {
    await copyTree(join(root, directory), join(packageRoot, directory));
  }
  const releaseTarget = join(packageRoot, 'release');
  await mkdir(releaseTarget, { recursive: true });
  for (const entry of await readdir(join(root, 'release'), { withFileTypes: true })) {
    // Committed prior-release tarballs are rollback fixtures and gate reports
    // are local evidence; the public package carries only runtime metadata.
    if (entry.name.endsWith('.tgz') || entry.name === 'gates') continue;
    await cp(join(root, 'release', entry.name), join(releaseTarget, entry.name), { recursive: entry.isDirectory() });
  }
  // npm used to include every README* at the root of the public package even
  // though only README.md appeared in `files`. Preserve those consumer-facing
  // paths while the package root moves under packages/plugin.
  //
  // `README.reversed.md` was in this list and is not any more: it is a draft of
  // a README rewrite, it is withheld from the release repository, and staging it
  // made the exported build fail on a missing file. A draft has no business in a
  // published package either way.
  for (const file of ['README.md', 'README.zh-CN.md', 'LICENSE', 'NOTICE']) {
    await cp(join(root, file), join(packageRoot, file));
  }
}

await stagePluginPackage();
