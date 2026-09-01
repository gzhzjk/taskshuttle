import type {
  AgentDescriptor,
  AgentFailure,
  AgentInteractionRequest,
  AgentInteractionResponse,
  AgentInventory,
  AgentPromptHandle,
  AgentPromptRequest,
  AgentPromptResult,
  AgentProvider,
  AgentSessionHandle,
  AgentSessionRequest,
  AgentProviderUpdate,
} from '@taskshuttle/core';
import {
  type Hub,
  type Session,
  policies,
  type Answer,
  type ContentBlock,
  type EngineDescriptor,
  type PermissionPolicy,
  type TranscriptEvent as RunskeinTranscriptEvent,
} from 'runskein';

import type { CwdEvidence, CwdPolicy } from './cwd-boundary.js';

/** Lifecycle hooks let the composition root attach Plugin-owned observers to a provider session. */
export interface RunskeinSessionLifecycle {
  readonly bound?: (sessionId: string | undefined, session: Session) => void;
  readonly closed?: (providerSessionId: string) => void;
}

/** A minimal Hub surface keeps the adapter testable without exposing internals. */
export interface RunskeinHub {
  readonly engines: Hub['engines'];
  readonly describe: Hub['describe'];
  readonly session: Hub['session'];
  readonly quit: Hub['quit'];
}

export interface RunskeinAdapterOptions {
  readonly hub: RunskeinHub;
  readonly cwdPolicy: CwdPolicy;
  /** Resolve catalogued MCP ids into Runskein's validated server descriptors. */
  readonly resolveMcpServers?: (ids: readonly string[]) => readonly unknown[];
  /** Build the async permission policy after Core has accepted a session. */
  readonly permissionPolicy?: (request: AgentSessionRequest, sessionId?: string) => PermissionPolicy;
  /** Prepare Plugin-owned interaction state after descriptor lookup and before cwd verification. */
  readonly prepareSession?: (request: AgentSessionRequest) => void;
  /** Receive normalized provider interactions without importing Runskein types. */
  readonly interactionListener?: (request: AgentInteractionRequest) => void;
  /** Answer permission requests when the composition layer owns that broker. */
  readonly permissionResponder?: (requestId: string, value: unknown) => Promise<void>;
  /** Bind provider sessions to Plugin-owned session ids without leaking Runskein types into Core. */
  readonly sessionLifecycle?: RunskeinSessionLifecycle;
}

interface SessionBinding {
  readonly session: Session;
  readonly removeListeners: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function failure(error: unknown, operation: string): AgentFailure {
  const record = isRecord(error) ? error : undefined;
  const message = error instanceof Error ? error.message : record !== undefined && typeof record.message === 'string' ? record.message : String(error);
  const explicitKind = record !== undefined && typeof record.kind === 'string' && /^[a-z][a-z0-9-]*$/u.test(record.kind)
    ? record.kind
    : undefined;
  const code = record !== undefined && typeof record.code === 'string' ? record.code : undefined;
  const kind = explicitKind ?? (operation === 'session/create'
    ? code === 'PERMISSION_DENIED' ? 'permission-denied'
      : code === 'RECURSION_DENIED' ? 'recursion-denied'
        : code === 'INVALID_ARGUMENT' ? 'invalid-input'
          : ['SecurityPolicyError', 'NotInstalledError', 'UnauthenticatedError', 'ConfigError'].includes(error instanceof Error ? error.name : '') ? 'not-created' : 'may-have-created'
    : undefined);
  const normalizedCode = code === 'PERMISSION_DENIED' ? 'permission-denied'
    : code === 'RECURSION_DENIED' ? 'recursion-denied'
      : code === 'INVALID_ARGUMENT' ? 'invalid-input'
        : undefined;
  return { operation, message, ...(normalizedCode === undefined ? {} : { code: normalizedCode }), ...(kind === undefined ? {} : { kind }) };
}

function capabilities(descriptor: EngineDescriptor): readonly string[] {
  const output: string[] = [];
  for (const [group, values] of Object.entries(descriptor.capabilities)) {
    for (const [name, supported] of Object.entries(values)) {
      if (supported === true) output.push(`${group}.${name}`);
    }
  }
  return output.sort();
}

function answer(value: unknown): Answer | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.text === 'string') return { text: value.text };
  if (typeof value.optionId === 'string') return { optionId: value.optionId };
  return undefined;
}

