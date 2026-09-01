import ts from 'typescript';
import { builtinModules } from 'node:module';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export type CoreBoundaryCategory =
  | 'plugin'
  | 'mcp'
  | 'runskein'
  | 'host'
  | 'console'
  | 'filesystem'
  | 'environment'
  | 'process'
  | 'release'
  | 'workspace'
  | 'dependency';

export interface CoreBoundaryViolation {
  category: CoreBoundaryCategory;
  file: string;
  detail: string;
}

/**
 * Node built-ins that are permitted in Core after extraction.
 *
 * This is deliberately a closed list. A new built-in must be reviewed before
 * it can enter Core; treating every unrecognised `node:` specifier as safe
 * would allow transports and process-control APIs to cross the boundary.
 */
export const ALLOWED_NODE_BUILTINS = new Set(['node:crypto', 'node:path']);
// Phase 4.8 makes the package boundary authoritative for extracted code. The
// former root source tree is intentionally absent; only package-owned Core is
// scanned so a deleted compatibility bridge cannot hide a boundary violation.
export const CORE_SOURCE_ROOTS = ['packages/core/src'] as const;
/**
 * Immutable Phase 0 anchor for every legacy file assigned to Core. The
 * transitional list below may shrink as extraction lands, but this list does
 * not: it keeps a move from being hidden by deleting the pending entry.
 */
export const PHASE0_CORE_DESTINED_FILES = [
  'src/core/anchor-store.ts',
  'src/core/delegation-evidence.ts',
  'src/core/engine-support.ts',
  'src/core/interaction-broker.ts',
  'src/core/logger.ts',
  'src/core/mutation-gate.ts',
  'src/core/nanny-snapshot.ts',
  'src/core/project-config.ts',
  'src/core/registry.ts',
  'src/core/scheduler.ts',
  'src/core/security-policy.ts',
  'src/core/state-machine.ts',
  'src/core/transcript-page.ts',
] as const;
/** Legacy files whose extraction produced both a Core API and a Plugin remainder. */
export const PHASE0_CORE_SPLIT_FILES = [
  'src/core/engine-support.ts',
  'src/core/logger.ts',
  'src/core/transcript-page.ts',
] as const;
/**
 * No Core-owned legacy source remains pending. The nine files in the original
 * The Phase 0 list remains an immutable historical anchor. Its owner
 * corrections point at package-local Plugin files, while the old root paths
 * are deleted once the compatibility entry surface is retired.
 */
export const TRANSITIONAL_CORE_SOURCE_FILES = [] as const;
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const PROCESS_BUILTINS = new Set(['node:child_process', 'node:cluster', 'node:worker_threads', 'node:process']);
const TRANSPORT_BUILTINS = new Set(['node:dgram', 'node:dns', 'node:dns/promises', 'node:http', 'node:http2', 'node:https', 'node:net', 'node:tls']);

/** Recursively enumerate TypeScript files below a Core source root. */
export async function walkCoreSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkCoreSourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files.sort();
}

const isDeclarationName = (node: ts.Identifier): boolean => {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return true;
  if (ts.isClassDeclaration(parent) && parent.name === node) return true;
  if (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent)) return true;
  if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) return true;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodSignature(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) return true;
  return false;
};

