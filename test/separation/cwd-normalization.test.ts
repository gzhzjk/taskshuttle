import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const isFunctionLike = (node: ts.Node): boolean => ts.isFunctionDeclaration(node)
  || ts.isMethodDeclaration(node)
  || ts.isArrowFunction(node)
  || ts.isFunctionExpression(node)
  || ts.isGetAccessorDeclaration(node)
  || ts.isSetAccessorDeclaration(node);

const callName = (node: ts.CallExpression): string | undefined => {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return undefined;
};

const NORMALIZATION_NAMES = new Set(['realpath', 'resolveCwd', 'verifyCwdBeforeSpawn']);
const RESERVATION_NAMES = new Set(['reserve', 'reserveSession', 'createSession', 'sessionCreate']);

const unwrapAwait = (node: ts.Expression): ts.Expression => ts.isAwaitExpression(node) ? node.expression : node;

interface NormalizationResult {
  position: number;
  bindings: Set<string>;
}

interface ReservationCall {
  position: number;
  node: ts.CallExpression;
}

function functionHasCwdBeforeReservation(functionNode: ts.Node): boolean {
  const normalizations: NormalizationResult[] = [];
  const reservations: ReservationCall[] = [];
  const collect = (node: ts.Node): void => {
    if (node !== functionNode && isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const initializer = unwrapAwait(node.initializer);
      if (ts.isCallExpression(initializer) && NORMALIZATION_NAMES.has(callName(initializer) ?? '') && ts.isIdentifier(node.name)) {
        normalizations.push({ position: node.getStart(), bindings: new Set([node.name.text]) });
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)) {
      const right = unwrapAwait(node.right);
      if (ts.isCallExpression(right) && NORMALIZATION_NAMES.has(callName(right) ?? '')) {
        normalizations.push({ position: node.getStart(), bindings: new Set([node.left.text]) });
      }
    }
    if (ts.isCallExpression(node)) {
      const name = callName(node);
      if (name !== undefined && NORMALIZATION_NAMES.has(name)) normalizations.push({ position: node.getStart(), bindings: new Set() });
      if (name !== undefined && RESERVATION_NAMES.has(name)) reservations.push({ position: node.getStart(), node });
    }
    ts.forEachChild(node, collect);
  };
  collect(functionNode);

  const isNormalizedExpression = (expression: ts.Expression, prior: NormalizationResult[]): boolean => {
    const value = unwrapAwait(expression);
    if (ts.isCallExpression(value) && NORMALIZATION_NAMES.has(callName(value) ?? '')) return true;
    if (ts.isIdentifier(value)) return prior.some((entry) => entry.bindings.has(value.text));
    if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.name) && value.name.text === 'path') {
      const target = value.expression;
      return ts.isIdentifier(target) && prior.some((entry) => entry.bindings.has(target.text));
    }
    if (ts.isObjectLiteralExpression(value)) {
      const cwd = value.properties.find((property) => ts.isPropertyAssignment(property)
        && ts.isIdentifier(property.name) && property.name.text === 'cwd');
      return cwd !== undefined && ts.isPropertyAssignment(cwd) && isNormalizedExpression(cwd.initializer, prior);
    }
    return false;
  };

  if (normalizations.length === 0 || reservations.length === 0) return false;
  return reservations.every((reservation) => {
    const prior = normalizations.filter((entry) => entry.position < reservation.position);
    const argument = reservation.node.arguments[0];
    return prior.length > 0 && argument !== undefined && isNormalizedExpression(argument, prior);
  });
}

function findCwdOrderMatches(source: string, file: string): number {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let matches = 0;
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      if (functionHasCwdBeforeReservation(node)) matches += 1;
      ts.forEachChild(node, visit);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matches;
}

function findCwdReservationFunctions(source: string, file: string): number {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let functions = 0;
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      let hasReservation = false;
      const collect = (child: ts.Node): void => {
        if (child !== node && isFunctionLike(child)) return;
        if (ts.isCallExpression(child) && RESERVATION_NAMES.has(callName(child) ?? '')) hasReservation = true;
        ts.forEachChild(child, collect);
      };
      collect(node);
      if (hasReservation) functions += 1;
      ts.forEachChild(node, visit);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return functions;
}

function findCwdOrder(source: string, file: string): boolean {
  const reservationFunctions = findCwdReservationFunctions(source, file);
  return reservationFunctions > 0 && findCwdOrderMatches(source, file) === reservationFunctions;
}

async function pluginSources(directory: string): Promise<string[]> {
  const entries = await import('node:fs/promises').then(({ readdir }) => readdir(directory, { withFileTypes: true })).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await pluginSources(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files.sort();
}

describe('Phase 2 cwd adapter gate', () => {
  it('SEC-CWD-029: Plugin normalizes cwd before Core reservation', async () => {
    const rawCwdMutation = `function openSession(cwd) {
      const safe = resolveCwd(cwd);
      return core.createSession(cwd);
    }`;
    expect(findCwdOrder(rawCwdMutation, 'mutation-raw-cwd.ts'), 'a Core reservation receiving raw host cwd before verification must be rejected').toBe(false);

    const reversedMutation = `function openSession(cwd) {
      const reservation = core.createSession(cwd);
      return verifyCwdBeforeSpawn(cwd, reservation);
    }`;
    expect(findCwdOrder(reversedMutation, 'mutation-reversed-order.ts'), 'Core reservation must not precede cwd verification').toBe(false);

    const mixedMutation = `function verified(cwd) {
      const safe = resolveCwd(cwd);
      return core.createSession(safe);
    }
    function leaked(cwd) {
      const safe = resolveCwd(cwd);
      return core.createSession(cwd);
    }`;
    expect(findCwdOrder(mixedMutation, 'mutation-mixed-functions.ts'), 'every function that reserves a Core session must pass its normalized cwd').toBe(false);

    const root = process.cwd();
    const pluginPackage = join(root, 'packages', 'plugin');
    const candidates = await pluginSources(join(pluginPackage, 'src'));
    const analyses = await Promise.all(candidates.map(async (candidate) => {
      const source = await readFile(candidate, 'utf8');
      return {
        candidate,
        valid: findCwdOrder(source, candidate),
        reservationFunctions: findCwdReservationFunctions(source, candidate),
      };
    }));
    expect(candidates.length, 'Plugin Runskein adapter must exist before the cwd reservation gate can run').toBeGreaterThan(0);
    const withReservations = analyses.filter((analysis) => analysis.reservationFunctions > 0);
    expect(withReservations.length, 'Plugin Runskein adapter must contain a Core reservation before the cwd gate can run').toBeGreaterThan(0);
    expect(withReservations.every((analysis) => analysis.valid), `every Plugin function containing a Core reservation must normalize cwd before the call: ${withReservations.filter((analysis) => !analysis.valid).map((analysis) => analysis.candidate).join(', ')}`).toBe(true);

  });
});
