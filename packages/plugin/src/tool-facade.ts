import { mapError, type PluginError } from './error-mapper.js';
import {
  parseToolInput,
  parseToolOutput,
  toolInputSchemas,
  type ToolInput,
  type ToolName,
  type ToolOutput,
} from './schemas.js';

export type ToolHandler<Name extends ToolName = ToolName> = (input: ToolInput<Name>) => ToolOutput<Name> | Promise<ToolOutput<Name>>;

export type ToolHandlers = Partial<{ [Name in ToolName]: ToolHandler<Name> }>;

export type ToolCallResult<Name extends ToolName = ToolName> =
  | { ok: true; output: ToolOutput<Name> }
  | { ok: false; error: PluginError };

function invalidInput(name: string, error: unknown): PluginError {
  const issues = typeof error === 'object' && error !== null && 'issues' in error && Array.isArray(error.issues) ? error.issues : undefined;
  return {
    code: 'INVALID_ARGUMENT',
    message: `invalid input for ${name}`,
    ...(issues === undefined ? {} : { details: { issues } }),
    cause: { name: 'ValidationError', message: 'tool input schema rejected the request', operation: `tool/${name}/input` },
  };
}

function invalidOutput(name: string, error: unknown): PluginError {
  const issues = typeof error === 'object' && error !== null && 'issues' in error && Array.isArray(error.issues) ? error.issues : undefined;
  return {
    // ADR 0027: the plugin's declared contract and its own handler have
    // drifted apart. No store is on this path, and no caller argument is
    // either — this is ours, and unattributable beyond that.
    code: 'INTERNAL',
    message: `handler returned invalid output for ${name}`,
    ...(issues === undefined ? {} : { details: { issues } }),
    cause: { name: 'ValidationError', message: 'tool output schema rejected the handler result', operation: `tool/${name}/output` },
  };
}

/** Schema-first dispatch boundary shared by MCP and native host adapters. */
export class ToolFacade {
  private readonly handlers: ToolHandlers;
  private readonly secretLiterals: readonly string[];

  constructor(handlers: ToolHandlers = {}, options: { secretLiterals?: readonly string[] } = {}) {
    this.handlers = { ...handlers };
    this.secretLiterals = options.secretLiterals ?? [];
  }

  async invoke<Name extends ToolName>(name: Name, input: unknown): Promise<ToolCallResult<Name>> {
    if (!(name in toolInputSchemas)) {
      return { ok: false, error: { code: 'INVALID_ARGUMENT', message: `unknown tool '${String(name)}'` } };
    }
    let parsed: ToolInput<Name>;
    try {
      parsed = parseToolInput(name, input);
    } catch (cause) {
      return { ok: false, error: invalidInput(name, cause) };
    }
    const handler = this.handlers[name] as ToolHandler<Name> | undefined;
    if (handler === undefined) {
      return { ok: false, error: { code: 'NOT_SUPPORTED', message: `tool '${name}' is not available in this runtime` } };
    }
    let output: ToolOutput<Name>;
    try {
      output = await handler(parsed);
    } catch (cause) {
      return {
        ok: false,
        error: mapError(cause, { operation: `tool/${name}`, secretLiterals: this.secretLiterals }),
      };
    }
    try {
      return { ok: true, output: parseToolOutput(name, output) };
    } catch (cause) {
      return { ok: false, error: invalidOutput(name, cause) };
    }
  }
}
