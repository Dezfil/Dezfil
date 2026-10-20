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

/** The catalogue with what Settings shows beside it: the Limits tab's
 * cards, in its order, with the labels and units its rows take, which the
 * System tab's Server settings card names those settings by too. Read
 * without a build, store or server, as the catalogue is. */
export async function settingsDisplaySource(root = process.cwd()) {
  const source = pathToFileURL(path.join(root, "src") + path.sep).href;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      const target = specifier.startsWith("@/") ? new URL(specifier.slice(2), source).href : specifier;
      let result;
      try { result = next(target, context); }
      catch (error) {
        if (!target.startsWith(".") && !target.startsWith("file:")) throw error;
        if (!context.parentURL?.startsWith(source)) throw error;
        result = next(target + ".ts", context);
      }
      return result.url.startsWith(source) && result.url.endsWith(".ts")
        ? { ...result, format: "module-typescript" } : result;
    },
  });
  try {
    const catalogue = await import(new URL("lib/settings/catalogue.ts", source));
    const limits = await import(new URL("components/settings/limits-table.ts", source));
    return { catalogue, limits };
  } finally { hooks.deregister(); }
}
