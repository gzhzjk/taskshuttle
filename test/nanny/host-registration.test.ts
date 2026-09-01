import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * NANNY-024: the host registrations against the host contracts.
 *
 * Every shape here was read out of the host's own binary, and the failure mode
 * they share is silence: a hook registered under a name a host does not accept,
 * or pointing at a file the bundle does not carry, simply never runs — and by
 * the design's §6 a nanny that never runs is indistinguishable from one that
 * found nothing to say.
 *
 * opencode has no case here: ADR 0022 withdrew its host-side nanny injection
 * (stdio MCP cannot carry it), so there is no registration to assert.
 */

const root = process.cwd();

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, path), 'utf8')) as Record<string, unknown>;
}

/** The command's target must exist in that host's own bundle, not merely in `dist/`. */
async function expectBundled(host: string): Promise<void> {
  await expect(access(join(root, 'hosts', host, 'dist', 'nanny.js'))).resolves.toBeUndefined();
}

interface ClaudeStyleHooks {
  hooks: { Stop?: { hooks: { type?: string; command?: string; args?: string[]; timeout?: number }[] }[] };
}

describe('nanny host registration', () => {
  it('claude-code registers Stop in exec form, so no path ever reaches a shell parser', async () => {
    const config = (await readJson('hosts/claude-code/hooks/hooks.json')) as unknown as ClaudeStyleHooks;
    const entries = config.hooks.Stop ?? [];
    expect(entries).toHaveLength(1);
    const handler = entries[0]!.hooks[0]!;
    expect(handler.type).toBe('command');
    // With `args` present the host substitutes placeholders per element as
    // plain strings; a single shell string would break on a plugin path
    // containing a space, a quote or a `$`.
    expect(handler.command).toBe('node');
    expect(handler.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/dist/nanny.js']);
    expect(handler.timeout).toBeGreaterThan(0);
    await expectBundled('claude-code');
  });

  it('codex registers Stop as a shell string with $PLUGIN_ROOT, the form its runner supports', async () => {
    const config = (await readJson('hosts/codex/hooks/hooks.json')) as unknown as ClaudeStyleHooks;
    const entries = config.hooks.Stop ?? [];
    expect(entries).toHaveLength(1);
    const handler = entries[0]!.hooks[0]!;
    expect(handler.type).toBe('command');
    // codex has no `args` field and runs the command through `SHELL -l -c`,
    // exporting PLUGIN_ROOT — so the path is quoted here rather than passed
    // as an element.
    expect(handler.args).toBeUndefined();
    expect(handler.command).toContain('"$PLUGIN_ROOT/dist/nanny.js"');
    await expectBundled('codex');
  });

  it('both hosts spell the event Stop — codex also has a snake_case enum that has no stop at all', async () => {
    for (const host of ['claude-code', 'codex']) {
      const config = (await readJson(`hosts/${host}/hooks/hooks.json`)) as unknown as ClaudeStyleHooks;
      // The registrable names are PascalCase. codex carries a second,
      // snake_case `HookEventName` enum (pre_tool_use … subagent_stop) which
      // contains no stop entry; a registration copied from that list parses and
      // then never fires.
      expect(Object.keys(config.hooks)).toEqual(['Stop']);
    }
  });

  it("kimi's entry fits a strict schema: known keys only, timeout inside 1..600", async () => {
    const manifest = await readJson('hosts/kimi/kimi.plugin.json');
    const hooks = manifest['hooks'] as { event?: string; command?: string; timeout?: number; matcher?: string }[];
    expect(Array.isArray(hooks)).toBe(true);
    expect(hooks).toHaveLength(1);
    const hook = hooks[0]!;
    expect(hook.event).toBe('Stop');
    expect(hook.command).toContain('"$KIMI_PLUGIN_ROOT/dist/nanny.js"');
    // The schema is `.strict()`: one unknown key rejects the whole entry, and
    // the ceiling is 600 — the reference implementation's 900 is illegal here.
    expect(Object.keys(hook).sort()).toEqual(['command', 'event', 'timeout']);
    expect(hook.timeout).toBeGreaterThanOrEqual(1);
    expect(hook.timeout).toBeLessThanOrEqual(600);
    await expectBundled('kimi');
  });
});
