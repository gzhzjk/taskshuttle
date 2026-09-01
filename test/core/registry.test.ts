import { describe, expect, it } from 'vitest';

import { SessionRegistry } from '../../packages/core/src/registry.js';

const prompt = [{ type: 'text' as const, text: 'do the work' }];
const failure = { code: 'ENGINE_ERROR' as const, message: 'worker crashed' };

function makeRegistry(instanceId = 'instance-1', limits?: ConstructorParameters<typeof SessionRegistry>[0]['limits']) {
  let tick = 0;
  return new SessionRegistry({ instanceId, ...(limits === undefined ? {} : { limits }), now: () => `2026-01-01T00:00:0${tick++}.000Z` });
}

function readySession(registry: SessionRegistry, id: string, engine: 'codex' | 'claude-code' | 'opencode' | 'kimi' = 'codex') {
  const created = registry.createSession({ id, instanceId: 'input-instance-is-ignored', engine, cwd: '/tmp/project' });
  expect(created.ok).toBe(true);
  expect(registry.markSessionReady(id, `taskshuttle-${id}`).ok).toBe(true);
  return registry.getSession(id)!;
}

describe('SessionRegistry', () => {
  it('creates creating sessions, transitions to idle, and returns defensive snapshots', () => {
    const registry = makeRegistry('runtime-instance');
    const created = registry.createSession({ id: 's1', instanceId: 'other', engine: 'codex', cwd: '/tmp/project', desiredConfig: { model: 'fast' } });
    expect(created.value).toMatchObject({ id: 's1', instanceId: 'runtime-instance', state: 'creating', desiredConfig: { model: 'fast' } });
    expect(registry.createTurn('s1', { prompt })).toEqual({ ok: false, reason: 'invalid-state' });
    const snapshot = created.value!;
    snapshot.desiredConfig.model = 'mutated';
    expect(registry.getSession('s1')?.desiredConfig.model).toBe('fast');
    expect(registry.markSessionReady('s1', 'taskshuttle-s1').value?.state).toBe('idle');
    expect(registry.getSession('s1')?.realmSessionId).toBe('taskshuttle-s1');
    expect(registry.createSession({ id: 's1', instanceId: 'x', engine: 'codex', cwd: '/tmp/project' })).toEqual({ ok: false, reason: 'invalid-state' });
  });

  it('enforces idle-only configuration and one active turn per session', () => {
    const registry = makeRegistry();
    readySession(registry, 's1');
    const first = registry.createTurn('s1', { id: 't1', prompt }).value!;
    const second = registry.createTurn('s1', { id: 't2', prompt }).value!;
    expect(registry.startTurn(first.id).ok).toBe(true);
    expect(registry.startTurn(second.id)).toEqual({ ok: false, reason: 'not-ready' });
    expect(registry.configureSession('s1', { config: { model: 'slow' } })).toEqual({ ok: false, reason: 'invalid-state' });
    expect(registry.claimTerminalCAS(first.id, { state: 'cancelled' }).ok).toBe(true);
    expect(registry.finishTurnCAS(first.id)).toEqual({ ok: false, reason: 'not-ready' });
    registry.markPromptSettled(first.id);
    expect(registry.finishTurnCAS(first.id)).toEqual({ ok: false, reason: 'not-ready' });
    registry.markStoreDrained(first.id);
    expect(registry.finishTurnCAS(first.id).value?.state).toBe('cancelled');
    expect(registry.getSession('s1')?.state).toBe('idle');
    expect(registry.startTurn(second.id).value?.state).toBe('running');
    expect(registry.configureSession('s1', { config: {} })).toEqual({ ok: false, reason: 'invalid-state' });
  });

  it('allows busy permission-mode changes without pending permission, but keeps engine config idle-only', () => {
    const registry = makeRegistry();
    readySession(registry, 's1');
    const turn = registry.createTurn('s1', { prompt }).value!;
    registry.startTurn(turn.id);
    registry.addInteraction(turn.id, { id: 'q1', kind: 'question', payload: { question: 'which?' } });
    expect(registry.configureSession('s1', { permissionMode: 'allow' }).value?.permissionMode).toBe('allow');
    expect(registry.configureSession('s1', { config: { model: 'slow' } })).toEqual({ ok: false, reason: 'invalid-state' });
    registry.addInteraction(turn.id, { id: 'p1', kind: 'permission', payload: { tool: 'read' } });
    expect(registry.getInteraction('p1')?.permissionModeSnapshot).toBe('allow');
    expect(registry.configureSession('s1', { permissionMode: 'deny' })).toEqual({ ok: false, reason: 'invalid-state' });
  });

  it('uses terminal claim CAS and expected versions, releasing leases once after both drains', () => {
    const registry = makeRegistry();
    readySession(registry, 's1');
    const turn = registry.createTurn('s1', { id: 't1', prompt }).value!;
    expect(registry.claimTerminalCAS(turn.id, { state: 'completed' })).toEqual({ ok: false, reason: 'invalid-state' });
    const claimed = registry.claimTerminalCAS(turn.id, { state: 'cancelled', source: 'cancel' }, turn.version);
    expect(claimed.ok).toBe(true);
    expect(registry.claimTerminalCAS(turn.id, { state: 'failed', error: failure })).toMatchObject({ ok: false, reason: 'already-claimed' });
    expect(registry.markPromptSettled(turn.id, turn.version)).toEqual({ ok: false, reason: 'version-mismatch' });
    registry.markPromptSettled(turn.id);
    registry.markStoreDrained(turn.id);
    expect(registry.finishTurnCAS(turn.id).value?.state).toBe('cancelled');
    expect(registry.finishTurnCAS(turn.id).value?.state).toBe('cancelled');
    expect(registry.gate.snapshot()).toEqual({ openSessions: 1, activeTurns: 0, queuedTurns: 0, activeByEngine: {} });
  });

  it('keeps published terminal outcomes immutable', () => {
    const registry = makeRegistry();
    readySession(registry, 's1');
    const turn = registry.createTurn('s1', { prompt }).value!;
    registry.claimTerminalCAS(turn.id, { state: 'cancelled' });
    registry.finishTurnCAS(turn.id);
    expect(registry.setTurnOutcome(turn.id, { finalText: 'late result', usage: { total: 1 } })).toMatchObject({ ok: false, reason: 'already-claimed' });
    expect(registry.getTurn(turn.id)).not.toMatchObject({ finalText: 'late result' });
    expect(registry.diagnostics()).toEqual({ lateTerminalClaims: 0, storeDrainFailures: 0 });
    expect(registry.claimTerminalCAS(turn.id, { state: 'failed', error: failure })).toMatchObject({ ok: false, reason: 'already-claimed' });
    expect(registry.diagnostics()).toEqual({ lateTerminalClaims: 1, storeDrainFailures: 0 });
  });

  it('rejects malformed transcript boundaries without partial mutation', () => {
    const registry = makeRegistry();
    readySession(registry, 's1');
    const turn = registry.createTurn('s1', { prompt }).value!;
    expect(registry.setTurnOutcome(turn.id, { beforeSeq: 2, fromSeq: 5, throughSeq: 4 })).toEqual({ ok: false, reason: 'invalid-state' });
    expect(registry.getTurn(turn.id)).not.toMatchObject({ beforeSeq: 2, fromSeq: 5, throughSeq: 4 });
    expect(registry.setTurnOutcome(turn.id, { beforeSeq: 2, fromSeq: null, throughSeq: 2 }).ok).toBe(true);
    expect(registry.setTurnOutcome(turn.id, { beforeSeq: 2, fromSeq: 2, throughSeq: 3 })).toEqual({ ok: false, reason: 'invalid-state' });
    expect(registry.setTurnOutcome(turn.id, { beforeSeq: 3 })).toEqual({ ok: false, reason: 'invalid-state' });
    const second = registry.createTurn('s1', { prompt }).value!;
    expect(registry.setTurnOutcome(second.id, { beforeSeq: 4 }).ok).toBe(true);
    expect(registry.setTurnOutcome(second.id, { fromSeq: 3, throughSeq: 5 })).toEqual({ ok: false, reason: 'invalid-state' });
  });

  it('never dispatches a queued turn after it has been terminal-claimed', () => {
    const registry = makeRegistry();
    readySession(registry, 's1');
    const turn = registry.createTurn('s1', { prompt }).value!;
    registry.claimTerminalCAS(turn.id, { state: 'cancelled' });
    expect(registry.startTurn(turn.id)).toEqual({ ok: false, reason: 'invalid-state' });
    expect(registry.gate.snapshot()).toMatchObject({ activeTurns: 0, queuedTurns: 0 });
  });

  it('projects multiple interactions and invalidates all on a terminal claim', () => {
    const registry = makeRegistry();
    readySession(registry, 's1');
    const turn = registry.createTurn('s1', { id: 't1', prompt }).value!;
    registry.startTurn(turn.id);
    const permission = registry.addInteraction(turn.id, { id: 'p1', kind: 'permission', payload: { tool: 'read' } }).value!;
    const question = registry.addInteraction(turn.id, { id: 'q1', kind: 'question', payload: { question: 'which?' } }).value!;
    expect(registry.getTurn(turn.id)).toMatchObject({ state: 'awaiting-interaction' });
    expect(registry.getTurn(turn.id)?.pendingPermissionIds).toEqual(new Set(['p1']));
    expect(registry.resolveInteractionCAS(permission.id, 'responded').value?.state).toBe('responded');
    expect(registry.getTurn(turn.id)?.state).toBe('awaiting-interaction');
    registry.claimTerminalCAS(turn.id, { state: 'cancelled' });
    expect(registry.getTurn(turn.id)).toMatchObject({ state: 'running', pendingPermissionIds: new Set(), pendingQuestionIds: new Set() });
    expect(registry.getInteraction(question.id)?.state).toBe('invalidated');
    expect(registry.resolveInteractionCAS(question.id, 'responded')).toMatchObject({ ok: false, reason: 'invalid-state' });
  });

  it('cancels queued turns and closes only after active prompt/store drain', () => {
    const registry = makeRegistry();
    readySession(registry, 's1');
    const active = registry.createTurn('s1', { id: 'active', prompt }).value!;
    const queued = registry.createTurn('s1', { id: 'queued', prompt }).value!;
    registry.startTurn(active.id);
    expect(registry.beginCloseSession('s1').value?.state).toBe('closing');
    expect(registry.getTurn(queued.id)?.state).toBe('cancelled');
    expect(registry.completeCloseSession('s1')).toEqual({ ok: false, reason: 'not-ready' });
    registry.markPromptSettled(active.id);
    registry.markStoreDrained(active.id);
    registry.finishTurnCAS(active.id);
    expect(registry.completeCloseSession('s1').value?.state).toBe('closed');
    expect(registry.completeCloseSession('s1').value?.state).toBe('closed');
    expect(registry.gate.snapshot().openSessions).toBe(0);
  });

  it('marks only a crashed engine unavailable and differentiates queued failures', () => {
    const registry = makeRegistry();
    readySession(registry, 'codex-active', 'codex');
    readySession(registry, 'codex-queued', 'codex');
    readySession(registry, 'claude', 'claude-code');
    const active = registry.createTurn('codex-active', { prompt }).value!;
    registry.startTurn(active.id);
    const queued = registry.createTurn('codex-queued', { prompt }).value!;
    const unaffected = registry.createTurn('claude', { prompt }).value!;
    registry.markEngineCrashed('codex', failure);
    expect(registry.getSession('codex-active')?.state).toBe('failed');
    expect(registry.getSession('codex-queued')?.state).toBe('failed');
    expect(registry.getSession('claude')?.state).toBe('idle');
    expect(registry.getTurn(active.id)).toMatchObject({ state: 'running', terminalClaim: { state: 'failed', error: failure } });
    registry.markPromptSettled(active.id);
    registry.markStoreDrained(active.id);
    expect(registry.finishTurnCAS(active.id).value).toMatchObject({ state: 'failed', error: failure });
    expect(registry.getTurn(queued.id)).toMatchObject({ state: 'failed', error: { ...failure, code: 'SESSION_UNAVAILABLE' } });
    expect(registry.getTurn(unaffected.id)?.state).toBe('queued');
  });

  it('keeps failed sessions reserved until close and supports safe creating discard', () => {
    const registry = makeRegistry('instance-1', { maxOpenSessions: 1 });
    readySession(registry, 's1');
    const sessionFailure = { ...failure, details: { nested: { keep: true } } };
    expect(registry.markSessionFailed('s1', sessionFailure).ok).toBe(true);
    sessionFailure.details.nested.keep = false;
    const sessionSnapshot = registry.getSession('s1')!;
    (sessionSnapshot.failure!.details!.nested as { keep: boolean }).keep = false;
    expect((registry.getSession('s1')!.failure!.details!.nested as { keep: boolean }).keep).toBe(true);
    expect(registry.gate.snapshot().openSessions).toBe(1);
    expect(registry.beginCloseSession('s1').ok).toBe(true);
    expect(registry.completeCloseSession('s1').value?.state).toBe('closed');
    const creating = registry.createSession({ id: 's2', engine: 'codex', cwd: '/tmp/project' });
    expect(creating.ok).toBe(true);
    expect(registry.discardCreatingSession('s2')).toEqual({ ok: true });
    expect(registry.gate.snapshot().openSessions).toBe(0);
  });

  it('serializes operations per session and preserves the lane after rejection', async () => {
    const registry = makeRegistry();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = registry.withSessionLane('s1', async () => {
      order.push('first-start');
      await firstBlocked;
      order.push('first-end');
      return 1;
    });
    const second = registry.withSessionLane('s1', async () => {
      order.push('second');
      return 2;
    });
    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    releaseFirst();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
    await expect(registry.withSessionLane('s1', () => { throw new Error('expected'); })).rejects.toThrow('expected');
    await expect(registry.withSessionLane('s1', () => 'after')).resolves.toBe('after');
  });

  it('announces transitions with the fields §15 requires and never a stale error code', () => {
    const sessions: Array<Record<string, unknown>> = [];
    const turns: Array<Record<string, unknown>> = [];
    const interactions: Array<Record<string, unknown>> = [];
    const registry = new SessionRegistry({
      instanceId: 'observed',
      observer: {
        onSessionTransition: (event) => sessions.push({ ...event }),
        onTurnTransition: (event) => turns.push({ ...event }),
        onInteractionTransition: (event) => interactions.push({ ...event }),
      },
    });
    readySession(registry, 's1');
    const turn = registry.createTurn('s1', { prompt }).value!;
    expect(registry.startTurn(turn.id).ok).toBe(true);
    const interaction = registry.addInteraction(turn.id, { kind: 'permission', payload: { question: 'may I' } }).value!;
    expect(registry.resolveInteractionCAS(interaction.id, 'responded').ok).toBe(true);
    expect(registry.claimTerminalCAS(turn.id, { state: 'failed', error: failure }).ok).toBe(true);
    registry.markPromptSettled(turn.id);
    registry.markStoreDrained(turn.id);
    expect(registry.finishTurnCAS(turn.id).ok).toBe(true);

    expect(sessions[0]).toMatchObject({ sessionId: 's1', engine: 'codex', from: 'creating', to: 'idle', operation: 'session/create' });
    expect(sessions.every((event) => event['errorCode'] === undefined)).toBe(true);
    // The interaction is announced before the turn is projected to awaiting.
    const awaiting = turns.findIndex((event) => event['to'] === 'awaiting-interaction');
    expect(interactions[0]).toMatchObject({ interactionId: interaction.id, turnId: turn.id, kind: 'permission', to: 'pending' });
    expect(typeof interactions[0]!['durationMs']).toBe('number');
    expect(awaiting).toBeGreaterThan(-1);
    // Only the terminal transition carries the error code and a duration.
    const normalized = turns.filter((event) => event['to'] === 'running' && event['from'] === 'awaiting-interaction');
    expect(normalized.every((event) => event['errorCode'] === undefined && event['durationMs'] === undefined)).toBe(true);
    const terminal = turns.at(-1)!;
    expect(terminal).toMatchObject({ to: 'failed', errorCode: 'ENGINE_ERROR', engine: 'codex', priority: 'normal' });
    expect(typeof terminal['durationMs']).toBe('number');
    // Dispatch reports how long the turn waited in the plugin queue (§7.2).
    const dispatch = turns.find((event) => event['from'] === 'queued' && event['to'] === 'running')!;
    expect(typeof dispatch['queuedMs']).toBe('number');
    expect(turns.filter((event) => event['from'] !== 'queued').every((event) => event['queuedMs'] === undefined)).toBe(true);
  });

  it('reports an out-of-table transition before the invariant error escapes', () => {
    const invalid: Array<Record<string, unknown>> = [];
    const registry = new SessionRegistry({ instanceId: 'observed', observer: { onInvalidTransition: (event) => invalid.push({ ...event }) } });
    readySession(registry, 's1');
    expect(registry.beginCloseSession('s1').ok).toBe(true);
    expect(registry.completeCloseSession('s1').ok).toBe(true);
    // `closed` is terminal: the enum table rejects any further transition.
    const internals = registry as unknown as { sessions: Map<string, unknown>; setSessionState(record: unknown, to: string, operation: string): void };
    expect(() => internals.setSessionState(internals.sessions.get('s1'), 'idle', 'test/forced')).toThrow();
    expect(invalid[0]).toMatchObject({ kind: 'session', from: 'closed', to: 'idle', operation: 'test/forced', sessionId: 's1' });
  });
});
