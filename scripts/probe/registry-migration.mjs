// HOST-COMMON-005 — the engine-registry migration §1.3 leaves unchecked.
// Drives fileOwnershipRegistry() at the default path, which is where
// migrateLegacyRegistry() is called from; XDG_STATE_HOME isolates it from the
// operator's real registry.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const state = mkdtempSync(join(tmpdir(), 'hostcommon005-'));
process.env['XDG_STATE_HOME'] = state;

const { defaultRegistryPath, fileOwnershipRegistry } = await import('@runskein/core/internal');
const target = defaultRegistryPath();
if (!target.startsWith(state)) throw new Error(`isolation failed: ${target} is not under ${state}`);
const legacy = join(state, 'realm-node', 'engines.jsonl');

const seeded = [
  '{"pid":999000001,"startedAt":"2026-08-01T00:00:00.000Z","command":"seed-one"}',
  '{"pid":999000002,"startedAt":"2026-08-01T00:00:01.000Z","command":"seed-two"}',
  '{"pid":999000003,"startedAt":"2026-08-01T00:00:02.000Z","command":"seed-three"}',
];
mkdirSync(dirname(legacy), { recursive: true });
writeFileSync(legacy, seeded.join('\n') + '\n');

const lines = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '') : []);
const results = [];
const check = (id, ok, detail) => { results.push({ id, ok, detail }); };

fileOwnershipRegistry();                       // first start
const afterFirst = lines(target);
check('A all seeded entries arrive at the new path',
  afterFirst.length === 3 && seeded.every((l) => afterFirst.includes(l)),
  `${afterFirst.length}/3 carried`);
check('B the legacy file is gone', !existsSync(legacy), existsSync(legacy) ? 'still present' : 'removed');

fileOwnershipRegistry();                       // second start
const afterSecond = lines(target);
check('C a second start appends nothing',
  afterSecond.length === afterFirst.length && afterFirst.length > 0,
  `before=${afterFirst.length} after=${afterSecond.length}`);

rmSync(state, { recursive: true, force: true });
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(46)} ${r.detail}`);
const failed = results.filter((r) => !r.ok);
console.log(`\nHOST-COMMON-005: ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length}/${results.length})`}`);
process.exit(failed.length === 0 ? 0 : 1);
