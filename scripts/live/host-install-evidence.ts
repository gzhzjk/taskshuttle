/** Typed operator evidence for the rename-specific HOST-COMMON-006 gate. */
export interface HostInstallEvidence {
  readonly hosts: Readonly<Record<string, { readonly pluginIds: readonly string[]; readonly managedPaths: readonly string[] }>>;
  readonly npmGlobalPackages: readonly string[];
}

function isNormalizedAbsolutePath(path: string): boolean {
  if (!path.startsWith('/') || path.includes('\0')) return false;
  const segments = path.split('/').slice(1);
  return segments.length > 0 && segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/** Parse the evidence file rather than letting a manual confirmation assert an install state. */
export function parseHostInstallEvidence(source: string): HostInstallEvidence {
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new Error('host install evidence is not valid JSON'); }
  if (value === null || typeof value !== 'object') throw new Error('host install evidence must be an object');
  const record = value as Record<string, unknown>;
  if (record['hosts'] === null || typeof record['hosts'] !== 'object' || Array.isArray(record['hosts'])) throw new Error('host install evidence.hosts must be an object');
  if (!Array.isArray(record['npmGlobalPackages']) || !record['npmGlobalPackages'].every((entry) => typeof entry === 'string')) throw new Error('host install evidence.npmGlobalPackages must be a string array');
  const hosts: Record<string, { pluginIds: string[]; managedPaths: string[] }> = {};
  for (const [host, raw] of Object.entries(record['hosts'] as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`host install evidence.hosts.${host} must be an object`);
    const listing = raw as Record<string, unknown>;
    for (const field of ['pluginIds', 'managedPaths'] as const) {
      if (!Array.isArray(listing[field]) || !listing[field].every((entry) => typeof entry === 'string')) throw new Error(`host install evidence.hosts.${host}.${field} must be a string array`);
    }
    hosts[host] = { pluginIds: [...listing['pluginIds'] as string[]], managedPaths: [...listing['managedPaths'] as string[]] };
  }
  return { hosts, npmGlobalPackages: [...record['npmGlobalPackages'] as string[]] };
}

/** Return every identity mismatch so a stale host cannot be hidden by a passing confirmation. */
export function validateHostInstallEvidence(evidence: HostInstallEvidence, expectedHosts: readonly string[], expectedPackage: string, retiredPackage: string): string[] {
  const issues: string[] = [];
  for (const host of expectedHosts) {
    const listing = evidence.hosts[host];
    if (listing === undefined) { issues.push(`missing evidence for host ${host}`); continue; }
    if (listing.pluginIds.length !== 1 || listing.pluginIds[0] !== expectedPackage) issues.push(`host ${host} must list exactly ${expectedPackage}`);
    if (listing.pluginIds.includes(retiredPackage)) issues.push(`host ${host} still lists retired id ${retiredPackage}`);
    if (host === 'kimi' && listing.managedPaths.length !== 1) issues.push('host kimi must list exactly one managed plugin path');
    if (listing.managedPaths.some((path) => !isNormalizedAbsolutePath(path))) issues.push(`host ${host} has an invalid managed path`);
    if (listing.managedPaths.some((path) => path.includes(retiredPackage))) issues.push(`host ${host} still has a managed path for retired package ${retiredPackage}`);
  }
  for (const host of Object.keys(evidence.hosts)) if (!expectedHosts.includes(host)) issues.push(`evidence names undeclared host ${host}`);
  if (!evidence.npmGlobalPackages.includes(expectedPackage)) issues.push(`npm global listing lacks ${expectedPackage}`);
  if (evidence.npmGlobalPackages.includes(retiredPackage)) issues.push(`npm global listing still contains retired package ${retiredPackage}`);
  return issues;
}
