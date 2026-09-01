import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ART-016's third home (ADR 0041 step 20): the claim a *directory* cannot make.
 *
 * `validateHostArtifacts(rootDirectory)` proves the file exists and every copy
 * matches. It cannot prove the file describes what was actually bundled — that
 * needs the build graph, which is what these cases read. Three checks, three
 * inputs, three homes; the third is the release preflight's `npm pack`.
 */
describe('NOTICE generation', () => {
  const root = process.cwd();

  it('attributes every package both bundlers inlined, from the union of the metafiles', async () => {
    const notice = await readFile(join(root, 'NOTICE'), 'utf8');
    const named = new Set([...notice.matchAll(/^## (\S+)$/gmu)].map((match) => match[1]!));

    const fromMetafile = async (path: string): Promise<Set<string>> => {
      const meta = JSON.parse(await readFile(join(root, path), 'utf8')) as { inputs: Record<string, unknown> };
      const packages = new Set<string>();
      for (const input of Object.keys(meta.inputs)) {
        const marker = input.lastIndexOf('node_modules/');
        if (marker === -1) continue;
        const after = input.slice(marker + 'node_modules/'.length).split('/');
        if (after[0] === '.pnpm') continue;
        packages.add(after[0]!.startsWith('@') ? `${after[0]}/${after[1]}` : after[0]!);
      }
      return packages;
    };

    const server = await fromMetafile('packages/plugin/dist/metafile-esm.json');
    const ui = await fromMetafile('.build/metafile-ui.json');
    const union = new Set([...server, ...ui]);
    expect(union.size).toBeGreaterThan(0);
    // Every inlined package is attributed. The reverse is not asserted: NOTICE
    // carrying an extra section is a stale entry, not a licence hole, and the
    // regeneration below is what removes it.
    for (const name of union) expect(named).toContain(name);
  });

  it('is regenerated from an unchanged graph byte-for-byte', async () => {
    // Determinism is what makes ART-016's "staged copy differs from the root"
    // check meaningful: if generation were unstable, every build would report a
    // difference and the check would be trained to be ignored.
    const before = await readFile(join(root, 'NOTICE'), 'utf8');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('pnpm', ['gen:notice'], { cwd: root });
    const after = await readFile(join(root, 'NOTICE'), 'utf8');
    expect(after).toBe(before);
  }, 60_000);

  it('fails the build when a bundled package has no identifiable licence', async () => {
    // Fail-closed is the decision, and a decision no case exercises is prose.
    //
    // This drives `scripts/gen-notice.ts` itself. An earlier version of this
    // case re-implemented the generator's resolution inline and asserted that
    // *that* threw, which proves the test can write a failing script and
    // nothing about the generator — the same shape of hole ART-016's third
    // home exists to close.
    const metafile = join(root, 'packages', 'plugin', 'dist', 'metafile-esm.json');
    const original = await readFile(metafile, 'utf8');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    try {
      const meta = JSON.parse(original) as { inputs: Record<string, unknown> };
      meta.inputs['node_modules/.pnpm/nolicence@0.0.0/node_modules/nolicence/index.js'] = {};
      await writeFile(metafile, JSON.stringify(meta));
      await expect(run('pnpm', ['gen:notice'], { cwd: root })).rejects.toThrow(/nolicence/u);
    } finally {
      await writeFile(metafile, original);
      // Leave NOTICE as the real graph produces it, so a later case in this
      // file is not reading whatever the failed run left behind.
      await run('pnpm', ['gen:notice'], { cwd: root });
    }
  }, 90_000);
});
