import { resolve } from 'node:path';
import { defineConfig } from 'tsup';

const packageRoot = resolve(import.meta.dirname);

/** Build the existing Plugin entry points into the package-owned dist tree. */
export default defineConfig({
  entry: {
    index: resolve(packageRoot, 'src/index.ts'),
    cli: resolve(packageRoot, 'src/cli.ts'),
    launch: resolve(packageRoot, 'src/launch.ts'),
    nanny: resolve(packageRoot, 'src/nanny.ts'),
  },
  outDir: resolve(packageRoot, 'dist'),
  format: ['esm'],
  minify: true,
  external: ['sqlite3'],
  // Core is private and must be bundled into the public Plugin artifact; an
  // unresolved workspace specifier would make a clean install depend on a
  // package that is not published.
  // The public package has no runtime dependencies: every workspace and
  // registry dependency is inlined into the bundle. Keep the patterns broad
  // enough to cover transitive Runskein/MCP imports when an adapter adds one.
  noExternal: [
    /^@taskshuttle\/core(?:\/|$)/,
    /^@runskein\//,
    /^runskein(?:\/|$)/,
    /^@modelcontextprotocol\//,
    /^zod(?:\/|$)/,
  ],
  clean: true,
  metafile: true,
});
