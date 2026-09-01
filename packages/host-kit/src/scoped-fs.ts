import { chmod, cp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** A canonical root granted to one host operation. */
export interface ScopedRoot {
  readonly kind: 'repository' | 'host' | 'output' | 'managed' | 'home';
  readonly path: string;
}

/** Build an immutable root descriptor after canonicalizing the directory. */
export async function scopedRoot(kind: ScopedRoot['kind'], path: string): Promise<ScopedRoot> {
  const canonical = await realpath(path);
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error(`scoped root is not a directory: ${path}`);
  return Object.freeze({ kind, path: canonical });
}

async function canonicalTarget(root: ScopedRoot, child: string, allowMissing: boolean): Promise<string> {
  if (typeof child !== 'string' || child.length === 0 || isAbsolute(child) || child.includes('\0') || child.includes('\\')) throw new Error(`unsafe scoped path '${child}'`);
  const target = resolve(root.path, child);
  const suffix: string[] = [];
  let cursor = target;
  let canonicalBase: string;
  while (true) {
    try {
      canonicalBase = await realpath(cursor);
      break;
    } catch (cause) {
      if (!allowMissing || (cause as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(cursor) === cursor) throw cause;
      suffix.push(cursor.slice(dirname(cursor).length + 1));
      cursor = dirname(cursor);
    }
  }
  const canonical = join(canonicalBase, ...suffix.reverse());
  const rel = relative(root.path, canonical);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`scoped path escapes ${root.kind} root: ${child}`);
  return canonical;
}

/** Filesystem operations restricted to a canonical root and relative child path. */
export class ScopedFilesystem {
  constructor(readonly root: ScopedRoot) {}

  async readFile(path: string): Promise<Buffer> {
    return readFile(await canonicalTarget(this.root, path, false));
  }

  async readText(path: string): Promise<string> {
    return readFile(await canonicalTarget(this.root, path, false), 'utf8');
  }

  async writeFile(path: string, contents: string | Uint8Array, mode?: number): Promise<void> {
    const target = await canonicalTarget(this.root, path, true);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, contents, mode === undefined ? undefined : { mode });
  }

  async ensureDirectory(path: string, mode = 0o700): Promise<void> {
    const target = await canonicalTarget(this.root, path, true);
    await mkdir(target, { recursive: true, mode });
    await chmod(target, mode);
  }

  async list(path = '.'): Promise<readonly string[]> {
    const target = await canonicalTarget(this.root, path, false);
    return (await readdir(target, { withFileTypes: true }))
      .filter((entry) => entry.name !== '.' && entry.name !== '..')
      .map((entry) => entry.name)
      .sort();
  }

  async copy(source: ScopedFilesystem, sourcePath: string, targetPath: string): Promise<void> {
    const from = await canonicalTarget(source.root, sourcePath, false);
    const to = await canonicalTarget(this.root, targetPath, true);
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true });
  }

  async remove(path: string, options: { missingOk?: boolean } = {}): Promise<void> {
    const target = await canonicalTarget(this.root, path, options.missingOk === true);
    await rm(target, { recursive: true, force: true });
  }
}
