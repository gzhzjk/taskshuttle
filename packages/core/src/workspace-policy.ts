import { relative, resolve, win32 } from 'node:path';
import type { CoreResult } from './errors.js';

/** Pure containment decision over already-canonical paths supplied by Plugin. */
export function narrowWorkspacePath(candidate: string, allowedRoot: string, platform: 'posix' | 'win32' = 'posix'): CoreResult<string> {
  const root = platform === 'win32' ? win32.resolve(allowedRoot) : resolve(allowedRoot);
  const selected = platform === 'win32' ? win32.resolve(candidate) : resolve(candidate);
  const remainder = platform === 'win32' ? win32.relative(root, selected) : relative(root, selected);
  const absolute = platform === 'win32' ? win32.isAbsolute(remainder) : remainder.startsWith('/');
  if (remainder === '' || (!remainder.startsWith('..') && !absolute)) return { ok: true, value: selected };
  return { ok: false, error: { code: 'workspace-forbidden', message: 'workspace path is outside the allowed root' } };
}
