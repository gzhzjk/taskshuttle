// SEC-REC-007..018 consumer half (ADR 0031): how the runtime, the console
// start authorities, `project_init` and the manifest act on a settled verdict.
// The verdict arrives through RuntimeOptions.delegation — the same seam cli.ts
// feeds from settleDelegation — with the environment markers scrubbed, so every
// refusal below is attributable to the ancestry verdict alone: against a
// marker-only implementation these cases pass their fixtures and fail loudly.
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import type { LogRecord } from '../../packages/plugin/src/logger.js';
import { projectKeyFor } from '../../packages/plugin/src/project-config.js';
import { DELEGATION_ENV, readDelegationIdentity, SecurityPolicyError } from '../../packages/plugin/src/security-policy.js';
import { createTaskShuttleServer, type TaskShuttleServer } from '../../packages/plugin/src/server.js';
import { runNannyHook } from '../../packages/plugin/src/nanny.js';
import type { DelegationDiagnostics, DelegationRecord } from '../../packages/plugin/src/delegation-evidence.js';
import { simulatedHubFactory } from '../../packages/plugin/src/testkit/simulated-engines.js';

const open: TaskShuttleServer[] = [];
const logs = new Map<TaskShuttleServer, LogRecord[]>();

/** The minimal generation skeleton `project_init` needs; the file side is not this suite's subject. */
const TEMPLATE = {
  defaultProfile: 'implementing',
  profiles: { implementing: { purpose: 'implementing an agreed task', config: {} }, reviewing: { config: {} } },
};

/**
 * Starts a plugin whose verdict is already settled. The environment never
 * carries a marker — asserted before anything else runs, because a fixture
 * that supplies the marker the code should be inferring tests only what
 * SEC-REC-005 already covered.
 */
async function start(config: Record<string, unknown>, delegation?: DelegationRecord, delegationDiagnostics?: DelegationDiagnostics): Promise<TaskShuttleServer> {
  const templatePath = join(await mkdtemp(join(tmpdir(), 'taskshuttle-delegation-tpl-')), 'default-config.json');
  await writeFile(templatePath, JSON.stringify(TEMPLATE), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [tmpdir()], ...config }),
    REALM_PLUGIN_DEFAULTS_TEMPLATE: templatePath,
    REALM_PLUGIN_LOG: 'off',
  } as NodeJS.ProcessEnv;
  for (const variable of Object.values(DELEGATION_ENV)) expect(env[variable]).toBeUndefined();
  // The marker half alone would admit everything this suite refuses: prove it.
  const marker = readDelegationIdentity(env);
  expect(marker.depth).toBe(0);
  expect(marker.recursionDenied).toBe(false);
  const sink: LogRecord[] = [];
  const plugin = createTaskShuttleServer({
    dataRoot: await mkdtemp(join(tmpdir(), 'taskshuttle-delegation-consumer-')),
    env,
    hostCwd: tmpdir(),
    hubFactory: simulatedHubFactory(),
    logSink: (record) => { sink.push(record); },
    ...(delegation === undefined ? {} : { delegation }),
    ...(delegationDiagnostics === undefined ? {} : { delegationDiagnostics }),
  });
  open.push(plugin);
  logs.set(plugin, sink);
  await plugin.runtime.ready;
  return plugin;
}

function consoleJsonPath(plugin: TaskShuttleServer): string {
  return join(plugin.runtime.dataRoot, 'instances', plugin.runtime.instanceId, 'console.json');
}

async function readManifestDelegation(plugin: TaskShuttleServer): Promise<{ provenance: string; depth?: number }> {
  const manifest = JSON.parse(await readFile(join(plugin.runtime.dataRoot, 'instances', plugin.runtime.instanceId, 'instance.json'), 'utf8')) as { delegation?: { provenance: string; depth?: number } };
  if (manifest.delegation === undefined) throw new Error('the manifest carries no delegation object');
  return manifest.delegation;
}

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close().catch(() => undefined);
});

describe('session gates on the settled verdict (SEC-REC-007)', () => {
  it('a scrubbed environment plus an ancestor lock is refused at session_create and session_fork', async () => {
    const plugin = await start({}, { provenance: 'ancestry', depth: 1 });
    const created = await plugin.invoke('session_create', { engine: 'kimi', cwd: plugin.runtime.hostCwd });
    expect(created.ok).toBe(false);
    if (created.ok) throw new Error('unreachable');
    expect(created.error.code).toBe('RECURSION_DENIED');
    // The gate precedes the session lookup: a fork is refused as itself, not
    // laundered into a NOT_FOUND for a session that could never exist.
    const forked = await plugin.invoke('session_fork', { sessionId: 'no-such-session' });
    expect(forked.ok).toBe(false);
    if (!forked.ok) expect(forked.error.code).toBe('RECURSION_DENIED');
  });

  it('an unavailable verdict still serves tools — refusing work is not how this fails closed', async () => {
    const plugin = await start({ console: { enabled: true } }, { provenance: 'unavailable' });
    const inventory = await plugin.invoke('workers_list', { rescan: true });
    expect(inventory.ok).toBe(true);
    // The console is where the doubt lands instead (asserted fully in its own case).
    expect(existsSync(consoleJsonPath(plugin))).toBe(false);
  });
});

