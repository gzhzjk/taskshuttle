import { describe, expect, it } from 'vitest';
import type { TranscriptEvent } from 'runskein';

import { PREVIEW_LIMIT, RunAssembler } from '../../packages/plugin/src/console/folded-projection.js';

/**
 * The projection half of ADR 0023: a folded tool run carries `args` with
 * exactly { text, from }. `value` must never reach the wire (§3.1), and the
 * text rides capped at PREVIEW_LIMIT. The merge rules themselves are owned by
 * test/console/tool-row-state.test.ts; what this pins is that applyToolRunFields
 * — the shared owner of run fields — actually puts args on the run.
 */

function event(sessionId: string, seq: number, update: Record<string, unknown>): TranscriptEvent {
  return { seq, ts: seq * 1_000, sessionId, engineId: 'codex', update: update as unknown as TranscriptEvent['update'] };
}

function fold(updates: Record<string, unknown>[]): Run[] {
  const assembler = new RunAssembler();
  updates.forEach((update, i) => assembler.pushEvent(event('r1', i + 1, update)));
  assembler.finish();
  return JSON.parse(JSON.stringify(assembler.runs));
}

type Run = Record<string, unknown> & { kind: string };

describe('folded projection: tool run args (ADR 0023)', () => {
  it('a tool_call with locations yields args { text: path, from: locations }, and only those keys', () => {
    const runs = fold([
      { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Read', kind: 'read', status: 'in_progress', locations: [{ path: '/tmp/x.md' }] },
      // The scripted pair: a status-only update whose partial row computes no
      // args — writing that absence back would drop the path (merge rule 1).
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed' },
    ]);
    const tool = runs.find((r) => r.kind === 'tool');
    expect(tool).toBeDefined();
    expect(tool?.['args']).toEqual({ text: '/tmp/x.md', from: 'locations' });
  });

  it('rawInput wins over locations and value never reaches the run', () => {
    const runs = fold([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc2',
        title: 'Bash',
        kind: 'execute',
        status: 'completed',
        rawInput: { command: 'ls -la', secret: 'hunter2' },
        locations: [{ path: '/tmp/y' }],
      },
    ]);
    const tool = runs.find((r) => r.kind === 'tool');
    expect(tool?.['args']).toEqual({ text: 'ls -la', from: 'rawInput' });
    expect(JSON.stringify(tool)).not.toContain('hunter2');
    expect(Object.keys(tool?.['args'] as Record<string, unknown>).sort()).toEqual(['from', 'text']);
  });

  it('text longer than PREVIEW_LIMIT ships capped, not raw', () => {
    const big = JSON.stringify({ blob: 'z'.repeat(PREVIEW_LIMIT * 3) });
    const runs = fold([{ sessionUpdate: 'tool_call', toolCallId: 'tc3', title: 'T', status: 'running', rawInput: { blob: 'z'.repeat(PREVIEW_LIMIT * 3) } }]);
    const tool = runs.find((r) => r.kind === 'tool');
    const args = tool?.['args'] as { text: string };
    expect(args.text.length).toBeLessThanOrEqual(PREVIEW_LIMIT);
    expect(big.length).toBeGreaterThan(PREVIEW_LIMIT);
  });

  it('no chain hit means no args key on the run at all', () => {
    const runs = fold([{ sessionUpdate: 'tool_call', toolCallId: 'tc4', title: 'Read', status: 'in_progress' }]);
    const tool = runs.find((r) => r.kind === 'tool');
    expect(tool).toBeDefined();
    expect('args' in (tool ?? {})).toBe(false);
  });
});