function update(event: RunskeinTranscriptEvent): AgentProviderUpdate {
  return {
    update: event.update,
    ...(event.usage === undefined ? {} : { usage: event.usage as unknown as Readonly<Record<string, unknown>> }),
  };
}

/**
 * Runskein composition adapter for the provider-neutral Core port.
 *
 * This class is the sole translation point for Runskein descriptors, sessions,
 * transcript updates, usage, interactions, and dependency failures. It also
 * owns the final cwd re-resolution/verification window: `verifyCwdBeforeSpawn`
 * and `hub.session` are adjacent in `openSession`, with no Core callback or
 * awaited operation between them.
 */
export class RunskeinAgentProvider implements AgentProvider {
  private readonly hub: RunskeinHub;
  private readonly cwdPolicy: CwdPolicy;
  private readonly resolveMcpServers: ((ids: readonly string[]) => readonly unknown[]) | undefined;
  private readonly permissionPolicy: (request: AgentSessionRequest, sessionId?: string) => PermissionPolicy;
  private readonly prepareSession: ((request: AgentSessionRequest) => void) | undefined;
  private readonly interactionListeners = new Set<(request: AgentInteractionRequest) => void>();
  private readonly permissionResponder: ((requestId: string, value: unknown) => Promise<void>) | undefined;
  private readonly sessionLifecycle: RunskeinSessionLifecycle;
  private readonly sessions = new Map<string, SessionBinding>();
  private readonly descriptors = new Map<string, AgentDescriptor>();
  private interactionSequence = 0;

  constructor(options: RunskeinAdapterOptions) {
    this.hub = options.hub;
    this.cwdPolicy = options.cwdPolicy;
    this.resolveMcpServers = options.resolveMcpServers;
    this.permissionPolicy = options.permissionPolicy ?? (() => policies.denyAll);
    this.prepareSession = options.prepareSession;
    if (options.interactionListener !== undefined) this.interactionListeners.add(options.interactionListener);
    this.permissionResponder = options.permissionResponder;
    this.sessionLifecycle = options.sessionLifecycle ?? {};
  }

  /** Resolve MCP ids without silently dropping a caller's requested servers. */
  private mcpServers(ids: readonly string[]): readonly unknown[] | undefined {
    if (ids.length === 0) return undefined;
    if (this.resolveMcpServers === undefined) {
      throw new Error('MCP server resolver is not configured');
    }
    const servers = this.resolveMcpServers(ids);
    if (servers.length !== ids.length) {
      throw new Error('MCP server resolver returned an incomplete server list');
    }
    return servers;
  }

  /** Return normalized inventory facts without exposing Runskein descriptors. */
  async inventory(): Promise<AgentInventory> {
    try {
      const infos = await this.hub.engines();
      return {
        agents: infos.flatMap((info) => info.id === undefined ? [] : [{ id: info.id, capabilities: [] }]),
      };
    } catch (error) {
      throw failure(error, 'agents/inventory');
    }
  }

  /** Describe one engine and flatten its capability matrix into stable paths. */
  async describe(engine: string): Promise<AgentDescriptor> {
    const cached = this.descriptors.get(engine);
    if (cached !== undefined) return cached;
    try {
      const descriptor = await this.hub.describe(engine);
      const normalized = { id: engine, capabilities: capabilities(descriptor) };
      this.descriptors.set(engine, normalized);
      return normalized;
    } catch (error) {
      throw failure(error, 'agents/describe');
    }
  }

