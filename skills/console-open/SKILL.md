---
name: console-open
description: Open the plugin's loopback observation console in the operator's browser, picking the right instance among several. Use when the operator asks to see, watch, or open the console/dashboard for live worker sessions.
---

# Console Open

The observation console is a loopback-only web UI each plugin instance serves when the install surface enables it (console-design §4). It has **no authentication**: the URL is the access (ADR 0032). So the command below is not hiding a secret — it exists because it picks the right instance among several and confirms the listener really is that instance before opening a browser at it.

## Preferred: the subcommand

Run exactly this via the shell tool:

```
taskshuttle console open
```

The subcommand finds the live instance, confirms the port answers as that instance, and hands `http://127.0.0.1:<port>/` to the system browser.

**`taskshuttle: command not found` is a normal answer on some hosts, and
it is not the last-resort fallback's cue.** The name is an npm `bin`, so it
reaches `PATH` only through `npm install -g` or `npm link`. Whether that has
happened depends on how the host starts this plugin, not on anything the
operator did wrong:

| host | how it starts the plugin | is the bin on `PATH`? |
| --- | --- | --- |
| Claude Code | `node <plugin-root>/dist/launch.js` | usually not — nothing required it |
| Codex | `taskshuttle-launch` | yes: the plugin could not have started otherwise |
| Kimi | `taskshuttle-launch` | yes, same reason |
| OpenCode | loads `index.mjs` in process, no MCP command | usually not — that package ships no bin |

So on Codex and Kimi the preferred form works, and a `command not found` there
means something else is wrong — say so rather than routing around it. On Claude
Code and OpenCode the absence is expected; go to **Same guarantee, by path**,
which is the same program and picks the instance the same way.

## Same guarantee, by path

Every distribution ships the same entry point beside the runtime, and it takes
the same subcommand:

```
node <plugin-root>/dist/launch.js console open
```

Finding `<plugin-root>`:

1. On Claude Code, `$CLAUDE_PLUGIN_ROOT` — **check that it is set, do not
   assume**. That name appears in the MCP server config because the host
   substitutes it there, which is not the same as exporting it to your shell.
   It is a Claude Code name; the other hosts neither set it nor use it.
2. On OpenCode, the installed `@taskshuttle/opencode` package directory: it
   ships `dist/` beside `index.mjs`, so `dist/launch.js` is there.
3. Otherwise ask the operator for the plugin directory. One question is cheaper
   than guessing, and much cheaper than the last resort below.

Everything the subcommand guarantees holds here — same code, same identity
probe, same exit codes.

Worth telling the operator once, on the hosts where the bin is absent: `npm
link` in the plugin directory (or a global install) puts `taskshuttle` on
`PATH` and makes the preferred form work from then on.

- **Several live instances**: the command narrows first and lists only if that fails. "Inside this process tree" means a shared ancestor *below* the terminal application or login session the two chains both descend from — that top-level process is everything's ancestor and is excluded, so two host sessions under one terminal are not kin. Before listing anything it asks which of the live instances was started inside *this* process tree — the plugin serving this session runs either as a separate process the host started, a sibling of the shell this command runs in (Claude Code, Codex, Kimi), or inside the host process itself (OpenCode) — and if exactly one candidate is kin it opens that one and says so in a line naming how many were live. Then the probe runs as always.

  When it lists instead, it exits 1 with the candidate instance IDs, hosts, and ports: re-run with `taskshuttle console open --instance=<id>`; an unambiguous prefix of the ID is accepted. **Never guess by recency or working directory** — and do not read `instance.lock` or walk `ps` yourself to reproduce the narrowing, which is the command's to make, not yours.

  **If you are an agent, you do not have to guess at all.** Call `workers_list`: its response carries `instanceId`, the id of the instance that answered, and only the instance serving this session can answer your tool call (ADR 0043). That is an exact answer where kinship is only evidence, so pass it straight to `--instance=<id>`. It is the id and nothing else: not the port, not whether a console is enabled or listening — the command still reads the manifest and still runs the identity probe. An operator at their own terminal has no such channel, which is who the narrowing is still for.

  It does not fire, correctly, when: an operator runs the command from their own terminal (nothing is kin to them, and they are the ones who know which session they meant); two sessions were started from one shell (both are kin); two host sessions were started from *one terminal application* in different windows or tabs, which meet only at that application and so are kin to nothing of each other's; or the process table cannot be read. All four list. And an `--instance` you typed is never resolved from the process tree, even when your prefix matches several — the command hands an ambiguous instruction back rather than answering it from evidence you did not cite (ADR 0042).
