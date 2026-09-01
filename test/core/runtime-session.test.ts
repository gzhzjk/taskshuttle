import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NANNY_SNAPSHOT_FILE, readNannySnapshot } from '../../packages/plugin/src/nanny-snapshot.js';
import { createTaskShuttleServer, type TaskShuttleServer } from '../../packages/plugin/src/server.js';
import { FakeRunskeinHub, type FakeRunskeinSession } from '../../packages/plugin/src/testkit/fake-runskein.js';
import type { LogRecord } from '../../packages/plugin/src/logger.js';
import type { ReactivationInfo, TranscriptEvent } from 'runskein';

const open: TaskShuttleServer[] = [];

const descriptor = {
  engine: 'codex',
  installed: true,
  authenticated: true,
  available: true,
  capabilities: {
    loadSession: true,
    session: { fork: true },
    prompt: { image: true, embeddedContext: true },
    mcp: {},
    providers: false,
  },
  models: [],
  modes: [],
  providers: [],
  configOptions: [],
  source: 'builtin',
};

const engineInfos = [{ id: 'codex', installed: true, authenticated: true, health: 'ready', version: '1.0.0' }];

/** The runtime's hub surface, backed by the deterministic fake. */
function fakeHub(hub: FakeRunskeinHub) {
  return Object.assign(hub, {
    on: () => () => undefined,
    rescan: async () => undefined,
  });
}

/** The snapshot lives in the instance directory, which the tools never name. */
async function findSnapshot(root: string): Promise<string | undefined> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const hit = entries.find((entry) => entry.isFile() && entry.name === NANNY_SNAPSHOT_FILE);
  return hit === undefined ? undefined : join(hit.parentPath, hit.name);
}

/**
 * Poll until a condition holds, so a fixture never depends on a fixed sleep
 * being long enough on a loaded runner (a slow machine would otherwise resolve
 * a prompt that has not been dispatched, or read a session mid-turn).
 */
async function settled(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error('condition did not settle in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function startWithFakeHub(): Promise<{ plugin: TaskShuttleServer; hub: FakeRunskeinHub; logs: LogRecord[]; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'taskshuttle-session-'));
  const hub = new FakeRunskeinHub({
    closeResolvesPrompt: true,
    engineInfos: engineInfos as never,
    descriptors: { codex: descriptor } as never,
  });
  const logs: LogRecord[] = [];
  const plugin = createTaskShuttleServer({
    dataRoot: root,
    env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [tmpdir()] }) } as NodeJS.ProcessEnv,
    hostCwd: tmpdir(),
    hubFactory: () => fakeHub(hub) as never,
    logSink: (record) => { logs.push(record); },
  });
  open.push(plugin);
  await plugin.runtime.ready;
  return { plugin, hub, logs, root };
}

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close().catch(() => undefined);
});

