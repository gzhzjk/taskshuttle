/**
 * Type declarations for the shared line diff (diff-lines.js). The inputs are
 * `unknown` because both callers apply `String(... ?? '')` semantics: the UI
 * renders whatever engines report, and the diff index reads the same wire.
 */

export interface DiffLine {
  readonly t: 'ctx' | 'add' | 'del';
  readonly x: string;
}

export function diffLines(oldText: unknown, newText: unknown): DiffLine[];
