/**
 * Deploy a built taskshuttle release to every discovered host driver.
 *
 * Run after a version is released (bumped, built, gated):
 *
 *   pnpm run deploy                 # full pipeline, gates first
 *   pnpm run deploy --skip-gate     # trust an already-green `pnpm check`
 *   pnpm run deploy --scope project # claude plugin scope (default user)
 *
 * What "install" means per engine (see README "Quickstart → Install TaskShuttle"):
 * - shared launcher: `npm install -g` the packed tgz so `taskshuttle-launch`
 *   is on PATH — every engine's MCP entry ultimately runs this binary;
 * - claude-code / codex: local marketplace under `marketplaces/<host>` plus
 *   plugin install from it (reinstall — `update` no-ops on an unchanged
 *   version string, which during alpha is every redeploy);
 * - opencode: no published plugin — merge a local stdio MCP entry into the
 *   user `opencode.json`, and sync the shared `skills/` into the user skills
 *   dir (`~/.config/opencode/skills/`), replacing only the names this
 *   repository ships;
 * - kimi: once the plugin has been bootstrapped with an in-session
 *   `/plugins install hosts/kimi`, kimi runs the managed copy under
 *   `$KIMI_CODE_HOME/plugins/managed/taskshuttle` — so deploys after the
 *   first simply sync that copy from `hosts/kimi` and take effect on the next
 *   `/reload` or new session. Without the bootstrap record there is nothing
 *   to sync onto and the script prints the one-time manual command.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { discoverHostManifests, runArgv, scopedRoot, ScopedFilesystem, type HostDeployContext, type HostDriver } from '@taskshuttle/host-kit';
import { pathToFileURL } from 'node:url';
import { runDeployPreflight } from './deploy-preflight.js';
import { describeProvision, ensureConsoleConfig } from './provision-config.js';

interface Options {
  skipGate: boolean;
  scope: 'user' | 'project' | 'local';
  dryRun: boolean;
}

type Outcome = 'ok' | 'failed' | 'manual' | 'skipped';

const root = process.cwd();
const results: Array<{ engine: string; outcome: Outcome; detail: string }> = [];

async function hostDrivers(): Promise<Array<{ driver: HostDriver; manifest: Awaited<ReturnType<typeof discoverHostManifests>>[number] }>> {
  const drivers: Array<{ driver: HostDriver; manifest: Awaited<ReturnType<typeof discoverHostManifests>>[number] }> = [];
  for (const manifest of await discoverHostManifests(root)) {
    const module = await import(pathToFileURL(join(root, 'hosts', manifest.id, manifest.driver)).href) as { default?: HostDriver };
    if (module.default === undefined || module.default.id !== manifest.id) throw new Error(`host '${manifest.id}' driver does not match its manifest`);
    drivers.push({ driver: module.default, manifest });
  }
  return drivers;
}

function fail(message: string): never {
  console.error(`deploy: ${message}`);
  process.exit(1);
}

function parseOptions(): Options {
  const argv = process.argv.slice(2);
  const scopeArg = argv.indexOf('--scope');
  const scope = scopeArg === -1 ? 'user' : (argv[scopeArg + 1] as Options['scope']);
  if (!['user', 'project', 'local'].includes(scope)) fail('--scope must be user, project or local');
  return {
    skipGate: argv.includes('--skip-gate'),
    scope,
    dryRun: argv.includes('--dry-run'),
  };
}

/** Run a command, returning null instead of throwing so each engine step can
 * decide between retry paths (e.g. install vs update) without nesting try/catch. */
