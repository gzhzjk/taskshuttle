import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ts from 'typescript';
import { discoverHostManifests } from '@taskshuttle/host-kit';
import { discoverVersionedManifests } from './release-manifests.mjs';

const exec = promisify(execFile);

export interface SeparationArtifactIssue {
  path: string;
  message: string;
}

interface HostProjectionCheckInput {
  expectedHostIds: readonly string[];
  manifests: ReadonlyArray<{ id: string; baseline: string }>;
  metadataHosts: Record<string, string>;
  verificationHosts: Record<string, unknown>;
}

const ENGINE_ID_TYPES = new Set(['EngineId', 'FrozenEngineId']);

function hasEngineIdType(node: ts.Node | undefined): boolean {
  if (node === undefined) return false;
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(current) && ENGINE_ID_TYPES.has(current.text)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

interface HostIdOccurrence {
  id: string;
  node: ts.Node;
}

function hostIdOccurrences(node: ts.ArrayLiteralExpression | ts.ObjectLiteralExpression, hostIds: readonly string[]): HostIdOccurrence[] {
  const occurrences = new Map<ts.Node, string>();
  const visit = (current: ts.Node): void => {
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
      if (hostIds.includes(current.text)) occurrences.set(current, current.text);
    }
    if ((ts.isPropertyAssignment(current) || ts.isMethodDeclaration(current))
      && (ts.isIdentifier(current.name) || ts.isStringLiteral(current.name))
      && hostIds.includes(current.name.text)) {
      occurrences.set(current.name, current.name.text);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return [...occurrences].map(([occurrence, id]) => ({ id, node: occurrence }));
}

// Engine registries are allowed to contain the same four strings as hosts, but
// only when their syntax says so. This keeps the detector independent of local
// variable names while still allowing a new host table to be caught if it is
// renamed to resemble an engine projection.
function isEngineSignalledOccurrence(occurrence: ts.Node, collection: ts.Node): boolean {
  let cursor: ts.Node | undefined = occurrence.parent;
  while (cursor !== undefined) {
    if ((ts.isPropertyAssignment(cursor) || ts.isMethodDeclaration(cursor))
      && ts.isIdentifier(cursor.name)
      && /^(?:engine|engineId)$/iu.test(cursor.name.text)) return true;
    if ((ts.isAsExpression(cursor) || ts.isSatisfiesExpression(cursor) || ts.isTypeAssertionExpression(cursor))
      && hasEngineIdType(cursor.type)) return true;
    if (ts.isVariableDeclaration(cursor)) {
      if (ts.isIdentifier(cursor.name) && /engine/iu.test(cursor.name.text)) return true;
      if (hasEngineIdType(cursor.type)) return true;
    }
    cursor = cursor === collection ? collection.parent : cursor.parent;
  }
  return false;
}

/** Detect a central host/artifact collection from its AST, regardless of local naming. */
export function containsCentralHostList(source: string, hostIds: readonly string[] = []): boolean {
  const sourceFile = ts.createSourceFile('artifact-boundary.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // This symbol is the pre-split central artifact table even when the file
    // imports it rather than spelling out the host IDs locally.
    if (ts.isIdentifier(node) && node.text === 'hostArtifactSpecs') {
      found = true;
      return;
    }
    if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) {
      const occurrences = hostIdOccurrences(node, hostIds);
      const hasAtLeastTwoIds = new Set(occurrences.map(({ id }) => id)).size >= 2;
      const everyOccurrenceIsEngineSignalled = occurrences.length > 0
        && occurrences.every(({ node: occurrence }) => isEngineSignalledOccurrence(occurrence, node));
      if (hasAtLeastTwoIds && !everyOccurrenceIsEngineSignalled) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * Compare discovered host baselines with the release projection that travels.
 *
 * The specification's §4.1 table is the other checked projection and is **not**
 * compared here: it is an internal document, and this gate runs in the release
 * repository where it does not exist (ADR 0056). The maintainers' own
 * spec-projection gate owns that comparison, in both directions, and runs only
 * on their side.
 */
export function checkHostProjectionAlignment(input: HostProjectionCheckInput): SeparationArtifactIssue[] {
  const issues: SeparationArtifactIssue[] = [];
  const expected = new Set(input.expectedHostIds);
  const manifestById = new Map(input.manifests.map((manifest) => [manifest.id, manifest]));

  for (const id of input.expectedHostIds) {
    const metadataBaseline = input.metadataHosts[id];
    if (typeof metadataBaseline !== 'string') {
      issues.push({ path: 'release/metadata.json', message: `ART-023: release/metadata.json has no baseline for supported host '${id}'` });
    }
    if (!(id in input.verificationHosts) || typeof input.verificationHosts[id] !== 'boolean') {
      issues.push({ path: 'release/metadata.json', message: `ART-023: verification.hosts has no boolean row for supported host '${id}'` });
    }

    const manifest = manifestById.get(id);
    if (manifest !== undefined && typeof metadataBaseline === 'string' && manifest.baseline !== metadataBaseline) {
      issues.push({ path: `hosts/${id}/host.json`, message: `ART-023: host manifest baseline ${manifest.baseline} does not match release/metadata.json ${metadataBaseline}` });
    }
  }

  for (const id of Object.keys(input.metadataHosts)) {
    if (!expected.has(id)) issues.push({ path: 'release/metadata.json', message: `ART-023: release/metadata.json has an unsupported host projection '${id}'` });
  }
  for (const id of Object.keys(input.verificationHosts)) {
    if (!expected.has(id)) issues.push({ path: 'release/metadata.json', message: `ART-023: verification.hosts has an unsupported host row '${id}'` });
  }
  for (const manifest of input.manifests) {
    if (!expected.has(manifest.id)) issues.push({ path: `hosts/${manifest.id}/host.json`, message: `ART-023: discovered host '${manifest.id}' has no frozen support projection` });
  }
  return issues;
}

function projectionCheckerMutationPasses(): boolean {
  const baseline = '1.0.0';
  const knownHostIds = ['codex', 'claude-code', 'opencode', 'kimi'];
  const input: HostProjectionCheckInput = {
    expectedHostIds: knownHostIds,
    manifests: knownHostIds.map((id) => ({ id, baseline })),
    metadataHosts: Object.fromEntries(knownHostIds.map((id) => [id, baseline])),
    verificationHosts: Object.fromEntries(knownHostIds.map((id) => [id, false])),
  };
  const mutation = checkHostProjectionAlignment({
    ...input,
    metadataHosts: { ...input.metadataHosts, codex: '2.0.0' },
  });
  // The table half of this assertion moved with the check: the mismatch that
  // stays here is manifest against release/metadata.json, which both travel.
  return mutation.some((issue) => issue.path === 'hosts/codex/host.json');
}

function hostListDetectorMutationPasses(): boolean {
  const knownHostIds = ['codex', 'claude-code', 'opencode', 'kimi'];
  const renamed = "const HOSTS = ['codex', 'claude-code', 'opencode', 'kimi']; for (const host of HOSTS) use(host);";
  const long = `const SPECS = [{ host: 'codex', payload: '${'x'.repeat(1_200)}' }, { host: 'claude-code' }];`;
  const engineValues = "const engineValues = { codex: 30, 'claude-code': 45, opencode: 20 };";
  const engineAssignments = "const assignments = [{ engine: 'opencode' as EngineId }, { engine: 'kimi' as EngineId }];";
  const frozenIds = "const FROZEN_ENGINE_IDS = ['codex', 'claude-code', 'opencode', 'kimi'];";
  const typedCli = "const CLI_FOR: Record<FrozenEngineId, string> = { codex: 'codex', 'claude-code': 'claude', opencode: 'opencode', kimi: 'kimi' };";
  const hostTableWithRenamedBinding = "const CLI_FOR = [{ id: 'codex', directory: 'hosts/codex' }, { id: 'kimi', directory: 'hosts/kimi' }];";
  return containsCentralHostList(renamed, knownHostIds)
    && containsCentralHostList(long, knownHostIds)
    && !containsCentralHostList(engineValues, knownHostIds)
    && !containsCentralHostList(engineAssignments, knownHostIds)
    && !containsCentralHostList(frozenIds, knownHostIds)
    && !containsCentralHostList(typedCli, knownHostIds)
    && containsCentralHostList(hostTableWithRenamedBinding, knownHostIds)
    && containsCentralHostList("import { hostArtifactSpecs } from './host-artifacts.js'; for (const spec of hostArtifactSpecs) use(spec);", knownHostIds);
}

const describe = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

/** Execute the package/host artifact checks introduced by Phase 2. */
export async function separationArtifactGate(root: string): Promise<SeparationArtifactIssue[]> {
  const issues: SeparationArtifactIssue[] = [];
  const rootPackagePath = join(root, 'package.json');
  const corePackagePath = join(root, 'packages', 'core', 'package.json');
  const pluginPackagePath = join(root, 'packages', 'plugin', 'package.json');
  const rollbackManifest = join(root, 'test', 'fixtures', 'rollback', 'manifest.json');
  const packageJson = JSON.parse(await readFile(rootPackagePath, 'utf8')) as { private?: boolean };

  if (packageJson.private !== true) issues.push({ path: rootPackagePath, message: 'ART-022: repository root must be private and non-publishable after package extraction' });
  if (!existsSync(corePackagePath)) {
    issues.push({ path: 'packages/core', message: 'ART-021: @taskshuttle/core package is missing; build/pack/clean-install gate has no target' });
  } else {
    await checkPackedPackage(root, corePackagePath, '@taskshuttle/core', issues, 'ART-021');
  }
  if (!existsSync(pluginPackagePath)) {
    issues.push({ path: 'packages/plugin', message: 'ART-022: public taskshuttle Plugin package is missing; pack/install gate has no target' });
  } else {
    await checkPackedPackage(root, pluginPackagePath, 'taskshuttle', issues, 'ART-022');
  }
  if (existsSync(rollbackManifest)) {
    const pluginFiles = await listPackedFiles(root, pluginPackagePath).catch(() => []);
    for (const entry of pluginFiles) {
      if (/rollback|release\/.*\.tgz|\.cache/u.test(entry)) issues.push({ path: entry, message: 'ART-022: public Plugin package includes rollback recipe, cache, or tarball bytes' });
    }
  }

  // §4.1 names `hosts/<id>/host.json` the sole hand-edited owner and both the
  // table and release/metadata.json checked projections of it, so the loop is
  // driven by the manifests. It used to be driven by the table, which meant a
  // host that exists in the tree was discovered by reading a document (ADR 0056).
  const discoveredManifests: Array<{ id: string; baseline: string }> = [];
  try {
    const strictManifests = await discoverHostManifests(root);
    discoveredManifests.push(...strictManifests.map((manifest) => ({ id: manifest.id, baseline: manifest.baseline })));
    const strictVersioned = [
      'packages/plugin/package.json',
      ...strictManifests.flatMap((manifest) => manifest.versionedManifest === undefined ? [] : [`hosts/${manifest.id}/${manifest.versionedManifest}`]),
    ].sort();
    let releaseVersioned: string[];
    try {
      releaseVersioned = discoverVersionedManifests(root).sort();
    } catch (cause) {
      issues.push({ path: 'scripts/release-manifests.mjs', message: `ART-023: release manifest discovery failed: ${describe(cause)}` });
      releaseVersioned = [];
    }
    if (releaseVersioned.join('\n') !== strictVersioned.join('\n')) {
      issues.push({ path: 'scripts/release-manifests.mjs', message: 'ART-023: release versioned-manifest discovery diverges from strict host discovery' });
    }
  } catch (cause) {
    issues.push({ path: 'hosts/', message: `ART-023/HOSTCFG-001: host manifest discovery failed: ${describe(cause)}` });
  }
  const hostIds = discoveredManifests.map((manifest) => manifest.id);
  if (hostIds.length === 0) issues.push({ path: 'hosts/', message: 'ART-023/HOSTCFG-001: no host manifest was discovered' });
  // The reverse — a supported host in the §4.1 table with no `host.json` — is
  // the spec-projection gate's, because only it can read the table.
  const productionSourceFiles = [
    ...await sourceFiles(join(root, 'scripts')),
    ...await sourceFiles(join(root, 'packages', 'plugin', 'src')),
    ...await sourceFiles(join(root, 'packages', 'host-kit', 'src')),
  ];
  for (const file of productionSourceFiles) {
    // This checker names the legacy symbols in its detection pattern; it is
    // not a production consumer and must not report its own rule.
    if (file === join(root, 'scripts', 'separation-artifact-gate.ts')) continue;
    const source = await readFile(file, 'utf8');
    if (containsCentralHostList(source, hostIds)) {
      issues.push({ path: file.slice(root.length + 1), message: 'ART-024: production source still depends on a central hard-coded host list' });
    }
  }
  const releaseMetadata = JSON.parse(await readFile(join(root, 'release', 'metadata.json'), 'utf8')) as {
    hosts?: Record<string, string>;
    verification?: { hosts?: Record<string, unknown> };
  };
  if (!hostListDetectorMutationPasses()) {
    issues.push({ path: 'scripts/separation-artifact-gate.ts', message: 'ART-024: host-list detector mutation self-test did not detect a renamed central collection' });
  }
  if (!projectionCheckerMutationPasses()) {
    issues.push({ path: 'scripts/separation-artifact-gate.ts', message: 'ART-023: projection checker mutation self-test did not detect a baseline mismatch' });
  }
  issues.push(...checkHostProjectionAlignment({
    expectedHostIds: hostIds,
    manifests: discoveredManifests,
    metadataHosts: releaseMetadata.hosts ?? {},
    verificationHosts: releaseMetadata.verification?.hosts ?? {},
  }));
  if (!existsSync(rollbackManifest)) issues.push({ path: rollbackManifest, message: 'STO-018: rollback fixture manifest is missing; pin the pre-separation artifact before extraction' });
  return issues;
}

async function checkPackedPackage(root: string, packageJsonPath: string, expectedName: string, issues: SeparationArtifactIssue[], id: string): Promise<void> {
  let manifest: { name?: string; exports?: unknown; bin?: unknown; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try { manifest = JSON.parse(await readFile(packageJsonPath, 'utf8')) as typeof manifest; }
  catch (cause) { issues.push({ path: packageJsonPath, message: `${id}: package manifest is unreadable: ${describe(cause)}` }); return; }
  if (manifest.name !== expectedName) issues.push({ path: packageJsonPath, message: `${id}: package identity must be ${expectedName}, saw ${manifest.name ?? 'missing'}` });
  if (id === 'ART-022' && Object.values(manifest.dependencies ?? {}).some((value) => value.startsWith('workspace:'))) issues.push({ path: packageJsonPath, message: `${id}: public Plugin cannot ship a workspace dependency on private Core` });
  if (Object.keys(manifest.dependencies ?? {}).length > 0) issues.push({ path: packageJsonPath, message: `${id}: runtime dependencies would make the hermetic clean-install gate network-dependent; keep dependencies empty and bundle or inject them` });
  if (id === 'ART-022' && !manifest.bin) issues.push({ path: packageJsonPath, message: `${id}: public Plugin package has no launcher bins` });
  if (!manifest.exports) issues.push({ path: packageJsonPath, message: `${id}: package must declare explicit exports` });
  const packageRoot = resolve(packageJsonPath, '..');
  const packed = await packPackage(root, packageRoot).catch((cause) => {
    issues.push({ path: packageJsonPath, message: `${id}: npm pack/install gate failed: ${describe(cause)}` });
    return undefined;
  });
  if (packed === undefined) return;
  const required = id === 'ART-021'
    ? ['package/dist/index.d.ts']
    : [
      'package/dist/cli.js',
      'package/dist/launch.js',
      'package/dist/nanny.js',
      // npm's root README* auto-inclusion was part of the old public package;
      // stagePluginPackage must keep the bilingual consumer documents visible
      // after the package root moves. The pair is the contract — a third
      // README was required here while `README.reversed.md`, a draft of a
      // rewrite, was staged into the package; it no longer is, and requiring a
      // draft in a published artifact was never the intent.
      'package/README.md',
      'package/README.zh-CN.md',
    ];
  for (const entry of required) if (!packed.files.includes(entry)) issues.push({ path: entry, message: `${id}: packed artifact is missing ${entry}` });
  if (id === 'ART-022') {
    for (const entryPath of ['package/dist/cli.js', 'package/dist/launch.js', 'package/dist/nanny.js']) {
      const entry = await exec('tar', ['-xOzf', packed.tarball, entryPath], { cwd: root }).then((result) => result.stdout).catch(() => '');
      if (/@taskshuttle\/core|packages\/core/u.test(entry)) issues.push({ path: entryPath, message: `${id}: Plugin bundle retains a runtime import of private Core` });
    }
  }
  const installRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-separation-install-'));
  try {
    await exec('npm', ['install', '--ignore-scripts', '--no-package-lock', '--no-save', packed.tarball], { cwd: installRoot });
    const installed = join(installRoot, 'node_modules', expectedName);
    await stat(installed);
    await exec(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(`file://${join(installed, 'dist', 'index.js')}`)})`], { cwd: installRoot });
  } catch (cause) {
    issues.push({ path: packageJsonPath, message: `${id}: clean install or declared export import failed: ${describe(cause)}` });
  } finally {
    await rm(installRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(dirname(packed.tarball), { recursive: true, force: true }).catch(() => undefined);
  }
}

interface PackedPackage { files: string[]; tarball: string; }

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && /\.(?:ts|mts|cts|mjs|cjs)$/u.test(entry.name)) files.push(path);
  }
  return files.sort();
}

async function packPackage(root: string, packageRoot: string): Promise<PackedPackage> {
  const outputRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-separation-pack-'));
  const packed = JSON.parse((await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', outputRoot], { cwd: packageRoot })).stdout) as Array<{ filename?: string }>;
  const filename = packed[0]?.filename;
  if (!filename) { await rm(outputRoot, { recursive: true, force: true }); throw new Error('npm pack returned no tarball'); }
  const tarball = join(outputRoot, filename);
  const listing = (await exec('tar', ['-tzf', tarball], { cwd: root })).stdout;
  const digest = createHash('sha256').update(await readFile(tarball)).digest('hex');
  if (digest.length !== 64) { await rm(outputRoot, { recursive: true, force: true }); throw new Error('packed artifact digest was not computed'); }
  return { files: listing.split('\n').filter(Boolean), tarball };
}

async function listPackedFiles(root: string, packageRoot: string): Promise<string[]> {
  const outputRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-separation-pack-list-'));
  try {
    const packed = JSON.parse((await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', outputRoot], { cwd: packageRoot })).stdout) as Array<{ filename?: string }>;
    const filename = packed[0]?.filename;
    if (!filename) throw new Error('npm pack returned no tarball');
    return (await exec('tar', ['-tzf', join(outputRoot, filename)], { cwd: root })).stdout.split('\n').filter(Boolean);
  } finally { await rm(outputRoot, { recursive: true, force: true }).catch(() => undefined); }
}
