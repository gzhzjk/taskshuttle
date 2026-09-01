import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTaskShuttleServer } from '../packages/plugin/src/server.js';
import { hostDisplayName } from '../packages/plugin/src/runtime.js';

describe('host display label', () => {
  it('installs an oninitialized callback wired to the runtime', async () => {
    const plugin = createTaskShuttleServer({ dataRoot: await mkdtemp(join(tmpdir(), 'taskshuttle-server-init-')), env: { REALM_PLUGIN_LOG: 'off' } as NodeJS.ProcessEnv });
    try {
      expect(typeof plugin.server.server.oninitialized).toBe('function');
    } finally {
      await plugin.close();
    }
  });

  it('maps the self-reported MCP client names of the four supported hosts', () => {
    expect(hostDisplayName('Claude Code 2.1.0')).toBe('claude-code');
    expect(hostDisplayName('codex-cli 0.5.0')).toBe('codex');
    expect(hostDisplayName('OpenCode')).toBe('opencode');
    expect(hostDisplayName('kimi-code 1.0')).toBe('kimi');
  });

  it('shows an unrecognized client verbatim and keeps the platform label for none', () => {
    expect(hostDisplayName('some-other-host')).toBe('some-other-host');
    expect(hostDisplayName('   ')).toBeUndefined();
    expect(hostDisplayName(undefined)).toBeUndefined();
  });

  it('adopts the client name as the instance manifest host label', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-server-host-'));
    const plugin = createTaskShuttleServer({ dataRoot, env: { REALM_PLUGIN_LOG: 'off' } as NodeJS.ProcessEnv });
    try {
      const manifestPath = async (): Promise<string> => {
        const instances = await readdir(join(dataRoot, 'instances'));
        return join(dataRoot, 'instances', instances[0]!, 'instance.json');
      };
      await plugin.runtime.noteHostIdentity('Claude Code 2.1.0');
      expect(JSON.parse(await readFile(await manifestPath(), 'utf8')).host).toBe('claude-code');
      // An absent client name is a no-op, not a rewrite back to the platform.
      await plugin.runtime.noteHostIdentity(undefined);
      expect(JSON.parse(await readFile(await manifestPath(), 'utf8')).host).toBe('claude-code');
    } finally {
      await plugin.close();
    }
  });
});

describe('production MCP entry', () => {
  it('registers exactly the frozen 20-tool catalog', async () => {
    const plugin = createTaskShuttleServer({ dataRoot: await mkdtemp(join(tmpdir(), 'taskshuttle-server-')), env: { REALM_PLUGIN_LOG: 'off' } as NodeJS.ProcessEnv });
    try {
      const registered = (plugin.server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools;
      expect(Object.keys(registered ?? {}).sort()).toHaveLength(20);
      expect(Object.keys(registered ?? {}).sort()).toEqual([
        'anchor', 'interaction_list', 'interaction_respond', 'project_init', 'session_close', 'session_configure', 'session_create', 'session_fork', 'session_get', 'session_list',
        'transcript_delete', 'transcript_event_get', 'transcript_list', 'transcript_read', 'turn_cancel', 'turn_get', 'turn_list', 'turn_start', 'worker_describe', 'workers_list',
      ]);
      const workers = await plugin.invoke('workers_list', { rescan: false });
      expect(workers.ok).toBe(true);
      // The frozen four must be there; anything else Realm registers may be too.
      // Asserting an exact list would turn every upstream adapter into a failing
      // test, which ADR 0004 decided is information rather than an error.
      if (workers.ok) {
        const engines = (workers.output as { workers: Array<{ engine: string }> }).workers.map((worker) => worker.engine);
        expect(engines.slice(0, 4)).toEqual(['codex', 'claude-code', 'opencode', 'kimi']);
      }
    } finally {
      await plugin.close();
    }
  });
});
