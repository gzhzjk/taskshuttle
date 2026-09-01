import type { AnchorRecord } from '../anchor-store.js';
import type { NannySnapshot, NannySnapshotInteraction, NannySnapshotTurn } from '../nanny-snapshot.js';

/**
 * What a stopping orchestrator is told, decided from files alone.
 *
 * Kept free of process, filesystem and host concerns so the whole of ADR 0015's
 * tiering can be driven from a literal: the hook's own failures are silent by
 * design (an unreadable state lets the user go, §6 of the design), so a decision
 * that can only be exercised through a real host is a decision nobody tests.
 */

/** Turns listed individually before the rest are folded into a count (ADR 0015 §3). */
export const MAX_LISTED_TURNS = 5;

/**
 * Ceiling on the anchor text handed back, in UTF-8 bytes.
 *
 * The anchor itself may be 16 KiB (ADR 0016 §2), and all of it would land in
 * the orchestrator's context on every stop. A quarter of that is enough to
 * re-anchor a plan; past it the reminder starts costing more than the drift it
 * prevents. Truncation is always announced — see {@link truncateUtf8}.
 */
export const ANCHOR_HANDBACK_MAX_BYTES = 4_096;

/**
 * First line of everything the hook says, block and note alike.
 *
 * A stop fires every hook the user has installed, and a host renders a
 * *successful* block as an error: claude-code prints `Stop hook error:` ahead
 * of the reason for a real block exactly as it does for a hook that crashed.
 * Text that does not name its source is therefore read as some unidentified
 * thing failing — which has now happened twice in real sessions, once when the
 * hook really had failed (ADR 0015's kimi discriminator) and once when it had
 * worked. One line ends the ambiguity, and it stays identical in both
 * decisions so the guard keeps handing back the same text it blocked with.
 */
export const NANNY_PREFIX = 'taskshuttle: a deliberate check on unfinished worker work — not a hook failure.';

export interface NannyHookInput {
  /** The workspace the host stopped in; absent when a host does not supply it. */
  readonly cwd?: string;
  /** The host's own loop guard: true means "you already blocked once". */
  readonly stopHookActive: boolean;
}

export interface NannyState {
  readonly snapshot?: NannySnapshot;
  readonly anchor?: AnchorRecord;
}

export type NannyDecision =
  | { readonly kind: 'pass' }
  | { readonly kind: 'block'; readonly reason: string }
  | { readonly kind: 'note'; readonly message: string };

/**
 * Cut a string to a byte ceiling without splitting a character.
 *
 * A byte-wise slice of UTF-8 can land inside a multi-byte sequence, and the
 * decoder would render the tail as a replacement character — a silent
 * corruption of text the plugin promised to keep opaque. Continuation bytes are
 * `10xxxxxx`, so walking back off them lands on a character boundary.
 *
 * @param value - the text to cut.
 * @param maxBytes - ceiling in UTF-8 bytes.
 * @returns the text and whether anything was removed.
 */
export function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

