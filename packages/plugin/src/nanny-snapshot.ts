import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { InteractionRecord, RegistryObserver, SessionRecord, TurnRecord } from '@taskshuttle/core';
import type { EngineId, TurnState } from '@taskshuttle/core';

/**
 * The nanny snapshot (ADR 0015 Decision 2, amended by ADR 0016 §5.2).
 *
 * The Stop hook is a process the host forks; it has no MCP client and cannot
 * reach `turn_list`, so the one fact it needs — is there unfinished work — has
 * to be on disk. This module owns that file: it observes registry transitions
 * and replaces the file with the current picture.
 *
 * Everything here is derived state. The in-memory registry and the transcript
 * store stay authoritative; a snapshot that is missing, stale or corrupt must
 * never change what the plugin answers.
 */

/** Instance-directory file name; the hook derives it the same way. */
export const NANNY_SNAPSHOT_FILE = 'nanny.json';

/** Turn states that mean "still owed work". Terminal turns never reach the file. */
const ACTIVE_TURN_STATES: ReadonlySet<TurnState> = new Set<TurnState>(['queued', 'running', 'awaiting-interaction']);


/** One non-terminal turn. Ids, an enum and timestamps — no prompt, no output. */
export interface NannySnapshotTurn {
  readonly turnId: string;
  readonly sessionId: string;
  readonly engine: EngineId;
  readonly state: TurnState;
  /** The owning session's cwd: the hook reports only turns in its own workspace. */
  readonly cwd: string;
  /** Absent while the turn is still queued. */
  readonly startedAt?: string;
}

/** One unanswered interaction — the stronger signal: without an answer it never moves. */
export interface NannySnapshotInteraction {
  readonly interactionId: string;
  readonly turnId: string;
  readonly kind: InteractionRecord['kind'];
  /** Absent when the install disabled the interaction TTL. */
  readonly expiresAt?: string;
}

/**
 * The frozen on-disk shape: ids, enum states, timestamps, and one monotone
 * counter. Prompts, transcripts and worker output cannot be represented here,
 * which is the point — the boundary is structural, not a rule to remember.
 */
export interface NannySnapshot {
  readonly instanceId: string;
  readonly updatedAt: string;
  /**
   * Diagnostic only, by ADR 0015: ordering is guaranteed by the single writer
   * below, so a reader that compared `seq` to decide which of two snapshots is
   * newer would be leaning on the wrong thing. Nothing may branch on it.
   */
  readonly seq: number;
  /**
   * Turns dispatched by this instance since it started, only ever increasing.
   * The anchor record stores this counter's value at the moment it was
   * written, and the hook subtracts the two to say how many turns went by since
   * the orchestrator last touched its plan (ADR 0016). It is deliberately not
   * derived from the turn records: those are subject to retention, and a count
   * that shrinks as records are evicted would read as "no drift here".
   */
  readonly turnsDispatched: number;
  readonly active: readonly NannySnapshotTurn[];
  readonly pendingInteractions: readonly NannySnapshotInteraction[];
}

/**
 * The slice of `SessionRegistry` the writer reads. Narrowed so the snapshot can
 * be tested without standing up a registry, and so it is obvious that the
 * writer only ever reads.
 */
export interface NannySnapshotSource {
  listTurns(sessionId?: string): TurnRecord[];
  listInteractions(turnId?: string): InteractionRecord[];
  getSession(id: string): SessionRecord | undefined;
}

