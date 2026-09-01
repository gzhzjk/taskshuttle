import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Return the public Plugin manifest followed by every host-owned manifest that
 * declares itself part of the release version agreement.
 *
 * Host discovery is deliberately data-driven: adding a host only requires its
 * `host.json` and its declared `versionedManifest`. Release scripts must not
 * grow another host-name list that can drift from the discovery contract.
 *
 * @param {string} root repository root
 * @returns {string[]} repository-relative manifest paths
 * @throws when a host manifest is malformed or names an unsafe versioned path
 */
export function discoverVersionedManifests(root) {
  const absoluteRoot = resolve(root);
  const paths = ['packages/plugin/package.json'];
  const hostsRoot = join(absoluteRoot, 'hosts');
  for (const entry of readdirSync(hostsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error(`host directory symlink is not allowed: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    const hostDirectory = join(hostsRoot, entry.name);
    const manifestPath = join(hostDirectory, 'host.json');
    // Host discovery deliberately ignores scaffolding directories without a
    // manifest. This is the same rule as the strict runtime discovery; a
    // release helper must not make a draft directory release-fatal.
    if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) continue;
    let host;
    try { host = JSON.parse(readFileSync(manifestPath, 'utf8')); }
    catch (cause) { throw new Error(`cannot read ${manifestPath}: ${cause instanceof Error ? cause.message : String(cause)}`); }
    if (host === null || typeof host !== 'object' || Array.isArray(host) || host.id !== entry.name) {
      throw new Error(`${manifestPath} has an invalid host id`);
    }
    const versioned = host?.versionedManifest;
    if (versioned === undefined) continue;
    if (typeof versioned !== 'string' || versioned.length === 0 || versioned.startsWith('/') || /^[A-Za-z]:/u.test(versioned) || versioned.includes('\\') || versioned.split('/').some((part) => part === '' || part === '.' || part === '..')) throw new Error(`${manifestPath} declares an unsafe versionedManifest`);
    const artifact = Array.isArray(host.artifacts)
      ? host.artifacts.find((candidate) => candidate !== null && typeof candidate === 'object' && candidate.path === versioned)
      : undefined;
    if (artifact === undefined || artifact.generated !== false) throw new Error(`${manifestPath} versionedManifest must name one static declared artifact`);
    const target = join(hostDirectory, versioned);
    if (!existsSync(target) || !statSync(target).isFile()) throw new Error(`${manifestPath} versionedManifest target is missing: ${versioned}`);
    const escaped = relative(realpathSync(hostDirectory), realpathSync(target));
    if (escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) throw new Error(`${manifestPath} versionedManifest escapes host directory: ${versioned}`);
    paths.push(`hosts/${entry.name}/${versioned}`);
  }
  return paths;
}