const categoryForModule = (moduleName: string): CoreBoundaryCategory | undefined => {
  if (/^(?:@runskein\/|runskein(?:$|\/))/u.test(moduleName)) return 'runskein';
  if (/^@modelcontextprotocol\//u.test(moduleName) || /(?:^|\/)mcp(?:-|\/|$)/iu.test(moduleName)) return 'mcp';
  if (/(?:^|\/)console(?:\/|$)/u.test(moduleName)) return 'console';
  if (/(?:^|\/)hosts?(?:\/|$)/u.test(moduleName)) return 'host';
  if (/(?:^|\/)(?:server|schemas|error-mapper)(?:\.|\/|$)/u.test(moduleName)) return 'plugin';
  if (moduleName === '@taskshuttle/plugin' || moduleName.startsWith('@taskshuttle/plugin/')) return 'plugin';
  if (moduleName === '@taskshuttle/host-kit' || moduleName.startsWith('@taskshuttle/host-kit/')) return 'host';
  if (NODE_BUILTINS.has(moduleName)) {
    if (ALLOWED_NODE_BUILTINS.has(moduleName)) return undefined;
    if (PROCESS_BUILTINS.has(moduleName) || TRANSPORT_BUILTINS.has(moduleName)) return 'process';
    return 'filesystem';
  }
  if (/(?:^|\/)release(?:\/|$)|metadata\.json$/u.test(moduleName)) return 'release';
  if (/^(?:\.|\.\.)\//u.test(moduleName)) return 'workspace';
  return 'dependency';
};

const categoryForImport = (moduleName: string, file: string): CoreBoundaryCategory | undefined => {
  if (!/^(?:\.\.?)(?:\/|$)/u.test(moduleName)) return categoryForModule(moduleName);
  const sourceDirectory = resolve(dirname(file));
  const resolved = resolve(sourceDirectory, moduleName);
  const coreDirectories = CORE_SOURCE_ROOTS.map((directory) => resolve(directory));
  if (coreDirectories.some((directory) => resolved === directory || resolved.startsWith(`${directory}/`))) return undefined;
  return categoryForModule(moduleName) ?? 'workspace';
};

/** Analyze one Core source file against the ADR 0048 dependency boundary. */
export function analyzeCoreSource(source: string, file: string): CoreBoundaryViolation[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: CoreBoundaryViolation[] = [];
  let shadowsGlobalProcess = false;
  const findProcessBinding = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'process' && isDeclarationName(node)) shadowsGlobalProcess = true;
    ts.forEachChild(node, findProcessBinding);
  };
  findProcessBinding(sourceFile);
  const add = (category: CoreBoundaryCategory, detail: string): void => { violations.push({ category, file, detail }); };
  const visit = (node: ts.Node): void => {
    const moduleSpecifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier : undefined;
    if (moduleSpecifier !== undefined && ts.isStringLiteral(moduleSpecifier)) {
      const moduleName = moduleSpecifier.text;
      const category = categoryForImport(moduleName, file);
      if (category !== undefined) add(category, `${ts.isExportDeclaration(node) ? 'export' : 'import'} ${moduleName}`);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression)) {
      const moduleName = node.moduleReference.expression.text;
      const category = categoryForImport(moduleName, file);
      if (category !== undefined) add(category, `import-equals ${moduleName}`);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) {
        const category = categoryForImport(argument.text, file);
        if (category !== undefined) add(category, `require(${argument.text})`);
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) {
        const category = categoryForImport(argument.text, file);
        if (category !== undefined) add(category, `import(${argument.text})`);
      }
    }
    if (ts.isIdentifier(node) && node.text === 'process' && !shadowsGlobalProcess && !isDeclarationName(node)) {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression !== node) {
        ts.forEachChild(node, visit);
        return;
      }
      const property = ts.isPropertyAccessExpression(parent) ? parent.name.text : undefined;
      add(property === 'env' || property === 'cwd' || property === 'execPath' ? 'environment' : 'process', `process${property ? `.${property}` : ''}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

/** Analyze all TypeScript files below the current Core source tree. */
export function analyzeCoreTree(files: ReadonlyArray<{ file: string; source: string }>): CoreBoundaryViolation[] {
  return files.flatMap(({ file, source }) => analyzeCoreSource(source, file));
}

/** Analyze every emitted declaration for forbidden product-layer type names. */
export function analyzeCoreDeclarations(files: ReadonlyArray<{ file: string; source: string }>): Array<{ file: string; detail: string }> {
  const forbidden = /(?:\b(?:Plugin\w*|Mcp\w*|MCP\w*|Runskein\w*|runskein\w*)|@modelcontextprotocol(?:\/|\b)|@runskein\/(?:[^\s"']+)|@taskshuttle\/(?:plugin|host-kit)(?:\/|\b))/gu;
  return files.flatMap(({ file, source }) => {
    // Declaration comments are documentation, not exported type references;
    // scan the emitted syntax so a harmless explanation cannot make ARCH-002
    // report a false boundary leak.
    const declaration = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu, '');
    forbidden.lastIndex = 0;
    const matches = [...declaration.matchAll(forbidden)].map((match) => match[0]).join(', ');
    return matches.length === 0 ? [] : [{ file, detail: `forbidden declaration reference(s): ${matches}` }];
  });
}
