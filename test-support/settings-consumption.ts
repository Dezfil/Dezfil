import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { SettingDefinition } from "../src/lib/settings/types";

export interface Consumption {
  file: string;
  line: number;
  kind: "environment" | "resolver" | "unresolved-environment" | "unresolved-resolver";
  name: string;
}
type Sources = Record<string, string>;
const plumbing = new Set(["NODE_ENV", "HOSTNAME", "NEXT_RUNTIME", "TZ", "CI"]);
const definitionFiles = new Set(["catalogue.ts", "numeric.ts", "types.ts", "validation.ts", "resolver.ts"]);

/** Catalogue data and the resolver's dynamic lookup are not their own consumers.
 * Fixtures are excluded by location/name; production messages remain in the scan. */
export function productionSources(root: string): Sources {
  const sources: Sources = {};
  function visit(relative: string) {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!["testing", "test-support", "fixtures"].includes(entry.name)) visit(file);
      } else if (/\.(?:ts|tsx|js|mjs)$/.test(file) && !/\.test\.|-fixture\./.test(file) &&
        !(relative === "src/lib/settings" && definitionFiles.has(entry.name))) {
        sources[file] = readFileSync(path.join(root, file), "utf8");
      }
    }
  }
  visit("src");
  return sources;
}

/** Parse executable accesses, not tokens. Literal maps count only when indexed by
 * an environment read, so a provider-name map cannot count just by existing. */
export function scanConsumption(file: string, source: string): Consumption[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const nodes: ts.Node[] = [];
  function collect(node: ts.Node) { nodes.push(node); ts.forEachChild(node, collect); }
  collect(tree);
  const aliases = new Set<string>(), initializers = new Map<string, ts.Expression>();
  const functions = new Map<string, ts.FunctionDeclaration>();
  const resolvers = new Set<string>();
  const isEnvironment = (node: ts.Node): boolean =>
    ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "process" && node.name.text === "env" ||
    ts.isIdentifier(node) && aliases.has(node.text);
  for (const node of nodes) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) initializers.set(node.name.text, node.initializer);
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const target = specifier.startsWith("@/") ? `src/${specifier.slice(2)}` : path.posix.join(path.posix.dirname(file), specifier);
      if (target !== "src/lib/settings/resolver") continue;
      const imports = node.importClause?.namedBindings;
      if (imports && ts.isNamedImports(imports)) for (const binding of imports.elements) {
        if (["resolveNumber", "resolveBoolean", "resolveNumericSetting"].includes((binding.propertyName ?? binding.name).text)) resolvers.add(binding.name.text);
      }
    }
  }
  // Follow defaults and local calls such as allowedModels(env, provider, ...).
  let changed = true;
  while (changed) {
    const before = aliases.size;
    for (const node of nodes) {
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name) && node.initializer && isEnvironment(node.initializer)) aliases.add(node.name.text);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const declaration = functions.get(node.expression.text);
        if (declaration) node.arguments.forEach((argument, i) => {
          const parameter = declaration.parameters[i];
          if (isEnvironment(argument) && parameter && ts.isIdentifier(parameter.name)) aliases.add(parameter.name.text);
        });
      }
    }
    changed = aliases.size !== before;
  }
  function literals(node: ts.Node, seen = new Set<string>()): string[] {
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return literals(node.expression, seen);
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return [];
      seen.add(node.text);
      const value = initializers.get(node.text);
      return value ? literals(value, seen) : [];
    }
    if (ts.isElementAccessExpression(node)) return literals(node.expression, seen);
    if (ts.isObjectLiteralExpression(node)) return node.properties.flatMap(property => ts.isPropertyAssignment(property) ? literals(property.initializer, new Set(seen)) : []);
    return [];
  }
  const reads: Consumption[] = [];
  const add = (node: ts.Node, kind: Consumption["kind"], name: string) => reads.push({ file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, kind, name });
  for (const node of nodes) {
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isEnvironment(node.expression)) {
      if (ts.isDeleteExpression(node.parent) || ts.isBinaryExpression(node.parent) && node.parent.left === node &&
        node.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) continue;
      const names = ts.isPropertyAccessExpression(node) ? [node.name.text] : literals(node.argumentExpression);
      if (!names.length) add(node, "unresolved-environment", "");
      for (const name of names) if (!plumbing.has(name) && !name.startsWith("DEZFIL_TEST_") && name !== "DEZFIL_BASE_URL") add(node, "environment", name);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && resolvers.has(node.expression.text)) {
      const names = node.arguments[0] ? literals(node.arguments[0]) : [];
      if (!names.length) add(node, "unresolved-resolver", "");
      for (const name of names) add(node, "resolver", name);
    }
  }
  return reads;
}

function allReads(sources: Sources) { return Object.entries(sources).flatMap(([file, source]) => scanConsumption(file, source)); }

/** Reproducible rows: key, variable, and actual consumer file/line/access kind. */
export function consumptionInventory(definitions: readonly SettingDefinition[], sources: Sources) {
  const reads = allReads(sources);
  return definitions.filter(definition => definition.environment).map(definition => ({
    key: definition.key, environment: definition.environment!,
    consumers: reads.filter(read => read.kind === "environment" ? read.name === definition.environment : read.kind === "resolver" && read.name === definition.key),
  }));
}

export function consumptionProblems(definitions: readonly SettingDefinition[], sources: Sources): string[] {
  const reads = allReads(sources), problems = new Set<string>();
  const keys = new Set(definitions.map(definition => definition.key));
  const variables = new Set(definitions.map(definition => definition.environment).filter(Boolean));
  for (const read of reads) {
    if (read.kind === "environment" && !variables.has(read.name)) problems.add(`Undefined variable: ${read.name}`);
    if (read.kind === "resolver" && !keys.has(read.name)) problems.add(`Unknown resolved key: ${read.name}`);
    if (read.kind === "unresolved-environment") problems.add(`Unresolved environment read: ${read.file}:${read.line}`);
    if (read.kind === "unresolved-resolver") problems.add(`Unresolved resolver read: ${read.file}:${read.line}`);
  }
  for (const definition of definitions.filter(d => d.environment)) {
    if (!reads.some(read => read.kind === "environment" ? read.name === definition.environment : read.kind === "resolver" && read.name === definition.key)) problems.add(`Unconsumed definition: ${definition.key}`);
  }
  return [...problems].sort();
}
