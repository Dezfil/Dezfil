import { registerHooks } from "node:module";

/** Preload for the release install command: its shipped-set check waits until
 * just past the command's own deadline before checking. Only the command's
 * import is redirected; the wrapper reaches the real module. */
const command = new URL("../../scripts/install-template.mjs", import.meta.url).href;
const wrapper = new URL("./shipped-check-stalled.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === command && specifier.endsWith("/templates/shipped.ts")) return { url: wrapper, shortCircuit: true };
    return next(specifier, context);
  },
});
