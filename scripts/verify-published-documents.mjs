#!/usr/bin/env node
/**
 * Verify that every published English document has a current Chinese
 * translation. A translation declares the SHA-256 of the English source so an
 * English edit cannot leave a plausible-looking but stale Chinese document.
 *
 * The pairs come from `docs/published-documents.json`, plus any pair named on
 * the command line. **The caller names the extra pair rather than this script
 * assembling a path**: it used to build the release note's path itself, which
 * put an internal directory into a file that ships to the release repository —
 * where that directory does not exist. The path now arrives from the release
 * flow, which is withheld and is the thing that knows where its notes live.
 *
 * Usage:
 *   pnpm docs:translations:check
 *   pnpm docs:translations:check --pair <source.md> <source.zh-CN.md>
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
// A package manager may pass its own `--` separator through to the script;
// it carries no meaning here and would otherwise fail argument validation.
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const pairIndex = args.indexOf('--pair');
const extraPair = pairIndex === -1 ? undefined : { source: args[pairIndex + 1], translation: args[pairIndex + 2] };
if (args.length !== 0 && (pairIndex === -1 || args.length !== 3 || !extraPair?.source || !extraPair?.translation)) {
  console.error('usage: pnpm docs:translations:check [--pair <source> <translation>]');
  process.exit(2);
}

/** Return the SHA-256 used by a translation's source-sha256 declaration. */
function sourceHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

/** Check one English source and its Chinese translation. */
function verifyPair(source, translation) {
  const sourcePath = resolve(root, source);
  const translationPath = resolve(root, translation);
  if (!existsSync(sourcePath)) return [`missing published source: ${source}`];
  if (!existsSync(translationPath)) return [`missing Chinese translation: ${translation} (source: ${source})`];

  const english = readFileSync(sourcePath, 'utf8');
  const chinese = readFileSync(translationPath, 'utf8');
  const declaredSource = /^---\nsource: (.+)\nsource-sha256: ([a-f0-9]{64})\n---\n/m.exec(chinese);
  const failures = [];
  if (!declaredSource) {
    failures.push(`${translation} needs source/source-sha256 frontmatter`);
    return failures;
  }
  if (declaredSource[1] !== source) failures.push(`${translation} declares source ${declaredSource[1]}, expected ${source}`);
  if (declaredSource[2] !== sourceHash(english)) failures.push(`${translation} is stale; retranslate ${source} and refresh source-sha256`);
  if (!/[\u3400-\u9fff]/.test(chinese.slice(declaredSource[0].length))) {
    failures.push(`${translation} contains no Chinese translation text`);
  }
  return failures;
}

const manifest = JSON.parse(readFileSync(resolve(root, 'docs/published-documents.json'), 'utf8'));
const pairs = [...manifest.documents, ...(extraPair === undefined ? [] : [extraPair])];

const failures = pairs.flatMap(({ source, translation }) => verifyPair(source, translation));
if (failures.length > 0) {
  console.error('published-document translation check failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`published-document translations current: ${pairs.length} pair(s)`);
