#!/usr/bin/env node
/**
 * Fail before Vitest when a package move silently shrinks the suite.
 *
 * The Phase 0 digest is intentionally committed with this gate. The ignored
 * `.taskshuttle/task-phase0` copy is useful evidence, but a clean checkout
 * must have enough information to detect a missing test without that file.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const fixturePath = resolve(root, 'test/fixtures/separation/vitest-collection-baseline.json');
const baseline = JSON.parse(readFileSync(fixturePath, 'utf8'));
const output = execFileSync('pnpm', ['exec', 'vitest', 'list', '--json'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
const listed = JSON.parse(output);
if (!Array.isArray(listed)) throw new Error('test collection guard: Vitest list did not return an array');

const rows = listed.map((entry) => {
  if (typeof entry?.name !== 'string' || typeof entry?.file !== 'string') {
    throw new Error('test collection guard: Vitest returned an entry without name/file');
  }
  return { file: relative(root, entry.file).split('\\').join('/'), name: entry.name };
});
const key = (row) => `${row.file}\0${row.name}`;
const allKeys = rows.map(key).sort();
const baseRows = allKeys.filter((value) => !baseline.allowedAdditions.some((addition) => value === `${addition.file}\0${addition.name}`));
const additions = allKeys.filter((value) => !baseRows.includes(value));
const digest = (value) => createHash('sha256').update(`${value.join('\n')}\n`).digest('hex');
const files = [...new Set(rows.map((row) => row.file))].sort();

if (files.length !== baseline.fileCount + baseline.allowedFileCount) {
  throw new Error(`test collection guard: expected ${baseline.fileCount + baseline.allowedFileCount} files including registered additions, saw ${files.length}`);
}
if (rows.length !== baseline.caseCount + baseline.allowedCaseCount) {
  throw new Error(`test collection guard: expected ${baseline.caseCount + baseline.allowedCaseCount} cases including registered additions, saw ${rows.length}`);
}
if (baseRows.length !== baseline.caseCount || digest([...new Set(baseRows.map((value) => value.split('\0', 1)[0]))].sort()) !== baseline.filesSha256) {
  throw new Error('test collection guard: baseline file set/count changed outside a registered move or addition');
}
if (digest(baseRows) !== baseline.casesSha256) {
  throw new Error('test collection guard: baseline case paths/names changed outside a registered move or addition');
}
if (additions.length !== baseline.allowedCaseCount || additions.some((value) => !baseline.allowedAdditions.some((addition) => value === `${addition.file}\0${addition.name}`))) {
  throw new Error('test collection guard: an unregistered test file or case was collected');
}
console.log(`test collection guard: ${files.length} files, ${rows.length} cases; baseline preserved with ${additions.length} registered additions`);
