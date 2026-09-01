import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { artifactDigest, buildReport, caseForThrow, exemptedEngines, exitCodeFor, MidRunRefusal, preRunExemption, preRunExemptionFor, refuseIfClassified, renderReport, classifiedRefusal, validateReport, writeReport, type CaseResult } from '../../scripts/live/evidence.js';

const passing: CaseResult = { id: 'ENG-CODEX-001', title: 'round trip', status: 'pass', evidence: { sessionId: 's1', turnIds: ['t1', 't2'] } };

function report(cases: CaseResult[], simulated = true) {
  return buildReport({ gate: 'engine', runId: 'run-1', startedAt: '2026-01-01T00:00:00.000Z', simulated, cases, cliVersions: { codex: 'simulated' } });
}

describe('gate evidence', () => {
  it('carries the provenance §1.7 requires', () => {
    const built = report([passing]);
    expect(built.provenance.realmVersion).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    expect(built.provenance.wrappers).toMatchObject({ 'codex-acp': expect.any(String) });
    expect(built.provenance.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(built.provenance.hostBaselines['codex']).toBeDefined();
    expect(built.environment.node).toBe(process.version);
    expect(validateReport(built)).toEqual([]);
  });

  it('refuses a report whose non-pass cases give no reason', () => {
    const problems = validateReport(report([passing, { id: 'ENG-KIMI-001', title: 'round trip', status: 'na' }]));
    expect(problems).toContain('case ENG-KIMI-001 is na without a reason');
    // An unexplained N/A must not be publishable, whatever the summary says.
    expect(exitCodeFor(report([passing]), problems)).toBe(1);
  });

  it('fails the run on a failed case and passes with explained N/A', () => {
    const failed = report([{ id: 'ENG-CODEX-001', title: 'round trip', status: 'fail', reason: 'engine never replied' }]);
    expect(exitCodeFor(failed, validateReport(failed))).toBe(1);
    const explained = report([passing, { id: 'HOST-KIMI-002', title: 'project scope', status: 'na', reason: 'the host does not support it' }]);
    expect(exitCodeFor(explained, validateReport(explained))).toBe(0);
  });

  it('states in the rendered report whether engines were simulated', () => {
    expect(renderReport(report([passing], true))).toContain('**simulated engines**');
    expect(renderReport(report([passing], false))).toContain('live engines');
    expect(renderReport(report([passing]))).toContain('ENG-CODEX-001');
  });

  it('writes both machine- and human-readable evidence with private modes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'taskshuttle-gate-report-'));
    try {
      const built = report([passing]);
      const written = await writeReport(built, directory);
      expect(JSON.parse(await readFile(written.json, 'utf8'))).toMatchObject({ gate: 'engine', runId: 'run-1' });
      expect(await readFile(written.markdown, 'utf8')).toContain('# engine gate — run-1');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('digests the built runtime entries so a report names the artifact it exercised', () => {
    expect(artifactDigest()).toMatch(/^[a-f0-9]{64}$/);
    expect(artifactDigest('/nonexistent')).toMatch(/^[a-f0-9]{64}$/);
    expect(artifactDigest()).not.toBe(artifactDigest('/nonexistent'));
  });

  // ADR 0011 guardrail 1. The criterion is Realm's classification, not the
  // gate's own text matching — and the two-way test is the only thing that
  // proves the criterion actually moved.
  describe('the mid-run refusal criterion', () => {
    it('classifies by cause even when the message never says "auth"', () => {
      const refusal = classifiedRefusal({
        code: 'ENGINE_ERROR',
        message: 'quota exhausted for this account',
        cause: { name: 'UnauthenticatedError', message: 'quota exhausted for this account', operation: 'turn/run' },
      });
      // The old criterion, /auth/iu over the message, would have said FAIL here.
      expect(refusal).toEqual({ message: 'quota exhausted for this account', classification: 'unauthenticated' });
    });

    it('does not classify by message when the cause is something else', () => {
      const refusal = classifiedRefusal({
        code: 'ENGINE_ERROR',
        message: 'cannot read /etc/authorized_keys',
        cause: { name: 'EngineOperationError', message: 'cannot read /etc/authorized_keys', operation: 'turn/run' },
      });
      // The old criterion would have matched "author…" and recorded N/A.
      expect(refusal).toBeUndefined();
    });

    it('reports what the engine said, not a summary of it', () => {
      const message = "engine 'kimi' is not authenticated \u2014 try: kimi acp --login";
      expect(classifiedRefusal({ code: 'ENGINE_ERROR', message, cause: { name: 'UnauthenticatedError', message, operation: 'turn/run' } })?.message).toBe(message);
    });

    // ADR 0029: upstream classifies a spent quota as rate-limit, so the
    // exemption must recognise that form too — or it stops matching the very
    // failure ADR 0011 exists for, silently, on the next Realm upgrade.
    it('classifies a rate-limited engine, which no longer arrives as UnauthenticatedError', () => {
      const message = "engine 'kimi' operation 'session/prompt' failed";
      expect(classifiedRefusal({
        code: 'ENGINE_ERROR',
        message,
        cause: { name: 'EngineOperationError', message, operation: 'turn/run', kind: 'rate-limit' },
      })).toEqual({ message, classification: 'rate-limit' });
    });

    it('requires the name beside the kind, and exempts no other kind', () => {
      const message = 'engine refused';
      // Parsed JSON: `instanceof` is unavailable here, so a bare `kind` check
      // would accept anything shaped like one.
      expect(classifiedRefusal({
        code: 'ENGINE_ERROR',
        message,
        cause: { name: 'SomethingElse', message, kind: 'rate-limit' },
      })).toBeUndefined();
      // An unclassified refusal carries no kind and is a failure, not an exemption.
      for (const kind of ['timeout', 'context-exceeded', 'internal', undefined]) {
        expect(classifiedRefusal({
          code: 'ENGINE_ERROR',
          message,
          cause: { name: 'EngineOperationError', message, ...(kind === undefined ? {} : { kind }) },
        })).toBeUndefined();
      }
    });

    it.each([
      ['no cause at all', { code: 'ENGINE_ERROR', message: 'not authenticated' }],
      ['a null cause', { code: 'ENGINE_ERROR', message: 'not authenticated', cause: null }],
      ['a cause with no name', { code: 'ENGINE_ERROR', message: 'not authenticated', cause: { message: 'not authenticated' } }],
      ['nothing', undefined],
    ])('treats %s as not a refusal', (_label, error) => {
      expect(classifiedRefusal(error)).toBeUndefined();
    });
  });

  // ADR 0011 guardrail 4. A run that exempted its way to green must not
  // exit zero, and the pass count cannot be the predicate: cap and fork run
  // no turn, int is always na live, so passes survive an unusable engine.
  describe('a run that verified nothing', () => {
    const exempt = (id: string, roundTrip = false): CaseResult => ({ id, title: 'round trip', status: 'na', reason: "engine 'kimi' is not authenticated", ...(roundTrip ? { roundTrip: true } : {}) });

    it('exits non-zero when every engine round trip was exempted', () => {
      const built = report([
        exempt('ENG-KIMI-001', true),
        { id: 'ENG-CAP-001-kimi', title: 'capabilities', status: 'pass' },
        { id: 'ENG-FORK-001-kimi', title: 'fork', status: 'pass' },
        { id: 'ENG-INT-001-kimi', title: 'interaction', status: 'na', reason: 'cannot be forced live' },
      ]);
      // Two passes and no failures: the old predicate returns 0 here.
      expect(built.summary.fail).toBe(0);
      expect(exitCodeFor(built, validateReport(built))).toBe(1);
    });

    it('exits zero when one engine of several completed its round trip', () => {
      const built = report([
        { ...passing, roundTrip: true },
        exempt('ENG-KIMI-001', true),
      ]);
      expect(exitCodeFor(built, validateReport(built))).toBe(0);
    });

    // ENG-AUTH-001 has the same id shape as a round trip. Parsing ids would
    // read it as an engine called AUTH and let an exempted run pass.
    it('does not mistake ENG-AUTH-001 for an engine round trip', () => {
      const built = report([
        exempt('ENG-KIMI-001', true),
        { id: 'ENG-AUTH-001', title: 'login hint', status: 'pass' },
      ]);
      expect(exitCodeFor(built, validateReport(built))).toBe(1);
    });

    it('leaves a report with no round trips alone', () => {
      const built = report([{ id: 'ENG-CAP-001-kimi', title: 'capabilities', status: 'pass' }]);
      expect(exitCodeFor(built, validateReport(built))).toBe(0);
    });

    // A workflow is one chain; exempted partway it proves nothing, so unlike
    // ENG there is no "some other engine covered it" to fall back on.
    it('exits non-zero when any workflow case did not pass', () => {
      const built = buildReport({ gate: 'workflow', runId: 'run-2', startedAt: '2026-01-01T00:00:00.000Z', simulated: false, cliVersions: { kimi: '0.38.0' }, cases: [
        { id: 'WF-001', title: 'develop then review', status: 'pass' },
        { id: 'WF-002', title: 'parallel workers', status: 'na', reason: "engine 'kimi' is not authenticated" },
      ] });
      expect(built.summary.fail).toBe(0);
      expect(exitCodeFor(built, validateReport(built))).toBe(1);
    });
  });

  // ADR 0011 guardrail 4: "The exempted engine is named in the summary and
  // gains no support claim from it." A reader must not have to scan rows.
  describe('naming the exemptions', () => {
    it('names each engine that was exempted, once', () => {
      const built = report([
        { id: 'ENG-KIMI-001', title: 'round trip', status: 'na', reason: 'refused while working', roundTrip: true, exemptedEngine: 'kimi' },
        { id: 'ENG-FORK-001-kimi', title: 'fork', status: 'na', reason: 'refused while working', exemptedEngine: 'kimi' },
        { ...passing, roundTrip: true },
      ]);
      expect(exemptedEngines(built)).toEqual(['kimi']);
    });

    it('names nobody when nothing was exempted', () => {
      expect(exemptedEngines(report([passing]))).toEqual([]);
    });

    // The pre-run exemptions are a different class (guardrail 3) and the
    // recorder does not mark them, so they must not be reported as refusals.
    it('does not name an engine whose N/A came from somewhere else', () => {
      const built = report([{ id: 'ENG-KIMI-001', title: 'round trip', status: 'na', reason: 'kimi CLI is not installed', roundTrip: true }]);
      expect(exemptedEngines(built)).toEqual([]);
    });

    it('puts the exempted engines in the rendered report', () => {
      const built = report([
        { id: 'ENG-KIMI-001', title: 'round trip', status: 'na', reason: 'refused while working', roundTrip: true, exemptedEngine: 'kimi' },
        { ...passing, roundTrip: true },
      ]);
      expect(renderReport(built)).toContain('exempted: kimi');
    });
  });

  // Measured against a live kimi quota failure on 2026-08-25: the gate
  // exempted the only round trip, named it, and still exited 0. The
  // recorder spread its options on the success path and dropped them on
  // both catch paths, so the round-trip marker vanished exactly when
  // guardrail 4 needed it. The predicate was right; nothing produced its
  // input. Both scripts shaped this case themselves, so it lives here now.
  describe('shaping a case from a throw', () => {
    it('keeps the round-trip marker when the case was exempted', () => {
      const refusal = new MidRunRefusal('kimi', "engine 'kimi' is not authenticated", 'turn failed');
      const shaped = caseForThrow({ id: 'ENG-KIMI-001', title: 'round trip', caught: refusal, options: { roundTrip: true }, durationMs: 12 });
      expect(shaped.status).toBe('na');
      expect(shaped.roundTrip).toBe(true);
      expect(shaped.exemptedEngine).toBe('kimi');
      expect(shaped.reason).toContain("engine 'kimi' is not authenticated");
    });

    it('keeps the round-trip marker when the case failed outright', () => {
      const shaped = caseForThrow({ id: 'ENG-KIMI-001', title: 'round trip', caught: new Error('engine never replied'), options: { roundTrip: true }, durationMs: 12 });
      expect(shaped.status).toBe('fail');
      expect(shaped.roundTrip).toBe(true);
      expect(shaped.exemptedEngine).toBeUndefined();
    });

    it('marks nothing when the case was not a round trip', () => {
      const refusal = new MidRunRefusal('kimi', 'refused', 'fork failed');
      const shaped = caseForThrow({ id: 'ENG-FORK-001-kimi', title: 'fork', caught: refusal, options: {}, durationMs: 3 });
      expect(shaped.roundTrip).toBeUndefined();
      expect(shaped.exemptedEngine).toBe('kimi');
    });

    // The end-to-end shape the live run should have produced.
    it('produces a report that exits non-zero when the only round trip was exempted', () => {
      const refusal = new MidRunRefusal('kimi', "engine 'kimi' is not authenticated", 'turn failed');
      const built = report([
        caseForThrow({ id: 'ENG-KIMI-001', title: 'round trip', caught: refusal, options: { roundTrip: true }, durationMs: 12 }),
        { id: 'ENG-CAP-001-kimi', title: 'capabilities', status: 'pass' },
        { id: 'ENG-FORK-001-kimi', title: 'fork', status: 'pass' },
      ]);
      expect(built.summary.fail).toBe(0);
      expect(exemptedEngines(built)).toEqual(['kimi']);
      expect(exitCodeFor(built, validateReport(built))).toBe(1);
    });
  });

  // ADR 0011 guardrail 3: the pre-run exemption and the mid-run refusal are
  // different classes and must not share wording. The round trip checked
  // both probes and the fork case checked only `installed`, so a logged-out
  // engine reached session_create there and was filed as "came up and
  // refused while working" — which the probe had already contradicted.
  describe('the pre-run exemption', () => {
    it('exempts an engine whose CLI is absent, live or not', () => {
      for (const live of [true, false]) {
        expect(preRunExemption({ installed: false, authenticated: 'unknown' }, 'kimi', live)?.reason).toContain('not installed');
      }
    });

    it('exempts a logged-out engine under live', () => {
      const outcome = preRunExemption({ installed: true, authenticated: false }, 'kimi', true);
      expect(outcome?.status).toBe('na');
      expect(outcome?.reason).toContain('not logged in');
      // Wording a reader can tell from the mid-run one.
      expect(outcome?.reason).not.toContain('refused while working');
    });

    // Guardrail 5's other half: the scripted agent is always authenticated,
    // so a false probe there is not an environment fact to excuse.
    it('does not exempt a logged-out engine when not live', () => {
      expect(preRunExemption({ installed: true, authenticated: false }, 'kimi', false)).toBeUndefined();
    });

    // Measured 2026-08-25: four of five engines probe `unknown` on this
    // machine. Treating that as logged-out would exempt nearly everything;
    // treating it as logged-in is what let ENG-AUTH-001 claim all CLIs were
    // logged in while a turn failed for want of authentication.
    it('does not exempt an engine whose login state is unknown', () => {
      expect(preRunExemption({ installed: true, authenticated: 'unknown' }, 'kimi', true)).toBeUndefined();
    });

    it('does not exempt a healthy engine', () => {
      expect(preRunExemption({ installed: true, authenticated: true }, 'codex', true)).toBeUndefined();
    });
  });

  // ADR 0011 guardrail 5: the exemption exists only under --live. The
  // scripted agent has neither account nor quota, so an authentication-class
  // error there can only be a defect. Two scripts held byte-identical copies
  // of this gate and nothing tested either.
  describe('the liveness gate on the exemption', () => {
    const authFailure = { code: 'ENGINE_ERROR', message: "engine 'kimi' is not authenticated", cause: { name: 'UnauthenticatedError', message: "engine 'kimi' is not authenticated", operation: 'turn/run' } };

    it('refuses under live when the cause is authentication', () => {
      let thrown: unknown;
      try { refuseIfClassified(true, 'kimi', authFailure, 'turn failed'); } catch (caught) { thrown = caught; }
      expect(thrown).toBeInstanceOf(MidRunRefusal);
      expect((thrown as MidRunRefusal).exemptedEngine).toBe('kimi');
      expect((thrown as MidRunRefusal).originalMessage).toBe("engine 'kimi' is not authenticated");
    });

    // The one that matters: simulated mode must never exempt.
    it('does not refuse when the run is simulated', () => {
      expect(() => refuseIfClassified(false, 'kimi', authFailure, 'turn failed')).not.toThrow();
    });

    it('does not refuse a failure classified as something else', () => {
      const other = { code: 'ENGINE_ERROR', message: 'cannot read /etc/authorized_keys', cause: { name: 'EngineOperationError', message: 'cannot read /etc/authorized_keys', operation: 'turn/run' } };
      expect(() => refuseIfClassified(true, 'kimi', other, 'turn failed')).not.toThrow();
    });

    it('does not refuse when there is no failure to classify', () => {
      expect(() => refuseIfClassified(true, 'kimi', undefined, 'turn failed')).not.toThrow();
    });
  });

  // The workflow gate uses several engines per case and had no probe at all,
  // so a never-logged-in engine was recorded there as having come up and
  // refused. This takes the inventory the script already fetched rather than
  // a plugin, so it is testable without a harness fake.
  describe('the pre-run exemption across a set of engines', () => {
    const healthy = { engine: 'claude-code', installed: true, authenticated: true } as const;
    const loggedOut = { engine: 'kimi', installed: true, authenticated: false } as const;

    it('exempts on the first engine that fails its probe', () => {
      const outcome = preRunExemptionFor([healthy, loggedOut], ['claude-code', 'kimi'], true);
      expect(outcome?.status).toBe('na');
      expect(outcome?.reason).toContain('not logged in');
      expect(outcome?.reason).toContain('kimi');
      expect(outcome?.reason).not.toContain('refused while working');
    });

    it('exempts nothing when every engine the workflow uses is healthy', () => {
      expect(preRunExemptionFor([healthy, loggedOut], ['claude-code'], true)).toBeUndefined();
    });

    it('exempts nothing when the run is simulated', () => {
      expect(preRunExemptionFor([healthy, loggedOut], ['claude-code', 'kimi'], false)).toBeUndefined();
    });

    // An engine the inventory does not list is a plugin defect, not an
    // environment fact, and must not be laundered into an exemption.
    it('throws when an engine the workflow needs is absent from the inventory', () => {
      expect(() => preRunExemptionFor([healthy], ['claude-code', 'kimi'], true)).toThrow(/kimi/u);
    });

    // The trap the last defect hid in: the producer's output must satisfy the
    // predicate. A pre-run exemption carries no marker, so it must not be
    // named as a refusal — and the workflow run must still fail.
    it('produces an outcome that fails the run without naming a refusal', () => {
      const outcome = preRunExemptionFor([loggedOut], ['kimi'], true)!;
      const built = buildReport({ gate: 'workflow', runId: 'run-3', startedAt: '2026-01-01T00:00:00.000Z', simulated: false, cliVersions: { kimi: '0.38.0' }, cases: [{ id: 'WF-002', title: 'parallel workers', ...outcome }] });
      expect(exemptedEngines(built)).toEqual([]);
      expect(exitCodeFor(built, validateReport(built))).toBe(1);
    });
  });
});
