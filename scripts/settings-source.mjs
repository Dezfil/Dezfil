import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

/** Read the application's data-only catalogue without a build, store or server. */
export async function settingsSource(root = process.cwd()) {
  const source = pathToFileURL(path.join(root, "src/lib/settings") + path.sep).href;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      let result;
      try { result = next(specifier, context); }
      catch (error) {
        if (!specifier.startsWith(".") || !context.parentURL?.startsWith(source)) throw error;
        result = next(specifier + ".ts", context);
      }
      return result.url.startsWith(source) && result.url.endsWith(".ts")
        ? { ...result, format: "module-typescript" } : result;
    },
  });
  try { return await import(new URL("catalogue.ts", source)); }
  finally { hooks.deregister(); }
}
