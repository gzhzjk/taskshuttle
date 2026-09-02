/**
 * Every local link in every markdown file resolves to a path this repository
 * carries.
 *
 * An export resolves links inside the set it publishes, which leaves every
 * document it leaves behind — in this project, most of them — checked by
 * nobody. That gap has been paid for once: GZH-109 was twelve design documents
 * linking a root `src/` tree that ADR 0048/0049 had moved under `packages/`,
 * and the check that found them was written by hand during GZH-102 and then
 * thrown away. This is that check, kept.
 *
 * **Resolution is against what git carries, not against the filesystem**: the
 * committed files plus anything new that is not ignored. A link resolving only
 * after `pnpm build` would answer differently on a clean clone than on a
 * working tree, and a reader who clones has no build output. Committed alone
 * would be wrong in the other direction — a document added in the working tree
 * is exactly the one whose links nobody has checked yet, and it is also the
 * whole tree in a directory an export has just written into a clone, where
 * `HEAD` still describes the previous release.
 *
 *   pnpm docs:links:check
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { localLinks } from './markdown-links.mjs';

// A document may declare that its paths are historical. The reason is required
// and lives beside the links it excuses, rather than in a registry that drifts
// away from them. It is deliberately whole-file: the property being claimed
// ("the paths in this record are as of a past date") is a property of the
// record, not of one link, and a frozen record does not gain new ones.
//
// It must own its line: a document that *describes* the marker — this project
// has one, and so does the failure message at the bottom of this file — would
// otherwise exempt itself, and then fail as an exemption excusing nothing.
const EXEMPT = /^<!--\s*link-check:\s*(\S[^>]*?)\s*-->\s*$/m;

// The repository root, not the caller's directory: `git ls-files` run from
// `docs/` lists only what is under it, and the check would then pass by
// having looked at a fraction of the tree.
let root;
try {
  root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
  // Worth naming rather than letting git's own message surface: the check is
  // defined in terms of what a repository carries, so outside one it has no
  // question to answer, and a raw `git rev-parse` failure sends the reader
  // looking at git.
  console.error('document links: this is not a git repository, so there is no set of carried files to resolve against');
  process.exit(1);
}
const carried = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(Boolean);
const carriedSet = new Set(carried);
// A link may name a directory. It exists when something carried is inside it.
const carriedDirectories = new Set();
for (const path of carried) {
  const segments = path.split('/');
  for (let depth = 1; depth < segments.length; depth += 1) carriedDirectories.add(segments.slice(0, depth).join('/'));
}

const failures = [];
let checkedFiles = 0;
let checkedLinks = 0;
const exemptions = new Map();

for (const path of carried) {
  if (!path.endsWith('.md')) continue;
  const text = readFileSync(join(root, path), 'utf8');
  const exemption = EXEMPT.exec(text);
  const unresolved = [];
  checkedFiles += 1;
  for (const { target, line } of localLinks(text)) {
    checkedLinks += 1;
    // A trailing slash survives `normalize`, and no repository path carries one.
    const resolved = normalize(join(dirname(path), target)).replace(/\/$/, '');
    if (resolved === '..' || resolved.startsWith('../')) {
      unresolved.push(`${path}:${line} links ${target}, which leaves the repository`);
      continue;
    }
    if (!carriedSet.has(resolved) && !carriedDirectories.has(resolved)) {
      unresolved.push(`${path}:${line} links ${target}, which is not a path this repository carries`);
    }
  }
  if (exemption === null) { failures.push(...unresolved); continue; }
  exemptions.set(path, { reason: exemption[1], excused: unresolved.length });
  // An exemption that excuses nothing is the same defect as an export-manifest
  // pattern matching no file: a rule nobody can see stop applying. It goes red
  // so the marker is deleted when the links it covered are fixed or removed.
  if (unresolved.length === 0) failures.push(`${path} carries a link-check exemption but every link resolves — delete the marker`);
}

console.log(`checked ${checkedLinks} local links across ${checkedFiles} markdown files`);
for (const [path, { reason, excused }] of exemptions) console.log(`  exempt: ${path} (${excused} unresolved) — ${reason}`);

if (failures.length > 0) {
  console.error('\ndocument links:');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(`\n${failures.length} problem(s). A link that no longer resolves is how a reader learns the tree moved.`);
  console.error("If a document's paths are deliberately historical, say so in it: <!-- link-check: why -->");
  process.exit(1);
}

console.log('every local link resolves');
