/**
 * Runtime assets Realm loads by path rather than by import.
 *
 * `spawnEngine` resolves its parent-death watchdog as
 * `new URL('./supervisor.mjs', import.meta.url)` — a path, not an import — so
 * the bundler never sees it and never emits it. Inlined into `dist/`, that URL
 * resolves next to the *chunk*, and the file has to be there or the spawn dies
 * with `MODULE_NOT_FOUND` from node's main-module loader. Only `claude-code`
 * declares `supervise`, so this is the difference between that engine starting
 * from the shipped artifact and not starting at all.
 *
 * The list is explicit on purpose. The artifact gate independently derives what
 * the built bundle asks for and fails when something is missing, so a new asset
 * surfaces as a gate failure rather than as a broken engine in the field.
 *
 * Upstream ships the asset since `0.1.0-alpha.10`; before that
 * the published tarball had no `.mjs` at all and no consumer could start
 * claude-code. Copying it here is still required because the build inlines Realm
 * into the bundle, which leaves the path-loaded file behind.
 *
 * This script also ships the worker-defaults template: `conf-template/
 * default-config.json` (ADR 0018/0019) is copied to `dist/` so it lands in the
 * npm tarball and — via `stage-host-bundles.ts` — in the staged host bundles.
 * It is no longer inert: `project_init` reads it at runtime as the generation
 * skeleton (profile names and purpose texts), beside the launcher's own
 * bundle-relative lookup.
 */
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const root = process.cwd();
const distArgument = process.argv.indexOf('--dist');
const targetDist = distArgument >= 0 && process.argv[distArgument + 1] !== undefined
  ? join(root, process.argv[distArgument + 1] as string)
  : join(root, 'dist');

/**
 * Bundle-relative asset name → the candidate sources that may provide it.
 *
 * Every entry's package is a declared dependency, because that is what makes
 * the path stable — pnpm links from a content-addressed store, so an
 * undeclared package has no predictable location.
 *
 * `permission-gate.ts` is here for a reason the gate cannot derive: it is passed
 * to the `pi` CLI as `--extension`, so the file must sit beside `shim.mjs` at
 * runtime, but the gate's derivation only recognises extensions a bundler never
 * emits (`.mjs`/`.cjs`/`.wasm`/`.node`) and would not notice a missing `.ts`.
 * This list is the only thing that ships it.
 *
 * Copying is only safe while the asset is self-contained. A copied file keeps
 * its own bare imports, and those resolve only while a `node_modules` tree
 * happens to sit above wherever it landed — true in this repository, false in
 * every install. `shim.mjs` imported the ACP SDK until `0.1.0-alpha.11` and so
 * shipped a `pi` that started here and died with `ERR_MODULE_NOT_FOUND` in the
 * field; upstream now publishes it with `node:` builtins only. The artifact gate
 * rejects a path-loaded asset carrying any bare specifier, so a regression there
 * fails the build rather than the engine, and this script can stay a copy.
 */
const RUNTIME_ASSETS: ReadonlyArray<{ name: string; candidates: readonly string[] }> = [
  { name: 'supervisor.mjs', candidates: ['node_modules/@runskein/core/dist/process/supervisor.mjs'] },
  { name: 'shim.mjs', candidates: ['node_modules/@runskein/adapter-pi/shim.mjs'] },
  { name: 'permission-gate.ts', candidates: ['node_modules/@runskein/adapter-pi/permission-gate.ts'] },
];

/**
 * `@runskein/core` is a direct dependency for exactly this reason: the asset
 * lives inside it, and its `exports` map publishes neither the file nor its
 * `package.json`, so no resolver call can find it from here. A declared
 * dependency gives the path above; reaching into another package's private
 * layout would not.
 *
 * Declaring it separately also creates a way to be wrong: the bundle inlines
 * whatever core `runskein` depends on, while the asset is copied from the core
 * we declared. Different versions would ship a watchdog that does not match the
 * `spawn.js` next to it — silently, since both files exist. So the two are
 * compared, and a mismatch fails the build rather than the engine.
 */
function assertCoreVersionsAgree(): void {
  const read = (path: string): string =>
    (JSON.parse(readFileSync(join(root, path), 'utf8')) as { version?: string }).version ?? 'unknown';
  const declared = read('node_modules/@runskein/core/package.json');
  // What the meta-package asks for, read from its manifest rather than from a
  // nested node_modules: pnpm links dependencies out of a content-addressed
  // store, so the nested layout npm would produce is simply not there.
  const meta = JSON.parse(readFileSync(join(root, 'node_modules/runskein/package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const wanted = meta.dependencies?.['@runskein/core'] ?? 'unknown';
  if (declared !== wanted) {
    throw new Error(
      `@runskein/core version mismatch: this package declares ${declared}, runskein wants ${wanted}. ` +
        'Align them in package.json before building, or the watchdog will not match the spawn code beside it.',
    );
  }
}

async function firstExisting(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    const absolute = join(root, candidate);
    if (await stat(absolute).then((info) => info.isFile()).catch(() => false)) return absolute;
  }
  return undefined;
}

assertCoreVersionsAgree();

for (const asset of RUNTIME_ASSETS) {
  const source = await firstExisting(asset.candidates);
  if (source === undefined) {
    throw new Error(`runtime asset ${asset.name} was not found: ${asset.candidates.join(', ')}. Is @runskein/core installed?`);
  }
  const target = join(targetDist, asset.name);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

// The worker-defaults template ships from conf-template/ rather than from a
// dependency, so it is not a RUNTIME_ASSETS entry; it is validated by the
// artifact gate instead of by the gate's path-load derivation.
await copyFile(join(root, 'conf-template', 'default-config.json'), join(targetDist, 'default-config.json'));
