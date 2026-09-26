// The resolve hook of the render stub: `puppeteer-core`, however it is
// imported, resolves to the fake module beside this file. Turbopack's
// server runtime imports an external under a hashed alias
// (`puppeteer-core-<hash>`), so the bare name and that alias both match.
// Runs on Node's loader thread; it holds no state.
const FAKE = new URL("./assistant-render-stub-puppeteer.mjs", import.meta.url).href;
const PUPPETEER = /^puppeteer-core(-[0-9a-f]{6,})?$/;
export async function resolve(specifier, context, nextResolve) {
  if (PUPPETEER.test(specifier)) return { url: FAKE, shortCircuit: true, format: "module" };
  return nextResolve(specifier, context);
}
