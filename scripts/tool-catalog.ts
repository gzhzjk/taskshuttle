import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as ajvModule from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';

/** One gate finding, in the shape `scripts/artifact-gate.ts` collects. */
export interface CatalogIssue {
  path: string;
  message: string;
}

/** The published contract, as `docs/tool-schemas.json` holds it. */
export interface ToolCatalog {
  version: string;
  $defs: Record<string, unknown>;
  tools: Record<string, { inputSchema: unknown; outputSchema: unknown }>;
}

/** Where the contract lives, relative to a repository root. */
export const TOOL_CATALOG_PATH = 'docs/tool-schemas.json';

// Ajv's `strict` option lints how a schema is *written* — chiefly unknown
// keywords and unknown formats — which is not the strictness this check is
// about. It is off so that an authoring change to the hand-maintained catalog
// cannot fail this case for a reason that says nothing about the response.
// Measured, because an earlier version of this comment claimed more: the
// current catalog compiles under `strict: true` as well, so nothing here is
// working around a schema Ajv would reject today.
//
// What ART-018 needs is that the data be rejected for an unexpected key, and
// that comes from the catalog's own `additionalProperties: false` — which
// `validateOutputAgainstCatalog` checks for rather than assuming, because a
// schema that lost it would silently stop detecting drift.

// ajv is CommonJS with a `default` export, so under NodeNext the namespace
// carries the constructor one level down. Reaching for it explicitly beats an
// interop flag that would change how every other import in this repository
// resolves.
const Ajv2020 = (ajvModule as unknown as { default: new (options: { allErrors: boolean; strict: boolean }) => import('ajv').default }).default;
const ajv = new Ajv2020({ allErrors: true, strict: false });

/**
 * Reads the published tool catalog.
 *
 * @param rootDirectory - repository root holding `docs/tool-schemas.json`.
 * @returns the parsed catalog.
 * @throws SyntaxError when the file is not JSON, and any `readFile` errno when
 * it cannot be read — both are gate failures with nothing to add.
 */
export async function readToolCatalog(rootDirectory: string): Promise<ToolCatalog> {
  return JSON.parse(await readFile(join(rootDirectory, TOOL_CATALOG_PATH), 'utf8')) as ToolCatalog;
}

/**
 * Validates one tool's live success output against the **published** catalog.
 *
 * This does not diff the two schema documents; it validates a **live response**
 * against the published one, which catches the drift that matters — a field on
 * one side and not the other — without either document having to describe the
 * other. It is one implementation with two call sites, the artifact gate and
 * `test/core/workers-list-identity.test.ts`, so both notice the same drift, and
 * it is why the gate opens the catalog at all: before ADR 0043 it counted tools
 * and never read the file. Every tool call
 * still validates against `packages/plugin/src/schemas.ts` alone, and
 * `test/tool-schema-catalog.test.ts` compares one field of `Cause`; for every
 * tool but `workers_list` a field added on one side alone would still ship
 * green with the count still 20.
 *
 * The composition — the selected schema plus the catalog's `$defs` — is the one
 * `design.md` §11 already specifies for building standalone schemas, so a `$ref`
 * such as `#/$defs/WorkerSummary` resolves.
 *
 * @param catalog - the parsed catalog.
 * @param tool - the tool name, as `tools` keys it.
 * @param output - the structured content the tool returned on success.
 * @returns one issue per validation error, empty when the output conforms.
 */
export function validateOutputAgainstCatalog(catalog: ToolCatalog, tool: string, output: unknown): CatalogIssue[] {
  const entry = catalog.tools[tool];
  if (entry === undefined) return [{ path: TOOL_CATALOG_PATH, message: `the catalog publishes no tool named ${tool}` }];
  const schema = entry.outputSchema;
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return [{ path: TOOL_CATALOG_PATH, message: `${tool}.outputSchema is not a schema object` }];
  }
  // A schema that admits unknown keys would pass a response carrying a field the
  // catalog never published, which is the drift this case exists to catch.
  if ((schema as { additionalProperties?: unknown }).additionalProperties !== false) {
    return [{ path: TOOL_CATALOG_PATH, message: `${tool}.outputSchema does not set additionalProperties: false, so it cannot detect an unpublished field` }];
  }
  const validate = ajv.compile({ ...(schema as Record<string, unknown>), $defs: catalog.$defs });
  if (validate(output)) return [];
  return (validate.errors ?? []).map((error: ErrorObject) => ({
    path: 'packages/plugin/src/schemas.ts',
    message: `${tool} output does not match the published catalog at ${error.instancePath === '' ? '<root>' : error.instancePath}: ${error.message ?? 'invalid'}`,
  }));
}

/**
 * ART-018 (ADR 0043): `workers_list` reports the instance that answered.
 *
 * Two independent assertions on one response. The contract half is
 * {@link validateOutputAgainstCatalog}. The identity half compares the returned
 * id with the manifest **the caller read off disk** — passing an id taken from
 * the same runtime object that produced the response would prove nothing,
 * because two values derived from one field agree under any consistent lie.
 *
 * @param options.catalog - the parsed published catalog.
 * @param options.output - the structured content `workers_list` returned.
 * @param options.manifestInstanceId - `instanceId` as read from
 * `<data-root>/instances/<id>/instance.json`.
 * @param options.consoleEnabled - whether this instance was started with a
 * console; carried only so a failure says which of the two runs produced it.
 * The expected result does not differ between them, and that is the point:
 * the field is unconditional (ADR 0043 decision 2).
 * @returns every issue found; empty when the response is contract-clean and the
 * id matches the manifest.
 */
export function checkWorkersListIdentity(options: {
  catalog: ToolCatalog;
  output: unknown;
  manifestInstanceId: string;
  consoleEnabled: boolean;
}): CatalogIssue[] {
  const where = `with the console ${options.consoleEnabled ? 'enabled' : 'disabled'}`;
  const issues = validateOutputAgainstCatalog(options.catalog, 'workers_list', options.output).map((issue) => ({
    ...issue,
    message: `${issue.message} (${where})`,
  }));
  const reported = (options.output as { instanceId?: unknown } | null)?.instanceId;
  // Reported separately from the schema result: a missing or mistyped id is a
  // contract failure above, and saying "does not match the manifest" about a
  // value that is not a string names the wrong defect.
  if (typeof reported === 'string' && reported !== options.manifestInstanceId) {
    issues.push({
      path: 'packages/plugin/src/runtime.ts',
      message: `workers_list reported instanceId ${reported} ${where}, but instance.json on disk records ${options.manifestInstanceId}`,
    });
  }
  return issues;
}
