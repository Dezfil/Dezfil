import { registerHooks } from "node:module";

/** Preload for the release install command: its engine reset at cleanup takes
 * longer than the settlement allowance, which is shortened here from 35 s to
 * 300 ms so the case runs quickly. Only the command's import of the query
 * stores is redirected; every other module reaches the real one. */
const command = new URL("../../scripts/install-template.mjs", import.meta.url).href;
const wrapper = new URL("./install-cleanup-slow.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === command && specifier.endsWith("/query/retained.ts")) return { url: wrapper, shortCircuit: true };
    return next(specifier, context);
  },
});
const schedule = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => schedule(callback, delay === 35_000 ? 300 : delay, ...args);
