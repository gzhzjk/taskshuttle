import type { CoreResult } from './errors.js';

/** A pure worker-default profile; file discovery and validation stay in Plugin. */
export interface DefaultProfile {
  readonly config: Readonly<Record<string, string | boolean>>;
  readonly engineConfig?: Readonly<Record<string, Readonly<Record<string, string | boolean>>>>;
}

/** Merge generic, engine-specific, and explicit values with explicit values winning. */
export function mergeWorkerDefaults(profile: DefaultProfile | undefined, engine: string, explicit: Readonly<Record<string, string | boolean>>): Readonly<Record<string, string | boolean>> {
  if (profile === undefined) return Object.freeze({ ...explicit });
  return Object.freeze({ ...profile.config, ...(profile.engineConfig?.[engine] ?? {}), ...explicit });
}

/** Select a named profile without reading a file or consulting an engine registry. */
export function selectWorkerDefaults(profiles: Readonly<Record<string, DefaultProfile>>, name: string | undefined): CoreResult<DefaultProfile | undefined> {
  if (name === undefined) return { ok: true, value: undefined };
  const profile = profiles[name];
  return profile === undefined
    ? { ok: false, error: { code: 'invalid-input', message: `worker defaults profile '${name}' was not found` } }
    : { ok: true, value: profile };
}
