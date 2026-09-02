// The repository-wide document link check and the link extractor it shares with
// the exporter. Both travel, so these cases travel with them: the release
// repository runs `docs:links:check` on every pull request, and a check nobody
// tests there is a check whose failure mode nobody has seen.
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { localLinks } from '../../scripts/markdown-links.mjs';

const CHECKER = resolve(import.meta.dirname, '..', '..', 'scripts', 'check-doc-links.mjs');

const cleanup: string[] = [];
afterEach(async () => {
  for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** A git repository holding the named files, all tracked. */
async function repository(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'taskshuttle-doclinks-'));
  cleanup.push(directory);
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: directory, stdio: 'ignore' });
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(directory, dirname(path)), { recursive: true });
    await writeFile(join(directory, path), contents);
  }
  execFileSync('git', ['add', '-A'], { cwd: directory, stdio: 'ignore' });
  return directory;
}

/** Run the checker against a tree expected to pass, returning its report. */
function check(cwd: string): string {
  return execFileSync('node', [CHECKER], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The same for a tree expected to fail; `execFileSync` throws on a non-zero exit. */
function checkFailing(cwd: string): string {
  try {
    execFileSync('node', [CHECKER], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    expect(failure.status).toBe(1);
    return `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
  }
  throw new Error('expected the check to fail');
}

describe('what counts as a link', () => {
  it('ignores a bracket-then-paren inside a fenced block', () => {
    // Not hypothetical: a migration record in this project holds a line whose
    // regex puts a character class before a group. Read as prose that is a link
    // target, and a check that resolved it would refuse a document nothing is
    // wrong with.
    const text = ['before', '```js', "if (/from[\"'](?:runskein|zod)/u.test(x)) …", '```', '[real](./other.md)'].join('\n');
    expect(localLinks(text)).toEqual([{ target: './other.md', line: 5 }]);
  });

  it('closes a fence only on its own marker, at least as long', () => {
    // A ```` block quoting ``` must not close on the sample it contains.
    const text = ['````md', '```', '[inner](./gone.md)', '```', '````', '[outer](./here.md)'].join('\n');
    expect(localLinks(text)).toEqual([{ target: './here.md', line: 6 }]);
  });

  it('ignores an inline code span and keeps the prose around it', () => {
    const text = 'see `[sample](./nowhere.md)` and [real](./here.md)';
    expect(localLinks(text)).toEqual([{ target: './here.md', line: 1 }]);
  });

  it('drops external schemes and bare fragments, and strips a fragment from a path', () => {
    const text = '[a](https://example.com) [b](mailto:x@example.com) [c](#section) [d](./doc.md#part)';
    expect(localLinks(text)).toEqual([{ target: './doc.md', line: 1 }]);
  });

  it('keeps a target that carries a title', () => {
    expect(localLinks('[a](./doc.md "the title")')).toEqual([{ target: './doc.md', line: 1 }]);
  });
});

describe('the repository-wide check', () => {
  it('passes when every local link resolves to a carried path or directory', async () => {
    const cwd = await repository({
      'docs/a.md': '[b](./b.md) and [the records](./adr) and [root](../README.md)',
      'docs/b.md': '# b',
      'docs/adr/0001.md': '# one',
      'README.md': '# readme',
    });
    expect(check(cwd)).toContain('every local link resolves');
  });

  it('checks the whole repository when run from a subdirectory', async () => {
    // `git ls-files` is relative to where it runs, so anchoring on the caller's
    // directory would let the check pass by having looked at a fraction of the
    // tree — a green that means nothing.
    const cwd = await repository({ 'docs/a.md': '[moved](../src/thing.ts)\n', 'other/b.md': '# b' });
    expect(checkFailing(join(cwd, 'other'))).toContain('docs/a.md:1 links ../src/thing.ts');
  });

  it('names the file, the line and the target of a link that does not resolve', async () => {
    const cwd = await repository({ 'docs/a.md': '# a\n\n[moved](../src/thing.ts)\n' });
    expect(checkFailing(cwd)).toContain('docs/a.md:3 links ../src/thing.ts');
  });

  it('refuses a link that resolves outside the repository', async () => {
    // `../../elsewhere` may exist on the author's disk and exists for nobody else.
    const cwd = await repository({ 'docs/a.md': '[out](../../elsewhere.md)\n' });
    expect(checkFailing(cwd)).toContain('leaves the repository');
  });

  it('refuses a link to build output, which a clone does not have', async () => {
    // It resolves on a working tree and not on a fresh clone, so resolving
    // against the filesystem would answer differently in the two places.
    const cwd = await repository({ 'docs/a.md': '[built](../dist/launch.js)\n', '.gitignore': 'dist/\n' });
    await mkdir(join(cwd, 'dist'), { recursive: true });
    await writeFile(join(cwd, 'dist', 'launch.js'), '');
    expect(checkFailing(cwd)).toContain('which is not a path this repository carries');
  });

  it('covers a document added but not yet committed, and what it links', async () => {
    // The set is what git carries — committed, plus anything new that is not
    // ignored. Committed alone would exempt exactly the document nobody has
    // checked yet, and it is the whole tree in a directory an export has just
    // written into a clone, where HEAD still describes the previous release.
    const cwd = await repository({ 'docs/a.md': '# a' });
    execFileSync('git', ['commit', '-m', 'first', '--author', 'T <t@example.com>'], {
      cwd, stdio: 'ignore', env: { ...process.env, GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com' },
    });
    await writeFile(join(cwd, 'docs', 'new.md'), '[missing](./gone.md)\n');
    expect(checkFailing(cwd)).toContain('docs/new.md:1 links ./gone.md');
  });

  it('excuses a document that declares its paths historical, and reports the reason', async () => {
    const cwd = await repository({
      'docs/a.md': '<!-- link-check: an execution record, paths as of August 2026 -->\n\n[gone](../src/thing.ts)\n',
    });
    const output = check(cwd);
    expect(output).toContain('exempt: docs/a.md (1 unresolved)');
    expect(output).toContain('an execution record, paths as of August 2026');
  });

  it('resolves a link that names a directory with a trailing slash', async () => {
    const cwd = await repository({ 'docs/a.md': '[records](./adr/)\n', 'docs/adr/0001.md': '# one' });
    expect(check(cwd)).toContain('every local link resolves');
  });

  it('reads the exemption only when it owns its line', async () => {
    // A document that describes the marker must not exempt itself by quoting it:
    // its own links resolve, so it would then fail as an exemption excusing
    // nothing.
    const cwd = await repository({
      'docs/a.md': 'write `<!-- link-check: why -->` in the file.\n\n[b](./b.md)\n',
      'docs/b.md': '# b',
    });
    expect(check(cwd)).toContain('every local link resolves');
  });

  it('refuses an exemption that excuses nothing', async () => {
    // The same discipline as the export manifest's rule that an include pattern
    // matching no file is an error: a marker nobody can see stop applying is a
    // rule that outlives its reason.
    const cwd = await repository({
      'docs/a.md': '<!-- link-check: stale -->\n\n[b](./b.md)\n',
      'docs/b.md': '# b',
    });
    expect(checkFailing(cwd)).toContain('carries a link-check exemption but every link resolves');
  });
});
