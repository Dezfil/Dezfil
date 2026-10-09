import { describe, it, expect } from "vitest";
import { builtinModules } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

/**
 * The client boundary: a module marked "use client" is bundled for the
 * browser together with everything it imports, and a Node built-in
 * anywhere down that chain (node:dns/promises, node:http, fs ...) stops
 * the page from compiling. Neither tsc nor the unit suite sees a client
 * bundle, so a server module that grows a network or file import can
 * break every page whose client code reaches it, with every other check
 * green. This walks the value imports (static, re-exports and literal
 * dynamic imports; never `import type` or `import { type X }`) from
 * every client module under src, through the modules src owns, and fails
 * on each Node built-in it reaches, naming the chain. Installed packages
 * are not walked: what they bundle is their own.
 *
 * A type imported without `type` reads as a value import here; mark it
 * `type` rather than add an exception. The exceptions below are the
 * built-ins a client module may reach on purpose, one line each, and are
 * held both ways: one that no longer occurs fails as stale.
 */

const SRC = path.resolve(__dirname);
const ROOT = path.resolve(SRC, "..");

/** "<module relative to the repository> :: <built-in>" → why it is allowed. */
const EXCEPTIONS = new Map<string, string>([]);

const BUILTINS = new Set(builtinModules);
const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const CANDIDATES = ["", ".ts", ".tsx", ".js", ".mjs", ".jsx", "/index.ts", "/index.tsx", "/index.js"];

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || BUILTINS.has(specifier);
}

/** The specifiers a module's code imports at run time: what a bundler
 * follows. Type-only imports and re-exports are erased before bundling. */
