# Adding a TaskShuttle host

A host is the coding-agent shell where a user installs TaskShuttle and talks to
their main agent. Workers are a separate concern: a host can also be a worker
engine, but a new host does not require a new worker adapter.

This guide covers the repository's host boundary. The generic types and
validators are in [`packages/host-kit/src`](../packages/host-kit/src); the frozen support and
acceptance rules are in
the maintainers' frozen specification and test plan, which are not part of
this repository.

## Before you start

Confirm that the host really needs a new integration. Reuse an existing kit and
the shared launcher when the host can consume a local stdio MCP server. Do not
add host-specific branches to Core or Plugin.

Write down:

- the host's product and version baseline;
- how a user installs, enables, reloads, verifies, and removes a plugin;
- which scopes it supports (`user`, `project`, or `local`);
- how it loads an MCP server and shared skills;
- how it runs a stop/disable hook, if it has one;
- what command can validate the installed artifact.

A new host changes the support matrix. Under the repository change discipline,
create or update the decision record and requirements evidence before calling
the host supported. Implementation comes after that review.

## Directory shape

Create one directory with the host id as its name:

```text
hosts/<id>/
├── host.json                 # required manifest
├── driver.ts                 # required, side-effect-free command planner
├── <host manifest>           # host-native static configuration
├── .mcp.json                 # normally the shared stdio entry
├── hooks/                    # optional host-native lifecycle hooks
├── dist/                     # generated from the plugin bundle
└── skills/                   # generated from the shared skills
```

Only directories containing `host.json` are discovered. Keep the host's
configuration and policy under this directory. Do not edit another host's
directory or copy the generated bundle by hand.

## The manifest

`host.json` is validated before a host is built or deployed. It is strict:
unknown top-level keys and unsafe paths fail validation.

A minimal manifest looks like this:

```json
{
  "schemaVersion": 1,
  "id": "example-agent",
  "kind": "stdio-config",
  "baseline": "1.2.3",
  "scopes": ["user", "project"],
  "kits": ["stdio-mcp", "shared-skill"],
  "driver": "driver.ts",
  "artifacts": [
    { "role": "mcp-config", "path": ".mcp.json", "generated": false },
    { "role": "runtime-bundle", "path": "dist", "generated": true },
    { "role": "skills", "path": "skills", "generated": true },
    { "role": "license", "path": "LICENSE", "generated": true },
    { "role": "notice", "path": "NOTICE", "generated": true }
  ]
}
```

Manifest rules:

- `id` must equal the directory basename and use the host's stable id.
- `kind` is `marketplace-plugin`, `stdio-config`, or `managed-plugin`.
- `baseline` is the exact host version used for the support claim.
- `scopes` contains one or more unique values from `user`, `project`,
  and `local`.
- `kits` contains only generic capabilities from
  `stdio-mcp`, `shared-skill`, `stop-hook`, `marketplace`, and
  `managed-copy`.
- `driver` and every artifact path are normalized, relative paths that stay
  inside the host directory.
- Each artifact has a unique role and path. Set `generated: false` for
  host-owned static files and `true` for files staged by the build.
- If you use `versionedManifest`, it must name one static declared artifact.
- Declare generated `dist` (or a generated path containing it) and the
  generated `dist/launch.js` and `dist/nanny.js` must be present after
  staging. The generic build rejects a host that omits either runtime entry.

The full `HostManifestV1` type and path checks are implemented in
[`packages/host-kit/src/manifest.ts`](../packages/host-kit/src/manifest.ts).

## The driver

A driver describes operations; it does not execute them. Export a default
`HostDriver` whose id matches the manifest:

```ts
import {
  createHostDriver,
  type HostDeployContext,
} from '@taskshuttle/host-kit';

async function deploy(context: HostDeployContext) {
  if (!context.onPath('example-agent')) {
    return { status: 'skipped' as const, detail: 'example-agent CLI not on PATH' };
  }

  // Use context.files for scoped filesystem access and context.run for argv.
  // Never build a shell string.
  const result = await context.run({
    binary: 'example-agent',
    argv: ['plugin', 'install', context.roots.repository],
  });

  return result?.status === 0
    ? { status: 'ok' as const, detail: 'plugin installed' }
    : { status: 'manual' as const, detail: 'finish the install in the host UI' };
}

export default createHostDriver('example-agent', {
  deploy,
  installDetail: 'install the host-native plugin',
  verify: [{ binary: 'example-agent', argv: ['plugin', 'list'] }],
  verifyDetail: 'check the host plugin list',
  uninstall: [{ binary: 'example-agent', argv: ['plugin', 'remove', 'taskshuttle'] }],
});
```