export interface NannySnapshotWriterOptions {
  readonly instanceId: string;
  /** The instance directory; the snapshot lives beside `instance.json`. */
  readonly instanceDir: string;
  readonly source: NannySnapshotSource;
  /**
   * The instance's dispatched-turn counter, read live.
   *
   * This writer deliberately does not keep a count of its own. The anchor
   * record's `turnsAtWrite` and this snapshot's `turnsDispatched` are
   * subtracted by the hook, so they have to be readings of one counter taken at
   * two times; two counters incrementing on different events produce a
   * difference that means nothing and can go negative. The runtime owns it.
   */
  readonly turnsDispatched: () => number;
  readonly now?: () => string;
  /**
   * Reported write failures. A failed write leaves the previous snapshot in
   * place and is otherwise not escalated: the hook fails open, so a stale or
   * missing snapshot costs a reminder, never correctness.
   */
  readonly onError?: (error: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function validTurn(value: unknown): value is NannySnapshotTurn {
  if (!isRecord(value)) return false;
  return typeof value['turnId'] === 'string' && typeof value['sessionId'] === 'string'
    && typeof value['engine'] === 'string' && typeof value['cwd'] === 'string'
    // Only non-terminal turns are ever written, so anything else came from a
    // file this reader does not understand — absent, not half-understood.
    && ACTIVE_TURN_STATES.has(value['state'] as TurnState)
    && optionalString(value['startedAt']);
}

function validInteraction(value: unknown): value is NannySnapshotInteraction {
  if (!isRecord(value)) return false;
  return typeof value['interactionId'] === 'string' && typeof value['turnId'] === 'string'
    && (value['kind'] === 'permission' || value['kind'] === 'question')
    && optionalString(value['expiresAt']);
}

function validSnapshot(value: unknown): value is NannySnapshot {
  if (!isRecord(value)) return false;
  if (typeof value['instanceId'] !== 'string' || typeof value['updatedAt'] !== 'string') return false;
  if (!Number.isInteger(value['seq'])) return false;
  if (!Number.isInteger(value['turnsDispatched']) || (value['turnsDispatched'] as number) < 0) return false;
  if (!Array.isArray(value['active']) || !value['active'].every(validTurn)) return false;
  if (!Array.isArray(value['pendingInteractions']) || !value['pendingInteractions'].every(validInteraction)) return false;
  return true;
}

/** The snapshot path for an instance directory, for writer and hook alike. */
export function nannySnapshotPath(instanceDir: string): string {
  return join(instanceDir, NANNY_SNAPSHOT_FILE);
}

/**
 * Read a snapshot, treating anything unreadable as absent.
 *
 * Missing, truncated, malformed and foreign-shaped files all answer
 * `undefined` rather than throwing. ADR 0015 makes "cannot read the state" the
 * ordinary case — most sessions never start a worker — and every one of those
 * cases has to end in the hook letting the user go. Nothing is repaired and nothing is partially parsed —
 * that is only safe because the writer never leaves a half-written file behind.
 *
 * @param path - snapshot path, from {@link nannySnapshotPath}.
 * @returns the snapshot, or `undefined` if it is absent or unusable.
 */
export async function readNannySnapshot(path: string): Promise<NannySnapshot | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
  return validSnapshot(parsed) ? parsed : undefined;
}

/**
 * Writes the nanny snapshot for one instance.
 *
 * Register {@link observer} on the runtime's registry fan-out. Every
 * transition marks the file dirty; at most one write is ever in flight, and
 * transitions arriving during one are merged into a single following write.
 * That serialisation — not the atomic `rename`, and not `seq` — is what keeps
 * a stale picture from landing on top of a fresh one: the callbacks are
 * synchronous while the writes are not, so unserialised writes would finish in
 * an order nobody controls.
 */
export class NannySnapshotWriter {
  private readonly path: string;
  private readonly now: () => string;
  private seq = 0;
  private dirty = false;
  private writing = false;
  private closed = false;
  /** The instance-scoped write lane: not the mutation gate, not a session lane. */
  private lane: Promise<void> = Promise.resolve();

