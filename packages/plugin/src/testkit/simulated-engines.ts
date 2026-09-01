import { builtinAdapters, createHub } from 'runskein';
import { scriptedAdapter } from '@runskein/testkit';

import { FROZEN_ENGINE_IDS, type EngineId } from '../schemas.js';

/**
 * Simulated engines for the live gates (design §17 step 9).
 *
 * The gates run twice: once against these simulated engines, which exercise the
 * whole plugin path without spending a real engine turn, and once against the
 * installed CLIs. The simulation uses `@runskein/testkit`'s scripted ACP agent
 * rather than a hand-written server, so the wire behaviour under test is one
 * Realm maintains — a home-grown stub would only prove the plugin agrees with
 * itself.
 *
 * The testkit is a published package with a stated contract: the exports, the
 * `RUNSKEIN_TESTKIT_*` variables, and the observable behaviour each produces.
 * Reply strings, session ids and update ordering beyond that are explicitly not
 * promised, so assert on shape and on what you configured. Earlier this file
 * located Realm's own internal fixture inside the dependency tree, which worked
 * only while the tree was vendored and carried no promise at all.
 */
export const SIMULATED_ENGINES: readonly EngineId[] = FROZEN_ENGINE_IDS;

export interface SimulatedEngineOptions {
  /** Per-engine `RUNSKEIN_TESTKIT_*` toggles for the scripted agent. */
  readonly env?: Partial<Record<EngineId, Record<string, string>>>;
  readonly startTimeoutMs?: number;
}

/**
 * The four frozen engine ids, each backed by the scripted agent. Engine
 * selection stays explicit: the ids, not the transport, are what the
 * orchestrator chooses between.
 * @param options - per-engine agent configuration and start budget.
 * @returns one adapter per frozen engine id.
 */
export function simulatedAdapters(options: SimulatedEngineOptions = {}): ReturnType<typeof scriptedAdapter>[] {
  const startTimeoutMs = options.startTimeoutMs ?? 20_000;
  return SIMULATED_ENGINES.map((engine) =>
    scriptedAdapter({ id: engine, env: { ...(options.env?.[engine] ?? {}) }, startTimeoutMs }),
  );
}

/**
 * Every frozen §4.2 engine still has a built-in adapter to simulate.
 *
 * This replaces a strict `builtin.size === SIMULATED_ENGINES.length`, which
 * failed the whole suite the moment Realm registered any new adapter — even
 * though nothing here had opted in. Under ADR 0004 that is information, not an
 * error.
 *
 * Scope is deliberately narrow: this asks only whether the harness can still
 * simulate what it claims to. The support-claim half of the tripwire — that no
 * engine is marked verified without the registry reporting it — lives in the
 * artifact gate, because builtins are only Realm's discovery base layer and a
 * workspace or installed adapter may override one by id. Only a live plugin has
 * the registry that question is about.
 * @returns whether every simulated id is still a built-in adapter id.
 */
export function simulatedEnginesCoverBuiltins(): boolean {
  const builtin = new Set(builtinAdapters.map((adapter) => adapter.id));
  return SIMULATED_ENGINES.every((engine) => builtin.has(engine));
}

/**
 * A `hubFactory` for `PluginRuntime`: the real Realm hub, the real store and
 * the real session machinery — only the engine binaries are simulated.
 * @param options - per-engine agent configuration and start budget.
 * @returns a factory that builds a hub whose adapters are the scripted ones.
 */
export function simulatedHubFactory(
  options: SimulatedEngineOptions = {},
): (hubOptions: Parameters<typeof createHub>[0]) => ReturnType<typeof createHub> {
  const adapters = simulatedAdapters(options);
  return (hubOptions) =>
    createHub({ ...(hubOptions ?? {}), adapters, discovery: false } as Parameters<typeof createHub>[0]);
}
