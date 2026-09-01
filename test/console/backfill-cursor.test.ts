import { describe, expect, it } from 'vitest';

import { renderedSeqAfterPage } from '../../packages/plugin/src/console/ui/backfill-cursor.js';

/**
 * console-v2 §3.2 backfill resume cursor (M2 of the console-v2 review): the
 * SSE fallback after a failed backfill page opens the stream at the last
 * RENDERED seq, never at the page's highWatermark. The regression being
 * pinned: backfillSession used to park the cursor at the watermark of every
 * fetched page, so one failed request in a multi-page transcript made the
 * stream skip the unrendered tail — and appendFrame's seq dedup then hid the
 * gap. There is no DOM harness for app.js; the rule lives in this pure
 * function and app.js feeds it every rendered page.
 */
describe('renderedSeqAfterPage (console-v2 §3.2 backfill cursor)', () => {
  it('advances over rendered run seqTo only — the watermark is not the cursor', () => {
    // The failure shape: the page rendered runs up to seq 80 while the server
    // was already at 100. The resume cursor must be 80, so the fallback
    // stream re-delivers 81..100.
    const page = {
      runs: [
        { seqFrom: 1, seqTo: 40, kind: 'agent', text: 'a' },
        { seqFrom: 41, seqTo: 80, kind: 'tool', toolCallId: 'tc1' },
      ],
      nextSeq: 81,
      highWatermark: 100,
      hasMore: true,
    };
    expect(renderedSeqAfterPage(0, page)).toBe(80);
  });

  it('degraded-mode envelope pages (§3.4) advance by event seq', () => {
    expect(renderedSeqAfterPage(0, { events: [{ seq: 3 }, { seq: 7 }], highWatermark: 9 })).toBe(7);
  });

  it('ignores absent and non-numeric fields, and never retreats', () => {
    expect(renderedSeqAfterPage(50, { runs: [{ kind: 'usage' }, { seqTo: 12 }] })).toBe(50);
    expect(renderedSeqAfterPage(50, { runs: [] })).toBe(50);
    expect(renderedSeqAfterPage(50, {})).toBe(50);
  });
});
