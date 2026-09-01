import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { discoverHostArtifactSpecs, NANNY_HOOK_ENTRY, SHARED_SKILL, STAGED_RUNTIME_ENTRIES, type HostArtifactSpec, type HostArtifactValidationContext, type HostDriver, type HostManifest } from '@taskshuttle/host-kit';
import { capabilityIsKnownBroken, KNOWN_BROKEN_CAPABILITIES, verificationState, VERIFIED_ENGINES } from '../packages/plugin/src/engine-support.js';
import { engineVerification, loadKnownDefects, staleDefects } from '../packages/plugin/src/known-defects.js';
import { WRAPPER_PINS } from '../packages/plugin/src/wrapper-pins.js';
import { resolvePluginDist, resolvePluginPackageRoot } from './plugin-artifact-path.js';

export type HostId = string;
export type { HostArtifactSpec } from '@taskshuttle/host-kit';
export { discoverHostArtifactSpecs, NANNY_HOOK_ENTRY, SHARED_SKILL, STAGED_RUNTIME_ENTRIES } from '@taskshuttle/host-kit';
export interface ArtifactIssue { readonly path: string; readonly message: string; }
function hasAbsolutePath(value: unknown): boolean {
  if (typeof value === 'string') return isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value);
  if (Array.isArray(value)) return value.some(hasAbsolutePath);
  if (typeof value === 'object' && value !== null) return Object.values(value).some(hasAbsolutePath);
  return false;
}
function hasEscapingRelativePath(value: unknown): boolean {
  if (typeof value === 'string') return value.split(/[\\/]/u).includes('..');
  if (Array.isArray(value)) return value.some(hasEscapingRelativePath);
  if (typeof value === 'object' && value !== null) return Object.values(value).some(hasEscapingRelativePath);
  return false;
}
async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path, 'utf8')) as unknown; }
async function findFiles(directory: string, predicate: (name: string) => boolean): Promise<string[]> {
  const results: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await findFiles(path, predicate));
    else if (entry.isFile() && predicate(entry.name)) results.push(path);
  }
  return results;
}
async function discoverMarketplacePayloads(root: string): Promise<string[]> {
  const marketplaceRoot = join(root, 'marketplaces');
  return (await findFiles(marketplaceRoot, (name) => name === 'host.json'))
    .map((path) => {
      const rel = relative(root, path).split('/');
      return rel.length >= 4 && rel[0] === 'marketplaces' && rel[2] === 'plugins' && rel[3] === 'taskshuttle'
        ? join('marketplaces', rel[1]!, 'plugins', 'taskshuttle') : undefined;
    })
    .filter((path): path is string => path !== undefined)
    .filter((path, index, all) => all.indexOf(path) === index);
}
async function discoverMarketplaceMetadata(root: string): Promise<string[]> {
  return findFiles(join(root, 'marketplaces'), (name) => name === 'marketplace.json');
}
async function digestOf(path: string): Promise<string | undefined> {
  try { return createHash('sha256').update(await readFile(path)).digest('hex'); } catch { return undefined; }
}

async function hostArtifactDriver(spec: HostArtifactSpec, root: string): Promise<HostDriver | undefined> {
  try {
    const module = await import(pathToFileURL(join(root, spec.directory, spec.hostManifest.driver)).href) as { default?: HostDriver };
    if (module.default === undefined || module.default.id !== spec.host) return undefined;
    return module.default;
  } catch {
    return undefined;
  }
}
function versionOf(value: unknown): unknown { return typeof value === 'object' && value !== null ? (value as { version?: unknown }).version : undefined; }
/**
 * `*.js` arguments must resolve inside the host package. A leading
 * `${HOST_PLUGIN_ROOT}` placeholder *is* the package root, so it is stripped
 * before the existence check.
 */
