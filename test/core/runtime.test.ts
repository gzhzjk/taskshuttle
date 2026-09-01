import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHub, type TranscriptEvent } from 'runskein';
import { scriptedAdapter } from '@runskein/testkit';

import { createTaskShuttleServer, type TaskShuttleServer } from '../../packages/plugin/src/server.js';
import { InstanceManager } from '../../packages/plugin/src/lifecycle.js';
import { createPluginTranscriptStore } from '../../packages/plugin/src/store/plugin-transcript-store.js';
import { PluginConfigError } from '../../packages/plugin/src/plugin-config.js';
import { pinWrapperArgs, wrapperArgsArePinned, WRAPPER_PINS } from '../../packages/plugin/src/wrapper-pins.js';
import type { LogRecord } from '../../packages/plugin/src/logger.js';
import { PluginRuntime, type RuntimeOptions } from '../../packages/plugin/src/runtime.js';
import { readDelegationIdentity } from '../../packages/plugin/src/security-policy.js';

const open: TaskShuttleServer[] = [];

const logs = new Map<TaskShuttleServer, LogRecord[]>();

async function startPlugin(dataRoot: string, config: Record<string, unknown> = {}, hubFactory?: RuntimeOptions['hubFactory']): Promise<TaskShuttleServer> {
  const sink: LogRecord[] = [];
  const plugin = createTaskShuttleServer({
    dataRoot,
    env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [tmpdir()], ...config }) } as NodeJS.ProcessEnv,
    hostCwd: tmpdir(),
    logSink: (record) => { sink.push(record); },
    ...(hubFactory === undefined ? {} : { hubFactory }),
  });
  open.push(plugin);
  logs.set(plugin, sink);
  await plugin.runtime.ready;
  return plugin;
}

function textEvent(sessionId: string, seq: number, text: string): TranscriptEvent {
  return { seq, ts: seq * 1_000, sessionId, engineId: 'codex', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } };
}

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close().catch(() => undefined);
});

describe('a fault event is named for its classification (ADR 0030)', () => {
  it('API-017: an out-of-table transition logs internal_error and no store_error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-fault-transition-'));
    const plugin = await startPlugin(root);
    const registry = plugin.runtime.registry;
    registry.createSession({ id: 'sx', engine: 'codex', cwd: root, permissionMode: 'ask-orchestrator' });
    // creating -> closed is not in the table: the plugin's own invariant, with
    // no storage anywhere near it.
    const apply = (registry as unknown as {
      applyTransition: (kind: string, from: string, to: string, operation: string, ids: Record<string, string>) => string;
    }).applyTransition.bind(registry);
    expect(() => apply('session', 'creating', 'closed', 'test/force', { sessionId: 'sx' })).toThrow();

    const events = logs.get(plugin)!;
    // All three fault names, not the two this fault could plausibly carry: a
    // filter that names only the expected outcomes accepts an extra line under
    // the third name, which is exactly the "second line per fault" this record
    // refuses elsewhere.
    const faults = events.filter((record) => ['store_error', 'internal_error', 'engine_error'].includes(record.event as string));
    expect(faults).toEqual([
      expect.objectContaining({
        event: 'internal_error',
        errorCode: 'INTERNAL',
        operation: 'registry/transition/session:test/force',
        from: 'creating',
        to: 'closed',
        // The id the fault is about. Supplying it to the transition and not
        // asserting it lets the site drop it silently.
        sessionId: 'sx',
      }),
    ]);
  });

  it('a tool fault the store had no part in is still logged (the regression the tool gate would cause)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-fault-tool-'));
    const plugin = await startPlugin(root);
    // An unattributable failure inside a handler: not the caller's argument,
    // not the store, not an engine round trip. Before ADR 0030 the tool site
    // logged only `STORE_ERROR`, so this fault — and, after the producer
    // changes, every malformed interaction payload — would reach the caller
    // and appear in no log at all. Restoring that gate must go red here.
    vi.spyOn(plugin.runtime.registry, 'getSession').mockImplementation(() => { throw new Error('unplaceable'); });
    const answer = await plugin.invoke('session_get', { sessionId: 'anything' });
    expect(answer).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    const faults = logs.get(plugin)!.filter((record) => ['store_error', 'internal_error', 'engine_error'].includes(record.event as string));
    expect(faults).toEqual([
      expect.objectContaining({ event: 'internal_error', errorCode: 'INTERNAL', operation: 'tool/session_get' }),
    ]);
    // The guard costs the id, and must not substitute the caller's raw string
    // for it: that string is the caller's, never a registry id, and a log line
    // carrying it would be the disclosure the resolution exists to avoid.
    expect(faults[0]).not.toHaveProperty('sessionId');
    vi.restoreAllMocks();
  });

  it('API-023: a caller error logs no classified-fault event at all', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-fault-caller-'));
    const plugin = await startPlugin(root);
    // A well-formed call that reaches the runtime handler: input the schema
    // rejects never reaches the logger, so a case built on that would pass
    // without testing anything.
    const answer = await plugin.invoke('session_get', { sessionId: 'no-such-session' });
    expect(answer).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const events = logs.get(plugin)!;
    expect(events.filter((record) => ['store_error', 'internal_error', 'engine_error'].includes(record.event as string))).toEqual([]);
  });
});

