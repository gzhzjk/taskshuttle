import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { analyzeCoreDeclarations, analyzeCoreSource, analyzeCoreTree, CORE_SOURCE_ROOTS, PHASE0_CORE_DESTINED_FILES, PHASE0_CORE_SPLIT_FILES, TRANSITIONAL_CORE_SOURCE_FILES, type CoreBoundaryCategory, walkCoreSourceFiles } from './core-boundary-check.js';

const root = process.cwd();

async function coreSources(): Promise<Array<{ file: string; source: string }>> {
  const existingRoots: string[] = [];
  for (const relativeRoot of CORE_SOURCE_ROOTS) {
    const candidate = join(root, relativeRoot);
    if ((await stat(candidate).catch(() => undefined))?.isDirectory() === true) existingRoots.push(candidate);
  }
  if (existingRoots.length === 0) throw new Error(`ARCH-001: none of the Core source roots exist (${CORE_SOURCE_ROOTS.join(', ')})`);
  const files = (await Promise.all(existingRoots.map((directory) => walkCoreSourceFiles(directory)))).flat();
  return Promise.all(files.map(async (file) => ({ file: relative(root, file), source: await readFile(file, 'utf8') })));
}

async function transitionalCoreSources(): Promise<Array<{ file: string; source: string }>> {
  return Promise.all(TRANSITIONAL_CORE_SOURCE_FILES.map(async (file) => ({ file, source: await readFile(join(root, file), 'utf8') })));
}

async function declarationSources(directory: string): Promise<Array<{ file: string; source: string }>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await declarationSources(path)).map(({ file }) => file));
    else if (entry.isFile() && entry.name.endsWith('.d.ts')) files.push(path);
  }
  return Promise.all(files.sort().map(async (file) => ({ file: relative(root, file), source: await readFile(file, 'utf8') })));
}