  /**
   * Create a provider session after the final Plugin-owned cwd check.
   *
   * Descriptor and permission-policy construction happen before cwd
   * verification; the final `verify` and `hub.session` calls intentionally
   * remain adjacent to preserve the narrowed TOCTOU window.
   */
  async createSession(request: AgentSessionRequest): Promise<AgentSessionHandle | AgentFailure> {
    let spawnAttempted = false;
    try {
      await this.describe(request.engine);
      this.prepareSession?.(request);
      const permissionPolicy = this.permissionPolicy(request, request.sessionId);
      const mcpServers = this.mcpServers(request.mcpServerIds);
      const cwd = await this.cwdPolicy.resolveCwd(request.cwd);
      await this.cwdPolicy.verifyCwdBeforeSpawn(cwd);
      const sessionPromise = this.hub.session({
        engine: request.engine,
        cwd: cwd.path,
        permissionPolicy,
        ...(request.systemInstructions === undefined ? {} : { systemInstructions: request.systemInstructions }),
        ...(request.config === undefined || Object.keys(request.config).length === 0 ? {} : { config: { ...request.config } }),
        ...(mcpServers === undefined ? {} : { mcpServers: mcpServers as never }),
      });
      spawnAttempted = true;
      const session = await sessionPromise;
      this.bindSession(session);
      this.sessionLifecycle.bound?.(request.sessionId, session);
      return { providerSessionId: session.id };
    } catch (error) {
      const normalized = failure(error, 'session/create');
      return spawnAttempted
        ? normalized
        : { ...normalized, preSpawn: true };
    }
  }

  /** Open a session for the legacy PluginRuntime while it is being extracted. */
  async openSession(request: AgentSessionRequest, permissionPolicy: PermissionPolicy): Promise<Session> {
    const mcpServers = this.mcpServers(request.mcpServerIds);
    const cwd = await this.cwdPolicy.resolveCwd(request.cwd);
    await this.cwdPolicy.verifyCwdBeforeSpawn(cwd);
    const sessionPromise = this.hub.session({
      engine: request.engine,
      cwd: cwd.path,
      permissionPolicy,
      ...(request.systemInstructions === undefined ? {} : { systemInstructions: request.systemInstructions }),
      ...(Object.keys(request.config).length === 0 ? {} : { config: { ...request.config } }),
      ...(mcpServers === undefined ? {} : { mcpServers: mcpServers as never }),
    });
    const session = await sessionPromise;
    this.bindSession(session);
    return session;
  }

  /** Return the opaque provider session handle for an existing Runskein id. */
  private binding(handle: AgentSessionHandle): SessionBinding | AgentFailure {
    const binding = this.sessions.get(handle.providerSessionId);
    return binding ?? failure(new Error(`provider session '${handle.providerSessionId}' was not found`), 'session/lookup');
  }

  /**
   * Adopt a session created by the transitional Plugin fork path.
   *
   * The old fork handler still owns its visibility/config-replay semantics,
   * but Core owns the close operation. Registering the binding here gives the
   * Core close port the same provider handle without duplicating lifecycle
   * observers that the legacy handler already installed.
   * @param sessionId - Plugin/Core session id used for diagnostics
   * @param session - provider session to retain for later Core operations
   * @returns void; the opaque provider id is retained internally
   */
  adoptSession(sessionId: string, session: Session): void {
    this.bindSession(session);
    // The binding lookup is by provider id; the session id is intentionally
    // not stored because provider ids are opaque to Core.
    void sessionId;
  }

  /** Attach interaction listeners once; prompt callers collect raw updates for their turn. */
  private bindSession(session: Session): void {
    if (this.sessions.has(session.id)) return;
    const offPermission = session.on('permission', (request) => {
      const providerRequestId = `${session.id}:permission:${++this.interactionSequence}`;
      this.emitInteraction({ providerRequestId, kind: 'permission', payload: request });
    });
    const offQuestion = session.on('question', (request) => {
      this.emitInteraction({ providerRequestId: `${session.id}:question:${request.requestId}`, kind: 'question', payload: request });
    });
    this.sessions.set(session.id, { session, removeListeners: () => { offPermission(); offQuestion(); } });
  }

