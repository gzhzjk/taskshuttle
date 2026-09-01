import { describe, expect, it } from 'vitest';

import { InteractionBroker, normalizePermissionRequest } from '../../packages/plugin/src/interaction-broker.js';
import { SessionRegistry } from '../../packages/core/src/registry.js';
import { FakeRunskeinSession } from '../../packages/plugin/src/testkit/fake-runskein.js';

const permissionRequest = {
  sessionId: 'taskshuttle-s1',
  engineId: 'codex',
  tool: 'read_file',
  input: { path: '/tmp/project/a.ts' },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' as const },
    { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' as const },
  ],
};

function setup(permissionMode: 'deny' | 'ask-orchestrator' | 'allow' = 'ask-orchestrator') {
  const registry = new SessionRegistry({ instanceId: 'broker-test', now: () => '2026-01-01T00:00:00.000Z' });
  registry.createSession({ id: 's1', engine: 'codex', cwd: '/tmp/project', permissionMode });
  registry.markSessionReady('s1', 'taskshuttle-s1');
  const turn = registry.createTurn('s1', { id: 'turn-1', prompt: [{ type: 'text', text: 'work' }] }).value!;
  registry.startTurn(turn.id);
  registry.markPromptSubmitted(turn.id);
  const session = new FakeRunskeinSession({ id: 'taskshuttle-s1', engine: 'codex' });
  return { registry, turn, session };
}