describe('the withheld console names its doubt (SEC-REC-026)', () => {
  it('carries the cause, what the scan read, and the instance a delegated verdict matched', async () => {
    const plugin = await start({ console: { enabled: true } }, { provenance: 'ancestry', depth: 1 },
      { cause: 'start-time-family', records: 1713, scanMs: 42, matchedInstanceId: 'root-one' });
    const withheld = logs.get(plugin)!.find((record) => record.event === 'console_withheld');
    expect(withheld).toMatchObject({
      provenance: 'ancestry', operation: 'console/boot',
      cause: 'start-time-family', records: 1713, scanMs: 42, matchedInstanceId: 'root-one',
    });
  });

  it('omits the count and the duration where no scan ran, rather than reporting zero', async () => {
    // The marker short-circuit settles before reading anything; a zero here
    // would read as "scanned and found none", which is the misdiagnosis this
    // field set exists to end.
    const plugin = await start({ console: { enabled: true } }, { provenance: 'marker', depth: 1 }, { cause: 'no-scan' });
    const withheld = logs.get(plugin)!.find((record) => record.event === 'console_withheld');
    expect(withheld).toMatchObject({ provenance: 'marker', cause: 'no-scan' });
    for (const field of ['records', 'scanMs', 'matchedInstanceId']) expect(Object.hasOwn(withheld!, field)).toBe(false);
  });

  it('says nothing extra when the runtime settled no verdict of its own', async () => {
    const plugin = await start({ console: { enabled: true } }, { provenance: 'unavailable' });
    const withheld = logs.get(plugin)!.find((record) => record.event === 'console_withheld');
    expect(withheld).toMatchObject({ provenance: 'unavailable' });
    for (const field of ['cause', 'records', 'scanMs', 'matchedInstanceId']) {
      expect(Object.hasOwn(withheld!, field)).toBe(false);
    }
  });
});

describe('console gating on the settled verdict (SEC-REC-008/011)', () => {
  it('a delegated instance starts no listener and says why — withheld, not failed', async () => {
    const plugin = await start({ console: { enabled: true } }, { provenance: 'ancestry', depth: 1 });
    expect(existsSync(consoleJsonPath(plugin))).toBe(false);
    const records = logs.get(plugin)!;
    expect(records).toContainEqual(expect.objectContaining({ event: 'console_withheld', provenance: 'ancestry' }));
    // A console that was withheld has not failed at anything.
    expect(records.some((record) => record.event === 'console_start_failed')).toBe(false);
    expect(records.some((record) => record.event === 'console_started')).toBe(false);
  });

  it('an unavailable instance keeps the console down too, and the manifest says so without a depth', async () => {
    const plugin = await start({ console: { enabled: true } }, { provenance: 'unavailable' });
    expect(existsSync(consoleJsonPath(plugin))).toBe(false);
    expect(logs.get(plugin)!).toContainEqual(expect.objectContaining({ event: 'console_withheld', provenance: 'unavailable' }));
    const delegation = await readManifestDelegation(plugin);
    expect(delegation.provenance).toBe('unavailable');
    expect(Object.hasOwn(delegation, 'depth')).toBe(false);
  });
});

describe('a root serves both halves (SEC-REC-009)', () => {
  it('no marker and no matching lock: create/fork proceed and the console starts when enabled', async () => {
    // The data root is fresh: no live lock belongs to any ancestor of this
    // process, which is exactly the narrowed SEC-REC-001 condition.
    const plugin = await start({ console: { enabled: true } });
    const created = await plugin.invoke('session_create', { engine: 'kimi', cwd: plugin.runtime.hostCwd });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('unreachable');
    const forked = await plugin.invoke('session_fork', { sessionId: created.output.sessionId });
    expect(forked.ok).toBe(true);
    // "Not withheld" means actually started: the check cannot be satisfied by
    // refusing everything, and it cannot be satisfied by starting nothing.
    expect(existsSync(consoleJsonPath(plugin))).toBe(true);
    expect(await readManifestDelegation(plugin)).toEqual({ provenance: 'root', depth: 0 });
  });
});

