import { randomBytes } from 'node:crypto';

import type {
  Answer,
  PermissionDecision,
  PermissionPolicy,
  PermissionRequest,
  QuestionRequest,
} from 'runskein';

import { mapError, type PluginError } from './error-mapper.js';
import type { PermissionMode } from './schemas.js';
import { SessionRegistry, type InteractionRecord } from '@taskshuttle/core';

/**
 * Normalise an engine permission request into the shape the tool output schema
 * promises (`permissionPayloadSchema` in ../schemas.ts).
 *
 * Engines are not validated at the runskein boundary — `handlePermission`
 * builds `input: toolCall.rawInput`, and an engine that asks for permission
 * BEFORE it has streamed the tool's raw input (kimi does this: the initial
 * `tool_call` update carries no `rawInput`, only later `tool_call_update`s do)
 * leaves that `undefined`. `undefined` does not survive JSON serialisation, so
 * the key vanishes from the stored payload and `interaction_list` then fails its
 * own output schema — the orchestrator can neither READ the request nor answer
 * it, because the interactionId only ever appears in that listing. A pending
 * permission becomes unanswerable, and the worker hangs until it is cancelled.
 *
 * So the boundary normalises instead of trusting: `input` is always present
 * (null when the engine had none to give), and each option is rebuilt to the
 * strict `{optionId, name, kind}` shape, with anything unusable dropped rather
 * than passed through to break serialisation later. Widening the schema would
 * have been the other way to make this validate, but it would push the same
 * uncertainty onto every consumer — the orchestrator would have to defend
 * against a payload shape that varies per engine.
 */
const PERMISSION_OPTION_KINDS = new Set([
  'allow_once', 'allow_always', 'reject_once', 'reject_always',
]);

export function normalizePermissionRequest(request: PermissionRequest): PermissionRequest {
  const options = Array.isArray(request.options) ? request.options : [];
  const normalizedOptions = options.flatMap((option) => {
    if (option === null || typeof option !== 'object') return [];
    const { optionId, name, kind, _meta } = option as PermissionRequest['options'][number];
    if (typeof optionId !== 'string' || typeof name !== 'string') return [];
    if (!PERMISSION_OPTION_KINDS.has(kind as string)) return [];
    const rebuilt = { optionId, name, kind } as PermissionRequest['options'][number];
    if (_meta !== undefined) (rebuilt as { _meta?: unknown })._meta = _meta;
    return [rebuilt];
  });
  const normalized: PermissionRequest = {
    sessionId: request.sessionId,
    engineId: request.engineId,
    tool: request.tool,
    input: request.input === undefined ? null : request.input,
    options: normalizedOptions,
  };
  if (request.kind !== undefined) normalized.kind = request.kind;
  if (request.locations !== undefined) normalized.locations = request.locations;
  return normalized;
}

/** The public Realm surface needed to answer question interactions. */
export interface InteractionBridgeSession {
  on(event: 'question', listener: (request: QuestionRequest) => void): () => void;
  respond(requestId: string, answer: Answer): Promise<void>;
}

export interface InteractionBrokerOptions {
  registry: SessionRegistry;
  /** Plugin session ID; the Realm policy/listener is reused across turns. */
  sessionId: string;
  permissionMode?: PermissionMode | (() => PermissionMode);
  /** Installation-level gate required before an `allow` policy can be used. */
  secretLiterals?: readonly string[];
}

export type InteractionResponse =
  | { optionId: string }
  | { outcome: 'allow' | 'deny' }
  | { text: string };

export type InteractionResponseResult =
  | { ok: true; value: InteractionRecord }
  | { ok: false; error: PluginError };

interface PendingPermission {
  readonly kind: 'permission';
  readonly resolve: (decision: PermissionDecision) => void;
}

interface PendingQuestion {
  readonly kind: 'question';
  readonly requestId: string;
}

type Pending = PendingPermission | PendingQuestion;

function failure(code: PluginError['code'], message: string): InteractionResponseResult {
  return { ok: false, error: { code, message } };
}

function uuidv7(): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp >> BigInt((5 - index) * 8)) & 0xff;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function permissionPayload(record: InteractionRecord): PermissionRequest | undefined {
  if (record.kind !== 'permission' || !isRecord(record.payload)) return undefined;
  const payload = record.payload as unknown as PermissionRequest;
  return Array.isArray(payload.options) ? payload : undefined;
}

