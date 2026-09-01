import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { discoverHostManifests } from '@taskshuttle/host-kit';

interface ReleaseMetadata {
  hosts?: Record<string, string>;
  readonly [key: string]: unknown;
}

/**
 * Regenerate the release metadata host-baseline projection from host manifests.
 * Evidence, verification state, and timestamps remain untouched in the central
 * metadata document; only its derived `hosts` map is replaced.
 *
 * @param root repository root
 * @returns a promise settled after metadata is synchronized
 * @throws when the metadata file or a discovered host manifest is invalid
 */
export async function syncHostBaselines(root = process.cwd()): Promise<void> {
  const absoluteRoot = resolve(root);
  const metadataPath = join(absoluteRoot, 'release', 'metadata.json');
  const raw = await readFile(metadataPath, 'utf8');
  const metadata = JSON.parse(raw) as ReleaseMetadata;
  const manifests = await discoverHostManifests(absoluteRoot);
  const hosts = Object.fromEntries(manifests.map((manifest) => [manifest.id, manifest.baseline]));
  const current = metadata.hosts ?? {};
  if (Object.keys(current).length === Object.keys(hosts).length && Object.entries(hosts).every(([id, baseline]) => current[id] === baseline)) return;
  const marker = raw.indexOf('"hosts"');
  const open = raw.indexOf('{', marker);
  if (marker < 0 || open < 0) throw new Error('release metadata has no top-level hosts projection');
  let depth = 0;
  let close = -1;
  let quoted = false;
  for (let index = open; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === '"' && raw[index - 1] !== '\\') quoted = !quoted;
    if (quoted) continue;
    if (character === '{') depth += 1;
    if (character === '}' && --depth === 0) { close = index; break; }
  }
  if (close < 0) throw new Error('release metadata hosts projection is not closed');
  const replacement = JSON.stringify(hosts, null, 2).split('\n').map((line, index) => index === 0 ? line : `  ${line}`).join('\n');
  await writeFile(metadataPath, `${raw.slice(0, open)}${replacement}${raw.slice(close + 1)}`, 'utf8');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await syncHostBaselines();
}
