import { TranscriptPageError } from './errors.js';
import type { TranscriptReader } from './ports.js';
import type { TranscriptEvent } from './types.js';

export interface TranscriptPage {
  readonly events: readonly TranscriptEvent[];
  readonly nextSeq: number;
  readonly highWatermark: number;
  readonly hasMore: boolean;
}

export interface TranscriptPageOptions {
  readonly afterSeq: number;
  readonly limit: number;
  readonly budgetBytes: number;
  readonly toSeq?: number;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Project one stored event without interpreting its opaque update payload.
 * @param event - the stored wire-isomorphic transcript event
 * @returns a structurally copied event with its opaque update untouched
 */
export function transcriptEventOutput(event: TranscriptEvent): TranscriptEvent {
  return {
    seq: event.seq,
    ts: event.ts,
    sessionId: event.sessionId,
    engineId: event.engineId,
    update: event.update,
    ...(event.usage === undefined ? {} : { usage: event.usage }),
  };
}

/**
 * Read one exclusive-cursor transcript page using only the repository port.
 * Oversized-event identity is returned as details for the outer error mapper;
 * this function never creates a Plugin/MCP exception or reads a file.
 * @param repository - transcript persistence port
 * @param sessionId - opaque provider/session key owned by the caller
 * @param highWatermark - successful append watermark captured by the caller
 * @param options - cursor, limit, byte budget, and optional console upper bound
 * @returns a page with exact event envelopes and cursor metadata
 * @throws TranscriptPageError when one event cannot fit the configured budget
 */
export async function readTranscriptPage(
  repository: TranscriptReader,
  sessionId: string,
  highWatermark: number,
  options: TranscriptPageOptions,
): Promise<TranscriptPage> {
  const { afterSeq, limit, budgetBytes } = options;
  const toSeq = options.toSeq === undefined ? highWatermark : Math.min(options.toSeq, highWatermark);
  const events: TranscriptEvent[] = [];
  let hasMore = false;
  let nextSeq = afterSeq + 1;
  if (afterSeq < highWatermark) {
    const envelope = (seq: number): number => utf8Bytes(JSON.stringify({ events: [], nextSeq: seq + 1, highWatermark, hasMore: true }));
    let used = envelope(highWatermark);
    for await (const rawEvent of repository.read(sessionId, { fromSeq: afterSeq + 1, toSeq })) {
      if (events.length === limit) { hasMore = true; break; }
      const event = transcriptEventOutput(rawEvent);
      const cost = utf8Bytes(JSON.stringify(event)) + (events.length === 0 ? 0 : 1);
      if (used + cost > budgetBytes) {
        if (events.length === 0) {
          const canonical = await repository.canonicalEvent?.(sessionId, event.seq);
          throw new TranscriptPageError(`transcript event ${event.seq} exceeds the configured response byte budget`, {
            seq: event.seq,
            responseByteBudget: budgetBytes,
            ...(canonical === undefined ? {} : { totalBytes: canonical.bytes.byteLength, sha256: canonical.sha256 }),
          });
        }
        hasMore = true;
        break;
      }
      used += cost;
      events.push(event);
      nextSeq = event.seq + 1;
    }
  }
  if (!hasMore) hasMore = nextSeq <= highWatermark;
  const result = { events, nextSeq, highWatermark, hasMore };
  if (utf8Bytes(JSON.stringify(result)) > budgetBytes) {
    throw new TranscriptPageError('transcript page exceeds the configured response byte budget', { responseByteBudget: budgetBytes });
  }
  return result;
}
