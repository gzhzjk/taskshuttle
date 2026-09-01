import { createHostDriver, hasStopHookTarget, type HostArtifactValidationContext, type HostDeployContext } from '@taskshuttle/host-kit';

function validateStopHook(context: HostArtifactValidationContext) {
  const issues: Array<{ path: string; message: string }> = [];
  const value = context.artifactManifest as { hooks?: Record<string, { hooks?: { command?: unknown; args?: unknown }[] }[]> } | undefined;
  const events = Object.keys(value?.hooks ?? {});
  if (!events.includes('Stop')) issues.push({ path: context.artifactManifestPath, message: `Stop hook registration must use the PascalCase event name; found ${events.join(', ') || 'none'}` });
  const handlers = (value?.hooks?.['Stop'] ?? []).flatMap((entry) => entry.hooks ?? []);
  const targets = handlers.flatMap((handler) => [handler.command, ...(Array.isArray(handler.args) ? handler.args : [])]).filter((target): target is string => typeof target === 'string');
  if (!hasStopHookTarget(targets, context.nannyHookEntry)) issues.push({ path: context.artifactManifestPath, message: `Stop hook must invoke ${context.nannyHookEntry}` });
  return issues;
}

async function deploy(context: HostDeployContext) {
  if (!context.onPath('codex')) return { status: 'skipped' as const, detail: 'codex CLI not on PATH' };
  const listed = (await context.run({ binary: 'codex', argv: ['plugin', 'marketplace', 'list'] }))?.stdout ?? '';
  if (!listed.includes('taskshuttle')) await context.requireRun({ binary: 'codex', argv: ['plugin', 'marketplace', 'add', `${context.roots.repository}/marketplaces/codex`] }, 'marketplace add failed');
  const plugins = (await context.run({ binary: 'codex', argv: ['plugin', 'list'] }))?.stdout ?? '';
  if (plugins.includes('taskshuttle')) await context.requireRun({ binary: 'codex', argv: ['plugin', 'remove', 'taskshuttle@taskshuttle'] }, 'plugin remove failed');
  await context.requireRun({ binary: 'codex', argv: ['plugin', 'add', 'taskshuttle@taskshuttle'] }, 'plugin add failed');
  const after = (await context.run({ binary: 'codex', argv: ['plugin', 'list'] }))?.stdout ?? '';
  if (!context.dryRun && !(after.includes('taskshuttle') && after.includes('installed'))) throw new Error('taskshuttle not reported installed by codex plugin list');
  return { status: 'ok' as const, detail: 'plugin added from refreshed local marketplace' };
}

export default createHostDriver('codex', {
  marketplacePayload: 'marketplaces/codex/plugins/taskshuttle',
  deploy,
  validateArtifacts: validateStopHook,
  install: [
    { binary: 'codex', argv: ['plugin', 'marketplace', 'add', './marketplaces/codex'] },
    { binary: 'codex', argv: ['plugin', 'add', 'taskshuttle@taskshuttle'] },
  ],
  verify: [{ binary: 'codex', argv: ['plugin', 'list'] }],
  uninstall: [{ binary: 'codex', argv: ['plugin', 'remove', 'taskshuttle@taskshuttle'] }],
  installDetail: 'Codex marketplace plugin install plan',
  verifyDetail: 'Codex plugin listing verification plan',
  uninstallDetail: 'Codex marketplace plugin uninstall plan',
});
