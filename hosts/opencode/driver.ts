import { createHostDriver, createStdioMcpEntry, syncDirectory, type HostDeployContext } from '@taskshuttle/host-kit';
import { join } from 'node:path';

async function deploy(context: HostDeployContext) {
  if (!context.onPath('opencode')) return { status: 'skipped' as const, detail: 'opencode CLI not on PATH' };
  const configPath = '.config/opencode/opencode.json';
  let raw: string;
  let config: Record<string, unknown>;
  try {
    raw = await context.files.home.readText(configPath);
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`cannot merge ${(error as Error).message.split('\n')[0]} — opencode.json may be JSONC, edit the mcp entry by hand`);
  }
  const mcp = (config.mcp as Record<string, unknown> | undefined) ?? {};
  const entry = createStdioMcpEntry('taskshuttle-launch');
  const mcpCurrent = JSON.stringify(mcp.taskshuttle) === JSON.stringify(entry);
  if (!mcpCurrent) {
    mcp.taskshuttle = entry;
    config.mcp = mcp;
    if (!context.dryRun) {
      await context.files.home.writeFile(`${configPath}.deploy-bak`, raw);
      await context.files.home.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    }
  }
  const skillsTarget = '.config/opencode/skills';
  if (!context.dryRun) {
    await syncDirectory(context.files.repository, context.files.home, 'skills', skillsTarget, { prune: false, filter: (name) => name !== '.DS_Store' });
  }
  return { status: 'ok' as const, detail: `${mcpCurrent ? 'user config already points at taskshuttle-launch' : 'mcp.taskshuttle -> taskshuttle-launch written to .config/opencode/opencode.json'}; skills synced to ${join(context.home, skillsTarget)}` };
}

export default createHostDriver('opencode', {
  deploy,
  verify: [{ binary: 'opencode', argv: ['mcp', 'list'] }],
  installDetail: 'merge the taskshuttle stdio entry into ~/.config/opencode/opencode.json with the deploy driver; OpenCode has no native plugin install operation',
  verifyDetail: 'OpenCode MCP listing verification plan',
  uninstallDetail: 'remove mcp.taskshuttle from ~/.config/opencode/opencode.json and delete only the TaskShuttle-managed skills',
});