describe('classified-fault events at the sites that emit them (ADR 0030)', () => {
  it('API-021: a store failure while draining a turn is logged as store_error', async () => {
    const { plugin, hub, logs } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-fault-drain-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const started = await plugin.invoke('turn_start', { sessionId: created.output.sessionId, prompt: [{ type: 'text', text: 'work' }] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    // Make the drain's own read fail. This is the failure the scheduler turns
    // into `drained.error`, and until ADR 0030's review nothing logged it: the
    // site that claimed to report a drain store failure was reporting the
    // turn's outcome instead.
    const { store } = await plugin.runtime.ready;
    const realmSessionId = plugin.runtime.registry.getSession(created.output.sessionId)!.realmSessionId!;
    await store.append({ seq: 1, ts: 1, sessionId: realmSessionId, engineId: 'codex', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } as never);
    vi.spyOn(store, 'read').mockImplementation((() => (async function* () { throw new Error('store is unwell'); })()) as never);
    const session = [...hub.sessions.values()][0]!;
    session.resolvePrompt({ stopReason: 'end_turn', durationMs: 1 });
    await settled(() => logs.some((record) => record.event === 'store_error'));

    // Exact array, like the other two drain cases: `find` plus a partial match
    // accepts a second fault line for the same failure.
    expect(logs.filter((record) => ['store_error', 'internal_error', 'engine_error'].includes(record.event as string))).toEqual([
      expect.objectContaining({
        event: 'store_error',
        errorCode: 'STORE_ERROR',
        operation: 'store/drain',
        sessionId: created.output.sessionId,
        turnId: started.output.turnId,
      }),
    ]);
    vi.restoreAllMocks();
  });

  it('API-018/019 at the tool boundary: a malformed payload reaches the caller AND the log', async () => {
    const { plugin, hub, logs } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-fault-payload-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd, permissionMode: 'ask-orchestrator' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const started = await plugin.invoke('turn_start', { sessionId: created.output.sessionId, prompt: [{ type: 'text', text: 'work' }] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const session = [...hub.sessions.values()][0]!;
    // The broker answers a permission request only for a session that is busy
    // with a submitted prompt; asking earlier is answered `deny` and creates no
    // interaction at all, which is a silent way for this case to test nothing.
    await settled(() => {
      const record = plugin.runtime.registry.getSession(created.output.sessionId);
      const turn = plugin.runtime.registry.getTurn(started.output.turnId);
      return record?.state === 'busy' && turn?.promptSubmitted === true && hub.sessions.size > 0;
    });
    // `requestPermission` is the path the engine really takes: it calls the
    // policy the runtime handed to `hub.session`, which is the broker's.
    void session.requestPermission({
      sessionId: session.id,
      engineId: 'codex',
      tool: 'read_file',
      input: { path: join(cwd, 'a.ts') },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never);
    await settled(() => plugin.runtime.registry.listInteractions().length > 0);
    const interaction = plugin.runtime.registry.listInteractions()[0]!;

    // Corrupt the stored record: reads clone and both permission producers
    // normalize, so this branch has no public path. The point of the case is
    // the pair — the caller is told INTERNAL, and the fault is on the record.
    const stored = (plugin.runtime.registry as unknown as { interactions: Map<string, { payload: unknown }> }).interactions.get(interaction.id)!;
    stored.payload = { sessionId: session.id, engineId: 'codex', tool: 'read_file', input: null };

    const answered = await plugin.invoke('interaction_respond', { interactionId: interaction.id, response: { optionId: 'allow-once' } });
    expect(answered).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    // The half a broker-level assertion cannot make: restoring the tool site's
    // STORE_ERROR gate leaves the caller's answer unchanged and this line gone.
    // No `sessionId` on the line: this call names an interaction, and the site
    // resolves an id only from `input.sessionId`. Asserting one would pin a
    // field the code does not produce here.
    expect(logs.filter((record) => ['store_error', 'internal_error', 'engine_error'].includes(record.event as string))).toMatchObject([
      { event: 'internal_error', errorCode: 'INTERNAL', operation: 'tool/interaction_respond' },
    ]);
  });

  it('a turn that fails for the engine deals no fault line at the drain site', async () => {
    const { plugin, hub, logs } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-fault-turnfail-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const started = await plugin.invoke('turn_start', { sessionId: created.output.sessionId, prompt: [{ type: 'text', text: 'work' }] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await settled(() => hub.sessions.size > 0 && plugin.runtime.registry.getTurn(started.output.turnId)?.promptSubmitted === true);
    [...hub.sessions.values()][0]!.rejectPrompt(new Error('the engine gave up'));
    await settled(() => plugin.runtime.registry.getTurn(started.output.turnId)?.state === 'failed');

    // The turn's own failure is an outcome, and `turn_transition` already
    // carries its code. Dealing a classified-fault line here as well would put
    // a second line under every failed turn — which is what a first attempt at
    // ADR 0030 did by passing the turn result's code through.
    expect(logs.filter((record) => ['store_error', 'internal_error', 'engine_error'].includes(record.event as string))).toEqual([]);
    expect(logs.some((record) => record.event === 'turn_transition' && record.to === 'failed')).toBe(true);
  });

  it('a watermark the drain cannot read is reported, and still degrades rather than failing the turn', async () => {
    const { plugin, hub, logs } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-fault-watermark-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const started = await plugin.invoke('turn_start', { sessionId: created.output.sessionId, prompt: [{ type: 'text', text: 'work' }] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await settled(() => hub.sessions.size > 0 && plugin.runtime.registry.getTurn(started.output.turnId)?.promptSubmitted === true);

    // The third way a drain fails, and the quietest: the watermark read is
    // swallowed into `beforeSeq`, so the drain reports the events it already
    // knows about and says nothing. The fallback is deliberate — the turn must
    // still settle — but silence about a store failure is not.
    const { store } = await plugin.runtime.ready;
    vi.spyOn(store, 'highWatermark').mockRejectedValue(new Error('watermark is unreadable'));
    [...hub.sessions.values()][0]!.resolvePrompt({ stopReason: 'end_turn', durationMs: 1 });
    await settled(() => plugin.runtime.registry.getTurn(started.output.turnId)?.state === 'completed');

    // The name and the code, not just the operation: an `internal_error` here
    // would mean the plugin failed to attribute a failure that is plainly the
    // store's, and asserting the operation alone would accept it.
    expect(logs.filter((record) => ['store_error', 'internal_error', 'engine_error'].includes(record.event as string))).toEqual([
      expect.objectContaining({
        event: 'store_error',
        errorCode: 'STORE_ERROR',
        operation: 'store/drain',
        sessionId: created.output.sessionId,
        turnId: started.output.turnId,
      }),
    ]);
    // The degradation the fallback promises: the drain reports the boundary it
    // started from rather than inventing a watermark it could not read.
    const settledTurn = await plugin.invoke('turn_get', { turnId: started.output.turnId });
    expect(settledTurn).toMatchObject({ ok: true, output: { state: 'completed', throughSeq: 0, fromSeq: null } });
    vi.restoreAllMocks();
  });

  it('API-018 at the tool boundary: a malformed question payload is engine_error', async () => {
    const { plugin, hub, logs } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-fault-question-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const started = await plugin.invoke('turn_start', { sessionId: created.output.sessionId, prompt: [{ type: 'text', text: 'work' }] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await settled(() => {
      const record = plugin.runtime.registry.getSession(created.output.sessionId);
      return record?.state === 'busy' && plugin.runtime.registry.getTurn(started.output.turnId)?.promptSubmitted === true && hub.sessions.size > 0;
    });
    const session = [...hub.sessions.values()][0]!;
    void session.requestQuestion({ requestId: 'q1', sessionId: session.id, engineId: 'codex', question: 'which one?', options: [] } as never);
    await settled(() => plugin.runtime.registry.listInteractions().some((entry) => entry.kind === 'question'));
    const interaction = plugin.runtime.registry.listInteractions().find((entry) => entry.kind === 'question')!;

    // Question requests are stored raw, so a shape the reader rejects is one an
    // engine really sent. The permission case is the other half and answers
    // INTERNAL; a single case covering only one of them would let the other's
    // classification be restored to STORE_ERROR unnoticed.
    const stored = (plugin.runtime.registry as unknown as { interactions: Map<string, { payload: unknown }> }).interactions.get(interaction.id)!;
    stored.payload = { requestId: 'q1', sessionId: session.id, engineId: 'codex' };

    const answered = await plugin.invoke('interaction_respond', { interactionId: interaction.id, response: { text: 'answer' } });
    expect(answered).toMatchObject({ ok: false, error: { code: 'ENGINE_ERROR' } });
    expect(logs.filter((record) => ['store_error', 'internal_error', 'engine_error'].includes(record.event as string))).toMatchObject([
      { event: 'engine_error', errorCode: 'ENGINE_ERROR', operation: 'tool/interaction_respond' },
    ]);
  });

  it('a drain failing while it reads a malformed stored event is logged too', async () => {
    const { plugin, hub, logs } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-fault-malformed-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const started = await plugin.invoke('turn_start', { sessionId: created.output.sessionId, prompt: [{ type: 'text', text: 'work' }] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const { store } = await plugin.runtime.ready;
    const realmSessionId = plugin.runtime.registry.getSession(created.output.sessionId)!.realmSessionId!;
    await store.append({ seq: 1, ts: 1, sessionId: realmSessionId, engineId: 'codex', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } as never);
    // Not the iterator: an event whose `update` is unreadable throws while the
    // drain builds `finalText`, one statement after the loop the first fix
    // wrapped. Three ways to fail a drain, and a boundary around one of them
    // reports a third of the failures.
    vi.spyOn(store, 'read').mockImplementation((() => (async function* () {
      yield { seq: 1, ts: 1, sessionId: realmSessionId, engineId: 'codex', get update(): never { throw new Error('unreadable event'); } };
    })()) as never);
    [...hub.sessions.values()][0]!.resolvePrompt({ stopReason: 'end_turn', durationMs: 1 });
    await settled(() => logs.some((record) => record.event === 'store_error' || record.event === 'internal_error'));

    expect(logs.filter((record) => ['store_error', 'internal_error', 'engine_error'].includes(record.event as string))).toEqual([
      expect.objectContaining({
        event: 'store_error',
        errorCode: 'STORE_ERROR',
        operation: 'store/drain',
        sessionId: created.output.sessionId,
        turnId: started.output.turnId,
      }),
    ]);
    vi.restoreAllMocks();
  });

  it('a store-classified tool fault still reaches the log (the half the gate used to cover)', async () => {
    const { plugin, logs } = await startWithFakeHub();
    // Removing the gate must not lose what the gate did report. A mutation that
    // skips only `STORE_ERROR` passes every other case in this file.
    vi.spyOn(plugin.runtime.registry, 'listSessions').mockImplementation(() => {
      throw Object.assign(new Error('the store is unwell'), { code: 'STORE_ERROR' });
    });
    const answer = await plugin.invoke('session_list', {});
    expect(answer).toMatchObject({ ok: false, error: { code: 'STORE_ERROR' } });
    expect(logs.filter((record) => ['store_error', 'internal_error', 'engine_error'].includes(record.event as string))).toEqual([
      expect.objectContaining({ event: 'store_error', errorCode: 'STORE_ERROR', operation: 'tool/session_list' }),
    ]);
    vi.restoreAllMocks();
  });

  it('a turn whose own result is a store failure still reports at turn/drain', async () => {
    const { plugin, hub, logs } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-fault-turnstore-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const started = await plugin.invoke('turn_start', { sessionId: created.output.sessionId, prompt: [{ type: 'text', text: 'work' }] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await settled(() => hub.sessions.size > 0 && plugin.runtime.registry.getTurn(started.output.turnId)?.promptSubmitted === true);
    // The narrow gate's positive half. Its companion case proves the gate must
    // not widen; without this one, deleting the gate outright passes both.
    [...hub.sessions.values()][0]!.rejectPrompt(Object.assign(new Error('the store is unwell'), { code: 'STORE_ERROR' }));
    await settled(() => plugin.runtime.registry.getTurn(started.output.turnId)?.state === 'failed');

    expect(logs.filter((record) => ['store_error', 'internal_error', 'engine_error'].includes(record.event as string))).toEqual([
      expect.objectContaining({
        event: 'store_error',
        errorCode: 'STORE_ERROR',
        operation: 'turn/drain',
        sessionId: created.output.sessionId,
        turnId: started.output.turnId,
      }),
    ]);
  });

  it('API-022: the retention and snapshot callbacks the runtime installed report through the same rule', async () => {
    const { plugin, logs } = await startWithFakeHub();
    const init = await plugin.runtime.ready;
    // Neither site can be driven end to end here, and for different reasons: a
    // snapshot write fails only for a filesystem this fixture should not
    // create, while the retention callback cannot fire in production at all —
    // `runRetention` swallows its own failure, so the scheduler's `onError`
    // never runs. That swallow is older than ADR 0030 and is not its to
    // remove. What is reachable is the thing that was wrong: the callback each
    // site installed, read off the objects the runtime built, so a site
    // rewired to log for itself again fails this.
    const retentionOnError = (plugin.runtime as unknown as { retention: { onError: (error: unknown) => void } }).retention.onError;
    retentionOnError(new Error('retention could not run'));
    const nannyOnError = (init.nanny as unknown as { options: { onError?: (error: unknown) => void } }).options.onError!;
    nannyOnError(new Error('snapshot could not be written'));

    // And again with a failure that classifies as the store's, because a
    // callback hardcoding `INTERNAL` passes the generic case: what is under
    // test is that each site passes the *mapped* code to the shared helper.
    retentionOnError(Object.assign(new Error('the store is unwell'), { code: 'STORE_ERROR' }));
    nannyOnError(Object.assign(new Error('the store is unwell'), { code: 'STORE_ERROR' }));

    const faults = logs.filter((record) => ['store_error', 'internal_error', 'engine_error'].includes(record.event as string));
    expect(faults).toEqual([
      expect.objectContaining({ event: 'internal_error', errorCode: 'INTERNAL', operation: 'retention/run' }),
      expect.objectContaining({ event: 'internal_error', errorCode: 'INTERNAL', operation: 'nanny/snapshot' }),
      expect.objectContaining({ event: 'store_error', errorCode: 'STORE_ERROR', operation: 'retention/run' }),
      expect.objectContaining({ event: 'store_error', errorCode: 'STORE_ERROR', operation: 'nanny/snapshot' }),
    ]);
  });

  it('API-022: a console/close failure is internal_error, not store_error', async () => {
    const { plugin, logs } = await startWithFakeHub();
    const init = await plugin.runtime.ready;
    // The console listener is not the store, and this site named the store for
    // it. `close()` is the only failure it has; an unattributable one is what
    // the plugin has to say about it.
    (init as { console?: { close: () => Promise<void> } }).console = { close: async () => { throw new Error('listener will not close'); } };
    await plugin.close();
    const faults = logs.filter((record) => ['store_error', 'internal_error', 'engine_error'].includes(record.event as string));
    expect(faults).toMatchObject([{ event: 'internal_error', errorCode: 'INTERNAL', operation: 'console/close' }]);
  });
});

describe('session lifecycle over a fake Realm hub', () => {
  it('writes the nanny snapshot for the live instance, carrying the turn and the dispatch count', async () => {
    // The writer has its own unit tests; what this pins is that the runtime
    // registers it at all. Nothing else would notice if it stopped: the hook
    // treats an absent snapshot as "nothing to report" and lets the user go
    // (ADR 0015 §4), so an unwired writer produces silence, not a failure.
    const { plugin, root } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-nanny-wired-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const started = await plugin.invoke('turn_start', { sessionId: created.output.sessionId, prompt: [{ type: 'text', text: 'work' }] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // Writes are deferred a microtask and then a file write; the fake prompt
    // never settles, so the turn stays active while we look.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const path = await findSnapshot(root);
    expect(path).toBeDefined();
    const snapshot = await readNannySnapshot(path!);
    expect(snapshot?.turnsDispatched).toBe(1);
    expect(snapshot?.active).toEqual([
      // cwd is the realpath the runtime resolved, not the string we passed in
      // (/var vs /private/var on darwin) - the snapshot carries what the
      // session actually runs in, which is what the hook filters on.
      expect.objectContaining({ turnId: started.output.turnId, sessionId: created.output.sessionId, engine: 'codex', cwd: expect.stringContaining(basename(cwd)) }),
    ]);
  });

  it('closes a session with a blocked turn: Realm close settles the prompt, no pre-close cancel', async () => {
    const { plugin, hub } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-session-cwd-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.output.sessionId;

    const started = await plugin.invoke('turn_start', { sessionId, prompt: [{ type: 'text', text: 'work' }] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // The fake prompt never settles on its own, so a close that waited for the
    // execution first would hang here.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const realm = [...hub.sessions.values()][0] as FakeRunskeinSession;
    expect(realm.promptCalls).toHaveLength(1);

    const closed = await Promise.race([
      plugin.invoke('session_close', { sessionId }),
      new Promise((resolve) => setTimeout(() => resolve('stuck'), 1_000)),
    ]);
    expect(closed).not.toBe('stuck');
    expect((closed as { ok: boolean; output?: { state: string } }).output?.state).toBe('closed');
    // §6.3: Realm close terminates the prompt; the plugin issues no cancel.
    expect(realm.cancelCalls).toHaveLength(0);
    expect(realm.closeCalls).toHaveLength(1);

    const turn = await plugin.invoke('turn_get', { turnId: started.output.turnId });
    expect(turn.ok).toBe(true);
    if (turn.ok) expect(turn.output.state).toBe('cancelled');

    const repeated = await plugin.invoke('session_close', { sessionId });
    expect(repeated.ok).toBe(true);
    expect(realm.closeCalls).toHaveLength(1);
  });

  it('releases the open-session slot when create fails before Realm produced a session', async () => {
    const { plugin, hub } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-session-describe-'));
    hub.failNextDescribe('codex', new Error('descriptor probe failed'));

    const failed = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(failed.ok).toBe(false);
    // A descriptor probe is a Realm round trip, so its generic failure is the
    // engine's and says so — it is mapped at the call, not at whichever tool
    // the caller happened to invoke (ADR 0027 decision 2(b)).
    if (!failed.ok) expect(failed.error.code).toBe('ENGINE_ERROR');
    // No hidden record, no burned slot (design §6.2.7).
    expect(plugin.runtime.registry.gate.snapshot().openSessions).toBe(0);
    const sessions = await plugin.invoke('session_list', {});
    if (sessions.ok) expect(sessions.output.sessions).toHaveLength(0);

    const retried = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(retried.ok).toBe(true);
  });

  it('keeps a create failure that may have left an engine child visible and closable', async () => {
    const { plugin, hub } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-session-start-'));
    const startFailure = new Error('engine start failed');
    startFailure.name = 'EngineStartError';
    hub.failNextSession(startFailure);

    const failed = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(failed.ok).toBe(false);
    const sessions = await plugin.invoke('session_list', {});
    expect(sessions.ok).toBe(true);
    if (!sessions.ok) return;
    expect(sessions.output.sessions).toHaveLength(1);
    const stranded = sessions.output.sessions[0]!;
    expect(stranded.state).toBe('failed');
    expect(plugin.runtime.registry.gate.snapshot().openSessions).toBe(1);

    const closed = await plugin.invoke('session_close', { sessionId: stranded.sessionId });
    expect(closed.ok).toBe(true);
    expect(plugin.runtime.registry.gate.snapshot().openSessions).toBe(0);
  });

  it('fails the create when an engine crash claims the record mid-build', async () => {
    const { plugin, hub } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-session-crash-'));
    // Hold hub.session() open, then project the engine crash the way §6.2 does.
    const originalSession = hub.session.bind(hub);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    (hub as unknown as { session: typeof hub.session }).session = async (options) => {
      const created = await originalSession(options);
      await held;
      return created;
    };

    const creating = plugin.invoke('session_create', { engine: 'codex', cwd });
    await new Promise((resolve) => setTimeout(resolve, 20));
    plugin.runtime.registry.markEngineCrashed('codex', { code: 'ENGINE_ERROR', message: 'engine codex crashed' });
    release();

    const result = await creating;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ENGINE_ERROR');
    // The failed record stays visible and closable; no success payload was faked.
    const sessions = await plugin.invoke('session_list', {});
    expect(sessions.ok).toBe(true);
    if (!sessions.ok) return;
    expect(sessions.output.sessions.map((session) => session.state)).toEqual(['failed']);
    // §6.2.7: the explicit close is the cleanup point, so the Realm session it
    // may still own has to be reachable from it.
    const realm = [...hub.sessions.values()][0] as FakeRunskeinSession;
    expect(realm.closeCalls).toHaveLength(0);
    const closed = await plugin.invoke('session_close', { sessionId: sessions.output.sessions[0]!.sessionId });
    expect(closed.ok).toBe(true);
    expect(realm.closeCalls).toHaveLength(1);
    expect(plugin.runtime.registry.gate.snapshot().openSessions).toBe(0);
  });

  it('records fork lineage as parentSessionId on the child (console-design §5.5)', async () => {
    const { plugin } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-session-lineage-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const forked = await plugin.invoke('session_fork', { sessionId: created.output.sessionId });
    expect(forked.ok).toBe(true);
    if (!forked.ok) return;

    const records = plugin.runtime.registry.listSessions();
    const child = records.find((session) => session.id === forked.output.sessionId);
    const parent = records.find((session) => session.id === created.output.sessionId);
    expect(child?.parentSessionId).toBe(created.output.sessionId);
    // session_create is a known root: null, never "unknown" (§10.1).
    expect(parent?.parentSessionId).toBeNull();
  });

  it('snapshots engine capabilities so fork and rich prompt blocks are allowed', async () => {
    const { plugin, hub } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-session-fork-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd, config: { model: 'fast' } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Hold the child's config replay open and assert that nothing observes the
    // child until the replay completed.
    const parent = [...hub.sessions.values()][0] as FakeRunskeinSession;
    const originalFork = parent.fork.bind(parent);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let childSession: FakeRunskeinSession | undefined;
    (parent as unknown as { fork: () => Promise<FakeRunskeinSession> }).fork = async () => {
      childSession = await originalFork();
      const originalSetConfig = childSession.setConfig.bind(childSession);
      (childSession as unknown as { setConfig: (patch: Record<string, string | boolean>) => Promise<void> }).setConfig = async (patch) => {
        await held;
        await originalSetConfig(patch);
      };
      return childSession;
    };

    const forking = plugin.invoke('session_fork', { sessionId: created.output.sessionId, name: 'child' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const midFork = await plugin.invoke('session_list', {});
    expect(midFork.ok).toBe(true);
    if (midFork.ok) expect(midFork.output.sessions).toHaveLength(1);
    // Nothing else may leak the half-built child either.
    const midTranscripts = await plugin.invoke('transcript_list', {});
    expect(midTranscripts.ok).toBe(true);
    if (midTranscripts.ok) expect(midTranscripts.output.transcripts).toHaveLength(1);
    const childId = plugin.runtime.registry.listSessions().find((session) => session.state === 'creating')?.id;
    expect(childId).toBeDefined();
    const leaked = await plugin.invoke('session_get', { sessionId: childId! });
    expect(leaked.ok).toBe(false);
    if (!leaked.ok) expect(leaked.error.code).toBe('NOT_FOUND');
    release();

    const forked = await forking;
    expect(forked.ok).toBe(true);
    if (!forked.ok) return;
    expect(forked.output.sessionId).not.toBe(created.output.sessionId);
    expect(forked.output.config).toEqual({ model: 'fast' });
    // The child's config was replayed key by key before it became visible.
    expect(childSession?.setConfigCalls).toEqual([{ model: 'fast' }]);
    const afterFork = await plugin.invoke('session_list', {});
    if (afterFork.ok) expect(afterFork.output.sessions).toHaveLength(2);

    const withImage = await plugin.invoke('turn_start', {
      sessionId: created.output.sessionId,
      prompt: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
    });
    expect(withImage.ok).toBe(true);
    const withLink = await plugin.invoke('turn_start', {
      sessionId: created.output.sessionId,
      prompt: [{ type: 'resource_link', name: 'spec', uri: 'file:///tmp/spec.md' }],
    });
    expect(withLink.ok).toBe(true);
  });

  it('leaves a crashed fork child closable instead of closing it blind', async () => {
    const { plugin, hub } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-session-fork-crash-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd, config: { model: 'a' } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const parent = [...hub.sessions.values()][0] as FakeRunskeinSession;
    const originalFork = parent.fork.bind(parent);
    let child: FakeRunskeinSession | undefined;
    (parent as unknown as { fork: () => Promise<FakeRunskeinSession> }).fork = async () => {
      child = await originalFork();
      const originalSetConfig = child.setConfig.bind(child);
      (child as unknown as { setConfig: (patch: Record<string, string | boolean>) => Promise<void> }).setConfig = async (patch) => {
        // The engine crashes while the child's config is being replayed.
        plugin.runtime.registry.markEngineCrashed('codex', { code: 'ENGINE_ERROR', message: 'engine codex crashed' });
        await originalSetConfig(patch);
      };
      return child;
    };

    const forked = await plugin.invoke('session_fork', { sessionId: created.output.sessionId });
    expect(forked.ok).toBe(false);
    expect(child?.closeCalls ?? []).toHaveLength(0);
    const sessions = await plugin.invoke('session_list', {});
    expect(sessions.ok).toBe(true);
    if (!sessions.ok) return;
    const failedChild = sessions.output.sessions.find((session) => session.sessionId !== created.output.sessionId);
    expect(failedChild?.state).toBe('failed');

    const closed = await plugin.invoke('session_close', { sessionId: failedChild!.sessionId });
    expect(closed.ok).toBe(true);
    // The explicit close is the child's single cleanup point (§6.2.7).
    expect(child?.closeCalls).toHaveLength(1);
  });

  it('keeps a fork child invisible until its config replay finished', async () => {
    const { plugin, hub } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-session-fork-config-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd, config: { model: 'a' } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const parent = [...hub.sessions.values()][0] as FakeRunskeinSession;
    // Fork itself succeeds; the config replay is what fails.
    const originalFork = parent.fork.bind(parent);
    let child: FakeRunskeinSession | undefined;
    (parent as unknown as { fork: () => Promise<FakeRunskeinSession> }).fork = async () => {
      child = await originalFork();
      child.failNextConfig(new Error('config rejected'));
      return child;
    };

    const failed = await plugin.invoke('session_fork', { sessionId: created.output.sessionId });
    expect(failed.ok).toBe(false);
    expect(child?.closeCalls).toHaveLength(1);
    const sessions = await plugin.invoke('session_list', {});
    expect(sessions.ok).toBe(true);
    // No half-built child is externally visible — not even as a closed record.
    if (sessions.ok) expect(sessions.output.sessions).toHaveLength(1);
    expect(plugin.runtime.registry.gate.snapshot().openSessions).toBe(1);
    const transcripts = await plugin.invoke('transcript_list', {});
    if (transcripts.ok) expect(transcripts.output.transcripts).toHaveLength(1);

    parent.failNextFork(new Error('fork rejected'));
    const rejected = await plugin.invoke('session_fork', { sessionId: created.output.sessionId });
    expect(rejected.ok).toBe(false);
    expect(plugin.runtime.registry.gate.snapshot().openSessions).toBe(1);
  });
});

describe('structured observability (design §15)', () => {
  it('emits the lifecycle event set across a session, a turn and shutdown', async () => {
    const { plugin, hub, logs } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-observability-'));
    await plugin.runtime.startupDiagnostics();

    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.output.sessionId;
    const started = await plugin.invoke('turn_start', { sessionId, prompt: [{ type: 'text', text: 'do the work' }] });
    expect(started.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const realm = [...hub.sessions.values()][0] as FakeRunskeinSession;
    realm.resolvePrompt({ stopReason: 'end_turn', durationMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await plugin.invoke('session_close', { sessionId });
    await plugin.close();

    const names = new Set(logs.map((record) => record.event));
    for (const expected of ['instance_started', 'retention_result', 'session_transition', 'turn_transition', 'shutdown_result']) {
      expect(names, `missing ${expected}`).toContain(expected);
    }

    // Where the outer boundary came from, on the one line that carries start-up
    // facts (ADR 0025). This harness injects `hostCwd`, so the honest answer is
    // `option` — reporting `cwd` would put the process working directory's name
    // on a decision it did not make.
    const startup = logs.find((record) => record.event === 'instance_started');
    expect(startup?.['hostCwdSource']).toBe('option');

    const sessionEvents = logs.filter((record) => record.event === 'session_transition' && record['sessionId'] === sessionId);
    expect(sessionEvents.map((record) => `${String(record['from'])}->${String(record['to'])}`)).toEqual(['creating->idle', 'idle->busy', 'busy->idle', 'idle->closing', 'closing->closed']);
    expect(sessionEvents.every((record) => record['engine'] === 'codex' && typeof record['operation'] === 'string')).toBe(true);

    const turnEvents = logs.filter((record) => record.event === 'turn_transition');
    expect(turnEvents.map((record) => String(record['to']))).toEqual(['running', 'completed']);
    expect(turnEvents.every((record) => record['turnId'] === (started.ok ? started.output.turnId : ''))).toBe(true);
    // The terminal transition carries how long the turn ran.
    expect(typeof turnEvents.at(-1)!['durationMs']).toBe('number');

    const shutdown = logs.find((record) => record.event === 'shutdown_result')!;
    expect(shutdown['quitCalls']).toBe(1);
    expect(typeof shutdown['durationMs']).toBe('number');

    // No prompt text, transcript body, cwd or nonce ever reaches a log line.
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain('do the work');
    expect(serialized).not.toContain(cwd);
    expect(serialized).not.toContain(plugin.runtime.config.allowedRoots[0]!.slice(1));
  });

  it('reports an engine crash and keeps every record on stderr-shaped fields', async () => {
    const { plugin, logs } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-observability-crash-'));
    expect((await plugin.invoke('session_create', { engine: 'codex', cwd })).ok).toBe(true);
    plugin.runtime.registry.markEngineCrashed('codex', { code: 'ENGINE_ERROR', message: 'engine codex crashed' });

    const failure = logs.find((record) => record.event === 'session_transition' && record['to'] === 'failed');
    expect(failure).toBeDefined();
    expect(failure!['errorCode']).toBe('ENGINE_ERROR');
    for (const record of logs) {
      expect(Object.values(record).every((value) => ['string', 'number', 'boolean'].includes(typeof value))).toBe(true);
    }
  });
});

/** A minimal engine-reported update carrying a sessionUpdate discriminator. */
function obsUpdate(sessionUpdate: string): TranscriptEvent {
  return { seq: 1, ts: 1, sessionId: 's', engineId: 'codex', update: { sessionUpdate } as TranscriptEvent['update'] } as TranscriptEvent;
}

/**
 * The session observation face (ADR 0020 / design §8.1, SES-026..033).
 * These pin the refresh mechanism from the runtime-session tests: the fake
 * Realm session's synchronous getters (usage/configState) are fed directly, the
 * same way a real engine reports them, and the subscription/refresh timing is
 * what each fixture is written to catch.
 */
describe('session observations (ADR 0020, design §8.1)', () => {
  it('SES-026 carries cumulative usage on session_get and session_list, growing across turns', async () => {
    const { plugin, hub } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-obs-usage-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.output.sessionId;
    const realm = [...hub.sessions.values()][0] as FakeRunskeinSession;

    // First turn reports 150 tokens, second reports 300. A snapshot-at-creation
    // implementation would read 0 both times; a real one reads the growth.
    realm.setUsage({ input: 100, output: 50, total: 150 });
    realm.emitUpdate(obsUpdate('usage_update'));
    const first = await plugin.invoke('session_get', { sessionId });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.output.usage).toEqual({ input: 100, output: 50, total: 150 });
    const list = await plugin.invoke('session_list', {});
    if (list.ok) {
      expect(list.output.sessions.find((s) => s.sessionId === sessionId)?.usage).toEqual({ input: 100, output: 50, total: 150 });
    }

    realm.setUsage({ input: 200, output: 100, total: 300 });
    realm.emitUpdate(obsUpdate('usage_update'));
    const second = await plugin.invoke('session_get', { sessionId });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.output.usage).toEqual({ input: 200, output: 100, total: 300 });
    expect(second.output.usage?.total).toBe(300);
  });

  it('SES-027 reports observed config keys and never falls back to desired', async () => {
    const { plugin, hub } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-obs-config-'));
    // The desired config is written at create; the engine reports only `model`.
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd, config: { model: 'fast' } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.output.sessionId;
    const realm = [...hub.sessions.values()][0] as FakeRunskeinSession;

    realm.setObservedConfig({ model: { value: 'sonnet', source: 'config_option_update', observedAt: 2_000 } });
    realm.emitUpdate(obsUpdate('config_option_update'));
    const reported = await plugin.invoke('session_get', { sessionId });
    expect(reported.ok).toBe(true);
    if (!reported.ok) return;
    expect(reported.output.observedConfig).toEqual({ model: { value: 'sonnet', source: 'config_option_update', observedAt: new Date(2_000).toISOString() } });
    // The engine's report never touches what was asked for.
    expect(reported.output.config).toEqual({ model: 'fast' });

    // A desired key the engine never reported stays out of observedConfig —
    // the absent key means the engine did not say, and must not read as the
    // engine agreeing with config (mvp §10.6 / design §5.1). A fallback
    // implementation that copies desired into observed would put
    // `reasoningEffort` here and fail this assertion.
    const configured = await plugin.invoke('session_configure', { sessionId, config: { reasoningEffort: 'high' } });
    expect(configured.ok).toBe(true);
    if (!configured.ok) return;
    expect(configured.output.config).toEqual({ model: 'fast', reasoningEffort: 'high' });
    expect(configured.output.observedConfig).toEqual({ model: { value: 'sonnet', source: 'config_option_update', observedAt: new Date(2_000).toISOString() } });
  });

  it('SES-028 keeps the close-time snapshot on a closed session, over a silent getter change', async () => {
    const { plugin, hub } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-obs-close-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.output.sessionId;
    const realm = [...hub.sessions.values()][0] as FakeRunskeinSession;

    // Last subscription-driven refresh: the record lands at 100.
    realm.setUsage({ total: 100 });
    realm.emitUpdate(obsUpdate('usage_update'));
    // THE GAP: the getter changes to 200 but NO update is emitted. Only the
    // close-time refresh (design §4.3 point 3) can pick up the 200 — a missing
    // close refresh leaves the record at 100 and this assertion fails.
    realm.setUsage({ total: 200 });
    const closed = await plugin.invoke('session_close', { sessionId });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.output.usage).toEqual({ total: 200 });

    const after = await plugin.invoke('session_get', { sessionId });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.output.usage).toEqual({ total: 200 });
    // The closed snapshot no longer changes, whatever the getter reports.
    realm.setUsage({ total: 999 });
    const frozen = await plugin.invoke('session_get', { sessionId });
    if (frozen.ok) expect(frozen.output.usage).toEqual({ total: 200 });
  });

  it('SES-029 forks with config inherited but observations empty and usage zero', async () => {
    const { plugin, hub } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-obs-fork-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd, config: { model: 'fast' } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const parentId = created.output.sessionId;
    const parent = [...hub.sessions.values()][0] as FakeRunskeinSession;
    // The parent must already carry non-empty observations before the fork, or
    // a copy-the-parent implementation would pass on an empty parent.
    parent.setObservedConfig({ model: { value: 'sonnet', source: 'session/new', observedAt: 1_000 } });
    parent.setUsage({ total: 500 });
    parent.emitUpdate(obsUpdate('config_option_update'));

    const forked = await plugin.invoke('session_fork', { sessionId: parentId });
    expect(forked.ok).toBe(true);
    if (!forked.ok) return;
    expect(forked.output.config).toEqual({ model: 'fast' });
    // The child is a new engine session: it inherits nothing the parent observed
    // (design §5.3 / mvp §10.6) — observedConfig stays absent and usage is zero
    // until the child itself reports usage.
    expect(forked.output.observedConfig).toBeUndefined();
    expect(forked.output.usage).toBeUndefined();
    const child = [...hub.sessions.values()].find((s) => s.id !== parent.id)!;
    expect(child.configState().observed).toEqual({});
    expect(child.usage()).toEqual({});
  });

  it('SES-034 contains a refresh that cannot complete, on both the subscription and the configure path', async () => {
    const { plugin, hub } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-obs-contain-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd, config: { model: 'fast' } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.output.sessionId;
    const realm = [...hub.sessions.values()][0] as FakeRunskeinSession;
    realm.setUsage({ total: 100 });
    realm.emitUpdate(obsUpdate('usage_update'));

    // A getter that throws must not escape into Realm's dispatch, and must not
    // clear what was last observed.
    realm.failNextUsageRead(new Error('session torn down under the getter'));
    expect(() => realm.emitUpdate(obsUpdate('usage_update'))).not.toThrow();
    const afterThrow = await plugin.invoke('session_get', { sessionId });
    expect(afterThrow.ok).toBe(true);
    if (!afterThrow.ok) return;
    expect(afterThrow.output.usage).toEqual({ total: 100 });

    // The sharper path: setConfig has already succeeded on the wire when the
    // refresh runs, so a throw here would report a failure for a configure the
    // engine had applied.
    realm.failNextUsageRead(new Error('session torn down under the getter'));
    const configured = await plugin.invoke('session_configure', { sessionId, config: { model: 'slow' } });
    expect(configured.ok).toBe(true);
    if (!configured.ok) return;
    expect(configured.output.config).toEqual({ model: 'slow' });

    // An observation whose timestamp cannot be expressed is dropped, not
    // carried undated: new Date(NaN).toISOString() throws.
    realm.setObservedConfig({
      model: { value: 'sonnet', source: 'config_option_update', observedAt: Number.NaN },
      reasoning: { value: 'high', source: 'config_option_update', observedAt: 2_000 },
    });
    realm.emitUpdate(obsUpdate('config_option_update'));
    const afterNaN = await plugin.invoke('session_get', { sessionId });
    expect(afterNaN.ok).toBe(true);
    if (!afterNaN.ok) return;
    expect(afterNaN.output.observedConfig).toEqual({
      reasoning: { value: 'high', source: 'config_option_update', observedAt: new Date(2_000).toISOString() },
    });
  });

  it('SES-030 silently skips a refresh with no live session, keeping the old record', async () => {
    const { plugin, hub } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-obs-detach-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.output.sessionId;
    const realm = [...hub.sessions.values()][0] as FakeRunskeinSession;
    realm.setUsage({ total: 100 });
    realm.emitUpdate(obsUpdate('usage_update'));
    await plugin.invoke('session_close', { sessionId });

    // The binding is gone; a refresh must be a no-op that preserves the record.
    const runtime = plugin.runtime as unknown as { syncSessionObservations(id: string): void };
    expect(() => runtime.syncSessionObservations(sessionId)).not.toThrow();
    const after = await plugin.invoke('session_get', { sessionId });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.output.usage).toEqual({ total: 100 });
  });

  it('SES-031 refreshes on an idle-period engine report, with no turn or configure', async () => {
    const { plugin, hub } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-obs-idle-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.output.sessionId;
    const realm = [...hub.sessions.values()][0] as FakeRunskeinSession;
    // The session sits idle: no turn is started, no configure runs, no close.
    // Only the subscription can make this report visible (design §4.2) — a
    // discrete-refresh-points implementation never sees it.
    realm.setObservedConfig({ mode: { value: 'fast', source: 'config_option_update', observedAt: 3_000 } });
    realm.emitUpdate(obsUpdate('config_option_update'));
    const idle = await plugin.invoke('session_get', { sessionId });
    expect(idle.ok).toBe(true);
    if (!idle.ok) return;
    expect(idle.output.observedConfig).toEqual({ mode: { value: 'fast', source: 'config_option_update', observedAt: new Date(3_000).toISOString() } });
  });

  it('SES-035 picks up a token report that arrives with no emitted update, when the turn settles', async () => {
    const { plugin, hub } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-obs-turn-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.output.sessionId;
    const realm = [...hub.sessions.values()][0] as FakeRunskeinSession;

    const started = await plugin.invoke('turn_start', { sessionId, prompt: [{ type: 'text', text: 'work' }] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await settled(() => realm.pendingPromptCount() === 1);

    // The shape measured on codex: the engine's own gauge emits while the token
    // counts do not exist yet, and the counts then land through Realm's
    // synthesized usage_update, which is persisted but never emitted. Only a
    // refresh at the settled turn can see them.
    realm.emitUpdate(obsUpdate('usage_update'));
    realm.setUsage({ input: 11_999, output: 5, total: 23_012 });
    realm.resolvePrompt({ stopReason: 'end_turn', durationMs: 1 });
    await settled(async () => {
      const turn = await plugin.invoke('turn_get', { turnId: started.output.turnId });
      return turn.ok && turn.output.state !== 'running' && turn.output.state !== 'queued';
    });

    // Read while the session is still open: closing would refresh anyway, which
    // is exactly the state that hid this gap — a live session showed nothing
    // and the same session showed the total the moment it closed.
    const open = await plugin.invoke('session_get', { sessionId });
    expect(open.ok).toBe(true);
    if (!open.ok) return;
    expect(open.output.state).toBe('idle');
    expect(open.output.usage).toEqual({ input: 11_999, output: 5, total: 23_012 });
  });

  it('SES-036 still picks up the token report when the drain\'s transcript read fails', async () => {
    const { plugin, hub } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-obs-drainfail-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.output.sessionId;
    const realm = [...hub.sessions.values()][0] as FakeRunskeinSession;

    // The store fails for the whole drain. The refresh reads the live session's
    // getters and needs nothing from the transcript, so a drain that cannot
    // read must not cost the session its usage — ordering the refresh after the
    // read would lose it exactly when a store is in trouble.
    const started = await plugin.invoke('turn_start', { sessionId, prompt: [{ type: 'text', text: 'work' }] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await settled(() => realm.pendingPromptCount() === 1);

    // Broken only once the turn is in flight, so the dispatch keeps the
    // watermark it really captured; the drain then believes there are events to
    // read and cannot read them. Patching before dispatch would leave
    // `throughSeq === beforeSeq` and skip the read altogether — the fake engine
    // writes no transcript — and the fixture would prove nothing.
    const init = await plugin.runtime.ready;
    const store = init.store as unknown as { highWatermark: unknown; read: unknown };
    store.highWatermark = async () => 5;
    store.read = () => { throw new Error('store is unavailable'); };

    realm.setUsage({ input: 7, output: 3, total: 10 });
    realm.resolvePrompt({ stopReason: 'end_turn', durationMs: 1 });
    await settled(async () => {
      const turn = await plugin.invoke('turn_get', { turnId: started.output.turnId });
      return turn.ok && turn.output.state !== 'running' && turn.output.state !== 'queued';
    });

    const open = await plugin.invoke('session_get', { sessionId });
    expect(open.ok).toBe(true);
    if (!open.ok) return;
    expect(open.output.usage).toEqual({ input: 7, output: 3, total: 10 });
  });

  it('SES-032 carries refreshed values in the create and configure responses themselves', async () => {
    const { plugin, hub } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-obs-respond-'));
    // Pre-seed the session the hub is about to create: the create response
    // (from publishSession) must carry it, which only holds if the refresh runs
    // before the response record is taken (design §4.4).
    const originalSession = hub.session.bind(hub);
    (hub as unknown as { session: typeof hub.session }).session = async (options) => {
      const s = await originalSession(options);
      s.setObservedConfig({ model: { value: 'fast', source: 'session/new', observedAt: 1_000 } });
      s.setUsage({ total: 10 });
      return s;
    };
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.output.observedConfig).toEqual({ model: { value: 'fast', source: 'session/new', observedAt: new Date(1_000).toISOString() } });
    expect(created.output.usage).toEqual({ total: 10 });

    // Configure: the response must carry the refreshed observation immediately.
    const realm = [...hub.sessions.values()][0] as FakeRunskeinSession;
    realm.setObservedConfig({ model: { value: 'sonnet', source: 'config_option_update', observedAt: 2_000 } });
    const configured = await plugin.invoke('session_configure', { sessionId: created.output.sessionId, config: { model: 'sonnet' } });
    expect(configured.ok).toBe(true);
    if (!configured.ok) return;
    // The wire setConfig ran; the loop's per-key refresh picked up the observed
    // report, so the very response carries it (design §4.4), not the next get.
    expect(configured.output.observedConfig).toEqual({ model: { value: 'sonnet', source: 'config_option_update', observedAt: new Date(2_000).toISOString() } });
  });

  it('SES-033 reflects a resume/reactivation as rebuilt observations, not the old ones', async () => {
    const { plugin, hub } = await startWithFakeHub();
    const cwd = await mkdtemp(join(tmpdir(), 'taskshuttle-obs-resume-'));
    const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.output.sessionId;
    const realm = [...hub.sessions.values()][0] as FakeRunskeinSession;

    // Pre-resume state is in the record.
    realm.setObservedConfig({ model: { value: 'old', source: 'session/new', observedAt: 1_000 } });
    realm.setUsage({ total: 100 });
    realm.emitUpdate(obsUpdate('config_option_update'));

    // Resume: adoptBinding writes the rebuilt creation state, then emits
    // `reactivated` — NOT an `update`. Only the reactivated subscription picks
    // this up (design §4.2); an update-only subscription leaves the old values.
    realm.setObservedConfig({ model: { value: 'new', source: 'session/resume', observedAt: 9_000 } });
    realm.setUsage({ total: 300 });
    realm.emitReactivated({ tier: 'native' });
    const resumed = await plugin.invoke('session_get', { sessionId });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.output.observedConfig).toEqual({ model: { value: 'new', source: 'session/resume', observedAt: new Date(9_000).toISOString() } });
    expect(resumed.output.usage).toEqual({ total: 300 });
  });
});
