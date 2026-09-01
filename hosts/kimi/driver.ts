import { createHostDriver, hasStopHookTarget, syncDirectory, type HostArtifactValidationContext, type HostDeployContext } from '@taskshuttle/host-kit';
import { join } from 'node:path';

function validateStopHook(context: HostArtifactValidationContext) {
  const issues: Array<{ path: string; message: string }> = [];
  const value = context.artifactManifest as { hooks?: unknown } | undefined;
  if (!Array.isArray(value?.hooks)) {
    issues.push({ path: context.artifactManifestPath, message: 'Kimi artifact must register its Stop hook in the plugin manifest' });
    return issues;
  }
  const stop = value.hooks.find((hook) => typeof hook === 'object' && hook !== null && (hook as { event?: unknown }).event === 'Stop') as { command?: unknown; timeout?: unknown } | undefined;
  if (stop === undefined) {
    issues.push({ path: context.artifactManifestPath, message: 'Kimi manifest has no Stop hook entry' });
    return issues;
  }
  if (typeof stop.command !== 'string' || !hasStopHookTarget([stop.command], context.nannyHookEntry)) issues.push({ path: context.artifactManifestPath, message: `Kimi Stop hook must invoke ${context.nannyHookEntry}` });
  for (const key of Object.keys(stop)) if (!['event', 'matcher', 'command', 'timeout'].includes(key)) issues.push({ path: context.artifactManifestPath, message: `Kimi hook schema is strict; unknown key ${key}` });
  if (stop.timeout !== undefined && (typeof stop.timeout !== 'number' || !Number.isInteger(stop.timeout) || stop.timeout < 1 || stop.timeout > 600)) issues.push({ path: context.artifactManifestPath, message: 'Kimi hook timeout must be an integer in 1..600' });
  return issues;
}

async function deploy(context: HostDeployContext) {
  if (!context.onPath('kimi')) return { status: 'skipped' as const, detail: 'kimi CLI not on PATH' };
  const kimiHome = context.env.KIMI_CODE_HOME ?? join(context.home, '.kimi-code');
  const kimiFiles = context.files.managed;
  if (kimiFiles === undefined) return { status: 'manual' as const, detail: `one-time bootstrap, in a kimi session: /plugins install ${join(context.roots.repository, 'hosts', 'kimi')} — then /reload` };
  let installed: { plugins?: Array<{ id?: string; enabled?: boolean }> } = {};
  try { installed = JSON.parse(await kimiFiles.readText('plugins/installed.json')) as typeof installed; } catch { /* bootstrap record is optional */ }
  const record = installed.plugins?.find((plugin) => plugin.id === 'taskshuttle');
  if (record === undefined || !record.enabled) return { status: 'manual' as const, detail: `one-time bootstrap, in a kimi session: /plugins install ${join(context.roots.repository, 'hosts', 'kimi')} — then /reload` };
  if (!context.dryRun) await syncDirectory(context.files.repository, kimiFiles, 'hosts/kimi', 'plugins/managed/taskshuttle', { mode: 0o700, prune: true, filter: (name) => name !== '.DS_Store' });
  return { status: 'ok' as const, detail: `managed copy synced from hosts/kimi; takes effect after /reload or a new session (${join(kimiHome, 'plugins', 'managed', 'taskshuttle')})` };
}

export default createHostDriver('kimi', {
  deploy,
  validateArtifacts: validateStopHook,
  install: [{ binary: 'kimi', argv: ['plugins', 'install', 'hosts/kimi/kimi.plugin.json'] }],
  verify: [{ binary: 'kimi', argv: ['plugins', 'list'] }],
  uninstall: [{ binary: 'kimi', argv: ['plugins', 'disable', 'taskshuttle'] }],
  installDetail: 'Kimi managed-plugin bootstrap plan',
  verifyDetail: 'Kimi plugin listing verification plan',
  uninstallDetail: 'Kimi plugin disable plan',
});
