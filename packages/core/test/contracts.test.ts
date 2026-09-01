import { describe, expect, it } from 'vitest';
import { createCore, readTranscriptPage, type AnchorRepository, type Clock, type IdGenerator, type TranscriptEvent, type TranscriptReader } from '../src/index.js';

const event = (seq: number, text: string): TranscriptEvent => ({
  seq,
  ts: seq,
  sessionId: 'session-1',
  engineId: 'codex',
  update: { sessionUpdate: 'agent_message_chunk', text },
});

function reader(events: readonly TranscriptEvent[]): TranscriptReader {
  return {
    async *read(_sessionId, options) {
      for (const item of events) {
        if (options?.fromSeq !== undefined && item.seq < options.fromSeq) continue;
        if (options?.toSeq !== undefined && item.seq > options.toSeq) continue;
        yield item;
      }
    },
    canonicalEvent: async (_sessionId, seq) => {
      const item = events.find((candidate) => candidate.seq === seq);
      return item === undefined ? undefined : { bytes: new TextEncoder().encode(JSON.stringify(item)), sha256: `digest-${seq}` };
    },
  };
}

describe('@taskshuttle/core contracts', () => {
  it('constructs from injected ports without reading process state', () => {
    const clock: Clock = { now: () => 10 };
    const ids: IdGenerator = { next: (kind) => `${kind}-1` };
    const anchors: AnchorRepository = { read: async () => undefined, write: async () => undefined };
    const transcripts = { append: async () => undefined, ...reader([]) };
    const agents = { inventory: async () => ({ agents: [] }) };
    const environment = { clock, ids, agents, transcripts, anchors };
    expect(createCore(environment).environment).toBe(environment);
  });

  it('paginates opaque events with an exclusive cursor and upper bound', async () => {
    const page = await readTranscriptPage(reader([event(1, 'one'), event(2, 'two'), event(3, 'three')]), 'session-1', 3, {
      afterSeq: 0,
      toSeq: 2,
      limit: 10,
      budgetBytes: 1_024,
    });
    expect(page.events).toEqual([event(1, 'one'), event(2, 'two')]);
    expect(page.nextSeq).toBe(3);
    expect(page.highWatermark).toBe(3);
    expect(page.hasMore).toBe(true);
  });

  it('returns canonical identity when one event exceeds the byte budget', async () => {
    await expect(readTranscriptPage(reader([event(1, 'a very large event')]), 'session-1', 1, {
      afterSeq: 0,
      limit: 10,
      budgetBytes: 20,
    })).rejects.toMatchObject({
      name: 'TranscriptPageError',
      code: 'payload-too-large',
      details: { seq: 1, sha256: 'digest-1' },
    });
  });
});
