import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/**
 * Worker default profiles (ADR 0018): a project-scoped declaration source at
 * `<data-root>/<project-key>/config.json` that `session_create` consults to
 * fill `config` keys the caller did not give. This module owns the file's
 * location, encoding, validation, profile selection and the three-tier merge
 * (`config` < `engineConfig[E]` < explicit); the write side is `project_init`'s
 * (ADR 0019): generation from the live registry, merge-regeneration on
 * `refresh`, and the 0600/atomic-write discipline, all below.
 *
 * The trust and failure posture mirrors the install surface
 * (plugin-config.ts): the file lives under the plugin-owned data root, is read
 * open-no-follow, must not be group/world accessible, and every invalid value
 * fails with a field-level error rather than being ignored. Two deliberate
 * differences: the file is optional (absence is the normal state, not a
 * start-up failure), and it is read per `session_create` call rather than once
 * at boot, so edits take effect without a host restart.
 */

/** A field-level rejection of the project default-config file or of profile selection. */
export class ProjectConfigError extends Error {
  readonly code = 'INVALID_ARGUMENT';
  constructor(readonly field: string, message: string) {
    super(`invalid worker defaults field '${field}': ${message}`);
    this.name = 'ProjectConfigError';
  }
}

/** One named default tier: a human-facing purpose note plus the config keys to fill. */
export interface WorkerProfile {
  readonly purpose?: string;
  readonly config: Readonly<Record<string, string | boolean>>;
  /**
   * Per-engine tier (ADR 0019): engine id → the patch that applies only to
   * sessions on that engine. Engines not declared here are simply not consulted
   * for them — declaring an engine that is not installed is legal pre-seeding,
   * never an error, so the table is never checked against the registry.
   */
  readonly engineConfig?: Readonly<Record<string, Readonly<Record<string, string | boolean>>>>;
}

/** The parsed default-config file. */
export interface ProjectConfig {
  readonly defaultProfile?: string;
  readonly profiles: Readonly<Record<string, WorkerProfile>>;
}

/**
 * Encode a path component so the joiner `-` can never appear inside one:
 * escape `%` first (it is the escape character), then `-`. With the joiner
 * absent from every encoded component, splitting the key on `-` and
 * un-escaping is lossless, which is what makes the encoding injective —
 * `/a/b-c`, `/a/b/c`, `/a-/b` and `/a/-b` all produce distinct keys. Getting
 * this wrong sends one project's defaults to another, which is worse than no
 * defaults at all.
 */
function encodeComponent(component: string): string {
  return component.replaceAll('%', '%25').replaceAll('-', '%2D');
}

/**
 * Derive the project key from the host working directory: realpath-resolved,
 * so a symlink entry and the real path name the same profile set. The key
 * always starts with `-` (the leading empty component of an absolute POSIX
 * path), which keeps it clear of the data root's own entries — `instances/`
 * and `config.json` — without a reserved-word list.
 *
 * @throws Never on valid input; a host cwd that does not resolve throws
 *   whatever `realpathSync` throws, which surfaces as a start-up-level failure
 *   the same way the install surface's cwd check does.
 */
export function projectKeyFor(hostCwd: string): string {
  return realpathSync(hostCwd).split('/').map(encodeComponent).join('-');
}

const KNOWN_FIELDS = new Set(['defaultProfile', 'profiles']);
const KNOWN_PROFILE_FIELDS = new Set(['purpose', 'config', 'engineConfig']);

/** Profile names share the `name` bound in the tool contract: 1..128 Unicode code points. */
function profileNameOk(name: string): boolean {
  return name.length > 0 && Array.from(name).length <= 128;
}

/**
 * Engine ids in the file carry the same 1..128 code-point bound as profile
 * names — and deliberately nothing more. They are not matched against the
 * registry at validation time: a file may declare an engine that is not
 * currently installed, and coupling validation to the live registry would
 * hostage engines installed later to files written earlier.
 */
function engineIdOk(id: string): boolean {
  return profileNameOk(id);
}

/**
 * Validate one flat config patch — the shared shape rule for a profile's
 * `config` and for every `engineConfig` section. Keys pass through verbatim by
 * design: which keys an engine understands is the engine adapter's business
 * (the maintainer checks them against `worker_describe`), and inventing a
 * plugin-side mapping is expressly out of scope.
 *
 * @throws {ProjectConfigError} naming the field, never a value.
 */