describe('runtime install configuration', () => {
  it('R4 refuses a live legacy root before creating the fresh root', async () => {
    const fresh = join(await mkdtemp(join(tmpdir(), 'taskshuttle-fresh-parent-')), 'new-root');
    const legacy = await mkdtemp(join(tmpdir(), 'taskshuttle-legacy-runtime-'));
    const owner = await InstanceManager.create({ dataRoot: legacy, pid: 7777, processStartedAt: '123', exePath: '/worker', rootNonce: 'e'.repeat(32) });
    const runtime = new PluginRuntime(readDelegationIdentity({} as NodeJS.ProcessEnv), {
      dataRoot: fresh,
      legacyRoots: [legacy],
      hostCwd: tmpdir(),
      env: { REALM_PLUGIN_CONFIG: '{}' } as NodeJS.ProcessEnv,
      legacyInspector: async () => ({ exists: true, processStartedAt: '123', exePath: '/worker' }),
    });
    await expect(runtime.ready).rejects.toThrow('legacy instance');
    await expect(stat(fresh)).rejects.toMatchObject({ code: 'ENOENT' });
    await owner.close();
  });

  it('fails start-up on an invalid install field instead of clamping it', () => {
    expect(() => new PluginRuntime(readDelegationIdentity({} as NodeJS.ProcessEnv), { dataRoot: tmpdir(), env: { REALM_PLUGIN_CONFIG: '{"maxOpenSessions":0}' } as NodeJS.ProcessEnv })).toThrow(PluginConfigError);
  });

  it('applies configured limits to the mutation gate and interaction TTL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-limits-'));
    const plugin = await startPlugin(root, { maxOpenSessions: 3, maxActiveTurns: 5, maxActiveTurnsPerEngine: 1, maxQueuedTurns: 7, interactionTtlMs: 60_000 });
    expect(plugin.runtime.registry.gate.limits).toMatchObject({ maxOpenSessions: 3, maxActiveTurns: 5, maxActiveTurnsPerEngine: 1, maxQueuedTurns: 7 });
    expect(plugin.runtime.config.interactionTtlMs).toBe(60_000);
  });

  // ADR 0008 removed the install-surface gate on `allow`. This harness has no
  // engine behind it, so a create still fails — the assertion is that it no
  // longer fails *for asking for `allow`*, which is what the gate used to do.
  it('no longer refuses permissionMode "allow" for lacking an install switch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-allow-'));
    const plugin = await startPlugin(root);
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd: root, permissionMode: 'allow' });
    if (!created.ok) expect(created.error.code).not.toBe('PERMISSION_DENIED');

    const unverifiedRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-unverified-'));
    const unverified = await startPlugin(unverifiedRoot, {}, (options) => createHub({
      ...(options ?? {}),
      adapters: [...(options?.adapters ?? []), scriptedAdapter({ id: 'unverified' })],
      discovery: false,
    }));
    const denied = await unverified.invoke('session_create', { engine: 'unverified', cwd: unverifiedRoot, permissionMode: 'ask-orchestrator' });
    expect(denied).toMatchObject({ ok: false, error: {
      code: 'PERMISSION_DENIED',
      message: "engine 'unverified' is not admitted by the current verification state (unknown); set allowUnverifiedEngines in the install configuration to use it",
      details: { engine: 'unverified', verification: 'unknown' },
    } });
  });

  it('rejects MCP ids that are not in the installed catalog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-mcp-'));
    const plugin = await startPlugin(root);
    const rejected = await plugin.invoke('session_create', { engine: 'codex', cwd: root, mcpServerIds: ['docs'] });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe('INVALID_ARGUMENT');
  });

  it('fails closed on catalogued MCP ids rather than reporting servers the worker never got', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-mcp-catalog-'));
    const plugin = await startPlugin(root, {
      mcpCatalog: { docs: { id: 'docs', transport: 'stdio', startupTimeoutMs: 1_000, connectionTimeoutMs: 1_000, permissionDescription: 'docs' } },
    });
    const rejected = await plugin.invoke('session_create', { engine: 'codex', cwd: root, mcpServerIds: ['docs'] });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe('NOT_SUPPORTED');
  });

  it('reads the admin install file from the data root and lets the host context override it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-file-'));
    await writeFile(join(root, 'config.json'), JSON.stringify({ maxOpenSessions: 5, maxQueuedTurns: 9 }), { mode: 0o600 });
    const plugin = createTaskShuttleServer({ dataRoot: root, hostCwd: tmpdir(), env: { REALM_PLUGIN_CONFIG: JSON.stringify({ maxQueuedTurns: 11, allowedRoots: [tmpdir()] }), REALM_PLUGIN_LOG: 'off' } as NodeJS.ProcessEnv });
    open.push(plugin);
    await plugin.runtime.ready;
    expect(plugin.runtime.registry.gate.limits).toMatchObject({ maxOpenSessions: 5, maxQueuedTurns: 11 });
  });

  it('refuses a group-readable install file instead of ignoring it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-file-mode-'));
    await writeFile(join(root, 'config.json'), JSON.stringify({ maxOpenSessions: 5 }), { mode: 0o644 });
    // writeFile's mode is masked by umask; force the group bit for this test.
    await chmod(join(root, 'config.json'), 0o644);
    expect(() => createTaskShuttleServer({ dataRoot: root, env: {} as NodeJS.ProcessEnv })).toThrow(PluginConfigError);
  });

  it('pins the ACP wrapper versions the release metadata advertises', async () => {
    expect(pinWrapperArgs(['-y', '@agentclientprotocol/codex-acp'])).toEqual(['-y', '@agentclientprotocol/codex-acp@1.3.0']);
    expect(pinWrapperArgs(['-y', '@agentclientprotocol/claude-agent-acp'])).toEqual(['-y', '@agentclientprotocol/claude-agent-acp@0.70.0']);
    expect(wrapperArgsArePinned(pinWrapperArgs(['-y', '@agentclientprotocol/codex-acp']))).toBe(true);
    const metadata = JSON.parse(await readFile(join(process.cwd(), 'release/metadata.json'), 'utf8')) as { wrappers: Record<string, string> };
    expect(metadata.wrappers).toMatchObject(WRAPPER_PINS);
    // Prototype keys are not wrapper packages.
    expect(pinWrapperArgs(['constructor', 'toString'])).toEqual(['constructor', 'toString']);
    expect(wrapperArgsArePinned(['constructor'])).toBe(true);
  });

  it('rejects a cwd outside the configured allowed roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-cwd-'));
    const plugin = createTaskShuttleServer({ dataRoot: root, hostCwd: root, env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [root] }), REALM_PLUGIN_LOG: 'off' } as NodeJS.ProcessEnv });
    open.push(plugin);
    const denied = await plugin.invoke('session_create', { engine: 'codex', cwd: '/' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('PERMISSION_DENIED');
  });

  it('returns stable structured codes for missing sessions and turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-codes-'));
    const plugin = await startPlugin(root);
    for (const call of [plugin.invoke('session_get', { sessionId: 'missing' }), plugin.invoke('turn_get', { turnId: 'missing' }), plugin.invoke('turn_start', { sessionId: 'missing', prompt: [{ type: 'text', text: 'hi' }] })]) {
      const result = await call;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
    }
  });
});