  constructor(private readonly options: NannySnapshotWriterOptions) {
    this.path = nannySnapshotPath(options.instanceDir);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Turns dispatched since this instance started, as the runtime counts them.
   *
   * The anchor writer captures the same counter before serialising its own
   * record, and this writer reads it as late as it can, so the hook's
   * `turnsDispatched - turnsAtWrite` over-counts rather than under-counts
   * (ADR 0016). Both ends lean the same way on purpose: an early reminder is
   * affordable, a signal that quietly reads low is not.
   */
  get turnsDispatched(): number {
    return this.options.turnsDispatched();
  }

  /**
   * Composed into the runtime's registry observer fan-out.
   *
   * These callbacks run inside the registry mutation that produced them, where
   * the registry is only half-applied, so they read nothing — they raise a flag
   * and let the asynchronous writer read a settled registry.
   */
  readonly observer: RegistryObserver = {
    onSessionTransition: () => this.schedule(),
    onTurnTransition: () => this.schedule(),
    onInteractionTransition: () => this.schedule(),
  };

  /**
   * Stop accepting transitions, then finish what is already flagged.
   *
   * The snapshot is deliberately left on disk: it describes work this instance
   * had outstanding, and deleting it would look exactly like "nothing to
   * report" to a hook that fires afterwards.
   */
  async close(): Promise<void> {
    this.closed = true;
    await this.settled();
  }

  /** Resolves once no write is in flight and none is pending. */
  async settled(): Promise<void> {
    // A settled lane may already have been replaced by a transition that
    // arrived while it ran; wait until the lane stops changing.
    let lane = this.lane;
    await lane;
    while (this.lane !== lane) {
      lane = this.lane;
      await lane;
    }
  }

  private schedule(): void {
    if (this.closed) return;
    this.dirty = true;
    if (this.writing) return;
    this.writing = true;
    // Deferred, not called inline: the observer is running inside a registry
    // mutation, and `project()` must not see it half-applied.
    this.lane = Promise.resolve().then(() => this.drain());
  }

  private async drain(): Promise<void> {
    try {
      // Work already flagged is finished even after close(): the last thing to
      // land is then the shutdown picture, not a snapshot still claiming that
      // turns are running.
      while (this.dirty) {
        this.dirty = false;
        try {
          // Read the registry and the counter here, as late as possible: a
          // write racing a dispatch then reports the higher count, the
          // over-counting direction ADR 0016 requires.
          //
          // Projection is inside the guard as well as the write: it clones
          // engine-supplied interaction payloads, which can fail, and nothing
          // about a snapshot is worth rejecting this lane over — the promise is
          // awaited by close() and otherwise floats.
          await this.write(this.project());
        } catch (error) {
          // The previous snapshot survives untouched. Retrying here could spin
          // against a full or read-only disk; the next transition writes again.
          this.options.onError?.(error);
        }
      }
    } finally {
      this.writing = false;
    }
  }

  private project(): NannySnapshot {
    const active: NannySnapshotTurn[] = [];
    for (const turn of this.options.source.listTurns()) {
      if (!ACTIVE_TURN_STATES.has(turn.state)) continue;
      const session = this.options.source.getSession(turn.sessionId);
      if (session === undefined) {
        // A non-terminal turn always has a session record today. Should that
        // ever change, omit the turn rather than write it without a cwd, which
        // would make it surface in unrelated workspaces — but say so through
        // onError: a snapshot that quietly loses entries is exactly the silent
        // failure ADR 0015 keeps warning about.
        this.options.onError?.(new Error(`nanny snapshot: no session record for active turn ${turn.id}`));
        continue;
      }
      active.push({
        turnId: turn.id,
        sessionId: turn.sessionId,
        engine: turn.engine,
        state: turn.state,
        cwd: session.cwd,
        ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
      });
    }
    const pendingInteractions: NannySnapshotInteraction[] = [];
    for (const interaction of this.options.source.listInteractions()) {
      if (interaction.state !== 'pending') continue;
      pendingInteractions.push({
        interactionId: interaction.id,
        turnId: interaction.turnId,
        kind: interaction.kind,
        ...(interaction.expiresAt === undefined ? {} : { expiresAt: interaction.expiresAt }),
      });
    }
    this.seq += 1;
    return {
      instanceId: this.options.instanceId,
      updatedAt: this.now(),
      seq: this.seq,
      // Read here rather than when the transition arrived: latest possible is
      // highest possible, which is the direction ADR 0016 requires.
      turnsDispatched: this.options.turnsDispatched(),
      active,
      pendingInteractions,
    };
  }

  /**
   * Same idiom as core/lifecycle.ts: create the temp file in the destination
   * directory at mode 0600 (never 0644 then chmod), verify what was created,
   * then rename over the target. A cross-directory rename would not be atomic,
   * and any failure before the rename leaves the previous snapshot readable.
   *
   * There is no fsync, unlike the anchor record: this file is derived state
   * rebuilt on the next transition, so losing it to a power cut costs at most
   * one reminder. `wx` still refuses an existing path, symlink included.
   */
  private async write(snapshot: NannySnapshot): Promise<void> {
    const temp = `${this.path}.tmp-${randomUUID()}`;
    try {
      await writeFile(temp, JSON.stringify(snapshot) + '\n', { mode: 0o600, flag: 'wx' });
      const tempInfo = await lstat(temp);
      if (tempInfo.isSymbolicLink() || !tempInfo.isFile() || (tempInfo.mode & 0o777) !== 0o600) {
        throw new Error('unsafe nanny snapshot temp file');
      }
      await rename(temp, this.path);
      const info = await lstat(this.path);
      if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600) {
        throw new Error('unsafe nanny snapshot');
      }
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }
}
