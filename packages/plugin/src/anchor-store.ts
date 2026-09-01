import { constants as fsConstants } from 'node:fs';
import { open, readFile, rename, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** File name of the anchor record inside the instance directory. */
export const ANCHOR_FILE = 'anchor.json';

/**
 * The four-field on-disk anchor record (ADR 0016).
 *
 * Only `content` is the orchestrator's; the other three are lifecycle metadata.
 * `turnsAtWrite` has to be on disk because the nanny hook is a separate process
 * and cannot read this instance's in-memory dispatch counter: it recomputes
 * `turnsSinceUpdate` as the snapshot's `turnsDispatched` minus this field.
 */
export interface AnchorRecord {
  readonly content: string;
  readonly updatedAt: string;
  readonly instanceId: string;
  readonly turnsAtWrite: number;
}

function isAnchorRecord(value: unknown): value is AnchorRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['content'] === 'string' &&
    typeof record['updatedAt'] === 'string' &&
    typeof record['instanceId'] === 'string' &&
    typeof record['turnsAtWrite'] === 'number' &&
    Number.isInteger(record['turnsAtWrite']) &&
    record['turnsAtWrite'] >= 0
  );
}

/**
 * Stores one opaque anchor blob per instance.
 *
 * The plugin never parses, trims, normalizes or validates the blob beyond its
 * byte size (ADR 0016): the moment it understands the content it becomes a
 * co-owner of the orchestrator's plan, which mvp §3.1/§3.2 forbid.
 *
 * Writes are serialized on this store's own instance-scoped lane. They do not
 * go through `GlobalMutationGate` — that gate throttles work that consumes
 * engine resources, and a few KiB of bookkeeping must stay writable precisely
 * when the worker queue is full — and not through the per-session lanes either,
 * because the anchor outlives any one session.
 */
export class AnchorStore {
  private readonly path: string;
  private lane: Promise<unknown> = Promise.resolve();

  /**
   * @param instanceDir the 0700 instance directory the record lives in
   * @param instanceId stamped into the record so a cross-process reader can tell
   *   the anchor and the nanny snapshot belong to the same instance
   */
  constructor(instanceDir: string, private readonly instanceId: string) {
    this.path = join(instanceDir, ANCHOR_FILE);
  }

  /**
   * Replace the anchor wholesale. Merging would require understanding the blob.
   *
   * @param content the opaque UTF-8 blob, stored byte for byte
   * @param turnsDispatched reads the instance's monotonic dispatch counter; it is
   *   called immediately before serialization, so any turn dispatched during the
   *   write is counted as "since the update". Over-counting only makes the
   *   reminder arrive early; under-counting would make drift look like progress.
   * @param now supplies `updatedAt`; injectable for tests
   * @returns the record as it was written
   * @throws whatever the filesystem throws; the previous anchor is untouched
   *   because nothing before the `rename` writes to the target path
   */
  async write(content: string, turnsDispatched: () => number, now: () => string = () => new Date().toISOString()): Promise<AnchorRecord> {
    const run = this.lane.then(async (): Promise<AnchorRecord> => {
      const record: AnchorRecord = { content, updatedAt: now(), instanceId: this.instanceId, turnsAtWrite: turnsDispatched() };
      const temp = `${this.path}.tmp-${randomUUID()}`;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        // Same idiom as core/lifecycle.ts and console/server.ts: exclusive
        // no-follow create at 0600, fsync, then an atomic same-directory rename.
        // Never create at 0644 and chmod afterwards — that leaves a readable window.
        handle = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
        await handle.writeFile(JSON.stringify(record) + '\n');
        await handle.sync();
        await handle.close();
        handle = undefined;
        const tempInfo = await lstat(temp);
        if (tempInfo.isSymbolicLink() || !tempInfo.isFile() || (tempInfo.mode & 0o777) !== 0o600) throw new Error('unsafe anchor record');
        await rename(temp, this.path);
        return record;
      } finally {
        await handle?.close().catch(() => undefined);
        await unlink(temp).catch(() => undefined);
      }
    });
    this.lane = run.catch(() => undefined);
    return run;
  }

  /**
   * Read the anchor, if there is a readable one.
   *
   * @returns the record, or `undefined` when none was written or the file is
   *   unreadable/corrupt. A single read, no retry loop: the writer never leaves a
   *   torn intermediate state, so "unreadable" can be treated as "absent" without
   *   masking a partial write.
   */
  async read(): Promise<AnchorRecord | undefined> {
    return readAnchorRecord(this.path);
  }
}

/**
 * Read an anchor record from its path, treating anything unreadable as absent.
 *
 * Exported because the nanny hook is a separate process with no store instance:
 * it needs the same "corrupt means absent" judgement, and a second reader would
 * be a second place for that judgement to drift.
 *
 * @param path - the anchor file, from {@link anchorPath}.
 * @returns the record, or `undefined` when none was written or it is unreadable.
 */
export async function readAnchorRecord(path: string): Promise<AnchorRecord | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isAnchorRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The anchor path for an instance directory, for store and hook alike. */
export function anchorPath(instanceDir: string): string {
  return join(instanceDir, ANCHOR_FILE);
}