function relativeScriptArgs(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  const servers = (value as { mcpServers?: Record<string, { args?: unknown }> }).mcpServers ?? {};
  const args: string[] = [];
  for (const server of Object.values(servers)) {
    if (!Array.isArray(server?.args)) continue;
    for (const arg of server.args) {
      if (typeof arg !== 'string' || !arg.endsWith('.js') || isAbsolute(arg)) continue;
      args.push(arg.replace(/^\$\{[A-Z_]+\}[\\/]/u, ''));
    }
  }
  return args;
}
function mcpConfigValid(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('mcpServers' in value)) return false;
  const servers = (value as { mcpServers?: unknown }).mcpServers;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return false;
  return Object.values(servers).every((server) => {
    if (typeof server !== 'object' || server === null) return false;
    const candidate = server as { command?: unknown; args?: unknown; cwd?: unknown; url?: unknown; env?: unknown; headers?: unknown };
    return typeof candidate.command === 'string' && Array.isArray(candidate.args) && candidate.args.every((arg) => typeof arg === 'string') && (candidate.cwd === undefined || typeof candidate.cwd === 'string') && candidate.url === undefined && candidate.env === undefined && candidate.headers === undefined;
  });
}
/** claude-code and codex both read their plugin's hooks from this path. */
/** Validate release structure without invoking host CLIs or writing user config. */
export async function validateHostArtifacts(rootDirectory: string): Promise<ArtifactIssue[]> {
  const root = resolve(rootDirectory); const issues: ArtifactIssue[] = [];
  const pluginRoot = resolvePluginPackageRoot(root);
  const pluginDist = resolvePluginDist(root);
  const specs = await discoverHostArtifactSpecs(root).catch((cause) => {
    issues.push({ path: 'hosts/', message: `host manifest discovery failed: ${cause instanceof Error ? cause.message : String(cause)}` });
    return [] as HostArtifactSpec[];
  });
  const pluginDigests: Record<string, string | undefined> = {};
  for (const entry of STAGED_RUNTIME_ENTRIES) pluginDigests[entry] = await digestOf(join(pluginRoot, entry));
  // Every file, not only `.js`: assets Realm loads by path (`supervisor.mjs`,
  // pi's `shim.mjs`, the `permission-gate.ts` pi is handed as `--extension`) are
  // part of the artifact too, and an extension filter here would keep passing
  // while a host bundle shipped without them (ADR 0009).
  const pluginBundleFiles = (await readdir(pluginDist, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile()).map((entry) => entry.name);
  const rootSkill = await digestOf(join(root, SHARED_SKILL));
  const packageManifestPath = join(pluginRoot, 'package.json');
  const packageVersion = versionOf(await readJson(packageManifestPath).catch(() => undefined));
  try {
    // ART-015 / ART-014 (ADR 0041): every runtime entry, not `dist/cli.js`
    // alone. The scan read one file while the change list claimed all three,
    // and an entry nothing scans is an entry a defect ships in.
    for (const entry of ['dist/cli.js', 'dist/launch.js', NANNY_HOOK_ENTRY]) {
      const entryPath = relative(root, join(pluginRoot, entry));
      let bundled: string;
      try { bundled = await readFile(join(pluginRoot, entry), 'utf8'); }
      catch {
        // dist/cli.js absent means the build did not run at all, which is a
        // different sentence from a standalone entry that failed to emit.
        if (entry === 'dist/cli.js') throw new Error('missing');
        issues.push({ path: entryPath, message: 'standalone runtime entry is missing' });
        continue;
      }
      // ART-015: the alternation carries both dependency names through the
      // migration. `runskein` is what this repository imports today; the
      // legacy name stays in the alternation so a bundle that somehow still
      // carries it is caught rather than passing unrecognised —
      // `runskein` is what it will import, and a name absent from the
      // alternation is unbundled silently rather than caught.
      // `\s*` because the old pattern required `from"x"` with no space: real
      // esbuild output has none, so it worked, but a check a space defeats is
      // a check that depends on someone else's formatter.
      if (/from\s*["'](?:realm-node|runskein|@modelcontextprotocol\/|zod)/u.test(bundled)) {
        issues.push({ path: entryPath, message: 'production bundle contains an unbundled workspace/runtime import' });
      }
      // ART-014: a runtime `createRequire(...)(...)` whose specifier is
      // relative resolves beside the *source* file, not beside the bundle, so
      // the artifact throws MODULE_NOT_FOUND at load. The predicate is the
      // argument, not the call: `createRequire(import.meta.url)('node:sqlite')`
      // in `plugin-transcript-store.ts` is legitimate and must keep passing.
      // Upstream shipped exactly this shape in a release because no check
      // looked for it.
      if (/createRequire\([^)]*\)\s*\(\s*["'`]\.{1,2}\//u.test(bundled)) {
        issues.push({ path: entryPath, message: 'bundle loads a relative path at runtime through createRequire' });
      }
    }
  } catch { issues.push({ path: relative(root, join(pluginRoot, 'dist/cli.js')), message: 'production bundle is missing; run build before artifact gate' }); }
  // Path-loaded assets have to be self-contained. They are not imported by the
  // bundle, so nothing inlines their dependencies, and their bare specifiers
  // resolve against whatever `node_modules` happens to sit above wherever the
  // artifact was installed — which is why a copied `shim.mjs` started `pi` in
  // this repository and killed it with `ERR_MODULE_NOT_FOUND` in an install.
  // Existence checks cannot see this: the file is present and broken.
  for (const asset of pluginBundleFiles.filter((file) => file.endsWith('.mjs') || file.endsWith('.cjs'))) {
    const contents = await readFile(join(pluginDist, asset), 'utf8').catch(() => undefined);
    if (contents === undefined) continue;
    const specifiers = new Set<string>();
    for (const match of contents.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/gu)) {
      const specifier = match[1];
      if (specifier !== undefined && !specifier.startsWith('.') && !specifier.startsWith('node:')) specifiers.add(specifier);
    }
    if (specifiers.size > 0) {
      issues.push({ path: relative(root, join(pluginDist, asset)), message: `runtime asset loaded by path imports ${[...specifiers].join(', ')}; it must be bundled, because nothing resolves those where it is installed` });
    }
  }
  try {
    const launch = await readFile(join(pluginDist, 'launch.js'), 'utf8');
    if (!launch.includes('orphan') || !launch.includes('TASKSHUTTLE_ORPHAN_FILE') || !launch.includes('umask')) issues.push({ path: relative(root, join(pluginDist, 'launch.js')), message: 'launch shim must write an orphan marker and enforce private umask' });
  } catch { /* reported with the bundled entries above */ }
  try {
    const packageManifest = await readJson(packageManifestPath) as { dependencies?: unknown; scripts?: unknown; bin?: unknown };
    const manifestIssuePath = packageManifestPath.slice(root.length + 1);
    if (packageManifest.dependencies !== undefined && typeof packageManifest.dependencies === 'object' && packageManifest.dependencies !== null && Object.keys(packageManifest.dependencies).length > 0) issues.push({ path: manifestIssuePath, message: 'runtime dependencies must be bundled for the standalone artifact' });
    if (typeof packageManifest.scripts === 'object' && packageManifest.scripts !== null && 'prepare' in packageManifest.scripts) issues.push({ path: manifestIssuePath, message: 'standalone artifact must not use an install lifecycle script' });
    if (typeof packageManifest.bin !== 'object' || packageManifest.bin === null || !('taskshuttle-launch' in packageManifest.bin) || !('taskshuttle' in packageManifest.bin)) issues.push({ path: manifestIssuePath, message: 'package must export taskshuttle and taskshuttle-launch binaries' });
  } catch { issues.push({ path: packageManifestPath.slice(root.length + 1), message: 'package manifest is missing or invalid' }); }
  // ART-017: nothing lives under `hosts/` that no spec names. Such a directory
  // is restaged by nothing, validated by nothing, and packed by `files:
  // ["hosts"]` regardless — and because the staged bundles are gitignored, it
  // is invisible to `git status` too. `hosts/opencode/` was exactly this after
  // ADR 0022 stopped staging a package for opencode: a pre-rename bundle that
  // `npm pack` still carried.
  const stagedHosts = new Set(specs.map((spec) => spec.directory));
  for (const entry of await readdir(join(root, 'hosts'), { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const at = join('hosts', entry.name);
    if (!stagedHosts.has(at)) {
      issues.push({ path: at, message: 'host directory matches no staged host spec; it is validated by nothing and packed by files: ["hosts"]' });
    }
  }

  // ART-016 (ADR 0041): the third-party attribution ships, everywhere the
  // bundle does, byte-identical. The staged bundles and the marketplace
  // payloads are distributions in their own right — each inlines the same
  // Apache-2.0 code as the root artifact — so "the root has it" is not the
  // question. What this can assert is what a directory can prove; tarball
  // inclusion is the release preflight's, and that the file matches the build
  // graph is a build-time test's.
  const legalTexts = new Map<string, string>();
  for (const legal of ['NOTICE', 'LICENSE']) {
    try { legalTexts.set(legal, await readFile(join(root, legal), 'utf8')); }
    catch { issues.push({ path: legal, message: 'third-party attribution is missing from the repository root' }); }
  }
  const licenseText = legalTexts.get('LICENSE');
  if (licenseText !== undefined && !/##\s+Third-party software/iu.test(licenseText)) {
    issues.push({ path: 'LICENSE', message: 'third-party section is missing; it is what points a reader at NOTICE' });
  }
  for (const [legal, expected] of legalTexts) {
    for (const spec of specs) {
      const at = join(spec.directory, legal);
      let actual: string;
      try { actual = await readFile(join(root, at), 'utf8'); }
      catch { issues.push({ path: at, message: 'staged bundle is missing its third-party attribution' }); continue; }
      if (actual !== expected) issues.push({ path: at, message: 'third-party attribution differs from the repository root' });
    }
    for (const payload of await discoverMarketplacePayloads(root)) {
      const at = join(payload, legal);
      let actual: string;
      try { actual = await readFile(join(root, at), 'utf8'); }
      catch { issues.push({ path: at, message: 'marketplace payload is missing its third-party attribution' }); continue; }
      if (actual !== expected) issues.push({ path: at, message: 'third-party attribution differs from the repository root' });
    }
  }

  // A staged marketplace is a distribution root, not a scratch directory:
  // leftovers can make a host install resolve an older plugin beside the one
  // just validated. Only the declared payload directory is permitted.
  for (const marketplaceRoot of await readdir(join(root, 'marketplaces'), { withFileTypes: true }).catch(() => [])) {
    if (!marketplaceRoot.isDirectory()) continue;
    const parent = join('marketplaces', marketplaceRoot.name, 'plugins');
    try {
      for (const entry of await readdir(join(root, parent))) {
        if (entry !== 'taskshuttle') issues.push({ path: `${parent}/${entry}`, message: 'marketplace payload directory matches no marketplace entry' });
      }
    } catch { /* metadata checks below report missing marketplace roots */ }
  }

  for (const marketplacePath of await discoverMarketplaceMetadata(root)) {
    const marketplaceRoot = join(root, relative(root, marketplacePath).split('/').slice(0, 2).join('/'));
    const rel = relative(root, marketplacePath);
    let marketplace: { plugins?: unknown };
    try { marketplace = await readJson(marketplacePath) as { plugins?: unknown }; }
    catch { issues.push({ path: rel, message: 'marketplace metadata is missing or invalid' }); continue; }
    if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1) { issues.push({ path: rel, message: 'marketplace must contain one plugin entry' }); continue; }
    const entry = marketplace.plugins[0] as { source?: unknown };
    const source = typeof entry.source === 'string' ? entry.source : typeof entry.source === 'object' && entry.source !== null ? (entry.source as { path?: unknown }).path : undefined;
    if (typeof source !== 'string' || isAbsolute(source)) { issues.push({ path: rel, message: 'marketplace plugin source must be a relative path inside the marketplace' }); continue; }
    // The published marketplace directory has to be self-contained: a source
    // that escapes it resolves to nothing on the installing machine.
    const resolved = resolve(marketplaceRoot, source);
    if (relative(marketplaceRoot, resolved).startsWith('..')) { issues.push({ path: rel, message: 'marketplace plugin source escapes the marketplace directory' }); continue; }
    const required = ['dist/launch.js', NANNY_HOOK_ENTRY];
    try {
      const host = await readJson(join(resolved, 'host.json')) as HostManifest;
      // Release authority comes only from the explicit manifest field; an
      // artifact role is descriptive and must not be promoted by inference.
      const packagePath = host.versionedManifest;
      if (packagePath !== undefined) required.push(packagePath);
      for (const artifact of host.artifacts) if (artifact.role === 'stop-hook') required.push(artifact.path);
    } catch { /* the missing host manifest is reported by the payload check itself */ }
    for (const entry of required) {
      try { await stat(join(resolved, entry)); } catch { issues.push({ path: relative(root, join(resolved, entry)), message: 'marketplace plugin payload is incomplete' }); }
    }
  }
  try {
    const release = await readJson(join(root, 'release/metadata.json')) as { realmVersion?: unknown; hosts?: unknown; wrappers?: unknown; engines?: unknown; verification?: unknown };
    if (typeof release.realmVersion !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/u.test(release.realmVersion)) issues.push({ path: 'release/metadata.json', message: 'Realm version is required' });
    const realmVersion = typeof release.realmVersion === 'string' ? release.realmVersion : '';
    if (typeof release.hosts !== 'object' || release.hosts === null || typeof release.wrappers !== 'object' || release.wrappers === null) issues.push({ path: 'release/metadata.json', message: 'host and wrapper baseline metadata is required' });
    else {
      // Provenance must describe what the runtime actually launches.
      const wrappers = release.wrappers as Record<string, unknown>;
      for (const [wrapper, version] of Object.entries(WRAPPER_PINS)) {
        if (wrappers[wrapper] !== version) issues.push({ path: 'release/metadata.json', message: `wrapper ${wrapper} must record the pinned version ${version}` });
      }
      // A known defect names the component version it was observed at. Bumping
      // that component without revisiting the entry would leave the support
      // matrix asserting a defect nobody re-checked, so pin the two together.
      // VERIFIED_ENGINES is a hand-kept copy of verification.engines, because a
      // bundled dist/ entry has no reliable path back to the metadata file. The
      // copy is only safe while something proves it still matches.
      const recorded = engineVerification(release.verification);
      for (const [engine, state] of Object.entries(recorded)) {
        const runtime = verificationState(engine);
        if (runtime !== state) issues.push({ path: 'packages/plugin/src/engine-support.ts', message: `VERIFIED_ENGINES reports ${engine} as ${runtime} but release/metadata.json records ${state}` });
      }
      for (const engine of Object.keys(VERIFIED_ENGINES)) {
        if (!Object.hasOwn(recorded, engine)) issues.push({ path: 'release/metadata.json', message: `verification.engines has no entry for ${engine}, which VERIFIED_ENGINES declares` });
      }
      const { defects, problems } = loadKnownDefects(release.verification);
      // KNOWN_BROKEN_CAPABILITIES is the runtime half of the same record, for
      // the same reason VERIFIED_ENGINES is: dist/ cannot read this file.
      for (const defect of defects) {
        if (!capabilityIsKnownBroken(defect.engine, defect.capability)) {
          issues.push({ path: 'packages/plugin/src/engine-support.ts', message: `KNOWN_BROKEN_CAPABILITIES is missing ${defect.engine} ${defect.capability}, which release/metadata.json records` });
        }
      }
      for (const entry of KNOWN_BROKEN_CAPABILITIES) {
        if (!defects.some((defect) => defect.engine === entry.engine && defect.capability === entry.capability)) {
          issues.push({ path: 'release/metadata.json', message: `KNOWN_BROKEN_CAPABILITIES declares ${entry.engine} ${entry.capability} with no matching knownDefects entry` });
        }
      }
      for (const problem of problems) issues.push({ path: 'release/metadata.json', message: problem.message });
      // Wrappers *and* engine binaries: a defect whose component appears in
      // neither baseline can never go stale on that dimension, and an entry
      // that cannot expire is the failure this check exists to prevent — `pi`
      // owns its own defect, so pinning it to the wrapper baseline alone would
      // leave it standing forever on that dimension. ADR 0026 adds a second, independent
      // dimension: each entry names the Realm version it was last observed
      // under, so a bump of the top-level `realmVersion` expires it even when
      // its component sat still — the gap that let ENG-FORK-001-pi age four
      // recorded pins unnoticed. One message per expired dimension, because
      // "re-run the case" is not actionable unless the reader can see what
      // expired.
      const componentBaselines = { ...wrappers, ...(typeof release.engines === 'object' && release.engines !== null ? release.engines as Record<string, unknown> : {}) };
      for (const { defect, componentExpired, realmExpired } of staleDefects(defects, componentBaselines, realmVersion)) {
        if (componentExpired) issues.push({ path: 'release/metadata.json', message: `known defect ${defect.id} was observed at ${defect.component} ${defect.componentVersion} but the baseline now records ${String(componentBaselines[defect.component])}; re-run the case and update or retire the entry` });
        if (realmExpired) issues.push({ path: 'release/metadata.json', message: `known defect ${defect.id} was last observed under runskein ${defect.realmVersion} but this release records ${realmVersion}; re-run the case and update or retire the entry` });
      }
    }
  } catch { issues.push({ path: 'release/metadata.json', message: 'release provenance metadata is missing or invalid' }); }
  for (const spec of specs) {
    const directory = join(root, spec.directory); const manifest = join(directory, spec.manifest);
    try { if (!(await stat(directory)).isDirectory()) throw new Error('not a directory'); } catch { issues.push({ path: spec.directory, message: 'host artifact directory is missing' }); continue; }
    let value: unknown = undefined;
    if (spec.manifest !== '') {
      try { value = await readJson(manifest); } catch { issues.push({ path: relative(root, manifest), message: 'manifest is missing or invalid JSON' }); continue; }
      if (hasAbsolutePath(value)) issues.push({ path: relative(root, manifest), message: 'manifest contains an absolute path' });
      if (hasEscapingRelativePath(value)) issues.push({ path: relative(root, manifest), message: 'manifest contains a path escaping its package root' });
      if (spec.kind === 'managed-plugin' && (typeof value !== 'object' || value === null || (value as { scope?: unknown }).scope !== 'user')) issues.push({ path: relative(root, manifest), message: 'managed host artifact must declare user scope only' });
      if (typeof value === 'object' && value !== null && (!('name' in value) || typeof (value as { name?: unknown }).name !== 'string')) issues.push({ path: relative(root, manifest), message: 'manifest name is required' });
      else if (typeof value === 'object' && value !== null && (value as { name?: unknown }).name !== 'taskshuttle') issues.push({ path: relative(root, manifest), message: 'manifest name must be taskshuttle' });
      if (versionOf(value) !== undefined && versionOf(value) !== packageVersion) issues.push({ path: relative(root, manifest), message: `manifest version must match the package version ${String(packageVersion)}` });
    }
    if (spec.transport === 'stdio-mcp') {
      const mcp = join(directory, '.mcp.json');
      try {
        const mcpValue = await readJson(mcp);
        if (!mcpConfigValid(mcpValue)) issues.push({ path: relative(root, mcp), message: 'MCP config must use command/args stdio entries only' });
        else if (hasAbsolutePath(mcpValue) || hasEscapingRelativePath(mcpValue)) issues.push({ path: relative(root, mcp), message: 'MCP config contains an unsafe path' });
        else for (const arg of relativeScriptArgs(mcpValue)) {
          try { await stat(join(directory, arg)); } catch { issues.push({ path: relative(root, mcp), message: `MCP config references a missing bundled entry: ${arg}` }); }
        }
      } catch { issues.push({ path: relative(root, mcp), message: 'MCP config is missing or invalid JSON' }); }
      try { await stat(join(directory, 'dist/launch.js')); } catch { issues.push({ path: relative(root, directory), message: 'host artifact is missing its bundled launch entry' }); }
    }
    // A staged host bundle that drifts from the root build ships code nobody tested.
    for (const entry of STAGED_RUNTIME_ENTRIES) {
      const staged = await digestOf(join(directory, entry));
      if (staged === undefined) { issues.push({ path: relative(root, join(directory, entry)), message: 'staged runtime entry is missing' }); continue; }
      if (pluginDigests[entry] !== undefined && staged !== pluginDigests[entry]) issues.push({ path: relative(root, join(directory, entry)), message: 'staged runtime entry differs from the current Plugin package build' });
    }
    const stagedChunks = (await readdir(join(directory, 'dist'), { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile()).map((entry) => entry.name);
    for (const file of stagedChunks) {
      if (!pluginBundleFiles.includes(file)) { issues.push({ path: relative(root, join(directory, 'dist', file)), message: 'stale bundle file from an earlier build' }); continue; }
      const staged = await digestOf(join(directory, 'dist', file));
      if (staged !== await digestOf(join(pluginDist, file))) issues.push({ path: relative(root, join(directory, 'dist', file)), message: 'staged bundle file differs from the current Plugin package build' });
    }
    for (const file of pluginBundleFiles) {
      if (!stagedChunks.includes(file)) issues.push({ path: relative(root, join(directory, 'dist', file)), message: 'staged bundle is missing a file from the current build' });
    }
    // Host-specific artifact rules live with the host driver. Core validates
    // only shared staging invariants and passes the parsed stop-hook/plugin
    // manifest into the driver's pure validator.
    const driver = await hostArtifactDriver(spec, root);
    if (driver?.validateArtifacts !== undefined) {
      const hookArtifact = spec.hostManifest.artifacts.find((artifact) => artifact.role === 'stop-hook');
      let validatorValue = value;
      let validatorPath = relative(root, manifest);
      if (hookArtifact !== undefined && hookArtifact.path.endsWith('hooks/hooks.json')) {
        validatorPath = relative(root, join(directory, hookArtifact.path));
        try { validatorValue = await readJson(join(directory, hookArtifact.path)); }
        catch { issues.push({ path: validatorPath, message: 'host artifact is missing its Stop hook registration' }); validatorValue = undefined; }
      }
      if (validatorValue !== undefined) {
        const context: HostArtifactValidationContext = {
          manifest: spec.hostManifest,
          roots: { repository: root, host: directory, output: directory },
          artifactManifest: validatorValue,
          artifactManifestPath: validatorPath,
          nannyHookEntry: NANNY_HOOK_ENTRY,
        };
        issues.push(...driver.validateArtifacts(context));
      }
    }
    const skill = await digestOf(join(directory, SHARED_SKILL));
    if (skill === undefined) issues.push({ path: relative(root, join(directory, SHARED_SKILL)), message: 'host artifact is missing the shared orchestration skill' });
    else if (rootSkill !== undefined && skill !== rootSkill) issues.push({ path: relative(root, join(directory, SHARED_SKILL)), message: 'host skill differs from the shared source skill' });
  }
  return issues;
}
