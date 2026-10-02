import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const verbs = /^(GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)$/;
const services = new Set(['createMap', 'updateMap', 'deleteMap', 'createLayer', 'updateLayer', 'deleteLayer', 'duplicateLayer', 'publishMap', 'unpublishMap', 'undoMap', 'redoMap', 'createRecipe', 'updateRecipe', 'deleteRecipe', 'addRecipeStep', 'updateRecipeStep', 'deleteRecipeStep', 'setWorkflowLayout', 'changeMembers', 'transferMap', 'transferRecipe', 'commitDocumentChanges']);
const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;

/** Syntax inventory, including dynamic helper routes. It reports candidates;
 * a human must distinguish setup, negative probes, reads and covered writes. */
export function auditSource(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const calls = [];
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(tree);
      const leaf = callee.split('.').at(-1);
      const args = [...node.arguments];
      const explicit = args.map(literal).find(value => value && verbs.test(value));
      const options = args.find(ts.isObjectLiteralExpression);
      const methodProperty = options?.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(tree).replaceAll(/["']/g, '') === 'method');
      const methodValue = methodProperty && literal(methodProperty.initializer);
      const optionMethod = methodValue && verbs.test(methodValue) ? methodValue : null;
      const contextMethod = /^(get|post|patch|put|delete|fetch)$/.test(leaf) && callee.includes('.') ? leaf.toUpperCase() : null;
      const method = services.has(leaf) ? 'service' : explicit ?? optionMethod ?? contextMethod ?? (leaf === 'fetch' ? 'GET' : null);
      if (method && (services.has(leaf) || /^(fetch|api|call|request|send|input|json|edit|gate|GET|POST|PATCH|PUT|DELETE|get|post|patch|put|delete)$/.test(leaf))) {
        const routeArg = args.find(arg => /\/api\//.test(arg.getText(tree)) && !ts.isObjectLiteralExpression(arg) && !ts.isArrowFunction(arg));
        const route = routeArg?.getText(tree) ?? (method === 'service' ? leaf : '<dynamic>');
        calls.push({ file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, callee, method, route });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return calls;
}

export async function auditCheckout(root) {
  const files = [];
  const walk = async dir => {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const name = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(name);
      else if (/\.(?:[cm]?js|tsx?)$/.test(name)) files.push(name);
    }
  };
  for (const dir of ['e2e', 'src/components', 'src/lib', 'scripts']) await walk(dir);
  const calls = [];
  for (const file of files.sort()) calls.push(...auditSource(file, await readFile(path.join(root, file), 'utf8')));
  return { scanned: { total: files.length, browser: files.filter(f => f.startsWith('e2e/')).length }, calls };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await auditCheckout(process.cwd()), null, 2));
}
