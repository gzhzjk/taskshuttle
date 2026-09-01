/**
 * Rate-limit payload capture harness (upstream GZH-43 step 1).
 *
 * Drives one engine through short prompts with a wire observer installed, and
 * records two things the transcript cannot hold:
 *
 *  - every JSON-RPC frame carrying an `error` member, verbatim;
 *  - the structure of whatever `prompt()` throws — name, `kind`, message, and
 *    the whole cause chain — which is exactly what `classifyEngineFailure()`
 *    matches against.
 *
 * It deliberately does not try to exhaust an account: it runs a bounded number
 * of rounds and stops on the first failure it captures.
 *
 * It talks to Realm directly rather than through the plugin, so it needs no
 * `REALM_PLUGIN_LAUNCH_PATH`: the shim that variable points at is the plugin's
 * worker launcher, and nothing here goes through it.
 *
 * Usage: npx tsx scripts/probe/rate-limit.ts <engine> [rounds] [concurrency]
 * Writes `capture-<engine>.jsonl` in the working directory, or `PROBE_OUT`.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Hub } from '@runskein/core/internal';
import { builtinAdapters } from 'runskein';

const engine = process.argv[2] ?? 'pi';
const rounds = Number(process.argv[3] ?? '3');
const concurrency = Number(process.argv[4] ?? '2');
const out = process.env['PROBE_OUT'] ?? join(process.cwd(), `capture-${engine}.jsonl`);
mkdirSync(dirname(out), { recursive: true });

function write(record: unknown): void {
  appendFileSync(out, `${JSON.stringify(record)}\n`);
}

/** Walk an error's cause chain, keeping only the fields a pattern could match. */
function describe(error: unknown, depth = 0): unknown {
  if (depth > 8) return '<depth>';
  if (typeof error !== 'object' || error === null) return { value: String(error) };
  const raw = error as Record<string, unknown>;
  return {
    name: raw['name'],
    message: raw['message'],
    kind: raw['kind'],
    code: raw['code'],
    data: raw['data'],
    engineId: raw['engineId'],
    operation: raw['operation'],
    ...(raw['cause'] === undefined ? {} : { cause: describe(raw['cause'], depth + 1) }),
  };
}

const hub = new Hub({
  builtins: [...builtinAdapters],
  wireObserver: (id: string) => (frame: { error?: unknown }) => {
    // Only refusals and engine-private session notifications are interesting;
    // everything else is the ordinary traffic the transcript already holds.
    if (frame.error !== undefined) write({ at: Date.now(), engine: id, type: 'wire-error', frame });
  },
});

let captured = 0;

/**
 * One session's share of the load. Turns queue per session (`TurnQueue`), so a
 * burst has to come from several sessions — prompting one session N times
 * serializes and never produces the concurrent pressure a 429 needs.
 */
async function drive(index: number): Promise<void> {
  const session = await hub.session({ engine, cwd: process.cwd() });
  write({ at: Date.now(), engine, type: 'session-open', probe: index, sessionId: session.id });
  try {
    for (let round = 0; round < rounds && captured === 0; round += 1) {
      try {
        const result = await session.prompt(`Reply with the single word ok (probe ${index}, round ${round}).`);
        write({ at: Date.now(), engine, type: 'turn-ok', probe: index, round, stopReason: result.stopReason });
      } catch (error) {
        captured += 1;
        write({ at: Date.now(), engine, type: 'turn-failed', probe: index, round, error: describe(error) });
        console.error('captured failure:', JSON.stringify(describe(error)));
        return;
      }
    }
  } finally {
    await session.close().catch(() => undefined);
  }
}

try {
  await Promise.all(Array.from({ length: concurrency }, (_, i) => drive(i).catch((error: unknown) => {
    write({ at: Date.now(), engine, type: 'probe-failed', probe: i, error: describe(error) });
    console.error('probe failure:', JSON.stringify(describe(error)));
  })));
} catch (error) {
  write({ at: Date.now(), engine, type: 'harness-failed', error: describe(error) });
} finally {
  await hub.quit();
}
console.error(`capture written to ${out}`);
process.exit(0);