function run(command: string, args: string[], dryRun: boolean, input?: string, cwd: string = root): { status: number; stdout: string } | null {
  const printable = `$ ${command} ${args.join(' ')}`;
  if (dryRun) {
    console.log(`  [dry-run] ${printable}`);
    return null;
  }
  console.log(`  ${printable}`);
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', input, timeout: 300_000 });
  if (result.error !== undefined) return null;
  return { status: result.status ?? 1, stdout: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function requireRun(command: string, args: string[], what: string, opts: Options, cwd: string = root): string | null {
  const result = run(command, args, opts.dryRun, undefined, cwd);
  if (opts.dryRun) return null;
  if (result === null || result.status !== 0) {
    console.error(result?.stdout ?? `${command} could not be started`);
    throw new Error(what);
  }
  return result.stdout;
}

function onPath(binary: string): boolean {
  return spawnSync('which', [binary], { encoding: 'utf8' }).status === 0;
}

async function hostDeploymentContext(manifest: Awaited<ReturnType<typeof discoverHostManifests>>[number], options: Options): Promise<HostDeployContext> {
  const hostRoot = join(root, 'hosts', manifest.id);
  const repositoryFiles = new ScopedFilesystem(await scopedRoot('repository', root));
  const homeFiles = new ScopedFilesystem(await scopedRoot('home', homedir()));
  const managedPath = process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
  const managedFiles = await scopedRoot('managed', managedPath).then((rootInfo) => new ScopedFilesystem(rootInfo)).catch(() => undefined);
  return {
    manifest,
    roots: { repository: root, host: hostRoot, output: hostRoot },
    dryRun: options.dryRun,
    scope: options.scope,
    home: homedir(),
    env: process.env,
    onPath,
    files: {
      repository: repositoryFiles,
      home: homeFiles,
      ...(managedFiles === undefined ? {} : { managed: managedFiles }),
    },
    run: async (command) => {
      if (options.dryRun) {
        console.log(`  [dry-run] $ ${command.binary} ${command.argv.join(' ')}`);
        return null;
      }
      return runArgv({ binary: command.binary, argv: [...command.argv] }, { cwd: command.cwd ?? root, env: process.env, timeoutMs: 300_000 });
    },
    requireRun: async (command, what) => {
      const result = await (async () => {
        if (options.dryRun) {
          console.log(`  [dry-run] $ ${command.binary} ${command.argv.join(' ')}`);
          return null;
        }
        return runArgv({ binary: command.binary, argv: [...command.argv] }, { cwd: command.cwd ?? root, env: process.env, timeoutMs: 300_000 });
      })();
      if (options.dryRun) return null;
      if (result === null || result.status !== 0) {
        console.error(result?.stderr ?? `${command.binary} could not be started`);
        throw new Error(what);
      }
      return `${result.stdout}${result.stderr}`;
    },
  };
}

async function preflight(options: Options): Promise<{ version: string }> {
  await runDeployPreflight();
  const pkg = JSON.parse(await readFile(join(root, 'packages', 'plugin', 'package.json'), 'utf8')) as { version: string };
  await mkdir(join(root, 'release'), { recursive: true });
  if (!options.skipGate) {
    console.log('== artifact gate (dist freshness, staged bundles, runtime assets, 20 tools)');
    // The gate reads dist/, never src/: deploying on a stale build would ship
    // code that is not what the tests answered about.
    requireRun('pnpm', ['artifact-gate'], 'artifact gate failed — run pnpm check first', options);
  } else {
    console.log('== artifact gate skipped (--skip-gate)');
  }
  return { version: pkg.version };
}

async function packLauncher(version: string, options: Options): Promise<string> {
  console.log(`== pack launcher taskshuttle-${version}.tgz`);
  const stdout = requireRun('npm', ['pack', '--pack-destination', resolve(root, 'release')], 'npm pack failed', options, join(root, 'packages', 'plugin'));
  const tgz = `release/taskshuttle-${version}.tgz`;
  if (!options.dryRun && !stdout?.includes(`taskshuttle-${version}.tgz`)) {
    throw new Error(`npm pack did not produce ${tgz}`);
  }
  if (!options.dryRun) await recordArtifactIdentity(version, tgz);
  return tgz;
}

/**
 * Record the identity of the tarball this deploy installs.
 *
 * `release:npm` uploads **this file**, not a re-pack: a rebuild would make the
 * published artifact a different set of bytes from the one the gates ran
 * against and the one the four engines received, and "the rebuild produced
 * something else" is the class of accident the record exists to prevent.
 *
 * Written beside the tarball rather than into `release/metadata.json`, which is
 * an evidence file governed by ART-013's freshness rule and read by four
 * scripts. This one is a handoff between two commands on one machine and is not
 * tracked.
 *
 * @param version - the release version being packed
 * @param tgz - the tarball's repository-relative path
 */
async function recordArtifactIdentity(version: string, tgz: string): Promise<void> {
  const bytes = await readFile(resolve(root, tgz));
  const record = {
    package: 'taskshuttle',
    version,
    path: tgz,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    packedAt: new Date().toISOString(),
  };
  await writeFile(resolve(root, 'release', 'artifacts.json'), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`== recorded ${tgz} as ${record.sha256.slice(0, 16)}… (${record.byteLength} bytes)`);
}

async function installLauncher(tgz: string, version: string, options: Options): Promise<void> {
  console.log('== global launcher (taskshuttle-launch on PATH)');
  // Remove the retired package first so its old launcher cannot remain on PATH
  // beside the new one during the cutover.
  run('npm', ['uninstall', '-g', 'realm-agent-plugin'], options.dryRun);
  run('npm', ['uninstall', '-g', 'realm-plugin'], options.dryRun);
  // Absolute path: a relative tgz argument is misread by npm as a git remote
  // (`ssh://git@github.com/release/…`), an error that says nothing about paths.
  requireRun('npm', ['install', '-g', resolve(root, tgz)], 'global launcher install failed', options);
  if (options.dryRun) return;
  const listed = run('npm', ['ls', '-g', 'taskshuttle', '--json'], false);
  const installed = listed !== null && listed.status === 0 && listed.stdout.includes(`"version": "${version}"`);
  if (!installed) throw new Error(`global launcher is not at ${version} after install`);
  if (!onPath('taskshuttle-launch')) throw new Error('taskshuttle-launch is not on PATH after global install');
  results.push({ engine: 'launcher', outcome: 'ok', detail: `taskshuttle ${version} installed globally` });
}

/**
 * Give the install an admin config file so the console exists on a fresh
 * machine (GZH-78). Create-if-absent: a file the operator has written is theirs,
 * and this step only reports what it found.
 */
async function provisionConfig(options: Options): Promise<void> {
  console.log('== install config (console)');
  const result = await ensureConsoleConfig(process.env, options.dryRun);
  const detail = describeProvision(result);
  console.log(`  ${options.dryRun ? '[dry-run] ' : ''}${detail}`);
  // Both non-writing outcomes leave the operator something to do by hand, which
  // is what `manual` says in this summary; only a created or already-declaring
  // file needs nothing further.
  const needsOperator = result.outcome === 'unreadable' || result.outcome === 'console-not-declared';
  results.push({ engine: 'config', outcome: needsOperator ? 'manual' : 'ok', detail });
}

/** Run every discovered driver's deployment operation in stable manifest order. */
async function deployDiscoveredHosts(options: Options): Promise<void> {
  const entries = await hostDrivers();
  for (const entry of entries) {
    if (entry.driver.deploy === undefined) throw new Error(`host '${entry.manifest.id}' driver does not provide deployment`);
    const result = await entry.driver.deploy(await hostDeploymentContext(entry.manifest, options));
    results.push({ engine: entry.manifest.id, outcome: result.status === 'skipped' ? 'skipped' : result.status === 'manual' ? 'manual' : 'ok', detail: result.detail });
  }
}

async function main(): Promise<void> {
  const options = parseOptions();
  const { version } = await preflight(options);
  const tgz = await packLauncher(version, options);
  try {
    await installLauncher(tgz, version, options);
    await provisionConfig(options);
    await deployDiscoveredHosts(options);
  } catch (error) {
    fail((error as Error).message);
  }

  console.log(`\n== deploy summary (taskshuttle ${version})${options.dryRun ? ' — DRY RUN, nothing was executed' : ''}`);
  let failures = 0;
  for (const { engine, outcome, detail } of results) {
    if (outcome === 'failed') failures += 1;
    console.log(`  ${outcome.padEnd(7)} ${engine.padEnd(12)} ${detail}`);
  }
  if (failures > 0) process.exit(1);
}

await main();
