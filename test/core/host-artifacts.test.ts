import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { discoverHostArtifactSpecs, validateHostArtifacts } from '../../scripts/host-artifacts.js';

/**
 * The Realm version this release records, read from the file under test rather
 * than pinned here. The entry versions below stay literal — they are what makes
 * each message prove it carries its own record — but the release version is one
 * fact with one owner, and a copy of it here turns every Realm bump into a test
 * edit that says nothing about the gate.
 */
const RELEASE_REALM_VERSION = (JSON.parse(
  readFileSync(new URL('../../release/metadata.json', import.meta.url), 'utf8'),
) as { realmVersion: string }).realmVersion;

interface ClaudeHooks { hooks: { Stop: { hooks: { args?: string[] }[] }[] } }

/** Copy the staged release tree so a case can corrupt exactly one artifact. */
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'taskshuttle-artifacts-'));
  // NOTICE and LICENSE are part of the tree ART-016 validates, so a fixture
  // without them is not a copy of the release tree — it is a tree that already
  // fails, and every comparison below would be against nothing.
  for (const entry of ['dist', 'hosts', 'marketplaces', 'skills', 'release', 'NOTICE', 'LICENSE']) {
    await cp(join(process.cwd(), entry), join(root, entry), { recursive: true });
  }
  await mkdir(join(root, 'packages', 'plugin'), { recursive: true });
  await cp(join(process.cwd(), 'packages', 'plugin', 'package.json'), join(root, 'packages', 'plugin', 'package.json'));
  await cp(join(process.cwd(), 'packages', 'plugin', 'dist'), join(root, 'packages', 'plugin', 'dist'), { recursive: true });
  return root;
}

async function issuesFor(mutate: (root: string) => Promise<void>): Promise<string[]> {
  const root = await fixture();
  await mutate(root);
  return (await validateHostArtifacts(root)).map((issue) => `${issue.path}: ${issue.message}`);
}


/**
 * The two defect entries every ART-013 case works from, and their runtime
 * mirror.
 *
 * These used to be read out of the checked-in `release/metadata.json`, which
 * coupled nine cases to whatever that file happened to hold — and the runskein
 * migration retired both entries at R4, taking all nine red at once. A case
 * about the *gate's* freshness rules should not depend on the repository
 * currently having a live defect to be stale about, so it seeds its own.
 *
 * The runtime mirror `KNOWN_BROKEN_CAPABILITIES` is a frozen module constant
 * and is **empty** for the duration of the migration, so a seeded entry has no
 * mirror half and the gate correctly adds a "missing from
 * KNOWN_BROKEN_CAPABILITIES" issue for each. That is a true statement about
 * the fixture rather than noise to suppress, and it is why every case below
 * asserts with `toContain` on the message it is about instead of comparing the
 * whole issue list. A case that ever needs the list to be exactly one thing
 * has to seed the mirror too, which needs a module mock these do not use.
 */
const SEED_DEFECTS = [
  { id: 'ENG-FORK-001-claude-code', engine: 'claude-code', capability: 'session.fork', component: 'claude-agent-acp', componentVersion: '0.70.0', realmVersion: RELEASE_REALM_VERSION, owner: 'engine/wrapper', summary: 'seeded', impact: 'seeded', evidence: 'release/gates/seed.md (live)' },
  { id: 'ENG-FORK-001-pi', engine: 'pi', capability: 'session.fork', component: 'pi', componentVersion: '0.84.2', realmVersion: RELEASE_REALM_VERSION, owner: 'engine', summary: 'seeded', impact: 'seeded', evidence: 'release/gates/seed.md (live)' },
];

/** Read the fixture's metadata, seed the two entries, and hand it to `mutate`. */
async function withSeededDefects(root: string, mutate: (metadata: any) => void): Promise<void> {
  const path = join(root, 'release/metadata.json');
  const metadata = JSON.parse(await readFile(path, 'utf8')) as any;
  metadata.verification.knownDefects.entries = JSON.parse(JSON.stringify(SEED_DEFECTS));
  mutate(metadata);
  await writeFile(path, JSON.stringify(metadata));
}


/**
 * The checked-in tree's issues, minus the ones ADR 0026 expects to be there.
 *
 * Between R4 and R6 of the runskein migration both `knownDefects` entries are
 * dated against the previous release, so ART-013 reports each as expired —
 * correctly: an entry cannot be re-dated before the run that dates it, and R6
 * is that run. A case about something else must not assert the whole list is
 * empty, or it fails for a reason it is not about; and it must not ignore
 * every issue either, or it stops noticing real ones. So this drops exactly
 * the expiry messages and keeps everything else.
 */