describe('malformed interaction payloads name the right subsystem (ADR 0030, API-018/019/020)', () => {
  it('API-020: both permission producers normalize before storing', async () => {
    // The invariant API-019's classification rests on. Without it, calling a
    // rejected permission payload the plugin's own fault is an assumption.
    const auto = setup('allow');
    const autoBroker = new InteractionBroker({ registry: auto.registry, sessionId: 's1', permissionMode: 'allow' });
    autoBroker.attachSession(auto.session);
    await autoBroker.permissionPolicy({ ...permissionRequest, options: [...permissionRequest.options, 'junk' as never] });

    const asked = setup('ask-orchestrator');
    const askBroker = new InteractionBroker({ registry: asked.registry, sessionId: 's1', permissionMode: 'ask-orchestrator' });
    askBroker.attachSession(asked.session);
    void askBroker.permissionPolicy({ ...permissionRequest, options: [...permissionRequest.options, 'junk' as never] });

    for (const registry of [auto.registry, asked.registry]) {
      const stored = registry.listInteractions().filter((entry) => entry.kind === 'permission');
      expect(stored.length).toBeGreaterThan(0);
      for (const entry of stored) {
        // The whole normalized record, not just `options`: pinning one field
        // accepts a producer that stores a payload whose ids or tool came from
        // somewhere else, and the classification in API-019 rests on the whole
        // record being what `normalizePermissionRequest` produced.
        expect(entry.payload).toEqual(normalizePermissionRequest({ ...permissionRequest, options: [...permissionRequest.options, 'junk' as never] }));
      }
    }
  });

  it('API-019: a corrupted permission record answers INTERNAL, not ENGINE_ERROR', async () => {
    const { registry, session } = setup();
    const broker = new InteractionBroker({ registry, sessionId: 's1', permissionMode: 'ask-orchestrator' });
    broker.attachSession(session);
    void broker.permissionPolicy(permissionRequest);
    const interaction = registry.listInteractions()[0]!;
    // Deliberate corruption of a record the broker really created, reaching
    // into the registry's own map: both permission producers normalize, and
    // `getInteraction` hands out clones, so this branch has no public path to
    // it at all. A case that does not corrupt the stored record cannot reach
    // the branch it names, and would pass against unfixed code.
    const stored = (registry as unknown as { interactions: Map<string, { payload: unknown }> }).interactions.get(interaction.id)!;
    stored.payload = { sessionId: 'taskshuttle-s1', engineId: 'codex', tool: 'read_file', input: null };
    await expect(broker.respond(interaction.id, { optionId: 'allow-once' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL' },
    });
  });

  it('API-018: a malformed question record answers ENGINE_ERROR', async () => {
    const { registry, session } = setup();
    const broker = new InteractionBroker({ registry, sessionId: 's1', permissionMode: 'ask-orchestrator' });
    broker.attachSession(session);
    session.emitQuestion({ requestId: 'q1', sessionId: 'taskshuttle-s1', engineId: 'codex', question: 'which one?', options: [] });
    const interaction = registry.listInteractions().find((entry) => entry.kind === 'question')!;
    // Question requests are stored raw, so this is a shape an engine can really
    // send; the same registry-map access is used only because reads clone.
    const storedQuestion = (registry as unknown as { interactions: Map<string, { payload: unknown }> }).interactions.get(interaction.id)!;
    storedQuestion.payload = { requestId: 'q1', sessionId: 'taskshuttle-s1', engineId: 'codex' };
    await expect(broker.respond(interaction.id, { text: 'answer' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'ENGINE_ERROR' },
    });
  });
});

describe('InteractionBroker', () => {
  it('blocks ask-mode permission policy until a valid orchestrator response', async () => {
    const { registry, turn, session } = setup();
    const broker = new InteractionBroker({ registry, sessionId: 's1', permissionMode: 'ask-orchestrator' });
    broker.attachSession(session);
    const decisionPromise = broker.permissionPolicy(permissionRequest);
    expect(decisionPromise).toBeInstanceOf(Promise);
    expect(registry.listInteractions()).toMatchObject([{ kind: 'permission', state: 'pending', payload: permissionRequest }]);
    expect(registry.getTurn(turn.id)?.state).toBe('awaiting-interaction');
    const interaction = registry.listInteractions()[0]!;
    await expect(broker.respond(interaction.id, { optionId: 'missing' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    await expect(broker.respond(interaction.id, { optionId: 'allow-once', extra: true } as never)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(registry.getInteraction(interaction.id)?.state).toBe('pending');
    await expect(broker.respond(interaction.id, { optionId: 'allow-once' })).resolves.toMatchObject({ ok: true, value: { state: 'responded' } });
    await expect(decisionPromise).resolves.toEqual({ optionId: 'allow-once' });
    expect(registry.getTurn(turn.id)?.state).toBe('running');
    broker.dispose();
  });

  it('returns public policy decisions for deny/allow, and records every automatic approval', async () => {
    const deniedSetup = setup('deny');
    const { registry: deniedRegistry, turn: deniedTurn, session: deniedSession } = deniedSetup;
    const denied = new InteractionBroker({ registry: deniedRegistry, sessionId: 's1', permissionMode: 'deny' });
    denied.attachSession(deniedSession);
    expect(denied.permissionPolicy(permissionRequest)).toEqual({ outcome: 'deny' });
    expect(deniedRegistry.listInteractions()).toHaveLength(0);
    // ADR 0008: `allow` needs no install-surface gate, and it records. An
    // approval that left no interaction would make "what was this worker
    // permitted to do" unanswerable, which is the whole defence of approving
    // without asking.
    const gatedSetup = setup('allow');
    const { registry: gatedRegistry, turn: gatedTurn, session: gatedSession } = gatedSetup;
    const allowed = new InteractionBroker({ registry: gatedRegistry, sessionId: 's1', permissionMode: 'allow' });
    allowed.attachSession(gatedSession);
    expect(allowed.permissionPolicy(permissionRequest)).toEqual({ outcome: 'allow' });
    const recorded = gatedRegistry.listInteractions().filter((entry) => entry.kind === 'permission');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.state).toBe('responded');
    expect(recorded[0]?.permissionModeSnapshot).toBe('allow');
    expect(allowed.permissionPolicy({ ...permissionRequest, sessionId: 'taskshuttle-other' })).toEqual({ outcome: 'deny' });
    gatedRegistry.claimTerminalCAS(gatedTurn.id, { state: 'cancelled', source: 'cancel' });
    expect(allowed.permissionPolicy(permissionRequest)).toEqual({ outcome: 'deny' });
    allowed.dispose();
    expect(allowed.permissionPolicy(permissionRequest)).toEqual({ outcome: 'deny' });
    denied.dispose();
    allowed.dispose();
  });

  it('bridges questions, preserves empty text, and maps only offered option ids', async () => {
    const { registry, turn, session } = setup();
    const broker = new InteractionBroker({ registry, sessionId: 's1', permissionMode: 'ask-orchestrator' });
    broker.attachSession(session);
    const realmQuestion = session.requestQuestion({
      requestId: 'question-1',
      sessionId: 'taskshuttle-s1',
      engineId: 'codex',
      question: 'choose',
      options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
    });
    const interaction = registry.listInteractions()[0]!;
    await expect(broker.respond(interaction.id, { optionId: 'unknown' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    await expect(broker.respond(interaction.id, { optionId: 'yes' })).resolves.toMatchObject({ ok: true });
    await expect(realmQuestion).resolves.toEqual({ optionId: 'yes' });
    expect(session.responses).toEqual([{ requestId: 'question-1', answer: { optionId: 'yes' } }]);

    const realmTextQuestion = session.requestQuestion({ requestId: 'question-2', sessionId: 'taskshuttle-s1', engineId: 'codex', question: 'text' });
    const textInteraction = registry.listInteractions().find((item) => item.state === 'pending')!;
    await expect(broker.respond(textInteraction.id, { text: '' })).resolves.toMatchObject({ ok: true });
    await expect(realmTextQuestion).resolves.toEqual({ text: '' });
    broker.dispose();
  });

  it('fails closed for inactive turns and settles policy promises on terminal invalidation', async () => {
    const { registry, turn, session } = setup();
    const broker = new InteractionBroker({ registry, sessionId: 's1', permissionMode: 'ask-orchestrator' });
    broker.attachSession(session);
    registry.claimTerminalCAS(turn.id, { state: 'cancelled', source: 'cancel' });
    expect(broker.permissionPolicy(permissionRequest)).toEqual({ outcome: 'deny' });
    registry.markPromptSettled(turn.id);
    registry.markStoreDrained(turn.id);
    registry.finishTurnCAS(turn.id);
    broker.dispose();

    const second = registry.createTurn('s1', { id: 'turn-2', prompt: [{ type: 'text', text: 'next' }] }).value!;
    registry.startTurn(second.id);
    registry.markPromptSubmitted(second.id);
    const secondBroker = new InteractionBroker({ registry, sessionId: 's1', permissionMode: 'ask-orchestrator' });
    secondBroker.attachSession(session);
    const pending = secondBroker.permissionPolicy(permissionRequest);
    const interaction = registry.listInteractions().find((item) => item.turnId === second.id)!;
    registry.claimTerminalCAS(second.id, { state: 'cancelled', source: 'cancel' });
    await expect(pending).resolves.toEqual({ outcome: 'deny' });
    await expect(secondBroker.respond(interaction.id, { outcome: 'deny' })).resolves.toMatchObject({ ok: false, error: { code: 'GONE' } });
    secondBroker.dispose();
  });

  it('is registered before the first turn and routes sequential turns through one session broker', async () => {
    const registry = new SessionRegistry({ instanceId: 'sequential-broker', now: () => '2026-01-01T00:00:00.000Z' });
    registry.createSession({ id: 's1', engine: 'codex', cwd: '/tmp/project', permissionMode: 'ask-orchestrator' });
    registry.markSessionReady('s1', 'taskshuttle-s1');
    const session = new FakeRunskeinSession({ id: 'taskshuttle-s1', engine: 'codex' });
    const broker = new InteractionBroker({ registry, sessionId: 's1', permissionMode: 'ask-orchestrator' });
    broker.attachSession(session);

    const first = registry.createTurn('s1', { id: 'first', prompt: [{ type: 'text', text: 'one' }] }).value!;
    registry.startTurn(first.id);
    registry.markPromptSubmitted(first.id);
    const firstDecision = broker.permissionPolicy(permissionRequest);
    const firstInteraction = registry.listInteractions()[0]!;
    await broker.respond(firstInteraction.id, { outcome: 'deny' });
    await expect(firstDecision).resolves.toEqual({ outcome: 'deny' });
    registry.claimTerminalCAS(first.id, { state: 'completed', source: 'executor' });
    registry.markPromptSettled(first.id);
    registry.markStoreDrained(first.id);
    registry.finishTurnCAS(first.id);

    const second = registry.createTurn('s1', { id: 'second', prompt: [{ type: 'text', text: 'two' }] }).value!;
    registry.startTurn(second.id);
    registry.markPromptSubmitted(second.id);
    const secondDecision = broker.permissionPolicy(permissionRequest);
    const secondInteraction = registry.listInteractions().find((item) => item.turnId === second.id)!;
    await broker.respond(secondInteraction.id, { optionId: 'allow-once' });
    await expect(secondDecision).resolves.toEqual({ optionId: 'allow-once' });
    expect(registry.listInteractions().filter((item) => item.turnId === second.id && item.state === 'responded')).toHaveLength(1);
    broker.dispose();
  });
});

describe('normalizePermissionRequest (engine payloads are not trusted)', () => {
  const base = {
    sessionId: 's1',
    engineId: 'kimi',
    tool: 'Bash',
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' as const },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' as const },
    ],
  };

  it('fills in `input` when the engine asked before streaming its raw input', () => {
    // kimi's first tool_call update carries no rawInput, so runskein builds
    // `input: undefined`; undefined vanishes in JSON and the stored payload then
    // fails interaction_list's own output schema, making the pending permission
    // unanswerable (the interactionId only appears in that listing).
    const out = normalizePermissionRequest({ ...base, input: undefined } as never);
    expect('input' in out).toBe(true);
    expect(out.input).toBeNull();
    expect(JSON.parse(JSON.stringify(out))).toHaveProperty('input');
  });

  it('preserves a real input untouched', () => {
    const input = { command: 'git status --short' };
    expect(normalizePermissionRequest({ ...base, input } as never).input).toEqual(input);
  });

  it('rebuilds options to the strict shape and drops unusable ones', () => {
    const out = normalizePermissionRequest({
      ...base,
      input: null,
      options: [
        { optionId: 'a', name: 'Allow', kind: 'allow_once', extra: 'nope' },
        { optionId: 'b', name: 'Bad', kind: 'not_a_kind' },
        { name: 'no id', kind: 'allow_once' },
        null,
      ],
    } as never);
    expect(out.options).toEqual([{ optionId: 'a', name: 'Allow', kind: 'allow_once' }]);
  });

  it('tolerates a missing options array', () => {
    const out = normalizePermissionRequest({ ...base, input: null, options: undefined } as never);
    expect(out.options).toEqual([]);
  });

  it('keeps optional kind/locations only when the engine sent them', () => {
    const bare = normalizePermissionRequest({ ...base, input: null } as never);
    expect('kind' in bare).toBe(false);
    expect('locations' in bare).toBe(false);
    const rich = normalizePermissionRequest({
      ...base, input: null, kind: 'execute', locations: [{ path: '/tmp/x' }],
    } as never);
    expect(rich.kind).toBe('execute');
    expect(rich.locations).toEqual([{ path: '/tmp/x' }]);
  });
});
