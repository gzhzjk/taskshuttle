/** Provider-neutral engine identity. The registry remains open to new engines. */
export type EngineId = string;

export type SessionState = 'creating' | 'idle' | 'busy' | 'failed' | 'closing' | 'closed';
export type TurnState = 'queued' | 'running' | 'awaiting-interaction' | 'completed' | 'failed' | 'cancelled';
export type InteractionState = 'pending' | 'responded' | 'expired' | 'invalidated';
export type Priority = 'high' | 'normal' | 'low';
export type PermissionMode = 'deny' | 'ask-orchestrator' | 'allow';

/** Provider-neutral prompt blocks; the Plugin validates the wire shape. */
export type PromptBlock =
  | Readonly<{ type: 'text'; text: string; [key: string]: unknown }>
  | Readonly<{ type: 'image'; data: string; mimeType: string; [key: string]: unknown }>
  | Readonly<{ type: 'resource_link'; name: string; uri: string; [key: string]: unknown }>
  | Readonly<{ type: 'resource'; resource: Readonly<{ uri: string; text: string }>; [key: string]: unknown }>;

/** Provider-neutral descriptor facts supplied by the composition layer. */
export interface AgentDescriptor {
  readonly id: EngineId;
  readonly displayName?: string;
  readonly capabilities: readonly string[];
}

export interface AgentInventory {
  readonly agents: readonly AgentDescriptor[];
}

/** Opaque provider session identity; Core never interprets its value. */
export interface AgentSessionHandle {
  readonly providerSessionId: string;
}

/** Opaque provider prompt identity returned when a prompt is accepted. */
export interface AgentPromptHandle {
  readonly providerPromptId: string;
}

export interface AgentSessionRequest {
  /** Core's opaque session id, supplied only so an adapter can bind effects. */
  readonly sessionId?: string;
  readonly engine: EngineId;
  readonly cwd: string;
  readonly name?: string;
  readonly systemInstructions?: string;
  readonly mcpServerIds: readonly string[];
  readonly permissionMode: PermissionMode;
  readonly config: Readonly<Record<string, string | boolean>>;
}

export interface AgentPromptRequest {
  readonly session: AgentSessionHandle;
  readonly content: readonly unknown[];
}

/** One provider update copied losslessly into the Core transcript port. */
export interface AgentProviderUpdate {
  readonly update: unknown;
  readonly usage?: Readonly<Record<string, unknown>>;
}

/** A provider update remains opaque and is copied losslessly into the transcript port. */
export interface AgentPromptResult {
  readonly updates: readonly AgentProviderUpdate[];
  readonly stopReason?: string;
  readonly usage?: Readonly<Record<string, unknown>>;
  readonly quota?: unknown;
}

export interface AgentInteractionRequest {
  readonly providerRequestId: string;
  readonly kind: 'permission' | 'question';
  readonly payload: unknown;
}

export interface AgentInteractionResponse {
  /** Core-owned interaction id; lets the adapter carry provider ids opaquely. */
  readonly interactionId?: string;
  readonly providerRequestId: string;
  readonly value: unknown;
}

/** Normalized provider failure; upstream error classes never cross this boundary. */
export interface AgentFailure {
  readonly operation: string;
  readonly message: string;
  /** Provider-neutral classification retained when a failure also releases a reservation. */
  readonly code?: 'permission-denied' | 'recursion-denied' | 'invalid-input' | 'provider-failure';
  /** True when the adapter proved that no provider process/session was spawned. */
  readonly preSpawn?: boolean;
  readonly kind?: string;
}

/**
 * The canonical event shape retained by Plugin storage and returned by Core.
 * `update` is intentionally opaque so a newer provider can be read by an older
 * archive consumer without an invented normalization layer.
 */
export interface TranscriptEvent {
  readonly seq: number;
  readonly ts: number;
  readonly sessionId: string;
  readonly engineId: string;
  readonly update: unknown;
  readonly usage?: Readonly<Record<string, unknown>>;
}

export interface TranscriptCanonicalEvent {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface CoreSessionId {
  readonly id: string;
}

export interface CoreTurnId {
  readonly id: string;
}
