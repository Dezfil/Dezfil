// Inspect the installed ESM artifacts, including shared chunks. A public
// setter that disappears or stops honoring the callback must fail with a
// named guarantee before an upgrade can silently lose pole coverage.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const packageDir = dirname(require.resolve("maplibre-gl/package.json"));
const bundles = ["maplibre-gl.mjs", "maplibre-gl-dev.mjs"] as const;

function nodes(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function name(node: ts.NamedDeclaration) {
  return node.name && ts.isIdentifier(node.name) ? node.name.text : "";
}

function method(node: ts.Node, key: string): node is ts.MethodDeclaration {
  return ts.isMethodDeclaration(node) && name(node) === key;
}

function call(node: ts.Node, key: string): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === key;
}

function guarantee(value: unknown, label: string, entry: string): asserts value {
  if (!value) throw new Error(`MapLibre pole clamp (${entry}): ${label}`);
}

function graph(dir: string, entry: string) {
  const files = new Map<string, ts.SourceFile>();
  const visit = (filename: string) => {
    if (files.has(filename)) return;
    const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    files.set(filename, source);
    for (const node of nodes(source, (node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node))) {
      const specifier = (node as ts.ImportDeclaration | ts.ExportDeclaration).moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith(".")) {
        visit(resolve(dirname(filename), specifier.text));
      }
    }
  };
  visit(join(dir, "dist", entry));
  return files;
}

function inspect(dir: string, entry: string) {
  const files = graph(dir, entry);
  const all = [...files.values()].flatMap(source => nodes(source, () => true));
  const setter = all.find(node => method(node, "setTransformConstrain")) as ts.MethodDeclaration | undefined;
  guarantee(setter, "public map-level setter is missing", entry);
  guarantee(nodes(setter, node => call(node, "applyTransformChange")).length > 0
    && nodes(setter, node => call(node, "setConstrainOverride")).length > 0,
  "public setter no longer forwards the callback to the transform", entry);

  const stores = all.filter(node => method(node, "setConstrainOverride") && nodes(node, child =>
    ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(child.left) && child.left.expression.kind === ts.SyntaxKind.ThisKeyword
      && child.left.name.text === "_constrainOverride"
      && ts.isIdentifier(child.right) && child.right.text === node.parameters[0]?.name.getText(),
  ).length > 0) as ts.MethodDeclaration[];
  guarantee(stores.length === 1, "transform callback storage is missing or ambiguous", entry);
  const transform = stores[0].parent;
  const paths = nodes(transform, node => ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(node.left) && node.left.name.text === "applyConstrain");
  const invocations = paths.flatMap(path => nodes(path, node => call(node, "_constrainOverride"))) as ts.CallExpression[];
  guarantee(invocations.length === 1, "constrain path no longer invokes the stored callback", entry);
  return { setter, invocation: invocations[0] };
}

function assertTypings(dir: string) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const filename = resolve(dir, pkg.exports["."].types);
  const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
  guarantee(nodes(source, node => method(node, "setTransformConstrain")).length === 1,
    "public map-level setter is absent from installed typings", "typings");
}

function scratchArtifacts(run: (dir: string) => void) {
  const scratch = mkdtempSync(join(tmpdir(), "dezfil-clamp-canary-"));
  try {
    cpSync(join(packageDir, "package.json"), join(scratch, "package.json"));
    cpSync(join(packageDir, "dist"), join(scratch, "dist"), { recursive: true });
    run(scratch);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

function replace(node: ts.Node, replacement: string) {
  const source = node.getSourceFile();
  writeFileSync(source.fileName, source.text.slice(0, node.getStart()) + replacement + source.text.slice(node.end));
}

describe("MapLibre public pole-clamp canary", () => {
  it("declares the setter in the installed public typings", () => assertTypings(packageDir));

  for (const entry of bundles) {
    it(`${entry} forwards, stores and honors the public constraint`, () => inspect(packageDir, entry));

    it(`${entry} fails by name when its public setter is removed`, () => {
      scratchArtifacts(dir => {
        const { setter } = inspect(dir, entry);
        replace(setter, "");
        assertTypings(dir);
        expect(() => inspect(dir, entry)).toThrow("public map-level setter is missing");
        inspect(dir, bundles.find(other => other !== entry)!);
      });
    });

    it(`${entry} fails by name when its callback is stored but ignored`, () => {
      scratchArtifacts(dir => {
        const { invocation } = inspect(dir, entry);
        const argumentsText = invocation.arguments.map(argument => argument.getText()).join(",");
        replace(invocation, `this._callbacks.defaultConstrain(${argumentsText})`);
        assertTypings(dir);
        expect(() => inspect(dir, entry)).toThrow("constrain path no longer invokes the stored callback");
        inspect(dir, bundles.find(other => other !== entry)!);
      });
    });
  }
});
