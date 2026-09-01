import * as z from 'zod/v4';

/**
 * Ids that must never name an engine, whatever the registry reports.
 *
 * mvp §4.2 requires the orchestrator to select an engine explicitly and forbids
 * `auto`. A closed enum enforced that by accident. With the set open, the ban
 * has to be stated, or it would hold only for as long as nobody registers an
 * adapter called `auto` — at which point a frozen rule would be silently
 * bypassable.
 */
const RESERVED_ENGINE_IDS: ReadonlySet<string> = new Set(['auto', 'any', 'default']);

/**
 * Worker IDs are open (ADR 0004): the set comes from Runskein's registry, not from
 * an enumeration here. The pattern is copied from Runskein's own adapter-id rule
 * rather than invented — a stricter one would reject engines the registry
 * accepts, and two validators that disagree fail in the least observable way.
 *
 * This only constrains the shape. Whether an id exists is checked against the
 * live registry at call time, which is also what makes it possible to say
 * "registered but unverified" instead of only "not one of four".
 */
export const engineIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase kebab-case engine id')
  .refine((id) => !RESERVED_ENGINE_IDS.has(id), 'engine must be selected explicitly; sentinel ids are not accepted');
export type EngineId = string;
/**
 * The engines mvp §4.2 requires. They stay usable without gate evidence because
 * the frozen spec authorizes them — a different and earlier kind of
 * authorization than `verification.engines`. The two are independent on purpose:
 * a frozen engine stays usable through a lapsed or failing claim, which is what
 * keeps a stale matrix from emptying a default install.
 */
export const FROZEN_ENGINE_IDS = ['codex', 'claude-code', 'opencode', 'kimi'] as const;
/**
 * Literal union of the frozen four. `EngineId` is now `string`, so a
 * `Record<EngineId, …>` no longer means "one entry per engine"; anything that
 * needs per-engine completeness checked at compile time keys on this instead.
 */
export type FrozenEngineId = (typeof FROZEN_ENGINE_IDS)[number];
/** True for engines mvp §4.2 requires, which need no gate evidence to be usable. */
export function isFrozenEngine(engine: string): engine is FrozenEngineId {
  return (FROZEN_ENGINE_IDS as readonly string[]).includes(engine);
}

export const sessionStateSchema = z.enum(['creating', 'idle', 'busy', 'failed', 'closing', 'closed']);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const turnStateSchema = z.enum([
  'queued',
  'running',
  'awaiting-interaction',
  'completed',
  'failed',
  'cancelled',
]);
export type TurnState = z.infer<typeof turnStateSchema>;

export const interactionStateSchema = z.enum(['pending', 'responded', 'expired', 'invalidated']);
export type InteractionState = z.infer<typeof interactionStateSchema>;

export const prioritySchema = z.enum(['high', 'normal', 'low']);
export type Priority = z.infer<typeof prioritySchema>;

