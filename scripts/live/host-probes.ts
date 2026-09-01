import type { CaseResult } from './evidence.js';

/** Result returned by one host-owned live case before the central recorder adds identity and duration. */
export type HostProbeOutcome = Omit<CaseResult, 'id' | 'title' | 'durationMs'>;

/** Minimal server surface host probes may use without owning orchestration or report writing. */
export interface HostProbeServer {
  readonly pid: number;
  readonly dataRoot: string;
  readonly workRoot: string;
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  stop(signal: NodeJS.Signals): Promise<{ exitedWithinMs: number | undefined }>;
}

/** Dependencies injected by the generic host gate into a host-owned probe. */
export interface HostProbeContext {
  readonly root: string;
  readonly runId: string;
  readonly confirmed: ReadonlySet<string>;
  readonly codexTrust: string | undefined;
  readonly hostBaselines: Readonly<Record<string, string>>;
  readonly cliVersion: (command: string, args?: readonly string[]) => string;
  readonly startServer: () => Promise<HostProbeServer>;
  readonly toolFailure: (result: Record<string, unknown>) => { code?: string; message?: string; cause?: unknown } | undefined;
  readonly runStagedHook: (entry: string, payload: unknown, env: NodeJS.ProcessEnv) => Promise<{ stdout: string; code: number | null }>;
  readonly nannyHookEntry: string;
}

/** A named host-owned live case. The central gate only records its outcome. */
export interface HostProbeCase {
  readonly id: string;
  readonly title: string;
  run(context: HostProbeContext): Promise<HostProbeOutcome>;
}
