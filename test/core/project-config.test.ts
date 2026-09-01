// SES-020 / SES-021 / SES-023 / SES-024 / SES-025: the project default-config
// file — parsing, validation, project-key derivation, profile selection, the
// per-engine engineConfig tier and the three-tier merge. The field semantics
// are owned by the default-config design record; these tests pin them.
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  loadProjectConfig,
  mergeProfileDefaults,
  projectKeyFor,
  ProjectConfigError,
  resolveProfileDefaults,
  validateProjectConfig,
  type ProjectConfig,
  type WorkerProfile,
} from '../../packages/plugin/src/project-config.js';

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

const VALID = {
  defaultProfile: 'implementing',
  profiles: {
    implementing: { purpose: '实现已定的任务', config: { model: 'm-impl', reasoning: 'high' } },
    reviewing: { config: { model: 'm-rev' } },
  },
};

/** Place a config file for the given host cwd under the data root, 0600. */
async function placeConfig(dataRoot: string, hostCwd: string, content: unknown): Promise<string> {
  const dir = join(dataRoot, projectKeyFor(hostCwd));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'config.json');
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content), { mode: 0o600 });
  return path;
}

describe('projectKeyFor', () => {
  it('encodes the resolved path, one leading dash per absolute root', async () => {
    const dir = await tempDir('taskshuttle-pk-');
    const key = projectKeyFor(dir);
    const resolved = await realpath(dir);
    // Components never contribute a bare '-', so the joiner is unambiguous and
    // the key always starts with one — which is also what keeps it clear of the
    // data root's own entries ('instances', 'config.json'), none of which do.
    expect(key.startsWith('-')).toBe(true);
    expect(key).not.toBe('instances');
    expect(key).not.toBe('config.json');
    expect(key.length).toBeGreaterThan(resolved.length - 1);
  });

  it('is injective across dash-bearing components (the /a-/b vs /a/-b trap)', async () => {
    const base = await tempDir('taskshuttle-pk-inj-');
    await mkdir(join(base, 'a-', 'b'), { recursive: true });
    await mkdir(join(base, 'a', '-b'), { recursive: true });
    expect(projectKeyFor(join(base, 'a-', 'b'))).not.toBe(projectKeyFor(join(base, 'a', '-b')));
    // And the plain collision that motivated escaping at all.
    await mkdir(join(base, 'x-y'), { recursive: true });
    await mkdir(join(base, 'x', 'y'), { recursive: true });
    expect(projectKeyFor(join(base, 'x-y'))).not.toBe(projectKeyFor(join(base, 'x', 'y')));
  });

  it('maps a symlink entry to the same key as the real path', async () => {
    const real = await tempDir('taskshuttle-pk-real-');
    const link = join(await tempDir('taskshuttle-pk-link-'), 'entry');
    await symlink(real, link);
    expect(projectKeyFor(link)).toBe(projectKeyFor(real));
  });
});

