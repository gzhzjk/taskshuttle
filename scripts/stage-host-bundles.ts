import { cp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { discoverHostManifests, type HostDriver } from '@taskshuttle/host-kit';

export interface StageHostBundlesOptions {
  readonly root: string;
  /** Already-built Plugin package root. Supplying this is the production path. */
  readonly pluginBundle?: string;
  /** Test-only seam that proves one Plugin build supplies all host stages. */
  readonly buildPluginBundle?: () => Promise<string>;
  readonly sharedSkills?: string;
  readonly legalSources?: readonly string[];
  /** Optional post-stage assertion, used by HOSTCFG-003 to check immutability. */
  readonly assertBundleUnchanged?: (hostId: string, pluginBundle: string) => Promise<void>;
}

/** Stage every discovered host from one immutable Plugin bundle. */
export async function stageHostBundles(options: StageHostBundlesOptions): Promise<void> {
  const root = options.root;
  const pluginBundle = options.pluginBundle ?? await options.buildPluginBundle?.();
  if (pluginBundle === undefined) throw new Error('stageHostBundles requires an already-built pluginBundle or buildPluginBundle');
  const sharedSkills = options.sharedSkills ?? join(root, 'skills');
  const legalSources = options.legalSources ?? [join(root, 'LICENSE'), join(root, 'NOTICE')];
  const manifests = await discoverHostManifests(root);
  for (const manifest of manifests) {
    const hostDirectory = join(root, 'hosts', manifest.id);
    const module = await import(pathToFileURL(join(hostDirectory, manifest.driver)).href) as { default?: HostDriver };
    const driver = module.default;
    if (driver === undefined || driver.id !== manifest.id) throw new Error(`host '${manifest.id}' driver does not match its manifest`);
    const roots = { repository: root, host: hostDirectory, output: hostDirectory };
    await driver.stage({ manifest, roots, pluginBundle, sharedSkills, legalSources });
    const verification = await driver.verify({ manifest, roots });
    if (verification.status === 'skipped') throw new Error(`host '${manifest.id}' verification was skipped during staging`);
    await options.assertBundleUnchanged?.(manifest.id, pluginBundle);
    if (driver.marketplacePayload !== undefined) {
      const target = join(root, driver.marketplacePayload);
      await rm(target, { recursive: true, force: true });
      await cp(hostDirectory, target, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const root = process.cwd();
  const pluginDistArgument = process.argv.indexOf('--plugin-dist');
  const pluginDistInput = pluginDistArgument >= 0 && process.argv[pluginDistArgument + 1] !== undefined
    ? resolve(root, process.argv[pluginDistArgument + 1] as string)
    : root;
  await stageHostBundles({ root, pluginBundle: basename(pluginDistInput) === 'dist' ? dirname(pluginDistInput) : pluginDistInput });
}
