import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostProbeCase, HostProbeContext } from '../../scripts/live/host-probes.js';
import { DELEGATION_ENV } from '../../packages/plugin/src/security-policy.js';
import { classifiedRefusal } from '../../scripts/live/evidence.js';

const engineCase: HostProbeCase = {
  id: 'HOST-COMMON-002',
  title: 'the shipped artifact can start an engine (claude-code)',
  async run(context) {
    const installed = context.cliVersion('claude', ['--version']);
    if (installed === 'not-installed') return { status: 'na', reason: 'the Claude Code CLI is not installed on this machine; the engine spawn path cannot be exercised' };
    const server = await context.startServer();
    try {
      const created = await server.request('tools/call', { name: 'session_create', arguments: { engine: 'claude-code', cwd: server.workRoot } });
      const failure = context.toolFailure(created);
      if (failure !== undefined) {
        if (classifiedRefusal(failure) !== undefined) {
          return { status: 'na', exemptedEngine: 'claude-code', reason: `the Claude Code CLI came up and refused while the session was being created (Realm classified the failure as authentication-class; quota exhaustion and a lapsed login are indistinguishable here): ${failure.message ?? failure.code ?? 'unknown'}` };
        }
        throw new Error(`session_create failed: ${failure.code ?? 'unknown'} ${failure.message ?? ''}`.trim());
      }
      const sessionId = (created.structuredContent as { sessionId?: string } | undefined)?.sessionId;
      if (sessionId === undefined) throw new Error('session_create returned no sessionId');
      await server.request('tools/call', { name: 'session_close', arguments: { sessionId } });
      return { status: 'pass', evidence: { engine: 'claude-code', lifecycleOwner: 'runskein', cliVersion: installed } };
    } finally {
      await server.stop('SIGTERM').catch(() => undefined);
      await rm(server.dataRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  },
};

const stopHookCase: HostProbeCase = {
  id: 'HOST-COMMON-003',
  title: 'the shipped Stop hook runs as its own process and hands the anchor back',
  async run(context) {
    const entry = join(context.root, 'hosts', 'claude-code', context.nannyHookEntry);
    if (!existsSync(entry)) throw new Error(`the staged hook is missing: hosts/claude-code/${context.nannyHookEntry}`);
    const server = await context.startServer();
    const sentinel = `anchor-sentinel-${context.runId}`;
    try {
      const written = await server.request('tools/call', { name: 'anchor', arguments: { content: sentinel } });
      const failure = context.toolFailure(written);
      if (failure !== undefined) throw new Error(`anchor write failed: ${failure.code ?? 'unknown'} ${failure.message ?? ''}`.trim());
      const payload = { hook_event_name: 'Stop', cwd: server.workRoot, stop_hook_active: false };
      const answered = await context.runStagedHook(entry, payload, { REALM_PLUGIN_DATA_ROOT: server.dataRoot });
      if (answered.code !== 0) throw new Error(`the hook exited ${String(answered.code)}; a hook that fails interferes with a host it was only observing`);
      if (answered.stdout === '') throw new Error('the hook produced no output while an anchor was set');
      const decision = JSON.parse(answered.stdout) as { decision?: string; reason?: string };
      if (decision.decision !== 'block') throw new Error(`expected a block, got ${JSON.stringify(decision).slice(0, 120)}`);
      if (!(decision.reason ?? '').includes(sentinel)) throw new Error('the anchor did not come back verbatim');

      const delegated = await context.runStagedHook(entry, payload, {
        REALM_PLUGIN_DATA_ROOT: server.dataRoot,
        [DELEGATION_ENV.version]: '1',
        [DELEGATION_ENV.depth]: '1',
        [DELEGATION_ENV.root]: 'a'.repeat(32),
      });
      if (delegated.stdout !== '') throw new Error('the hook spoke inside a delegated worker; the recursion guard is not in the shipped bundle');
      const bare = await mkdtemp(join(tmpdir(), 'taskshuttle-host-nanny-bare-'));
      const quiet = await context.runStagedHook(entry, payload, { REALM_PLUGIN_DATA_ROOT: bare });
      await rm(bare, { recursive: true, force: true }).catch(() => undefined);
      if (quiet.stdout !== '') throw new Error('the hook spoke with no state to report; §6 requires silence');
      return { status: 'pass', evidence: { entry: `hosts/claude-code/${context.nannyHookEntry}`, blocked: true, guardSilent: true, emptySilent: true } };
    } finally {
      await server.stop('SIGTERM').catch(() => undefined);
      await rm(server.dataRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  },
};

export default [engineCase, stopHookCase] satisfies readonly HostProbeCase[];
