import { mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import ts from 'typescript';

/** Stable generic capability identifiers claimed by host manifests. */
export const HOST_KITS = ['stdio-mcp', 'shared-skill', 'stop-hook', 'marketplace', 'managed-copy'] as const;
export type HostKitId = (typeof HOST_KITS)[number];

const HOST_KIT_SET = new Set<string>(HOST_KITS);
const KINDS = new Set(['marketplace-plugin', 'stdio-config', 'managed-plugin']);
const SCOPES = new Set(['user', 'project', 'local']);
const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'id', 'kind', 'baseline', 'scopes', 'kits', 'driver', 'versionedManifest', 'artifacts']);

export interface HostArtifact {
  readonly role: string;
  readonly path: string;
  readonly generated: boolean;
}

export interface HostManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly kind: 'marketplace-plugin' | 'stdio-config' | 'managed-plugin';
  readonly baseline: string;
  readonly scopes: readonly ('user' | 'project' | 'local')[];
  readonly kits: readonly HostKitId[];
  readonly driver: string;
  readonly versionedManifest?: string;
  readonly artifacts: readonly HostArtifact[];
}

/** Validate generic kit source without allowing host policy to leak into it. */
export function assertGenericKitSource(source: string, options: { allowProcessRunner?: boolean } = {}): void {
  const sourceFile = ts.createSourceFile('host-kit.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let effectViolation = false;
  let hostViolation = false;
  const idDerivedNames = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;
      if (!options.allowProcessRunner && (moduleName === 'node:child_process' || moduleName === 'node:process')) effectViolation = true;
      if (/(?:^|[\\/])hosts(?:[\\/]|$)/u.test(moduleName)) hostViolation = true;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && ts.isPropertyAccessExpression(node.initializer) && node.initializer.name.text === 'id') {
      idDerivedNames.add(node.name.text);
    }
    if (ts.isBinaryExpression(node) && [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
    ].includes(node.operatorToken.kind)) {
      const [left, right] = [node.left, node.right];
      const idValue = (value: ts.Expression): boolean => (ts.isPropertyAccessExpression(value) && value.name.text === 'id')
        || (ts.isIdentifier(value) && (idDerivedNames.has(value.text) || /^(?:host|hostId|hostName)$/iu.test(value.text)));
      if ((idValue(left) || idValue(right)) && (ts.isStringLiteral(left) || ts.isStringLiteral(right))) hostViolation = true;
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'process' && (node.name.text === 'env' || node.name.text === 'cwd')) effectViolation = true;
    if (!options.allowProcessRunner && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync'].includes(node.expression.text)) effectViolation = true;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (effectViolation) throw new Error('host-kit source contains an undeclared process or environment effect');
  if (hostViolation) throw new Error('host-kit source contains a host-ID conditional or dependency');
}

function readObjectId(expression: ts.Expression): string | undefined {
  if (ts.isObjectLiteralExpression(expression)) {
    for (const property of expression.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = property.name;
      if (!(ts.isIdentifier(name) || ts.isStringLiteral(name)) || name.text !== 'id') continue;
      const value = property.initializer;
      if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
    }
  }
  if (ts.isCallExpression(expression)) {
    const first = expression.arguments[0];
    if (first !== undefined && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) return first.text;
  }
  return undefined;
}

function exportedDriverId(source: string): string | undefined {
  const sourceFile = ts.createSourceFile('host-driver.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const variableIds = new Map<string, string>();
  const exportedNames = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
          const id = readObjectId(declaration.initializer);
          if (id !== undefined) variableIds.set(declaration.name.text, id);
        }
      }
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) exportedNames.add(element.propertyName?.text ?? element.name.text);
    }
  }
  const readReference = (expression: ts.Expression): string | undefined => {
    if (ts.isIdentifier(expression)) return variableIds.get(expression.text);
    return readObjectId(expression);
  };
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const id = readReference(statement.expression);
      if (id !== undefined) return id;
    }
    if (!ts.isVariableStatement(statement)) continue;
    const isExported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
      if (isExported || exportedNames.has(declaration.name.text)) {
        const id = readReference(declaration.initializer);
        if (id !== undefined) return id;
      }
    }
  }
  return undefined;
}

