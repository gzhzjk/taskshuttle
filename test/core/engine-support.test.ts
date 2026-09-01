import { describe, expect, it } from 'vitest';

import { capabilityAdvertised, capabilityIsKnownBroken, capabilityPaths, engineAdmission, evaluateRequirements, VERIFIED_ENGINES } from '../../packages/plugin/src/engine-support.js';
import { unversionedWrapperPackages, wrapperArgsArePinned } from '../../packages/plugin/src/wrapper-pins.js';
import { FROZEN_ENGINE_IDS, isFrozenEngine, parseToolInput } from '../../packages/plugin/src/schemas.js';

const admit = (engine: string, allowUnverified: boolean) =>
  engineAdmission(engine, { isFrozen: isFrozenEngine(engine), allowUnverified });

describe('engine admission', () => {
  // The whole reason the flag scopes to non-frozen engines: a frozen engine
  // stays usable through a lapsed or failing claim, so gating on evidence alone
  // would drop it from a default install. The table records evidence separately
  // from this frozen authorization.
  it('admits every frozen engine even without gate evidence', () => {
    for (const engine of FROZEN_ENGINE_IDS) {
      expect(admit(engine, false)).toEqual({ allowed: true, reason: 'frozen' });
    }
    // An id the table has never heard of: proof that the frozen branch answers
    // before `VERIFIED_ENGINES` is consulted at all.
    expect(VERIFIED_ENGINES['not-in-the-table']).toBeUndefined();
    expect(engineAdmission('not-in-the-table', { isFrozen: true, allowUnverified: false })).toEqual({ allowed: true, reason: 'frozen' });
  });

  // Not `pi`: it was the unverified example until its live matrix was run, which
  // is precisely why a fixed engine id is the wrong sample for this rule. The
  // subject here is the rule, so the id only has to be absent from both lists.
  it('refuses an unverified engine outside the frozen set by default', () => {
    expect(admit('some-new-engine', false)).toEqual({ allowed: false, reason: 'unverified' });
  });

  it('admits it once the operator opts in', () => {
    expect(admit('some-new-engine', true)).toEqual({ allowed: true, reason: 'operator-allowed' });
  });

  it('admits a verified engine without the flag', () => {
    const verified = Object.entries(VERIFIED_ENGINES).find(([, ok]) => ok)?.[0];
    expect(verified).toBeDefined();
    expect(engineAdmission(verified!, { isFrozen: false, allowUnverified: false })).toEqual({ allowed: true, reason: 'verified' });
  });

  it('distinguishes the three authorities rather than collapsing them', () => {
    // A frozen engine is admitted for being frozen, not for being verified —
    // codex is admitted through the frozen rule, which only a distinct reason
    // can explain.
    expect(admit('codex', true).allowed && admit('codex', true).reason).toBe('frozen');
    expect(admit('some-new-engine', true).allowed && admit('some-new-engine', true).reason).toBe('operator-allowed');
    expect(admit('pi', false).allowed && admit('pi', false).reason).toBe('verified');
  });
});

describe('engine id shape', () => {
  it('accepts an id the registry could report', () => {
    expect(parseToolInput('session_create', { engine: 'pi', cwd: '/tmp' })).toMatchObject({ engine: 'pi' });
    expect(parseToolInput('session_create', { engine: '2b-agent', cwd: '/tmp' })).toMatchObject({ engine: '2b-agent' });
  });

  // mvp §4.2 forbids `auto`. The closed enum used to enforce that by accident;
  // with the set open it must be stated, or it would hold only until someone
  // registered an adapter with that name.
  it.each(['auto', 'any', 'default'])('rejects the reserved id %s', (engine) => {
    expect(() => parseToolInput('session_create', { engine, cwd: '/tmp' })).toThrow();
  });

  it.each(['-leading', 'Upper', 'has_underscore', ''])('rejects the malformed id %s', (engine) => {
    expect(() => parseToolInput('session_create', { engine, cwd: '/tmp' })).toThrow();
  });
});

