---
name: delegate-workers
description: Delegate bounded, explicitly selected coding tasks to TaskShuttle workers, follow and inspect their transcripts, answer what they ask, and close them when the work is done. Use when another coding agent should implement, review, or investigate an independent task.
---

# Delegate Workers

Use the TaskShuttle tools to create a session with an explicit engine, submit a complete standalone prompt, and read the resulting transcript. The orchestrator owns task decomposition, ordering, worktree rules, and review decisions; the plugin does not invent a workflow.

## Workflow

1. Call `workers_list` and pick one engine by name — see **Choosing an engine**.
2. `session_create` with a `cwd` inside the host's working directory, and only the MCP IDs you intend to expose. Permissions are approved silently by default; pass `permissionMode: "ask-orchestrator"` if you want to be asked, or `"deny"` to refuse everything the worker requests. Tell the operator what you just created — its name and `sessionId` — and give them the console URL again so the new worker is one click away; see **Watching** for where that URL comes from and why you must never assemble one.
3. Submit a self-contained `turn_start` prompt describing the expected work and verification, with the project brief and the task's file list linked rather than pasted — see **Context handoff**. Use `high`, `normal`, or `low` priority deliberately. After the first one of this host session succeeds, open the console once — see **Watching**.
4. Follow the work with `turn_list` — see **Pacing**. When it reports `pendingInteractionIds`, read them with `interaction_list` to see what is being asked and reply with `interaction_respond`. **`interaction_list` filters by `state` and defaults to `pending`**, so an empty result means nothing is waiting on you — not that nothing happened. Auto-approved permissions are recorded as `responded`; ask for that state to see what the worker was allowed to do (`expired` and `invalidated` are the other two).
5. When the turn is terminal, read the result with `transcript_read` (page with `afterSeq` / `nextSeq`; it is the worker's own output, not a summary the plugin made). A single event larger than the response budget fails the page with `PAYLOAD_TOO_LARGE` and names the `seq` in its details — fetch that one with `transcript_event_get`, in `maxBytes` slices, then resume the page after it.
6. Judge that result against the `Accept` you wrote, and decide whether to modify the task, ask another worker to review, or finish. Never assume the plugin has judged “blocking” issues.
7. When that line of work is over, `session_close` it. See **Closing** — nothing closes a session for you.

## Choosing an engine

**The list is not fixed, and this page is not the list.** Runskein gains adapters;
`workers_list` is what exists right now. Pick from what it returned, not from
memory and not from the examples below. There is no `auto` — sentinel ids are
rejected, and choosing is your job.

One thing the tools cannot show you: some engines do not speak ACP natively, and
Runskein drives them through a translating shim (today that is `pi`). It is
invisible from here — sessions, turns, transcripts and permissions behave as they
do anywhere else — but those engines can fail in the translation rather than in
the model, so quote their errors verbatim when reporting them.

Three fields decide it, and they answer different questions:

| Field | Question |
| --- | --- |
| `usable` | will `session_create` accept this engine at all |
| `verification` | did the required live round trip establish admission evidence — `unverified` includes a failed run, while `unknown` means no record |
| `requirements` | of the capabilities you asked about, which are `met`, `unmet`, or `defective` |

`requirements` only appears if you ask for it: pass `requires` to `workers_list` — up to eight dotted
capability paths as `worker_describe` reports them (`session.fork`, `loadSession`). It annotates every
engine and removes none, so you still see *why* one does not qualify rather than a shortened list.

**`defective` is the one that costs time if ignored.** `worker_describe` reports
what an engine advertises, which is not always what it delivers, so a capability
that is advertised but recorded broken lands in `defective` rather than in `met`:
the call still returns `ENGINE_ERROR` while the descriptor says `true`, and you
see it before you design a workflow around it instead of after.

So route by the answer, not by engine name — send work that needs a capability to
an engine where that path came back `met`. Each defect is scoped to the
capability it names, so the rest of that engine is worth using; check what you
actually need rather than writing the engine off.

There is usually a way to proceed without the capability, and it is worth
planning rather than improvising. For a defective `session.fork`, that is a
fresh session carrying the two handoff files — see **Context handoff**; keep
`systemInstructions` for the standing conventions rather than pouring the task's
context into it. Either way the new session inherits no engine-side state, so
say so in the prompt instead of treating it as a fork.

## Default profiles

A project may declare worker-default profiles — named tiers of engine config
(model, reasoning, …) that the plugin fills in when you do not specify them.
The file is `<data-root>/<project-key>/config.json` (the same data root the
plugin already uses; the project key encodes the host's working directory).
`project_init` generates it for you — see the next section; hand-placement by
whoever administers the installation works too. If no file exists, nothing
changes and every `session_create` behaves as it always has.

- Pass `profile: "<name>"` on `session_create` to select a tier; without it, the
  file's `defaultProfile` applies. An unknown name fails with
  `INVALID_ARGUMENT` — as does naming one when the project has no file at all.
- **Your explicit `config` always wins, per key.** A profile fills only the keys
  you left out, so a one-off override needs no ceremony.
- Name profiles after the role vocabulary you already write in prompts
  (`implementing | reviewing | investigating`) — the profile name *is* the role;
  the plugin stores nothing extra on the session.
- Key names are engine-defined. Check `worker_describe`'s `configOptions` for
  the engine you target rather than assuming two engines share a key; a wrong
  key fails at creation with the engine's own error, same as passing it
  explicitly would.
- What got filled is visible on `session_get`'s `config` — indistinguishable
  from config you passed yourself.

`session_fork` never consults the file: a child inherits the parent's config
verbatim, filled or not.

## First dispatch in a project: `project_init`

Before your first `session_create` in a project, if you have not seen this
project's defaults file yet, call `project_init` once. It generates the file
from the live engine registry — only installed engines get sections, with the
keys each engine's own descriptor reports — and starts the console.

- Read the returned `content` to the user verbatim and ask whether they want to
  change anything. If they do, edit the file yourself at the returned `path`;
  the plugin re-reads it on every `session_create`, so no notification is
  needed. If they don't, you are done — the file is already in effect.
- `enginesOmitted` lists engines the registry knows that have no section in the
  file. If the user later installs one, call `project_init` with
  `refresh: true`: it appends the new engine's section and never rewrites or
  deletes a key already there.
- An existing but invalid file is an error, not an overwrite — the tool refuses
  and nothing is returned or replaced; the fix is a manual edit at `path`.
- `console.state` tells you the console outcome: `started` /
  `already-running` / `start-failed` / `disabled` (the operator set
  `allowInitStart: false` on the install surface) / `withheld` (this instance
  could not establish that it is a root, so the console fails closed while the
  tools keep serving — the file side of the call still happened). To open it,
  run `taskshuttle console open` — do **not** build a URL from the
  output; that command is what picks the right instance and confirms the
  listener really is that instance. The console has no token (ADR 0031), so the
  address it prints is itself the access: fine to hand the operator, not
  something to leave anywhere that outlives the session.
- Inside a delegated worker the tool does not exist for you — initialisation is
  the orchestrator's job. Delegation is established by the environment marker
  **or** by this instance running underneath a live one, so an engine that
  scrubs its MCP servers' environment does not get you a second level.

This is also the moment to write the project brief, if this project has none
yet — see **Context handoff**. Both are once-per-project setup, and doing them
together means the first worker you dispatch already has somewhere to read.

`verification.knownDefects` in `release/metadata.json` is the authoritative list;
`requirements.defective` is that same list applied to the engine in front of you.
Every entry is bound to the component version it was observed at, so bumping an
engine or a wrapper pin forces it to be re-checked or retired — which is why
asking beats remembering.

## The worker prompt

A worker cannot see the conversation that produced its task, so every `turn_start` prompt has to stand on its own. State four things:

```
Scope:   which files it may touch, and what it must leave alone
Context: what is already true — prior decisions, where the relevant code lives, what has been tried
         (link the two brief files rather than retelling them — see **Context handoff**)
Accept:  the command that must pass, or the observable condition that means done
Role:    implementing | reviewing | investigating
```

A prompt missing `Accept` is the common failure: the worker stops when it believes it is finished rather than when it is, and the orchestrator has nothing to check the result against.

`prompt` is an array of content blocks (text, image, resource link, embedded resource), not a string. Do not ask a worker to delegate further — it cannot: a session created from inside a worker is refused by the recursion marker, so the task would fail rather than fan out.

## Turn timeouts

`turn_start` takes `timeoutMs`, and on the one session anyone here has measured
it was **the largest single source of wasted wall time**. That session spent 81
minutes to do 4.8 minutes of tool work: eight of its twenty turns hit a 300 s or
600 s ceiling, and six later turns did nothing but recover from those — 30% of
the session re-deriving conclusions a killed turn had already reached.

Size it to the task, not to your patience:

| Task shape | Order of magnitude |
| --- | --- |
| a review, a large diff, anything that reads a lot and then runs a test suite | 1800 s |
| a bounded edit with a named acceptance command | 600 s |
| a single question against code already in the worker's context | 120 s |

Two things this is not. It is **not** a promise about how long the work takes —
a turn that finishes in 90 s finishes in 90 s whatever ceiling you set, so a
generous value costs nothing when the work is quick. And **omitting `timeoutMs`
is not the generous choice**: the field is optional, nothing supplies a default,
and an omitted timeout is an unbounded turn — a wedged worker then never fails
and never tells you. Pass a number.

When one does fire the turn goes `failed` with `turn exceeded its timeout`, and
whatever it had concluded but not yet said is gone. What it already wrote is
still in the transcript, so read that before re-dispatching and say in the next
prompt what the killed turn had established — otherwise the worker pays for that
reasoning a second time, which is exactly what the six recovery turns were.

## Context handoff: two layers

A worker rebuilds its understanding of the project from nothing. Left to itself
it greps its way around first and works second, and N workers pay for N
independent — and mutually inconsistent — explorations. **The expensive part is
the exploration, not the prompt.** Cut it with two files.

A third layer is already there and costs you nothing: engines load the
repository's own instruction file themselves — `CLAUDE.md` for claude-code,
`AGENTS.md` for codex and opencode. Whatever those already say does not belong
in the brief; duplicating it gives the same rule two owners, and the copy that
rots is the one the next worker reads.

**L1, the project brief** — one per project, written once before your first
dispatch (the moment you call `project_init` is a natural one). It belongs in
the working tree, at `.taskshuttle/brief.md`, for one reason: its only reader
is a worker, and the region a worker is sure to be able to read is its own
`cwd`. Track it when the team wants the brief reviewed: the path decides
reachability, `.gitignore` decides version control, and they are separate
choices. This repository tracks its English structural brief; other projects
that deliberately ignore theirs must provide a current reachable copy before
dispatch.

During the one-release rename window, if `.taskshuttle/brief.md` is absent,
read the legacy `.realm-plugin/brief.md` instead; do not write new state there.

**Dispatching into a git worktree:** a tracked brief arrives with
`git worktree add`, so do not copy it into this repository's worktrees. Before
dispatch, verify that the worktree contains the expected brief and read it: the
branch may be changing the structure the index describes, and a stale map is
worse than no map. If a different project deliberately keeps its brief
ignored, its host must arrange a current copy in the worktree before dispatch
and read that copy before handing it to a worker.

It is an **index, not a copy**: which document owns which class of fact, what
each directory holds, which files are generated rather than edited, and the change-one-change-the-other pairs a worker
cannot infer. Keep it to **structural facts** — module boundaries, dependency
direction, verification commands, traps. Never function signatures, line numbers
or implementation details: a worker invalidates those by doing its job, and a
stale brief is worse than none, because the next worker reasons from it and it
reads exactly as credible as a correct one.

Write it yourself when decomposing the task already required you to understand
the structure — the understanding is in your context, so writing it down costs
almost nothing. Delegate a worker to write it when it would take exploration you
do not otherwise need: that worker's context is disposable, yours has to survive
the whole workflow.

Refresh it on three triggers: you changed what it describes (in the same commit,
the way a repository's own paired files work), a worker reported it wrong, or
someone reading it found it no longer matches the code. Never regenerate it
wholesale on a schedule — that discards hand corrections and produces a diff
nobody can review — and never open a workflow by sending a worker to re-survey
the repository, which pays back the exploration the brief just saved.

**L2, the task knowledge** — one per dispatch, at
`.taskshuttle/task-<id>/knowledge.md`, beside the brief for the same reason.
Write it to a file rather than assembling it into the prompt: a worker that dies
can be retried without rebuilding it, another engine can be handed the same
task, and a person can read and correct it. Delete the directory when the task
is done. Write three things:

1. the files that matter, **each with a line range and one line on why it
   matters** — what you are saving is the worker's search, and neither a bare
   path nor a bare reason saves it. `packages/core/src/index.ts:1-40 — the only
   public export barrel; ADR 0048 forbids MCP or Runskein names here` hands over
   a place to start reading. The same line without `:1-40` hands over a file to
   go and search;
2. the task background: what changes, what must not be touched, known traps;
3. **where you are unsure** — "I think X is handled in this file, confirm it" is
   far cheaper than a confident sentence that turns out to be wrong.

Line numbers belong in L2 and **never in L1** — the reason is the two files'
different lifetimes, and it is L1's own rule: L1 outlives the change and a worker
invalidates line numbers by doing its job, while L2 is written for one dispatch
and deleted with it, so its numbers are valid for the whole of its life.

L2 is your judgement, not fact. Say so in the prompt and ask for corrections:
*"if the file list is incomplete, a range is wrong, or a description does not
match the code, say so in your final output."* Without that loop your file lists
never get better, and a bad list sends the worker straight back to exploring.

**Compute the predictable prefix yourself.** Whatever the task, a worker's first
few calls are the same and you can already guess them: `git log`,
`git show --stat HEAD`, `git show HEAD -- <the files L2 names>`. Run them before
dispatching — yourself, or in a cheap disposable worker — and put the output in
the prompt as a `text` block, marked as prefetched. In the measured session those
four calls opened turn 1 and reappeared at the top of nearly every later turn.

What that saves is not the calls. They are cheap; the whole session spent 5.9% of
its wall time inside tool execution. It is the model's *deciding what to run*,
and the round trip before it can start on the actual question.

Two rules keep it honest:

- **Inline the bytes, not a summary of them.** A worker that is given a
  description of a diff fetches the diff to check it, and you have paid for both.

Prefer a `{type: "resource", resource: {uri, text}}` block over a bare `text`
block for the prefetched bytes: it says *this region is a document*, which a
paragraph of pasted diff does not. The `uri` is a label — nothing fetches it —
so name computed output for what it is (`prefetch/git-show-HEAD`). Engines
without `capabilities.prompt.embeddedContext` refuse the turn rather than
degrade it, so fall back to a `text` block for those; the saving survives either
way, because what it saves is the round trip.
- **Bound it by the L2 list.** Prefetch what L2 already names, as a diff rather
  than whole files. An unbounded prefetch fills the context you were trying to
  protect, which is the failure this whole section exists to avoid.

Also say what is *not* fetchable, when you know: a worktree has no
`node_modules`, so a range you name inside a dependency is a range the worker
cannot open. Inline that excerpt or drop it.

Pass both by **link, not by value**:

```
turn_start(prompt=[
  {type: "text",          text: "Scope / Context / Accept / Role …, plus the ask-for-corrections line"},
  {type: "resource_link", uri: "file://…/.taskshuttle/brief.md",          name: "project brief"},
  {type: "resource_link", uri: "file://…/.taskshuttle/task-<id>/knowledge.md", name: "task knowledge"},
  {type: "resource_link", uri: "file://…/<each relevant file>",            name: "<why it matters>"},
])
```

One caveat on both: a session whose `cwd` is a subdirectory cannot necessarily
reach a `.taskshuttle/` at the repository root — engines generally allow the
`cwd` subtree and nothing above it. Open the session at the root, or put a copy
where that session can see it.

Links keep the content out of your own context. Resource links are an ACP
baseline and do not require `capabilities.prompt.embeddedContext`. Only an
embedded `resource` is rejected when that capability is absent or false; fall
back to text blocks listing the same paths with the same one-line reasons in
that case. The saving survives the fallback, because what it saves is the
search.

When the same piece of L2 knowledge shows up in several dispatches, it belongs
in L1 — move it. When something in L1 is used by one kind of task only and needs
re-explaining every time, move it down. Without that rule L1 grows past the
point anyone reads it.

Fork is a different mechanism and a narrower one: `session_fork` inherits the
conversation itself, but only on the same engine, only from an `idle` parent, and
only where the engine really supports it. Use it when you are fanning out
immediately; the two files are what work everywhere else.

## Pacing

**One `turn_list` covers every worker.** With no arguments it returns every turn
of every session, so the cost of checking does not grow with the number of
workers. Calling `turn_get` once per worker is the mistake this section exists to
prevent — it multiplies calls for information one call already contains.

**React to the state, not to the clock.** Every field below is in that same
response:

| What you see | What to do |
| --- | --- |
| any turn `awaiting-interaction`, or a non-zero `pendingPermissionCount` / `pendingQuestionCount` | answer it now — the worker is stopped until you do, and where the install sets a TTL the interaction carries an `expiresAt`. Letting it lapse does not merely deny that one request: the **whole turn** ends `failed` / `INTERACTION_TIMEOUT`, its other interactions are invalidated, and the Runskein prompt is cancelled. The engine does see a deny, but that is the smaller half — not answering costs you the turn |
| every turn `queued` | nothing can move until a slot frees; wait at the long end |
| `running` | back off progressively |
| everything terminal | stop checking |

**Back off, but reset on movement.** First check roughly five seconds after
dispatch, then double, capped around a minute — and go back to the short end
whenever anything moved: a state changed, or the transcript grew.

**A stalled transcript is a reason to look, not to wait longer.** `transcript_read`
returns `highWatermark`, the event count, so passing your last watermark as
`afterSeq` with `limit: 1` tells you whether the worker is still producing
without pulling its output. A turn that stays `running` while the watermark sits
still for several checks is the one to inspect — plain backoff sleeps longest
exactly when something has gone wrong.

**Calibrate against what already happened.** Terminal turns stay in `turn_list`,
so `finishedAt - startedAt` on comparable past turns is the honest estimate of
how long to leave this one alone before checking at all.

Backing off saves calls, not time: a worker that finishes early is still found
late. So prefer one well-specified task per turn over chopping it into
checkpoints you then have to shepherd — a follow-up turn is for new work, not for
supervision.

**Closing the latency floor: `taskshuttle wait`.** Backoff, however tuned,
still has a floor — a worker that finishes early can sit unnoticed for up to the
current interval (60 s at cap). After dispatching, instead of sleeping through the
first backoff interval, run:

```
taskshuttle wait [--instance=<id>] [--cursor=<n>] [--timeout=<ms>]
# or, where that name is not on PATH:
node <plugin-root>/dist/launch.js wait …
```

It blocks (bounded to ~45 s) polling `<data-root>/instances/<id>/progress.ndjson`
at ~200 ms via `stat` + offset reads — no `fs.watch` — and wakes on either a
terminal turn (`completed`/`failed`/`cancelled`) or a pending interaction
(`interaction_transition to=pending` or `turn_transition to=awaiting-interaction`,
§10). Every exit prints `cursor=<n>` last; pass it as `--cursor` next time — a
turn that finishes between two invocations is then not lost (append-only plus
offsets; a foreign cursor is operator error and out of scope). On wake, confirm
with `turn_get` (or `turn_list` aggregated per above) — the journal is the fast
path, polling the correctness path. Timeout exits `0` with `timeout cursor=<n>`;
reissue with that cursor. I/O errors exit `1` with a cursor where recoverable.
Ambiguous instance (several live under `<data-root>/instances/*/`) lists candidates
and exits `2`, never guessing. **Any absence or error** — journal missing
(`REALM_PLUGIN_LOG=off`, no transitions yet while live), `stat`/`read` failure,
host forbids shell — **falls back to the `turn_list` polling above**; orchestration
correctness never depends on the fast path.

## Watching

Once per host session — after the first `turn_start` succeeds, not before it and
not again for later turns — run:

```
taskshuttle console open
```

If that name is not on `PATH` — expected on Claude Code and OpenCode, which
start the plugin without it; not expected on Codex or Kimi, which start it
through that very bin — run the same program by path,
`node <plugin-root>/dist/launch.js console open`, which is the same program.
The `console-open` skill has the full ladder, including the one path that gives
up the identity check.

There is one console per plugin instance, not per session or per turn, so
opening it again only adds browser tabs. Before any work is dispatched there is
nothing in it to see.

**Repeat the URL whenever you create a session, though.** One console covers
every worker, so a new session needs no new command — but the operator wanting
to look at the worker you just made should not have to scroll back for the
address. Say the session's name and `sessionId` beside it, so they know which
row in the console is the one you mean.

**Relay its last line verbatim.** On success it prints
`opened console for instance <id> at http://127.0.0.1:<port>/`. Repeat that line
later if it helps. **Never build a console URL yourself** — the command exists to
pick the right instance among several and to confirm the port still answers as
that instance, and a hand-assembled URL skips both. Note that since ADR 0032 the
console has no credential, so that address *is* the access for as long as the
instance lives: it is fine to say to the operator, and it does not belong
anywhere that outlives the session.

**You cannot start the console — with one carve-out you have already used.**
`project_init` may start it within the install surface's `allowInitStart` gate,
and reports the outcome in `console.state`; nothing else starts it, and no tool
stops or queries it. That rule and its one carve-out are the whole of it — this
file ships to readers who do not have the specification it used to cite, so the
rule is stated here rather than pointed at. Otherwise the console is enabled in the install
surface and comes up with the plugin, before any tool is served. So a failure is not something to retry:

- *no console is enabled* — it is off in the configuration. Tell the operator to
  set `console.enabled: true` and restart the host session; nothing you do now
  will change it for this run.
- *console is not listening* — the command found a record it could not open.
  That covers more than one situation and they need different responses; the
  `console-open` skill's ladder is the owner of that distinction, so read it
  rather than assuming a dead instance and restarting a session that works.
- *more than one live console* — the command lists the candidates. Re-run with
  `--instance=<id>`; never guess by recency or working directory.

Say it once. Whether the console is available is a fact about this host session,
not about the turn, so repeating the complaint for every dispatch is noise.

## Closing

**Nothing closes a session for you.** There is no idle timeout and no automatic
reaping: a session created and never closed stays open, holding its engine-side
process, until the host session ends. `session_close` is the only thing that
closes one.

**Close when the line of work is over, not when a turn finishes.** A session is
the worker's context — a second `turn_start` on the same session sees everything
the first one did, which is exactly why you reuse it for follow-up work, a fix
after review, or a question about what it just did. Closing after every turn
throws that away and makes the next task start from nothing.

**Closing does not lose the transcript.** A closed session's transcript stays
readable through `transcript_list` / `transcript_read`; only `transcript_delete`
removes it. So there is no reason to keep a session open "so the record
survives" — keep it open only if you may send it more work.

**A failed or cancelled turn is still worth closing** once you have read the
transcript. What you give up is the ability to prompt that same context again,
not the record of what happened.

**What closing gets you.** The engine process is shared: one process per engine
id, however many sessions are on it. Closing one session of an engine changes
nothing on the process; closing the *last* one lets the process be reaped after
about a minute idle. An engine Runskein reaches through an ACP wrapper costs more
than one process — the wrapper spawns CLI processes of its own, each with its own
MCP servers (on `claude-code`, four CLIs and twelve MCP servers for two sessions,
when this was measured), so an abandoned session there costs several processes
and hundreds of megabytes. There is also a hard ceiling: `maxOpenSessions` (32 by
default) counts open sessions, and a run that never closes will eventually be
refused a new one.

**The hub is not yours to close.** The catalogue is frozen at twenty tools and
none of them starts, stops or restarts it. Runskein owns the engine processes and
the plugin quits the hub exactly once, when the host session ends.
So "shut the workers down" means closing your sessions and ending your own
session; if a worker will not stop, `turn_cancel` then `session_close` is the
whole vocabulary you have, and it is enough.

## Safety

Engine selection is explicit — see **Choosing an engine**. An engine that is not
usable is refused rather than quietly substituted.

**`cwd` is a boundary, not a sandbox.** It must resolve inside the directory the
host was launched in — configuration may narrow that, never move it — but it
bounds only where the worker *starts*. Nothing stops it reading or writing
elsewhere afterwards, so anything that matters belongs in the prompt's `Scope`,
not in the assumption that the directory fences it in.

**Permissions are approved silently unless you ask otherwise.** The delegation
decision is made once, when you create the session; after that the worker is not
asked per action, and an ACP permission request covers running commands, not just
writing files. `permissionMode: "ask-orchestrator"` is how you take that back for
a session you do not want to grant in advance, and `"deny"` refuses everything
the worker asks for — including, on the engines described next, every command it
tries to run.

**What the record shows depends on the engine.** Some engines ask the client to
run their commands; each command is then one approval record carrying the argv
and the resolved working directory, and `interaction_list` with
`state: "responded"` is a log of what the worker actually ran. Engines that run
commands inside their own process ask once for the tool and leave no such
record. Both are normal — but do not read an absence of records as an absence of
commands.

Keep prompts and worker results as ordinary text/content blocks; do not create a
finding or severity protocol. Worktree ownership and inter-worker communication
belong in the prompt and remain outside the plugin.