async function issuesBesidesExpiredDefects(root: string): Promise<string[]> {
  const issues = await validateHostArtifacts(root);
  return issues
    .map((issue) => `${issue.path}: ${issue.message}`)
    .filter((issue) => !/known defect \S+ was last observed under \S+ /u.test(issue));
}

describe('host artifacts', () => {
  it('validates the public package dist rather than a stale root compatibility mirror', async () => {
    const issues = await issuesFor(async (root) => {
      await writeFile(join(root, 'packages', 'plugin', 'dist', 'launch.js'), 'export const stale = true;\n');
      // Keep the compatibility mirror untouched: a gate reading root/dist
      // would incorrectly report this fixture as healthy.
    });
    expect(issues).toContain('packages/plugin/dist/launch.js: launch shim must write an orphan marker and enforce private umask');
  });

  it('declares exactly the four frozen hosts, stages three packages, validates the checked-in release tree', async () => {
    const specs = await discoverHostArtifactSpecs(process.cwd());
    expect(specs.map((spec) => spec.host).sort()).toEqual(['claude-code', 'codex', 'kimi', 'opencode']);
    expect(specs).toHaveLength(4);
    await expect(issuesBesidesExpiredDefects(process.cwd())).resolves.toEqual([]);
  });

  it('ART-017: hosts/ holds exactly the staged hosts, and nothing the gate never sees', async () => {
    // A directory under `hosts/` that no spec names is validated by nothing,
    // restaged by nothing, and packed by `files: ["hosts"]` anyway. That is not
    // hypothetical: `hosts/opencode/` sat there from before ADR 0022 stopped
    // staging a package for opencode, gitignored so `git status` never showed
    // it, and `npm pack --dry-run` listed 19 of its files — a whole
    // pre-rename bundle, with the old dependency's log prefixes, its ACP
    // `clientInfo.name`, and an alias set from before this repository's own
    // rename.
    const issues = await issuesFor(async (root) => {
      await mkdir(join(root, 'hosts', 'ghost', 'dist'), { recursive: true });
      await writeFile(join(root, 'hosts', 'ghost', 'dist', 'cli.js'), 'export {};\n');
    });
    expect(issues).toContain('hosts/ghost: host directory matches no staged host spec; it is validated by nothing and packed by files: ["hosts"]');
  });

  it('ART-019: rejects a stale marketplace payload directory', async () => {
    const issues = await issuesFor(async (root) => {
      await mkdir(join(root, 'marketplaces', 'codex', 'plugins', 'stale'), { recursive: true });
    });
    expect(issues).toContain('marketplaces/codex/plugins/stale: marketplace payload directory matches no marketplace entry');
  });

  it('ART-020: requires the released package identity to be taskshuttle', async () => {
    const root = process.cwd();
    const manifest = JSON.parse(await readFile(join(root, 'packages/plugin/package.json'), 'utf8')) as { name?: unknown; bin?: Record<string, unknown> };
    expect(manifest.name).toBe('taskshuttle');
    expect(manifest.bin).toMatchObject({ taskshuttle: 'dist/launch.js', 'taskshuttle-launch': 'dist/launch.js' });
    for (const path of [
      'hosts/codex/.codex-plugin/plugin.json',
      'hosts/claude-code/.claude-plugin/plugin.json',
      'hosts/kimi/kimi.plugin.json',
      'marketplaces/codex/.agents/plugins/marketplace.json',
      'marketplaces/claude-code/.claude-plugin/marketplace.json',
    ]) {
      const value = JSON.parse(await readFile(join(root, path), 'utf8')) as { name?: unknown; plugins?: Array<{ name?: unknown }> };
      expect(value.name, path).toBe('taskshuttle');
      for (const plugin of value.plugins ?? []) expect(plugin.name, path).toBe('taskshuttle');
    }
  });

  it('ART-016: NOTICE and LICENSE ship at the root, in every staged bundle and every marketplace payload', async () => {
    // Three deletions, three messages. A distribution that inlines Apache-2.0
    // code and ships no attribution is a licence problem, not a cosmetic one,
    // and the staged bundles and marketplace payloads are distributions of
    // their own rather than copies of one (ADR 0041).
    for (const legal of ['NOTICE', 'LICENSE']) {
      const atRoot = await issuesFor(async (root) => { await rm(join(root, legal)); });
      expect(atRoot).toContain(`${legal}: third-party attribution is missing from the repository root`);

      const staged = await issuesFor(async (root) => { await rm(join(root, 'hosts/codex', legal)); });
      expect(staged).toContain(`hosts/codex/${legal}: staged bundle is missing its third-party attribution`);

      const payload = await issuesFor(async (root) => { await rm(join(root, 'marketplaces/claude-code/plugins/taskshuttle', legal)); });
      expect(payload).toContain(`marketplaces/claude-code/plugins/taskshuttle/${legal}: marketplace payload is missing its third-party attribution`);
    }
  });

  it('ART-016: a staged copy that differs from the root is caught', async () => {
    // Byte-identical, not merely present: a stale copy is how a bundle ships
    // attribution for code it no longer contains.
    const issues = await issuesFor(async (root) => {
      await writeFile(join(root, 'hosts/kimi/NOTICE'), 'not the root NOTICE\n');
    });
    expect(issues).toContain('hosts/kimi/NOTICE: third-party attribution differs from the repository root');
  });

  it('ART-016: LICENSE without its third-party section is caught', async () => {
    // The section is what points a reader at NOTICE. Without it the generated
    // file ships and nothing tells anyone it is there.
    const issues = await issuesFor(async (root) => {
      await writeFile(join(root, 'LICENSE'), 'MIT, and nothing about what is bundled\n');
    });
    expect(issues).toContain('LICENSE: third-party section is missing; it is what points a reader at NOTICE');
  });

  it('ART-015: bundle purity recognises the renamed dependency, in every runtime entry', async () => {
    // At R3 `runskein` is not a dependency yet, so the real tree cannot produce
    // this import and a synthetic one is the only honest form (ADR 0041,
    // change-list step 11). The legacy name stays in the alternation until the
    // bump removes the dependency that uses it — this repository imports
    // `runskein` today; keeping the legacy name means a bundle that somehow
    // still carries it is caught rather than passing unrecognised.
    for (const entry of ['dist/cli.js', 'dist/launch.js', 'dist/nanny.js']) {
      const issues = await issuesFor(async (root) => {
        const path = join(root, 'packages/plugin', entry);
        await writeFile(path, `import { hub } from "runskein";\n` + await readFile(path, 'utf8'));
      });
      expect(issues).toContain(`packages/plugin/${entry}: production bundle contains an unbundled workspace/runtime import`);
    }
  });

  it('ART-015: the purity scan covers all three runtime entries, not only the first', async () => {
    // The scan read `dist/cli.js` alone. Step 9's row and step 11's could not
    // both stand as written — one claims every entry is checked, the other
    // checked one — and this case is which way that was settled.
    const issues = await issuesFor(async (root) => {
      const path = join(root, 'packages/plugin/dist/launch.js');
      await writeFile(path, `import { z } from "zod";\n` + await readFile(path, 'utf8'));
    });
    expect(issues).toContain('packages/plugin/dist/launch.js: production bundle contains an unbundled workspace/runtime import');
  });

  it('ART-014: rejects a path-loaded relative createRequire in any runtime entry', async () => {
    // The shape that reached a released artifact upstream: a bundled module
    // calling `createRequire(import.meta.url)('../../package.json')` resolves
    // beside the *source* file, so the bundle throws MODULE_NOT_FOUND at load.
    // Nothing looked for it, which is why it shipped (ADR 0041).
    for (const entry of ['dist/cli.js', 'dist/launch.js', 'dist/nanny.js']) {
      const issues = await issuesFor(async (root) => {
        const path = join(root, 'packages/plugin', entry);
        await writeFile(path, `const v = createRequire(import.meta.url)('../../package.json');\n` + await readFile(path, 'utf8'));
      });
      expect(issues).toContain(`packages/plugin/${entry}: bundle loads a relative path at runtime through createRequire`);
    }
  });

  it('ART-014: leaves the legitimate builtin createRequire alone', async () => {
    // `plugin-transcript-store.ts` calls `createRequire(import.meta.url)` and
    // hands it `'node:sqlite'`, because a static import of that builtin breaks
    // bundlers older than Node 22.5. The predicate is the *argument*, not the
    // call — a check on the call would fail the shipped bundle today, which is
    // the check that cannot exist rather than the one that must.
    await expect(issuesBesidesExpiredDefects(process.cwd())).resolves.toEqual([]);
    const issues = await issuesFor(async (root) => {
      const path = join(root, 'packages/plugin/dist/cli.js');
      await writeFile(path, `const db = createRequire(import.meta.url)('node:sqlite');\n` + await readFile(path, 'utf8'));
    });
    expect(issues).not.toContain('packages/plugin/dist/cli.js: bundle loads a relative path at runtime through createRequire');
  });

  it('HOST-COMMON-003: rejects a host artifact whose Stop hook registration is missing', async () => {
    // The whole reason this is asserted rather than inferred: a hook that is
    // not registered does not fail, it never runs — and ADR 0015 §4 makes "the
    // nanny said nothing" the ordinary, correct outcome.
    const issues = await issuesFor(async (root) => {
      await rm(join(root, 'hosts/claude-code/hooks'), { recursive: true });
    });
    expect(issues).toContain('hosts/claude-code/hooks/hooks.json: host artifact is missing its Stop hook registration');
  });

  it('HOST-COMMON-003: rejects the snake_case event name codex also defines but never fires', async () => {
    const issues = await issuesFor(async (root) => {
      const path = join(root, 'hosts/codex/hooks/hooks.json');
      const file = JSON.parse(await readFile(path, 'utf8')) as { hooks: Record<string, unknown> };
      // codex carries a second enumeration — pre_tool_use … subagent_stop —
      // with no stop entry. A registration copied from it parses cleanly.
      file.hooks = { stop: file.hooks['Stop'] };
      await writeFile(path, JSON.stringify(file));
    });
    expect(issues).toContain('hosts/codex/hooks/hooks.json: Stop hook registration must use the PascalCase event name; found stop');
  });

  it('HOST-COMMON-003: rejects a Stop hook pointing somewhere other than the shipped entry', async () => {
    const issues = await issuesFor(async (root) => {
      const path = join(root, 'hosts/claude-code/hooks/hooks.json');
      const file = JSON.parse(await readFile(path, 'utf8')) as ClaudeHooks;
      file.hooks.Stop[0]!.hooks[0]!.args = ['${CLAUDE_PLUGIN_ROOT}/dist/not-the-hook.js'];
      await writeFile(path, JSON.stringify(file));
    });
    expect(issues).toContain('hosts/claude-code/hooks/hooks.json: Stop hook must invoke dist/nanny.js');
  });

  it('HOST-COMMON-003: rejects a Kimi manifest with no Stop hook entry', async () => {
    const issues = await issuesFor(async (root) => {
      const path = join(root, 'hosts/kimi/kimi.plugin.json');
      const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      delete manifest['hooks'];
      await writeFile(path, JSON.stringify(manifest));
    });
    expect(issues).toContain('hosts/kimi/kimi.plugin.json: Kimi artifact must register its Stop hook in the plugin manifest');
  });

  it("HOST-COMMON-003: rejects a Kimi entry the host's strict schema would throw away", async () => {
    const issues = await issuesFor(async (root) => {
      const path = join(root, 'hosts/kimi/kimi.plugin.json');
      const manifest = JSON.parse(await readFile(path, 'utf8')) as { hooks: Record<string, unknown>[] };
      // 900 is what the reference implementation uses on Claude; kimi's ceiling
      // is 600, and `.strict()` means one unknown key voids the entry.
      manifest.hooks[0]!['timeout'] = 900;
      manifest.hooks[0]!['type'] = 'command';
      await writeFile(path, JSON.stringify(manifest));
    });
    expect(issues).toContain('hosts/kimi/kimi.plugin.json: Kimi hook timeout must be an integer in 1..600');
    expect(issues).toContain('hosts/kimi/kimi.plugin.json: Kimi hook schema is strict; unknown key type');
  });

  it('HOST-COMMON-003: rejects a host bundle shipped without the hook script', async () => {
    const issues = await issuesFor(async (root) => {
      await rm(join(root, 'hosts/kimi/dist/nanny.js'));
    });
    expect(issues).toContain('hosts/kimi/dist/nanny.js: staged runtime entry is missing');
  });

  it('HOST-COMMON-003: rejects a published marketplace payload without the hook', async () => {
    const issues = await issuesFor(async (root) => {
      await rm(join(root, 'marketplaces/claude-code/plugins/taskshuttle/hooks'), { recursive: true });
    });
    expect(issues).toContain('marketplaces/claude-code/plugins/taskshuttle/hooks/hooks.json: marketplace plugin payload is incomplete');
  });

  it('rejects a staged bundle that drifted from the current build', async () => {
    const issues = await issuesFor(async (root) => {
      await writeFile(join(root, 'hosts/codex/dist/cli.js'), '// stale build\n');
    });
    expect(issues).toContain('hosts/codex/dist/cli.js: staged runtime entry differs from the current Plugin package build');
  });

  it('rejects a stale file left over from an earlier build', async () => {
    const issues = await issuesFor(async (root) => {
      await writeFile(join(root, 'hosts/kimi/dist/chunk-OLDBUILD.js'), 'export {}\n');
    });
    expect(issues).toContain('hosts/kimi/dist/chunk-OLDBUILD.js: stale bundle file from an earlier build');
  });

  it('rejects a host skill that diverged from the shared source skill', async () => {
    const issues = await issuesFor(async (root) => {
      await writeFile(join(root, 'hosts/claude-code/skills/delegate-workers/SKILL.md'), '# drifted\n');
    });
    expect(issues).toContain('hosts/claude-code/skills/delegate-workers/SKILL.md: host skill differs from the shared source skill');
  });

  it('rejects a missing host skill', async () => {
    const issues = await issuesFor(async (root) => {
      await rm(join(root, 'hosts/kimi/skills'), { recursive: true });
    });
    expect(issues).toContain('hosts/kimi/skills/delegate-workers/SKILL.md: host artifact is missing the shared orchestration skill');
  });

  it('rejects a manifest version that drifted from the package version', async () => {
    const issues = await issuesFor(async (root) => {
      const path = join(root, 'hosts/kimi/kimi.plugin.json');
      const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      await writeFile(path, JSON.stringify({ ...manifest, version: '9.9.9' }));
    });
    expect(issues.some((issue) => issue.includes('manifest version must match the package version'))).toBe(true);
  });

  it('rejects a marketplace whose plugin source escapes the marketplace directory', async () => {
    const issues = await issuesFor(async (root) => {
      const path = join(root, 'marketplaces/claude-code/.claude-plugin/marketplace.json');
      const marketplace = JSON.parse(await readFile(path, 'utf8')) as { plugins: Array<Record<string, unknown>> };
      marketplace.plugins[0]!['source'] = '../../hosts/claude-code';
      await writeFile(path, JSON.stringify(marketplace));
    });
    expect(issues.some((issue) => issue.includes('escapes the marketplace directory'))).toBe(true);
  });

  it('rejects a marketplace whose staged plugin payload is incomplete', async () => {
    const issues = await issuesFor(async (root) => {
      await rm(join(root, 'marketplaces/codex/plugins/taskshuttle/dist/launch.js'));
    });
    expect(issues).toContain('marketplaces/codex/plugins/taskshuttle/dist/launch.js: marketplace plugin payload is incomplete');
  });

  it('rejects an MCP config that points at a bundled entry the package does not ship', async () => {
    const issues = await issuesFor(async (root) => {
      await writeFile(join(root, 'hosts/claude-code/.mcp.json'), JSON.stringify({ mcpServers: { 'realm-plugin': { command: 'node', args: ['dist/missing.js'] } } }));
    });
    expect(issues).toContain('hosts/claude-code/.mcp.json: MCP config references a missing bundled entry: dist/missing.js');
  });

  it('rejects an MCP config carrying raw url/env/header transport details', async () => {
    const issues = await issuesFor(async (root) => {
      await writeFile(join(root, 'hosts/codex/.mcp.json'), JSON.stringify({ mcpServers: { 'realm-plugin': { command: 'taskshuttle-plugin-launch', args: [], env: { TOKEN: 'x' } } } }));
    });
    expect(issues).toContain('hosts/codex/.mcp.json: MCP config must use command/args stdio entries only');
  });

  it('rejects release provenance that disagrees with the pinned wrapper versions', async () => {
    const issues = await issuesFor(async (root) => {
      await withSeededDefects(root, (metadata) => {
        metadata.wrappers['codex-acp'] = '9.9.9';
      });
    });
    expect(issues).toContain('release/metadata.json: wrapper codex-acp must record the pinned version 1.3.0');
  });

  it('rejects a known defect whose component version no longer matches the baseline', async () => {
    const issues = await issuesFor(async (root) => {
      await withSeededDefects(root, (metadata) => {
        metadata.verification.knownDefects.entries[0]!['componentVersion'] = '0.15.0';
      });
    });
    expect(issues).toContain('release/metadata.json: known defect ENG-FORK-001-claude-code was observed at claude-agent-acp 0.15.0 but the baseline now records 0.70.0; re-run the case and update or retire the entry');
    // Realm did not move, so only the component dimension may be reported.
    expect(issues.filter((issue) => issue.includes('ENG-FORK-001-claude-code'))).toHaveLength(1);
  });

  it('rejects a known defect that does not cite its evidence', async () => {
    const issues = await issuesFor(async (root) => {
      await withSeededDefects(root, (metadata) => {
        delete metadata.verification.knownDefects.entries[0]!['evidence'];
      });
    });
    expect(issues).toContain('release/metadata.json: known defect ENG-FORK-001-claude-code must record id, engine, capability, component, componentVersion, realmVersion, evidence; missing or empty: evidence');
  });

  // ADR 0026 / ART-013. The component sitting still across a Realm bump is
  // the case the second dimension exists for: without it these entries stay
  // green while nobody has re-run them.
  it('rejects a known defect last observed under an older Realm', async () => {
    const issues = await issuesFor(async (root) => {
      await withSeededDefects(root, (metadata) => {
        metadata.verification.knownDefects.entries[0]!['realmVersion'] = '0.1.0-alpha.13';
      });
    });
    expect(issues).toContain('release/metadata.json: known defect ENG-FORK-001-claude-code was last observed under runskein 0.1.0-alpha.13 but this release records ' + RELEASE_REALM_VERSION + '; re-run the case and update or retire the entry');
    // Exactly one message: the component did not move, so blaming it too
    // would send the reader to re-pin a wrapper that is already correct.
    expect(issues.filter((issue) => issue.includes('ENG-FORK-001-claude-code was observed at'))).toEqual([]);
  });

  // The baseline is wrappers *and* engines, and `pi` is the entry that
  // proves it: its component is an engine binary, so a gate built from the
  // wrapper baseline alone would never expire this record on the component
  // dimension — it would still expire on a Realm bump — while every
  // claude-code case above stayed green.
  it('rejects a known defect whose engine-supplied component version has moved', async () => {
    const issues = await issuesFor(async (root) => {
      await withSeededDefects(root, (metadata) => {
        metadata.engines['pi'] = '0.85.0';
      });
    });
    expect(issues).toContain('release/metadata.json: known defect ENG-FORK-001-pi was observed at pi 0.84.2 but the baseline now records 0.85.0; re-run the case and update or retire the entry');
  });

  // A Realm bump expires every entry at once. Reporting only the first
  // would understate the work and is invisible in any single-entry case.
  it('names every entry when the release Realm version moves', async () => {
    const issues = await issuesFor(async (root) => {
      await withSeededDefects(root, (metadata) => {
        // Distinct versions per entry: with both set to the same value, a gate
        // reporting the first entry's version for every message would pass.
        metadata.verification.knownDefects.entries[0]!['realmVersion'] = '0.1.0-alpha.13';
        metadata.verification.knownDefects.entries[1]!['realmVersion'] = '0.1.0-alpha.16';
      });
    });
    const expired = issues.filter((issue) => issue.includes('was last observed under runskein'));
    expect(expired).toHaveLength(2);
    // Each message must carry its own entry's id and its own recorded
    // version — arity alone would accept two copies of the first record.
    expect(issues).toContain('release/metadata.json: known defect ENG-FORK-001-claude-code was last observed under runskein 0.1.0-alpha.13 but this release records ' + RELEASE_REALM_VERSION + '; re-run the case and update or retire the entry');
    expect(issues).toContain('release/metadata.json: known defect ENG-FORK-001-pi was last observed under runskein 0.1.0-alpha.16 but this release records ' + RELEASE_REALM_VERSION + '; re-run the case and update or retire the entry');
  });

  // One entry stale on each dimension. Reusing the first entry's dimensions
  // for both would keep the message count at two and point the reader at
  // the wrong re-run for one of them.
  it('reports each entry on the dimension that actually expired', async () => {
    const issues = await issuesFor(async (root) => {
      await withSeededDefects(root, (metadata) => {
        metadata.verification.knownDefects.entries[0]!['componentVersion'] = '0.15.0';
        metadata.verification.knownDefects.entries[1]!['realmVersion'] = '0.1.0-alpha.16';
      });
    });
    expect(issues).toContain('release/metadata.json: known defect ENG-FORK-001-claude-code was observed at claude-agent-acp 0.15.0 but the baseline now records 0.70.0; re-run the case and update or retire the entry');
    expect(issues).toContain('release/metadata.json: known defect ENG-FORK-001-pi was last observed under runskein 0.1.0-alpha.16 but this release records ' + RELEASE_REALM_VERSION + '; re-run the case and update or retire the entry');
    // Exactly one message each, on the dimension that moved.
    expect(issues.filter((issue) => issue.includes('ENG-FORK-001-claude-code'))).toHaveLength(1);
    expect(issues.filter((issue) => issue.includes('ENG-FORK-001-pi'))).toHaveLength(1);
  });

  // Every other case here moves an entry's version and leaves the release
  // where it is, so a gate that hardcoded the current Realm version would
  // pass them all — and a real Realm bump, the one thing this dimension
  // exists to notice, would be invisible. This case moves the release.
  it('expires every entry when the release Realm version itself moves', async () => {
    // The release moves and the entries stay put — the mirror image of the
    // case above, and the reason the version moved to is deliberately not one
    // any entry records: a gate comparing the wrong pair would still find them
    // equal if it happened to pick the entry's own value.
    const moved = '0.1.0-alpha.999';
    const issues = await issuesFor(async (root) => {
      await withSeededDefects(root, (metadata) => {
        metadata.realmVersion = moved;
      });
    });
    for (const id of ['ENG-FORK-001-claude-code', 'ENG-FORK-001-pi']) {
      expect(issues).toContain(`release/metadata.json: known defect ${id} was last observed under runskein ${RELEASE_REALM_VERSION} but this release records ${moved}; re-run the case and update or retire the entry`);
    }
  });

  // The two failures call for different work, so they may not share a
  // message: an undated entry needs a run, a stale one needs a re-run.
  it('reports an undated known defect as a shape problem, not as a stale one', async () => {
    const issues = await issuesFor(async (root) => {
      await withSeededDefects(root, (metadata) => {
        delete metadata.verification.knownDefects.entries[0]!['realmVersion'];
      });
    });
    expect(issues).toContain('release/metadata.json: known defect ENG-FORK-001-claude-code must record id, engine, capability, component, componentVersion, realmVersion, evidence; missing or empty: realmVersion');
    expect(issues.filter((issue) => issue.includes('was last observed under runskein'))).toEqual([]);
  });

  // Both dimensions moved: naming only one sends the reader to re-run the
  // wrong thing, so the gate emits both.
  it('names both dimensions when both have expired', async () => {
    const issues = await issuesFor(async (root) => {
      await withSeededDefects(root, (metadata) => {
        metadata.verification.knownDefects.entries[0]!['componentVersion'] = '0.15.0';
        metadata.verification.knownDefects.entries[0]!['realmVersion'] = '0.1.0-alpha.13';
      });
    });
    expect(issues).toContain('release/metadata.json: known defect ENG-FORK-001-claude-code was observed at claude-agent-acp 0.15.0 but the baseline now records 0.70.0; re-run the case and update or retire the entry');
    expect(issues).toContain('release/metadata.json: known defect ENG-FORK-001-claude-code was last observed under runskein 0.1.0-alpha.13 but this release records ' + RELEASE_REALM_VERSION + '; re-run the case and update or retire the entry');
    expect(issues.filter((issue) => issue.includes('ENG-FORK-001-claude-code'))).toHaveLength(2);
  });

  it('accepts a host-root placeholder in an MCP script argument', async () => {
    const issues = await issuesFor(async (root) => {
      await writeFile(join(root, 'hosts/kimi/.mcp.json'), JSON.stringify({ mcpServers: { 'realm-plugin': { command: 'node', args: ['${KIMI_PLUGIN_ROOT}/dist/launch.js'] } } }));
    });
    expect(issues.filter((issue) => issue.includes('hosts/kimi/.mcp.json'))).toEqual([]);
  });

  it('rejects a kimi manifest that claims project scope', async () => {
    const issues = await issuesFor(async (root) => {
      const path = join(root, 'hosts/kimi/kimi.plugin.json');
      const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      await writeFile(path, JSON.stringify({ ...manifest, scope: 'project' }));
    });
    expect(issues).toContain('hosts/kimi/kimi.plugin.json: managed host artifact must declare user scope only');
  });
});
