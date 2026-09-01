# Security policy

## Reporting a vulnerability

Report privately through GitHub's **private vulnerability reporting** on this
repository (Security → Report a vulnerability). It reaches the maintainers
without creating a public issue.

Please include what you ran, which engine and host, and what you observed.
There is no bounty programme, and no guaranteed response time: this is a
pre-1.0 project maintained by one person. You will get an acknowledgement and,
if the report is accepted, a fix in a subsequent release with credit unless you
ask otherwise.

**Supported versions.** Only the newest published version. Prereleases carry
the `next` dist-tag and are not separately maintained.

## What this software does, in security terms

TaskShuttle starts other coding agents as child processes and gives an
orchestrating agent a fixed tool surface for driving them. Anyone deciding
whether to run it should read the following as the actual boundary, not as a
list of features.

**The worker is a full coding agent with your credentials.** It runs as your
user, with your engine logins, and it can read and write files and run
commands the way you can. Delegating a task to it is closer to letting a
colleague use your terminal than to running a sandboxed plugin.

## The boundaries the code implements, and why each is where it is

The reasoning behind these decisions is recorded in decision records the
maintainers keep privately; the boundaries themselves are described here
because a reader of the code should not have to infer them.

- **A session's working directory must resolve inside an allowed root.** The
  roots derive from the host's own working directory, so a delegated session
  cannot be pointed at an unrelated part of the filesystem by a mistaken or
  manipulated tool call. It is checked again immediately before the worker is
  spawned, because the path could be replaced between validation and use.

  **It is a containment check, not a filesystem sandbox**, and this is the most
  important sentence on this page. Once a worker is running, nothing in
  TaskShuttle prevents it from reading or writing outside those roots — the
  engine's own permissions do. The roots stop a *tool call* from naming the
  wrong directory; they do not confine the process it starts.

- **Workers run with silent approval by default.** A worker's permission
  requests are answered automatically unless the orchestrator configures
  `ask-orchestrator` or `deny`. The default exists because a delegated task
  that stops on every prompt cannot run unattended, and the honest consequence
  is that the default trades interruption for oversight. Choose deliberately.

- **A worker cannot delegate further.** Each instance establishes its
  delegation depth from a marker passed to the child, falling back to process
  ancestry, and a nested instance refuses to act as an orchestrator. Without
  this, one delegation can fan out into an unbounded tree of agents spending
  real money.

- **The observation console binds loopback and carries no credential.** It
  listens on `127.0.0.1` only, and its boundary *is* that binding: anyone who
  can reach the port can read the transcripts it serves. On a shared or
  port-forwarded machine, treat it as public and leave it disabled.

- **Engines are refused until their support is established.** An engine
  TaskShuttle has not verified is admitted only when the operator opts in
  explicitly. This is a correctness boundary rather than a security one, and it
  is listed because it is often mistaken for the other kind.

## What is out of scope

- The engines themselves, their credentials, and what they choose to do with a
  prompt. TaskShuttle starts them; it does not audit them.
- A malicious orchestrator. The orchestrating agent is trusted by construction;
  it is the thing you are running.
- Anything reachable by someone who already has your user account.
