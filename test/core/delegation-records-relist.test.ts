// SEC-REC-023, the fourth fixture (ADR 0033): the re-listing's own failure.
// It lives in its own file because both listings read one directory, so the
// failure can only be staged by mocking `readdir` — and a module mock is
// file-wide, which would silently rewrite every other case in the suite.
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  let listings = 0;
  return {
    ...actual,
    readdir: (...args: Parameters<typeof actual.readdir>) => {
      listings += 1;
      // The first listing must succeed: a scan that never enumerates at all
      // would doubt for the wrong reason and the case would prove nothing.
      if (listings > 1) return Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }));
      return (actual.readdir as (...a: Parameters<typeof actual.readdir>) => Promise<unknown>)(...args);
    },
  };
});

const { readInstanceRecords } = await import('../../packages/plugin/src/delegation-evidence.js');
// The real type, so the case cannot drift from the shape the module publishes.
type Diagnostics = import('../../packages/plugin/src/delegation-evidence.js').DelegationDiagnostics;

describe('SEC-REC-023: the re-listing itself fails', () => {
  it('doubts, and names the enumeration', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'taskshuttle-delegation-relist-'));
    // A directory holding neither file: the entry is listed, its manifest is
    // gone, and resolving it needs the second listing that will fail.
    await mkdir(join(dataRoot, 'instances', 'gone-one'), { recursive: true });

    const diagnostics: Diagnostics = {};
    expect(await readInstanceRecords(dataRoot, diagnostics)).toBeUndefined();
    expect(diagnostics.cause).toBe('scan-enumeration');
  });
});
