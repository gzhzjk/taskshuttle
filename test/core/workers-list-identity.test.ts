// ART-018 (ADR 0043). `workers_list` returns the id of the instance that
// answered, and this suite asserts it from both ends: the response is validated
// against the **published** catalog rather than against the Zod schema that
// produced it, and the id is compared with `instance.json` read off disk.
//
// The two live cases are the producer half, and the two deletions they cover
// fail by **different mechanisms**, which is worth stating because the obvious
// reading is wrong. Delete the field from `docs/tool-schemas.json` and they go
// red here, on `additionalProperties: false` — and in the artifact gate, which
// calls the same checker over the same catalog; before ADR 0043 nothing in this
// repository compared a response with the published contract at all. Delete it
// from `src/core/runtime.ts` and the response never reaches this suite's
// checker at all: `ToolFacade` validates against
// `src/schemas.ts` first and the call fails `INTERNAL`, so `listWorkers`
// throws. Both are red, only one of them is red *because of the catalog*.
// Measured both ways rather than assumed.
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { checkWorkersListIdentity, readToolCatalog, type ToolCatalog } from '../../scripts/tool-catalog.js';
import { createTaskShuttleServer, type TaskShuttleServer } from '../../packages/plugin/src/server.js';
import { simulatedHubFactory } from '../../packages/plugin/src/testkit/simulated-engines.js';

const open: TaskShuttleServer[] = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close().catch(() => undefined);
});

/** A plugin on its own data root, with the console configured as the case needs. */
async function start(consoleEnabled: boolean): Promise<TaskShuttleServer> {
  const plugin = createTaskShuttleServer({
    dataRoot: await mkdtemp(join(tmpdir(), 'taskshuttle-instance-identity-')),
    env: {
      REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [tmpdir()], console: { enabled: consoleEnabled } }),
      REALM_PLUGIN_LOG: 'off',
    } as NodeJS.ProcessEnv,
    hostCwd: tmpdir(),
    hubFactory: simulatedHubFactory(),
    logSink: () => undefined,
  });
  open.push(plugin);
  await plugin.runtime.ready;
  return plugin;
}

/**
 * The manifest's own record of who this instance is — read from the file rather
 * than from the runtime object, because two values projected from one field
 * agree under any consistent lie.
 */
async function manifestInstanceId(plugin: TaskShuttleServer): Promise<string> {
  const path = join(plugin.runtime.dataRoot, 'instances', plugin.runtime.instanceId, 'instance.json');
  return (JSON.parse(await readFile(path, 'utf8')) as { instanceId: string }).instanceId;
}

/**
 * The MCP callback this plugin actually registered for one tool.
 *
 * `plugin.invoke` stops at the facade; a host sees what `registerMcpTools`
 * built from the facade's result, and that projection is where an error's text
 * envelope is written. This reaches the registered handler itself rather than
 * wiring a second facade over the same runtime — a parallel wiring would keep
 * passing if `createTaskShuttleServer` ever composed the two differently, which
 * is the drift this assertion exists to be immune to. `scripts/artifact-gate.ts`
 * reads the same private map to count tools.
 *
 * @param plugin - a started plugin.
 * @param name - the tool whose registered handler is wanted.
 * @returns the handler, taking tool input and resolving to the wire result.
 * @throws Error when the server registered nothing under that name.
 */
function wireHandlerFor(plugin: TaskShuttleServer, name: string): (input: unknown) => Promise<Record<string, unknown>> {
  const registered = (plugin.server as unknown as { _registeredTools?: Record<string, { handler?: unknown }> })._registeredTools;
  const handler = registered?.[name]?.handler;
  if (typeof handler !== 'function') throw new Error(`the server registered no handler for ${name}`);
  return handler as (input: unknown) => Promise<Record<string, unknown>>;
}

async function listWorkers(plugin: TaskShuttleServer): Promise<unknown> {
  const result = await plugin.invoke('workers_list', { rescan: false });
  if (!result.ok) throw new Error(`workers_list failed: ${result.error.code}`);
  return result.output;
}