Use `createHostDriver` for command plans and the standard staging behavior.
Implement a custom `HostDriver` only when the host needs behavior the
declarative helper cannot express.

The driver contract includes:

- `inspect(context)`: read-only host inspection;
- `stage(context)`: materialize generated bundle, skills, and legal files;
- `install(context)`, `verify(context)`, `uninstall(context)`: lifecycle
  plans for the release gate;
- optional `deploy(context)`: the local deployment operation used by
  `pnpm run deploy`;
- optional `validateArtifacts(context)`: host-native manifest and hook checks.

A driver may return `ok`, `manual`, or `skipped`; the central coordinator
owns command execution and reports the result. For a host that cannot expose a
CLI install operation, return a manual instruction rather than pretending the
operation ran.

## Safety rules

The validator rejects host drivers that:

- import or invoke `node:child_process` or shell commands;
- read `process.env` or `process.cwd()` directly;
- import filesystem modules or write outside the scoped filesystem helpers;
- depend on another host by id or branch on host-specific logic in shared kit
  code.

Use the supplied `HostDeployContext`:

- `context.files.repository` for repository inputs;
- `context.files.home` for user configuration;
- `context.files.managed` only when the coordinator granted a validated
  managed-host root;
- `context.run` / `context.requireRun` for argv-only commands;
- `context.roots` for already validated roots;
- `context.env` for host environment supplied by the coordinator.

Do not put secrets in manifests or command arguments. Preserve unrelated user
configuration when merging a host file, and write a backup before a deployment
driver changes an existing file.

## Generated output and shared kits

The build receives one immutable Plugin bundle and the shared `skills/`
directory, then stages the generated artifacts listed by your manifest.
Generated host `dist/` and `skills/` are not edit targets; change
`packages/plugin/src/` or the repository-level `skills/` source and rebuild.

Claim a kit only when the host consumes it:

| Kit | Use it when |
| --- | --- |
| `stdio-mcp` | the host starts the bundled launcher as a local stdio MCP server |
| `shared-skill` | the host loads TaskShuttle's generated delegation skill |
| `stop-hook` | the host can invoke the nanny during stop/disable/reload |
| `marketplace` | the host installs a packaged marketplace/plugin directory |
| `managed-copy` | the host keeps a coordinator-managed copy that is synchronized later |

The host-kit helpers are deliberately engine-neutral. If two hosts need the same
filesystem or manifest behavior, add it to `packages/host-kit`; do not make
the kit import a concrete host.

## Registration and support evidence

Host discovery is manifest-driven and sorted by id. After adding the directory:

1. ensure the host baseline and scope are represented in the frozen support
   documentation and release metadata;
2. add host-specific artifact and lifecycle checks to the test plan;
3. add or update the host live driver and validator;
4. run the build and artifact checks;
5. run the host gate against the shipped artifact;
6. run the real host install/reload/verify/disable flow on the declared
   baseline and record the evidence.

Use the repository commands in this order:

```bash
pnpm check
pnpm release:hosts
pnpm release:hosts --confirm=<id>   # when the operation may change real config
```

The default release gates use temporary trees and do not silently claim a
real host install. Missing CLIs are recorded as environment outcomes; an
unreachable registry is a failure. Add the evidence to
[`release/metadata.json`](../release/metadata.json) only after the live run
has actually established it.

## Review checklist

Before opening a change, verify:

- [ ] `host.json` passes strict validation and every path is inside
      `hosts/<id>/`.
- [ ] `driver.ts` exports the same id and uses only scoped/argv APIs.
- [ ] The host can load `dist/launch.js` and `dist/nanny.js` after staging.
- [ ] Static manifest/configuration files match the host's documented schema.
- [ ] Install, verify, uninstall, reload, and stop behavior have a plan.
- [ ] The host does not introduce a second MCP/tool implementation.
- [ ] Generated files were rebuilt, not edited directly.
- [ ] Tests, artifact gate, host gate, support evidence, and documentation agree.