describe('runtime storage lifecycle', () => {
  it('keeps the transcript store inside its own instance directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-store-'));
    const plugin = await startPlugin(root);
    const instances = await readdir(join(root, 'instances'));
    expect(instances).toContain(plugin.runtime.instanceId);
    const instanceDir = join(root, 'instances', plugin.runtime.instanceId);
    expect((await stat(join(instanceDir, 'taskshuttle.sqlite'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(instanceDir, 'instance.lock'))).isFile()).toBe(true);
    const manifest = JSON.parse(await readFile(join(instanceDir, 'instance.json'), 'utf8')) as { launchTokenHash?: string };
    expect(manifest.launchTokenHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(stat(join(instanceDir, 'realm.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not migrate or read a legacy database at a fresh root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-no-db-migration-'));
    await mkdir(join(root, 'instances', 'old-instance'), { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'instances', 'old-instance', 'realm.sqlite'), 'legacy-bytes', { mode: 0o600 });

    const plugin = await startPlugin(root);
    const instanceDir = join(root, 'instances', plugin.runtime.instanceId);
    expect((await stat(join(instanceDir, 'taskshuttle.sqlite'))).isFile()).toBe(true);
    expect((await stat(join(root, 'instances', 'old-instance', 'realm.sqlite'))).isFile()).toBe(true);
    await expect(stat(join(instanceDir, 'realm.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a crashed instance at start-up and lists its transcript as an archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-recovery-'));
    const dead = await InstanceManager.create({ dataRoot: root, instanceId: '44444444-4444-4444-8444-444444444444', rootNonce: 'a'.repeat(32), pid: 999_999, processStartedAt: 'old', exePath: '/old' });
    const store = createPluginTranscriptStore(join(dead.instanceDir, 'taskshuttle.sqlite'), { dataRoot: root });
    await store.append(textEvent('crashed-session', 1, 'partial work'));
    await store.close();
    // Simulate a hard crash: the lock file stays behind with a dead pid.

    const plugin = await startPlugin(root, { retentionDays: 30 });
    const diagnostics = await plugin.runtime.startupDiagnostics();
    expect(diagnostics.recovery.find((entry) => entry.instanceId === dead.instanceId)).toMatchObject({ recovered: true, deleted: false });
    // §15: the same outcome is reported as a structured event.
    const recoveryEvents = logs.get(plugin)!.filter((record) => record.event === 'recovery_result');
    expect(recoveryEvents.map((record) => record['targetInstanceId'])).toContain(dead.instanceId);
    expect(recoveryEvents.find((record) => record['targetInstanceId'] === dead.instanceId)).toMatchObject({ recovered: true, deleted: false });

    const recovered = createPluginTranscriptStore(join(dead.instanceDir, 'taskshuttle.sqlite'), { dataRoot: root });
    expect(await recovered.getMeta('sessions_state')).toBe('aborted');
    expect(await recovered.getMeta('recovered_at')).toBeTruthy();
    await recovered.close();

    const listed = await plugin.invoke('transcript_list', { kind: 'archive' });
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.output.transcripts.map((entry) => entry.sessionId)).toContain('crashed-session');
  });

  it('reaps a dead instance\'s worker shims before retention deletes their markers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-reap-'));
    const dead = await InstanceManager.create({ dataRoot: root, instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', rootNonce: '3'.repeat(32), pid: 999_989, processStartedAt: 'old', exePath: '/old', launchTokenHash: 'e'.repeat(64), now: () => '2020-01-01T00:00:00.000Z' });
    await writeFile(dead.manifestPath, JSON.stringify({ ...dead.getManifest(), closedAt: '2020-01-01T00:00:00.000Z' }) + '\n', { mode: 0o600 });
    await mkdir(join(dead.instanceDir, 'orphans'), { recursive: true, mode: 0o700 });
    await writeFile(join(dead.instanceDir, 'orphans', 'worker.orphan.json'), JSON.stringify({ pid: 999_988, processGroupId: 999_988, processStartedAt: 'shim', exePath: '/usr/bin/node', instanceTokenHash: 'e'.repeat(64) }), { mode: 0o600 });

    const plugin = await startPlugin(root, { retentionDays: 1 });
    const diagnostics = await plugin.runtime.startupDiagnostics();
    // The directory is gone, but its shim was inspected first.
    await expect(stat(dead.instanceDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(diagnostics.orphans.map((entry) => entry.pid)).toContain(999_988);
  });

  it('keeps a scan over many instance directories a constant-cost log event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-scan-logs-'));
    // Instance directories accumulate; the log must not scale with them.
    for (let index = 0; index < 40; index += 1) {
      const id = `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
      const manager = await InstanceManager.create({ dataRoot: root, instanceId: id, rootNonce: '4'.repeat(32), pid: 999_000 + index, processStartedAt: 'old', exePath: '/old' });
      // Break the lock/manifest agreement so the scan reports it untouched.
      await writeFile(manager.manifestPath, JSON.stringify({ ...manager.getManifest(), pid: 1 }) + '\n', { mode: 0o600 });
    }

    const plugin = await startPlugin(root, { retentionDays: 30 });
    const diagnostics = await plugin.runtime.startupDiagnostics();
    expect(diagnostics.recovery.length).toBeGreaterThanOrEqual(40);
    const events = logs.get(plugin)!;
    // Anomalies are never sampled away: an unreadable identity is what a fault
    // looks like, and hiding it behind a benign summary is the failure mode.
    const anomalous = diagnostics.recovery.filter((entry) => entry.reason === 'identity-uncertain').length;
    expect(anomalous).toBeGreaterThanOrEqual(40);
    expect(events.filter((record) => record.event === 'recovery_result').length).toBe(anomalous);
    const retention = events.find((record) => record.event === 'retention_result')!;
    expect(retention['scanned']).toBeGreaterThanOrEqual(40);
    expect(retention['anomalies']).toBe(anomalous);
  });

  it('samples only the benign no-ops when a scan finds nothing to do', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-scan-benign-'));
    const managers: InstanceManager[] = [];
    for (let index = 0; index < 30; index += 1) {
      const id = `${(index + 100).toString(16).padStart(8, '0')}-2222-4222-8222-222222222222`;
      // A live, well-formed peer instance: nothing to recover, nothing wrong.
      managers.push(await InstanceManager.create({ dataRoot: root, instanceId: id, rootNonce: '5'.repeat(32) }));
    }

    const plugin = await startPlugin(root, { retentionDays: 30 });
    const diagnostics = await plugin.runtime.startupDiagnostics();
    expect(diagnostics.recovery.filter((entry) => entry.reason === 'active' || entry.reason === 'identity-indeterminate').length).toBeGreaterThanOrEqual(30);
    const events = logs.get(plugin)!;
    expect(events.filter((record) => record.event === 'recovery_result').length).toBeLessThanOrEqual(20);
    const retention = events.find((record) => record.event === 'retention_result')!;
    expect(retention['anomalies']).toBe(0);
    expect(retention['scanned']).toBeGreaterThanOrEqual(30);
    for (const manager of managers) await manager.close();
  });

  it('deletes an expired instance under retention and never touches a locked one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-retention-'));
    const expired = await InstanceManager.create({ dataRoot: root, instanceId: '55555555-5555-4555-8555-555555555555', rootNonce: 'b'.repeat(32), pid: 999_998, processStartedAt: 'old', exePath: '/old', now: () => '2020-01-01T00:00:00.000Z' });
    await writeFile(expired.manifestPath, JSON.stringify({ ...expired.getManifest(), closedAt: '2020-01-01T00:00:00.000Z' }) + '\n', { mode: 0o600 });
    const live = await InstanceManager.create({ dataRoot: root, instanceId: '66666666-6666-4666-8666-666666666666', rootNonce: 'c'.repeat(32) });

    const plugin = await startPlugin(root, { retentionDays: 1 });
    await plugin.runtime.startupDiagnostics();
    await expect(stat(expired.instanceDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(live.instanceDir)).isDirectory()).toBe(true);
    await live.close();
  });
});

describe('transcript inventory and deletion', () => {
  it('inventories live sessions by plugin id and refuses to delete an active transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-live-'));
    const plugin = await startPlugin(root);
    const { store } = await plugin.runtime.ready;
    // A live session as the registry sees it, with its Realm-side transcript.
    const created = plugin.runtime.registry.createSession({ id: 'plugin-session-1', engine: 'codex', cwd: root });
    expect(created.ok).toBe(true);
    expect(plugin.runtime.registry.markSessionReady('plugin-session-1', 'taskshuttle-session-1', {}).ok).toBe(true);
    await store.append(textEvent('taskshuttle-session-1', 1, 'live output'));

    const listed = await plugin.invoke('transcript_list', {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.output.transcripts).toContainEqual(expect.objectContaining({ sessionId: 'plugin-session-1', kind: 'live', state: 'idle', highWatermark: 1 }));

    const read = await plugin.invoke('transcript_read', { sessionId: 'plugin-session-1', afterSeq: 0, limit: 10 });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.output.events).toHaveLength(1);

    for (const id of ['plugin-session-1', 'taskshuttle-session-1']) {
      const deleted = await plugin.invoke('transcript_delete', { sessionId: id });
      expect(deleted.ok).toBe(false);
      if (!deleted.ok) expect(deleted.error.code).toBe('CONFLICT');
    }
  });

  it('reads and deletes an archived transcript in the instance that owns it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-archive-'));
    const dead = await InstanceManager.create({ dataRoot: root, instanceId: '77777777-7777-4777-8777-777777777777', rootNonce: 'd'.repeat(32), pid: 999_997, processStartedAt: 'old', exePath: '/old' });
    const store = createPluginTranscriptStore(join(dead.instanceDir, 'taskshuttle.sqlite'), { dataRoot: root });
    await store.append(textEvent('archived-session', 1, 'earlier work'));
    await store.close();

    const plugin = await startPlugin(root, { retentionDays: 30 });
    await plugin.runtime.startupDiagnostics();
    const listed = await plugin.invoke('transcript_list', { kind: 'archive' });
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.output.transcripts).toContainEqual(expect.objectContaining({ sessionId: 'archived-session', kind: 'archive', state: 'aborted' }));

    const read = await plugin.invoke('transcript_read', { sessionId: 'archived-session', afterSeq: 0, limit: 10 });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.output.events[0]).toMatchObject({ seq: 1, sessionId: 'archived-session' });

    const deleted = await plugin.invoke('transcript_delete', { sessionId: 'archived-session' });
    expect(deleted.ok).toBe(true);
    const after = await plugin.invoke('transcript_read', { sessionId: 'archived-session', afterSeq: 0, limit: 10 });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe('NOT_FOUND');
  });

  it('keeps a deleted transcript NOT_FOUND even when its session record survives', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-deleted-'));
    const plugin = await startPlugin(root);
    const { store } = await plugin.runtime.ready;
    expect(plugin.runtime.registry.createSession({ id: 'p1', engine: 'codex', cwd: root }).ok).toBe(true);
    expect(plugin.runtime.registry.markSessionReady('p1', 'r1', {}).ok).toBe(true);
    await store.append(textEvent('r1', 1, 'output'));
    expect(plugin.runtime.registry.beginCloseSession('p1').ok).toBe(true);
    expect(plugin.runtime.registry.completeCloseSession('p1').ok).toBe(true);

    expect((await plugin.invoke('transcript_delete', { sessionId: 'p1' })).ok).toBe(true);
    const read = await plugin.invoke('transcript_read', { sessionId: 'p1', afterSeq: 0, limit: 10 });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe('NOT_FOUND');
    // The inventory must not keep advertising what reads now refuse.
    const listed = await plugin.invoke('transcript_list', {});
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.output.transcripts.map((entry) => entry.sessionId)).not.toContain('p1');
  });

  it('returns an empty page for a live session that has not produced an event yet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-empty-'));
    const plugin = await startPlugin(root);
    expect(plugin.runtime.registry.createSession({ id: 'p2', engine: 'codex', cwd: root }).ok).toBe(true);
    expect(plugin.runtime.registry.markSessionReady('p2', 'r2', {}).ok).toBe(true);
    const read = await plugin.invoke('transcript_read', { sessionId: 'p2', afterSeq: 0, limit: 10 });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.output).toMatchObject({ events: [], nextSeq: 1, highWatermark: 0, hasMore: false });
  });
});

describe('transcript pagination budget', () => {
  it('reports PAYLOAD_TOO_LARGE for a single event larger than the response budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-budget-'));
    const plugin = await startPlugin(root);
    const { store } = await plugin.runtime.ready;
    await store.append(textEvent('huge-session', 1, 'x'.repeat(2 * 1_048_576)));
    const result = await plugin.invoke('transcript_read', { sessionId: 'huge-session', afterSeq: 0, limit: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PAYLOAD_TOO_LARGE');
      expect(result.error.details).toMatchObject({ seq: 1 });
      expect((result.error.details as { sha256?: string }).sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('stops a page at the byte budget and reports hasMore', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-page-'));
    const plugin = await startPlugin(root);
    const { store } = await plugin.runtime.ready;
    for (let seq = 1; seq <= 4; seq += 1) await store.append(textEvent('paged-session', seq, 'y'.repeat(400_000)));
    const first = await plugin.invoke('transcript_read', { sessionId: 'paged-session', afterSeq: 0, limit: 100 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.output.events.length).toBeGreaterThan(0);
    expect(first.output.events.length).toBeLessThan(4);
    expect(first.output.hasMore).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first.output), 'utf8')).toBeLessThanOrEqual(plugin.runtime.config.responseByteBudget);

    const second = await plugin.invoke('transcript_read', { sessionId: 'paged-session', afterSeq: first.output.nextSeq - 1, limit: 100 });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.output.events[0]?.seq).toBe(first.output.nextSeq);
  });

  it('slices canonical event bytes with a stable digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-runtime-slice-'));
    const plugin = await startPlugin(root);
    const { store } = await plugin.runtime.ready;
    await store.append(textEvent('slice-session', 1, 'hello world'));
    const head = await plugin.invoke('transcript_event_get', { sessionId: 'slice-session', seq: 1, offset: 0, maxBytes: 8 });
    expect(head.ok).toBe(true);
    if (!head.ok) return;
    const tail = await plugin.invoke('transcript_event_get', { sessionId: 'slice-session', seq: 1, offset: 8, maxBytes: 262_144 });
    expect(tail.ok).toBe(true);
    if (!tail.ok) return;
    expect(tail.output.totalBytes).toBe(head.output.totalBytes);
    expect(tail.output.sha256).toBe(head.output.sha256);
    const bytes = Buffer.concat([Buffer.from(head.output.data, 'base64'), Buffer.from(tail.output.data, 'base64')]);
    expect(bytes.byteLength).toBe(head.output.totalBytes);
    expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({ seq: 1, sessionId: 'slice-session' });
  });
});