/** Validate a host driver without importing or executing it. */
export async function validateHostDriver(driverPath: string, expectedId: string): Promise<void> {
  const source = await readFile(driverPath, 'utf8');
  if (/node:child_process|\b(?:spawn|exec|execFile|fork|execSync|spawnSync)\s*\(/u.test(source)) {
    throw new Error('host driver may not import or invoke node:child_process APIs');
  }
  if (/\b(?:sh|bash|zsh|cmd|powershell)(?:\.exe)?\s+-c\b|['"`]\s*(?:sh|bash|zsh|cmd|powershell)(?:\.exe)?\s+-c\b/iu.test(source)) {
    throw new Error('host driver may not contain shell command strings');
  }
  if (/(?:node:fs(?:\/promises)?|from\s+['"]fs(?:\/promises)?['"]|require\(\s*['"]fs(?:\/promises)?['"])/u.test(source)) {
    throw new Error('host driver may only use scoped filesystem helpers');
  }
  if (/\bprocess\.(?:env|cwd)\b/u.test(source)) {
    throw new Error('host driver may not access process environment or cwd directly');
  }
  const id = exportedDriverId(source);
  if (id !== expectedId) throw new Error(`host driver exported id '${id ?? 'missing'}' does not match manifest id '${expectedId}'`);
}

/** Return whether a manifest path is normalized, relative, and platform-neutral. */
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value) || value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

async function realpathForTarget(path: string): Promise<string> {
  const suffix: string[] = [];
  let cursor = path;
  while (true) {
    try { return join(await realpath(cursor), ...suffix.reverse()); }
    catch {
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error(`cannot resolve ${path}`);
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

async function assertContained(hostDirectory: string, path: string, allowMissing: boolean): Promise<void> {
  if (!isSafeRelativePath(path)) throw new Error(`unsafe relative path '${path}'`);
  const canonicalHost = await realpath(hostDirectory);
  const target = join(hostDirectory, path);
  const canonicalTarget = await realpathForTarget(target);
  const escaped = relative(canonicalHost, canonicalTarget).split('/').includes('..');
  if (escaped || canonicalTarget === '') throw new Error(`path escapes host directory: ${path}`);
  if (!allowMissing) await stat(target);
}

/** Parse and validate one HostManifestV1 and all static driver/artifact paths. */
export async function validateHostManifest(document: unknown, hostDirectory: string): Promise<HostManifest> {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) throw new Error('host manifest must be an object');
  const record = document as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!TOP_LEVEL_KEYS.has(key)) throw new Error(`unknown host manifest field '${key}'`);
  if (record.schemaVersion !== 1) throw new Error('unsupported host manifest schemaVersion');
  if (typeof record.id !== 'string' || record.id !== basename(hostDirectory)) throw new Error('host manifest id must equal the directory basename');
  if (typeof record.kind !== 'string' || !KINDS.has(record.kind)) throw new Error('unknown host manifest kind');
  if (typeof record.baseline !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(record.baseline)) throw new Error('host manifest baseline is not a version');
  if (!Array.isArray(record.scopes) || record.scopes.length === 0 || record.scopes.some((scope) => typeof scope !== 'string' || !SCOPES.has(scope))) throw new Error('host manifest scopes are invalid');
  if (new Set(record.scopes).size !== record.scopes.length) throw new Error('host manifest scopes must be unique');
  if (!Array.isArray(record.kits) || record.kits.some((kit) => typeof kit !== 'string' || !HOST_KIT_SET.has(kit))) throw new Error('host manifest kits contain an unknown capability');
  if (new Set(record.kits).size !== record.kits.length) throw new Error('host manifest kits must be unique');
  if (!isSafeRelativePath(record.driver)) throw new Error('host manifest driver must be normalized and relative');
  await assertContained(hostDirectory, record.driver, false);
  await validateHostDriver(join(hostDirectory, record.driver), record.id);
  if (!Array.isArray(record.artifacts) || record.artifacts.length === 0) throw new Error('host manifest artifacts are required');
  const artifacts: HostArtifact[] = [];
  const roles = new Set<string>();
  const paths = new Set<string>();
  for (const value of record.artifacts) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('host artifact must be an object');
    const artifact = value as Record<string, unknown>;
    if (typeof artifact.role !== 'string' || artifact.role.length === 0 || roles.has(artifact.role)) throw new Error('host artifact roles must be unique and non-empty');
    if (!isSafeRelativePath(artifact.path) || paths.has(artifact.path)) throw new Error('host artifact paths must be unique and normalized');
    if (typeof artifact.generated !== 'boolean') throw new Error('host artifact generated must be boolean');
    roles.add(artifact.role); paths.add(artifact.path);
    await assertContained(hostDirectory, artifact.path, artifact.generated);
    artifacts.push({ role: artifact.role, path: artifact.path, generated: artifact.generated });
  }
  if (record.versionedManifest !== undefined) {
    if (!isSafeRelativePath(record.versionedManifest)) throw new Error('versionedManifest must be normalized and relative');
    const match = artifacts.find((artifact) => artifact.path === record.versionedManifest);
    if (match === undefined || match.generated) throw new Error('versionedManifest must name one static declared artifact');
    await assertContained(hostDirectory, record.versionedManifest, false);
  }
  return {
    schemaVersion: 1,
    id: record.id,
    kind: record.kind as HostManifest['kind'],
    baseline: record.baseline,
    scopes: [...record.scopes] as HostManifest['scopes'],
    kits: [...record.kits] as HostKitId[],
    driver: record.driver,
    ...(record.versionedManifest === undefined ? {} : { versionedManifest: record.versionedManifest }),
    artifacts,
  };
}

/** Discover direct host directories and validate every manifest-bearing entry. */
export async function discoverHostManifests(root: string): Promise<HostManifest[]> {
  const hostsDirectory = join(root, 'hosts');
  const entries = await readdir(hostsDirectory, { withFileTypes: true });
  const manifests: HostManifest[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) throw new Error(`host directory symlink is not allowed: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    const directory = join(hostsDirectory, entry.name);
    const manifestPath = join(directory, 'host.json');
    if (!(await stat(manifestPath).catch(() => undefined))?.isFile()) continue;
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
    manifests.push(await validateHostManifest(parsed, directory));
  }
  return manifests.sort((left, right) => left.id.localeCompare(right.id));
}

/** Reject a discovered host until frozen support and evidence name it. */
export function assertSupportAlignment(manifests: readonly HostManifest[], supportedHostIds: readonly string[]): void {
  const ids = manifests.map((manifest) => manifest.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate host id');
  const unknown = ids.filter((id) => !supportedHostIds.includes(id));
  if (unknown.length > 0) throw new Error(`host ${unknown.join(', ')} is discovered but not in the frozen support matrix`);
  const missing = supportedHostIds.filter((id) => !ids.includes(id));
  if (missing.length > 0) throw new Error(`frozen supported host is missing: ${missing.join(', ')}`);
}

/** Create a minimal fixture for consumers that need a valid manifest in tests. */
export async function createManifestFixture(parent: string, id = 'fixture'): Promise<string> {
  const directory = join(parent, id);
  await mkdir(directory, { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  await Promise.all([
    writeFile(join(directory, 'driver.ts'), `export default { id: '${id}' };`),
    writeFile(join(directory, 'plugin.json'), '{}'),
    writeFile(join(directory, 'host.json'), JSON.stringify({ schemaVersion: 1, id, kind: 'stdio-config', baseline: '1.0.0', scopes: ['user'], kits: ['stdio-mcp'], driver: 'driver.ts', versionedManifest: 'plugin.json', artifacts: [{ role: 'plugin-manifest', path: 'plugin.json', generated: false }] })),
  ]);
  return directory;
}
