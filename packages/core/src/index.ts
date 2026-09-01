/** Intentional Core package entry point: only domain APIs, DTOs, errors, and ports. */
export * from './types.js';
export * from './errors.js';
export * from './events.js';
export * from './ports.js';
export * from './transcript-page.js';
export * from './mutation-gate.js';
export * from './state-machine.js';
export * from './registry.js';
export * from './scheduler.js';
export * from './services.js';
export * from './workspace-policy.js';
export * from './defaults-policy.js';
export * from './anchor-policy.js';
export * from './interaction-policy.js';
export * from './delegation-policy.js';
import { createCoreApplication, type CoreApplication } from './services.js';

/** Construct Core contracts without starting a process or opening a transport.
 * @param environment - explicit ports supplied by the composition layer
 * @returns a Core application handle retaining the injected environment
 */
export function createCore(environment: import('./ports.js').CoreEnvironment): CoreApplication {
  return createCoreApplication(environment);
}