describe('loadProjectConfig', () => {
  it('returns undefined when no file exists — absence is the normal state', async () => {
    const dataRoot = await tempDir('taskshuttle-pc-root-');
    const host = await tempDir('taskshuttle-pc-host-');
    expect(loadProjectConfig(dataRoot, projectKeyFor(host))).toBeUndefined();
  });

  it('parses a valid file', async () => {
    const dataRoot = await tempDir('taskshuttle-pc-root-');
    const host = await tempDir('taskshuttle-pc-host-');
    await placeConfig(dataRoot, host, VALID);
    const parsed = loadProjectConfig(dataRoot, projectKeyFor(host));
    expect(parsed?.defaultProfile).toBe('implementing');
    expect(parsed?.profiles['implementing']?.config).toEqual({ model: 'm-impl', reasoning: 'high' });
    expect(parsed?.profiles['reviewing']?.purpose).toBeUndefined();
  });

  it('rejects invalid JSON, naming the file but never its contents', async () => {
    const dataRoot = await tempDir('taskshuttle-pc-root-');
    const host = await tempDir('taskshuttle-pc-host-');
    const secret = 'sk-do-not-leak-this';
    await placeConfig(dataRoot, host, `{ "profiles": "${secret}"`);
    try {
      loadProjectConfig(dataRoot, projectKeyFor(host));
      expect.unreachable();
    } catch (cause) {
      expect(cause).toBeInstanceOf(ProjectConfigError);
      expect((cause as ProjectConfigError).code).toBe('INVALID_ARGUMENT');
      expect((cause as Error).message).not.toContain(secret);
    }
  });

  it('rejects unknown fields, wrong types and a dangling defaultProfile', async () => {
    const cases: unknown[] = [
      { ...VALID, typo: true },
      { profiles: {} },
      { profiles: 'not-an-object' },
      { profiles: { a: { config: { model: 42 } } } },
      { profiles: { a: { purpose: 7, config: {} } } },
      { defaultProfile: 'ghost', profiles: { a: { config: {} } } },
      'a string is not a config',
    ];
    for (const [index, content] of cases.entries()) {
      const dataRoot = await tempDir(`taskshuttle-pc-bad${index}-root-`);
      const host = await tempDir(`taskshuttle-pc-bad${index}-host-`);
      await placeConfig(dataRoot, host, content);
      expect(() => loadProjectConfig(dataRoot, projectKeyFor(host)), `case ${index}: ${JSON.stringify(content)}`).toThrowError(ProjectConfigError);
    }
  });

  it('refuses a group/world-accessible file, same predicate as the install face', async () => {
    const dataRoot = await tempDir('taskshuttle-pc-root-');
    const host = await tempDir('taskshuttle-pc-host-');
    const path = await placeConfig(dataRoot, host, VALID);
    await chmod(path, 0o644);
    expect(() => loadProjectConfig(dataRoot, projectKeyFor(host))).toThrowError(ProjectConfigError);
  });

  it('treats an unrepresentable key (ENAMETOOLONG) as absence', async () => {
    const dataRoot = await tempDir('taskshuttle-pc-root-');
    // The key is a single encoded path component; past NAME_MAX no file can
    // exist under it, so "absent" is the correct reading — an error here would
    // reject every create for a project that never placed a file.
    expect(loadProjectConfig(dataRoot, `-${'x'.repeat(300)}`)).toBeUndefined();
  });

  it('refuses a bare path where the key goes — join() would walk it out of the data root', async () => {
    const dataRoot = await tempDir('taskshuttle-pc-root-');
    // Neutral absolute path, not a real home: this file is exported to the
    // public repository, where a maintainer's home directory is noise.
    for (const bad of ['/absolute/path/x', '..', 'plain-name']) {
      expect(() => loadProjectConfig(dataRoot, bad), bad).toThrowError(ProjectConfigError);
    }
  });

  it('keeps a profile named __proto__ instead of dropping it into the prototype', async () => {
    const dataRoot = await tempDir('taskshuttle-pc-root-');
    const host = await tempDir('taskshuttle-pc-host-');
    // Written as raw JSON on purpose: in a JS object literal a `__proto__` key
    // sets the prototype instead of declaring an own property, which would
    // make the test itself lie about what the file said.
    await placeConfig(dataRoot, host, '{ "profiles": { "__proto__": { "config": { "model": "m-proto" } } } }');
    const parsed = loadProjectConfig(dataRoot, projectKeyFor(host));
    expect(Object.keys(parsed?.profiles ?? {})).toEqual(['__proto__']);
    expect(resolveProfileDefaults(parsed, '__proto__')?.config).toEqual({ model: 'm-proto' });
  });
});