function validatePatch(field: string, value: unknown): Record<string, string | boolean> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ProjectConfigError(field, 'must be an object of string|boolean values');
  for (const [key, configValue] of Object.entries(value as Record<string, unknown>)) {
    if (key.length === 0) throw new ProjectConfigError(field, 'config keys must be non-empty strings');
    if (typeof configValue !== 'string' && typeof configValue !== 'boolean') throw new ProjectConfigError(field, 'config values must be strings or booleans');
  }
  return { ...(value as Record<string, string | boolean>) };
}

/**
 * Validate a parsed JSON value into a ProjectConfig; unknown fields and wrong
 * types are rejected. Exported so the artifact gate can validate the shipped
 * `default-config.json` template with the same rules the runtime enforces.
 *
 * @throws {ProjectConfigError} with a field-level message naming the rejected
 *   field, never the file contents.
 */
export function validateProjectConfig(input: unknown): ProjectConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new ProjectConfigError('<root>', 'must be an object');
  const source = input as Record<string, unknown>;
  for (const field of Object.keys(source)) {
    if (!KNOWN_FIELDS.has(field)) throw new ProjectConfigError(field, 'is not a known configuration field');
  }
  const profilesValue = source['profiles'];
  if (typeof profilesValue !== 'object' || profilesValue === null || Array.isArray(profilesValue)) throw new ProjectConfigError('profiles', 'must be an object keyed by profile name');
  const entries = Object.entries(profilesValue as Record<string, unknown>);
  if (entries.length === 0) throw new ProjectConfigError('profiles', 'must declare at least one profile');
  // Null-prototype map: a profile named `__proto__` assigned into a `{}`
  // literal would hit the prototype setter and vanish without an error, and a
  // bare-index lookup would then read inherited members — both are silent
  // drops of a declared tier, which this module exists to forbid.
  const profiles: Record<string, WorkerProfile> = Object.create(null) as Record<string, WorkerProfile>;
  for (const [name, value] of entries) {
    if (!profileNameOk(name)) throw new ProjectConfigError('profiles', 'profile names must be 1..128 Unicode code points');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ProjectConfigError(`profiles.${name}`, 'must be an object');
    const profile = value as Record<string, unknown>;
    for (const field of Object.keys(profile)) {
      if (!KNOWN_PROFILE_FIELDS.has(field)) throw new ProjectConfigError(`profiles.${name}.${field}`, 'is not a known profile field');
    }
    const purpose = profile['purpose'];
    if (purpose !== undefined && typeof purpose !== 'string') throw new ProjectConfigError(`profiles.${name}.purpose`, 'must be a string');
    const config = validatePatch(`profiles.${name}.config`, profile['config']);
    const engineConfigValue = profile['engineConfig'];
    let engineConfig: Record<string, Readonly<Record<string, string | boolean>>> | undefined;
    if (engineConfigValue !== undefined) {
      if (typeof engineConfigValue !== 'object' || engineConfigValue === null || Array.isArray(engineConfigValue)) throw new ProjectConfigError(`profiles.${name}.engineConfig`, 'must be an object keyed by engine id');
      // Same null-prototype discipline as the profiles table: an engine id of
      // `__proto__` assigned into a `{}` literal would hit the prototype setter
      // and vanish, and a bare-index lookup at merge time would read inherited
      // members as declared sections — both are silent drops this module
      // exists to forbid.
      const sections: Record<string, Readonly<Record<string, string | boolean>>> = Object.create(null) as Record<string, Readonly<Record<string, string | boolean>>>;
      for (const [engine, section] of Object.entries(engineConfigValue as Record<string, unknown>)) {
        if (!engineIdOk(engine)) throw new ProjectConfigError(`profiles.${name}.engineConfig`, 'engine ids must be 1..128 Unicode code points');
        sections[engine] = Object.freeze(validatePatch(`profiles.${name}.engineConfig.${engine}`, section));
      }
      engineConfig = Object.freeze(sections);
    }
    profiles[name] = Object.freeze({
      ...(purpose === undefined ? {} : { purpose }),
      config: Object.freeze(config),
      ...(engineConfig === undefined ? {} : { engineConfig }),
    });
  }
  const defaultProfile = source['defaultProfile'];
  if (defaultProfile !== undefined) {
    if (typeof defaultProfile !== 'string' || !profileNameOk(defaultProfile)) throw new ProjectConfigError('defaultProfile', 'must be a profile name');
    if (!Object.hasOwn(profiles, defaultProfile)) throw new ProjectConfigError('defaultProfile', `names no declared profile; available: ${Object.keys(profiles).join(', ')}`);
  }
  return Object.freeze({
    ...(defaultProfile === undefined ? {} : { defaultProfile }),
    profiles: Object.freeze(profiles),
  });
}