export const permissionModeSchema = z.enum(['deny', 'ask-orchestrator', 'allow']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const errorCodeSchema = z.enum([
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'SESSION_UNAVAILABLE',
  'CONFLICT',
  'GONE',
  'LIMIT_EXCEEDED',
  'NOT_SUPPORTED',
  'TURN_TIMEOUT',
  'INTERACTION_TIMEOUT',
  'PAYLOAD_TOO_LARGE',
  'PERMISSION_DENIED',
  'RECURSION_DENIED',
  'ENGINE_ERROR',
  'STORE_ERROR',
  // ADR 0027: the only code meaning "we could not attribute this fault". The
  // mapper's fallback must be this and never a code naming a subsystem.
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

const metadataSchema = z
  .object({
    audience: z.array(z.enum(['assistant', 'user'])).nullable().optional(),
    lastModified: z.string().nullable().optional(),
    priority: z.number().nullable().optional(),
    _meta: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

const base64Schema = z.string().refine(
  (value) => value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
  { message: 'must be valid base64' },
);

const textBlockSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
    annotations: metadataSchema.nullable().optional(),
    _meta: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

const imageBlockSchema = z
  .object({
    type: z.literal('image'),
    data: base64Schema,
    mimeType: z.string(),
    uri: z.string().nullable().optional(),
    annotations: metadataSchema.nullable().optional(),
    _meta: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

const resourceLinkBlockSchema = z
  .object({
    type: z.literal('resource_link'),
    name: z.string(),
    uri: z.string(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    mimeType: z.string().nullable().optional(),
    size: z.number().nullable().optional(),
    annotations: metadataSchema.nullable().optional(),
    _meta: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

/**
 * The embedded resource lets a caller deliver bytes it already holds — a diff it
 * computed, a file it read — instead of a path the engine has to fetch (ADR
 * 0050). Text only: ACP's shape unions text with a base64 `blob`, and nothing
 * asks for the binary half. `uri` carries no constraint beyond its type, exactly
 * as `resource_link`'s does, because nothing dereferences it: it is a label for
 * content already supplied, and the two must not drift apart.
 */
const embeddedResourceBlockSchema = z
  .object({
    type: z.literal('resource'),
    resource: z
      .object({
        uri: z.string(),
        text: z.string(),
        mimeType: z.string().nullable().optional(),
        _meta: z.record(z.string(), z.unknown()).nullable().optional(),
      })
      .strict(),
    annotations: metadataSchema.nullable().optional(),
    _meta: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

/** Audio blocks, and the `blob` half of the embedded resource, stay out (ADR 0050). */
export const promptBlockSchema = z.discriminatedUnion('type', [
  textBlockSchema,
  imageBlockSchema,
  resourceLinkBlockSchema,
  embeddedResourceBlockSchema,
]);
export type PromptBlock = z.infer<typeof promptBlockSchema>;

export const promptSchema = z.array(promptBlockSchema).min(1);
export type Prompt = z.infer<typeof promptSchema>;

export const configPatchSchema = z.record(z.string(), z.union([z.string(), z.boolean()]));
export type ConfigPatch = z.infer<typeof configPatchSchema>;
const nonEmptyConfigPatchSchema = configPatchSchema.refine((value) => Object.keys(value).length > 0, {
  message: 'config must contain at least one key',
});
const boundedNameSchema = z.string().min(1).refine((value) => Array.from(value).length <= 128, {
  message: 'name must be at most 128 Unicode code points',
});

/**
 * Byte ceiling on the anchor blob (ADR 0016): 16 KiB exactly. It reaches the
 * hook output and the orchestrator's context, so it cannot be unbounded.
 */
export const ANCHOR_MAX_BYTES = 16_384;
/**
 * The anchor payload, measured in UTF-8 bytes and nothing else.
 *
 * `maxLength` counts Unicode code points and `String.prototype.length` counts
 * UTF-16 code units; neither is a byte. Under Chinese content either would let
 * roughly three times the intended payload through without any error, which is
 * why the check is `Buffer.byteLength` and the boundary is written down: 16384
 * passes, 16385 is rejected. Over-limit input is refused, never truncated —
 * truncating would silently destroy the caller's own structure.
 */
const anchorContentSchema = z.string().superRefine((value, context) => {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > ANCHOR_MAX_BYTES) {
    context.addIssue({ code: 'custom', message: `anchor content is ${bytes} UTF-8 bytes; the limit is ${ANCHOR_MAX_BYTES}` });
  }
});

const sessionIdSchema = z.string().min(1);
const turnIdSchema = z.string().min(1);

const dateTimeSchema = z.string().datetime({ offset: true });
const authenticatedSchema = z.union([z.boolean(), z.literal('unknown')]);
/**
 * A dotted capability path as `worker_describe` reports it: `loadSession`, or
 * `session.fork`. Shape only — whether a path exists is checked against the
 * registered engines at call time, the same way engine ids are.
 */
const capabilityPathSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)?$/, 'dotted capability path');
const usageSchema = z
  .object({
    input: z.number().min(0).optional(),
    output: z.number().min(0).optional(),
    total: z.number().min(0).optional(),
    uncached: z.number().min(0).optional(),
    cacheRead: z.number().min(0).optional(),
    cacheCreation: z.number().min(0).optional(),
    thought: z.number().min(0).optional(),
  })
  .strict();

const usageSummarySchema = usageSchema.extend({ cost: z.number().min(0).optional(), currency: z.string().optional() }).strict();
/**
 * One config key as the engine reported it (ADR 0020, docs/tool-schemas.json
 * `ConfigObservation`). `observedAt` is ISO 8601: Runskein gives epoch milliseconds,
 * the tool face converts on entry to the registry (design §5.2), and every
 * timestamp on the tool face is a date-time string.
 */
const configObservationSchema = z
  .object({
    value: z.union([z.string(), z.boolean()]),
    source: z.enum(['session/new', 'session/resume', 'session/load', 'current_mode_update', 'config_option_update']),
    observedAt: dateTimeSchema,
    engineOptionId: z.string().optional(),
  })
  .strict();
const workerCapabilitiesSchema = z
  .object({
    loadSession: z.boolean(),
    session: z.record(z.string(), z.boolean()),
    prompt: z.record(z.string(), z.boolean()),
    mcp: z.record(z.string(), z.boolean()),
    providers: z.boolean(),
  })
  .strict();
const namedDescriptorSchema = z.object({ id: z.string(), name: z.string(), description: z.string().optional() }).strict();
const selectOptionSchema = z.object({ value: z.string(), name: z.string(), description: z.string().optional() }).strict();
const selectGroupSchema = z.object({ name: z.string(), options: z.array(selectOptionSchema) }).strict();
const providerInfoSchema = z
  .object({
    id: z.string(),
    protocols: z.array(z.string()),
    required: z.boolean(),
    current: z.object({ apiType: z.string(), baseUrl: z.string() }).strict().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const configOptionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    category: z.string().optional(),
    type: z.enum(['select', 'boolean']),
    options: z.array(z.union([selectOptionSchema, selectGroupSchema])).optional(),
    currentValue: z.union([z.string(), z.boolean()]).optional(),
    // Runskein's ConfigOption carries this since alpha.16: describe() appends
    // adapter-declared options an engine accepts only inside session/new (e.g.
    // claude-code's reasoning budget), marked 'creation'. Absent means the
    // engine-advertised default 'session' — writable at any time. The strict
    // schema must admit the key or every describe of such an engine fails
    // output validation.
    settable: z.enum(['session', 'creation']).optional(),
  })
  .strict();
const workerSummarySchema = z
  .object({
    engine: engineIdSchema,
    installed: z.boolean(),
    authenticated: authenticatedSchema,
    available: z.boolean(),
    /**
     * Whether the live ENG matrix has been run for this engine. Three states,
     * because a missing record means nobody asked — not that the answer was no.
     */
    verification: z.enum(['verified', 'unverified', 'unknown']),
    /**
     * Whether `session_create` will accept this engine. Separate from
     * `verification` on purpose: the frozen §4.2 engines are usable without gate
     * evidence, and `allowUnverifiedEngines` can admit ones without it.
     */
    usable: z.boolean(),
    /** Present only when `requires` was passed (ADR 0005). */
    requirements: z
      .object({
        met: z.array(capabilityPathSchema),
        unmet: z.array(capabilityPathSchema),
        /** Advertised but recorded broken — kept apart from `unmet` deliberately. */
        defective: z.array(capabilityPathSchema),
        satisfied: z.boolean(),
      })
      .strict()
      .optional(),
    version: z.string().optional(),
    hint: z.string().optional(),
  })
  .strict();
const workerDescriptorSchema = workerSummarySchema
  .extend({
    capabilities: workerCapabilitiesSchema,
    providers: z.array(providerInfoSchema).optional(),
    modes: z.array(namedDescriptorSchema).optional(),
    models: z.array(namedDescriptorSchema).optional(),
    currentModel: z.string().optional(),
    configOptions: z.array(configOptionSchema),
    source: z.enum(['probe', 'hints']),
  })
  .strict();
// `kind` carries Runskein's own classification of an engine failure (ADR 0029).
// Bounded rather than enumerated: the vocabulary is Runskein's and can gain a
// member in a patch release, so an enum here would reject an upstream addition.
// `docs/tool-schemas.json` states the same pattern and bound; nothing compares
// the two automatically, which is what API-019 exists for.
const toolErrorCauseSchema = z
  .object({
    name: z.string(),
    message: z.string(),
    operation: z.string().optional(),
    kind: z.string().regex(/^[a-z][a-z0-9-]*$/).max(32).optional(),
  })
  .strict();
export const toolErrorSchema = z
  .object({ code: errorCodeSchema, message: z.string(), details: z.record(z.string(), z.unknown()).optional(), cause: toolErrorCauseSchema.optional() })
  .strict();
const sessionOutputSchema = z
  .object({
    sessionId: sessionIdSchema,
    engine: engineIdSchema,
    name: boundedNameSchema.optional(),
    cwd: z.string().min(1),
    systemInstructions: z.string().optional(),
    permissionMode: permissionModeSchema,
    mcpServerIds: z.array(z.string()).max(8).superRefine((ids, context) => {
      if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'mcpServerIds must be unique' });
    }),
    config: configPatchSchema.optional(),
    state: sessionStateSchema,
    activeTurnId: z.string().optional(),
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema.optional(),
    closedAt: dateTimeSchema.optional(),
    failure: toolErrorSchema.optional(),
    usage: usageSummarySchema.optional(),
    // What the engine reported it is running on, parallel to `config` and never
    // merged with it (ADR 0020). An absent key means the engine did not say: it
    // does not mean the value is unset, and it must not be read as the engine
    // agreeing with `config`.
    observedConfig: z.record(z.string(), configObservationSchema).optional(),
  })
  .strict();
const turnOutputSchema = z
  .object({
    turnId: turnIdSchema,
    sessionId: sessionIdSchema,
    engine: engineIdSchema,
    priority: prioritySchema,
    state: turnStateSchema,
    enqueuedAt: dateTimeSchema,
    startedAt: dateTimeSchema.optional(),
    finishedAt: dateTimeSchema.optional(),
    pendingPermissionCount: z.number().int().min(0),
    pendingQuestionCount: z.number().int().min(0),
    pendingInteractionIds: z.array(z.string()).superRefine((ids, context) => {
      if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'pendingInteractionIds must be unique' });
    }),
    fromSeq: z.number().int().min(1).nullable().optional(),
    throughSeq: z.number().int().min(0).optional(),
    finalText: z.string().optional(),
    stopReason: z.string().optional(),
    usage: usageSchema.optional(),
    error: toolErrorSchema.optional(),
  })
  .strict();
const transcriptEventSchema = z
  .object({
    seq: z.number().int().min(1),
    ts: z.number(),
    sessionId: sessionIdSchema,
    engineId: engineIdSchema,
    update: z.object({ sessionUpdate: z.string() }).passthrough(),
    usage: usageSchema.optional(),
  })
  .strict();
const transcriptMetadataSchema = z
  .object({
    sessionId: sessionIdSchema,
    engine: engineIdSchema,
    name: z.string().optional(),
    kind: z.enum(['live', 'archive']),
    state: z.enum(['creating', 'idle', 'busy', 'failed', 'closing', 'closed', 'aborted']),
    createdAt: dateTimeSchema,
    closedAt: dateTimeSchema.optional(),
    recoveredAt: dateTimeSchema.optional(),
    highWatermark: z.number().int().min(0),
  })
  .strict();
const permissionOptionSchema = z
  .object({
    optionId: z.string(),
    name: z.string(),
    kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
    _meta: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();
const toolCallLocationSchema = z
  .object({ path: z.string(), line: z.number().int().nullable().optional(), _meta: z.record(z.string(), z.unknown()).nullable().optional() })
  .strict();
const permissionPayloadSchema = z
  .object({
    sessionId: z.string(),
    engineId: z.string(),
    tool: z.string(),
    kind: z.enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']).optional(),
    input: z.unknown(),
    locations: z.array(toolCallLocationSchema).optional(),
    options: z.array(permissionOptionSchema),
  })
  .strict();
const questionPayloadSchema = z
  .object({
    requestId: z.string(),
    sessionId: z.string(),
    engineId: z.string(),
    question: z.string(),
    options: z.array(z.object({ id: z.string(), label: z.string() }).strict()).optional(),
  })
  .strict();
const interactionBaseSchema = z.object({
  interactionId: z.string(),
  turnId: z.string(),
  sessionId: z.string(),
  state: interactionStateSchema,
  createdAt: dateTimeSchema,
  expiresAt: dateTimeSchema.optional(),
});
const interactionSchema = z.discriminatedUnion('kind', [
  interactionBaseSchema.extend({ kind: z.literal('permission'), payload: permissionPayloadSchema }).strict(),
  interactionBaseSchema.extend({ kind: z.literal('question'), payload: questionPayloadSchema }).strict(),
]);

/** Runtime validators for the structured result of every frozen tool. */
export const toolOutputSchemas = {
  workers_list: z
    .object({
      workers: z.array(workerSummarySchema),
      // ADR 0043. The id of the instance that answered — top-level because it
      // describes the responder, not an engine. Required rather than optional
      // so that its presence cannot become a signal about the console's state.
      // Opaque to callers; no format is promised.
      instanceId: z.string().min(1),
    })
    .strict(),
  worker_describe: workerDescriptorSchema,
  session_create: sessionOutputSchema,
  session_list: z.object({ sessions: z.array(sessionOutputSchema) }).strict(),
  session_get: sessionOutputSchema,
  session_configure: sessionOutputSchema,
  session_fork: sessionOutputSchema,
  session_close: sessionOutputSchema,
  turn_start: z.object({ turnId: turnIdSchema, status: z.literal('queued') }).strict(),
  turn_list: z.object({ turns: z.array(turnOutputSchema) }).strict(),
  turn_get: turnOutputSchema,
  turn_cancel: turnOutputSchema,
  transcript_list: z.object({ transcripts: z.array(transcriptMetadataSchema) }).strict(),
  transcript_read: z
    .object({ events: z.array(transcriptEventSchema), nextSeq: z.number().int().min(0), highWatermark: z.number().int().min(0), hasMore: z.boolean() })
    .strict(),
  transcript_event_get: z
    .object({ encoding: z.literal('base64'), offset: z.number().int().min(0), totalBytes: z.number().int().min(1), data: base64Schema, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict(),
  transcript_delete: z.object({ sessionId: sessionIdSchema, deleted: z.literal(true) }).strict(),
  interaction_list: z.object({ interactions: z.array(interactionSchema) }).strict(),
  interaction_respond: z.object({ interactionId: z.string().min(1), state: z.literal('responded') }).strict(),
  anchor: z
    .object({
      content: z.string().optional(),
      updatedAt: dateTimeSchema.optional(),
      // Absent anchor reports 0: there is no update to count from. The caller
      // distinguishes the two cases by whether `content` is present.
      turnsSinceUpdate: z.number().int().min(0),
    })
    .strict(),
  project_init: z
    .object({
      path: z.string(),
      created: z.boolean(),
      content: z.string(),
      enginesIncluded: z.array(engineIdSchema),
      enginesOmitted: z.array(engineIdSchema),
      console: z
        .object({
          state: z.enum(['started', 'already-running', 'start-failed', 'disabled', 'withheld']),
          // A listener's loopback port; absent on start-failed and disabled.
          // ADR 0019 bounds this disclosure to a status word and this port; since
          // ADR 0031 removed the console's token, the port is what reaches the
          // console, and that cost is stated in ADR 0031 rather than defended.
          port: z.number().int().min(0).max(65_535).optional(),
        })
        .strict(),
    })
    .strict(),
} as const;
export type ToolOutput<Name extends keyof typeof toolOutputSchemas = keyof typeof toolOutputSchemas> = z.infer<
  (typeof toolOutputSchemas)[Name]
>;

export function parseToolOutput<Name extends keyof typeof toolOutputSchemas>(name: Name, output: unknown): ToolOutput<Name> {
  return toolOutputSchemas[name].parse(output) as ToolOutput<Name>;
}

export const toolInputSchemas = {
  workers_list: z
    .object({
      rescan: z.boolean().default(false),
      /**
       * Dotted capability paths to measure each engine against (ADR 0005).
       * Annotates the response; it never removes an engine from it.
       */
      requires: z.array(capabilityPathSchema).min(1).max(8).refine((paths) => new Set(paths).size === paths.length, 'requires must be unique').optional(),
    })
    .strict(),
  worker_describe: z
    .object({ engine: engineIdSchema, rescan: z.boolean().default(false) })
    .strict(),
  session_create: z
    .object({
      engine: engineIdSchema,
      cwd: z.string().min(1),
      name: boundedNameSchema.optional(),
      systemInstructions: z.string().optional(),
      permissionMode: permissionModeSchema.default('allow'),
      mcpServerIds: z.array(z.string().min(1)).max(8).superRefine((ids, context) => {
        if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'mcpServerIds must be unique' });
      }).optional(),
      config: configPatchSchema.optional(),
      // ADR 0018: names a worker-default profile from the project's
      // <data-root>/<project-key>/config.json; its keys fill only what the
      // caller left unset. Same bound as `name`.
      profile: boundedNameSchema.optional(),
    })
    .strict(),
  session_list: z
    .object({ engine: engineIdSchema.optional(), state: sessionStateSchema.optional() })
    .strict(),
  session_get: z.object({ sessionId: sessionIdSchema }).strict(),
  session_configure: z
    .object({
      sessionId: sessionIdSchema,
      permissionMode: permissionModeSchema.optional(),
      config: nonEmptyConfigPatchSchema.optional(),
    })
    .strict()
    .refine((value) => value.permissionMode !== undefined || value.config !== undefined, {
      message: 'session_configure requires permissionMode or config',
    }),
  session_fork: z
    .object({ sessionId: sessionIdSchema, name: boundedNameSchema.optional() })
    .strict(),
  session_close: z.object({ sessionId: sessionIdSchema }).strict(),
  turn_start: z
    .object({
      sessionId: sessionIdSchema,
      prompt: promptSchema,
      priority: prioritySchema.default('normal'),
      timeoutMs: z.number().int().min(1_000).max(86_400_000).optional(),
    })
    .strict(),
  turn_list: z
    .object({
      sessionId: sessionIdSchema.optional(),
      engine: engineIdSchema.optional(),
      state: turnStateSchema.optional(),
    })
    .strict(),
  turn_get: z.object({ turnId: turnIdSchema }).strict(),
  turn_cancel: z.object({ turnId: turnIdSchema }).strict(),
  transcript_list: z
    .object({ engine: engineIdSchema.optional(), kind: z.enum(['live', 'archive']).optional() })
    .strict(),
  transcript_read: z
    .object({
      sessionId: sessionIdSchema,
      afterSeq: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100),
    })
    .strict(),
  transcript_event_get: z
    .object({
      sessionId: sessionIdSchema,
      seq: z.number().int().min(1),
      offset: z.number().int().min(0),
      maxBytes: z.number().int().min(1).max(262_144).default(262_144),
    })
    .strict(),
  transcript_delete: z.object({ sessionId: sessionIdSchema }).strict(),
  interaction_list: z
    .object({
      turnId: turnIdSchema.optional(),
      sessionId: sessionIdSchema.optional(),
      kind: z.enum(['permission', 'question']).optional(),
      state: interactionStateSchema.default('pending'),
    })
    .strict(),
  interaction_respond: z
    .object({
      interactionId: z.string().min(1),
      response: z.union([
        z.object({ optionId: z.string().min(1) }).strict(),
        z.object({ outcome: z.enum(['allow', 'deny']) }).strict(),
        z.object({ text: z.string() }).strict(),
      ]),
    })
    .strict(),
  // One name, not `anchor_get` + `anchor_set`: omitting `content` reads, giving
  // it writes. The pure-noun name breaks the `noun_verb` convention the other
  // nineteen follow, knowingly — it is both reader and writer, and splitting it
  // would put two names on a frozen surface instead of one (ADR 0016 §4).
  anchor: z.object({ content: anchorContentSchema.optional() }).strict(),
  // Generates the project's worker-defaults file and starts the console
  // (ADR 0019). The file is idempotent — `refresh` merges, never overwrites —
  // while the console start is attempted on every call.
  project_init: z.object({ refresh: z.boolean().default(false) }).strict(),
} as const;

export type ToolName = keyof typeof toolInputSchemas;
export type ToolInput<Name extends ToolName = ToolName> = z.infer<(typeof toolInputSchemas)[Name]>;

/** Parse a tool payload through the same strict runtime boundary used by hosts. */
export function parseToolInput<Name extends ToolName>(name: Name, input: unknown): ToolInput<Name> {
  return toolInputSchemas[name].parse(input) as ToolInput<Name>;
}
