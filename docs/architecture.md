# TaskShuttle architecture

This document is the reader-friendly architecture reference for TaskShuttle. It
explains the boundary between a host, the plugin, the process-free Core library,
Runskein, and the workers. The frozen behavior and security rules remain owned
by the maintainers' frozen requirements, and implementation detail by their
detailed design. Neither is part of this repository; what a consumer needs is
here, in [the tool contract](tool-schemas.json), [the host-integration
contract](host-extension.md) and [SECURITY.md](../SECURITY.md).

![TaskShuttle architecture overview: host, plugin, workers, and local console](../assets/taskshuttle-architecture.png)

## One request, one named worker

A person speaks to the coding agent already open on their desktop. That host
agent turns the request into TaskShuttle tool calls, names one worker engine,
and decides what to do with the worker's result.

```text
person
  │ natural-language request
  ▼
host coding agent
  │ 20 TaskShuttle tools
  ▼
Plugin composition root
  │ one session, then queued/running turns
  ▼
named worker CLI (Codex, Claude Code, OpenCode, Kimi, pi, ...)
  │ events and answers
  ├──────────────► transcript store
  └──────────────► local read-only console
```

The plugin is a coordinator for lifecycle and evidence, not a workflow engine.
It does not split a request, select a worker automatically, create a DAG, or
judge whether a result is acceptable.

## Package and process boundaries

TaskShuttle is an embedded MCP plugin. Each supported host starts the same
bundled stdio entry point, while the host's own manifest and lifecycle hooks
remain host-specific.

```text
hosts/<id>/
  host manifest + driver + host configuration
          │ stages one common bundle
          ▼
packages/plugin/
  MCP server, tool handlers, configuration, storage, console
          │ calls process-free application APIs
          ▼
packages/core/
  state machine, registry, scheduler, interaction and policy rules
          │ injected ports supplied by Plugin
          ├── Runskein hub ── worker process
          ├── SQLite transcript store
          ├── host lifecycle / filesystem policy
          └── loopback console
```

### Host

A host is where the user talks to their main coding agent. The host owns:

- installation scope and native manifest format;
- the trusted working-directory boundary;
- the stdio MCP entry and reload/disable signals;
- host-specific stop hooks, marketplace or managed-copy behavior.

Host code must not duplicate delegation logic. All hosts reach the same Plugin
bundle and Core policies. See [the host extension guide](host-extension.md).

### Plugin

The Plugin package is the composition root. It owns effects that Core must not
know about:

- MCP schemas and the stable error envelope;
- Runskein adapter and worker process startup;
- configuration and environment discovery;
- canonical project/cwd checks and recursion evidence;
- SQLite transcript persistence and instance recovery;
- shutdown, orphan handling, structured logs, and the console.

The Plugin maps a tool call to Core, supplies the required ports, and maps the
Core result back to the frozen MCP shape.

### Core

Core is a process-free TypeScript library. It starts no child process, opens no
socket, reads no environment variable, and writes no file. Its responsibilities
are pure or port-backed application rules:

- worker admission decisions over injected descriptors;
- session creation, configuration, fork, close, and legal state transitions;
- one-turn-per-session execution with bounded global/per-engine scheduling;
- interaction registration, response, expiry, and invalidation;
- transcript-page semantics and stable domain errors.

Keeping Core free of host and process code makes the state machine testable and
keeps every host on one implementation.

### Runskein and workers

Runskein is the runtime below TaskShuttle. It discovers installed worker CLIs,
starts their processes, and presents a common session/event API. TaskShuttle
chooses an explicit engine id and asks Runskein to open the session. The worker
does the coding work in the requested cwd; TaskShuttle does not sandbox that
directory.

Most workers speak ACP through Runskein adapters. pi is driven through
Runskein's translating shim. This difference is hidden from the TaskShuttle
tools, but a capability advertised by a worker can still be defective; the
support record names those cases.

## A request lifecycle

1. The host starts the bundled launcher. Plugin resolves its install
   configuration, data root, project boundary, and delegation verdict.
2. Plugin creates an instance lock and transcript store, then discovers the
   worker registry. A console starts only when the install surface grants it
   and the instance is established as a root.
3. The host agent calls `workers_list` and chooses an explicit engine. There is
   no `auto` engine.
4. `session_create` validates the cwd, permission mode, and engine admission.
   Plugin asks Runskein to start one worker session and records the session.
5. `turn_start` accepts a prompt, reserves the scheduler slot, and runs the
   worker turn asynchronously. A session has at most one prompt in flight;
   other turns wait in the Plugin queue.
6. Worker events are normalized, appended to the transcript, and projected to
   the host agent through the transcript tools. Permission and question events
   become pending interactions when the selected policy requires a response.
7. The host agent reads the terminal turn and transcript, judges the result, and
   may start another turn or another worker session. TaskShuttle never creates
   follow-up work by itself.
8. `session_close` ends the session. Plugin shuts down through Runskein,
   releases the instance resources, and applies retention rules.

## State and data flow

A **worker** is an engine process. A **session** is one conversation with one
worker. A **turn** is one submitted prompt in that session. An
**interaction** is a permission request or question that needs a policy or
orchestrator response. A **transcript** is the ordered event record saved as
the worker produces it.

```text
session
  ├── turn 1 ── worker events ──► transcript seq 1..n
  ├── turn 2 ── worker events ──► transcript seq n+1..m
  └── pending interaction ──────► orchestrator response
```

The plugin keeps live session/turn/interaction state in the Core registry and
stores raw transcript events in the instance's SQLite store. The console reads
the same projections and receives already-persisted events; it is observation
only and has no mutation routes.

The host agent carries context between workers. A new session does not inherit
another worker's conversation unless the host explicitly passes the needed
files, notes, or result. `session_fork` is an engine capability, not a plugin
workflow primitive; if an engine cannot deliver it, the tool returns the
engine's typed failure.

## Security boundaries

TaskShuttle's safety decisions happen before a worker can act:

- install configuration controls allowed roots, limits, console access, and
  whether unverified engines may be admitted;
- cwd validation keeps a session inside the host's trusted working directory;
- recursion evidence prevents a delegated worker from opening another
  orchestrator instance or console;
- permission modes (`allow`, `ask-orchestrator`, `deny`) govern only
  permission requests the worker actually sends;
- transcripts and configuration files are private filesystem data;
- the console binds to `127.0.0.1`, is read-only, and has no authentication:
  access to the loopback port is access to that instance.

These are product boundaries, not an operating-system sandbox. A prompt cannot
widen them, and a worker's cwd does not limit what its own CLI can reach on
disk. The exact predicates and failure codes a caller can rely on are in
[the tool contract](tool-schemas.json); the boundaries and the reason for each
are in [SECURITY.md](../SECURITY.md).

## Why the split matters

The split lets one host change its install format without changing scheduling,
one worker adapter change without changing MCP schemas, and one policy test
cover every host. It also prevents a tempting but unsafe shortcut: putting
engine-specific branches in each host driver.

When a change crosses an external tool contract, security boundary, state
machine, scheduling rule, support claim, or acceptance gate, record the decision
and review it before implementing. [CONTRIBUTING.md](../CONTRIBUTING.md) says
what that means for a change arriving from outside; the maintainers keep the
full discipline with the records it produces.