function questionPayload(record: InteractionRecord): QuestionRequest | undefined {
  if (record.kind !== 'question' || !isRecord(record.payload)) return undefined;
  const payload = record.payload as unknown as QuestionRequest;
  return typeof payload.question === 'string' ? payload : undefined;
}

function hasOption(options: PermissionRequest['options'], optionId: string): boolean {
  return options.some((option) => option.optionId === optionId);
}

function hasQuestionOption(request: QuestionRequest, optionId: string): boolean {
  return (request.options ?? []).some((option) => option.id === optionId);
}

/**
 * Bridges Realm's public permission policy/question callbacks to plugin
 * interactions. The broker never imports Realm internals or constructs a
 * wire-level permission outcome; Realm remains responsible for that mapping.
 */
export class InteractionBroker {
  readonly permissionPolicy: PermissionPolicy;

  private readonly registry: SessionRegistry;
  private readonly sessionId: string;
  private session: InteractionBridgeSession | undefined;
  private readonly permissionMode: PermissionMode | (() => PermissionMode);
  private readonly secretLiterals: readonly string[];
  private readonly pending = new Map<string, Pending>();
  private readonly responseInFlight = new Set<string>();
  private unsubscribeQuestion: () => void;
  private readonly unsubscribeInteraction: () => void;
  private disposed = false;

  constructor(options: InteractionBrokerOptions) {
    this.registry = options.registry;
    this.sessionId = options.sessionId;
    this.permissionMode = options.permissionMode ?? 'allow';
    this.secretLiterals = options.secretLiterals ?? [];
    this.unsubscribeQuestion = () => undefined;
    this.unsubscribeInteraction = this.registry.onInteraction((interaction) => this.observeInteraction(interaction));
    this.permissionPolicy = (request) => this.handlePermission(request);
  }

  /**
   * Attach the public Realm session returned by `hub.session` exactly once.
   * Callers pass `permissionPolicy` to hub.session first, then attach before
   * marking the plugin session ready or submitting its first prompt.
   */
  attachSession(session: InteractionBridgeSession): void {
    if (this.disposed) throw new Error('interaction broker is disposed');
    if (this.session !== undefined) throw new Error('interaction broker session is already attached');
    this.session = session;
    this.unsubscribeQuestion = session.on('question', (request) => this.receiveQuestion(request));
  }

  /** Resolve one externally supplied interaction response exactly once. */
  async respond(interactionId: string, response: InteractionResponse): Promise<InteractionResponseResult> {
    const interaction = this.registry.getInteraction(interactionId);
    if (interaction === undefined) return failure('NOT_FOUND', 'interaction not found');
    if (interaction.sessionId !== this.sessionId) return failure('NOT_FOUND', 'interaction not found');
    if (interaction.state !== 'pending') return failure('GONE', 'interaction is no longer pending');

    const pending = this.pending.get(interactionId);
    if (pending === undefined) return failure('GONE', 'interaction is no longer pending');
    if (this.responseInFlight.has(interactionId)) return failure('GONE', 'interaction response is already in flight');
    const validation = this.validateResponse(interaction, response);
    if (validation !== undefined) return validation;

    if (pending.kind === 'permission') {
      const resolved = this.registry.resolveInteractionCAS(interactionId, 'responded');
      if (!resolved.ok || resolved.value === undefined) return failure('GONE', 'interaction is no longer pending');
      pending.resolve(response as PermissionDecision);
      this.pending.delete(interactionId);
      return { ok: true, value: resolved.value };
    }

    if (this.session === undefined) return failure('SESSION_UNAVAILABLE', 'Realm session is not attached');

    this.responseInFlight.add(interactionId);
    try {
      await this.session.respond(pending.requestId, response as Answer);
    } catch (cause) {
      const current = this.registry.getInteraction(interactionId);
      if (current === undefined || current.state !== 'pending') {
        this.pending.delete(interactionId);
        return failure('GONE', 'interaction is no longer pending');
      }
      return {
        ok: false,
        error: mapError(cause, { operation: 'session/respond', secretLiterals: this.secretLiterals }),
      };
    } finally {
      this.responseInFlight.delete(interactionId);
    }
    const resolved = this.registry.resolveInteractionCAS(interactionId, 'responded');
    if (!resolved.ok || resolved.value === undefined) {
      this.pending.delete(interactionId);
      return failure('GONE', 'interaction is no longer pending');
    }
    this.pending.delete(interactionId);
    return { ok: true, value: resolved.value };
  }

