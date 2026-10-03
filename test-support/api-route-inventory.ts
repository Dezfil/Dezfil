import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { buildOpenApiDocument } from "../src/lib/api/openapi";

const APP_DIR = path.join(process.cwd(), "src/app");
const HTTP_METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PATCH", "PUT", "DELETE"];

/** Turn a route.ts file path into its API path with {param} placeholders. */
function routePath(file: string): string {
  const rel = path.relative(APP_DIR, path.dirname(file));
  const segments = rel
    .split(path.sep)
    .filter((s) => !(s.startsWith("(") && s.endsWith(")"))) // route groups
    .map((s) => s.replace(/^\[(?:\.\.\.)?(.+)\]$/, "{$1}"));
  return "/" + segments.join("/");
}

export function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

interface Implemented {
  path: string;
  method: string;
}

/** A transport export is proven from its complete body and the imported helper,
 * not a comment, method name, or an allowlist of routes. Any added resource work
 * makes it an operation again and must be covered by the published contract. */
export function routeExports(source: string): { method: string; transport: boolean }[] {
  const file = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true);
  const helpers = new Map<string, string>();
  for (const node of file.statements) if (ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "@/lib/auth/route-gate") {
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
      helpers.set(item.name.text, item.propertyName?.text ?? item.name.text);
    }
  }
  return file.statements.flatMap(node => {
    if (!ts.isFunctionDeclaration(node) || !node.name || !HTTP_METHODS.includes(node.name.text) ||
        !node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) return [];
    const statement = node.body?.statements.length === 1 ? node.body.statements[0] : undefined;
    const expression = statement && ts.isReturnStatement(statement) ? statement.expression : undefined;
    const call = expression && ts.isCallExpression(expression) ? expression : undefined;
    const helper = call && ts.isIdentifier(call.expression) ? helpers.get(call.expression.text) : undefined;
    const parameter = node.parameters.length === 1 && ts.isIdentifier(node.parameters[0].name) ? node.parameters[0].name.text : undefined;
    const forwardsRequest = call && ts.isIdentifier(call.arguments[0]) && call.arguments[0].text === parameter;
    const transport = !!forwardsRequest && ((helper === "gateOnly" && call!.arguments.length === 1) ||
      (helper === "gateHead" && node.name.text === "HEAD" && call!.arguments.length === 2 &&
       ts.isIdentifier(call!.arguments[1]) && call!.arguments[1].text === "GET"));
    return [{ method: node.name.text.toLowerCase(), transport }];
  });
}

export function implementedRoutes(automatic = false): Implemented[] {
  const files = walk(path.join(APP_DIR, "api")).filter(f => f.endsWith("route.ts"));
  const routes = files.flatMap(file => routeExports(readFileSync(file, "utf8"))
    .filter(handler => automatic || !handler.transport)
    .map(handler => ({ path: routePath(file), method: handler.method })));
  if (automatic) for (const p of new Set(routes.map(route => route.path))) {
    if (!routes.some(route => route.path === p && route.method === "options")) routes.push({ path: p, method: "options" });
    if (routes.some(route => route.path === p && route.method === "get") &&
        !routes.some(route => route.path === p && route.method === "head")) routes.push({ path: p, method: "head" });
  }
  return routes;
}

export function documentedRoutes(): Implemented[] {
  const doc = buildOpenApiDocument();
  const out: Implemented[] = [];
  for (const [p, methods] of Object.entries(doc.paths)) {
    for (const method of Object.keys(methods as Record<string, unknown>)) {
      out.push({ path: p, method });
    }
  }
  return out;
}

export const key = (r: Implemented) => `${r.method.toUpperCase()} ${r.path}`;

/** Resource semantics exclude automatic transport methods, which have their own gate inventory. */
export function resourceOperations<T>(operations: Record<string, T>): T[] {
  return Object.entries(operations).filter(([method]) => method !== "head" && method !== "options").map(([, operation]) => operation);
}

