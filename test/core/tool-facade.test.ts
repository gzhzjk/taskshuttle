import { describe, expect, it, vi } from 'vitest';

import { registerMcpTools } from '../../packages/plugin/src/mcp-transport.js';
import { ToolFacade } from '../../packages/plugin/src/tool-facade.js';

describe('ToolFacade', () => {
  it('parses strict input/defaults before dispatch and validates output', async () => {
    const handler = vi.fn((input) => ({ turnId: input.sessionId, status: 'queued' as const }));
    const facade = new ToolFacade({ turn_start: handler });
    await expect(facade.invoke('turn_start', { sessionId: 's1', prompt: [{ type: 'text', text: 'go' }] })).resolves.toEqual({
      ok: true,
      output: { turnId: 's1', status: 'queued' },
    });
    expect(handler).toHaveBeenCalledWith({ sessionId: 's1', prompt: [{ type: 'text', text: 'go' }], priority: 'normal' });
    await expect(facade.invoke('turn_start', { sessionId: 's1', prompt: [], unknown: true })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  });

  it('returns stable not-supported, mapped handler, and invalid-output errors', async () => {
    const facade = new ToolFacade({
      workers_list: () => { throw new Error('engine secret token=abc'); },
      session_get: () => ({ bad: true } as never),
    }, { secretLiterals: ['abc'] });
    await expect(facade.invoke('transcript_list', {})).resolves.toMatchObject({ ok: false, error: { code: 'NOT_SUPPORTED' } });
    // A handler that throws generically at the tool boundary is exactly what
    // the plugin cannot attribute: `tool/<name>` says which tool was called,
    // not who failed inside it (ADR 0027).
    await expect(facade.invoke('workers_list', { rescan: false })).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL', message: expect.not.stringContaining('abc') } });
    // ADR 0027 / API-016: output-schema drift is ours and unattributable
    // beyond that. `STORE_ERROR` named a subsystem that is not on this path.
    await expect(facade.invoke('session_get', { sessionId: 's1' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL', message: 'handler returned invalid output for session_get', cause: { operation: 'tool/session_get/output' } },
    });
  });

  it('registers exactly the frozen 20 tools on MCP transport', () => {
    const names: string[] = [];
    const configs: Array<Record<string, unknown>> = [];
    const fakeServer = {
      registerTool(name: string, config: Record<string, unknown>) { names.push(name); configs.push(config); },
    };
    registerMcpTools(fakeServer as never, new ToolFacade());
    expect(names).toHaveLength(20);
    expect(new Set(names).size).toBe(20);
    expect(names).toContain('interaction_respond');
    expect(names).toContain('anchor');
    expect(names).toContain('project_init');
    expect(configs).toHaveLength(20);
    for (const config of configs) {
      expect(config.inputSchema).toBeDefined();
      expect(config.outputSchema).toBeDefined();
    }
  });

  /**
   * The wire shape of a result, success and failure (ADR 0024). Every tool
   * declares an `outputSchema`, which describes its success; an error envelope
   * cannot conform to it, so it travels in the text content with `isError` and
   * `structuredContent` is success-only. A host that validates the structured
   * field unconditionally otherwise reports every tool error as a schema
   * mismatch and the real code never reaches the operator (GZH-36).
   */
  describe('result wire shape (ADR 0024)', () => {
    const handlerFor = (name: string) => {
      const handlers: Array<[string, unknown]> = [];
      const fakeServer = {
        registerTool(tool: string, _config: unknown, handler: unknown) { handlers.push([tool, handler]); },
      };
      registerMcpTools(fakeServer as never, new ToolFacade({
        workers_list: () => ({ workers: [], instanceId: 'fixture-instance' }),
      }));
      const found = handlers.find(([tool]) => tool === name);
      if (found === undefined) throw new Error(`no handler registered for ${name}`);
      return found[1] as (input: unknown) => Promise<Record<string, unknown>>;
    };

    it('carries structuredContent on success', async () => {
      const result = await handlerFor('workers_list')({ rescan: false });
      expect(result['isError']).toBeUndefined();
      expect(result['structuredContent']).toEqual({ workers: [], instanceId: 'fixture-instance' });
    });

    it('carries the error envelope in the text content, and no structuredContent', async () => {
      // `transcript_list` has no handler in this facade, so the facade answers
      // NOT_SUPPORTED — a real error result, not a fabricated one.
      const result = await handlerFor('transcript_list')({});
      expect(result['isError']).toBe(true);
      expect('structuredContent' in result).toBe(false);
      const content = result['content'] as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0]!.text)).toMatchObject({ error: { code: 'NOT_SUPPORTED' } });
    });
  });
});