/**
 * Read the project's default-config file, or return `undefined` when it does
 * not exist — absence is the normal state and must not change behaviour.
 *
 * The caller derives `projectKey` once via `projectKeyFor` (the runtime does it
 * in its constructor: the host cwd is fixed for the process, and deriving per
 * call would turn a deleted host cwd into a per-create failure misclassified
 * as an engine error).
 *
 * Read open-no-follow and validated through the handle, never check-then-read
 * (the TOCTOU pattern the install surface already follows). The file must be a
 * regular file and not group/world accessible; anything else is a hard error,
 * because a file that is present but unreadable-as-declared must be loud, not
 * silently treated as absent. `ENAMETOOLONG` reads as absence: the key is a
 * single encoded path component, so a name the filesystem cannot represent is
 * a file that cannot exist, not a file that failed.
 *
 * @returns the parsed config, or `undefined` when no file exists or none can.
 * @throws {ProjectConfigError} on unreadable, non-private, malformed or
 *   semantically invalid files; messages name fields, never file contents.
 */
export function loadProjectConfig(dataRoot: string, projectKey: string): ProjectConfig | undefined {
  // Both parameters are bare strings, so the type system cannot stop a caller
  // from passing a path where the key goes — and join() would happily walk
  // that path out of the data root. Pin the encoding contract instead: every
  // key projectKeyFor produces starts with '-' (the leading empty component
  // of an absolute path) and contains no '/'; '/' and '..' both fail this.
  if (!projectKey.startsWith('-') || projectKey.includes('/')) {
    throw new ProjectConfigError('<key>', 'must be a projectKeyFor-encoded key, not a path');
  }
  const path = join(dataRoot, projectKey, 'config.json');
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENAMETOOLONG') return undefined;
    throw new ProjectConfigError('<file>', 'could not be opened as a private regular file');
  }
  try {
    const info: Stats = fstatSync(descriptor);
    if (!info.isFile()) throw new ProjectConfigError('<file>', 'must be a regular file');
    if ((info.mode & 0o077) !== 0) throw new ProjectConfigError('<file>', 'must not be group/world accessible');
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(descriptor, 'utf8')) as unknown; }
    catch { throw new ProjectConfigError('<file>', 'is not valid JSON'); }
    return validateProjectConfig(parsed);
  } finally { closeSync(descriptor); }
}

/**
 * Select the profile to fill from: the caller's explicit `profile`, else the
 * file's `defaultProfile`, else nothing.
 *
 * @returns the selected profile, or `undefined` when neither source names one.
 * @throws {ProjectConfigError} when a profile is named — by the caller or by
 *   `defaultProfile` — but no file exists or no such profile is declared.
 *   Fail-closed is the only reading compatible with the no-silent-ignore rule:
 *   the caller asked for a specific tier, and proceeding without it would
 *   discard that input.
 */
/** Allowlist for the repo layer (ADR 0039): only these config keys may appear in taskshuttle.config.json. */
export const REPO_ALLOWLIST: ReadonlySet<string> = new Set(['model', 'reasoning', 'reasoning_effort', 'effort', 'thinking']);

/**
 * Validate that every key in every profile's config and engineConfig is in the repo allowlist (ADR 0039).
 * Only for the repo layer — project layer is unrestricted.
 * @throws {ProjectConfigError} naming the offending key.
 */
export function validateRepoAllowlist(config: ProjectConfig): void {
  for (const [name, profile] of Object.entries(config.profiles)) {
    for (const key of Object.keys(profile.config)) {
      if (!REPO_ALLOWLIST.has(key)) throw new ProjectConfigError(`profiles.${name}.config.${key}`, 'is not in the repo allowlist');
    }
    if (profile.engineConfig !== undefined) {
      for (const [engine, section] of Object.entries(profile.engineConfig)) {
        for (const key of Object.keys(section)) {
          if (!REPO_ALLOWLIST.has(key)) throw new ProjectConfigError(`profiles.${name}.engineConfig.${engine}.${key}`, 'is not in the repo allowlist');
        }
      }
    }
  }
}

