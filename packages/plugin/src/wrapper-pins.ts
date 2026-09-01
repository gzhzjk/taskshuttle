/**
 * ACP wrapper pins (design §12). The bundled adapters launch their wrappers
 * through an unversioned `npx -y <package>`; the plugin rewrites those args to
 * the exact released versions so a worker never silently picks up a new
 * wrapper. `release/metadata.json` records the same pins and the artifact gate
 * checks the two agree.
 */
export const WRAPPER_PINS: Readonly<Record<string, string>> = Object.freeze({
  'codex-acp': '1.3.0',
  'claude-agent-acp': '0.70.0',
});

export const WRAPPER_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  '@agentclientprotocol/codex-acp': 'codex-acp',
  '@agentclientprotocol/claude-agent-acp': 'claude-agent-acp',
});

/** Replace unversioned wrapper specs with their pinned versions. */
function pinFor(arg: string): string | undefined {
  // Own-property lookups only: `constructor`/`toString`/… must not match.
  if (!Object.hasOwn(WRAPPER_PACKAGES, arg)) return undefined;
  const key = WRAPPER_PACKAGES[arg]!;
  return Object.hasOwn(WRAPPER_PINS, key) ? WRAPPER_PINS[key] : undefined;
}

export function pinWrapperArgs(args: readonly string[]): string[] {
  return args.map((arg) => {
    const version = pinFor(arg);
    return version === undefined ? arg : `${arg}@${version}`;
  });
}

/** True when no *known* wrapper package in the args is still missing its pin. */
export function wrapperArgsArePinned(args: readonly string[]): boolean {
  return !args.some((arg) => pinFor(arg) !== undefined);
}

/** A bare package spec: no `@version`, allowing for a leading scope. */
function isUnversionedSpec(arg: string): boolean {
  if (arg.startsWith('-')) return false;
  const separator = arg.lastIndexOf('@');
  // `@scope/name` has its only `@` at index 0, so it carries no version.
  return separator <= 0;
}

/**
 * Package specs an `npx` launch would resolve to whatever is newest.
 *
 * {@link wrapperArgsArePinned} only sees packages already listed in
 * {@link WRAPPER_PACKAGES}: it answers "did we forget to apply a pin we hold",
 * not "is anything unpinned". While the engine set was frozen those were the
 * same question. With the set open (ADR 0004) an adapter can arrive carrying a
 * wrapper nobody has ever pinned, which the first check cannot see at all — so
 * admission needs this shape-based one instead.
 */
export function unversionedWrapperPackages(command: string, args: readonly string[]): readonly string[] {
  const binary = command.split(/[\\/]/u).pop() ?? command;
  if (binary !== 'npx' && binary !== 'npx.cmd' && binary !== 'pnpx' && binary !== 'bunx') return [];
  return args.filter(isUnversionedSpec);
}
