import ts from "typescript";
import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import type { Database } from "better-sqlite3";

export interface SourceStore {
  id: string;
  kind: "memory" | "location" | "writer";
  classification: "server" | "browser" | "local" | "immutable";
  evidence: string;
  roots?: string[];
}
export interface Discovery {
  tables: string[];
  accountReferences: string[];
  identityColumns: string[];
  sources: SourceStore[];
}

/** Scan product source, never the data directory, generated output or fixtures. */
export function productSources(root = process.cwd()): Map<string, string> {
  const result = new Map<string, string>();
  function walk(dir: string) {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!["testing", "test-support", "fixtures"].includes(entry.name)) walk(relative);
      } else if (/\.(?:tsx?|mjs)$/.test(relative) && !/\.(?:test|d)\.[^.]+$/.test(relative) && !/(?:-fixture|contract-oracle)\./.test(relative)) {
        result.set(relative, readFileSync(path.join(root, relative), "utf8"));
      }
    }
  }
  walk("src"); return result;
}

const collections = new Set(["Map", "Set", "WeakMap", "WeakSet", "Array", "WeakRef", "FinalizationRegistry"]);
const fileWrites = new Set(["writeFile", "writeFileSync", "appendFile", "appendFileSync", "createWriteStream", "mkdir", "mkdirSync", "rename", "renameSync", "copyFile", "copyFileSync", "cp", "cpSync", "open", "openSync"]);
function find(node: ts.Node, predicate: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = []; function visit(n: ts.Node) { if (predicate(n)) out.push(n); ts.forEachChild(n, visit); } visit(node); return out;
}
function unwrap(node: ts.Node): ts.Node {
  return ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAwaitExpression(node)
    ? unwrap(node.expression) : node;
}
function name(node: ts.Node): string {
  return "name" in node && node.name && typeof node.name === "object" && "getText" in node.name
    ? (node.name as ts.Node).getText() : "";
}
function anchor(node: ts.Node): string {
  const parts: string[] = [];
  for (let n: ts.Node | undefined = node; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isVariableDeclaration(n) || ts.isPropertyDeclaration(n) || ts.isPropertyAssignment(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isClassDeclaration(n)) {
      if (name(n)) parts.unshift(name(n));
    }
  }
  return parts.join(".") || "module";
}
function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let n = node.parent; n && !ts.isSourceFile(n); n = n.parent) if (ts.isFunctionLike(n) && !ts.isFunctionTypeNode(n)) return n as ts.FunctionLikeDeclaration;
}
function returnedClosure(fn: ts.FunctionLikeDeclaration): boolean {
  if (!fn.body) return false;
  function escapes(node: ts.Node): boolean {
    const n = unwrap(node);
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)) return true;
    if (ts.isCallExpression(n) && n.expression.getText() === "Object.assign") return n.arguments.some(escapes);
    if (ts.isIdentifier(n)) return !!fn.body && find(fn.body, d =>
      ts.isFunctionDeclaration(d) && name(d) === n.text || ts.isVariableDeclaration(d) && name(d) === n.text && !!d.initializer && (ts.isArrowFunction(unwrap(d.initializer)) || ts.isFunctionExpression(unwrap(d.initializer)))).length > 0;
    if (ts.isObjectLiteralExpression(n)) return n.properties.some(p => ts.isMethodDeclaration(p) || ts.isShorthandPropertyAssignment(p) && !!fn.body && find(fn.body, d =>
      ts.isFunctionDeclaration(d) && name(d) === p.name.text || ts.isVariableDeclaration(d) && name(d) === p.name.text && !!d.initializer && (ts.isArrowFunction(unwrap(d.initializer)) || ts.isFunctionExpression(unwrap(d.initializer)))).length > 0 || ts.isPropertyAssignment(p) && escapes(p.initializer));
    return false;
  }
  const returns: ts.Node[] = [];
  function visit(n: ts.Node) {
    if (ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) returns.push(n.expression);
    else ts.forEachChild(n, visit);
  }
  if (ts.isBlock(fn.body)) visit(fn.body); else returns.push(fn.body);
  return returns.some(escapes);
}

