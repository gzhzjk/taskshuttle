import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { HostProbeCase, HostProbeContext } from '../../scripts/live/host-probes.js';

async function verifyStdioConfig(context: HostProbeContext): Promise<void> {
  const manifestPath = join(context.root, 'hosts', 'opencode', 'host.json');
  if (!existsSync(manifestPath)) throw new Error('HOSTCFG-001: OpenCode stdio-config case requires hosts/opencode/host.json');
  const hostManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { kind?: unknown; artifacts?: Array<{ role?: unknown; path?: unknown }> };
  if (hostManifest.kind !== 'stdio-config') throw new Error(`HOSTCFG-001: OpenCode manifest kind must be stdio-config, got ${String(hostManifest.kind)}`);
  const configArtifact = hostManifest.artifacts?.find((artifact) => artifact.role === 'mcp-config' && typeof artifact.path === 'string');
  if (configArtifact === undefined) throw new Error('HOSTCFG-001: OpenCode manifest has no mcp-config artifact');
  const directory = await mkdtemp(join(tmpdir(), 'taskshuttle-opencode-host-'));
  try {
    await mkdir(join(directory, '.opencode'));
    await writeFile(join(directory, '.opencode', 'opencode.json'), JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: { taskshuttle: { type: 'local', command: [resolve(context.root, 'dist', 'launch.js')] } },
    }));
    const output = await new Promise<string>((resolveOutput, rejectOutput) => {
      const child = spawn('opencode', ['mcp', 'list'], { cwd: directory, env: { ...process.env, REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [directory] }) } });
      let text = '';
      child.stdout.on('data', (chunk) => { text += String(chunk); });
      child.stderr.on('data', (chunk) => { text += String(chunk); });
      child.once('error', rejectOutput);
      child.once('close', (code) => code === 0 ? resolveOutput(text) : rejectOutput(new Error(`opencode mcp list exited ${code}: ${text}`)));
    });
    if (!/taskshuttle[\s\S]*connected/u.test(output)) throw new Error(`OpenCode did not connect taskshuttle: ${output}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const openCodeCase: HostProbeCase = {
  id: 'HOST-OPENCODE-001',
  title: 'OpenCode loads the local stdio configuration',
  async run(context) {
    const installed = context.cliVersion('opencode', ['--version']);
    if (installed === 'not-installed') {
      return { status: 'na', reason: 'the OpenCode CLI is not installed on this machine; the stdio configuration load cannot be exercised' };
    }
    await verifyStdioConfig(context);
    return { status: 'pass', evidence: { cli: 'opencode', transport: 'stdio-mcp', cliVersion: installed } };
  },
};

export default [openCodeCase] satisfies readonly HostProbeCase[];
