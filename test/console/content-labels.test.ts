import { describe, expect, it } from 'vitest';

import { contentLabel, noticeLabel, toolArgsView } from '../../packages/plugin/src/console/ui/content-labels.js';

/**
 * The label contracts of ADR 0023 §4.2/§4.3: both render paths (live and
 * backfill) share these pure functions precisely so a refresh cannot show
 * something different from live. Every fallback here is "today's behavior" —
 * the ADR changes only resource_link and the four meta notices.
 */
describe('contentLabel (ADR 0023 §4.2)', () => {
  it('resource_link labels with name and carries the uri as title', () => {
    expect(contentLabel({ type: 'resource_link', uri: 'file:///tmp/brief.md', name: 'project brief — which document owns which fact' })).toEqual({
      label: 'project brief — which document owns which fact',
      title: 'file:///tmp/brief.md',
    });
  });

  it('resource_link falls back name → uri → the type name', () => {
    expect(contentLabel({ type: 'resource_link', uri: 'file:///x', name: '' })).toEqual({ label: 'file:///x', title: 'file:///x' });
    expect(contentLabel({ type: 'resource_link', uri: '', name: '' })).toEqual({ label: 'resource_link' });
  });

  it('no uri means no title property at all — not an empty string', () => {
    const out = contentLabel({ type: 'resource_link', name: 'just a name' });
    expect(out).toEqual({ label: 'just a name' });
    expect('title' in out).toBe(false);
  });

  it('every other block keeps exactly the bare type, with no title', () => {
    for (const type of ['text', 'image', 'resource', 'something_new']) {
      expect(contentLabel({ type })).toEqual({ label: type });
    }
  });

  it('missing or malformed type degrades to content — never undefined', () => {
    for (const block of [undefined, null, {}, { type: 42 }, { nope: true }]) {
      expect(contentLabel(block as never)).toEqual({ label: 'content' });
    }
  });
});

describe('noticeLabel (ADR 0023 §4.3)', () => {
  it('names each of the four session meta events', () => {
    expect(noticeLabel({ sessionUpdate: 'available_commands_update' })).toBe('commands');
    expect(noticeLabel({ sessionUpdate: 'config_option_update' })).toBe('config');
    expect(noticeLabel({ sessionUpdate: 'session_info_update' })).toBe('session info');
  });

  it('current_mode_update appends the mode only when one is actually there', () => {
    expect(noticeLabel({ sessionUpdate: 'current_mode_update', currentModeId: 'code' })).toBe('mode code');
    // No `mode undefined`, ever: absence degrades to the bare word.
    for (const update of [{ sessionUpdate: 'current_mode_update' }, { sessionUpdate: 'current_mode_update', currentModeId: 7 }, { sessionUpdate: 'current_mode_update', currentModeId: '' }]) {
      expect(noticeLabel(update as never)).toBe('mode');
    }
  });

  it('anything unrecognized falls back to notice instead of raising', () => {
    for (const update of [undefined, null, {}, { sessionUpdate: 'auto_retry_start' }, { other: true }]) {
      expect(noticeLabel(update as never)).toBe('notice');
    }
  });

  it('prototype keys are unrecognized, not inherited (ADR 0023 review finding 2)', () => {
    // `constructor`, `toString`, `hasOwnProperty` resolve on a plain lookup —
    // the fallback must be hasOwn, or a hostile/malformed kind reaches the
    // page as an inherited function's source text.
    for (const kind of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(noticeLabel({ sessionUpdate: kind } as never)).toBe('notice');
    }
  });

  it('returns plain text — escaping is the caller’s job', () => {
    expect(noticeLabel({ sessionUpdate: '<script>' })).toBe('notice');
    expect(noticeLabel({ sessionUpdate: 'current_mode_update', currentModeId: '<mode>' })).toBe('mode <mode>');
  });
});

describe('toolArgsView (ADR 0023 §4.1, review finding 5)', () => {
  it('absent or malformed args draw nothing', () => {
    for (const args of [undefined, null, 'text', {}, { text: 7, from: 'locations' }, { text: 'x' }]) {
      expect(toolArgsView(args as never)).toBeUndefined();
    }
  });

  it('the inferred marker rides only on a standalone content-sourced card', () => {
    const content = { text: 'wrote src/x.ts', from: 'content' };
    expect(toolArgsView(content)).toEqual({ text: 'wrote src/x.ts', title: 'wrote src/x.ts', inferred: true });
    // Grouped rows carry no marker — the decision is encoded here so the DOM
    // assembly stays untested while the decision does not.
    expect(toolArgsView(content, { inline: true })).toEqual({ text: 'wrote src/x.ts', title: 'wrote src/x.ts', inferred: false });
    for (const from of ['rawInput', 'locations']) {
      expect(toolArgsView({ text: 'p', from })).toMatchObject({ inferred: false });
    }
  });

  it('title carries the same capped text the row already holds', () => {
    const text = 'x'.repeat(600).slice(0, 512);
    expect(toolArgsView({ text, from: 'rawInput' })?.title).toBe(text);
  });
});
