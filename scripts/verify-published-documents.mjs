#!/usr/bin/env node
/**
 * Verify that every published English document has a current Chinese
 * translation. A translation declares the SHA-256 of the English source so an
 * English edit cannot leave a plausible-looking but stale Chinese document.
 *
 * Usage: `pnpm docs:translations:check [--release <version>]`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
// A package manager may pass its own `--` separator through to the script;
// it carries no meaning here and would otherwise fail argument validation.
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const releaseIndex = args.indexOf('--release');
const releaseVersion = releaseIndex === -1 ? undefined : args[releaseIndex + 1];
if (args.length !== 0 && (releaseIndex === -1 || args.length !== 2 || !releaseVersion)) {
  console.error('usage: pnpm docs:translations:check [--release <version>]');
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
const pairs = [...manifest.documents];
if (releaseVersion) {
  pairs.push({
    source: `docs/design/releases/${releaseVersion}.md`,
    translation: `docs/design/releases/${releaseVersion}.zh-CN.md`,
  });
}

const failures = pairs.flatMap(({ source, translation }) => verifyPair(source, translation));
if (failures.length > 0) {
  console.error('published-document translation check failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`published-document translations current: ${pairs.length} pair(s)`);
