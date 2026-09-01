import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTaskShuttleServer, type TaskShuttleServer } from '../../packages/plugin/src/server.js';
import { FakeRunskeinHub, type FakeRunskeinSession } from '../../packages/plugin/src/testkit/fake-runskein.js';

/**
 * INV-005 / INV-006 / INV-013 — prompt gates and the ACP resource-link baseline.
 *
 * The gated image and embedded-resource cases assert refusals at the caller
 * boundary — the envelope `invoke` returns — because that is where mvp §6.4's
 * "including the engine, block type, and required capability" is owed. The
 * resource-link case instead proves the ACP baseline across all descriptor
 * states and at the Runskein boundary.
 */

const open: TaskShuttleServer[] = [];

function descriptorWith(prompt: { image: boolean; embeddedContext?: boolean }) {
  return {
    engine: 'codex',
    installed: true,
    authenticated: true,
    available: true,
    capabilities: { loadSession: true, session: { fork: true }, prompt, mcp: {}, providers: false },
    models: [],
    modes: [],
    providers: [],
    configOptions: [],
    source: 'builtin',
  };
}

const engineInfos = [{ id: 'codex', installed: true, authenticated: true, health: 'ready', version: '1.0.0' }];

async function startWith(prompt: { image: boolean; embeddedContext?: boolean }): Promise<{ plugin: TaskShuttleServer; hub: FakeRunskeinHub; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), 'taskshuttle-prompt-gate-'));
  const hub = new FakeRunskeinHub({
    closeResolvesPrompt: true,
    engineInfos: engineInfos as never,
    descriptors: { codex: descriptorWith(prompt) } as never,
  });
  const plugin = createTaskShuttleServer({
    dataRoot: root,
    env: { REALM_PLUGIN_CONFIG: JSON.stringify({ allowedRoots: [tmpdir()] }) } as NodeJS.ProcessEnv,
    hostCwd: tmpdir(),
    hubFactory: () => Object.assign(hub, { on: () => () => undefined, rescan: async () => undefined }) as never,
  });
  open.push(plugin);
  await plugin.runtime.ready;
  return { plugin, hub, cwd: root };
}

async function openSession(plugin: TaskShuttleServer, cwd: string): Promise<string> {
  const created = await plugin.invoke('session_create', { engine: 'codex', cwd });
  if (!created.ok) throw new Error(`session_create failed: ${created.error.code}`);
  return created.output.sessionId as string;
}

/** Poll rather than sleep: dispatch is asynchronous and a fixed wait is a flake. */
async function settled(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error('condition did not settle in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close().catch(() => undefined);
});

describe('prompt capability gates and the ACP resource-link baseline', () => {
  it('INV-005: an image block without prompt.image is refused, naming the capability', async () => {
    const { plugin, cwd } = await startWith({ image: false, embeddedContext: true });
    const sessionId = await openSession(plugin, cwd);
    const refused = await plugin.invoke('turn_start', {
      sessionId,
      prompt: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toMatchObject({
      code: 'NOT_SUPPORTED',
      details: { engine: 'codex', blockType: 'image', requiredCapability: 'prompt.image' },
    });
    // INV-005 registers the refusal as happening **before enqueue**, and the
    // envelope alone cannot tell: a gate moved below `turns.start` would refuse
    // identically with a turn already queued behind it. This assertion pins the
    // ordering for the gated image path; the embedded-resource case exercises
    // the same runtime gate independently.
    const turns = await plugin.invoke('turn_list', { sessionId });
    expect(turns.ok && turns.output.turns).toEqual([]);
  });

  it('INV-006: a resource link is baseline with embeddedContext absent, false, or true', async () => {
    for (const embeddedContext of [undefined, false, true] as const) {
      const prompt = embeddedContext === undefined ? { image: true } : { image: true, embeddedContext };
      const { plugin, hub, cwd } = await startWith(prompt);
      const sessionId = await openSession(plugin, cwd);
      const block = { type: 'resource_link', name: 'spec', uri: 'not-a-url' };
      const started = await plugin.invoke('turn_start', { sessionId, prompt: [block] });
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(`turn_start failed: ${started.error.code}`);
      expect(plugin.runtime.registry.getTurn(started.output.turnId as string)?.prompt).toEqual([block]);
      const realm = [...hub.sessions.values()][0] as FakeRunskeinSession;
      await settled(() => realm.promptCalls.length === 1);
      expect(realm.promptCalls[0]!.input).toEqual([block]);
      await plugin.close();
      open.splice(open.indexOf(plugin), 1);
    }
  });

  it('INV-013: an embedded resource without prompt.embeddedContext is refused, naming the capability', async () => {
    const { plugin, cwd } = await startWith({ image: true, embeddedContext: false });
    const sessionId = await openSession(plugin, cwd);
    const refused = await plugin.invoke('turn_start', {
      sessionId,
      prompt: [{ type: 'resource', resource: { uri: 'file:///tmp/diff.patch', text: 'diff --git a b' } }],
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toMatchObject({
      code: 'NOT_SUPPORTED',
      details: { engine: 'codex', blockType: 'resource', requiredCapability: 'prompt.embeddedContext' },
    });
  });

  it('INV-013: with the capability, the block reaches Runskein byte-identical and its uri is never touched', async () => {
    const { plugin, hub, cwd } = await startWith({ image: true, embeddedContext: true });
    const sessionId = await openSession(plugin, cwd);
    // A scheme-less label, which `z.string().url()` rejects — that is the point:
    // ADR 0050 decision 6 fixes that the plugin neither dereferences nor
    // constrains the uri, and this assertion has to fail if someone tightens it.
    // Measured twice, because the obvious values do not work: `taskshuttle:…`
    // and even `prefetch: git show HEAD` both *pass* `url()`, which accepts any
    // scheme — a case built on either could not fail under the mutation it
    // exists to catch.
    const block = { type: 'resource', resource: { uri: 'prefetch/git-show-HEAD', text: 'diff --git a b' } };
    const started = await plugin.invoke('turn_start', { sessionId, prompt: [block] });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(plugin.runtime.registry.getTurn(started.output.turnId as string)?.prompt).toEqual([block]);
    // "Reaches Runskein" is the hub boundary, not the turn record. The seam that
    // could convert is `textFromPrompt` at the runtime's `run` callback — it
    // already collapses a lone text block to a string — so a registry-only
    // assertion would pass a build that flattened this block on the way out.
    // Negative-tested by making `textFromPrompt` flatten `resource` to text:
    // this goes red, the registry assertion above does not. Dispatch is
    // asynchronous, hence the settle.
    //
    // What this cannot see, so nobody re-wires the fake trying to reach it:
    // `RunskeinAgentProvider.prompt` is not on the runtime's turn path at all —
    // the runtime builds a `RunskeinSessionAdapter` over the hub instead, in
    // production exactly as here. Mutating that provider turns nothing red
    // because nothing calls it, which is a fact about the code, not a gap in
    // this fixture.
    const realm = [...hub.sessions.values()][0] as FakeRunskeinSession;
    await settled(() => realm.promptCalls.length === 1);
    expect(realm.promptCalls[0]!.input).toEqual([block]);
  });
});
