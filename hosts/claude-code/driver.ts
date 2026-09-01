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
  if (!context.onPath('claude')) return { status: 'skipped' as const, detail: 'claude CLI not on PATH' };
  const listed = (await context.run({ binary: 'claude', argv: ['plugin', 'marketplace', 'list'] }))?.stdout ?? '';
  if (listed.includes('taskshuttle')) await context.requireRun({ binary: 'claude', argv: ['plugin', 'marketplace', 'update', 'taskshuttle'] }, 'marketplace refresh failed');
  else await context.requireRun({ binary: 'claude', argv: ['plugin', 'marketplace', 'add', `${context.roots.repository}/marketplaces/claude-code`] }, 'marketplace add failed');
  const plugins = (await context.run({ binary: 'claude', argv: ['plugin', 'list'] }))?.stdout ?? '';
  if (plugins.includes('taskshuttle')) await context.requireRun({ binary: 'claude', argv: ['plugin', 'uninstall', 'taskshuttle@taskshuttle'] }, 'plugin uninstall failed');
  await context.requireRun({ binary: 'claude', argv: ['plugin', 'install', 'taskshuttle@taskshuttle', '-s', context.scope, '-y'] }, 'plugin install failed');
  const after = (await context.run({ binary: 'claude', argv: ['plugin', 'list'] }))?.stdout ?? '';
  if (!context.dryRun && !after.includes('taskshuttle')) throw new Error('taskshuttle absent from claude plugin list');
  return { status: 'ok' as const, detail: `plugin installed/updated (scope ${context.scope}) via local marketplace` };
}

export default createHostDriver('claude-code', {
  marketplacePayload: 'marketplaces/claude-code/plugins/taskshuttle',
  deploy,
  validateArtifacts: validateStopHook,
  install: [
    { binary: 'claude', argv: ['plugin', 'marketplace', 'add', './marketplaces/claude-code'] },
    { binary: 'claude', argv: ['plugin', 'install', 'taskshuttle@taskshuttle', '-s', 'user', '-y'] },
  ],
  verify: [{ binary: 'claude', argv: ['plugin', 'list'] }],
  uninstall: [{ binary: 'claude', argv: ['plugin', 'uninstall', 'taskshuttle@taskshuttle'] }],
  installDetail: 'Claude Code marketplace plugin install plan',
  verifyDetail: 'Claude Code plugin listing verification plan',
  uninstallDetail: 'Claude Code marketplace plugin uninstall plan',
});
