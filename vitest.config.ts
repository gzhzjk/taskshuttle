import { defineConfig } from 'vitest/config';

/**
 * The suite is the explicit set of current and future package test roots.
 *
 * Without this, vitest's default include walks the whole tree. Git worktrees
 * live under `.worktree/` and git hides them from `git status` because it knows
 * they are checkouts of the same repository — vitest does not, so it collected
 * every test twice and reported a total that mixed two branches. A worktree
 * holding work in progress could therefore turn `pnpm test` red on a checkout
 * whose own tests all pass, which is worse than slow.
 *
 * `vendor/` is excluded for the same reason with a different owner: Realm's own
 * suite is not ours to run or to gate on. What we depend on from it is asserted
 * by our tests and by the artifact gate's vendored digest.
 */
export default defineConfig({
  test: {
    // Keep these roots explicit. Widening to `**/*.test.ts` would collect tests
    // from linked worktrees and generated/vendor trees before the collection
    // guard can report which checkout they belong to.
    include: [
      'test/**/*.test.ts',
      'packages/core/test/**/*.test.ts',
      'packages/plugin/test/**/*.test.ts',
      'packages/host-kit/test/**/*.test.ts',
    ],
    // Vitest's default is 5s, and several cases legitimately need most of it.
    // The tests that start a plugin run against a *real* Realm hub with
    // scripted adapters, and shutdown carries a 3s deadline (`hub.quit`), paid
    // per case in `afterEach`: engine-admission cases measure 3.2-3.7s on this
    // machine and the runtime ones 1.4s. That left barely a second of headroom,
    // and CI — slower, and running files in parallel — crossed it and failed
    // two unrelated files with timeouts on the same run.
    //
    // The number is margin over a measured worst case, not a guess, and it is
    // deliberately not a fix for a hang: nothing here waits on an event that
    // may never arrive. If a case ever approaches this, the shutdown path is
    // the thing to look at, not this line.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    exclude: [
      '**/node_modules/**',
      'dist/**',
      'packages/*/dist/**',
      'vendor/**',
      '.worktree/**',
      'hosts/*/dist/**',
    ],
  },
});
