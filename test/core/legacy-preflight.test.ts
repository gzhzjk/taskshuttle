import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { assertLegacyRootsSafe, defaultLegacyRoot, probeLegacyInstances, resolveLegacyProbeRoots } from '../../packages/plugin/src/legacy-preflight.js';
import { InstanceManager } from '../../packages/plugin/src/lifecycle.js';

describe('legacy-root preflight', () => {
  it('derives the legacy default from the injected home', () => {
    expect(defaultLegacyRoot('/tmp/operator')).toBe('/tmp/operator/.realm-plugin');
  });
  it('adds every declared custom root without hiding the default root', () => {
    expect(resolveLegacyProbeRoots({ TASKSHUTTLE_LEGACY_DATA_ROOTS: '/tmp/one:/tmp/two' }, { home: '/tmp/operator' }))
      .toEqual(['/tmp/operator/.realm-plugin', '/tmp/one', '/tmp/two']);
  });
  it('permits a missing legacy root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-legacy-clear-'));
    await expect(assertLegacyRootsSafe([join(root, 'missing')], false, async () => ({ exists: false }))).resolves.toBeUndefined();
  });

  it('refuses a matching live legacy instance before fresh-root startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-legacy-live-'));
    const manager = await InstanceManager.create({ dataRoot: root, pid: 4242, processStartedAt: '123', exePath: '/worker', rootNonce: 'a'.repeat(32) });
    await expect(assertLegacyRootsSafe([root], false, async () => ({ exists: true, processStartedAt: '123', exePath: '/worker' }))).rejects.toThrow('legacy instance');
    await expect(assertLegacyRootsSafe([root], true, async () => ({ exists: true, processStartedAt: '123', exePath: '/worker' }))).rejects.toThrow('legacy instance');
    await manager.close();
  });

  it('treats an unreadable process identity as indeterminate and supports explicit override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-legacy-uncertain-'));
    const manager = await InstanceManager.create({ dataRoot: root, pid: 4243, processStartedAt: '123', exePath: '/worker', rootNonce: 'b'.repeat(32) });
    await expect(assertLegacyRootsSafe([root], false, async () => ({ exists: true }))).rejects.toThrow('indeterminate');
    await expect(assertLegacyRootsSafe([root], true, async () => ({ exists: true }))).resolves.toBeUndefined();
    await manager.close();
  });

  it('does not classify cross-format timestamps as a dead owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-legacy-format-'));
    const manager = await InstanceManager.create({ dataRoot: root, pid: 4244, processStartedAt: '123', exePath: '/worker', rootNonce: 'c'.repeat(32) });
    await expect(probeLegacyInstances([root], async () => ({ exists: true, processStartedAt: '2026-08-29T00:00:00.000Z' }))).resolves.toEqual([expect.objectContaining({ state: 'indeterminate' })]);
    await manager.close();
  });

  it('checks every declared root and reports scan failures as indeterminate', async () => {
    const first = await mkdtemp(join(tmpdir(), 'taskshuttle-legacy-first-'));
    const second = await mkdtemp(join(tmpdir(), 'taskshuttle-legacy-second-'));
    const manager = await InstanceManager.create({ dataRoot: second, pid: 4245, processStartedAt: '123', exePath: '/worker', rootNonce: 'd'.repeat(32) });
    const results = await probeLegacyInstances([first, second], async () => ({ exists: true, processStartedAt: '123', exePath: '/worker' }));
    expect(results).toEqual([expect.objectContaining({ root: first, state: 'clear' }), expect.objectContaining({ root: second, state: 'active' })]);
    await manager.close();
  });
});
