import { McpServer } from '@modelcontextprotocol/server';
import { readDelegationIdentity } from './security-policy.js';
import { registerMcpTools } from './mcp-transport.js';
import { ToolFacade, type ToolCallResult, type ToolHandlers } from './tool-facade.js';
import type { ToolName } from './schemas.js';
import { PluginRuntime, type RuntimeOptions } from './runtime.js';

export interface TaskShuttleServer {
  server: McpServer;
  runtime: PluginRuntime;
  invoke<Name extends ToolName>(name: Name, input: unknown): Promise<ToolCallResult<Name>>;
  close(): Promise<void>;
}

/** Production stdio entry: one shared schema-first 20-tool catalog for every host. */
export function createTaskShuttleServer(options: RuntimeOptions = {}): TaskShuttleServer {
  // A malformed marker throws here, before any runtime exists — no server is
  // created, and no manifest records the state, which is why `malformed` is not
  // one of the persisted provenances (ADR 0031).
  const identity = readDelegationIdentity(options.env);
  const runtime = new PluginRuntime(identity, options);
  const handlers: ToolHandlers = runtime.handlers();
  // One secret list for logs and tool errors alike: the nonce and the launch token.
  const facade = new ToolFacade(handlers, { secretLiterals: runtime.secretLiterals.filter((literal) => literal.length > 0) });
  const server = new McpServer(
    { name: 'taskshuttle', version: '0.1.0' },
    { instructions: 'Use the 20 TaskShuttle tools to select explicit workers, submit bounded turns, inspect transcripts, and answer interactions. The orchestrator owns workflow decisions.' },
  );
  registerMcpTools(server, facade);
  // Once the host completes the MCP initialize handshake, its self-reported
  // name replaces the platform label as the console's host field.
  server.server.oninitialized = () => {
    void runtime.noteHostIdentity(server.server.getClientVersion()?.name);
  };
  return {
    server,
    runtime,
    invoke: (name, input) => facade.invoke(name, input),
    async close() { await runtime.close(); },
  };
}
