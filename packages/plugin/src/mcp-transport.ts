import type { McpServer } from '@modelcontextprotocol/server';

import { toolInputSchemas, toolOutputSchemas, type ToolName } from './schemas.js';
import { ToolFacade } from './tool-facade.js';

const descriptions: Record<ToolName, string> = {
  workers_list: 'List available Realm worker engines.',
  worker_describe: 'Describe one Realm worker engine and its capabilities.',
  session_create: 'Create a Realm worker session.',
  session_list: 'List plugin-managed worker sessions.',
  session_get:
    'Read one worker session. The output may carry what the engine reported about itself: `observedConfig` (what the engine says it is running on) is parallel to `config` (what was asked for) and is never merged with it — a key absent from `observedConfig` means the engine did not say, not that the value is unset, and must not be read as the engine agreeing with `config`. `usage` is the session\'s cumulative engine-reported usage and carries no timestamp.',
  session_configure: 'Update a session permission mode or engine configuration.',
  session_fork: 'Fork an idle worker session when the engine supports it.',
  session_close: 'Close a worker session.',
  turn_start: 'Queue a prompt turn and return its stable turn ID.',
  turn_list: 'List prompt turns.',
  turn_get: 'Read one prompt turn.',
  turn_cancel: 'Cancel one prompt turn.',
  transcript_list: 'List live and archived transcripts.',
  transcript_read: 'Read a bounded transcript page.',
  transcript_event_get: 'Read a byte range from one transcript event.',
  transcript_delete: 'Delete a closed or archived transcript.',
  interaction_list: 'List pending or resolved permission/question interactions.',
  interaction_respond: 'Respond once to a permission or question interaction.',
  anchor:
    'Read or replace this instance\'s plan anchor. Omit `content` to read, give it to replace the whole anchor. The text is stored verbatim and never parsed, so nothing in it is filtered — do not put secrets in it. At most 16384 UTF-8 bytes; larger is rejected, not truncated.',
  project_init:
    'Generate this project\'s worker-defaults file from the live engine registry (only installed engines get sections, copied from their own descriptors) and start the console. The file side is idempotent: an existing valid file is returned untouched unless `refresh: true` asks for a merge-regeneration that only appends sections for newly installed engines — no existing key is rewritten or deleted; an existing invalid file is a field-level error, never overwritten. The console start is attempted on every call and reports one of started / already-running / start-failed / disabled / withheld, in that precedence; withheld means this instance could not establish that it is a root, so the console failed closed while the tools keep serving. Not available to a delegated instance, whether the environment marker or its own ancestry established that.',
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

/** Register the exact frozen tool catalog on an MCP server. */
export function registerMcpTools(server: McpServer, facade: ToolFacade): void {
  const registerTool = (server.registerTool as unknown as (...args: unknown[]) => unknown).bind(server);
  for (const name of Object.keys(toolInputSchemas) as ToolName[]) {
    const inputSchema = toolInputSchemas[name] as never;
    const outputSchema = toolOutputSchemas[name] as never;
    registerTool(
      name,
      { description: descriptions[name], inputSchema, outputSchema },
      async (input: unknown) => {
        const result = await facade.invoke(name, input);
        if (result.ok) {
          return { content: [{ type: 'text' as const, text: json(result.output) }], structuredContent: result.output } as never;
        }
        // No `structuredContent` on the error path (ADR 0024). A tool that
        // declares an `outputSchema` is declaring the shape of its *success*,
        // and an error envelope cannot conform to it; the spec's own error
        // example carries `content` and `isError` alone, and the bundled SDK
        // skips output validation once `isError` is set, so the duplicate was
        // read by nobody and validated by nobody. One host validated it anyway
        // and turned every tool error into "structured content does not match
        // the tool's output schema", masking the real code (GZH-36).
        return {
          content: [{ type: 'text' as const, text: json({ error: result.error }) }],
          isError: true,
        } as never;
      },
    );
  }
}