describe('malformed markers fail closed in each consumer (SEC-REC-013)', () => {
  it('server half: the malformed marker propagates and no server is created', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-delegation-malformed-'));
    // A partial marker: version present, depth and root missing.
    const env = { REALM_DELEGATION_VERSION: '1' } as NodeJS.ProcessEnv;
    let thrown: unknown;
    try {
      createTaskShuttleServer({
        dataRoot,
        env,
        hostCwd: tmpdir(),
        hubFactory: simulatedHubFactory(),
      });
    } catch (cause) { thrown = cause; }
    expect(thrown).toBeInstanceOf(SecurityPolicyError);
    expect((thrown as SecurityPolicyError).code).toBe('RECURSION_DENIED');
    // No server means no instance artifacts: nothing recorded a state that no
    // running instance ever held.
    const entries = await readdir(dataRoot).catch(() => []);
    expect(entries).toEqual([]);
  });

  it('nanny half: the hook catches it and exits successfully, silently', async () => {
    let out = '';
    const code = await runNannyHook({
      env: { REALM_DELEGATION_VERSION: '1' } as NodeJS.ProcessEnv,
      stdin: Readable.from([JSON.stringify({ cwd: tmpdir() })]),
      write: (text) => { out += text; },
    });
    expect(code).toBe(0);
    expect(out).toBe('');
  });
});

describe('project_init precedence (SEC-REC-015)', () => {
  it('unavailable reports withheld and still generates the file side', async () => {
    const plugin = await start({ console: { enabled: false } }, { provenance: 'unavailable' });
    const result = await plugin.invoke('project_init', {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.output.console.state).toBe('withheld');
    expect('port' in result.output.console).toBe(false);
    expect(result.output.created).toBe(true);
    expect(result.output.content.length).toBeGreaterThan(0);
    expect(logs.get(plugin)!).toContainEqual(expect.objectContaining({ event: 'console_withheld', provenance: 'unavailable' }));
  });

  it('allowInitStart: false outranks an unavailable verdict — the operator is owed that answer (ADR 0019/0031)', async () => {
    const plugin = await start({ console: { allowInitStart: false } }, { provenance: 'unavailable' });
    const result = await plugin.invoke('project_init', {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.output.console.state).toBe('disabled');
  });

  it('already-running outranks the veto: a console the operator can watch is not disabled (ADR 0019/0031)', async () => {
    // enabled governs the boot start, allowInitStart only project_init's — so
    // both conditions hold at once, and the answer must name the running one.
    const plugin = await start({ console: { enabled: true, allowInitStart: false } }, { provenance: 'root', depth: 0 });
    expect(existsSync(consoleJsonPath(plugin))).toBe(true);
    const result = await plugin.invoke('project_init', {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.output.console.state).toBe('already-running');
  });

  it('a delegated instance is refused outright, whether marker or ancestry established it', async () => {
    for (const delegation of [
      { provenance: 'marker', depth: 2 },
      { provenance: 'ancestry', depth: 1 },
    ] as DelegationRecord[]) {
      const plugin = await start({ console: { enabled: true } }, delegation);
      const refused = await plugin.invoke('project_init', {});
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe('NOT_SUPPORTED');
      // Whole-tool refusal: neither side happened.
      expect(existsSync(consoleJsonPath(plugin))).toBe(false);
      expect(existsSync(join(plugin.runtime.dataRoot, projectKeyFor(plugin.runtime.hostCwd), 'config.json'))).toBe(false);
      await plugin.close();
    }
  });
});

describe('the manifest records every outcome that writes one (SEC-REC-017)', () => {
  it.each([
    [{ provenance: 'root', depth: 0 }, { provenance: 'root', depth: 0 }],
    [{ provenance: 'marker', depth: 2 }, { provenance: 'marker', depth: 2 }],
    [{ provenance: 'ancestry', depth: 1 }, { provenance: 'ancestry', depth: 1 }],
    [{ provenance: 'unavailable' }, { provenance: 'unavailable' }],
  ] as Array<[DelegationRecord, { provenance: string; depth?: number }]>)(
    'verdict %j is diagnosed from disk verbatim, with depth present exactly when established',
    async (verdict, expected) => {
      const plugin = await start({}, verdict);
      const delegation = await readManifestDelegation(plugin);
      expect(delegation).toEqual(expected);
      // Only `unavailable` omits the field: a zero there would be a guess
      // dressed as a fact, and `hasOwn` tells absence from a written zero.
      expect(Object.hasOwn(delegation, 'depth')).toBe(verdict.provenance !== 'unavailable');
    },
  );
});
