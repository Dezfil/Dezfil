import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const GEO = "@deck.gl/geo-layers";
function restricted(specifier: string): boolean {
  return /(?:^|\/)(?:@deck\.gl\/(?:geo-layers|mesh-layers)|@loaders\.gl\/[^/]+|@luma\.gl\/gltf|deck\.gl|loaders\.gl|image-size|texture-compressor|fflate)(?:\/|$)/.test(specifier);
}

export function inspectSource(file: string, source: string): { imports: string[]; errors: string[] } {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const errors: string[] = [];
  const reject = (specifier: string) => errors.push(`${file}: restricted loader access: ${specifier}`);
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (restricted(specifier)) {
        const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
        const hasDefault = ts.isImportDeclaration(node) && Boolean(node.importClause?.name);
        if (specifier !== GEO || hasDefault || !bindings ||
            !(ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) || !bindings.elements.length) {
          reject(specifier);
        } else {
          for (const symbol of bindings.elements) {
            const original = (symbol.propertyName ?? symbol.name).text;
            imports.push(`${file}: ${specifier}#${original}`);
            if (original !== "MVTLayer") reject(`${specifier}#${original}`);
          }
        }
      }
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const loaderCall = expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(expression) && expression.text === "require") ||
        (ts.isPropertyAccessExpression(expression) &&
          (expression.name.text === "require" || expression.getText(parsed) === "require.resolve"));
      if (loaderCall) {
        const argument = node.arguments[0];
        if (!argument || !ts.isStringLiteralLike(argument)) errors.push(`${file}: opaque module access needs review`);
        else if (restricted(argument.text)) reject(argument.text);
      }
    } else if (ts.isExternalModuleReference(node) && ts.isStringLiteralLike(node.expression)) {
      if (restricted(node.expression.text)) reject(node.expression.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal) && restricted(node.argument.literal.text)) {
      reject(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return { imports, errors };
}

/** Source and tests under src; e2e/scripts and installed packages are outside this inventory. */
export function inventory(root: string): { files: number; imports: string[]; errors: string[] } {
  const result = { files: 0, imports: [] as string[], errors: [] as string[] };
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file)) {
        result.files += 1;
        const found = inspectSource(file, readFileSync(file, "utf8"));
        result.imports.push(...found.imports);
        result.errors.push(...found.errors);
      }
    }
  }
  walk(root);
  return result;
}
