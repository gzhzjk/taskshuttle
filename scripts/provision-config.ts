import { mkdir, open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { CONFIG_FILE_NAME, readPluginConfigFile, resolveDataRoot, resolvePluginConfigFile, PluginConfigError } from '../packages/plugin/src/plugin-config.js';

/**
 * What provisioning did, and what the operator has to know afterwards.
 *
 * - `written`: there was no admin install file and this run created one.
 * - `console-already-declared`: a file exists and already states `console`.
 * - `console-not-declared`: a file exists and states no `console` — deploy says
 *   so and changes nothing, because merging into a file the operator wrote is
 *   how a hand-edited install surface gets silently rewritten.
 * - `unreadable`: a file exists that the plugin itself would refuse at start-up
 *   (bad JSON, not an object, group/world accessible). Reported, never repaired.
 */
export type ProvisionOutcome = 'written' | 'console-already-declared' | 'console-not-declared' | 'unreadable';

export interface ProvisionResult {
  readonly outcome: ProvisionOutcome;
  readonly path: string;
  /** Present on `unreadable`: why the existing file would fail start-up. */
  readonly detail?: string;
}

/**
 * Give a first install a console (GZH-78). Without this, `console.enabled`
 * defaults to false and nothing writes the admin install file, so a fresh
 * machine reaches `taskshuttle console open` with nothing to open and the
 * operator has to discover both the file and the field by hand.
 *
 * This does not widen who may grant network capability (ADR 0003): the file is
 * the install surface, an operator running the installer is the one authoring
 * it, and every later boot reads whatever the operator has since made it say.
 * Which is why an existing file is never edited — create-if-absent only.
 *
 * @param env environment used to resolve the data root and any config-file override.
 * @param dryRun when true, report what would happen and write nothing.
 * @returns the outcome and the path it applies to.
 * @throws Error when the file is absent and cannot be created.
 */
export async function ensureConsoleConfig(env: NodeJS.ProcessEnv = process.env, dryRun = false): Promise<ProvisionResult> {
  const dataRoot = resolveDataRoot(env);
  const { path } = resolvePluginConfigFile(dataRoot, env);

  const existing = await inspectExisting(path, dataRoot, env);
  if (existing !== undefined) return existing;
  if (dryRun) return { outcome: 'written', path };

  // 0700/0600 and an exclusive create: the plugin refuses a group/world
  // accessible install file at start-up, so provisioning one that boots is part
  // of the job, and `wx` means a file that appeared since the check above wins.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      const raced = await inspectExisting(path, dataRoot, env);
      if (raced !== undefined) return raced;
    }
    throw new Error(`cannot create ${path}: ${(cause as Error).message}`);
  }
  try {
    await handle.writeFile(`${JSON.stringify({ console: { enabled: true } }, null, 2)}\n`, 'utf8');
    // The mode argument is masked by umask; the console's data is the reason
    // the plugin refuses a wider file, so set it rather than hope for 0o077.
    await handle.chmod(0o600);
  } finally { await handle.close(); }
  return { outcome: 'written', path };
}

/**
 * Classify a file that is already there, using the plugin's own reader so that
 * "would this boot?" is answered by the code that decides it at boot.
 *
 * @returns undefined when no file exists at `path` — the caller may create one.
 */
async function inspectExisting(path: string, dataRoot: string, env: NodeJS.ProcessEnv): Promise<ProvisionResult | undefined> {
  try { await stat(path); } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return { outcome: 'unreadable', path, detail: (cause as Error).message };
  }
  let content: unknown;
  try { content = readPluginConfigFile(dataRoot, env); }
  catch (cause) {
    return { outcome: 'unreadable', path, detail: cause instanceof PluginConfigError ? cause.message : String(cause) };
  }
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    return { outcome: 'unreadable', path, detail: `${path} must contain a configuration object` };
  }
  return (content as Record<string, unknown>)['console'] === undefined
    ? { outcome: 'console-not-declared', path }
    : { outcome: 'console-already-declared', path };
}

/** One line for the deploy summary, naming what the operator must do next. */
export function describeProvision(result: ProvisionResult): string {
  switch (result.outcome) {
    case 'written':
      return `${result.path} created (0600) with console.enabled true — the console listens from the next host session`;
    case 'console-already-declared':
      return `${result.path} already declares console — left untouched`;
    case 'console-not-declared':
      return `${result.path} exists and declares no console — add {"console":{"enabled":true}} by hand to get one`;
    case 'unreadable':
      return `${result.path} would fail start-up (${result.detail ?? 'unknown cause'}) — fix it by hand; ${CONFIG_FILE_NAME} must be private JSON`;
  }
}
