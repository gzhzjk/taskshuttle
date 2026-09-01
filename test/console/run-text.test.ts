import { describe, expect, it } from 'vitest';

import { applyPreviewPolicy, composeRunText, thoughtDisplay, type MessageRunText } from '../../packages/plugin/src/console/ui/run-text.js';

/**
 * The expansion path behind a truncated folded preview (console-v2 §3.2). The
 * regression pinned here is the earlier single-request version: a run long
 * enough to be truncated — §2's case is a 30 000-character thought — spans far
 * more chunk events than one page of the events route carries, so taking the
 * first response as the full text presented a cut-off message as the complete
 * one, with `truncated`/`preview` recomputed to agree.
 */

const EVENTS_PAGE_LIMIT = 100;

function chunkEvent(seq: number, text: string): Record<string, unknown> {
  return { seq, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } } };
}

/** The raw events route over one session, including its forced paging. */
function routeOver(events: Record<string, unknown>[], highWatermark: number) {
  const calls: Array<{ afterSeq: number; toSeq: number }> = [];
  const fetchPage = async (afterSeq: number, toSeq: number): Promise<unknown> => {
    calls.push({ afterSeq, toSeq });
    const page = events.filter((ev) => (ev['seq'] as number) > afterSeq && (ev['seq'] as number) <= toSeq).slice(0, EVENTS_PAGE_LIMIT);
    const nextSeq = page.length === 0 ? afterSeq + 1 : (page.at(-1)!['seq'] as number) + 1;
    // The route reports the real watermark, not the toSeq bound: hasMore stays
    // true past the interval's end, so it cannot be the loop's bound.
    return { events: page, nextSeq, highWatermark, hasMore: nextSeq <= highWatermark };
  };
  return { fetchPage, calls };
}

describe('composeRunText (console-v2 §3.2 expansion)', () => {
  it('pages to the end of the interval instead of stopping at the first page', async () => {
    const events = Array.from({ length: 250 }, (_, i) => chunkEvent(i + 1, `${i},`));
    const { fetchPage, calls } = routeOver(events, 400);
    const text = await composeRunText(fetchPage, 1, 250);
    expect(text).toBe(events.map((_, i) => `${i},`).join(''));
    expect(calls).toEqual([{ afterSeq: 0, toSeq: 250 }, { afterSeq: 100, toSeq: 250 }, { afterSeq: 200, toSeq: 250 }]);
  });

  it('stops at seqTo even though the page still reports hasMore for the watermark', async () => {
    const events = Array.from({ length: 300 }, (_, i) => chunkEvent(i + 1, 'x'));
    const { fetchPage, calls } = routeOver(events, 300);
    expect(await composeRunText(fetchPage, 1, 50)).toBe('x'.repeat(50));
    expect(calls).toEqual([{ afterSeq: 0, toSeq: 50 }]);
  });

  it('takes only text chunks, and stops when a page makes no progress', async () => {
    const mixed = [
      chunkEvent(1, 'a'),
      { seq: 2, update: { sessionUpdate: 'tool_call', toolCallId: 'tc1' } },
      { seq: 3, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'image', data: 'zz' } } },
      chunkEvent(4, 'b'),
    ];
    const { fetchPage } = routeOver(mixed, 4);
    expect(await composeRunText(fetchPage, 1, 4)).toBe('ab');

    let calls = 0;
    const stalled = async (): Promise<unknown> => { calls += 1; return { events: [], nextSeq: 1, highWatermark: 9, hasMore: true }; };
    expect(await composeRunText(stalled, 1, 9)).toBe('');
    expect(calls).toBe(1);
  });

  it('propagates a failed page rather than returning a partial text as whole', async () => {
    const failing = async (): Promise<unknown> => { throw new Error('GET events → 413'); };
    await expect(composeRunText(failing, 1, 5)).rejects.toThrow('413');
  });
});

