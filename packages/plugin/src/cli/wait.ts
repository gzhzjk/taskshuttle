import { join } from 'node:path';
import { findLiveInstances, lockAlive } from '../instance-discovery.js';
import { resolveDataRoot } from '../plugin-config.js';

export interface WaitOptions {
  dataRoot?: string; env?: NodeJS.ProcessEnv;
  instance?: string; cursor?: number; timeoutMs?: number;
  out?: (line: string) => void;
  // seams
  stat?: (path: string) => Promise<{ size: number } | null>;
  read?: (path: string, offset: number) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  discover?: (dataRoot: string) => Promise<Array<{ instanceId: string; instanceDir: string; createdAt: string }>>;
  alive?: (instanceDir: string) => Promise<boolean>;
}

export interface WaitResult { exitCode: number; cursor: number; wake?: string }

function isTerminal(r: Record<string, unknown>): boolean {
  return r['event'] === 'turn_transition' && ['completed','failed','cancelled'].includes(String(r['to']));
}
function isPending(r: Record<string, unknown>): boolean {
  if (r['event'] === 'interaction_transition' && String(r['to']) === 'pending') return true;
  if (r['event'] === 'turn_transition' && String(r['to']) === 'awaiting-interaction') return true;
  return false;
}

/**
 * Blocking wait over the progress journal (ADR 0040).
 * @param options - wait options with seams for tests
 * @returns exit code and cursor
 */
export async function runWait(options: WaitOptions = {}): Promise<WaitResult> {
  const out = options.out ?? ((l: string) => console.log(l));
  const dataRoot = resolveDataRoot(options.env ?? process.env, options.dataRoot);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());

  const discover = options.discover ?? findLiveInstances;
  const aliveFn = options.alive ?? (async (dir: string) => lockAlive(dir, (await import('../lifecycle.js')).defaultProcessInspector));
  // instance discovery via findLiveInstances (never console.json)
  const all = await discover(dataRoot);
  let picked = options.instance
    ? all.filter(c => c.instanceId === options.instance || c.instanceId.startsWith(options.instance!))
    : all;
  if (picked.length === 0) {
    if (all.length > 0) out(`no live instance matches --instance=${options.instance}`);
    else out(`no live instance under ${dataRoot}`);
    return { exitCode: 2, cursor: options.cursor ?? 0 };
  }
  if (picked.length > 1) {
    out('more than one live instance; re-run with --instance=<id>:');
    for (const c of picked) out(`  ${c.instanceId}  created ${c.createdAt}`);
    return { exitCode: 2, cursor: options.cursor ?? 0 };
  }
  const inst = picked[0]!;
  const journal = join(inst.instanceDir, 'progress.ndjson');
  let cursor = options.cursor ?? 0;
  if (!Number.isFinite(cursor) || cursor < 0) {
    out(`warning: invalid cursor, re-reading from 0`);
    cursor = 0;
  }
  const timeoutMs = options.timeoutMs ?? 45000;
  const deadline = now() + timeoutMs;

  const doStat = options.stat ?? (async (p: string) => {
    const { stat } = await import('node:fs/promises');
    try { const s = await stat(p); return { size: s.size }; } catch { return null; }
  });
  const doRead = options.read ?? (async (p: string, off: number) => {
    const { open } = await import('node:fs/promises');
    const h = await open(p, 'r');
    try {
      const st = await h.stat();
      if (off >= st.size) return '';
      const len = st.size - off;
      const buf = Buffer.alloc(len);
      await h.read(buf, 0, len, off);
      return buf.toString('utf8');
    } finally { await h.close(); }
  });

  while (now() < deadline) {
    // ENOENT handling with liveness check
    let st: { size: number } | null = null;
    try { st = await doStat(journal); } catch { return { exitCode: 1, cursor }; }
    if (st === null) {
      const alive = await aliveFn(inst.instanceDir).catch(() => false);
      if (!alive) { out(`timeout cursor=${cursor}`); return { exitCode: 0, cursor }; }
      await sleep(200); continue;
    }
    if (st.size < cursor) { out(`warning: cursor past end, re-reading from 0`); cursor = 0; }
    if (st.size > cursor) {
      let chunk: string;
      try { chunk = await doRead(journal, cursor); } catch { return { exitCode: 1, cursor }; }
      // advance cursor to current file size regardless of parse outcome
      const nextCursor = st.size;
      const lines = chunk.split('\n').filter(l => l.trim().length > 0);
      for (const line of lines) {
        let rec: Record<string, unknown>;
        try { rec = JSON.parse(line); } catch { continue; }
        if (isTerminal(rec)) {
          const tid = String(rec['turnId'] ?? ''), sid = String(rec['sessionId'] ?? '');
          out(`wake=terminal cursor=${nextCursor} turnId=${tid} sessionId=${sid}`);
          return { exitCode: 0, cursor: nextCursor, wake: 'terminal' };
        }
        if (isPending(rec)) {
          out(`wake=pending cursor=${nextCursor}`);
          return { exitCode: 0, cursor: nextCursor, wake: 'pending' };
        }
      }
      cursor = nextCursor;
    }
    await sleep(200);
  }
  out(`timeout cursor=${cursor}`);
  return { exitCode: 0, cursor };
}