/**
 * Read the repo-layer defaults file at `<hostCwd>/taskshuttle.config.json` (ADR 0039).
 * Path is joined with hostCwd exactly (no resolution). O_NOFOLLOW | O_RDONLY, fstat checks regular file only.
 * ENOENT/ENAMETOOLONG → undefined. Other open errors → ProjectConfigError. Validates via validateProjectConfig then validateRepoAllowlist.
 */
export function loadRepoConfig(hostCwd: string): ProjectConfig | undefined {
  const path = join(hostCwd, 'taskshuttle.config.json');
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENAMETOOLONG') return undefined;
    throw new ProjectConfigError('<file>', 'could not be opened as a private regular file');
  }
  try {
    const info: Stats = fstatSync(descriptor);
    if (!info.isFile()) throw new ProjectConfigError('<file>', 'must be a regular file');
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(descriptor, 'utf8')) as unknown; }
    catch { throw new ProjectConfigError('<file>', 'is not valid JSON'); }
    const config = validateProjectConfig(parsed);
    validateRepoAllowlist(config);
    return config;
  } finally { closeSync(descriptor); }
}

/**
 * Compose repo and project layers per ADR 0039 Decision §2: wholesale shadowing.
 * Explicit profile → P first then R; defaultProfile → P wins else R. Dangling
 * defaultProfile cannot reach here — validateProjectConfig rejects it at load time.
 * Uses null-prototype/hasOwn discipline.
 */
export function resolveRepoProfile(
  repo: ProjectConfig | undefined,
  project: ProjectConfig | undefined,
  profileName: string | undefined,
): { profile: WorkerProfile | undefined; source: 'repo' | 'project' | undefined } {
  if (profileName !== undefined) {
    if (project !== undefined && Object.hasOwn(project.profiles, profileName)) return { profile: project.profiles[profileName], source: 'project' };
    if (repo !== undefined && Object.hasOwn(repo.profiles, profileName)) return { profile: repo.profiles[profileName], source: 'repo' };
    if (repo === undefined && project === undefined) throw new ProjectConfigError('profile', 'no worker defaults file exists for this project');
    const available: string[] = [];
    if (project !== undefined) available.push(...Object.keys(project.profiles));
    if (repo !== undefined) available.push(...Object.keys(repo.profiles));
    throw new ProjectConfigError('profile', `unknown profile; available: ${available.join(', ')}`);
  }
  // No explicit profile: defaultProfile resolution — P wins else R. Dangling is
  // impossible: load*Config validates defaultProfile at load time.
  if (project !== undefined && project.defaultProfile !== undefined) {
    return { profile: project.profiles[project.defaultProfile], source: 'project' };
  }
  if (repo !== undefined && repo.defaultProfile !== undefined) {
    return { profile: repo.profiles[repo.defaultProfile], source: 'repo' };
  }
  return { profile: undefined, source: undefined };
}

export function resolveProfileDefaults(project: ProjectConfig | undefined, profile: string | undefined): WorkerProfile | undefined {
  if (project === undefined) {
    if (profile !== undefined) throw new ProjectConfigError('profile', 'no worker defaults file exists for this project');
    return undefined;
  }
  const name = profile ?? project.defaultProfile;
  if (name === undefined) return undefined;
  // hasOwn, not a bare index: `name` is a caller-controlled string, and a
  // lookup that walks the prototype chain would read `constructor`/`toString`
  // as declared profiles and slip past the undefined guard below — creating
  // without the named tier, the silent path this function exists to close.
  if (!Object.hasOwn(project.profiles, name)) throw new ProjectConfigError('profile', `unknown profile; available: ${Object.keys(project.profiles).join(', ')}`);
  return project.profiles[name];
}

/**
 * The three-tier merge for one `session_create` on engine E: the profile's
 * `config` (all engines) first, then `engineConfig[E]` per key, then the
 * caller's explicit `config` per key — the more specific wins, the explicit
 * always wins. An engine with no section in `engineConfig` gets the flat tier
 * only; sections declared for other engines are never consulted.
 *
 * @returns the merged patch; may be empty, which the caller reads as "no fill".
 */
