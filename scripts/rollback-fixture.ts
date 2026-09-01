import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { InstanceManager } from '../packages/plugin/src/lifecycle.js';
import { createPluginTranscriptStore } from '../packages/plugin/src/store/plugin-transcript-store.js';
import type { TranscriptEvent } from 'runskein';

const dataRoot = process.argv[2];
if (dataRoot === undefined) throw new Error('rollback fixture requires a data-root argument');

const sessionId = '11111111-1111-4111-8111-111111111111';
const instanceId = '22222222-2222-4222-8222-222222222222';
const firstTs = Date.parse('2026-08-30T00:00:00.000Z');
const events = [
  {
    seq: 1,
    ts: firstTs,
    sessionId,
    engineId: 'codex',
    update: { sessionUpdate: 'session_info_update', _meta: { 'runskein.dev/sessionMeta': { cwd: '/tmp/sto-018-workspace', status: 'closed' } } },
    usage: { input: 17, output: 5, total: 22 },
  },
  {
    seq: 2,
    ts: firstTs + 1,
    sessionId,
    engineId: 'codex',
    update: { sessionUpdate: 'opaque_future_update', payload: { marker: 'sto-018-opaque-update' } },
  },
] as unknown as TranscriptEvent[];

const instance = await InstanceManager.create({
  dataRoot,
  instanceId,
  rootNonce: 'sto-018-root-nonce',
  host: 'sto-018-fixture',
  pid: process.pid,
  processStartedAt: '2026-08-30T00:00:00.000Z',
  exePath: process.execPath,
  now: () => '2026-08-30T00:00:00.000Z',
});
const store = createPluginTranscriptStore(join(instance.instanceDir, 'taskshuttle.sqlite'), { dataRoot });
try {
  for (const event of events) await store.append(event);
} finally {
  await store.close();
}
// A clean close removes the instance lock but leaves its complete directory.
// The old reader must adopt this closed archive through its normal recovery scan.
await instance.close({ now: () => '2026-08-30T00:00:01.000Z', retentionDays: null });
await writeFile(join(dataRoot, 'sto-018-expected.json'), JSON.stringify({ sessionId, events }));