/** Syntax plus symbol binding, not path literals. Return-value propagation follows
 * imported aliases, local variables and path wrappers across modules. Every root
 * call remains visible even when an opaque external writer cannot be followed. */
export function discoverSourceStores(sources: Map<string, string>, root = process.cwd()): SourceStore[] {
  const absolute = new Map([...sources].map(([file, text]) => [path.join(root, file), text]));
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true, noLib: true, types: [], baseUrl: root, paths: { "@/*": ["src/*"] } };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host), exists = host.fileExists.bind(host);
  host.readFile = file => absolute.get(file) ?? read(file);
  host.fileExists = file => absolute.has(file) || exists(file);
  const program = ts.createProgram([...absolute.keys()], options, host), checker = program.getTypeChecker();
  const files = program.getSourceFiles().filter(f => absolute.has(f.fileName));
  const symbol = (node: ts.Node): ts.Symbol | undefined => {
    let value = checker.getSymbolAtLocation(node);
    if (value && value.flags & ts.SymbolFlags.Alias) value = checker.getAliasedSymbol(value);
    return value;
  };
  const declaration = (node: ts.Node) => symbol(node)?.valueDeclaration;
  const functionOf = (node: ts.Node, seen = new Set<ts.Node>()): ts.FunctionLikeDeclaration | undefined => {
    if (seen.has(node)) return; seen = new Set(seen).add(node);
    const direct = unwrap(node);
    if (ts.isArrowFunction(direct) || ts.isFunctionExpression(direct)) return direct;
    const d = declaration(node);
    if (d && (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d))) return d;
    if (d && ts.isVariableDeclaration(d) && d.initializer) {
      const init = unwrap(d.initializer); if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
      if (ts.isIdentifier(init)) return functionOf(init, seen);
    }
    if (d && ts.isBindingElement(d) && d.parent.parent && ts.isVariableDeclaration(d.parent.parent)) {
      const init = d.parent.parent.initializer && unwrap(d.parent.parent.initializer);
      if (init && ts.isCallExpression(init) && init.expression.kind === ts.SyntaxKind.ImportKeyword &&
        init.arguments[0]?.getText().includes("/config") && (d.propertyName?.getText() ?? d.name.getText()) === "dataDir") {
        return files.find(f => f.fileName === path.join(root, "src/lib/config.ts"))?.statements.find(ts.isFunctionDeclaration);
      }
    }
  };
  function pathPart(node: ts.Node, seen = new Set<ts.Node>()): string {
    if (seen.has(node)) return "*"; seen = new Set(seen).add(node);
    const n = unwrap(node);
    if (ts.isStringLiteralLike(n)) return n.text;
    if (ts.isIdentifier(n)) {
      const d = declaration(n); if (d && ts.isVariableDeclaration(d) && d.initializer) return pathPart(d.initializer, seen);
    }
    if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map(s => `*${s.literal.text}`).join("");
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "join")
      return n.arguments.map(a => pathPart(a, seen)).join("/");
    return "*";
  }
  const retainedMemo = new Map<ts.FunctionLikeDeclaration, boolean>();
  function retainedFunction(fn: ts.FunctionLikeDeclaration): boolean {
    if (retainedMemo.has(fn)) return retainedMemo.get(fn)!;
    const published = !!fn.body && find(fn.body, n => ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment).some(n => {
      const left = (n as ts.BinaryExpression).left;
      if (/^(?:process|globalThis)\b|\.prototype\./.test(left.getText())) return true;
      let base: ts.Node = left;
      while (ts.isPropertyAccessExpression(base) || ts.isElementAccessExpression(base)) base = base.expression;
      const d = declaration(base);
      return !!d && ts.isVariableDeclaration(d) && !enclosingFunction(d);
    });
    const result = returnedClosure(fn) || published; retainedMemo.set(fn, result); return result;
  }
  const writerMemo = new Map<ts.FunctionLikeDeclaration, boolean>();
  function isWriter(call: ts.CallExpression, seen = new Set<ts.Node>()): boolean {
    const d = declaration(ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression);
    const raw = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : call.expression.getText();
    if (fileWrites.has(d ? name(d) : raw)) return true;
    const fn = functionOf(call.expression);
    if (!fn?.body || seen.has(fn)) return false;
    if (writerMemo.has(fn)) return writerMemo.get(fn)!;
    seen = new Set(seen).add(fn);
    const yes = find(fn.body, ts.isCallExpression).some(c => isWriter(c as ts.CallExpression, seen));
    writerMemo.set(fn, yes); return yes;
  }
  const memo = new Map<ts.Node, string[]>();
  function roots(node: ts.Node | undefined, seen = new Set<ts.Node>()): string[] {
    if (!node || seen.has(node)) return [];
    if (memo.has(node)) return memo.get(node)!;
    seen = new Set(seen).add(node); const n = unwrap(node);
    let result: string[] = [];
    if (ts.isIdentifier(n)) {
      const d = declaration(n);
      if (d && ts.isVariableDeclaration(d)) result = roots(d.initializer, seen);
      else if (d && ts.isBindingElement(d)) result = roots(d.initializer, seen);
    } else if (ts.isCallExpression(n)) {
      const fn = functionOf(n.expression);
      if (fn && path.relative(root, fn.getSourceFile().fileName) === "src/lib/config.ts" && name(fn) === "dataDir") result = ["."];
      else if (ts.isPropertyAccessExpression(n.expression) && ["join", "resolve"].includes(n.expression.name.text)) {
        const base = roots(n.arguments[0], seen);
        if (base.length) {
          const parts = n.arguments.slice(1).map(a => pathPart(a));
          result = base.map(b => [b === "." ? "" : b, ...parts].filter(Boolean).join("/") || ".");
        }
      } else if (fn?.body) {
        const returns = ts.isBlock(fn.body) ? find(fn.body, ts.isReturnStatement).flatMap(r => (r as ts.ReturnStatement).expression ?? []) : [fn.body];
        result = returns.flatMap(r => roots(r, seen));
      }
    } else if (ts.isTemplateExpression(n)) result = n.templateSpans.flatMap(s => roots(s.expression, seen));
    else if (ts.isBinaryExpression(n)) result = [...roots(n.left, seen), ...roots(n.right, seen)];
    else if (ts.isConditionalExpression(n)) result = [...roots(n.whenTrue, seen), ...roots(n.whenFalse, seen)];
    result = [...new Set(result)]; if (!seen.has(n.parent)) memo.set(node, result); return result;
  }
  const stores = new Map<string, SourceStore>();
  for (const file of files) {
    const relative = path.relative(root, file.fileName), browser = relative.startsWith("src/components/") || /^\s*["']use client["']/.test(file.text);
    const add = (node: ts.Node, kind: SourceStore["kind"], classification: SourceStore["classification"], suffix = "", foundRoots?: string[]) => {
      const id = `${kind}:${relative}#${anchor(node)}${suffix}`;
      const previous = stores.get(id);
      stores.set(id, { id, kind, classification: browser ? "browser" : classification,
        evidence: node.getText().replace(/\s+/g, " ").slice(0, 180), ...(foundRoots ? { roots: [...new Set([...(previous?.roots ?? []), ...foundRoots])].sort() } : {}) });
    };
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
        const fn = enclosingFunction(node), init = node.initializer && unwrap(node.initializer);
        const mutable = ts.isPropertyDeclaration(node) || !(node.parent.flags & ts.NodeFlags.Const);
        const allocation = init && (ts.isNewExpression(init) || ts.isArrayLiteralExpression(init) || ts.isObjectLiteralExpression(init) ||
          ts.isBinaryExpression(init) && init.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken);
        const factory = init && ts.isCallExpression(init) && functionOf(init.expression);
        const factoryState = factory && (retainedFunction(factory) || !!factory.body && find(factory.body, n => ts.isNewExpression(n) || ts.isObjectLiteralExpression(n)).length > 0);
        if (mutable || allocation || factoryState) {
          const closure = fn && retainedFunction(fn);
          const classification = fn && !closure ? "local" : "server";
          // Nonempty literal constants containing no allocations, callbacks or
          // mutations are immutable configuration, explicitly retained below.
          const literal = init && (ts.isArrayLiteralExpression(init) || ts.isObjectLiteralExpression(init));
          const hasState = init && find(init, n => ts.isNewExpression(n) || ts.isFunctionLike(n) || ts.isCallExpression(n) || ts.isSpreadAssignment(n) || ts.isSpreadElement(n) || ts.isShorthandPropertyAssignment(n) ||
            ts.isPropertyAssignment(n) && ts.isIdentifier(n.initializer) ||
            ts.isArrayLiteralExpression(n) && n.elements.length === 0 || ts.isObjectLiteralExpression(n) && n.properties.length === 0).length > 0;
          const binding = name(node);
          const modified = /^[a-zA-Z_$][\w$]*$/.test(binding) && new RegExp(`\\b${binding}\\s*(?:\\.\\s*(?:push|pop|splice|shift|unshift|set|add|delete|clear)\\s*\\(|\\[[^\\]]+\\]\\s*=|\\.\\w+\\s*=)`).test(file.text);
          add(node, "memory", !mutable && literal && !hasState && !modified ? "immutable" : classification);
        }
      }
      if (ts.isNewExpression(node) && collections.has(node.expression.getText())) {
        const fn = enclosingFunction(node);
        const binding = ts.isVariableDeclaration(node.parent) ? node.parent.name.getText() : "";
        const modified = binding && new RegExp(`\\b${binding}\\s*\\.\\s*(?:add|delete|clear|set)\\s*\\(`).test(file.text);
        const literalSet = !modified && node.expression.getText() === "Set" && node.arguments?.[0] && ts.isArrayLiteralExpression(node.arguments[0]) &&
          node.arguments[0].elements.every(e => ts.isStringLiteralLike(e) || ts.isNumericLiteral(e));
        add(node, "memory", literalSet ? "immutable" : fn && !retainedFunction(fn) ? "local" : "server");
      }
      if (ts.isCallExpression(node)) {
        const found = roots(node);
        if (found.length) add(node, "location", "server", `:${node.expression.getText()}`, found);
        if (isWriter(node)) {
          const paths = node.arguments.flatMap(arg => roots(arg));
          if (paths.length) add(node, "writer", "server", `:${node.expression.getText()}`, paths);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  return [...stores.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function discoverStores(db: Database, sources = productSources()): Discovery {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(r => r.name);
  return { tables,
    accountReferences: tables.flatMap(table => (db.pragma(`foreign_key_list("${table}")`) as { table: string; from: string; to: string }[])
      .filter(f => f.table === "accounts" && f.to === "id").map(f => `${table}.${f.from}`)).sort(),
    identityColumns: (db.pragma("table_info(accounts)") as { name: string }[]).map(c => c.name).sort(),
    sources: discoverSourceStores(sources),
  };
}

/** The directory's actual files, not names copied from the source inventory. */
export function discoverFiles(directory: string): string[] {
  const files: string[] = [];
  function walk(relative: string) {
    for (const e of readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const file = path.posix.join(relative, e.name);
      if (e.isDirectory()) walk(file); else files.push(file);
    }
  }
  walk(""); return files.sort();
}
