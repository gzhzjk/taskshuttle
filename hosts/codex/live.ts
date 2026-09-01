import type { HostProbeCase, HostProbeContext } from '../../scripts/live/host-probes.js';

/** Run Codex's operator-confirmed three-state hook check from this host's owner directory. */
const trustCase: HostProbeCase = {
  id: 'HOST-CODEX-003',
  title: 'Codex hook trust three-state: feature off, untrusted, trusted',
  async run(context) {
    const installed = context.cliVersion('codex');
    if (installed === 'not-installed') return { status: 'na', reason: 'the Codex CLI is not installed on this machine' };
    const reported = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/u.exec(installed)?.[0];
    const baseline = context.hostBaselines['codex'] ?? '';
    const evidence = { cli: installed, baseline, matchesBaseline: reported === baseline };
    if (!context.confirmed.has('codex-hooks')) {
      return {
        status: 'manual-pending',
        reason: [
          'mutates the operator\'s Codex configuration; run the three states then re-run with --confirm=codex-hooks:',
          '1. `[features] hooks = false` in CODEX_HOME/config.toml → stop a session → the hook must not run and the session must end normally',
          '2. hooks enabled but this hook not trusted (no hooks.state."…".trusted_hash entry) → same silence',
          '3. hooks enabled and the hook trusted → a stop with unfinished work (an anchor is enough; it needs no engine) must block once, and the model must act on the reason',
          'confirm with --codex-trust=persisted (Codex recorded a trusted_hash entry) or --codex-trust=bypassed (--dangerously-bypass-hook-trust)',
          `state the Codex version the run used; the recorded baseline is ${baseline}`,
        ].join(' | '),
        evidence,
      };
    }
    if (reported !== baseline) throw new Error(`confirmed on codex ${reported ?? installed} but release/metadata.json records the baseline as ${baseline}; raise the baseline or run against it`);
    if (context.codexTrust !== 'persisted' && context.codexTrust !== 'bypassed') throw new Error('confirming HOST-CODEX-003 requires --codex-trust=persisted or --codex-trust=bypassed; state 3 means something different in each case');
    const reason = context.codexTrust === 'persisted'
      ? 'confirmed by the operator; state 3 ran against a persisted trusted_hash entry'
      : 'confirmed by the operator; state 3 ran with --dangerously-bypass-hook-trust, which exercises the enabled-and-trusted branch but leaves trust persistence unverified';
    return { status: 'pass', reason, evidence: { ...evidence, trust: context.codexTrust } };
  },
};

export default [trustCase] satisfies readonly HostProbeCase[];