export function mergeProfileDefaults(
  profile: WorkerProfile,
  engine: string,
  explicit: Readonly<Record<string, string | boolean>> | undefined,
): Record<string, string | boolean> {
  // hasOwn, not a bare index: `engine` is a caller-controlled string, and on a
  // profile object that did not come from validateProjectConfig (tests build
  // literals) a prototype-walking lookup would read `constructor`/`toString` as
  // a declared section — the same silent-drop class the profiles table guards.
  const enginePatch = profile.engineConfig !== undefined && Object.hasOwn(profile.engineConfig, engine) ? profile.engineConfig[engine] : undefined;
  return { ...profile.config, ...enginePatch, ...explicit };
}

/**
 * Byte ceiling on an existing file that `project_init` will read back into tool
 * output. A legitimate defaults file is KiB-scale (the generated template is
 * about 2 KiB); the bound only stops anomalous files, and it exists because the
 * whole content enters the orchestrator's context. Over the limit the file
 * counts as invalid: field-level error, never returned, never overwritten.
 */
export const PROJECT_INIT_MAX_CONTENT_BYTES = 64 * 1024;

/** The existing file as `project_init` sees it: raw content plus the validated shape. */
export interface ExistingProjectConfig {
  readonly path: string;
  readonly content: string;
  readonly config: ProjectConfig;
}

/**
 * Read the project's default-config file for `project_init`, or return
 * `undefined` when it does not exist — which is what triggers generation.
 *
 * The read side's discipline applies unchanged: open-no-follow validated
 * through the handle, regular file, not group/world accessible, same validator
 * `session_create` runs — init is not more lenient than the read side, and
 * `refresh` is not a bypass around validation. The one addition is the byte
 * ceiling above, which the read side does not need (it never returns content).
 *
 * @throws {ProjectConfigError} on anything unreadable-as-declared, oversized or
 *   invalid; messages name fields, never file contents.
 */
export function readProjectConfigFile(dataRoot: string, projectKey: string): ExistingProjectConfig | undefined {
  if (!projectKey.startsWith('-') || projectKey.includes('/')) {
    throw new ProjectConfigError('<key>', 'must be a projectKeyFor-encoded key, not a path');
  }
  const path = join(dataRoot, projectKey, 'config.json');
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENAMETOOLONG') return undefined;
    throw new ProjectConfigError('<file>', 'could not be opened as a private regular file');
  }
  try {
    const info: Stats = fstatSync(descriptor);
    if (!info.isFile()) throw new ProjectConfigError('<file>', 'must be a regular file');
    if ((info.mode & 0o077) !== 0) throw new ProjectConfigError('<file>', 'must not be group/world accessible');
    const content = readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > PROJECT_INIT_MAX_CONTENT_BYTES) {
      throw new ProjectConfigError('<file>', `exceeds the ${PROJECT_INIT_MAX_CONTENT_BYTES}-byte content limit`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(content) as unknown; }
    catch { throw new ProjectConfigError('<file>', 'is not valid JSON'); }
    return { path, content, config: validateProjectConfig(parsed) };
  } finally { closeSync(descriptor); }
}

/** The subset of one engine descriptor's configOptions that generation reads. */
export interface ConfigOptionLike {
  readonly id: string;
  readonly category?: string;
  readonly currentValue?: string | boolean;
}

/**
 * The generated `engineConfig` section for one engine: options whose category
 * is `model` or `thought_level` and that report a `currentValue`, copied
 * verbatim. The current value is what the engine is using right now, so writing
 * it down changes no behaviour — it only makes the knob visible and editable.
 * Every key comes from the engine's own descriptor; the plugin invents none. An
 * engine without such options gets an empty section.
 */
export function engineConfigSection(options: readonly ConfigOptionLike[]): Record<string, string | boolean> {
  const section: Record<string, string | boolean> = {};
  for (const option of options) {
    if (option.category !== 'model' && option.category !== 'thought_level') continue;
    if (option.currentValue === undefined) continue;
    section[option.id] = option.currentValue;
  }
  return section;
}

