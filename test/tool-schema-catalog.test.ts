import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { promptBlockSchema, toolErrorSchema, toolOutputSchemas } from '../packages/plugin/src/schemas.js';

/**
 * API-019 (ADR 0029). `docs/tool-schemas.json` is the published contract and
 * `packages/plugin/src/schemas.ts` is what validates at runtime, and **almost nothing compares
 * them**: every tool call validates against Zod alone, so for all but one tool
 * the catalog can be left behind by an implementation and every other case
 * stays green. The exception since ADR 0043 is `workers_list`, whose whole
 * output ART-018 validates against the catalog — this header said *nothing
 * compares them* and that stopped being true the day that case landed. The
 * rest of the catalog is still uncompared, and this file compares one field of
 * it. It reads the catalog as data.
 */
describe('the published catalog and the runtime schema agree on Cause.kind', () => {
  const catalog = JSON.parse(
    readFileSync(join(process.cwd(), 'docs/tool-schemas.json'), 'utf8'),
  ) as { $defs: { Cause: { properties: Record<string, { type?: string; pattern?: string; maxLength?: number }> } } };
  const kind = catalog.$defs.Cause.properties['kind'];

  it('publishes the field with the pattern and bound the runtime enforces', () => {
    expect(kind).toMatchObject({ type: 'string', pattern: '^[a-z][a-z0-9-]*$', maxLength: 32 });
  });

  // API-018's schema half: the envelope rides inside *success* output on two
  // separate shapes, so an implementation projecting `kind` on one and not the
  // other must not pass. Leaving `toolErrorCauseSchema` strict without the
  // field turns both of these red — the calls would answer INTERNAL rather than
  // returning a turn with a missing field.
  it('admits the field on both output paths that carry an error envelope', () => {
    const cause = { name: 'EngineOperationError', message: 'engine refused', operation: 'turn/run', kind: 'rate-limit' };
    const turn = toolOutputSchemas.turn_get.safeParse({
      turnId: 't1',
      sessionId: 's1',
      engine: 'kimi',
      priority: 'normal',
      state: 'failed',
      enqueuedAt: '2026-08-25T00:00:00.000Z',
      pendingPermissionCount: 0,
      pendingQuestionCount: 0,
      pendingInteractionIds: [],
      throughSeq: 0,
      error: { code: 'ENGINE_ERROR', message: 'engine refused', cause },
    });
    expect(turn.success).toBe(true);
    const session = toolOutputSchemas.session_get.safeParse({
      sessionId: 's1',
      engine: 'kimi',
      cwd: '/work/project',
      permissionMode: 'allow',
      mcpServerIds: [],
      state: 'failed',
      createdAt: '2026-08-25T00:00:00.000Z',
      failure: { code: 'ENGINE_ERROR', message: 'engine refused', cause },
    });
    expect(session.success).toBe(true);
  });

  it('accepts and rejects the same values the catalog describes', () => {
    const envelope = (value: string) => ({
      code: 'ENGINE_ERROR' as const,
      message: 'engine refused',
      cause: { name: 'EngineOperationError', message: 'engine refused', kind: value },
    });
    const pattern = new RegExp(kind?.pattern ?? '');
    const bound = kind?.maxLength ?? 0;
    for (const value of ['rate-limit', 'future-kind', 'x'.repeat(bound)]) {
      expect(pattern.test(value) && value.length <= bound).toBe(true);
      expect(toolErrorSchema.safeParse(envelope(value)).success).toBe(true);
    }
    for (const value of ['RATE LIMIT', '-leading', 'x'.repeat(bound + 1)]) {
      expect(pattern.test(value) && value.length <= bound).toBe(false);
      expect(toolErrorSchema.safeParse(envelope(value)).success).toBe(false);
    }
  });
});

/**
 * ADR 0050. The published `PromptBlock` and the Zod union that actually
 * validates a turn are two hand-maintained lists of the same set, and nothing
 * compared them: a member added to one alone shipped green with the tool count
 * still 20. This extends the mechanism above — the catalog read as data — to
 * the one input the frozen surface describes as a union.
 */
describe('the published catalog and the runtime schema agree on the prompt block union', () => {
  const catalog = JSON.parse(
    readFileSync(join(process.cwd(), 'docs/tool-schemas.json'), 'utf8'),
  ) as { $defs: { PromptBlock: { oneOf: Array<{ $ref: string }> }; [name: string]: unknown } };

  /** Each catalog member's discriminator, read from the `$def` its `$ref` names. */
  const catalogTypes = catalog.$defs.PromptBlock.oneOf.map((member) => {
    const name = member.$ref.replace('#/$defs/', '');
    const def = catalog.$defs[name] as { properties: { type: { const: string } } };
    return def.properties.type.const;
  });

  it('publishes exactly the block types the runtime accepts', () => {
    // Driven from the catalog rather than a literal list, so a member added to
    // one side alone fails here instead of drifting silently.
    for (const type of catalogTypes) {
      const sample: Record<string, unknown> = { type };
      if (type === 'text') sample['text'] = 'go';
      if (type === 'image') Object.assign(sample, { data: 'aGVsbG8=', mimeType: 'image/png' });
      if (type === 'resource_link') Object.assign(sample, { name: 'spec', uri: 'file:///spec.md' });
      if (type === 'resource') sample['resource'] = { uri: 'file:///spec.md', text: 'body' };
      expect(promptBlockSchema.safeParse(sample).success).toBe(true);
    }
    expect(catalogTypes).toEqual(['text', 'image', 'resource_link', 'resource']);
    // Membership alone is not agreement: make `mimeType` required in the catalog
    // while Zod keeps it optional and the loop above stays green. API-019 went to
    // field level on `Cause` for the same reason, so this one does too, on the
    // member this change adds.
    const embedded = catalog.$defs['EmbeddedResourceBlock'] as {
      required: string[];
      properties: { resource: { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> } };
    };
    expect(embedded.required).toEqual(['type', 'resource']);
    expect(embedded.properties.resource.required).toEqual(['uri', 'text']);
    expect(embedded.properties.resource.additionalProperties).toBe(false);
    expect(Object.keys(embedded.properties.resource.properties)).toEqual(['uri', 'text', 'mimeType', '_meta']);
    // The published optionality must match the runtime's: the catalog omitting a
    // key from `required` is a promise the schema has to keep.
    expect(promptBlockSchema.safeParse({ type: 'resource', resource: { uri: 'u', text: 't' } }).success).toBe(true);
    expect(promptBlockSchema.safeParse({ type: 'resource', resource: { uri: 'u' } }).success).toBe(false);
    expect(promptBlockSchema.safeParse({ type: 'resource', resource: { text: 't' } }).success).toBe(false);
    // The two the surface still refuses, so widening the runtime without the
    // catalog is caught in the same case as the reverse.
    expect(promptBlockSchema.safeParse({ type: 'audio', data: 'AA==', mimeType: 'audio/wav' }).success).toBe(false);
    expect(promptBlockSchema.safeParse({ type: 'resource', resource: { uri: 'x', blob: 'AA==' } }).success).toBe(false);
  });
});
