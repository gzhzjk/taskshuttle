# TaskShuttle

English | [简体中文](README.zh-CN.md)

TaskShuttle lets the coding agent you already use ask another coding agent to
do a bounded piece of work. You stay in one conversation: name the worker,
describe the task, and receive the result back with its transcript.

![TaskShuttle architecture overview: host agent, plugin, selected worker engine, and local console](assets/taskshuttle-architecture.png)

You decide what to delegate and whether the result is good enough. TaskShuttle
handles the hand-off, keeps the work visible, and lets you use the coding
agent that fits each task.

`0.1.0` · Node.js 22+ · macOS · first public release

## Quickstart

### 1. Install TaskShuttle

The simplest setup builds the plugin and installs every host integration that
is available on your machine:

```bash
git clone <your-taskshuttle-repository>
cd taskshuttle
pnpm install
pnpm check
pnpm run deploy --scope user
```

`pnpm run deploy --scope user` installs the shared `taskshuttle-launch`
command, then installs or updates Codex, Claude Code, and OpenCode when their
CLIs are present. If Kimi is present, it syncs Kimi after its one-time in-session
bootstrap; otherwise it prints the bootstrap command for you. Have at least
one host CLI installed and logged in before running it. Restart the host (or
reload its plugins) after deployment.

#### Install only one host

If you do not want to configure every host, build once and install the shared
launcher, then run only the host command you need:

```bash
pnpm install
pnpm check
npm pack --pack-destination release ./packages/plugin
npm install -g ./release/taskshuttle-$(node -p "require('./packages/plugin/package.json').version").tgz
```

Run the relevant block from the repository root:

```bash
# Codex
codex plugin marketplace add "$PWD/marketplaces/codex"
codex plugin add taskshuttle@taskshuttle
```

```bash
# Claude Code
claude plugin marketplace add "$PWD/marketplaces/claude-code"
claude plugin install taskshuttle@taskshuttle --scope user -y
```

For OpenCode, add this entry to `~/.config/opencode/opencode.json` under
`mcp` and restart OpenCode:

```json
{
  "taskshuttle": {
    "type": "local",
    "command": ["taskshuttle-launch"]
  }
}
```

Kimi has two extra steps. Start it from the project you want to work on with
the project directory explicitly pinned:

```bash
cd /path/to/your/project
TASKSHUTTLE_HOST_CWD="$PWD" kimi
```

This launch form avoids the Kimi managed-plugin working-directory permission
problem. In the Kimi session, install the plugin once and reload it:

```text
/plugins install /absolute/path/to/taskshuttle/hosts/kimi
/reload
```

Use the explicit `TASKSHUTTLE_HOST_CWD="$PWD" kimi` form whenever Kimi hosts
this repository itself; it is also safe to use for every project.

### 2. Ask another engine to work

Use a normal prompt in the host you already use. Name the worker, the scope,
and what success looks like:

```text
Use codex to add a regression test for the empty-input case in parse(), run the relevant tests, and report the files you changed.
```

Then ask another worker for a review without opening another window:

```text
Have claude-code review Codex's changes and fix only the issues it finds.
```

### 3. Open the console

The host session initializes TaskShuttle when it starts. To watch its workers,
ask your host agent:

```text
Open the TaskShuttle console for this project.
```

Or run the launcher command yourself:

```bash
taskshuttle console open
```

The browser page shows active workers, tasks, questions, state changes, and
transcript output. It is local and read-only. On a custom install, make sure
`console.enabled` is `true` in `~/.taskshuttle/config.json`, then restart the
host session.

## What you can build

With TaskShuttle you can:

- let one worker implement a change while another reviews it;
- ask different engines for parallel investigations or independent tests;
- keep a single conversation while work happens in the background;
- give each task a project directory, file scope, and acceptance criteria;
- return to a worker transcript when you need to check what actually happened;
- create repeatable project defaults for the workers you use most often.

