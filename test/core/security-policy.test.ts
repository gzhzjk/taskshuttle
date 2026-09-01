import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CWD_DENIED,
  DELEGATION_ENV,
  SecurityPolicy,
  SecurityPolicyError,
  assertSessionCreationAllowed,
  createWorkerEnvironment,
  isContainedPath,
  readDelegationIdentity,
  validateMcpSelection,
} from '../../packages/plugin/src/security-policy.js';

describe('security policy', () => {
  it('treats a fully absent marker as depth zero and injects an explicit child marker', () => {
    const identity = readDelegationIdentity({});
    expect(identity.depth).toBe(0);
    expect(identity.rootNonce.length).toBeGreaterThanOrEqual(32);
    expect(identity.rootNonce).not.toBe(identity.rootNonceHash);
    const child = createWorkerEnvironment({ FOO: 'bar' }, identity);
    expect(child[DELEGATION_ENV.version]).toBe('1');
    expect(child[DELEGATION_ENV.depth]).toBe('1');
    expect(child[DELEGATION_ENV.root]).toBe(identity.rootNonce);
  });

  it('fails closed for partial and malformed markers and denies nested creation', () => {
    expect(() => readDelegationIdentity({ REALM_DELEGATION_VERSION: '1' })).toThrow(SecurityPolicyError);
    expect(() => readDelegationIdentity({ REALM_DELEGATION_VERSION: '2', REALM_DELEGATION_DEPTH: '1', REALM_DELEGATION_ROOT: 'a'.repeat(32) })).toThrow(SecurityPolicyError);
    expect(() => readDelegationIdentity({ REALM_DELEGATION_VERSION: '1', REALM_DELEGATION_DEPTH: '0', REALM_DELEGATION_ROOT: 'a'.repeat(32) })).toThrow(/depth is invalid/);
    expect(() => readDelegationIdentity({ REALM_DELEGATION_VERSION: '1', REALM_DELEGATION_DEPTH: '2000', REALM_DELEGATION_ROOT: 'a'.repeat(32) })).toThrow(/depth is invalid/);
    const nested = readDelegationIdentity({ REALM_DELEGATION_VERSION: '1', REALM_DELEGATION_DEPTH: '1', REALM_DELEGATION_ROOT: 'a'.repeat(32) });
    expect(() => assertSessionCreationAllowed(nested)).toThrow(/nested/);
  });

  it('merges old/new marker tuples fail-closed at the deeper depth', () => {
    const base = { TASKSHUTTLE_DELEGATION_VERSION: '1', TASKSHUTTLE_DELEGATION_DEPTH: '2', TASKSHUTTLE_DELEGATION_ROOT: 'a'.repeat(32), REALM_DELEGATION_VERSION: '1', REALM_DELEGATION_DEPTH: '5', REALM_DELEGATION_ROOT: 'b'.repeat(32) };
    expect(readDelegationIdentity(base)).toMatchObject({ depth: 5, recursionDenied: true, rootNonce: 'b'.repeat(32) });
    expect(readDelegationIdentity({ TASKSHUTTLE_DELEGATION_VERSION: '1', REALM_DELEGATION_VERSION: '1', REALM_DELEGATION_DEPTH: '3', REALM_DELEGATION_ROOT: 'b'.repeat(32) })).toMatchObject({ depth: 3, recursionDenied: true });
    expect(readDelegationIdentity({ TASKSHUTTLE_DELEGATION_VERSION: '1', TASKSHUTTLE_DELEGATION_DEPTH: '5', REALM_DELEGATION_VERSION: '1', REALM_DELEGATION_DEPTH: '1', REALM_DELEGATION_ROOT: 'b'.repeat(32) })).toMatchObject({ depth: 5, recursionDenied: true, rootNonce: 'b'.repeat(32) });
  });

  it('contains cwd by components and catches replacement before spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskshuttle-security-'));
    const child = join(root, 'child'); await mkdir(child);
    const policy = await SecurityPolicy.create({ allowedRoots: [root], identity: readDelegationIdentity({}) });
    const snapshot = await policy.resolveCwd(child);
    await policy.verifyCwdBeforeSpawn(snapshot);
    const sibling = await mkdtemp(join(tmpdir(), 'taskshuttle-sibling-'));
    await expect(policy.resolveCwd(sibling)).rejects.toThrow(SecurityPolicyError);
    const outside = await mkdtemp(join(tmpdir(), 'taskshuttle-outside-'));
    await symlink(outside, join(root, 'escape'));
    await expect(policy.resolveCwd(join(root, 'escape'))).rejects.toThrow(SecurityPolicyError);
    await writeFile(join(child, 'sentinel'), 'ok');
  });

  // ADR 0027 decisions 4-6. Every case below names the mutation it must catch,
  // because the property they defend — a path resolving outside the roots
  // discloses nothing about presence, type or reason — is passed by an
  // implementation that decides containment lexically, and that was this
  // record's own first draft.
  describe('classifies an unusable cwd without disclosing what is outside the roots', () => {
    async function policyWithRoot(): Promise<{ policy: SecurityPolicy; root: string }> {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'taskshuttle-cwd-')));
      return { policy: await SecurityPolicy.create({ allowedRoots: [root], identity: readDelegationIdentity({}) }), root };
    }
    async function refusal(call: Promise<unknown>): Promise<{ code: string; message: string }> {
      try {
        await call;
        throw new Error('expected a refusal');
      } catch (cause) {
        if (!(cause instanceof SecurityPolicyError)) throw cause;
        return { code: cause.code, message: cause.message };
      }
    }

    it('SEC-CWD-014: names an absent final component inside a root, and says nothing when the parent is absent too', async () => {
      const { policy, root } = await policyWithRoot();
      expect(await refusal(policy.resolveCwd(join(root, 'missing')))).toEqual({ code: 'INVALID_ARGUMENT', message: 'cwd does not exist' });
      // The parent's absence must not be reported: distinguishing "your parent
      // is also missing" from "your parent is outside the roots" is the oracle.
      expect(await refusal(policy.resolveCwd(join(root, 'missing', 'child')))).toEqual({ code: 'PERMISSION_DENIED', message: CWD_DENIED });
    });

    it('SEC-CWD-015: says nothing about a path that is absent and outside every root', async () => {
      const { policy } = await policyWithRoot();
      const outside = await realpath(await mkdtemp(join(tmpdir(), 'taskshuttle-outside-')));
      expect(await refusal(policy.resolveCwd(join(outside, 'missing')))).toEqual({ code: 'PERMISSION_DENIED', message: CWD_DENIED });
    });

    it('SEC-CWD-016: refuses a path under a parent symlinked out of the roots', async () => {
      const { policy, root } = await policyWithRoot();
      const outside = await realpath(await mkdtemp(join(tmpdir(), 'taskshuttle-outside-')));
      await symlink(outside, join(root, 'link'));
      // Lexically inside, resolves outside. A lexical containment test answers
      // INVALID_ARGUMENT here and reports on the filesystem it must not.
      expect(await refusal(policy.resolveCwd(join(root, 'link', 'missing')))).toEqual({ code: 'PERMISSION_DENIED', message: CWD_DENIED });
    });

    it('SEC-CWD-017: refuses an unresolvable intermediate component and a dangling final link', async () => {
      const { policy, root } = await policyWithRoot();
      await symlink(join(root, 'nowhere'), join(root, 'dangling'));
      // Walking past the dangling link to a "nearest existing ancestor"
      // rebuilds the oracle one level up.
      expect(await refusal(policy.resolveCwd(join(root, 'dangling', 'missing')))).toEqual({ code: 'PERMISSION_DENIED', message: CWD_DENIED });
      expect(await refusal(policy.resolveCwd(join(root, 'dangling')))).toEqual({ code: 'PERMISSION_DENIED', message: CWD_DENIED });
    });

    it('SEC-CWD-018: separates a non-directory parent from absence, and fails closed on EACCES', async () => {
      const { policy, root } = await policyWithRoot();
      await writeFile(join(root, 'file'), 'x');
      // lstat gives ENOTDIR, not ENOENT; folding it into absence is the bug.
      expect(await refusal(policy.resolveCwd(join(root, 'file', 'child')))).toEqual({ code: 'INVALID_ARGUMENT', message: 'cwd is not a directory' });
      const sealed = join(root, 'sealed');
      await mkdir(sealed);
      await mkdir(join(sealed, 'inner'));
      await chmod(sealed, 0o000);
      try {
        // Access denied means the plugin could not look. A boundary that
        // guesses under that condition is not a boundary.
        expect(await refusal(policy.resolveCwd(join(sealed, 'inner')))).toEqual({ code: 'PERMISSION_DENIED', message: CWD_DENIED });
      } finally {
        await chmod(sealed, 0o700);
      }
    });

    it('SEC-CWD-021: names a regular file inside a root and says nothing about one outside', async () => {
      const { policy, root } = await policyWithRoot();
      await writeFile(join(root, 'plain'), 'x');
      // The success path: both syscalls succeed. Folding this back into the
      // containment throw is what round 3 of the review caught.
      expect(await refusal(policy.resolveCwd(join(root, 'plain')))).toEqual({ code: 'INVALID_ARGUMENT', message: 'cwd is not a directory' });
      const outside = await realpath(await mkdtemp(join(tmpdir(), 'taskshuttle-outside-')));
      await writeFile(join(outside, 'plain'), 'x');
      expect(await refusal(policy.resolveCwd(join(outside, 'plain')))).toEqual({ code: 'PERMISSION_DENIED', message: CWD_DENIED });
    });

    it('SEC-CWD-022: refuses a root deleted after the policy was created, without special-casing it', async () => {
      const { policy, root } = await policyWithRoot();
      await rm(root, { recursive: true, force: true });
      // Answering INVALID_ARGUMENT here would be an allowed-root membership
      // oracle: every other absent outside path answers PERMISSION_DENIED.
      expect(await refusal(policy.resolveCwd(root))).toEqual({ code: 'PERMISSION_DENIED', message: CWD_DENIED });
    });

    it('SEC-CWD-020: refuses a snapshot whose cwd vanished, as the world changing rather than bad input', async () => {
      const { policy, root } = await policyWithRoot();
      const child = join(root, 'child');
      await mkdir(child);
      const snapshot = await policy.resolveCwd(child);
      await rm(child, { recursive: true, force: true });
      expect(await refusal(policy.verifyCwdBeforeSpawn(snapshot))).toEqual({ code: 'PERMISSION_DENIED', message: 'cwd disappeared before worker spawn' });
    });

    // SEC-CWD-020 is deliberately outside this set: `verifyCwdBeforeSpawn`
    // runs against a path already shown to be inside a root, so its distinct
    // messages describe something the caller is entitled to know and disclose
    // nothing about what lies outside the boundary.
    it('SEC-CWD-023: gives every resolveCwd denial one identical message', async () => {
      const { policy, root } = await policyWithRoot();
      const outside = await realpath(await mkdtemp(join(tmpdir(), 'taskshuttle-outside-')));
      await symlink(outside, join(root, 'link'));
      await symlink(join(root, 'nowhere'), join(root, 'dangling'));
      const denials = await Promise.all([
        refusal(policy.resolveCwd(join(root, 'missing', 'child'))),
        refusal(policy.resolveCwd(join(outside, 'missing'))),
        refusal(policy.resolveCwd(join(root, 'link', 'missing'))),
        refusal(policy.resolveCwd(join(root, 'dangling'))),
        refusal(policy.resolveCwd(outside)),
      ]);
      // Per-case assertions cannot catch a divergence; only an identity check
      // across the set can. One code with several messages withholds nothing.
      expect(new Set(denials.map((denial) => denial.message))).toEqual(new Set([CWD_DENIED]));
      expect(new Set(denials.map((denial) => denial.code))).toEqual(new Set(['PERMISSION_DENIED']));
    });
  });

  it('allows only catalog IDs and rejects Realm aliases/raw catalog values', () => {
    const catalog = {
      docs: { id: 'docs', transport: 'stdio' as const, startupTimeoutMs: 1_000, connectionTimeoutMs: 1_000, permissionDescription: 'read docs' },
    };
    expect(() => validateMcpSelection(['docs'], catalog)).not.toThrow();
    expect(() => validateMcpSelection(['realm-plugin'], { ...catalog, 'realm-plugin': { ...catalog.docs, id: 'realm-plugin' } })).toThrow(SecurityPolicyError);
    // ADR 0041: the dependency renamed, so `runskein` is now a name a caller
    // could register an MCP server under to impersonate the runtime. The alias
    // set grows rather than moves — `realm-node` is still refused, because a
    // name that stops being ours does not stop being confusable. This is the
    // one security boundary the rename moves, and it moves outward.
    // Both names, and the duplicate that hid the damage is why this list is
    // written out rather than derived: when step 10's rename turned the code's
    // `'realm-node'` into `'runskein'`, it turned this line into
    // `['runskein', 'runskein', …]` too, and the case went on passing.
    for (const alias of ['runskein', 'realm-node', 'realm', 'realm-agent-plugin', 'taskshuttle']) {
      expect(() => validateMcpSelection([alias], { ...catalog, [alias]: { ...catalog.docs, id: alias } })).toThrow(SecurityPolicyError);
    }
    expect(() => validateMcpSelection(['unknown'], catalog)).toThrow(/unknown/);
    expect(() => validateMcpSelection(Array.from({ length: 9 }, (_, i) => `x${i}`), catalog)).toThrow(/eight/);
    expect(() => validateMcpSelection(['docs'], { docs: { ...catalog.docs, command: 'sh' } as never })).toThrow(/raw MCP/);
  });

  it('uses component-aware Windows containment semantics', () => {
    expect(isContainedPath('C:\\root\\child', 'C:\\root', 'win32')).toBe(true);
    expect(isContainedPath('C:\\root2', 'C:\\root', 'win32')).toBe(false);
    expect(isContainedPath('C:\\outside', 'C:\\root', 'win32')).toBe(false);
  });
});
