import { spawn } from 'node:child_process';

import type { ArgvCommand } from './index.js';

/** Command execution options with secrets kept out of argv and diagnostics. */
export interface ArgvRunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly secretEnvKeys?: readonly string[];
}

export interface ArgvRunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function assertArgv(command: ArgvCommand): void {
  if (typeof command.binary !== 'string' || command.binary.length === 0 || command.binary.includes('\0')) throw new Error('command binary must be a non-empty path');
  if (/^(?:sh|bash|zsh|cmd|powershell)(?:\.exe)?$/iu.test(command.binary)) throw new Error('shell binaries are not allowed');
  if (command.argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('command argv contains an invalid value');
  if (command.argv.some((arg) => /^(?:sh|bash|zsh|cmd|powershell)(?:\.exe)?$/iu.test(arg))) throw new Error('shell binaries are not allowed');
}

/** Run a binary with argv and shell disabled; timeout and env are explicit. */
export function runArgv(command: ArgvCommand, options: ArgvRunOptions = {}): Promise<ArgvRunResult> {
  assertArgv(command);
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) throw new RangeError('timeoutMs must be an integer in 1..900000');
  const secretKeys = new Set(options.secretEnvKeys ?? []);
  for (const key of secretKeys) if (!(key in (options.env ?? {}))) throw new Error(`secret environment key '${key}' is not present`);
  return new Promise((resolve, reject) => {
    const child = spawn(command.binary, [...command.argv], { cwd: options.cwd, env: options.env === undefined ? undefined : { ...options.env }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`command '${command.binary}' exceeded ${timeoutMs}ms`)); }, timeoutMs);
    child.once('error', (cause) => { clearTimeout(timer); reject(cause); });
    child.once('close', (status) => { clearTimeout(timer); resolve({ status: status ?? 1, stdout, stderr }); });
  });
}
