import type {
  AgentDescriptor,
  AgentFailure,
  AgentInteractionRequest,
  AgentInteractionResponse,
  AgentInventory,
  AgentPromptHandle,
  AgentPromptRequest,
  AgentPromptResult,
  AgentSessionHandle,
  AgentSessionRequest,
  TranscriptCanonicalEvent,
  TranscriptEvent,
} from './types.js';
import type { CoreEventSink } from './events.js';

/** Monotonic time source injected by the composition layer. */
export interface Clock {
  readonly now: () => number;
}

/** Opaque identifier source injected by the composition layer. */
export interface IdGenerator {
  readonly next: (kind: string) => string;
}

/**
 * Provider-neutral operations used by Core. The adapter owns all dependency
 * types, process effects, and translation to these DTOs.
 */
export interface AgentProvider {
  readonly inventory: () => Promise<AgentInventory>;
  readonly describe?: (engine: string) => Promise<AgentDescriptor>;
  readonly createSession: (request: AgentSessionRequest) => Promise<AgentSessionHandle | AgentFailure>;
  readonly forkSession?: (session: AgentSessionHandle, targetSessionId?: string) => Promise<AgentSessionHandle | AgentFailure>;
  readonly configureSession?: (session: AgentSessionHandle, config: Readonly<Record<string, string | boolean>>) => Promise<void | AgentFailure>;
  readonly prompt: (request: AgentPromptRequest) => Promise<AgentPromptHandle | AgentPromptResult | AgentFailure>;
  readonly cancelPrompt?: (session: AgentSessionHandle, prompt?: AgentPromptHandle) => Promise<void | AgentFailure>;
  readonly respondInteraction?: (response: AgentInteractionResponse) => Promise<void | AgentFailure>;
  readonly onInteraction?: (listener: (request: AgentInteractionRequest) => void) => () => void;
  readonly closeSession?: (session: AgentSessionHandle) => Promise<void | AgentFailure>;
  readonly shutdown?: () => Promise<void | AgentFailure>;
}

/** Read-side transcript port used by Core pagination semantics. */
export interface TranscriptReader {
  readonly read: (sessionId: string, options?: { fromSeq?: number; toSeq?: number }) => AsyncIterable<TranscriptEvent>;
  readonly canonicalEvent?: (sessionId: string, seq: number) => Promise<TranscriptCanonicalEvent | undefined>;
}

/** Persistence port; paths, SQLite handles, and serialization stay in Plugin. */
export interface TranscriptRepository extends TranscriptReader {
  readonly append: (event: TranscriptEvent) => Promise<void>;
  /** Resolve after all writes already accepted for a session are durable. */
  readonly drain?: (sessionId: string) => Promise<void>;
}

/** Opaque, whole-value anchor persistence port. */
export interface AnchorRepository {
  readonly read: () => Promise<string | undefined>;
  readonly write: (value: string) => Promise<void>;
}

/** Complete effect surface required to compose Core application services. */
export interface CoreEnvironment {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly agents: AgentProvider;
  readonly transcripts: TranscriptRepository;
  readonly anchors: AnchorRepository;
  readonly events?: CoreEventSink;
}
