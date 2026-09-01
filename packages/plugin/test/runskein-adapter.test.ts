import { describe, expect, it } from 'vitest';

import { RunskeinAgentProvider } from '../src/runskein-adapter.js';

interface FakeSession {
  id: string;
  on: (event: string, listener: (value: any) => void) => () => void;
  prompt: () => Promise<{ stopReason: string; usage?: Record<string, number>; quota?: unknown }>;
  fork: () => Promise<FakeSession>;
  setConfig: (config: Record<string, string | boolean>) => Promise<void>;
  cancel: () => Promise<void>;
  close: () => Promise<void>;
  respond: (requestId: string, answer: unknown) => Promise<void>;
}

function fakeSession(id = 'provider-session-1'): FakeSession {
  const listeners = new Map<string, (value: any) => void>();
  const session: FakeSession = {
    id,
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
    prompt: async () => {
      listeners.get('update')?.({ update: { sessionUpdate: 'agent_message_chunk', content: 'ok' }, usage: { output: 1 } });
      return { stopReason: 'end_turn', usage: { output: 1 } };
    },
    fork: async () => fakeSession(`${id}-child`),
    setConfig: async () => undefined,
    cancel: async () => undefined,
    close: async () => undefined,
    respond: async () => undefined,
  };
  return session;
}

function hubFor(session: FakeSession, order: string[]) {
  return {
    engines: async () => [{ id: 'codex', installed: true, health: 'ready' }],
    describe: async (engine: string) => {
      order.push(`describe:${engine}`);
      return { capabilities: { session: {}, prompt: {}, loadSession: false, mcp: {}, providers: false }, configOptions: [], source: 'hints' as const };
    },
    session: async () => { order.push('hub.session'); return session; },
    quit: async () => undefined,
  };
}

const request = { engine: 'codex', cwd: '/raw', mcpServerIds: [], permissionMode: 'deny' as const, config: {} };

describe('RunskeinAgentProvider', () => {
  it('keeps final cwd verification adjacent to hub.session', async () => {
    const order: string[] = [];
    const provider = new RunskeinAgentProvider({
      hub: hubFor(fakeSession(), order) as never,
      cwdPolicy: {
        resolveCwd: async (cwd) => { order.push(`resolve:${cwd}`); return { path: '/safe', dev: 1, ino: 2 }; },
        verifyCwdBeforeSpawn: async () => { order.push('verify'); },
      },
    });

    await expect(provider.createSession(request)).resolves.toEqual({ providerSessionId: 'provider-session-1' });
    expect(order).toEqual(['describe:codex', 'resolve:/raw', 'verify', 'hub.session']);
  });

  it('normalizes provider updates and usage without exposing dependency errors', async () => {
    const session = fakeSession();
    const provider = new RunskeinAgentProvider({
      hub: hubFor(session, []) as never,
      cwdPolicy: { resolveCwd: async () => ({ path: '/safe', dev: 1, ino: 2 }), verifyCwdBeforeSpawn: async () => undefined },
    });
    const created = await provider.createSession(request);
    await expect(provider.createSession({ ...request, mcpServerIds: ['catalogued-server'] })).resolves.toMatchObject({
      operation: 'session/create',
      message: 'MCP server resolver is not configured',
    });
    const result = await provider.prompt({ session: created as { providerSessionId: string }, content: [{ type: 'text', text: 'hello' }] });
    expect(result).toMatchObject({ stopReason: 'end_turn', usage: { output: 1 }, updates: [{ update: { sessionUpdate: 'agent_message_chunk', content: 'ok' }, usage: { output: 1 } }] });
  });

  it('returns a normalized failure and never spawns after cwd verification refuses', async () => {
    let spawned = false;
    const provider = new RunskeinAgentProvider({
      hub: { ...hubFor(fakeSession(), []), session: async () => { spawned = true; return fakeSession(); } } as never,
      cwdPolicy: {
        resolveCwd: async () => ({ path: '/safe', dev: 1, ino: 2 }),
        verifyCwdBeforeSpawn: async () => { throw Object.assign(new Error('cwd changed'), { kind: 'cwd-race' }); },
      },
    });
    await expect(provider.createSession(request)).resolves.toMatchObject({ operation: 'session/create', kind: 'cwd-race' });
    expect(spawned).toBe(false);
  });
});