/** Human-readable elapsed time; the hook reports duration, never wall-clock timestamps it did not observe. */
function elapsed(startedAt: string | undefined, now: number): string {
  if (startedAt === undefined) return 'unknown';
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return 'unknown';
  const seconds = Math.max(0, Math.round((now - started) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * design §8: only report work in the workspace the host stopped in.
 *
 * When the host supplies no cwd there is nothing to filter on. Reporting
 * everything is then the right failure: an extra line about another workspace
 * is noise, while dropping the turns would leave the orchestrator believing
 * nothing is running — the one direction this signal may not fail in.
 */
function inWorkspace(turns: readonly NannySnapshotTurn[], cwd: string | undefined): NannySnapshotTurn[] {
  if (cwd === undefined) return [...turns];
  return turns.filter((turn) => turn.cwd === cwd);
}

function describeTurns(turns: readonly NannySnapshotTurn[], now: number): string[] {
  const lines = turns.slice(0, MAX_LISTED_TURNS).map((turn) =>
    `  - turn ${turn.turnId} (session ${turn.sessionId}, ${turn.engine}, ${turn.state}, running ${elapsed(turn.startedAt, now)})`);
  const hidden = turns.length - Math.min(turns.length, MAX_LISTED_TURNS);
  if (hidden > 0) lines.push(`  - …and ${hidden} more`);
  return lines;
}

function describeInteractions(interactions: readonly NannySnapshotInteraction[]): string[] {
  return interactions.slice(0, MAX_LISTED_TURNS).map((interaction) => {
    const expiry = interaction.expiresAt === undefined ? 'no TTL configured' : `expires ${interaction.expiresAt}`;
    return `  - ${interaction.kind} ${interaction.interactionId} on turn ${interaction.turnId} (${expiry})`;
  });
}

/**
 * `turnsDispatched - turnsAtWrite`, or nothing.
 *
 * Both halves are on disk because the hook is a separate process (ADR 0016
 * §5.2). The instance ids must match: two different instances' counters have no
 * relation, and subtracting them would produce a number that looks like a
 * measurement. When the snapshot is missing the anchor still goes back, just
 * without this line — ANCHOR-017 pins that it is neither skipped nor guessed.
 */
function turnsSinceUpdate(state: NannyState): number | undefined {
  const { snapshot, anchor } = state;
  if (snapshot === undefined || anchor === undefined) return undefined;
  if (snapshot.instanceId !== anchor.instanceId) return undefined;
  const since = snapshot.turnsDispatched - anchor.turnsAtWrite;
  return since >= 0 ? since : undefined;
}

function describeAnchor(state: NannyState): string[] {
  const { anchor } = state;
  if (anchor === undefined) return [];
  const { text, truncated } = truncateUtf8(anchor.content, ANCHOR_HANDBACK_MAX_BYTES);
  const lines = ['Your task anchor, as you last wrote it:', text];
  // Saying so matters more than the truncation: an orchestrator that believes
  // it is looking at the whole plan will act on the half it can see.
  if (truncated) lines.push(`[anchor truncated to ${ANCHOR_HANDBACK_MAX_BYTES} bytes of ${Buffer.byteLength(anchor.content, 'utf8')}; read the rest with the anchor tool]`);
  const since = turnsSinceUpdate(state);
  if (since !== undefined) lines.push(`You have dispatched ${since} turn(s) since you last updated it.`);
  return lines;
}

/**
 * Decide what to tell a host whose orchestrator has stopped.
 *
 * @param input - the host's stop payload, normalised.
 * @param state - what could be read from disk; anything unreadable is absent.
 * @param now - epoch millis, injected so elapsed times are deterministic in tests.
 * @returns pass (silence), block (one interruption), or note (say it, do not hold).
 */
export function decide(input: NannyHookInput, state: NannyState, now: number): NannyDecision {
  const active = inWorkspace(state.snapshot?.active ?? [], input.cwd);
  // An interaction carries no cwd of its own; it belongs to the workspace of
  // the turn it blocks. One whose turn is in no snapshot at all is kept rather
  // than dropped — the turn is what went missing, not the question.
  const inScope = new Set(active.map((turn) => turn.turnId));
  const known = new Set((state.snapshot?.active ?? []).map((turn) => turn.turnId));
  const pending = (state.snapshot?.pendingInteractions ?? []).filter(
    (interaction) => inScope.has(interaction.turnId) || !known.has(interaction.turnId));

  const sections: string[] = [];
  if (pending.length > 0) {
    // Pending first: a running turn needs time, a pending interaction needs
    // *you*, and letting its TTL run out fails the whole turn (mvp §8.3).
    sections.push(
      `${pending.length} interaction(s) are waiting on you — nothing moves until you answer:`,
      ...describeInteractions(pending),
      'If one expires the whole turn ends as failed/INTERACTION_TIMEOUT, the other interactions on it are invalidated and the Realm prompt is cancelled. Answer with interaction_respond.',
    );
  }
  if (active.length > 0) {
    sections.push(
      `${active.length} turn(s) are still running:`,
      ...describeTurns(active, now),
      'Decide: wait and poll turn_get, cancel with turn_cancel, or finish anyway. Deciding is yours; not noticing is not.',
    );
  }
  sections.push(...describeAnchor(state));

  if (sections.length === 0) return { kind: 'pass' };
  const body = [NANNY_PREFIX, ...sections].join('\n');
  // The loop guard outranks every block condition, pending interactions
  // included (ADR 0015 §3): repeated blocking cannot stop a TTL, but it can
  // lock the user in. Nothing is dropped — the same text goes out as a note.
  if (input.stopHookActive) return { kind: 'note', message: body };
  return { kind: 'block', reason: body };
}
