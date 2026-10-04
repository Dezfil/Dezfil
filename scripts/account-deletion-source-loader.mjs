// Proof-only loader for the private coordinator before a confirmation route
// exists. Native packages come from the standalone server's own module tree.
import Module, { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function productLoader(standalone = process.cwd()) {
  const external = createRequire(path.join(standalone, 'server.js')), cache = new Map();
  function load(file) {
    let resolved = file;
    if (!existsSync(resolved) || !path.extname(resolved)) resolved = [file + '.ts', file + '.tsx', file + '.mjs', file + '/index.ts'].find(existsSync);
    if (!resolved) throw new Error(`Missing product source: ${file}`);
    if (cache.has(resolved)) return cache.get(resolved).exports;
    if (!/\.tsx?$/.test(resolved)) return createRequire(import.meta.url)(resolved);
    const loadedModule = new Module(resolved); cache.set(resolved, loadedModule); loadedModule.filename = resolved;
    loadedModule.require = specifier => specifier.startsWith('@/') ? load(path.join(root, 'src', specifier.slice(2)))
      : specifier.startsWith('.') ? load(path.resolve(path.dirname(resolved), specifier)) : external(specifier);
    const output = ts.transpileModule(readFileSync(resolved, 'utf8'), { fileName: resolved, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    loadedModule._compile(output, resolved); loadedModule.loaded = true; return loadedModule.exports;
  }
  return name => load(path.join(root, 'src', name));
}
