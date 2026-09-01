import { describe, expect, it, vi } from 'vitest';

// SEC-CWD-019. The dev/ino recheck cannot be driven by a real filesystem
// without racing for it, and a test that races is a test that flakes. The
// filesystem is faked instead, so the swap happens exactly between the two
// readings the recheck compares — which is the only moment that matters.
const state = {
  entryLookedUp: false,
  swapWhenTheEntryIsLookedUp: false,
};

vi.mock('node:fs/promises', () => {
  // Node names the failing syscall in the message and carries the errno in
  // `code`; the classifier reads `code`, and getting the shape right keeps the
  // fake honest about what it is standing in for.
  const errnoError = (code: string, syscall: string, path: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`${code}: no such file or directory, ${syscall} '${path}'`), { code, syscall, path });
  const dir = (dev: number, ino: number) => ({ dev, ino, isDirectory: () => true, isSymbolicLink: () => false });
  return {
    lstat: async (path: string) => {
      if (path === '/root') return dir(1, 10);
      // Only the entry the caller actually named is absent. Anything else is a
      // directory, so a mutant that looks up the wrong basename gets a clean
      // answer and fails the case — the ordering fixture must also pin *what*
      // is looked up, not only when.
      if (path !== '/root/missing') return dir(1, 11);
      // The swap is triggered *by the entry lookup*, not by a call count. That
      // is the whole point: a mutant that takes both parent readings before
      // this line sees an unchanged inode and must answer INVALID_ARGUMENT.
      state.entryLookedUp = true;
      throw errnoError('ENOENT', 'lstat', path);
    },
    realpath: async (path: string) => {
      if (path === '/root') return '/root';
      throw errnoError('ENOENT', 'realpath', path);
    },
    stat: async (path: string) => {
      if (path !== '/root') throw errnoError('ENOENT', 'stat', path);
      // The parent is a different directory once the entry has been looked up.
      return state.swapWhenTheEntryIsLookedUp && state.entryLookedUp ? dir(1, 99) : dir(1, 10);
    },
  };
});

const { CWD_DENIED, SecurityPolicy, SecurityPolicyError, readDelegationIdentity } = await import('../../packages/plugin/src/security-policy.js');

describe('SEC-CWD-019: the parent identity is rechecked after the entry lookup', () => {
  // Two mutations must go red here: dropping the recheck, and taking both
  // parent readings before the entry lookup. The second is why the fake keys
  // its swap on the lookup rather than on a call count — a counter is
  // satisfied by any two stats, in any position.
  async function refuse(swap: boolean): Promise<{ code: string; message: string }> {
    state.entryLookedUp = false;
    state.swapWhenTheEntryIsLookedUp = false;
    const policy = await SecurityPolicy.create({ allowedRoots: ['/root'], identity: readDelegationIdentity({}) });
    state.swapWhenTheEntryIsLookedUp = swap;
    try {
      await policy.resolveCwd('/root/missing');
      throw new Error('expected a refusal');
    } catch (cause) {
      if (!(cause instanceof SecurityPolicyError)) throw cause;
      return { code: cause.code, message: cause.message };
    }
  }

  it('names the absent entry when the parent is unchanged', async () => {
    expect(await refuse(false)).toEqual({ code: 'INVALID_ARGUMENT', message: 'cwd does not exist' });
  });

  it('withholds it when the parent was replaced between the readings', async () => {
    // Dropping the recheck turns this back into INVALID_ARGUMENT, which is the
    // withheld bit: the lookup observed a path the containment decision never
    // approved.
    expect(await refuse(true)).toEqual({ code: 'PERMISSION_DENIED', message: CWD_DENIED });
  });
});