function serializeProfiles(
  config: ProjectConfig,
  engineConfigFor: (profile: WorkerProfile) => Record<string, Readonly<Record<string, string | boolean>>> | undefined,
): string {
  const doc = {
    ...(config.defaultProfile === undefined ? {} : { defaultProfile: config.defaultProfile }),
    profiles: Object.fromEntries(Object.entries(config.profiles).map(([name, profile]) => {
      const engineConfig = engineConfigFor(profile);
      return [name, {
        ...(profile.purpose === undefined ? {} : { purpose: profile.purpose }),
        config: { ...profile.config },
        ...(engineConfig === undefined ? {} : { engineConfig }),
      }];
    })),
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

/**
 * Generate a fresh file from the shipped template skeleton: profile names,
 * `purpose` texts and `config` patches come from the template verbatim, and
 * every profile gets the same freshly generated `engineConfig` sections — the
 * values come from the live descriptors, never from the template's example
 * values. The template is validated with the same rules first: a corrupt
 * shipped copy fails loudly here rather than writing a file the read side
 * would then reject.
 *
 * @param template - the parsed content of the shipped `default-config.json`.
 * @param sections - engine id → generated section, one entry per installed engine.
 * @returns the file content to write.
 * @throws {ProjectConfigError} when the template itself is invalid.
 */
export function generateProjectConfig(template: unknown, sections: Readonly<Record<string, Record<string, string | boolean>>>): string {
  const skeleton = validateProjectConfig(template);
  return serializeProfiles(skeleton, () => Object.fromEntries(Object.entries(sections).map(([engine, section]) => [engine, { ...section }])));
}

/**
 * Merge-regeneration (the `refresh` path): append a section for every engine
 * that is installed now but not yet declared in a profile. Nothing the file
 * already carries is rewritten or deleted — an engine that has a section keeps
 * it verbatim, whatever the descriptor now reports, so a user's edit can never
 * be discarded by init. Byte-level formatting and key order are not promised
 * (a parse–merge–rewrite cannot keep them); the promise is semantic.
 *
 * @param existing - the validated current file.
 * @param sections - engine id → generated section, one entry per installed engine.
 * @returns the merged file content to write.
 */
export function mergeProjectConfig(existing: ProjectConfig, sections: Readonly<Record<string, Record<string, string | boolean>>>): string {
  return serializeProfiles(existing, (profile) => {
    const current = profile.engineConfig ?? {};
    const appended = Object.fromEntries(
      Object.entries(sections)
        .filter(([engine]) => !Object.hasOwn(current, engine))
        .map(([engine, section]) => [engine, { ...section }]),
    );
    // A profile that never had engineConfig and gains nothing stays without
    // the field — adding an empty table would be a change the call did not need.
    if (profile.engineConfig === undefined && Object.keys(appended).length === 0) return undefined;
    return { ...current, ...appended };
  });
}

/**
 * Engine ids that have an `engineConfig` section anywhere in the file — the
 * `enginesIncluded` basis, defined over the returned content regardless of
 * whether this call wrote it.
 */
export function declaredEngines(config: ProjectConfig): string[] {
  const declared = new Set<string>();
  for (const profile of Object.values(config.profiles)) {
    for (const engine of Object.keys(profile.engineConfig ?? {})) declared.add(engine);
  }
  return [...declared].sort();
}

/**
 * Write the project's default-config file with the discipline its trust level
 * requires (the same idiom as the anchor store and the console manifest): the
 * temp file is created 0600 from the start — never 0644-then-chmod, which
 * leaves a readable window — opened `O_NOFOLLOW`, fsynced, then atomically
 * renamed inside the same directory. The project directory is created 0700. A
 * symlink at the target is a field-level error: never followed, never
 * overwritten.
 *
 * @returns the path written.
 * @throws {ProjectConfigError} on a symlink target or a malformed key; whatever
 *   the filesystem throws otherwise, with the previous file untouched because
 *   nothing before the rename writes to the target path.
 */
export async function writeProjectConfigFile(dataRoot: string, projectKey: string, content: string): Promise<string> {
  if (!projectKey.startsWith('-') || projectKey.includes('/')) {
    throw new ProjectConfigError('<key>', 'must be a projectKeyFor-encoded key, not a path');
  }
  const dir = join(dataRoot, projectKey);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'config.json');
  const targetInfo = await lstat(path).catch(() => undefined);
  if (targetInfo !== undefined && targetInfo.isSymbolicLink()) throw new ProjectConfigError('<file>', 'must not be a symbolic link');
  const temp = join(dir, `.config.json.tmp-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const tempInfo = await lstat(temp);
    if (tempInfo.isSymbolicLink() || !tempInfo.isFile() || (tempInfo.mode & 0o777) !== 0o600) throw new Error('unsafe worker defaults file');
    await rename(temp, path);
    return path;
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
  }
}
