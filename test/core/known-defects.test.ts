import { describe, expect, it } from 'vitest';

import { loadKnownDefects, staleDefects } from '../../packages/plugin/src/known-defects.js';

const FORK_DEFECT = {
  id: 'ENG-FORK-001-claude-code',
  engine: 'claude-code',
  capability: 'session.fork',
  component: 'claude-code-acp',
  componentVersion: '0.16.2',
  realmVersion: '0.1.0-alpha.20',
  owner: 'engine/wrapper',
  evidence: 'release/gates/engine-2026-08-17T11-31-24-757Z.json',
};

/** The Realm version the fixtures are dated against. */
const REALM = '0.1.0-alpha.20';

function verification(entries: unknown[]): unknown {
  return { knownDefects: { entries } };
}

describe('known defects', () => {
  it('parses a well-formed record', () => {
    const { defects, problems } = loadKnownDefects(verification([FORK_DEFECT]));
    expect(problems).toEqual([]);
    expect(defects).toHaveLength(1);
    expect(defects[0]?.capability).toBe('session.fork');
  });

  it.each([
    ['a missing block', {}],
    ['a null verification', null],
    ['entries that are not an array', { knownDefects: { entries: 'nope' } }],
  ])('treats %s as no defects rather than failing', (_label, input) => {
    expect(loadKnownDefects(input)).toEqual({ defects: [], problems: [] });
  });

  // A malformed entry must not be skipped: the matrix would then read as
  // "no known defects", which is the opposite of what the record says.
  //
  // Every required field, not a representative one: the gate message prints
  // the whole REQUIRED list, so a check that validated only some of them
  // would still name them all and look right.
  const REQUIRED_FIELDS = ['id', 'engine', 'capability', 'component', 'componentVersion', 'realmVersion', 'evidence'] as const;

  it.each(REQUIRED_FIELDS)('reports a missing %s as a problem and keeps the entry out of defects', (field) => {
    const { defects, problems } = loadKnownDefects(verification([{ ...FORK_DEFECT, [field]: undefined }]));
    expect(defects).toEqual([]);
    expect(problems[0]?.message).toContain(`missing or empty: ${field}`);
  });

  it.each(REQUIRED_FIELDS)('treats an empty %s as missing', (field) => {
    const { defects, problems } = loadKnownDefects(verification([{ ...FORK_DEFECT, [field]: '' }]));
    expect(defects).toEqual([]);
    expect(problems[0]?.message).toContain(`missing or empty: ${field}`);
  });

  it('names an unidentifiable entry rather than dropping it silently', () => {
    const { problems } = loadKnownDefects(verification([{ engine: 'codex' }]));
    expect(problems[0]?.id).toBe('<unnamed>');
  });



  // ADR 0026 places realmVersion between componentVersion and evidence; the
  // table above covers its presence, this pins where it sits in the message.
  it('names realmVersion in the required list, in order', () => {
    const { problems } = loadKnownDefects(verification([{ ...FORK_DEFECT, realmVersion: undefined }]));
    expect(problems[0]?.message).toContain('componentVersion, realmVersion, evidence');
  });

  it('is fresh while the component version matches the baseline', () => {
    const { defects } = loadKnownDefects(verification([FORK_DEFECT]));
    expect(staleDefects(defects, { 'claude-code-acp': '0.16.2' }, REALM)).toEqual([]);
  });

  it('goes stale when the baseline moves', () => {
    const { defects } = loadKnownDefects(verification([FORK_DEFECT]));
    expect(staleDefects(defects, { 'claude-code-acp': '0.17.0' }, REALM)).toHaveLength(1);
  });

  // ADR 0026's whole point: the component can sit still across a Realm bump,
  // and today that is exactly what happened four times running.
  // The flags decide how many messages the gate emits, so a count alone
  // would let `componentExpired` be set for a Realm-only expiry and still
  // pass — while the gate then blames a component that never moved.
  it('goes stale when Realm moves and the component does not', () => {
    const { defects } = loadKnownDefects(verification([FORK_DEFECT]));
    expect(staleDefects(defects, { 'claude-code-acp': '0.16.2' }, '0.1.0-alpha.21'))
      .toEqual([{ defect: defects[0], componentExpired: false, realmExpired: true }]);
  });

  it('marks only the component dimension when Realm has not moved', () => {
    const { defects } = loadKnownDefects(verification([FORK_DEFECT]));
    expect(staleDefects(defects, { 'claude-code-acp': '0.17.0' }, REALM))
      .toEqual([{ defect: defects[0], componentExpired: true, realmExpired: false }]);
  });

  // One entry, two reasons: the caller still gets it once, and the gate is
  // what turns it into two messages.
  it('returns an entry once when both dimensions have moved, flagging both', () => {
    const { defects } = loadKnownDefects(verification([FORK_DEFECT]));
    expect(staleDefects(defects, { 'claude-code-acp': '0.17.0' }, '0.1.0-alpha.21'))
      .toEqual([{ defect: defects[0], componentExpired: true, realmExpired: true }]);
  });

  // An engine with no wrapper (opencode, kimi speak ACP natively) has no
  // baseline entry to compare against; that is not staleness.
  it('stays fresh when the component has no baseline entry', () => {
    const { defects } = loadKnownDefects(verification([{ ...FORK_DEFECT, component: 'opencode' }]));
    expect(staleDefects(defects, { 'claude-code-acp': '0.16.2' }, REALM)).toEqual([]);
  });

  // The baseline is wrappers *and* engines. Every other fixture here uses a
  // wrapper component, so building the baseline from wrappers alone would
  // pass them all while `pi` — which owns its own defect — stopped expiring
  // on the component dimension. It would still expire on a Realm bump; the
  // loss is the dimension that notices its own binary moving.
  it('expires a component supplied by the engines baseline, not just a wrapper', () => {
    const piDefect = { ...FORK_DEFECT, id: 'ENG-FORK-001-pi', engine: 'pi', component: 'pi', componentVersion: '0.84.2' };
    const { defects } = loadKnownDefects(verification([piDefect]));
    expect(staleDefects(defects, { 'claude-code-acp': '0.16.2', pi: '0.85.0' }, REALM))
      .toEqual([{ defect: defects[0], componentExpired: true, realmExpired: false }]);
    expect(staleDefects(defects, { 'claude-code-acp': '0.16.2', pi: '0.84.2' }, REALM)).toEqual([]);
  });

  // Returning only the first stale entry would pass every single-entry case
  // above and silently drop the rest from the gate.
  it('returns every stale entry, not just the first', () => {
    const piDefect = { ...FORK_DEFECT, id: 'ENG-FORK-001-pi', engine: 'pi', component: 'pi', componentVersion: '0.84.2' };
    const { defects } = loadKnownDefects(verification([FORK_DEFECT, piDefect]));
    expect(defects).toHaveLength(2);
    expect(staleDefects(defects, { 'claude-code-acp': '0.17.0', pi: '0.85.0' }, REALM)).toEqual([
      { defect: defects[0], componentExpired: true, realmExpired: false },
      { defect: defects[1], componentExpired: true, realmExpired: false },
    ]);
  });

  // Every multi-entry case above has the two entries expiring for the same
  // reason, so computing the dimensions once and reusing them would pass.
  // A release really can hold one of each, and then the wrong record gets
  // sent for the wrong re-run.
  it('judges each entry on its own dimensions when they differ', () => {
    const piDefect = { ...FORK_DEFECT, id: 'ENG-FORK-001-pi', engine: 'pi', component: 'pi', componentVersion: '0.84.2', realmVersion: '0.1.0-alpha.16' };
    const { defects } = loadKnownDefects(verification([FORK_DEFECT, piDefect]));
    // claude-code: component moved, Realm matches. pi: Realm moved, component matches.
    expect(staleDefects(defects, { 'claude-code-acp': '0.17.0', pi: '0.84.2' }, REALM)).toEqual([
      { defect: defects[0], componentExpired: true, realmExpired: false },
      { defect: defects[1], componentExpired: false, realmExpired: true },
    ]);
  });

  // A Realm bump expires every entry at once, which is the migration cost
  // ADR 0026 accepts — and the case where dropping all but the first hides
  // most of the work.
  it('expires every entry when Realm moves', () => {
    const piDefect = { ...FORK_DEFECT, id: 'ENG-FORK-001-pi', engine: 'pi', component: 'pi', componentVersion: '0.84.2' };
    const { defects } = loadKnownDefects(verification([FORK_DEFECT, piDefect]));
    expect(staleDefects(defects, { 'claude-code-acp': '0.16.2', pi: '0.84.2' }, '0.1.0-alpha.21')).toEqual([
      { defect: defects[0], componentExpired: false, realmExpired: true },
      { defect: defects[1], componentExpired: false, realmExpired: true },
    ]);
  });

  // ADR 0026 decision 4: the Realm dimension is a second expiry path, not a
  // patch for the component-absent hole. An entry can still evade the
  // component dimension forever — it just cannot evade this one.
  it('still expires an unrecognised component on the Realm dimension alone', () => {
    const { defects } = loadKnownDefects(verification([{ ...FORK_DEFECT, component: 'opencode' }]));
    expect(staleDefects(defects, { 'claude-code-acp': '0.16.2' }, '0.1.0-alpha.21'))
      .toEqual([{ defect: defects[0], componentExpired: false, realmExpired: true }]);
  });
});
