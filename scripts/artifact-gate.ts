#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { discoverHostArtifactSpecs } from '@taskshuttle/host-kit';
import { validateHostArtifacts } from './host-artifacts.js';
import { validateProjectConfig } from '../packages/plugin/src/project-config.js';
import { CONSOLE_CSP } from '../packages/plugin/src/console/server.js';
import { UI_APP_CSS, UI_APP_JS, UI_INDEX_HTML } from '../packages/plugin/src/console/ui-assets.js';
import { verificationState, VERIFIED_ENGINES } from '../packages/plugin/src/engine-support.js';
import { FROZEN_ENGINE_IDS } from '../packages/plugin/src/schemas.js';
import { createTaskShuttleServer } from '../packages/plugin/src/server.js';
import { checkWorkersListIdentity, readToolCatalog, TOOL_CATALOG_PATH } from './tool-catalog.js';
import { separationArtifactGate } from './separation-artifact-gate.js';
import { resolvePluginDist } from './plugin-artifact-path.js';

const exec = promisify(execFile);

/** A thrown value as a gate message reads it. */
const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
const pluginDist = resolvePluginDist(process.cwd());

const issues = await validateHostArtifacts(process.cwd());
const hostSpecs = await discoverHostArtifactSpecs(process.cwd());
// Phase 2 package/host checks are intentionally run here, not from the unit
// suite: ART-021–024 prove clean pack/install and manifest projections against
// the distribution boundary. They are red on the pre-split tree until Phase 4.
issues.push(...await separationArtifactGate(process.cwd()));

// Which Realm was built is now stated by a version, not by a digest of a
// vendored tree. Three places have to agree or the artifact is not what the
// metadata says it is: what we declare, what the meta-package wants, and what
// is actually installed. The Plugin package also declares the meta-package as
// a build-time pin so its bundle recipe cannot silently drift from the root
// composition. A mismatch is silent at runtime — the bundle would carry one
// core and the copied watchdog another — so it is caught here.
const metadata = JSON.parse(await readFile(join(process.cwd(), 'release', 'metadata.json'), 'utf8')) as {
  realmVersion?: string;
};
const recordedVersion = metadata.realmVersion;
const rootManifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
  devDependencies?: Record<string, string>;
};
const pluginManifest = JSON.parse(await readFile(join(process.cwd(), 'packages', 'plugin', 'package.json'), 'utf8')) as {
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
};
const installedCore = (
  JSON.parse(await readFile(join(process.cwd(), 'node_modules', '@runskein', 'core', 'package.json'), 'utf8')) as {
    version?: string;
  }
).version;
const installedMeta = (
  JSON.parse(await readFile(join(process.cwd(), 'node_modules', 'runskein', 'package.json'), 'utf8')) as {
    version?: string;
  }
).version;
if (recordedVersion === undefined) {
  issues.push({ path: 'release/metadata.json', message: 'realmVersion is missing; record the Realm version the artifact was built against' });
} else {
  for (const [what, actual] of [['@runskein/core', installedCore], ['runskein', installedMeta]] as const) {
    if (actual !== recordedVersion) {
      issues.push({
        path: 'release/metadata.json',
        message: `${what} is installed at ${actual ?? 'unknown'} but realmVersion records ${recordedVersion}; run \`pnpm install\` or update the metadata`,
      });
    }
  }
  const declared = rootManifest.devDependencies?.['@runskein/core'];
  if (declared !== recordedVersion) {
    issues.push({
      path: 'package.json',
      message: `devDependencies['@runskein/core'] is ${declared ?? 'absent'} but realmVersion records ${recordedVersion}`,
    });
  }
  const pluginDeclared = pluginManifest.devDependencies?.runskein ?? pluginManifest.dependencies?.runskein;
  if (pluginDeclared !== recordedVersion) {
    issues.push({
      path: 'packages/plugin/package.json',
      message: `runskein build pin is ${pluginDeclared ?? 'absent'} but realmVersion records ${recordedVersion}`,
    });
  }
}


