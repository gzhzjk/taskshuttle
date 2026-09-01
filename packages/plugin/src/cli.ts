#!/usr/bin/env node

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createTaskShuttleServer } from './server.js';
import { settleDelegation, type DelegationDiagnostics } from './delegation-evidence.js';
import { installRootFrom, resolveDataRoot } from './plugin-config.js';
import { readDelegationIdentity } from './security-policy.js';

process.umask(0o077);
for (const [current, legacy] of [['TASKSHUTTLE_LAUNCH_PATH', 'REALM_PLUGIN_LAUNCH_PATH'], ['TASKSHUTTLE_DATA_ROOT', 'REALM_PLUGIN_DATA_ROOT']] as const) {
  if (process.env[current] === undefined && process.env[legacy] !== undefined) process.stderr.write(`taskshuttle compatibility: using legacy ${legacy}\n`);
}
process.env['TASKSHUTTLE_LAUNCH_PATH'] ??= process.env['REALM_PLUGIN_LAUNCH_PATH'] ?? fileURLToPath(new URL('./launch.js', import.meta.url));
const plugins = new Set<ReturnType<typeof createTaskShuttleServer>>();

// The delegation verdict is settled here, before `serveStdio` can hand us a
// single tool call (mvp §5.2). `serveStdio` takes a synchronous factory, and the
// walk is IO, so the alternative would be every gate awaiting the verdict — a gate
// that must be remembered at every call site is a gate that will be forgotten at
// one. A malformed marker throws out of this await: no server, as before.
// Filled by the settle: what the scan read, and which doubt the verdict
// reached. It reaches `console_withheld`, so a withheld console names its cause
// instead of presenting as a console that was never enabled (ADR 0033).
const delegationDiagnostics: DelegationDiagnostics = {};
const delegation = await settleDelegation({
  marker: readDelegationIdentity(process.env),
  dataRoot: resolveDataRoot(process.env),
  diagnostics: delegationDiagnostics,
});

const handle = serveStdio(() => {
  const plugin = createTaskShuttleServer({ installRoot: installRootFrom(import.meta.url), delegation, delegationDiagnostics });
  plugins.add(plugin);
  const server = plugin.server as typeof plugin.server & { close?: () => Promise<void> };
  const transportClose = server.close?.bind(server);
  if (transportClose !== undefined) {
    server.close = async () => {
      try { await transportClose(); }
      finally { await plugin.close(); plugins.delete(plugin); }
    };
  }
  return plugin.server;
});

async function performShutdown(): Promise<void> {
  try {
    const closing = [...plugins].map(async (plugin) => { try { await plugin.close(); } finally { plugins.delete(plugin); } });
    const results = await Promise.allSettled([handle.close(), ...closing]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure !== undefined) throw failure.reason;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    // The launcher in the same bundle sets the current names; the legacy reads
    // stay because an operator may have pointed the orphan file somewhere.
    const orphan = process.env['TASKSHUTTLE_ORPHAN_FILE'] ?? process.env['REALM_PLUGIN_ORPHAN_FILE'];
    const owner = process.env['TASKSHUTTLE_ORPHAN_OWNER'] ?? process.env['REALM_PLUGIN_ORPHAN_OWNER'];
    if (orphan !== undefined && owner !== undefined) {
      try {
        const marker = JSON.parse(await readFile(orphan, 'utf8')) as { pid?: unknown; tokenHash?: unknown };
        if (marker.pid === process.pid && marker.tokenHash === owner) await unlink(orphan);
      } catch { /* an absent or foreign marker is left for recovery */ }
    }
  }
}

let shutdownPromise: Promise<void> | undefined;
function shutdown(): Promise<void> {
  shutdownPromise ??= performShutdown();
  return shutdownPromise;
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
process.stdin.once('end', () => void shutdown());
process.stdin.once('close', () => void shutdown());