describe('wrapper admission', () => {
  // The frozen four go through npx, so this is the check that stops an open
  // engine set from quietly widening how much unversioned third-party code a
  // worker runs.
  it('flags a bare package spec an npx launch would resolve to latest', () => {
    expect(unversionedWrapperPackages('npx', ['-y', '@agentclientprotocol/codex-acp'])).toEqual(['@agentclientprotocol/codex-acp']);
    expect(unversionedWrapperPackages('npx', ['-y', 'brand-new-acp'])).toEqual(['brand-new-acp']);
  });

  it('accepts a spec that carries a version', () => {
    expect(unversionedWrapperPackages('npx', ['-y', '@agentclientprotocol/codex-acp@1.3.0'])).toEqual([]);
    expect(unversionedWrapperPackages('npx', ['-y', 'brand-new-acp@0.1.0'])).toEqual([]);
  });

  it('ignores launches that are not package runners', () => {
    // opencode and kimi speak ACP natively; `acp` is a subcommand, not a package.
    expect(unversionedWrapperPackages('opencode', ['acp'])).toEqual([]);
    expect(unversionedWrapperPackages('kimi', ['acp'])).toEqual([]);
  });

  // wrapperArgsArePinned only knows packages already in WRAPPER_PACKAGES, which
  // is why it cannot carry admission on its own.
  it('shows why the pin-table check is not sufficient alone', () => {
    expect(wrapperArgsArePinned(['-y', 'brand-new-acp'])).toBe(true);
    expect(unversionedWrapperPackages('npx', ['-y', 'brand-new-acp'])).toHaveLength(1);
  });
});

describe('capability requirements', () => {
  const CAPS = {
    loadSession: true,
    providers: false,
    session: { fork: true, list: true, resume: false },
    prompt: { image: true, embeddedContext: false },
  };

  it('flattens a matrix to the vocabulary knownDefects already uses', () => {
    expect([...capabilityPaths(CAPS)].sort()).toEqual([
      'loadSession', 'prompt.embeddedContext', 'prompt.image', 'providers', 'session.fork', 'session.list', 'session.resume',
    ]);
  });

  // design §12: a missing capability key is judged false, never unknown.
  it('reads a missing key as not advertised', () => {
    expect(capabilityAdvertised(CAPS, 'session.fork')).toBe(true);
    expect(capabilityAdvertised(CAPS, 'session.absent')).toBe(false);
    expect(capabilityAdvertised(CAPS, 'absent.thing')).toBe(false);
    expect(capabilityAdvertised(undefined, 'session.fork')).toBe(false);
  });

  it('separates never-claimed from claimed-and-broken', () => {
    const evaluation = evaluateRequirements(CAPS, ['session.fork', 'session.resume', 'prompt.image'], (c) => c === 'session.fork');
    expect(evaluation.defective).toEqual(['session.fork']);
    expect(evaluation.unmet).toEqual(['session.resume']);
    expect(evaluation.met).toEqual(['prompt.image']);
    expect(evaluation.satisfied).toBe(false);
  });

  it('is satisfied only when nothing is unmet or defective', () => {
    expect(evaluateRequirements(CAPS, ['prompt.image'], () => false).satisfied).toBe(true);
    expect(evaluateRequirements(CAPS, ['prompt.image'], () => true).satisfied).toBe(false);
  });

  // The mirrored record must keep naming the defect this project keeps citing.
  it('records the claude-code fork defect for the runtime to read', () => {
    expect(capabilityIsKnownBroken('claude-code', 'session.fork')).toBe(true);
    expect(capabilityIsKnownBroken('codex', 'session.fork')).toBe(false);
  });

  // Prefix matching would let a record about session.fork also suppress
  // session.forkTree — a different capability nobody gathered evidence about.
  it('matches a capability exactly, never by prefix', () => {
    expect(capabilityIsKnownBroken('claude-code', 'session.forkTree')).toBe(false);
    expect(capabilityIsKnownBroken('claude-code', 'session')).toBe(false);
  });
});