  private emitInteraction(request: AgentInteractionRequest): void {
    for (const listener of this.interactionListeners) {
      try { listener(request); } catch { /* a Core observer cannot break the engine callback */ }
    }
  }

  async forkSession(handle: AgentSessionHandle, targetSessionId?: string): Promise<AgentSessionHandle | AgentFailure> {
    const binding = this.binding(handle);
    if ('operation' in binding) return binding;
    try {
      const child = await binding.session.fork();
      this.bindSession(child);
      this.sessionLifecycle.bound?.(targetSessionId, child);
      return { providerSessionId: child.id };
    } catch (error) {
      return failure(error, 'session/fork');
    }
  }

  async configureSession(handle: AgentSessionHandle, config: Readonly<Record<string, string | boolean>>): Promise<void | AgentFailure> {
    const binding = this.binding(handle);
    if ('operation' in binding) return binding;
    try {
      await binding.session.setConfig({ ...config });
    } catch (error) {
      return failure(error, 'session/configure');
    }
  }

  async prompt(request: AgentPromptRequest): Promise<AgentPromptHandle | AgentPromptResult | AgentFailure> {
    const binding = this.binding(request.session);
    if ('operation' in binding) return binding;
    const updates: AgentProviderUpdate[] = [];
    const off = binding.session.on('update', (event) => updates.push(update(event)));
    try {
      const result = await binding.session.prompt(request.content as ContentBlock[]);
      return {
        updates,
        stopReason: result.stopReason,
        ...(result.usage === undefined ? {} : { usage: result.usage as unknown as Readonly<Record<string, unknown>> }),
        ...(result.quota === undefined ? {} : { quota: result.quota }),
      };
    } catch (error) {
      return failure(error, 'session/prompt');
    } finally {
      off();
    }
  }

  async cancelPrompt(handle: AgentSessionHandle): Promise<void | AgentFailure> {
    const binding = this.binding(handle);
    if ('operation' in binding) return binding;
    try {
      await binding.session.cancel();
    } catch (error) {
      return failure(error, 'session/cancel');
    }
  }

  async respondInteraction(response: AgentInteractionResponse): Promise<void | AgentFailure> {
    const separator = response.providerRequestId.indexOf(':');
    const sessionId = separator < 0 ? response.providerRequestId : response.providerRequestId.slice(0, separator);
    const binding = this.sessions.get(sessionId);
    if (binding === undefined) {
      return failure(new Error(`provider session '${sessionId}' was not found`), 'interaction/respond');
    }
    try {
      const parsed = answer(response.value);
      if (parsed !== undefined && response.providerRequestId.includes(':question:')) {
        await binding.session.respond(response.providerRequestId.slice(response.providerRequestId.lastIndexOf(':') + 1), parsed);
      } else if (this.permissionResponder !== undefined) {
        await this.permissionResponder(response.providerRequestId, response.value);
      } else {
        return failure(new Error('permission responder is not configured'), 'interaction/respond');
      }
    } catch (error) {
      return failure(error, 'interaction/respond');
    }
  }

  onInteraction(listener: (request: AgentInteractionRequest) => void): () => void {
    this.interactionListeners.add(listener);
    return () => { this.interactionListeners.delete(listener); };
  }

  async closeSession(handle: AgentSessionHandle): Promise<void | AgentFailure> {
    const binding = this.binding(handle);
    if ('operation' in binding) return binding;
    try {
      await binding.session.close();
      binding.removeListeners();
      this.sessions.delete(handle.providerSessionId);
      this.sessionLifecycle.closed?.(handle.providerSessionId);
    } catch (error) {
      return failure(error, 'session/close');
    }
  }

  async shutdown(): Promise<void | AgentFailure> {
    try {
      await this.hub.quit();
      for (const binding of this.sessions.values()) binding.removeListeners();
      this.sessions.clear();
    } catch (error) {
      return failure(error, 'agents/shutdown');
    }
  }
}