describe('Phase 2 architecture gates', () => {
  it('ARCH-001: transitional Core ownership is an explicit shrinking inventory', async () => {
    const legacyRoot = join(root, 'src', 'core');
    const legacyRootStat = await stat(legacyRoot).catch(() => undefined);
    const inventoryPath = join(root, 'test', 'fixtures', 'separation', 'core-transitional-baseline.json');
    const inventory = JSON.parse(await readFile(inventoryPath, 'utf8')) as {
      phase0CoreDestined: Array<{ source: string; movedTo: string; split?: boolean; pluginRemainder?: string }>;
      ownerCorrections: Array<{ source: string; owner: 'plugin'; destination: string }>;
      pendingFiles: string[];
      phase0AnchorCount: number;
    };
    const pendingFiles = [...TRANSITIONAL_CORE_SOURCE_FILES];
    expect(inventory.phase0CoreDestined.length).toBe(inventory.phase0AnchorCount);
    const anchorSources = inventory.phase0CoreDestined.map(({ source }) => source);
    expect(anchorSources).toEqual([...PHASE0_CORE_DESTINED_FILES]);
    expect(pendingFiles.every((file) => anchorSources.includes(file)), 'pending files must remain a subset of the immutable Phase 0 Core-destined anchor').toBe(true);
    const splitSources = inventory.phase0CoreDestined.filter(({ source }) => PHASE0_CORE_SPLIT_FILES.includes(source as typeof PHASE0_CORE_SPLIT_FILES[number])).map(({ source }) => source);
    expect(splitSources).toEqual([...PHASE0_CORE_SPLIT_FILES]);
    expect(inventory.pendingFiles).toEqual([]);
    expect(pendingFiles).toEqual([]);
    const corrections = new Map(inventory.ownerCorrections.map((entry) => [entry.source, entry]));
    expect(inventory.ownerCorrections.map(({ source }) => source)).toEqual([
      'src/core/anchor-store.ts',
      'src/core/delegation-evidence.ts',
      'src/core/engine-support.ts',
      'src/core/interaction-broker.ts',
      'src/core/logger.ts',
      'src/core/nanny-snapshot.ts',
      'src/core/project-config.ts',
      'src/core/security-policy.ts',
      'src/core/transcript-page.ts',
    ]);
    const declaredDestinations = inventory.phase0CoreDestined.flatMap(({ movedTo, pluginRemainder }) => [movedTo, ...(pluginRemainder === undefined ? [] : [pluginRemainder])]);
    const correctedDestinations = new Set(inventory.ownerCorrections.map(({ destination }) => destination));
    const duplicateDestinations = [...new Set(declaredDestinations.filter((destination, index) => declaredDestinations.indexOf(destination) !== index))].sort();
    expect(duplicateDestinations).toEqual([...new Set(declaredDestinations.filter((destination, index) => correctedDestinations.has(destination) && declaredDestinations.indexOf(destination) !== index))].sort());
    const coreSourceRoot = CORE_SOURCE_ROOTS[0];
    for (const entry of inventory.phase0CoreDestined) {
      const sourceName = basename(entry.source);
      const isSplit = PHASE0_CORE_SPLIT_FILES.includes(entry.source as typeof PHASE0_CORE_SPLIT_FILES[number]);
      expect(entry.split === true).toBe(isSplit);
      const correction = corrections.get(entry.source);
      if (correction !== undefined) {
        expect(correction.destination).toBe(`packages/plugin/src/${sourceName}`);
        expect(await stat(join(root, correction.destination))).toBeDefined();
        expect(await lstat(join(root, entry.source)).catch(() => undefined)).toBeUndefined();
        if (isSplit) expect(entry.pluginRemainder).toBe(`packages/plugin/src/${sourceName}`);
        continue;
      }
      expect(entry.movedTo).toBe(`${coreSourceRoot}/${sourceName}`);
      expect(entry.pluginRemainder).toBeUndefined();
      expect(await lstat(join(root, entry.source)).catch(() => undefined), `${entry.source} cannot leave the transitional inventory while the legacy source still exists`).toBeUndefined();
      expect((await walkCoreSourceFiles(join(root, coreSourceRoot))).map((file) => relative(root, file))).toContain(entry.movedTo);
    }
    expect(legacyRootStat).toBeUndefined();
  });

  it('ARCH-001: Core source uses only the allow-listed domain boundary', async () => {
    const walkRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-core-walk-'));
    try {
      const nested = join(walkRoot, 'nested', 'deeper', 'probe.ts');
      await mkdir(dirname(nested), { recursive: true });
      await writeFile(nested, "import { spawn } from 'node:child_process';");
      expect(await walkCoreSourceFiles(walkRoot)).toEqual([nested]);
    } finally {
      await rm(walkRoot, { recursive: true, force: true });
    }
    const nestedMutation = analyzeCoreTree([{ file: 'packages/core/src/probe-sub/leak.ts', source: "import { spawn } from 'node:child_process';" }]);
    expect(nestedMutation.map((violation) => violation.category)).toEqual(['process']);
    const violations = analyzeCoreTree(await coreSources());
    expect(violations, violations.map((v) => `${v.category}: ${v.file}: ${v.detail}`).join('\n'))
      .toEqual([]);
    const transitionalViolations = analyzeCoreTree(await transitionalCoreSources());
    expect(transitionalViolations, transitionalViolations.map((v) => `${v.category}: ${v.file}: ${v.detail}`).join('\n'))
      .toEqual([]);
  });

  const mutationFixtures: Array<[CoreBoundaryCategory, string]> = [
    ['plugin', "import { createTaskShuttleServer } from '../server.js';"],
    ['mcp', "import type { McpServer } from '@modelcontextprotocol/server';"],
    ['runskein', "import type { Session } from '@runskein/core';"],
    ['host', "import { driver } from '../hosts/codex/driver.js';"],
    ['console', "import { ConsoleServer } from '../console/server.js';"],
    ['filesystem', "import { readFile } from 'node:fs/promises';"],
    ['environment', 'const cwd = process.cwd();'],
    ['process', "import { spawn } from 'node:child_process';"],
    ['release', "import metadata from '../../release/metadata.json';"],
    ['workspace', "const plugin = await import('../plugin/index.js');"],
    ['dependency', "import { z } from 'zod';"],
  ];

  for (const [category, source] of mutationFixtures) {
    it(`ARCH-001 mutation rejects ${category}`, () => {
      expect(analyzeCoreSource(source, `mutation-${category}.ts`).some((violation) => violation.category === category)).toBe(true);
    });
  }

  const reExportMutationFixtures: Array<[CoreBoundaryCategory, string]> = [
    ['plugin', "export { createTaskShuttleServer } from '../server.js';"],
    ['mcp', "export type { McpServer } from '@modelcontextprotocol/server';"],
    ['runskein', "export type { Session } from '@runskein/core';"],
    ['host', "export { driver } from '../hosts/codex/driver.js';"],
    ['console', "export { ConsoleServer } from '../console/server.js';"],
    ['filesystem', "export { readFile } from 'node:fs/promises';"],
    ['process', "export { spawn } from 'node:child_process';"],
    ['release', "export { default } from '../../release/metadata.json';"],
    ['workspace', "export { plugin } from '../plugin/index.js';"],
    ['dependency', "export { z } from 'zod';"],
  ];

  for (const [category, source] of reExportMutationFixtures) {
    it(`ARCH-001 mutation rejects ${category} re-export`, () => {
      expect(analyzeCoreSource(source, `mutation-export-${category}.ts`).some((violation) => violation.category === category)).toBe(true);
    });
  }

  it('ARCH-001 mutation rejects require', () => {
    expect(analyzeCoreSource("const session = require('@runskein/core');", 'mutation-require.ts')).toEqual([
      { category: 'runskein', file: 'mutation-require.ts', detail: 'require(@runskein/core)' },
    ]);
  });

  it('ARCH-001 mutation rejects dynamic import', () => {
    expect(analyzeCoreSource("const server = await import('@modelcontextprotocol/server');", 'mutation-dynamic-import.ts')).toEqual([
      { category: 'mcp', file: 'mutation-dynamic-import.ts', detail: 'import(@modelcontextprotocol/server)' },
    ]);
  });

  it('ARCH-001 mutation rejects unallowlisted Node built-ins but permits the reviewed pure list', () => {
    expect(analyzeCoreSource("import { join } from 'node:path';", 'mutation-allowed-path.ts')).toEqual([]);
    expect(analyzeCoreSource("import { request } from 'node:http';", 'mutation-transport.ts')).toHaveLength(1);
    expect(analyzeCoreSource("import { readFile } from 'node:fs/promises';", 'mutation-filesystem.ts')).toHaveLength(1);
    expect(analyzeCoreSource('const record = { process: 1 };', 'mutation-property-name.ts')).toEqual([]);
    expect(analyzeCoreSource('const process = { value: 1 }; process.value;', 'mutation-shadowed-process.ts')).toEqual([]);
  });

  it('ARCH-002: emitted Core declarations and exports contain no Plugin/MCP/Runskein types', async () => {
    const packageRoot = join(root, 'packages', 'core');
    const packageStat = await stat(packageRoot).catch(() => undefined);
    expect(packageStat?.isDirectory(), 'packages/core must exist before emitted declaration checks can run').toBe(true);
    const declarationRoot = join(packageRoot, 'dist');
    const declarationStat = await stat(declarationRoot).catch(() => undefined);
    expect(declarationStat?.isDirectory(), 'packages/core/dist must exist before emitted declaration checks can run').toBe(true);
    const declarations = await declarationSources(declarationRoot);
    expect(declarations.length, 'the Core package must emit at least one declaration').toBeGreaterThan(0);
    const violations = analyzeCoreDeclarations(declarations);
    expect(violations, violations.map((violation) => `${violation.file}: ${violation.detail}`).join('\n')).toEqual([]);
  });

  it('ARCH-002 mutation rejects a leaked type in a non-entry declaration', () => {
    const violations = analyzeCoreDeclarations([{ file: 'mutation/leaked.d.ts', source: "export type Leaked = import('@runskein/core').Session;" }]);
    expect(violations).toHaveLength(1);
    expect(analyzeCoreDeclarations([{ file: 'mutation/reexport.d.ts', source: "export { Session } from 'runskein';" }])).toHaveLength(1);
  });

  it('ARCH-002 mutations reject Plugin and MCP declaration references', () => {
    expect(analyzeCoreDeclarations([{ file: 'mutation/plugin.d.ts', source: 'export type Leaked = import("../packages/plugin/src/error-mapper.js").PluginError;' }])).toHaveLength(1);
    expect(analyzeCoreDeclarations([{ file: 'mutation/mcp.d.ts', source: 'export type Leaked = import("@modelcontextprotocol/sdk").McpServer;' }])).toHaveLength(1);
  });
});
