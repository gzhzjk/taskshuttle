import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { HostManifest } from './manifest.js';

/** The manifest fields required by the generic staging boundary. */
export type BuildHostManifest = Pick<HostManifest, 'id' | 'artifacts'>;

/** Immutable inputs shared by every host build. */
export interface BuildHostContext {
  readonly pluginBundle: string;
  readonly sharedSkills: string;
  readonly legalSources: readonly string[];
}

async function copyFiles(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) await copyFiles(from, to);
    else if (entry.isFile()) await cp(from, to);
  }
}

/**
 * Materialize one host output from the immutable Plugin bundle and shared sources.
 * @param manifest Host artifact declaration to validate while staging.
 * @param context Read-only shared bundle, skills, and legal-file inputs.
 * @param outputRoot Empty output directory to recreate for this host.
 * @returns The output root after staging.
 * @throws If a shared input is missing or required runtime entries are absent.
 */
export async function buildHost(
  manifest: BuildHostManifest,
  context: BuildHostContext,
  outputRoot: string,
): Promise<string> {
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const pluginDist = join(context.pluginBundle, 'dist');
  await stat(pluginDist);
  await stat(context.sharedSkills);
  const generated = manifest.artifacts.filter((artifact) => artifact.generated);
  for (const artifact of generated) await rm(join(outputRoot, artifact.path), { recursive: true, force: true });
  for (const artifact of generated) {
    const target = join(outputRoot, artifact.path);
    if (artifact.path === 'dist') await copyFiles(pluginDist, target);
    else if (artifact.path === 'skills') await copyFiles(context.sharedSkills, target);
    else if (artifact.path.startsWith('dist/')) {
      const source = join(pluginDist, artifact.path.slice('dist/'.length));
      await stat(source);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target);
    } else {
      const source = context.legalSources.find((candidate) => basename(candidate) === basename(artifact.path));
      if (source === undefined) throw new Error(`no generated source is available for host artifact '${artifact.path}'`);
      await stat(source);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target);
    }
  }
  for (const required of ['dist/launch.js', 'dist/nanny.js']) {
    const declared = generated.some((artifact) => required === artifact.path || required.startsWith(`${artifact.path}/`));
    if (!declared) throw new Error(`host '${manifest.id}' does not declare generated runtime entry ${required}`);
    await stat(join(outputRoot, required));
  }
  for (const artifact of generated) await stat(join(outputRoot, artifact.path));
  return outputRoot;
}
