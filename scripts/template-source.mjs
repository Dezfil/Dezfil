import { createRequire, registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { pathToFileURL } from "node:url";

/** Run the application's TypeScript readers directly from a release checkout. */
export function templateSource() {
  const source = new URL("../src/", import.meta.url).href;
  return registerHooks({
    resolve(specifier, context, next) {
      const target = specifier.startsWith("@/") ? new URL(specifier.slice(2), source).href : specifier;
      try { return next(target, context); }
      catch (error) {
        if (!target.startsWith(".") && !target.startsWith("file:")) {
          if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
          return next(pathToFileURL(createRequire(context.parentURL).resolve(target)).href, context);
        }
        return next(target + ".ts", context);
      }
    },
    load(url, context, next) {
      if (!url.startsWith(source)) return next(url, context);
      if (url.endsWith(".json")) return next(url, { ...context, importAttributes: { type: "json" } });
      if (!url.endsWith(".ts")) return next(url, context);
      const output = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        fileName: new URL(url).pathname,
      });
      return { format: "module", source: output.outputText, shortCircuit: true };
    },
  });
}
