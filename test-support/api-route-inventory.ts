import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { buildOpenApiDocument } from "../src/lib/api/openapi";

const APP_DIR = path.join(process.cwd(), "src/app");
const HTTP_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"];

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

export function implementedRoutes(): Implemented[] {
  const files = walk(path.join(APP_DIR, "api")).filter((f) =>
    f.endsWith("route.ts"),
  );
  const routes: Implemented[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const p = routePath(file);
    for (const method of HTTP_METHODS) {
      const re = new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`);
      if (re.test(src)) routes.push({ path: p, method: method.toLowerCase() });
    }
  }
  return routes;
}

/** Operations whose route handler invokes one of the bounded body readers. */
export function governedBodyRoutes(): Implemented[] {
  const files = walk(path.join(APP_DIR, "api")).filter((f) =>
    f.endsWith("route.ts"),
  );
  const routes: Implemented[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const exported = HTTP_METHODS.flatMap((method) => {
      const re = new RegExp(
        `export\\s+(?:async\\s+)?function\\s+${method}\\b`,
        "g",
      );
      return [...src.matchAll(re)].map((match) => ({
        method: method.toLowerCase(),
        at: match.index,
      }));
    }).sort((a, b) => a.at - b.at);

    for (const [index, candidate] of exported.entries()) {
      const end = exported[index + 1]?.at ?? src.length;
      const handler = src.slice(candidate.at, end);
      if (/\b(?:jsonBody|optionalJsonBody)\s*\(/.test(handler)) {
        routes.push({ path: routePath(file), method: candidate.method });
      }
    }
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

