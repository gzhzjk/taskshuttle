import { describe, expect, it } from 'vitest';

import { parseToolInput, parseToolOutput, promptBlockSchema } from '../packages/plugin/src/schemas.js';

describe('frozen tool input schemas', () => {
  it('applies defaults and keeps worker selection explicit', () => {
    expect(parseToolInput('workers_list', {})).toEqual({ rescan: false });
    expect(parseToolInput('turn_start', { sessionId: 's', prompt: [{ type: 'text', text: 'work' }] })).toMatchObject({
      priority: 'normal',
    });
    expect(() => parseToolInput('session_create', { engine: 'auto', cwd: '/tmp' })).toThrow();
    // ADR 0008: silent approval is the default, and the frozen schema says so.
    expect(parseToolInput('session_create', { engine: 'codex', cwd: '/tmp' })).toMatchObject({ permissionMode: 'allow' });
  });

  it('preserves supported native content blocks and rejects unsupported ones', () => {
    expect(
      promptBlockSchema.parse({
        type: 'image',
        data: 'aGVsbG8=',
        mimeType: 'image/png',
        uri: null,
        _meta: { source: 'fixture' },
      }),
    ).toMatchObject({ type: 'image', data: 'aGVsbG8=' });
    expect(promptBlockSchema.parse({ type: 'resource_link', name: 'readme', uri: 'file:///README.md' })).toMatchObject({
      type: 'resource_link',
    });
    expect(() => promptBlockSchema.parse({ type: 'audio', data: 'AA==', mimeType: 'audio/wav' })).toThrow();
    // API-009 / ADR 0050: the text half of the embedded resource is admitted and
    // the binary half is not, so the case keeps a `blob` vector — admitting one
    // half must not read as admitting the union.
    expect(promptBlockSchema.parse({ type: 'resource', resource: { uri: 'file:///README.md', text: 'hello' } })).toMatchObject({
      type: 'resource',
      resource: { text: 'hello' },
    });
    expect(() => promptBlockSchema.parse({ type: 'resource', resource: { uri: 'x', blob: 'AA==' } })).toThrow();
    // INV-013: `uri` is a label for content already supplied — the plugin never
    // dereferences it, so it is not constrained to a URL, and the empty string
    // is as acceptable as `resource_link`'s empty uri is today. Both values must
    // be ones a URL rule would reject, or the case cannot fail under it.
    expect(promptBlockSchema.parse({ type: 'resource', resource: { uri: 'prefetch/git-show-HEAD', text: 'diff' } })).toMatchObject({
      resource: { uri: 'prefetch/git-show-HEAD' },
    });
    expect(promptBlockSchema.parse({ type: 'resource', resource: { uri: '', text: 'diff' } }).type).toBe('resource');
  });

  it('rejects unknown mutation fields and enforces limits', () => {
    expect(() => parseToolInput('session_create', { engine: 'codex', cwd: '/tmp', allowUnsafeAutoApproval: true })).toThrow();
    expect(() =>
      parseToolInput('session_create', {
        engine: 'codex',
        cwd: '/tmp',
        mcpServerIds: Array.from({ length: 9 }, (_, index) => `mcp-${index}`),
      }),
    ).toThrow();
    expect(() =>
      parseToolInput('transcript_event_get', { sessionId: 's', seq: 1, offset: 0, maxBytes: 262_145 }),
    ).toThrow();
    expect(() =>
      parseToolInput('session_create', { engine: 'codex', cwd: '/tmp', mcpServerIds: ['same', 'same'] }),
    ).toThrow();
    expect(() => promptBlockSchema.parse({ type: 'image', data: 'not-base64', mimeType: 'image/png' })).toThrow();
  });

  it('keeps question option ids distinct from answer optionId', () => {
    expect(
      parseToolInput('interaction_respond', { interactionId: 'i', response: { optionId: 'question-option' } }),
    ).toEqual({ interactionId: 'i', response: { optionId: 'question-option' } });
    expect(() =>
      parseToolInput('interaction_respond', { interactionId: 'i', response: { optionId: '' } }),
    ).toThrow();
  });

  it('accepts an optional profile on session_create, bounded like name (ADR 0018)', () => {
    expect(parseToolInput('session_create', { engine: 'codex', cwd: '/tmp', profile: 'implementing' })).toMatchObject({ profile: 'implementing' });
    expect(() => parseToolInput('session_create', { engine: 'codex', cwd: '/tmp', profile: '' })).toThrow();
    expect(() => parseToolInput('session_create', { engine: 'codex', cwd: '/tmp', profile: 7 })).toThrow();
    expect(() => parseToolInput('session_create', { engine: 'codex', cwd: '/tmp', profile: 'x'.repeat(129) })).toThrow();
  });

  it('uses Unicode code points for names, rejects empty config patches, and validates outputs', () => {
    const name128 = '😀'.repeat(128);
    expect(parseToolInput('session_create', { engine: 'codex', cwd: '/tmp', name: name128 })).toMatchObject({ name: name128 });
    expect(() => parseToolInput('session_create', { engine: 'codex', cwd: '/tmp', name: `${name128}😀` })).toThrow();
    expect(() => parseToolInput('session_configure', { sessionId: 's', config: {} })).toThrow();
    expect(() => parseToolOutput('turn_start', { turnId: 't', status: 'queued', extra: true })).toThrow();
  });

  it('admits creation-only config options in worker_describe output (Realm alpha.16)', () => {
    // Realm 0.1.0-alpha.16's describe() appends adapter-declared options an
    // engine accepts only at session/new (claude-code's reasoning budget was
    // the first), marked settable: 'creation'. The strict schema rejecting that
    // key is what turned every claude-code worker_describe into a STORE_ERROR.
    const descriptor = {
      engine: 'claude-code',
      installed: true,
      authenticated: 'unknown',
      available: true,
      verification: 'verified',
      usable: true,
      capabilities: {
        loadSession: true,
        session: { fork: true, list: true, resume: true },
        prompt: { image: true, embeddedContext: true },
        mcp: { http: true, sse: true },
        providers: false,
      },
      source: 'probe',
      configOptions: [
        { id: 'model', name: 'Model', type: 'select', options: [{ value: 'a', name: 'a' }] },
        {
          id: 'reasoning',
          name: 'reasoning',
          category: 'thought_level',
          type: 'select',
          options: [{ value: 'low', name: 'low' }],
          settable: 'creation',
        },
      ],
    };
    expect(parseToolOutput('worker_describe', descriptor)).toMatchObject({ configOptions: descriptor.configOptions });
    expect(() =>
      parseToolOutput('worker_describe', {
        ...descriptor,
        configOptions: [{ id: 'x', name: 'x', type: 'select', settable: 'whenever' }],
      }),
    ).toThrow();
  });
});
