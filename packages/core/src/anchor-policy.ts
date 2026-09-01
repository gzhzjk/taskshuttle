import type { CoreResult } from './errors.js';

/** The byte ceiling shared by the tool schema and the opaque anchor policy. */
export const ANCHOR_MAX_BYTES = 16_384;

/** Validate an opaque anchor by UTF-8 bytes; Core never parses its contents. */
export function validateAnchorContent(content: string, maxBytes = ANCHOR_MAX_BYTES): CoreResult<string> {
  const bytes = new TextEncoder().encode(content).byteLength;
  return bytes <= maxBytes
    ? { ok: true, value: content }
    : { ok: false, error: { code: 'payload-too-large', message: `anchor content exceeds the ${maxBytes}-byte limit`, details: { bytes, maxBytes } } };
}
