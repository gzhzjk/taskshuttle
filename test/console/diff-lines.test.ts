import { describe, expect, it } from 'vitest';

import { diffLines } from '../../packages/plugin/src/console/ui/diff-lines.js';

/**
 * The shared line diff (console-diff-shapes-design §6.1): the UI's diff bodies
 * and the server-side diff index both count with it, so the `+a −d` on a card
 * and in the index cannot diverge — same input, same numbers, by construction.
 * The gutter numbering this file once covered is gone (ADR 0035): the console's
 * diffs show no line numbers.
 */

describe('diffLines', () => {
  it('classifies context, deletions and additions in order', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc')).toEqual([
      { t: 'ctx', x: 'a' },
      { t: 'del', x: 'b' },
      { t: 'add', x: 'x' },
      { t: 'ctx', x: 'c' },
    ]);
  });

  it('counts an empty old text as one empty line — the inherited counting convention', () => {
    // A newly created file whose oldText is empty counts one deletion of an
    // empty line. The index inherits this, so a change here changes both sides.
    expect(diffLines('', 'new')).toEqual([
      { t: 'del', x: '' },
      { t: 'add', x: 'new' },
    ]);
  });
});