describe('applyPreviewPolicy (console-v2 §4.1 preview device)', () => {
  /**
   * The regression pinned here: the preview cap was applied to every message
   * run, so a live agent answer past 512 characters — the console's primary
   * content, whose full text was already in memory — rendered collapsed behind
   * a "show more" no section asks for. §4.1 asks for the preview device on
   * thought runs and says why: they clamp to two lines, so the DOM carries the
   * preview only.
   */
  const LIMIT = 10;

  it('mounts the preview for a long thought run', () => {
    const run = applyPreviewPolicy<MessageRunText>({ kind: 'thought', text: 'x'.repeat(25) }, LIMIT);
    expect(run.truncated).toBe(true);
    expect(run.preview).toBe('x'.repeat(LIMIT));
  });

  it('mounts the whole text for agent and user runs however long', () => {
    for (const kind of ['agent', 'user']) {
      const run = applyPreviewPolicy<MessageRunText>({ kind, text: 'y'.repeat(500) }, LIMIT);
      expect(`${kind}:${String(run.truncated)}`).toBe(`${kind}:false`);
      expect(run.preview).toBe('y'.repeat(500));
    }
  });

  it('leaves a short thought run whole', () => {
    const run = applyPreviewPolicy<MessageRunText>({ kind: 'thought', text: 'short' }, LIMIT);
    expect(run.truncated).toBe(false);
    expect(run.preview).toBe('short');
  });

  it('keeps a server-sent preview when the text is not in memory', () => {
    // The backfill path releases `text`; the preview it was given stands, and
    // the fetch decision is `text === undefined`, not this flag.
    const run = applyPreviewPolicy({ kind: 'agent', text: undefined, preview: 'from the wire', truncated: true }, LIMIT);
    expect(run.preview).toBe('from the wire');
    expect(run.truncated).toBe(false);
  });
});

describe('thoughtDisplay (GZH-38: whitespace-only thoughts must not render)', () => {
  /**
   * Engines stream thoughts as raw chunks and several separate thinking
   * segments with blank lines; rendered verbatim those arrive as empty
   * clamped cards — a header, a `…` and nothing behind it. The display text
   * is therefore trimmed, and the caller suppresses the block when it comes
   * back empty AND the run is not truncated: a truncated run carries content
   * past the cap, and hiding it would make that content unreachable (a
   * hidden block cannot be expanded). The one unbounded input — the in-memory
   * text behind a collapsed truncated run's whitespace-only preview — is
   * sliced to the preview limit, so no path can pour an unbounded thought
   * into the DOM. Trimming
   * is display-only: the accumulated raw text and the preview policy keep
   * the original bytes, so expand/fetch and the seam merge are untouched.
   */
  const LIMIT = 10;

  it('trims surrounding whitespace off a thought with real content', () => {
    expect(thoughtDisplay({ kind: 'thought', text: '\n\n  Assessing the impact.  \n' }, LIMIT)).toBe('Assessing the impact.');
  });
  it('returns nothing for a thought whose text is only spaces and newlines', () => {
    for (const text of ['', '   ', '\n\n', ' \n \t\n']) {
      expect(thoughtDisplay({ kind: 'thought', text }, LIMIT), JSON.stringify(text)).toBe('');
    }
  });

  it('judges a collapsed truncated run by its preview, not the in-memory text', () => {
    // The selection must mirror the renderer: a collapsed truncated run shows
    // its preview — reaching for the full text would pour it into the DOM
    // unclamped and bypass the §4.1 preview policy. A backfill run with a
    // whitespace-only preview has nothing visible to show, but the caller
    // keeps the block visible because the run is truncated.
    expect(thoughtDisplay({ kind: 'thought', text: 'x'.repeat(600), preview: '  head of a long thought  ', truncated: true }, LIMIT))
      .toBe('head of a long thought');
    expect(thoughtDisplay({ kind: 'thought', text: undefined, preview: '\n'.repeat(512), truncated: true }, LIMIT)).toBe('');
  });

  it('caps the in-memory fallback of a collapsed truncated run at the preview limit', () => {
    // Degenerate payload: content exists past the cap, but the preview shows
    // none of it. The run must stay reachable, and the fallback that keeps it
    // so is bounded — a 30 000-character thought never enters the DOM whole.
    const text = `${' \n '.repeat(300)}real thinking that keeps going and going`;
    expect(thoughtDisplay({ kind: 'thought', text, preview: '\n'.repeat(512), truncated: true }, LIMIT)).toBe('real think');
  });

  it('shows the trimmed full text for an expanded truncated run', () => {
    // Expanding is the one state where the whole text is meant to render; the
    // cap bounds the fallback, not this.
    expect(thoughtDisplay({ kind: 'thought', text: '\n\n expanded shows everything \n', preview: 'head', truncated: true, expanded: true }, LIMIT))
      .toBe('expanded shows everything');
  });

  it('judges a truncated run by its preview when the text was withheld', () => {
    // The backfill path releases `text`; the preview it was given stands, and
    // the fetch decision is `text === undefined`, not this flag.
    expect(thoughtDisplay({ kind: 'thought', text: undefined, preview: '  from the wire  ', truncated: true }, LIMIT)).toBe('from the wire');
    expect(thoughtDisplay({ kind: 'thought', text: undefined, preview: '\n\n', truncated: true }, LIMIT)).toBe('');
  });

  it('answers empty for non-thought kinds — the rule never applies to them', () => {
    expect(thoughtDisplay({ kind: 'agent', text: '\n\n' }, LIMIT)).toBe('');
    expect(thoughtDisplay({ kind: 'user', text: '\n\n' }, LIMIT)).toBe('');
  });
});
