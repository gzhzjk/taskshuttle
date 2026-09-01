import { describe, expect, it } from 'vitest';

import { parseHostInstallEvidence, validateHostInstallEvidence } from '../../scripts/live/host-install-evidence.js';

const hosts = ['codex', 'claude-code', 'opencode', 'kimi'] as const;
const clean = JSON.stringify({
  hosts: Object.fromEntries(hosts.map((host) => [host, { pluginIds: ['taskshuttle'], managedPaths: [`/tmp/${host}`] }])),
  npmGlobalPackages: ['taskshuttle'],
});

describe('HOST-COMMON-006 install evidence', () => {
  it('accepts the complete new identity set', () => {
    expect(validateHostInstallEvidence(parseHostInstallEvidence(clean), hosts, 'taskshuttle', 'realm-agent-plugin')).toEqual([]);
  });

  it('rejects a stale old identity even when an operator confirms the case', () => {
    const stale = JSON.parse(clean) as { hosts: Record<string, { pluginIds: string[]; managedPaths: string[] }>; npmGlobalPackages: string[] };
    stale.hosts['kimi']!.pluginIds.push('realm-agent-plugin');
    stale.hosts['kimi']!.managedPaths.push('/tmp/realm-agent-plugin');
    stale.npmGlobalPackages.push('realm-agent-plugin');
    expect(validateHostInstallEvidence(parseHostInstallEvidence(JSON.stringify(stale)), hosts, 'taskshuttle', 'realm-agent-plugin')).toEqual([
      'host kimi must list exactly taskshuttle',
      'host kimi still lists retired id realm-agent-plugin',
      'host kimi must list exactly one managed plugin path',
      'host kimi still has a managed path for retired package realm-agent-plugin',
      'npm global listing still contains retired package realm-agent-plugin',
    ]);
  });

  it('rejects malformed evidence before it can be treated as a manual result', () => {
    expect(() => parseHostInstallEvidence('{')).toThrow('not valid JSON');
    expect(() => parseHostInstallEvidence(JSON.stringify({ hosts: {}, npmGlobalPackages: [1] }))).toThrow('npmGlobalPackages must be a string array');
  });

  it('rejects a relative managed path as evidence no host listing can produce', () => {
    const relative = JSON.parse(clean) as { hosts: Record<string, { pluginIds: string[]; managedPaths: string[] }>; npmGlobalPackages: string[] };
    relative.hosts['codex']!.managedPaths = ['relative-path'];
    expect(validateHostInstallEvidence(parseHostInstallEvidence(JSON.stringify(relative)), hosts, 'taskshuttle', 'realm-agent-plugin')).toContain('host codex has an invalid managed path');
  });
});
