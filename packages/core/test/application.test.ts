import { describe, expect, it } from 'vitest';
import { createCoreApplication, narrowWorkspacePath, mergeWorkerDefaults, validateAnchorContent, SessionRegistry, type AgentProvider, type CoreEnvironment, type TranscriptEvent } from '../src/index.js';

function environment(overrides: Partial<AgentProvider> = {}): CoreEnvironment {
  const events: TranscriptEvent[] = [];
  let idSequence = 0;
  const agents: AgentProvider = {
    inventory: async () => ({ agents: [{ id: 'codex', capabilities: ['session.fork'] }] }),
    describe: async (engine) => ({ id: engine, capabilities: ['session.fork'] }),
    createSession: async () => ({ providerSessionId: 'provider-session' }),
    forkSession: async () => ({ providerSessionId: 'provider-child' }),
    closeSession: async () => undefined,
    ...overrides,
  };
  return {
    clock: { now: () => 1_700_000_000_000 },
    ids: { next: (kind) => `${kind}-generated-${++idSequence}` },
    agents,
    transcripts: {
      append: async (event) => { events.push(event); },
      async *read() { yield* events; },
    },
    anchors: { read: async () => undefined, write: async () => undefined },
  };
}

describe('@taskshuttle/core application services', () => {
  it('creates, forks, configures, and closes through provider-neutral ports', async () => {
    const app = createCoreApplication(environment(), { instanceId: 'instance-1' });
    const created = await app.sessions.create({ engine: 'codex', cwd: '/work' });
    expect(created).toMatchObject({ ok: true, value: { sessionId: 'session-generated-1', providerSessionId: 'provider-session', state: 'idle' } });
    const configured = await app.sessions.configure('session-generated-1', { config: { model: 'fast' } });
    expect(configured).toMatchObject({ ok: true, value: { config: { model: 'fast' } } });
    const forked = await app.sessions.fork({ sessionId: 'session-generated-1', name: 'child' });
    expect(forked).toMatchObject({ ok: true, value: { parentSessionId: 'session-generated-1', providerSessionId: 'provider-child' } });
    const closed = await app.sessions.close('session-generated-1');
    expect(closed).toMatchObject({ ok: true, value: { state: 'closed' } });
    await app.close();
  });

  it('uses Core scheduling and immutable turn projections when an executor is injected', async () => {
    const app = createCoreApplication(environment(), {
      instanceId: 'instance-2',
      executor: {
        beforePrompt: () => 0,
        run: async () => ({}),
        cancel: async () => undefined,
        drain: async () => ({ fromSeq: null, throughSeq: 0 }),
      },
    });
    const session = await app.sessions.create({ engine: 'codex', cwd: '/work' });
    const started = app.turns.start({ sessionId: session.ok ? session.value.sessionId : 'missing', prompt: [{ type: 'text', text: 'hello' }] });
    expect(started).toMatchObject({ ok: true, value: { status: 'queued' } });
    if (started.ok) expect(Object.isFrozen(app.turns.get(started.value.turnId).value)).toBe(true);
    await app.close();
  });

  it('keeps opaque anchor and policy decisions in Core without opening files', () => {
    expect(validateAnchorContent('a')).toEqual({ ok: true, value: 'a' });
    expect(validateAnchorContent('x'.repeat(16_385))).toMatchObject({ ok: false, error: { code: 'payload-too-large' } });
    expect(narrowWorkspacePath('/work/project/src', '/work/project')).toEqual({ ok: true, value: '/work/project/src' });
    expect(narrowWorkspacePath('/work/other', '/work/project')).toMatchObject({ ok: false, error: { code: 'workspace-forbidden' } });
    expect(mergeWorkerDefaults({ config: { model: 'base', effort: 'normal' }, engineConfig: { codex: { model: 'engine' } } }, 'codex', { model: 'explicit' })).toEqual({ model: 'explicit', effort: 'normal' });
  });

  it('retains a failed provider creation as a failed session so the reservation is explicit', async () => {
    const app = createCoreApplication(environment({
      createSession: async () => ({ operation: 'session/create', message: 'provider was unavailable', code: 'provider-failure' }),
    }), { instanceId: 'instance-failed', limits: { maxOpenSessions: 1 } });
    const created = await app.sessions.create({ engine: 'codex', cwd: '/work' });
    expect(created).toMatchObject({ ok: false, error: { code: 'provider-failure' } });
    expect(app.sessions.list()).toMatchObject([{ state: 'failed', failure: { code: 'provider-failure' } }]);
    await expect(app.sessions.create({ engine: 'codex', cwd: '/work/second' })).resolves.toMatchObject({ ok: false, error: { code: 'capacity-exceeded' } });
    expect('registry' in app).toBe(false);
    await app.close();
  });

  it('discards a provider refusal proven to precede spawn and makes the reservation reusable', async () => {
    let attempts = 0;
    const app = createCoreApplication(environment({
      createSession: async () => attempts++ === 0
        ? { operation: 'session/create', message: 'configuration refused before spawn', code: 'invalid-input', preSpawn: true }
        : { providerSessionId: 'provider-session-2' },
    }), { instanceId: 'instance-pre-spawn', limits: { maxOpenSessions: 1 } });
    const refused = await app.sessions.create({ engine: 'codex', cwd: '/work' });
    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
    expect(app.sessions.list()).toEqual([]);
    await expect(app.sessions.create({ engine: 'codex', cwd: '/work/second' })).resolves.toMatchObject({ ok: true, value: { state: 'idle' } });
    await app.close();
  });

  it('resolves an interaction by Core id without interpreting provider separators', async () => {
    let response: string | undefined;
    const registry = new SessionRegistry({ instanceId: 'interaction-id' });
    expect(registry.createSession({ id: 'session-1', engine: 'codex', cwd: '/work' }).ok).toBe(true);
    expect(registry.markSessionReady('session-1', 'provider-session').ok).toBe(true);
    expect(registry.createTurn('session-1', { id: 'turn-1', prompt: [{ type: 'text', text: 'ask' }] }).ok).toBe(true);
    expect(registry.startTurn('turn-1').ok).toBe(true);
    const app = createCoreApplication(environment({
      respondInteraction: async (value) => { response = value.providerRequestId; },
    }), { instanceId: 'interaction-id', registry });
    expect(registry.addInteraction('turn-1', { id: 'interaction-1', kind: 'question', payload: { question: 'pick' }, realmQuestionRequestId: 'provider:question:request:with:separators' }).ok).toBe(true);
    const resolved = await app.interactions.respond({ interactionId: 'interaction-1', providerRequestId: 'provider:question:request:with:separators', value: { text: 'yes' } });
    expect(resolved).toMatchObject({ ok: true, value: { interactionId: 'interaction-1', state: 'responded' } });
    expect(response).toBe('provider:question:request:with:separators');
    await app.close();
  });

  it('joins concurrent closes and drains transcript writes before completing the close', async () => {
    let closeCalls = 0;
    let drainCalls = 0;
    let releaseProvider!: () => void;
    const providerReleased = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const app = createCoreApplication(environment({
      closeSession: async () => { closeCalls += 1; await providerReleased; },
    }), { instanceId: 'instance-close' });
    const session = await app.sessions.create({ engine: 'codex', cwd: '/work' });
    expect(session.ok).toBe(true);
    const sessionId = session.ok ? session.value.sessionId : 'missing';
    const originalEnvironment = app.environment;
    // The repository is an injected port; replace only the optional barrier
    // in this test fixture to make the ordering observable.
    (originalEnvironment.transcripts as { drain?: (id: string) => Promise<void> }).drain = async () => { drainCalls += 1; };
    const first = app.sessions.close(sessionId);
    const second = app.sessions.close(sessionId);
    expect(first).toBe(second);
    releaseProvider();
    await expect(Promise.all([first, second])).resolves.toMatchObject([{ ok: true, value: { state: 'closed' } }, { ok: true, value: { state: 'closed' } }]);
    expect(closeCalls).toBe(1);
    expect(drainCalls).toBe(1);
    await app.close();
  });
});
