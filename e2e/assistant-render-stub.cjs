/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS preload loaded through --require has no other way in */
// The render stub for the browser gate. The map check drives the export
// renderer, which loads puppeteer-core and launches a headless browser; a
// browser launched from inside the dev server never settles the render
// page (Server-side image export), and the note, thumbnail, lifecycle and
// recovery suites are about the pane, not the render. Loaded through
// NODE_OPTIONS=--require into every process of the dev server (through
// assistant-preloads.cjs), this registers a module resolve hook that
// answers `puppeteer-core`, an external the server reaches through a
// native ESM import, with the fake in
// assistant-render-stub-puppeteer.mjs: a page that settles at once and
// screenshots a fixed PNG, so the whole product road (the check's route,
// its budget, retention, the events, the receipt) runs with only the
// browser faked. Test-owned; nothing in the product reads
// DEZFIL_E2E_RENDER_STUB. Set it to `1` to arm the stub.
const { register } = require("node:module");
const { pathToFileURL } = require("node:url");

if (process.env.DEZFIL_E2E_RENDER_STUB === "1") {
  register("./assistant-render-stub-hooks.mjs", pathToFileURL(__filename));
  console.info("[render stub] armed: puppeteer-core resolves to the fixed-image fake");
}