describe('ART-018: workers_list says which instance answered', () => {
  let catalog: ToolCatalog;

  beforeAll(async () => {
    catalog = await readToolCatalog(process.cwd());
  });

  // Both runs assert the same thing, which is the decision: the field is
  // unconditional, so a build that returned it only when a console was running
  // would satisfy a console-enabled-only case and still be wrong.
  for (const consoleEnabled of [false, true]) {
    it(`reports the id the manifest on disk records, with the console ${consoleEnabled ? 'enabled' : 'disabled'}`, async () => {
      const plugin = await start(consoleEnabled);
      const output = await listWorkers(plugin);
      expect(checkWorkersListIdentity({ catalog, output, manifestInstanceId: await manifestInstanceId(plugin), consoleEnabled })).toEqual([]);
      // Named separately so a failure here is legible without reading the
      // checker: the field exists and is the instance's own id.
      expect((output as { instanceId?: unknown }).instanceId).toBe(await manifestInstanceId(plugin));
    });
  }

  it('discloses the id and no other console fact', async () => {
    // The bound the ADR 0003 amendment is drawn on, asserted by name rather
    // than left to `additionalProperties: false` to imply. A build that added
    // the port here would satisfy every other case in this file.
    const plugin = await start(true);
    const output = (await listWorkers(plugin)) as Record<string, unknown>;
    expect(Object.keys(output).sort()).toEqual(['instanceId', 'workers']);
    for (const forbidden of ['port', 'consolePort', 'console', 'enabled', 'listening', 'url']) {
      expect(output).not.toHaveProperty(forbidden);
    }
  });

  it('reports no id on a failed call, on the wire and not merely inside the facade', async () => {
    // mvp §12: the id rides on a successful response and on no other result.
    // An unknown capability path is the cheapest way to make the call fail
    // after the runtime is ready, so this exercises the real error path.
    //
    // Asserted against the **transport's** result rather than the facade's.
    // An earlier version of this case read `plugin.invoke`'s return value,
    // which is the facade's internal shape; the text envelope a host actually
    // receives is built afterwards in `registerMcpTools`, so a leak written
    // there would have passed. A reviewer found that, and it is the failure
    // this repository names first: a check placed where its subject cannot
    // reach it. Each of the three assertions below was made to fail on its
    // own — `isError` removed, `structuredContent` added back, and the id
    // written into the transport's text and nowhere else.
    const plugin = await start(false);
    const wire = await wireHandlerFor(plugin, 'workers_list')({ rescan: false, requires: ['no.such'] });
    expect(wire['isError']).toBe(true);
    // ADR 0024, and the reason the id cannot ride along: an error carries no
    // structured content, and this field is structured content.
    expect(wire['structuredContent']).toBeUndefined();
    expect(JSON.stringify(wire)).toContain('INVALID_ARGUMENT');
    expect(JSON.stringify(wire)).not.toContain(plugin.runtime.instanceId);
  });

  it('the published catalog requires the field, so dropping it from the runtime cannot pass', async () => {
    const schema = catalog.tools['workers_list']!.outputSchema as { required: string[]; additionalProperties: unknown };
    expect(schema.required).toContain('instanceId');
    expect(schema.additionalProperties).toBe(false);
  });
});

// The identity comparison itself. The cases above cannot distinguish a checker
// that compares from one that returns [] unconditionally; these can, and they
// are honestly consumer-side — the response is mutated rather than the code
// that produced it.
describe('ART-018 negatives: what the check must refuse', () => {
  let catalog: ToolCatalog;
  let plugin: TaskShuttleServer;
  let output: Record<string, unknown>;
  let onDisk: string;

  beforeAll(async () => {
    catalog = await readToolCatalog(process.cwd());
  });

  beforeEach(async () => {
    plugin = await start(false);
    output = (await listWorkers(plugin)) as Record<string, unknown>;
    onDisk = await manifestInstanceId(plugin);
  });

  it('an absent field fails against the catalog', () => {
    const { instanceId: _dropped, ...without } = output;
    const issues = checkWorkersListIdentity({ catalog, output: without, manifestInstanceId: onDisk, consoleEnabled: false });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("must have required property 'instanceId'");
  });

  it('a fabricated id fails against the manifest', () => {
    const issues = checkWorkersListIdentity({ catalog, output: { ...output, instanceId: 'not-this-instance' }, manifestInstanceId: onDisk, consoleEnabled: false });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: 'packages/plugin/src/runtime.ts' });
    expect(issues[0]!.message).toContain(onDisk);
  });

  it("another live instance's id fails, which a presence check would not catch", async () => {
    const other = await start(false);
    const issues = checkWorkersListIdentity({ catalog, output: { ...output, instanceId: await manifestInstanceId(other) }, manifestInstanceId: onDisk, consoleEnabled: false });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: 'packages/plugin/src/runtime.ts' });
  });

  it('a non-string id fails as a contract error and not as a mismatch', () => {
    const issues = checkWorkersListIdentity({ catalog, output: { ...output, instanceId: 7 }, manifestInstanceId: onDisk, consoleEnabled: false });
    // One issue, from the schema: calling a number "does not match the
    // manifest" would name the wrong defect. This is the case a hand-rolled
    // presence check would have passed, and why the catalog is compiled with a
    // real validator (ADR 0043).
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: 'packages/plugin/src/schemas.ts' });
    expect(issues[0]!.message).toContain('must be string');
  });

  it('a missing workers array fails, because the claim is that the whole response is validated', () => {
    // Without this, a catalog that lost `workers` from `required` would leave
    // `{ instanceId }` passing — the check would be about one field while the
    // test plan's row says it is about the response.
    const { workers: _dropped, ...without } = output;
    const issues = checkWorkersListIdentity({ catalog, output: without, manifestInstanceId: onDisk, consoleEnabled: false });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("must have required property 'workers'");
  });

  it('a malformed worker entry fails, so drift inside WorkerSummary is caught too', () => {
    // The `$ref` into the catalog's `$defs` has to resolve for this to fail;
    // it is what a hand-rolled presence check would not have reached.
    const issues = checkWorkersListIdentity({ catalog, output: { ...output, workers: [{ engine: 'codex' }] }, manifestInstanceId: onDisk, consoleEnabled: false });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.path === 'packages/plugin/src/schemas.ts')).toBe(true);
    expect(issues.map((issue) => issue.message).join(' ')).toContain('/workers/0');
  });

  it('an empty id fails the published minimum length, not merely the comparison', () => {
    // Matched against an equally empty manifest id on purpose: with the two
    // equal, the identity comparison stays silent and only `minLength: 1` can
    // produce the failure.
    const issues = checkWorkersListIdentity({ catalog, output: { ...output, instanceId: '' }, manifestInstanceId: '', consoleEnabled: false });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: 'packages/plugin/src/schemas.ts' });
    expect(issues[0]!.message).toContain('must NOT have fewer than 1 characters');
  });

  it('an unpublished extra field fails, so the catalog cannot silently fall behind', () => {
    const issues = checkWorkersListIdentity({ catalog, output: { ...output, consolePort: 4720 }, manifestInstanceId: onDisk, consoleEnabled: false });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('must NOT have additional properties');
  });
});
