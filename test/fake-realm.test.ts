import { describe, expect, it } from 'vitest';
import type { TranscriptEvent } from 'runskein';

import { FakeRunskeinHub, FakeRunskeinSession } from '../packages/plugin/src/testkit/fake-runskein.js';

describe('FakeRunskeinHub/FakeRunskeinSession', () => {
  it('keeps one prompt active and exposes deterministic completion controls', async () => {
    const session = new FakeRunskeinSession({ id: 's-1', engine: 'codex', closeResolvesPrompt: false });
    const first = session.prompt('first');
    await expect(session.prompt('second')).rejects.toThrow('second active prompt');
    const event: TranscriptEvent = {
      seq: 1,
      ts: Date.now(),
      sessionId: 's-1',
      engineId: 'codex',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    };
    session.emitUpdate(event);
    session.resolvePrompt({ stopReason: 'end_turn', durationMs: 4 });
    await expect(first).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(session.promptCalls).toHaveLength(1);
  });

  it('models question listener/response and auto-cancel without a listener', async () => {
    const session = new FakeRunskeinSession({ id: 's-1', engine: 'kimi' });
    const unsubscribe = session.on('question', () => undefined);
    const pending = session.requestQuestion({
      requestId: 'q-1',
      sessionId: 's-1',
      engineId: 'kimi',
      question: 'choose',
      options: [{ id: 'yes', label: 'Yes' }],
    });
    await session.respond('q-1', { optionId: 'yes' });
    await expect(pending).resolves.toEqual({ optionId: 'yes' });
    expect(session.responses).toEqual([{ requestId: 'q-1', answer: { optionId: 'yes' } }]);
    unsubscribe();
    await expect(
      session.requestQuestion({ requestId: 'q-2', sessionId: 's-1', engineId: 'kimi', question: 'decline' }),
    ).resolves.toEqual({ action: 'cancel' });
  });

  it('creates sessions, injects the configured policy, and queues failures', async () => {
    const hub = new FakeRunskeinHub();
    hub.failNextSession(new Error('start failed'));
    await expect(
      hub.session({ engine: 'codex', cwd: '/tmp', permissionPolicy: () => ({ outcome: 'deny' }) }),
    ).rejects.toThrow('start failed');
    const session = await hub.session({
      engine: 'claude-code',
      cwd: '/tmp',
      permissionPolicy: () => ({ outcome: 'deny' }),
    });
    expect(session.id).toBe('fake-session-1');
    expect(hub.sessionCalls).toHaveLength(2);
  });

  it('accepts an injected clock for deterministic lifecycle timestamps', async () => {
    const hub = new FakeRunskeinHub({ now: () => 1234 });
    const session = await hub.session({ engine: 'codex', cwd: '/tmp', permissionPolicy: () => ({ outcome: 'deny' }) });
    const pending = session.prompt('clocked');
    expect((session as FakeRunskeinSession).promptCalls[0]?.startedAt).toBe(1234);
    await session.close();
    await expect(pending).resolves.toMatchObject({ stopReason: 'cancelled' });
  });

  it('does not race auto-resolution with close', async () => {
    const session = new FakeRunskeinSession({ id: 's-1', engine: 'codex', autoResolve: { stopReason: 'end_turn', durationMs: 1 } });
    const pending = session.prompt('race');
    await session.close();
    await expect(pending).resolves.toMatchObject({ stopReason: 'cancelled' });
    await Promise.resolve();
  });

  it('exposes inventory/descriptor and records explicit quit arguments', async () => {
    const descriptor = {
      capabilities: { loadSession: true, session: {}, prompt: {}, mcp: {}, providers: false },
      configOptions: [],
      source: 'hints' as const,
    };
    const hub = new FakeRunskeinHub({
      engineInfos: [{ id: 'codex', installed: true, authenticated: true, health: 'ready' }],
      descriptors: { codex: descriptor },
    });
    await expect(hub.engines()).resolves.toMatchObject([{ id: 'codex' }]);
    await expect(hub.describe('codex')).resolves.toEqual(descriptor);
    await hub.quit();
    await hub.quit(undefined);
    expect(hub.quitArguments[0]).toHaveLength(0);
    expect(hub.quitArguments[1]).toHaveLength(1);
  });

  it('propagates engine crashes and registers forked sessions for quit', async () => {
    const hub = new FakeRunskeinHub({ closeResolvesPrompt: false });
    const first = await hub.session({ engine: 'codex', cwd: '/tmp', permissionPolicy: () => ({ outcome: 'deny' }) });
    const second = await hub.session({ engine: 'codex', cwd: '/tmp', permissionPolicy: () => ({ outcome: 'deny' }) });
    const fork = await first.fork();
    expect(hub.sessions.has(fork.id)).toBe(true);
    hub.crashEngine('codex', new Error('crashed'));
    expect(first.crashCalls).toHaveLength(1);
    expect(second.crashCalls).toHaveLength(1);
    await hub.quit();
    expect(fork.closeCalls).toHaveLength(1);
  });
});