- **"no console is enabled"**: no instance has a `console.json`. That has two causes and they need opposite answers, so **read the running instance's manifest before advising anything** — `<data-root>/instances/<id>/instance.json` records `delegation.provenance`:
  - `provenance: "root"`, or no `delegation` field at all: the console really is off in the install configuration. Tell the operator to set `console.enabled: true` and restart the host session.
  - `provenance: "unavailable"` or `"marker"`/`"ancestry"`: the console was **withheld**, not disabled, and turning the setting on changes nothing. The instance's `console_withheld` log line names which doubt the verdict reached — a scan that could not be read, a lapsed budget, an ancestor identity, a start-time collision — and that cause is what to act on. This branch is here because for the whole life of the defect ADR 0033 fixed, every instance on an ordinary machine settled `unavailable` and this skill sent the operator to a setting that was already correct.
- **"not listening"**: the command found a record it could not open. The two **lines** are different and need different responses; the second line covers more than one situation, so do not read a cause into it:
  - *The instance is gone.* Its lock is dead, so the port is never contacted at all. The line names no instance and counts the files: `console is not listening: N console.json file(s) left behind by an instance that is no longer usable`. Ask the operator to start a fresh host session.
  - *The port was contacted and did not answer as this instance.* The line names the instance and the port. It **deliberately names no condition**, because several reach it and the probe cannot always tell them apart: a refused connection, an expired deadline, a non-200, a body that is not this instance's id. Do not translate it into a diagnosis — read the candidate listing instead, and if the listing showed other candidates, open one of those with `--instance=<id>`.

    Two known causes, neither of which the line distinguishes:

    - *An older build.* Consoles from before the credential was removed answer the identity probe with a `401`, so a newer `console open` declines them — correctly, since it cannot confirm which instance is there. Nothing is broken and nothing needs restarting on that account.
    - *A cold console, on a build without the start-time warm.* `/api/instance` awaits engine discovery, which costs seconds on its first call and is cached after it, so the probe's own request paid that cost and expired — every first attempt failing, every retry succeeding, because the timed-out request warmed the cache. Starting the listener now warms discovery itself, so this should no longer be reachable. If a first attempt does fail and an immediate retry succeeds, that is what happened: say so rather than reporting a flake, and do not send the operator to an upgrade or a restart, which fix neither cause.

  **A browser tab left open on a console from before an upgrade goes silent when that instance stops.** Its page is the pre-fix client, whose stream error handler renders nothing, so it will sit there looking connected. Tell the operator to close it and open the new console: reloading that tab reaches the old port, which nothing is serving any more, so they get the browser's own connection-refused page. A page served by the current build does render the failure — that is the fix in this record — but this tab is not one of them and a reload does not make it one.

## Last resort: the host refuses to run commands at all

Only when neither form above can be executed — the host will run no shell
command, not merely that the name is missing from `PATH`. This path gives up the
identity probe and puts the address into the conversation, which under ADR 0032
*is* the access. Say so to the operator before doing it:

1. Read `<data-root>/instances/*/console.json` (default data root `~/.taskshuttle`, or `$TASKSHUTTLE_DATA_ROOT` when set). Each live entry holds `{ port, startedAt }` and is mode 0600. An older instance's file may also carry a `token` field — ignore it; the current console has no credential.
2. An entry is live only while its sibling `instance.lock` owner process exists; ignore entries whose instance directory has no lock.
3. Hand the operator the URL `http://127.0.0.1:<port>/` to paste into their own browser. Nothing confirms that port still belongs to this instance — that is the check being skipped — so if the page is not the console the operator expected, stop and start a fresh host session. Keep the URL out of anywhere that outlives the session: it grants access for as long as the instance lives and, unlike the token it replaced, there is nothing to rotate.

Never probe the port to decide liveness — something unrelated may hold it now (§4).