describe('resolveProfileDefaults', () => {
  const project: ProjectConfig = {
    defaultProfile: 'implementing',
    profiles: {
      implementing: { config: { model: 'm-impl', reasoning: 'high' } },
      reviewing: { config: { model: 'm-rev' } },
    },
  };

  it('no file and no profile means no fill', () => {
    expect(resolveProfileDefaults(undefined, undefined)).toBeUndefined();
  });

  it('an explicit profile with no file fails closed — never create silently without it', () => {
    expect(() => resolveProfileDefaults(undefined, 'implementing')).toThrowError(ProjectConfigError);
  });

  it('an explicit profile selects that profile', () => {
    expect(resolveProfileDefaults(project, 'reviewing')?.config).toEqual({ model: 'm-rev' });
  });

  it('an unknown profile fails with INVALID_ARGUMENT and names the field', () => {
    try {
      resolveProfileDefaults(project, 'ghost');
      expect.unreachable();
    } catch (cause) {
      expect(cause).toBeInstanceOf(ProjectConfigError);
      expect((cause as ProjectConfigError).field).toBe('profile');
      // Profile names are keys, not contents: listing them is allowed.
      expect((cause as Error).message).toContain('implementing');
    }
  });

  it('falls back to defaultProfile, and to nothing when neither exists', () => {
    expect(resolveProfileDefaults(project, undefined)?.config).toEqual({ model: 'm-impl', reasoning: 'high' });
    const noDefault: ProjectConfig = { profiles: { a: { config: {} } } };
    expect(resolveProfileDefaults(noDefault, undefined)).toBeUndefined();
  });

  it('prototype member names are not profiles — naming one fails closed', () => {
    // `project` here is a plain literal, so its profiles map still carries
    // Object.prototype: exactly the shape a bare-index lookup would leak
    // through. `__proto__` as a *query* reads the prototype on such a map.
    for (const name of ['__proto__', 'constructor', 'toString']) {
      expect(() => resolveProfileDefaults(project, name), name).toThrowError(ProjectConfigError);
    }
  });
});

describe('shipped template', () => {
  it('conf-template/default-config.json passes runtime validation unchanged', () => {
    // The template ships real per-engine example values (ADR 0019), so
    // installing it as-is must apply exactly those — and that only stays true
    // if it keeps passing the same validator the runtime applies to an
    // operator-edited file.
    const source = JSON.parse(readFileSync(join(process.cwd(), 'conf-template', 'default-config.json'), 'utf8')) as unknown;
    expect(() => validateProjectConfig(source)).not.toThrow();
  });

  it('carries no empty-valued key anywhere — an empty string is a real value the fill path would apply (ART-012)', () => {
    const source = JSON.parse(readFileSync(join(process.cwd(), 'conf-template', 'default-config.json'), 'utf8')) as {
      profiles: Record<string, { config: Record<string, unknown>; engineConfig?: Record<string, Record<string, unknown>> }>;
    };
    for (const profile of Object.values(source.profiles)) {
      for (const value of Object.values(profile.config)) expect(value).not.toBe('');
      for (const section of Object.values(profile.engineConfig ?? {})) {
        for (const value of Object.values(section)) expect(value).not.toBe('');
      }
    }
  });
});

