/**
 * Gate-side engine metadata.
 *
 * The engine set itself comes from `FROZEN_ENGINE_IDS` (packages/plugin/src/schemas.ts) — this file
 * only adds what the gates need and the runtime does not: which executable to
 * probe for a version. Keeping that here leaves test-only knowledge out of the
 * production surface.
 *
 * `Record<EngineId, string>` is load-bearing: adding an engine id without a CLI
 * name fails to compile here rather than producing an `undefined` binary name
 * that a gate would report as "not installed".
 */
import { FROZEN_ENGINE_IDS, type EngineId, type FrozenEngineId } from '../../packages/plugin/src/schemas.js';

export { FROZEN_ENGINE_IDS, type EngineId, type FrozenEngineId };

/**
 * Engine id → the executable whose `--version` the gates read.
 *
 * Keyed on `FrozenEngineId`, not `EngineId`: ids are open now (ADR 0004), so
 * `Record<EngineId, string>` would be `Record<string, string>` and would check
 * nothing. Against the frozen four this still fails to compile when one is
 * added without a CLI name, which is the point of the map.
 */
export const CLI_FOR: Record<FrozenEngineId, string> = {
  codex: 'codex',
  'claude-code': 'claude',
  opencode: 'opencode',
  kimi: 'kimi',
};

/**
 * Binaries for engines beyond the frozen four, so a live report can record what
 * it actually exercised.
 *
 * Deliberately separate from `CLI_FOR`: that map is exhaustive over the frozen
 * ids and the compiler keeps it that way, which is the property worth having.
 * This one is best-effort — an engine with no entry reports `unknown` rather
 * than a guessed binary name, because a wrong version in an evidence record is
 * worse than an absent one.
 */
export const CLI_FOR_OPTIONAL: Readonly<Record<string, string>> = { pi: 'pi' };

/** `{ [engine]: version }` for the frozen engines, for report provenance. */
export function engineCliVersions(read: (bin: string) => string): Record<string, string> {
  return Object.fromEntries(FROZEN_ENGINE_IDS.map((engine) => [engine, read(CLI_FOR[engine])]));
}
