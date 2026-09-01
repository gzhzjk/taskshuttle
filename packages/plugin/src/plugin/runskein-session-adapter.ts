import {
  type Hub,
  type Session,
  type PermissionPolicy,
} from 'runskein';

import type { CwdPolicy } from '../cwd-boundary.js';

export interface LegacySessionRequest {
  readonly engine: string;
  readonly cwd: string;
  readonly mcpServerIds: readonly string[];
  readonly permissionMode: string;
  readonly systemInstructions?: string;
  readonly config: Readonly<Record<string, string | boolean>>;
}

export interface LegacyRunskeinHub {
  readonly session: Hub['session'];
}

/**
 * Transitional Plugin-owned Runskein session adapter.
 *
 * The package-side `RunskeinAgentProvider` is the provider-neutral Core port.
 * This narrow companion lets the current PluginRuntime move the final spawn
 * window first without making the legacy registry depend on Core internals.
 */
export class RunskeinSessionAdapter {
  constructor(
    private readonly hub: LegacyRunskeinHub,
    private readonly cwdPolicy: CwdPolicy,
    private readonly resolveMcpServers: ((ids: readonly string[]) => readonly unknown[]) | undefined = undefined,
  ) {}

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

  /** Re-resolve, verify, and spawn with no await or callback between the two. */
  async openSession(request: LegacySessionRequest, permissionPolicy: PermissionPolicy): Promise<Session> {
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
    return await sessionPromise;
  }
}
