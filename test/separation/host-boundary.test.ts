import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertGenericKitSource, assertSupportAlignment, createHostFixture, discoverHostManifests, validateHostManifest, type HostManifest } from './host-manifest-check.js';
import { stageHostBundles } from '../../scripts/stage-host-bundles.js';
import { discoverVersionedManifests } from '../../scripts/release-manifests.mjs';
import { assertSupportAlignment as alignHostIds, createStdioMcpEntry, discoverHostArtifactSpecs, hasStopHookTarget, marketplaceProjection, managedCopyPlan, ScopedFilesystem, scopedRoot, syncDirectory, type HostDeployContext } from '../../packages/host-kit/src/index.js';

const root = process.cwd();

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await import('node:fs/promises').then(({ readdir }) => readdir(directory, { withFileTypes: true })).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

async function digestTree(directory: string): Promise<string> {
  const digest = createHash('sha256');
  for (const file of await filesUnder(directory)) {
    digest.update(relative(directory, file).split('\\').join('/'));
    digest.update('\0');
    digest.update(await readFile(file));
  }
  return digest.digest('hex');
}

async function fakeDeploymentContext(manifest: HostManifest, repository: string, home: string, dryRun: boolean): Promise<HostDeployContext> {
  const repositoryFiles = new ScopedFilesystem(await scopedRoot('repository', repository));
  const homeFiles = new ScopedFilesystem(await scopedRoot('home', home));
  const managedFiles = new ScopedFilesystem(await scopedRoot('managed', join(home, '.kimi-code')));
  return {
    manifest,
    roots: { repository, host: join(repository, 'hosts', manifest.id), output: join(repository, 'hosts', manifest.id) },
    dryRun,
    scope: 'user',
    home,
    env: { KIMI_CODE_HOME: join(home, '.kimi-code') },
    onPath: () => true,
    files: {
      repository: repositoryFiles,
      home: homeFiles,
      managed: managedFiles,
    },
    run: async () => ({ status: 0, stdout: 'taskshuttle installed', stderr: '' }),
    requireRun: async () => '',
  };
}

