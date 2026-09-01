/** Public package entry for the embedded TaskShuttle Plugin. */
export { createTaskShuttleServer } from './server.js';
export type { TaskShuttleServer } from './server.js';

/** Internal package marker retained for package-boundary probes. */
export type PluginPackageBoundary = Readonly<{ packageName: 'taskshuttle' }>;

export { createSessionWithNormalizedCwd } from './cwd-boundary.js';
export type { CoreSessionReservation, CwdEvidence, CwdPolicy } from './cwd-boundary.js';
export { RunskeinAgentProvider } from './runskein-adapter.js';
export type { RunskeinAdapterOptions, RunskeinHub } from './runskein-adapter.js';