  /** Stop observing callbacks and fail-closed any still pending policies. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeQuestion();
    this.unsubscribeInteraction();
    for (const [id, pending] of this.pending) {
      if (pending.kind === 'permission') pending.resolve({ outcome: 'deny' });
      else void this.respondWithoutInteraction(pending.requestId);
      this.registry.resolveInteractionCAS(id, 'invalidated');
    }
    this.pending.clear();
  }

  /**
   * `allow` still records (ADR 0008). The decision this project made was to stop
   * asking, not to stop keeping the answer: an approval that leaves no
   * interaction and no log line makes "what was this worker permitted to do"
   * unanswerable afterwards, and the after-the-fact record is the whole defence
   * of approving automatically. The record is created and resolved in one step,
   * so `interaction_list` shows it already settled.
   */
  private recordAutoApproval(turnId: string, request: PermissionRequest): PermissionDecision {
    const interactionId = uuidv7();
    try {
      const added = this.registry.addInteraction(turnId, {
        id: interactionId,
        kind: 'permission',
        payload: normalizePermissionRequest(request),
        permissionModeSnapshot: 'allow',
      });
      // A record that cannot be written must not silently become a bare
      // approval: fail closed, the same as every other unverifiable state.
      if (!added.ok) return { outcome: 'deny' };
      // Both reachable failures mean the record is not ours to settle: the turn
      // went terminal and invalidated it. Fail closed rather than approve
      // against a record that says something else.
      if (!this.registry.resolveInteractionCAS(interactionId, 'responded').ok) return { outcome: 'deny' };
    } catch {
      return { outcome: 'deny' };
    }
    return { outcome: 'allow' };
  }

  private handlePermission(request: PermissionRequest): PermissionDecision | Promise<PermissionDecision> {
    const turn = this.activeTurn(request.sessionId, request.engineId);
    if (this.disposed || turn === undefined) return { outcome: 'deny' };
    const mode = this.resolvePermissionMode();
    if (mode === 'deny') return { outcome: 'deny' };
    if (mode === 'allow') return this.recordAutoApproval(turn.id, request);

    const interactionId = uuidv7();
    const deferred = new Promise<PermissionDecision>((resolve) => {
      this.pending.set(interactionId, { kind: 'permission', resolve });
    });
    let added;
    try {
      added = this.registry.addInteraction(turn.id, {
        id: interactionId,
        kind: 'permission',
        payload: normalizePermissionRequest(request),
        permissionModeSnapshot: 'ask-orchestrator',
      });
    } catch {
      this.pending.delete(interactionId);
      return { outcome: 'deny' };
    }
    if (!added.ok) {
      this.pending.delete(interactionId);
      return { outcome: 'deny' };
    }
    return deferred;
  }

  private receiveQuestion(request: QuestionRequest): void {
    const turn = this.activeTurn(request.sessionId, request.engineId);
    if (this.disposed || turn === undefined) {
      void this.respondWithoutInteraction(request.requestId);
      return;
    }
    const interactionId = uuidv7();
    let added;
    try {
      added = this.registry.addInteraction(turn.id, {
        id: interactionId,
        kind: 'question',
        payload: request,
        realmQuestionRequestId: request.requestId,
      });
    } catch {
      void this.respondWithoutInteraction(request.requestId);
      return;
    }
    if (!added.ok) {
      void this.respondWithoutInteraction(request.requestId);
      return;
    }
    this.pending.set(interactionId, { kind: 'question', requestId: request.requestId });
  }

  /**
   * Settle a Realm question that no orchestrator answer will ever reach
   * (no active turn, or the interaction was invalidated/expired). Realm's
   * `Answer` has no decline variant, so an empty text is the only available
   * "no answer" signal; it is never derived from worker output, and the plugin
   * makes no domain judgement about it (design §2.2).
   */
  private async respondWithoutInteraction(requestId: string): Promise<void> {
    try {
      await this.session?.respond(requestId, { text: '' });
    } catch {
      // A concurrent Realm cancel/close already settled the request.
    }
  }

  private observeInteraction(interaction: InteractionRecord): void {
    if (interaction.sessionId !== this.sessionId || interaction.state === 'pending') return;
    const pending = this.pending.get(interaction.id);
    if (pending === undefined) return;
    if (interaction.state === 'invalidated' || interaction.state === 'expired') {
      // Settle the engine side unconditionally instead of relying on Realm's
      // own cancel to clear a question the orchestrator will never answer.
      if (pending.kind === 'permission') pending.resolve({ outcome: 'deny' });
      else void this.respondWithoutInteraction(pending.requestId);
      this.pending.delete(interaction.id);
    }
  }