describe('engineConfig tier (SES-024)', () => {
  const WITH_ENGINES = {
    profiles: {
      implementing: {
        config: { reasoning: 'medium' },
        engineConfig: {
          codex: { model: 'm-codex', reasoning: 'high' },
          pi: { model: 'm-pi' },
        },
      },
    },
  };

  it('parses per-engine sections and keeps the old format valid unchanged', () => {
    const parsed = validateProjectConfig(WITH_ENGINES);
    expect(parsed.profiles['implementing']?.engineConfig?.['codex']).toEqual({ model: 'm-codex', reasoning: 'high' });
    // A file without engineConfig is exactly as valid as before ADR 0019.
    const legacy = validateProjectConfig(VALID);
    expect(legacy.profiles['implementing']?.engineConfig).toBeUndefined();
  });

  it('declaring an engine that is not installed is legal pre-seeding, never an error', () => {
    // Validation never consults the registry, so "ghost" is just a name here.
    const parsed = validateProjectConfig({ profiles: { a: { config: {}, engineConfig: { ghost: { model: 'm' } } } } });
    expect(parsed.profiles['a']?.engineConfig?.['ghost']).toEqual({ model: 'm' });
  });

  it('rejects unknown profile fields, wrong types and out-of-bounds engine ids', () => {
    const cases: unknown[] = [
      { profiles: { a: { config: {}, engineConfig: 'not-an-object' } } },
      { profiles: { a: { config: {}, engineConfig: { codex: 'not-a-patch' } } } },
      { profiles: { a: { config: {}, engineConfig: { codex: { model: 42 } } } } },
      { profiles: { a: { config: {}, engineConfig: { codex: { '': 'x' } } } } },
      { profiles: { a: { config: {}, engineConfig: { [`e${'x'.repeat(128)}`]: { model: 'm' } } } } },
      { profiles: { a: { config: {}, engineConfig: { '': { model: 'm' } } } } },
      { profiles: { a: { config: {}, engineConfig: { codex: {} }, typo: true } } },
    ];
    for (const [index, content] of cases.entries()) {
      expect(() => validateProjectConfig(content), `case ${index}: ${JSON.stringify(content)}`).toThrowError(ProjectConfigError);
    }
  });

  it('keeps an engine section named __proto__ instead of dropping it into the prototype', async () => {
    const dataRoot = await tempDir('taskshuttle-pc-root-');
    const host = await tempDir('taskshuttle-pc-host-');
    // Raw JSON on purpose, same reason as the __proto__ profile-name case: in a
    // JS literal the key would set the prototype and the test would lie.
    await placeConfig(dataRoot, host, '{ "profiles": { "a": { "config": {}, "engineConfig": { "__proto__": { "model": "m-proto" } } } } }');
    const parsed = loadProjectConfig(dataRoot, projectKeyFor(host));
    const profile = parsed?.profiles['a'];
    expect(Object.keys(profile?.engineConfig ?? {})).toEqual(['__proto__']);
    // And the merge must find it through the own-property guard.
    expect(mergeProfileDefaults(profile!, '__proto__', undefined)).toEqual({ model: 'm-proto' });
  });
});

describe('three-tier merge (SES-025)', () => {
  const profile: WorkerProfile = {
    config: { model: 'm-all', reasoning: 'medium' },
    engineConfig: {
      codex: { model: 'm-codex' },
      pi: { model: 'm-pi', reasoning: 'low' },
    },
  };

  it('orders config < engineConfig[E] < explicit, per key', () => {
    // Same key in all three tiers: the engine section beats the flat tier, the
    // explicit value beats both.
    expect(mergeProfileDefaults(profile, 'codex', undefined)).toEqual({ model: 'm-codex', reasoning: 'medium' });
    expect(mergeProfileDefaults(profile, 'codex', { model: 'm-mine' })).toEqual({ model: 'm-mine', reasoning: 'medium' });
    expect(mergeProfileDefaults(profile, 'pi', { reasoning: 'high' })).toEqual({ model: 'm-pi', reasoning: 'high' });
  });

  it('an engine with no section gets the flat tier only; other sections are not consulted', () => {
    expect(mergeProfileDefaults(profile, 'kimi', undefined)).toEqual({ model: 'm-all', reasoning: 'medium' });
  });

  it('a section declared for another engine is not read into this one', () => {
    const other: WorkerProfile = { config: {}, engineConfig: { pi: { model: 'm-pi' } } };
    expect(mergeProfileDefaults(other, 'codex', undefined)).toEqual({});
  });

  it('prototype-member engine names are not sections', () => {
    // `profile` here is a plain literal whose engineConfig map still carries
    // Object.prototype — exactly the shape a bare-index lookup would leak
    // through; the hasOwn guard keeps `toString` from reading as a section.
    for (const engine of ['__proto__', 'constructor', 'toString']) {
      expect(mergeProfileDefaults(profile, engine, undefined), engine).toEqual({ model: 'm-all', reasoning: 'medium' });
    }
  });
});