// Console UI self-containment (console-design §7.5/§11): the embedded assets
// must fetch nothing from an external host, and the CSP constant must be
// exactly the §7.5 value — both in source and in the built artifact.
if (CONSOLE_CSP !== "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'") {
  issues.push({ path: 'packages/plugin/src/console/server.ts', message: 'CONSOLE_CSP no longer equals the §7.5 value' });
}
// 'http://www.w3.org/2000/svg' is an XML namespace identifier, never fetched.
for (const [name, asset] of [['index.html', UI_INDEX_HTML], ['app.css', UI_APP_CSS], ['app.js', UI_APP_JS]] as const) {
  const stripped = asset.replaceAll('http://www.w3.org/2000/svg', '');
  if (/https?:\/\//i.test(stripped) || /(?:src|href)\s*=\s*["']\/\//i.test(stripped)) {
    issues.push({ path: `packages/plugin/src/console/ui/${name}`, message: 'embedded console UI references an external host (§7.5 requires self-containment)' });
  }
}
if (/<script(?![^>]*\bsrc=)/i.test(UI_INDEX_HTML) || /<style[\s>]/i.test(UI_INDEX_HTML) || /\sstyle\s*=/i.test(UI_INDEX_HTML)) {
  issues.push({ path: 'packages/plugin/src/console/ui/index.html', message: 'inline script/style in the console UI would violate its own CSP (§7.5)' });
}
// tsup code-splits, so the console server may land in a chunk: the CSP must
// be present somewhere in the built JS, not necessarily in the entry file.
try {
  const distFiles = (await readdir(pluginDist)).filter((entry) => entry.endsWith('.js'));
  const built = (await Promise.all(distFiles.map((entry) => readFile(join(pluginDist, entry), 'utf8')))).join('\n');
  if (!built.includes(CONSOLE_CSP)) issues.push({ path: 'packages/plugin/dist/', message: 'the built artifact does not contain the §7.5 CSP; run pnpm build' });

  // Assets the bundle loads by path instead of importing. The bundler cannot
  // see them, so nothing else would notice their absence until an engine fails
  // to spawn — which is exactly how Realm's `supervise` watchdog went missing
  // and left `claude-code` unable to start from the shipped artifact. The
  // requirement is derived from the built code rather than restated here, so a
  // new asset fails this gate instead of shipping broken.
  const referenced = new Set<string>();
  for (const match of built.matchAll(/new URL\(\s*["'`]\.\/([\w.-]+)["'`]\s*,\s*import\.meta\.url\s*\)/gu)) {
    // `.js` is included: an emitted chunk resolves to itself and costs nothing
    // to assert, while a renamed entry is a real way for this to break.
    if (match[1] !== undefined) referenced.add(match[1]);
  }
  // The shape above is what the current bundler emits, and a matcher that only
  // knows one shape is a gate that goes blind the day minification hoists
  // `import.meta.url` into a variable. These extensions are never produced by
  // bundling, so a `./name.ext` literal in the output can only be a file the
  // runtime expects to find beside itself.
  for (const match of built.matchAll(/["'`]\.\/([\w.-]+\.(?:mjs|cjs|wasm|node))["'`]/gu)) {
    const name = match[1];
    if (name !== undefined) referenced.add(name);
  }
  for (const name of referenced) {
    if (!existsSync(join(pluginDist, name))) {
      issues.push({ path: `packages/plugin/dist/${name}`, message: `the built artifact resolves ./${name} at runtime but the file is not in the public Plugin dist; run pnpm build` });
    }
    for (const spec of hostSpecs) {
      if (!existsSync(join(process.cwd(), spec.directory, 'dist', name))) {
        issues.push({ path: `${spec.directory}/dist/${name}`, message: `${spec.host} ships a bundle that resolves ./${name} at runtime without the file` });
      }
    }
  }
} catch {
  issues.push({ path: 'packages/plugin/dist/', message: 'public Plugin build output is missing; run pnpm build before the artifact gate' });
}

// The worker-defaults template (ADR 0018/0019) ships two ways — npm tarball via
// `files`, staged host bundles via `stage-host-bundles.ts` — and every copy must
// be the conf-template/ source byte-for-byte, or the sample one install reads
// is not the sample another got. It must also pass the runtime's own validator:
// a template that fails validation on first use teaches the operator that the
// file format is broken, not that their edit is. And no engine section may
// carry an empty-string value (ART-012): an empty string is a real value, and
// the fill path would hand it to every session of that engine.
{
  let source: Buffer | undefined;
  try { source = await readFile(join(process.cwd(), 'conf-template', 'default-config.json')); }
  catch { issues.push({ path: 'conf-template/default-config.json', message: 'worker-defaults template is missing from conf-template/' }); }
  if (source !== undefined) {
    let template: unknown;
    try { template = JSON.parse(source.toString('utf8')); }
    catch (error) { issues.push({ path: 'conf-template/default-config.json', message: `worker-defaults template is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }); }
    if (template !== undefined) {
      try { validateProjectConfig(template); }
      catch (error) { issues.push({ path: 'conf-template/default-config.json', message: `worker-defaults template does not validate: ${error instanceof Error ? error.message : String(error)}` }); }
      // ART-012: walk every profile's config and engineConfig sections; an
      // empty-string value anywhere is a defect, not a placeholder.
      const profiles = (template as { profiles?: Record<string, { config?: Record<string, unknown>; engineConfig?: Record<string, Record<string, unknown>> }> }).profiles ?? {};
      for (const [profileName, profile] of Object.entries(profiles)) {
        const patches: Array<[string, Record<string, unknown>]> = [['config', profile.config ?? {}]];
        for (const [engine, section] of Object.entries(profile.engineConfig ?? {})) patches.push([`engineConfig.${engine}`, section]);
        for (const [where, patch] of patches) {
          for (const [key, value] of Object.entries(patch)) {
            if (value === '') issues.push({ path: 'conf-template/default-config.json', message: `template carries an empty-valued key at profiles.${profileName}.${where}.${key}; an empty string is a real value the fill path would apply` });
          }
        }
      }
    }
    const shipped = [
      relative(process.cwd(), join(pluginDist, 'default-config.json')),
      ...hostSpecs.map((spec) => `${spec.directory}/dist/default-config.json`),
    ];
    for (const shippedPath of shipped) {
      const target = join(process.cwd(), shippedPath);
      if (!existsSync(target)) {
        issues.push({ path: shippedPath, message: 'worker-defaults template was not shipped here; run pnpm build' });
      } else if (!(await readFile(target)).equals(source)) {
        issues.push({ path: shippedPath, message: 'shipped worker-defaults template differs from the conf-template/ source; run pnpm build' });
      }
    }
  }
}

// The gate never writes into the operator's real data root.
const gateDataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-plugin-gate-'));
const plugin = createTaskShuttleServer({ dataRoot: gateDataRoot, legacyRoots: [join(gateDataRoot, 'legacy-probe')], env: { ...process.env, REALM_PLUGIN_LOG: 'off' } });
const registered = (plugin.server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools;
if (Object.keys(registered ?? {}).length !== 20) issues.push({ path: 'packages/plugin/src/server.ts', message: 'production MCP server did not register exactly 20 tools' });
const smoke = await plugin.invoke('workers_list', { rescan: false });
if (!smoke.ok || !Array.isArray(smoke.output.workers)) {
  issues.push({ path: 'packages/plugin/src/server.ts', message: 'workers_list runtime smoke did not return a worker list' });
} else {
  // The engine set is open (ADR 0004), so an engine beyond the frozen four is
  // information rather than a failure — it appears marked unverified. What must
  // still hold is that every engine mvp §4.2 requires is reported.
  const workers = smoke.output.workers as Array<{ engine?: unknown; verification?: unknown }>;
  const reported = new Set(workers.map((worker) => String(worker.engine)));
  const missing = FROZEN_ENGINE_IDS.filter((engine) => !reported.has(engine));
  if (missing.length > 0) {
  issues.push({ path: 'packages/plugin/src/server.ts', message: `workers_list runtime smoke did not report the frozen engines; missing ${missing.join(', ')}` });
  }
  // The rewritten tripwire (ADR 0004). It runs here rather than in the simulated
  // harness because only a live plugin has a registry: builtins are just Realm's
  // discovery base layer, and a workspace or installed adapter may override one
  // by id. A support claim naming an engine nothing registers points at nothing.
  const unregisteredVerified = Object.keys(VERIFIED_ENGINES).filter((engine) => verificationState(engine) === 'verified' && !reported.has(engine));
  if (unregisteredVerified.length > 0) {
    issues.push({ path: 'release/metadata.json', message: `verification.engines marks ${unregisteredVerified.join(', ')} verified, but the registry does not report ${unregisteredVerified.length > 1 ? 'them' : 'it'}` });
  }
  // The other half: growth upstream is information, not a failure. An engine the
  // matrix has never covered must surface as `unknown`, never be hidden.
  const mislabelled = workers.filter((worker) => !Object.hasOwn(VERIFIED_ENGINES, String(worker.engine)) && worker.verification !== 'unknown');
  for (const worker of mislabelled) {
  issues.push({ path: 'packages/plugin/src/engine-support.ts', message: `engine ${String(worker.engine)} has no verification record but reports '${String(worker.verification)}' instead of 'unknown'` });
  }
  // ART-018 (ADR 0043). Two documents that must agree and that nothing else
  // here compares: the response is validated against the *published* catalog,
  // not against the Zod schema that produced it, so a field added on one side
  // alone fails instead of shipping green with the count still 20. The id is
  // then compared with the manifest read off disk — the runtime's own copy
  // would agree with the response under any consistent lie. This plugin runs
  // with no console; the console-enabled half is
  // `test/core/workers-list-identity.test.ts`, which needs a listener the gate
  // has no reason to open.
  const manifestPath = join(gateDataRoot, 'instances', plugin.runtime.instanceId, 'instance.json');
  // Two reads, two `catch`es. One `try` around both would report a broken
  // catalog as an unreadable manifest, which is the rule ADR 0027 states about
  // error codes applied to a gate message: a message that names a component is
  // a claim about where the fault was.
  let manifestInstanceId: string | undefined;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { instanceId?: unknown };
    if (typeof manifest.instanceId !== 'string') {
      issues.push({ path: manifestPath, message: 'instance manifest carries no instanceId to compare the tool response against' });
    } else {
      manifestInstanceId = manifest.instanceId;
    }
  } catch (cause) {
    issues.push({ path: manifestPath, message: `instance manifest could not be read: ${describe(cause)}` });
  }
  if (manifestInstanceId !== undefined) {
    try {
      issues.push(...checkWorkersListIdentity({
        catalog: await readToolCatalog(process.cwd()), output: smoke.output, manifestInstanceId, consoleEnabled: false,
      }));
    } catch (cause) {
      issues.push({ path: TOOL_CATALOG_PATH, message: `the published tool catalog could not be read or compiled: ${describe(cause)}` });
    }
  }
}
await plugin.close();
try {
  const packRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-plugin-artifact-'));
  const packed = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packRoot], { cwd: join(process.cwd(), 'packages', 'plugin') });
  const entries = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  const tarball = join(packRoot, entries[0]!.filename);
  const installRoot = join(packRoot, 'install');
  await exec('npm', ['install', '--prefix', installRoot, '--ignore-scripts', tarball], { cwd: process.cwd() });
  const installed = join(installRoot, 'node_modules', 'taskshuttle');
  const installedStat = await stat(installed).catch(() => undefined);
  if (installedStat === undefined || !installedStat.isDirectory()) throw new Error('packed artifact did not install a taskshuttle package directory');
} catch (error) {
  issues.push({ path: 'package artifact', message: error instanceof Error ? error.message : String(error) });
}
if (issues.length > 0) {
  for (const issue of issues) console.error(`${issue.path}: ${issue.message}`);
  process.exitCode = 1;
} else {
  console.log('host artifact gate: passed');
}
