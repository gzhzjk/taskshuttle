import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { InstanceManager } from '../../packages/plugin/src/lifecycle.js';
import { loadPluginConfig } from '../../packages/plugin/src/plugin-config.js';
import { runDeployPreflight } from '../../scripts/deploy-preflight.js';
import { ensureConsoleConfig } from '../../scripts/provision-config.js';

describe('DEPLOY-001 legacy-root preflight', () => {
  it('refuses deploy while a legacy instance is demonstrably live', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-deploy-'));
    const manager = await InstanceManager.create({ dataRoot: root, pid: 5252, processStartedAt: '123', exePath: '/worker', rootNonce: 'd'.repeat(32) });
    const previous = process.env['TASKSHUTTLE_LEGACY_DATA_ROOTS'];
    process.env['TASKSHUTTLE_LEGACY_DATA_ROOTS'] = root;
    try {
      await expect(runDeployPreflight(async () => ({ exists: true, processStartedAt: '123', exePath: '/worker' }))).rejects.toThrow('legacy instance');
    } finally {
      if (previous === undefined) delete process.env['TASKSHUTTLE_LEGACY_DATA_ROOTS']; else process.env['TASKSHUTTLE_LEGACY_DATA_ROOTS'] = previous;
      await manager.close();
    }
  });

  it('allows indeterminate legacy state with a warning, without using runtime force', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-deploy-uncertain-'));
    const manager = await InstanceManager.create({ dataRoot: root, pid: 5253, processStartedAt: '123', exePath: '/worker', rootNonce: 'e'.repeat(32) });
    const previous = process.env['TASKSHUTTLE_LEGACY_DATA_ROOTS']; const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env['TASKSHUTTLE_LEGACY_DATA_ROOTS'] = root;
    try {
      await expect(runDeployPreflight(async () => ({ exists: true }))).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(root));
    } finally {
      warn.mockRestore();
      if (previous === undefined) delete process.env['TASKSHUTTLE_LEGACY_DATA_ROOTS']; else process.env['TASKSHUTTLE_LEGACY_DATA_ROOTS'] = previous;
      await manager.close();
    }
  });
});

describe('DEPLOY-002 install-config provisioning', () => {
  async function freshRoot(): Promise<{ root: string; env: NodeJS.ProcessEnv; path: string }> {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-provision-'));
    return { root, env: { TASKSHUTTLE_DATA_ROOT: root }, path: join(root, 'config.json') };
  }

  it('creates a private config enabling the console when none exists', async () => {
    const { env, path } = await freshRoot();
    const result = await ensureConsoleConfig(env);
    expect(result).toEqual({ outcome: 'written', path });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ console: { enabled: true } });
    // The plugin refuses a group/world accessible install file at start-up, so
    // a provisioned one that cannot boot would be worse than none at all.
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(loadPluginConfig(env, { dataRoot: env['TASKSHUTTLE_DATA_ROOT'] as string, hostCwd: tmpdir() }).console.enabled).toBe(true);
  });

  it('writes nothing on a dry run', async () => {
    const { env, path } = await freshRoot();
    expect((await ensureConsoleConfig(env, true)).outcome).toBe('written');
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves an operator-written config untouched, whether or not it declares a console', async () => {
    const declaring = await freshRoot();
    await writeFile(declaring.path, '{"console":{"enabled":false}}', { mode: 0o600 });
    expect((await ensureConsoleConfig(declaring.env)).outcome).toBe('console-already-declared');
    expect(await readFile(declaring.path, 'utf8')).toBe('{"console":{"enabled":false}}');

    const silent = await freshRoot();
    await writeFile(silent.path, '{"repoDefaults":true}', { mode: 0o600 });
    expect((await ensureConsoleConfig(silent.env)).outcome).toBe('console-not-declared');
    expect(await readFile(silent.path, 'utf8')).toBe('{"repoDefaults":true}');
  });

  it('reports a config the plugin would refuse at start-up instead of repairing it', async () => {
    const wide = await freshRoot();
    await writeFile(wide.path, '{"console":{"enabled":true}}', { mode: 0o644 });
    await chmod(wide.path, 0o644);
    const widened = await ensureConsoleConfig(wide.env);
    expect(widened.outcome).toBe('unreadable');
    expect(widened.detail).toContain('group/world');
    expect((await stat(wide.path)).mode & 0o777).toBe(0o644);

    const malformed = await freshRoot();
    await writeFile(malformed.path, 'not json', { mode: 0o600 });
    expect((await ensureConsoleConfig(malformed.env)).outcome).toBe('unreadable');
    expect(await readFile(malformed.path, 'utf8')).toBe('not json');
  });
});