export function valueImports(file: string, source: string): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  const out: string[] = [];
  const typeOnlyNamed = (elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>) =>
    elements.length > 0 && elements.every((element) => element.isTypeOnly);
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) &&
          typeOnlyNamed(clause.namedBindings.elements)) continue;
      out.push(statement.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier &&
        ts.isStringLiteralLike(statement.moduleSpecifier)) {
      if (statement.isTypeOnly) continue;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause) &&
          typeOnlyNamed(statement.exportClause.elements)) continue;
      out.push(statement.moduleSpecifier.text);
    }
  }
  if (/\bimport\s*\(|\brequire\s*\(/.test(source)) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const loads = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
        const argument = node.arguments[0];
        if (loads && argument && ts.isStringLiteralLike(argument)) out.push(argument.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  return out;
}

function isClientModule(source: string): boolean {
  return /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/.test(source);
}

function resolveImport(srcDir: string, from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(srcDir, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier);
  else return null;
  for (const suffix of CANDIDATES) {
    const candidate = base + suffix;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (CODE.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

export type Reach = { key: string; chain: string[] };

/**
 * Every Node built-in reached from a client module under `srcDir`, as
 * "<module> :: <built-in>" with the shortest chain from a client module
 * that reaches it. Paths are relative to `rootDir`. `unresolved` lists
 * project imports (relative or `@/`) that name no file, which would
 * otherwise end a chain silently.
 */
export function clientReach(srcDir: string, rootDir: string): { clients: number; reached: Reach[]; unresolved: string[] } {
  const rel = (file: string) => path.relative(rootDir, file);
  const sources = new Map<string, string>();
  const read = (file: string) => {
    let text = sources.get(file);
    if (text === undefined) {
      text = fs.readFileSync(file, "utf8");
      sources.set(file, text);
    }
    return text;
  };
  const clients = sourceFiles(srcDir).filter((file) => isClientModule(read(file)));
  const parent = new Map<string, string | null>(clients.map((file) => [file, null]));
  const queue = [...clients];
  const reached: Reach[] = [];
  const unresolved: string[] = [];
  const chainTo = (file: string): string[] => {
    const chain: string[] = [];
    for (let at: string | null | undefined = file; at; at = parent.get(at)) chain.unshift(rel(at));
    return chain;
  };
  for (let i = 0; i < queue.length; i++) {
    const file = queue[i];
    if (!CODE.test(file)) continue;
    for (const specifier of valueImports(file, read(file))) {
      if (isNodeBuiltin(specifier)) {
        reached.push({ key: `${rel(file)} :: ${specifier}`, chain: [...chainTo(file), specifier] });
        continue;
      }
      if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
      const target = resolveImport(srcDir, file, specifier);
      if (!target) {
        if (!/\.(?:css|svg|png|jpe?g|gif|webp|woff2?|json|md|txt)$/.test(specifier)) {
          unresolved.push(`${rel(file)} imports ${specifier}`);
        }
        continue;
      }
      if (parent.has(target)) continue;
      parent.set(target, file);
      queue.push(target);
    }
  }
  return { clients: clients.length, reached, unresolved };
}

describe("the client boundary", () => {
  it("is red for the defect it exists to catch: a client module reaching a network built-in through a plain module", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-boundary-"));
    try {
      const src = path.join(dir, "src");
      fs.mkdirSync(path.join(src, "lib"), { recursive: true });
      fs.writeFileSync(path.join(src, "Pane.tsx"), '"use client";\nimport { BASE } from "@/lib/constants";\nimport type { Kept } from "./lib/typed";\nexport const x: Kept = BASE;\n');
      fs.writeFileSync(path.join(src, "lib/constants.ts"), 'import { open } from "./fetcher";\nexport const BASE = "s3://bucket";\nexport const go = open;\n');
      fs.writeFileSync(path.join(src, "lib/fetcher.ts"), 'import { lookup } from "node:dns/promises";\nexport const open = lookup;\n');
      fs.writeFileSync(path.join(src, "lib/typed.ts"), 'import fs from "node:fs";\nexport type Kept = string;\nexport const read = fs.readFileSync;\n');
      const { clients, reached, unresolved } = clientReach(src, dir);
      expect(clients).toBe(1);
      expect(unresolved).toEqual([]);
      expect(reached).toEqual([
        {
          key: "src/lib/fetcher.ts :: node:dns/promises",
          chain: ["src/Pane.tsx", "src/lib/constants.ts", "src/lib/fetcher.ts", "node:dns/promises"],
        },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads value imports the way a bundler does", () => {
    const imports = valueImports("seed.tsx", [
      'import type { A } from "type-only";',
      'import { type B, type C } from "inline-type-only";',
      'import { type D, e } from "mixed";',
      'import "side-effect";',
      'export { f } from "re-export";',
      'export type { G } from "type-re-export";',
      'export * from "star";',
      'const Lazy = dynamic(() => import("lazy"));',
      'type H = import("type-position").H;',
    ].join("\n"));
    expect(imports.sort()).toEqual(["lazy", "mixed", "re-export", "side-effect", "star"]);
    expect(isNodeBuiltin("fs")).toBe(true);
    expect(isNodeBuiltin("node:net")).toBe(true);
    expect(isNodeBuiltin("dns/promises")).toBe(true);
    expect(isNodeBuiltin("maplibre-gl")).toBe(false);
  });

  const { clients, reached, unresolved } = clientReach(SRC, ROOT);

  it("finds the client modules and resolves every project import it follows", () => {
    expect(clients).toBeGreaterThan(100);
    expect(unresolved).toEqual([]);
  });

  it("no client module reaches a Node built-in outside the exceptions", () => {
    const offenders = reached.filter(({ key }) => !EXCEPTIONS.has(key));
    expect(offenders.map(({ key, chain }) => `${key}\n    ${chain.join("\n    → ")}`)).toEqual([]);
  });

  it("every exception still occurs", () => {
    const seen = new Set(reached.map(({ key }) => key));
    expect([...EXCEPTIONS.keys()].filter((key) => !seen.has(key))).toEqual([]);
  });
});