  private validateResponse(interaction: InteractionRecord, response: InteractionResponse): InteractionResponseResult | undefined {
    if (!isRecord(response) || Array.isArray(response)) return failure('INVALID_ARGUMENT', 'response must be an object');
    if (interaction.kind === 'permission') {
      const request = permissionPayload(interaction);
      // `INTERNAL`, not `ENGINE_ERROR`: a permission request is normalized by
      // `normalizePermissionRequest` at both producers before it is stored, so
      // the engine's shape is gone by the time this reads it. A payload this
      // rejects is the plugin's own record not being what the plugin put there
      // (ADR 0030). The invariant lives in those two producers, not in the
      // registry, which stores payloads without validating them.
      if (request === undefined) return failure('INTERNAL', 'permission interaction payload is malformed');
      const keys = Object.keys(response);
      if (keys.length !== 1 || (keys[0] !== 'optionId' && keys[0] !== 'outcome')) {
        return failure('INVALID_ARGUMENT', 'permission response must use exactly one of optionId or outcome');
      }
      if ('text' in response || ('optionId' in response && (typeof response.optionId !== 'string' || response.optionId.length === 0))) {
        return failure('INVALID_ARGUMENT', 'permission response must use optionId or outcome');
      }
      if ('optionId' in response && !hasOption(request.options, response.optionId as string)) {
        return failure('INVALID_ARGUMENT', 'permission optionId is not offered by Realm');
      }
      if ('outcome' in response && response.outcome !== 'allow' && response.outcome !== 'deny') {
        return failure('INVALID_ARGUMENT', 'permission outcome must be allow or deny');
      }
      if (!('optionId' in response) && !('outcome' in response)) return failure('INVALID_ARGUMENT', 'permission response is missing a decision');
      return undefined;
    }

    const request = questionPayload(interaction);
    // The mirror image of the permission case: a question request is stored
    // raw, so a payload this rejects is a payload the engine sent (ADR 0030).
    if (request === undefined) return failure('ENGINE_ERROR', 'question interaction payload is malformed');
    const keys = Object.keys(response);
    if (keys.length !== 1 || (keys[0] !== 'text' && keys[0] !== 'optionId')) {
      return failure('INVALID_ARGUMENT', 'question response must use exactly one of text or optionId');
    }
    if ('outcome' in response) return failure('INVALID_ARGUMENT', 'question response must use text or optionId');
    if ('text' in response && typeof response.text !== 'string') return failure('INVALID_ARGUMENT', 'question text must be a string');
    if ('optionId' in response) {
      if (typeof response.optionId !== 'string' || response.optionId.length === 0 || !hasQuestionOption(request, response.optionId)) {
        return failure('INVALID_ARGUMENT', 'question optionId is not offered by Realm');
      }
    }
    if (!('text' in response) && !('optionId' in response)) return failure('INVALID_ARGUMENT', 'question response is missing an answer');
    return undefined;
  }

  private activeTurn(realmSessionId: string, engineId: string): ReturnType<SessionRegistry['getTurn']> {
    const session = this.registry.getSession(this.sessionId);
    if (session === undefined || session.state !== 'busy' || session.activeTurnId === undefined || session.realmSessionId !== realmSessionId || session.engine !== engineId) return undefined;
    const turn = this.registry.getTurn(session.activeTurnId);
    if (turn === undefined || turn.sessionId !== this.sessionId || turn.terminalClaim !== undefined || !turn.promptSubmitted || (turn.state !== 'running' && turn.state !== 'awaiting-interaction')) return undefined;
    return turn;
  }

  private resolvePermissionMode(): PermissionMode {
    try {
      const current = this.registry.getSession(this.sessionId)?.permissionMode;
      if (current !== undefined) return current;
      return typeof this.permissionMode === 'function' ? this.permissionMode() : this.permissionMode;
    } catch {
      return 'deny';
    }
  }

}

/**
 * Construct a Plugin-owned interaction broker.
 * @param options - registry, session and permission bridge options
 * @returns a Plugin-owned interaction broker
 */
export function createInteractionBroker(options: InteractionBrokerOptions): InteractionBroker {
  return new InteractionBroker(options);
}
