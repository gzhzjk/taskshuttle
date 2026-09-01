/**
 * Generate the root `NOTICE` from what the build actually inlined.
 *
 * ADR 0041 step 20. The input is the **union of both bundlers' esbuild
 * metafiles** — `tsup`'s for the server entries and `scripts/gen-ui-assets.ts`'s
 * for the console UI, which inlines `runskein/fold` and is a second dependency
 * graph entirely. Two earlier drafts of that decision proposed reading
 * `noExternal` from `tsup.config.ts` instead, and it is wrong three ways: those
 * entries are *patterns*, they may name packages nothing imports, and they say
 * nothing about transitive dependencies that get inlined anyway. The set it
 * produces is neither what was shipped nor a superset of it, while reading as
 * authoritative.
 *
 * **Generation fails closed.** A package in either metafile whose licence
 * cannot be identified stops the build, because the failure worth preventing is
 * a distribution that is silently incomplete, and a build that stops is the
 * cheapest possible way to notice.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

const root = process.cwd();
const METAFILES = [join(root, 'packages', 'plugin', 'dist', 'metafile-esm.json'), join(root, '.build', 'metafile-ui.json')];
const LICENCE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING'];
const NOTICE_FILES = ['NOTICE', 'NOTICE.md', 'NOTICE.txt'];

interface Metafile { readonly inputs: Record<string, unknown> }

/**
 * Every bundled package, as a name and the directory it was actually read from.
 *
 * The directory comes out of the metafile input path rather than being rebuilt
 * as `node_modules/<name>`: under pnpm only direct dependencies are linked at
 * the top level, so a transitive one like `@runskein/fold` is not there at all
 * and reconstructing that path finds nothing. An earlier version of this
 * generator did exactly that and failed the build for seven packages that
 * carry a LICENSE and a NOTICE — fail-closed working, on a bug of its own.
 */
async function inlinedPackages(): Promise<{ name: string; dir: string }[]> {
  const found = new Map<string, string>();
  for (const path of METAFILES) {
    let meta: Metafile;
    try { meta = JSON.parse(await readFile(path, 'utf8')) as Metafile; }
    catch { throw new Error(`NOTICE generation needs ${path}; run the full build (pnpm build) rather than one half of it`); }
    for (const input of Object.keys(meta.inputs)) {
      // Metafile inputs are relative to the process that wrote the metafile,
      // not necessarily the repository root: tsup writes `../../node_modules`
      // from packages/plugin/dist while the UI build writes `node_modules`
      // from the root. Keep the fallback for synthetic missing-package inputs
      // used by the fail-closed test; existence is not a safe discriminator.
      const bases = input.startsWith(`..${sep}`)
        ? [dirname(path), dirname(dirname(path)), root]
        : [root];
      const resolvedInput = isAbsolute(input)
        ? input
        : bases.map((base) => resolve(base, input)).find((candidate) => existsSync(candidate)) ?? resolve(bases.at(-1)!, input);
      // …/node_modules/<name>/rest — the segment after the *last* node_modules
      // names the package, and everything up to and including it is its root.
      const nodeModulesMarker = `${sep}node_modules${sep}`;
      const marker = resolvedInput.lastIndexOf(nodeModulesMarker);
      if (marker === -1) continue;
      const packageStart = marker + nodeModulesMarker.length;
      const after = resolvedInput.slice(packageStart).split(sep);
      const scoped = after[0]!.startsWith('@');
      const name = scoped ? `${after[0]}/${after[1]}` : after[0]!;
      if (name === undefined || after[0] === '.pnpm') continue;
      const dir = join(resolvedInput.slice(0, packageStart), ...(scoped ? [after[0]!, after[1]!] : [after[0]!]));
      found.set(name, dir);
    }
  }
  return [...found].map(([name, dir]) => ({ name, dir })).sort((a, b) => a.name.localeCompare(b.name));
}

/** The package's own licence and NOTICE text, or undefined when it has neither. */
async function attribution(dir: string): Promise<{ licence: string; text: string; notice?: string } | undefined> {
  let manifest: { license?: string; licenses?: unknown };
  try { manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as typeof manifest; }
  catch { return undefined; }
  const licence = typeof manifest.license === 'string' ? manifest.license : undefined;
  if (licence === undefined) return undefined;
  let text = '';
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const candidate of LICENCE_FILES) {
    if (!entries.includes(candidate)) continue;
    text = await readFile(join(dir, candidate), 'utf8');
    break;
  }
  let notice: string | undefined;
  for (const candidate of NOTICE_FILES) {
    if (!entries.includes(candidate)) continue;
    notice = await readFile(join(dir, candidate), 'utf8');
    break;
  }
  if (text === '' && notice === undefined) return undefined;
  return { licence, text, ...(notice === undefined ? {} : { notice }) };
}

const packages = await inlinedPackages();
const sections: string[] = [];
const unidentified: string[] = [];
for (const { name, dir } of packages) {
  const found = await attribution(dir);
  if (found === undefined) { unidentified.push(name); continue; }
  const body = found.notice ?? found.text;
  sections.push(`## ${name}\n\nLicence: ${found.licence}\n\n${body.trim()}\n`);
}

if (unidentified.length > 0) {
  throw new Error(
    `NOTICE generation cannot identify a licence for: ${unidentified.join(', ')}.\n` +
    'These packages are inlined into the shipped bundle, so shipping without ' +
    'their attribution is a licence problem rather than a cosmetic one. Add ' +
    'the missing text or stop bundling the package; this build stops either way.',
  );
}

const header = `# NOTICE

Third-party software bundled into this distribution.

**Generated by \`scripts/gen-notice.ts\` — do not edit.** The source is the union
of both builds' esbuild metafiles, so what is attributed here is what was
actually inlined. Re-run \`pnpm build\`.

`;
await mkdir(root, { recursive: true });
await writeFile(join(root, 'NOTICE'), header + sections.join('\n'), 'utf8');
console.log(`NOTICE: ${sections.length} bundled package(s) attributed`);