describe('Phase 2 host configuration gates', () => {
  it('HOSTCFG-001: discovers and validates exactly the four supported host manifests', async () => {
    const manifests = await discoverHostManifests(root);
    expect(manifests.map((manifest) => manifest.id).sort(), 'every supported host manifest must be discovered; manifest-less host directories are ignored').toEqual(['claude-code', 'codex', 'kimi', 'opencode']);
    assertSupportAlignment(manifests);
  });

  it('HOSTCFG-001: rejects malformed, unknown-version, mismatched, duplicate, missing, symlink, and escaping fixtures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'taskshuttle-hostcfg-'));
    try {
      const fixture = await createHostFixture(directory);
      const valid = JSON.parse(await readFile(join(fixture, 'host.json'), 'utf8')) as Record<string, unknown>;
      await expect(validateHostManifest({ ...valid, unknownField: true }, fixture)).rejects.toThrow(/unknown host manifest field/u);
      await expect(validateHostManifest({ ...valid, baseline: 'not-a-version' }, fixture)).rejects.toThrow(/baseline/u);
      await expect(validateHostManifest({ ...valid, scopes: [] }, fixture)).rejects.toThrow(/scopes/u);
      await expect(validateHostManifest({ ...valid, scopes: ['user', 'user'] }, fixture)).rejects.toThrow(/unique/u);
      await expect(validateHostManifest({ ...valid, kits: ['unknown-kit'] }, fixture)).rejects.toThrow(/unknown capability/u);
      await expect(validateHostManifest({ ...valid, kits: ['stdio-mcp', 'stdio-mcp'] }, fixture)).rejects.toThrow(/unique/u);
      await expect(validateHostManifest({ ...valid, schemaVersion: 2 }, fixture)).rejects.toThrow(/schemaVersion/u);
      await expect(validateHostManifest({ ...valid, id: 'other' }, fixture)).rejects.toThrow(/directory basename/u);
      await writeFile(join(fixture, 'driver.ts'), "export default { id: 'other' };");
      await expect(validateHostManifest(valid, fixture)).rejects.toThrow(/exported id/u);
      await writeFile(join(fixture, 'driver.ts'), "import { spawn } from 'node:child_process'; export default { id: 'fixture' };");
      await expect(validateHostManifest(valid, fixture)).rejects.toThrow(/child_process/u);
      await writeFile(join(fixture, 'driver.ts'), "export default { id: 'fixture', command: 'sh -c echo' };");
      await expect(validateHostManifest(valid, fixture)).rejects.toThrow(/shell/u);
      await writeFile(join(fixture, 'driver.ts'), "import { readFile } from 'node:fs/promises'; export default { id: 'fixture' };");
      await expect(validateHostManifest(valid, fixture)).rejects.toThrow(/filesystem/u);
      await writeFile(join(fixture, 'driver.ts'), "const driver = { id: 'fixture' }; export default driver;");
      await expect(validateHostManifest(valid, fixture)).resolves.toMatchObject({ id: 'fixture' });
      await writeFile(join(fixture, 'driver.ts'), "export default { id: 'fixture' };");
      await expect(validateHostManifest({ ...valid, artifacts: [{ role: 'plugin-manifest', path: 'plugin.json', generated: false }, { role: 'plugin-manifest', path: 'driver.ts', generated: false }] }, fixture)).rejects.toThrow(/unique/u);
      await expect(validateHostManifest({ ...valid, driver: '../outside.ts' }, fixture)).rejects.toThrow(/normalized|unsafe/u);
      await writeFile(join(fixture, 'outside.ts'), '');
      await symlink(join(directory, 'outside.ts'), join(fixture, 'escape.ts'));
      await expect(validateHostManifest({ ...valid, driver: 'escape.ts' }, fixture)).rejects.toThrow(/escapes|ENOENT/u);
      await expect(validateHostManifest({ ...valid, driver: 'missing.ts' }, fixture)).rejects.toThrow(/ENOENT/u);
      await expect(validateHostManifest({ ...valid, versionedManifest: 'missing.json' }, fixture)).rejects.toThrow(/declared|ENOENT/u);
      await expect(validateHostManifest({ ...valid, artifacts: [] }, fixture)).rejects.toThrow(/artifacts/u);
      await expect(validateHostManifest({ ...valid, artifacts: [{ role: 'plugin-manifest', path: 'plugin.json', generated: false }, { role: 'runtime-bundle', path: 'dist/launch.js', generated: true }] }, fixture)).resolves.toMatchObject({ id: 'fixture' });
      await expect(validateHostManifest({ ...valid, versionedManifest: 'dist/launch.js', artifacts: [{ role: 'plugin-manifest', path: 'plugin.json', generated: false }, { role: 'runtime-bundle', path: 'dist/launch.js', generated: true }] }, fixture)).rejects.toThrow(/static declared artifact/u);
      await writeFile(join(directory, 'outside-artifact.txt'), 'outside');
      await symlink(join(directory, 'outside-artifact.txt'), join(fixture, 'artifact-link.txt'));
      await expect(validateHostManifest({ ...valid, artifacts: [{ role: 'plugin-manifest', path: 'plugin.json', generated: false }, { role: 'outside', path: 'artifact-link.txt', generated: false }] }, fixture)).rejects.toThrow(/escapes|ENOENT/u);

      const discoveryRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-host-discovery-'));
      try {
        const hostsRoot = join(discoveryRoot, 'hosts');
        await import('node:fs/promises').then(({ mkdir }) => mkdir(hostsRoot, { recursive: true }));
        await import('node:fs/promises').then(({ mkdir }) => mkdir(join(hostsRoot, 'manifest-less')));
        await createHostFixture(hostsRoot, 'valid');
        const roleOnlyDirectory = await createHostFixture(hostsRoot, 'role-only');
        const roleOnlyManifest = JSON.parse(await readFile(join(roleOnlyDirectory, 'host.json'), 'utf8')) as Record<string, unknown>;
        delete roleOnlyManifest.versionedManifest;
        await writeFile(join(roleOnlyDirectory, 'host.json'), JSON.stringify(roleOnlyManifest));
        await symlink(join(hostsRoot, 'valid'), join(hostsRoot, 'linked'));
        await expect(discoverHostManifests(discoveryRoot)).rejects.toThrow(/symlink/u);
        await rm(join(hostsRoot, 'linked'), { recursive: true, force: true });
        await expect(discoverHostManifests(discoveryRoot)).resolves.toMatchObject([{ id: 'role-only' }, { id: 'valid' }]);
        const projected = await discoverHostArtifactSpecs(discoveryRoot);
        expect(projected.find((entry) => entry.host === 'role-only')?.manifest, 'artifact roles must not become version owners').toBe('');
        await expect(Promise.resolve(discoverVersionedManifests(discoveryRoot))).resolves.toEqual(['packages/plugin/package.json', 'hosts/valid/plugin.json']);
        const discoveredDocument = JSON.parse(await readFile(join(hostsRoot, 'valid', 'host.json'), 'utf8')) as Record<string, unknown>;
        await writeFile(join(hostsRoot, 'valid', 'host.json'), JSON.stringify({
          ...discoveredDocument,
          versionedManifest: 'dist/launch.js',
          artifacts: [...(discoveredDocument.artifacts as unknown[]), { role: 'runtime', path: 'dist/launch.js', generated: true }],
        }));
        await expect(Promise.resolve().then(() => discoverVersionedManifests(discoveryRoot))).rejects.toThrow(/static declared artifact/u);
      } finally {
        await rm(discoveryRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('HOSTCFG-002: every real host-kit source has no host-specific dependency branches', async () => {
    const sources = await filesUnder(join(root, 'packages', 'host-kit', 'src'));
    expect(sources.filter((file) => file.endsWith('.ts')).length, 'packages/host-kit/src must contain generic kit modules before host drivers can depend on it').toBeGreaterThan(0);
    for (const file of sources.filter((candidate) => candidate.endsWith('.ts'))) {
      assertGenericKitSource(await readFile(file, 'utf8'), { allowProcessRunner: file.endsWith('/argv-runner.ts') });
    }
  });

  it('HOSTCFG-002: synthetic hosts can claim each kit capability without shell/effect escape', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'taskshuttle-hostkit-'));
    try {
      const kits = ['stdio-mcp', 'shared-skill', 'stop-hook', 'marketplace', 'managed-copy'];
      for (const kit of kits) {
        for (const ordinal of [1, 2]) {
          const manifest = await createHostFixture(directory, `fixture-${kit}-${ordinal}`);
          const document = JSON.parse(await readFile(join(manifest, 'host.json'), 'utf8')) as Record<string, unknown>;
          const candidate: Record<string, unknown> = { ...document, kits: [kit] };
          if (kit !== 'stdio-mcp') candidate.artifacts = [{ role: kit, path: 'plugin.json', generated: false }];
          const parsed = await validateHostManifest(candidate, manifest);
          expect(parsed.kits).toEqual([kit]);
        }
      }
      expect(() => assertGenericKitSource("import { spawn } from 'node:child_process';")).toThrow(/effect/u);
      expect(() => assertGenericKitSource('const value = process.env.SECRET;')).toThrow(/effect/u);
      expect(() => assertGenericKitSource("if (hostId === 'codex') return driver();")).toThrow(/host-ID/u);
      expect(() => assertGenericKitSource("import { codexDriver } from '../../hosts/codex/driver.js';")).toThrow(/host-ID/u);
      for (const source of [
        "if (context.manifest.id === 'codex') return driver();",
        "if (manifest.id !== 'codex') return driver();",
        "const id = manifest.id; if (id === 'codex') return driver();",
      ]) expect(() => assertGenericKitSource(source)).toThrow(/host-ID/u);

      const sourceRoot = await mkdtemp(join(directory, 'kit-source-'));
      const destinationRoot = await mkdtemp(join(directory, 'kit-destination-'));
      await mkdir(join(sourceRoot, 'skills', 'alpha'), { recursive: true });
      await writeFile(join(sourceRoot, 'skills', 'alpha', 'SKILL.md'), 'skill');
      await mkdir(join(destinationRoot, 'skills'), { recursive: true });
      await writeFile(join(destinationRoot, 'skills', 'stale'), 'stale');
      const sourceFiles = new ScopedFilesystem(await scopedRoot('repository', sourceRoot));
      const destinationFiles = new ScopedFilesystem(await scopedRoot('managed', destinationRoot));
      expect(createStdioMcpEntry('taskshuttle-launch')).toEqual({ type: 'local', command: ['taskshuttle-launch'] });
      expect(marketplaceProjection('hosts/one', 'marketplaces/one')).toEqual({ sourcePath: 'hosts/one', destinationPath: 'marketplaces/one' });
      expect(hasStopHookTarget(['dist/nanny.js'], 'dist/nanny.js')).toBe(true);
      expect(managedCopyPlan(['alpha'], ['alpha', 'stale'])).toEqual({ copy: ['alpha'], remove: ['stale'] });
      await syncDirectory(sourceFiles, destinationFiles, 'skills', 'skills', { prune: true });
      await expect(destinationFiles.readText('skills/alpha/SKILL.md')).resolves.toBe('skill');
      await expect(destinationFiles.readText('skills/stale')).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('HOSTCFG-003: production host build receives one immutable Plugin bundle', async () => {
    const candidates = ['packages/host-kit/src/build-host.ts', 'scripts/build-host.ts'];
    let builder: { buildHost?: (manifest: HostManifest, context: { pluginBundle: string; sharedSkills: string; legalSources: string[] }, outputRoot: string) => Promise<unknown> } | undefined;
    for (const candidate of candidates) {
      try {
        builder = await import(pathToFileURL(join(root, candidate)).href) as typeof builder;
        break;
      } catch {
        // The implementation is intentionally absent in the pre-split tree.
      }
    }
    const buildHost = builder?.buildHost;
    expect(typeof buildHost, 'the production buildHost entry must be importable before HOSTCFG-003 can execute').toBe('function');
    if (typeof buildHost !== 'function') throw new Error('HOSTCFG-003: production buildHost entry is unavailable');

    const directory = await mkdtemp(join(tmpdir(), 'taskshuttle-host-build-'));
    try {
      const hostDirectory = await createHostFixture(directory, 'fixture-build');
      const document = JSON.parse(await readFile(join(hostDirectory, 'host.json'), 'utf8')) as Record<string, unknown>;
      const manifest = await validateHostManifest({
        ...document,
        artifacts: [
          ...(document.artifacts as unknown[]),
          { role: 'runtime-launch', path: 'dist/launch.js', generated: true },
          { role: 'runtime-nanny', path: 'dist/nanny.js', generated: true },
        ],
      }, hostDirectory);
      const pluginBundle = join(directory, 'plugin-bundle');
      const sharedSkills = join(directory, 'shared-skills');
      const legalDirectory = join(directory, 'legal');
      const outputRoot = join(directory, 'output');
      await mkdir(join(pluginBundle, 'dist'), { recursive: true });
      await mkdir(sharedSkills, { recursive: true });
      await mkdir(legalDirectory, { recursive: true });
      await writeFile(join(pluginBundle, 'dist', 'launch.js'), 'export {};');
      await writeFile(join(pluginBundle, 'dist', 'nanny.js'), 'export {};');
      await writeFile(join(sharedSkills, 'README.md'), 'shared');
      await writeFile(join(legalDirectory, 'LICENSE'), 'license');
      await writeFile(join(legalDirectory, 'NOTICE'), 'notice');
      const before = await digestTree(pluginBundle);
      await buildHost(manifest, { pluginBundle, sharedSkills, legalSources: [join(legalDirectory, 'LICENSE'), join(legalDirectory, 'NOTICE')] }, outputRoot);
      expect(await digestTree(pluginBundle)).toBe(before);
      await expect(import('node:fs/promises').then(({ stat }) => stat(join(outputRoot, 'dist', 'launch.js')))).resolves.toBeDefined();
      await expect(import('node:fs/promises').then(({ stat }) => stat(join(outputRoot, 'dist', 'nanny.js')))).resolves.toBeDefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('HOSTCFG-003: the production staging orchestrator builds once and verifies every isolated host', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'taskshuttle-host-stage-'));
    try {
      await mkdir(join(directory, 'hosts'), { recursive: true });
      for (const id of ['first-host', 'second-host', 'third-host', 'fourth-host']) {
        const hostDirectory = await createHostFixture(join(directory, 'hosts'), id);
        const document = JSON.parse(await readFile(join(hostDirectory, 'host.json'), 'utf8')) as Record<string, unknown>;
        await writeFile(join(hostDirectory, 'host.json'), JSON.stringify({
          ...document,
          artifacts: [
            ...(document.artifacts as unknown[]),
            { role: 'runtime-launch', path: 'dist/launch.js', generated: true },
            { role: 'runtime-nanny', path: 'dist/nanny.js', generated: true },
          ],
        }));
      }
      await rm(join(directory, 'hosts', 'second-host'), { recursive: true, force: true });
      await expect(discoverHostManifests(directory)).resolves.toHaveLength(3);
      await expect(discoverHostManifests(directory).then((manifests) => alignHostIds(manifests, ['first-host', 'second-host', 'third-host', 'fourth-host']))).rejects.toThrow(/second-host/u);
      const pluginBundle = join(directory, 'plugin-bundle');
      const sharedSkills = join(directory, 'skills');
      const legalDirectory = join(directory, 'legal');
      await mkdir(join(pluginBundle, 'dist'), { recursive: true });
      await mkdir(sharedSkills, { recursive: true });
      await mkdir(legalDirectory, { recursive: true });
      await writeFile(join(pluginBundle, 'dist', 'launch.js'), 'launch');
      await writeFile(join(pluginBundle, 'dist', 'nanny.js'), 'nanny');
      await writeFile(join(sharedSkills, 'README.md'), 'shared');
      await writeFile(join(legalDirectory, 'LICENSE'), 'license');
      await writeFile(join(legalDirectory, 'NOTICE'), 'notice');
      const before = await digestTree(pluginBundle);
      let pluginBuilds = 0;
      const staged: string[] = [];
      await stageHostBundles({
        root: directory,
        buildPluginBundle: async () => { pluginBuilds += 1; return pluginBundle; },
        sharedSkills,
        legalSources: [join(legalDirectory, 'LICENSE'), join(legalDirectory, 'NOTICE')],
        assertBundleUnchanged: async (hostId, bundle) => {
          staged.push(hostId);
          expect(await digestTree(bundle)).toBe(before);
        },
      });
      expect(pluginBuilds).toBe(1);
      expect(staged).toEqual(['first-host', 'fourth-host', 'third-host']);
      for (const id of staged) {
        await expect(import('node:fs/promises').then(({ stat }) => stat(join(directory, 'hosts', id, 'dist', 'launch.js')))).resolves.toBeDefined();
        await expect(import('node:fs/promises').then(({ stat }) => stat(join(directory, 'hosts', id, 'dist', 'nanny.js')))).resolves.toBeDefined();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('HOSTCFG-002: every host deploy driver uses the typed effect context and preserves shared skills', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'taskshuttle-host-deploy-'));
    try {
      const repository = join(directory, 'repository');
      const home = join(directory, 'home');
      await mkdir(join(repository, 'skills', 'console-open'), { recursive: true });
      await mkdir(join(repository, 'skills', 'delegate-workers'), { recursive: true });
      await mkdir(join(repository, 'hosts', 'kimi'), { recursive: true });
      await writeFile(join(repository, 'skills', 'console-open', 'SKILL.md'), 'console');
      await writeFile(join(repository, 'skills', 'delegate-workers', 'SKILL.md'), 'delegate');
      await writeFile(join(repository, 'hosts', 'kimi', 'host.json'), '{}');
      await mkdir(join(home, '.config', 'opencode', 'skills', 'operator-owned'), { recursive: true });
      await writeFile(join(home, '.config', 'opencode', 'skills', 'operator-owned', 'SKILL.md'), 'operator');
      await mkdir(join(home, '.config', 'opencode'), { recursive: true });
      await writeFile(join(home, '.config', 'opencode', 'opencode.json'), '{}');
      await mkdir(join(home, '.kimi-code', 'plugins'), { recursive: true });
      await writeFile(join(home, '.kimi-code', 'plugins', 'installed.json'), JSON.stringify({ plugins: [{ id: 'taskshuttle', enabled: true }] }));
      const manifests = await discoverHostManifests(root);
      for (const manifest of manifests) {
        const module = await import(pathToFileURL(join(root, 'hosts', manifest.id, manifest.driver)).href) as { default?: { deploy?: (context: HostDeployContext) => Promise<{ status: string }> } };
        if (module.default?.deploy === undefined) continue;
        const result = await module.default.deploy(await fakeDeploymentContext(manifest, repository, home, false));
        expect(result.status, `${manifest.id} deploy driver must be executable through its typed context`).not.toBe('skipped');
      }

      const opencode = (await import(pathToFileURL(join(root, 'hosts', 'opencode', 'driver.ts')).href) as { default: { deploy?: (context: HostDeployContext) => Promise<{ status: string }> } }).default;
      if (opencode.deploy === undefined) throw new Error('OpenCode driver has no deploy implementation');
      await opencode.deploy(await fakeDeploymentContext((manifests.find((manifest) => manifest.id === 'opencode'))!, repository, home, false));
      const config = JSON.parse(await readFile(join(home, '.config', 'opencode', 'opencode.json'), 'utf8')) as { mcp?: { taskshuttle?: unknown } };
      expect(config.mcp?.taskshuttle).toEqual({ type: 'local', command: ['taskshuttle-launch'] });
      await expect(readFile(join(home, '.config', 'opencode', 'skills', 'console-open', 'SKILL.md'), 'utf8')).resolves.toBe('console');
      await expect(readFile(join(home, '.config', 'opencode', 'skills', 'delegate-workers', 'SKILL.md'), 'utf8')).resolves.toBe('delegate');
      await expect(readFile(join(home, '.config', 'opencode', 'skills', 'operator-owned', 'SKILL.md'), 'utf8')).resolves.toBe('operator');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('HOSTCFG-004: a valid fifth host is discovered but refused by support alignment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'taskshuttle-fifth-host-'));
    try {
      const manifestDirectory = await createHostFixture(directory, 'fifth-host');
      const manifest = JSON.parse(await readFile(join(manifestDirectory, 'host.json'), 'utf8')) as HostManifest;
      expect(() => assertSupportAlignment([manifest])).toThrow(/not in the frozen support matrix/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
