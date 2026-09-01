import type { TranscriptEvent } from 'runskein';

import { toPluginException } from './error-mapper.js';
import type { PluginTranscriptStore } from './store/plugin-transcript-store.js';

/**
 * Byte-budgeted transcript pagination (design §9.4), shared by the
 * `transcript_read` tool and the console's events endpoint so both surfaces
 * page identically (console-design §5.1): same exclusive cursor, same
 * high-watermark semantics, same oversized-event reference flow.
 */

export interface TranscriptPage {
  readonly events: Record<string, unknown>[];
  readonly nextSeq: number;
  readonly highWatermark: number;
  readonly hasMore: boolean;
}

/** The public event projection `transcript_read` returns. */
export function transcriptEventOutput(event: TranscriptEvent): Record<string, unknown> {
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
 * Read one page of `(afterSeq, highWatermark]`. The caller captures
 * `highWatermark` first, with its own not-found policy. Throws a
 * PAYLOAD_TOO_LARGE plugin exception when a single event exceeds the budget;
 * its details carry the oversized reference (`seq`, `totalBytes`, `sha256`).
 *
 * `toSeq` (console-v2 §3.2) caps the page at a closed-interval upper bound —
 * the console's single-event fetch (`afterSeq=N-1&toSeq=N`). The response's
 * `highWatermark` and `hasMore` keep their real values, so the cursor semantics
 * are untouched. The tool surface never passes it.
 */
export async function readTranscriptPage(
  store: PluginTranscriptStore,
  realmSessionId: string,
  highWatermark: number,
  options: { afterSeq: number; limit: number; budgetBytes: number; toSeq?: number; project?: (event: TranscriptEvent) => Record<string, unknown> },
): Promise<TranscriptPage> {
  const { afterSeq, limit, budgetBytes } = options;
  const toSeq = options.toSeq === undefined ? highWatermark : Math.min(options.toSeq, highWatermark);
  const project = options.project ?? transcriptEventOutput;
  const events: Record<string, unknown>[] = [];
  let hasMore = false;
  let nextSeq = afterSeq + 1;
  if (afterSeq < highWatermark) {
    // Incremental accounting: each event costs its own serialized length plus
    // one separating comma; the envelope is measured once, with the widest
    // dynamic values (design §9.4). One final stringify re-checks the total.
    const envelope = (seq: number): number => Buffer.byteLength(JSON.stringify({ events: [], nextSeq: seq + 1, highWatermark, hasMore: true }), 'utf8');
    let used = envelope(highWatermark);
    for await (const event of store.read(realmSessionId, { fromSeq: afterSeq + 1, toSeq })) {
      if (events.length === limit) { hasMore = true; break; }
      const projected = project(event);
      const cost = Buffer.byteLength(JSON.stringify(projected), 'utf8') + (events.length === 0 ? 0 : 1);
      const size = used + cost;
      if (size > budgetBytes) {
        if (events.length === 0) {
          const canonical = await store.canonicalEvent(realmSessionId, event.seq);
          throw toPluginException({
            code: 'PAYLOAD_TOO_LARGE',
            message: `transcript event ${event.seq} exceeds the configured response byte budget`,
            details: {
              seq: event.seq,
              responseByteBudget: budgetBytes,
              ...(canonical === undefined ? {} : { totalBytes: canonical.bytes.byteLength, sha256: canonical.sha256 }),
            },
          });
        }
        hasMore = true;
        break;
      }
      used = size;
      events.push(projected);
      nextSeq = event.seq + 1;
    }
  }
  if (!hasMore) hasMore = nextSeq <= highWatermark;
  const result = { events, nextSeq, highWatermark, hasMore };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > budgetBytes) {
    throw toPluginException({ code: 'PAYLOAD_TOO_LARGE', message: 'transcript page exceeds the configured response byte budget', details: { responseByteBudget: budgetBytes } });
  }
  return result;
}
