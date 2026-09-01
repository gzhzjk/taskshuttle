import { describe, expect, it } from 'vitest';

import { continuesOpenRun, continuesRun, joinFragmentContent } from '../../packages/plugin/src/console/ui/seam-merge.js';

/**
 * The client side of the console-v2 §3.2 seam rule. The regression pinned here
 * is the earlier rule — same-(kind, messageId) adjacency alone — which joined
 * two genuinely distinct messages into one whenever the folder's boundary left
 * no run between them that the UI treats as a break. `usage` runs are exactly
 * that case: token accounting rides nearly every envelope, so a `usage` run
 * deliberately breaks no adjacency, and a bare `usage_update` ends the message
 * it follows. Open state is what tells the two apart.
 */

const openRun = (over: Record<string, unknown> = {}) =>
  ({ type: 'msg', run: { kind: 'thought', messageId: undefined, open: true, ...over } });

describe('continuesOpenRun (console-v2 §3.2 seam)', () => {
  it('joins a folded page fragment onto the open tail run of the same key', () => {
    expect(continuesOpenRun(openRun(), { kind: 'thought', messageId: undefined, fromFoldedPage: true, openStart: true })).toBe(true);
    expect(continuesOpenRun(openRun({ messageId: 'm1' }), { kind: 'agent', messageId: 'm1' })).toBe(false);
    expect(continuesOpenRun(openRun({ messageId: 'm1' }), { kind: 'thought', messageId: 'm2' })).toBe(false);
  });

  it('refuses a settled tail run: a message that ended is not a message the page cut', () => {
    // Two no-id thought messages the folder separated with a usage_update. The
    // `usage` run between them breaks no adjacency, so adjacency alone would
    // merge them and diverge from fold(raw); the tail's open state does not.
    const settled = openRun({ open: false });
    expect(continuesOpenRun(settled, { kind: 'thought', messageId: undefined })).toBe(false);
    expect(continuesOpenRun(settled, { kind: 'thought', messageId: undefined, fromFoldedPage: true, openStart: true })).toBe(false);
  });

  it('requires a folded fragment to declare itself a continuation', () => {
    // A page whose first message run is a NEW message (the cursor event was
    // not a chunk of it) carries no openStart; joining it onto the previous
    // page's open fragment would splice two messages together.
    expect(continuesOpenRun(openRun(), { kind: 'thought', messageId: undefined, fromFoldedPage: true })).toBe(false);
    expect(continuesOpenRun(openRun(), { kind: 'thought', messageId: undefined, fromFoldedPage: true, openStart: false })).toBe(false);
    // The live folder has no flag to give: its cold start at the seam is the
    // continuation by construction (§3.2, seam three).
    expect(continuesOpenRun(openRun(), { kind: 'thought', messageId: undefined })).toBe(true);
  });

  it('refuses anything that is not a message run at the tail', () => {
    expect(continuesOpenRun(null, { kind: 'thought', messageId: undefined })).toBe(false);
    expect(continuesOpenRun(undefined, { kind: 'thought', messageId: undefined })).toBe(false);
    expect(continuesOpenRun({ type: 'group', group: {} }, { kind: 'thought', messageId: undefined })).toBe(false);
  });
});

describe('joinFragmentContent (the half every consumer shares)', () => {
  /**
   * Two of the three consumers used to join by concatenating `text`. A
   * fragment past the cap has no `text` — it carries preview/truncated/
   * fullBytes — so that join produced an empty string beside a stale byte
   * count, a shape no server sends. Both sides now take the content from here
   * and decide separately what to do with it.
   */
  const LIMIT = 8;

  it('joins two whole fragments into a whole message', () => {
    expect(joinFragmentContent({ text: 'ab' }, { text: 'cd' }, LIMIT)).toEqual({
      text: 'abcd', preview: 'abcd', fullBytes: 4,
    });
  });

  it('withholds `text` when either side withheld its own, and still previews the join', () => {
    // The first fragment is past the cap: preview only, plus its byte count.
    const fromTruncated = joinFragmentContent({ preview: 'AAAAAAAA', fullBytes: 40 }, { text: 'bb' }, LIMIT);
    expect(fromTruncated.text).toBeUndefined();
    expect(fromTruncated.preview).toBe('AAAAAAAA');
    expect(fromTruncated.fullBytes).toBe(42);

    const toTruncated = joinFragmentContent({ text: 'ab' }, { preview: 'CCCCCCCC', fullBytes: 40 }, LIMIT);
    expect(toTruncated.text).toBeUndefined();
    expect(toTruncated.preview).toBe('abCCCCCC');
    expect(toTruncated.fullBytes).toBe(42);
  });

  it('counts bytes, not characters', () => {
    // Four-byte astral pair plus a three-byte CJK character.
    expect(joinFragmentContent({ text: '𝄞' }, { text: '中' }, LIMIT).fullBytes).toBe(7);
  });

  it('treats an absent half as empty rather than throwing', () => {
    expect(joinFragmentContent({}, { text: 'x' }, LIMIT)).toEqual({ text: undefined, preview: 'x', fullBytes: 1 });
  });
});

describe('continuesRun (the wire form the gate and the unit check use)', () => {
  const open = { kind: 'agent', messageId: undefined, open: true };

  it('is the same rule the UI applies, expressed over wire fields', () => {
    expect(continuesRun(open, { kind: 'agent', messageId: undefined, fromFoldedPage: true, openStart: true })).toBe(true);
    expect(continuesRun({ ...open, open: false }, { kind: 'agent', messageId: undefined, fromFoldedPage: true, openStart: true })).toBe(false);
    expect(continuesRun(open, { kind: 'agent', messageId: undefined, fromFoldedPage: true })).toBe(false);
    expect(continuesRun(undefined, { kind: 'agent', messageId: undefined })).toBe(false);
  });

  it('backs continuesOpenRun, so the UI cannot drift from it', () => {
    const tail = { type: 'msg', run: { ...open } };
    for (const incoming of [
      { kind: 'agent', messageId: undefined },
      { kind: 'agent', messageId: undefined, fromFoldedPage: true, openStart: true },
      { kind: 'thought', messageId: undefined },
    ]) {
      expect(continuesOpenRun(tail, incoming)).toBe(continuesRun(tail.run, incoming));
    }
  });
});