TaskShuttle does not manage Git branches or worktrees. When workers share a
directory, give them separate file ownership or separate directories in your
prompts.

## Why TaskShuttle?

Getting a second coding agent's help normally means opening another window,
repeating the context, and copying the answer back. TaskShuttle keeps that
handoff in one place:

- **Stay in one conversation.** Results return to the agent you already know.
- **Use the right worker.** Pick Codex, Claude Code, OpenCode, Kimi, or pi for
  the task at hand.
- **Keep the trail.** Worker output remains available as a transcript.
- **See progress.** The local console makes waiting, questions, and completion
  visible.
- **Control the decision.** You choose the task, the worker, and when the
  result is acceptable.

TaskShuttle never grades a worker's answer for you.

## Supported hosts and workers

There are two ways to use an engine:

- a **host** is the coding agent where you install TaskShuttle and have the
  conversation;
- a **worker** is the coding agent that receives a delegated task.

### Hosts

| Host | Install method | Scope |
| --- | --- | --- |
| Codex | Local marketplace plugin | user, project |
| Claude Code | Local marketplace plugin | user, project, local |
| OpenCode | `opencode.json` MCP entry | user, project |
| Kimi | In-session plugin install | user |

Codex, Claude Code, OpenCode, and Kimi can host TaskShuttle. Kimi requires the
special startup command shown in Quickstart.

### Workers

| Worker | Available as a host? |
| --- | --- |
| Codex | Yes |
| Claude Code | Yes |
| OpenCode | Yes |
| Kimi | Yes |
| pi | Worker only |

Worker availability depends on the CLIs installed and logged in on your
machine. Ask your host agent to run `workers_list` to see what is usable now.

### Add another host

To bring TaskShuttle to another coding-agent shell, add a host integration and
follow the contributor checklist in [Adding a host](docs/host-extension.md).
That guide covers the host manifest, install commands, verification, safety
boundaries, and release checks.

## Architecture

The high-level path is simple: your host sends a request to TaskShuttle,
TaskShuttle coordinates one named worker, and the result and transcript return
to your conversation. The console observes the same work without changing it.

For the component boundaries, startup behavior, state flow, storage, and
security model, see the [Architecture reference](docs/architecture.md). The
exact request and response shapes are in the
[tool contract](docs/tool-schemas.json).

## Documentation

### For users

- [Delegate workers](skills/delegate-workers/SKILL.md) — how to ask your host
  agent to delegate bounded work, including the default worker profiles and how
  to hand a worker the context it needs.
- [Architecture reference](docs/architecture.md) — the component boundaries, the
  console, and the security model.
- [Tool contract](docs/tool-schemas.json) — the inputs and outputs of all 20
  tools.

### For contributors

- [Architecture reference](docs/architecture.md) — the public boundary map.
- [Host extension guide](docs/host-extension.md) — add and verify a host.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how a change gets in, what the identifiers
  in the code mean, and which CI decides.
- [SECURITY.md](SECURITY.md) — the boundaries this software enforces, the reason
  for each, and what is out of scope.

The frozen specification, the detailed design, the test plan and the decision
records are the maintainers' and are not published. Code comments cite them by
number; CONTRIBUTING.md says what that means for a reader.

## Limitations

- TaskShuttle does not choose tasks, split work, select a worker automatically,
  or decide whether a review is complete.
- It does not manage Git branches/worktrees or provide an OS sandbox.
- Workers do not share context automatically; pass the needed files, notes, or
  prior result in the prompt.
- The console is local and read-only. Anyone who can access its loopback port
  can read the page while the host session is running.

## Contributing

Node.js 22+ and pnpm 9.15.9 are required. Run the full check after changes:

```bash
pnpm check
```

Build before testing because the artifact and host checks read generated
bundles. A change that affects tool behavior, scheduling, security boundaries or
support claims needs a decision recorded before it is implemented — see
[CONTRIBUTING.md](CONTRIBUTING.md).
