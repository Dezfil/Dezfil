#!/usr/bin/env node
// The documentation's pictures and recordings, taken from a real instance.
//
// Run by hand from a built checkout with no .env files, such as a detached
// worktree (`npm run build` there first), never in the pipeline:
//
//   npm run docs:pictures                      # every scene
//   npm run docs:pictures -- --only setup-card # some scenes, comma-separated
//   npm run docs:pictures -- --port 3290       # a port of your choosing
//   npm run docs:pictures -- --keep-requests <file>
//                                              # keep the observer's file
//
// It provisions a production server of the checkout's build on loopback, on
// a port of its own, over a scratch directory it creates under the system's
// temporary folder and removes at the end, whatever happens. The server's
// data directory and template catalogue are in that folder; no other data
// directory is opened. The scenes that need no account are taken first, then
// the instance is seeded through the documented API and the rest are taken.
// Every scene is taken twice from the same instance state, in the app's light
// theme and in its dark theme, chosen the way the app's own switch stores it;
// the dark take is written beside the light one with `.dark` before the
// extension, and shares its frame or crop. The server's outbound requests are
// written down by an observer in its preload chain, and the browser's
// requests off the instance are refused; a run in which either happened
// fails, and so does a file over its bound, a page drawn in the other theme,
// or a dark take that came out the same as its light take. Only then are
// files written under docs/images/, each one only when its bytes changed,
// with the manifest beside them. Commit what changed.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cropRectangle, frameContext, openBrowser, pageTheme, settle, takeRecording, takeStill } from "./docs-pictures-capture.mjs";
import { assertBuiltCheckout, freePort, makeScratch, seed, serverRequests, startServer, writeCatalogue } from "./docs-pictures-instance.mjs";
import { MANIFEST, manifestText, planRun } from "./docs-pictures-manifest.mjs";
import { SCENES, STATES } from "./docs-pictures-scenes.mjs";
import { PICTURE_AIM_BYTES, PICTURE_MAX_BYTES, RECORDING_MAX_BYTES, RECORDINGS_MAX, THEMES, lightTake } from "./docs-media.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const { values } = parseArgs({ options: { only: { type: "string" }, port: { type: "string" }, "keep-requests": { type: "string" } } });
const only = values.only ? new Set(values.only.split(",").map((id) => id.trim()).filter(Boolean)) : null;
if (only) for (const id of only) assert.ok(SCENES.some((scene) => scene.id === id), `There is no scene ${id}.`);
const chosen = SCENES.filter((scene) => !only || only.has(scene.id));
assert.ok(SCENES.filter((scene) => scene.kind === "recording").length <= RECORDINGS_MAX, `The scene list holds more than ${RECORDINGS_MAX} recordings.`);
const port = values.port ? Number(values.port) : await freePort();
assert.ok(Number.isInteger(port) && port > 1024 && port !== 3000, "Choose a port above 1024 other than 3000.");

assertBuiltCheckout(root);
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const date = new Date().toISOString().slice(0, 10);

const scratch = await makeScratch();
let server = null;
let browser = null;
const captured = [];
try {
  await writeCatalogue(root, scratch.catalogue);
  server = await startServer({ root, port, scratch });
  browser = await openBrowser();
  let cookie = null;
  // A scene's crop, found on its light take and shared by its dark take.
  const crops = new Map();
  for (const state of STATES) {
    const scenes = chosen.filter((scene) => scene.state === state);
    if (!scenes.length) continue;
    if (state === "seeded") ({ cookie } = await seed(server.base, root));
    for (const theme of THEMES) {
      const { context, foreign } = await frameContext(browser, server.base, { cookie, theme });
      try {
        for (const scene of scenes) {
          const page = await context.newPage();
          try {
            await scene.open(page);
            await settle(page);
            const drawn = await pageTheme(page);
            assert.equal(drawn, theme, `${scene.id}: the page is drawn in the ${drawn} theme, not the ${theme} theme the browser chose.`);
            if (!crops.has(scene.id)) crops.set(scene.id, scene.crop ? await cropRectangle(page, scene.crop) : null);
            const take = { theme, crop: crops.get(scene.id) };
            const files = scene.kind === "recording"
              ? await takeRecording(page, scene, path.join(scratch.folder, `${scene.id}.${theme}.webm`), take)
              : await takeStill(page, scene, take);
            for (const file of files) console.log(`${scene.id}: ${file.file}, ${file.width} × ${file.height}${file.length ? `, ${file.length} s` : ""}, ${file.bytes.length} bytes`);
            captured.push(...files);
          } finally {
            await page.close();
          }
        }
      } finally {
        await context.close();
      }
      assert.deepEqual(foreign, [], `The ${state} scenes' pages asked for addresses off the instance in the ${theme} theme.`);
    }
  }
  if (values["keep-requests"]) await copyFile(scratch.requests, path.resolve(values["keep-requests"]));
  const requests = await serverRequests(scratch);
  assert.deepEqual(requests, [], "The server opened requests during the run; every picture must come from the run alone.");
  console.log("The server opened no request: the observer's file is empty.");
} catch (error) {
  if (server) console.error(server.output().split("\n").slice(-40).join("\n"));
  throw error;
} finally {
  await browser?.close();
  await server?.stop();
  await rm(scratch.folder, { recursive: true, force: true });
}

// A dark take the same as its light take was not drawn in the dark theme.
const takes = new Map(captured.map((item) => [item.file, item]));
for (const item of captured.filter((taken) => taken.theme === "dark")) {
  const light = takes.get(lightTake(item.file));
  assert.ok(light, `${item.scene}: ${item.file} has no light take in the run.`);
  assert.ok(Buffer.compare(Buffer.from(light.bytes), Buffer.from(item.bytes)) !== 0, `${item.scene}: ${item.file} came out the same as ${light.file}; the dark theme did not reach the picture.`);
}

// Bounds, before anything is written: a run over a bound writes nothing.
for (const item of captured) {
  if (item.kind === "picture") {
    assert.ok(item.bytes.length <= PICTURE_MAX_BYTES, `${item.scene}: ${item.file} is ${item.bytes.length} bytes, over ${PICTURE_MAX_BYTES}; declare a crop for the scene.`);
    if (item.bytes.length > PICTURE_AIM_BYTES) console.warn(`${item.scene}: ${item.file} is ${item.bytes.length} bytes, over the ${PICTURE_AIM_BYTES} aim.`);
  } else {
    assert.ok(item.bytes.length <= RECORDING_MAX_BYTES, `${item.scene}: ${item.file} is ${item.bytes.length} bytes, over ${RECORDING_MAX_BYTES}; hold fewer frames or declare a crop for the scene.`);
  }
}

const images = path.join(root, "docs/images");
const manifestFile = path.join(root, MANIFEST);
const manifest = existsSync(manifestFile) ? JSON.parse(await readFile(manifestFile, "utf8")) : null;
const current = (file) => (existsSync(path.join(images, file)) ? readFileSync(path.join(images, file)) : null);
const plan = planRun({ manifest, captured, current, scenes: SCENES, partial: only !== null, version, date });
for (const { file, bytes } of plan.writes) {
  await mkdir(path.dirname(path.join(images, file)), { recursive: true });
  await writeFile(path.join(images, file), bytes);
}
for (const file of plan.removes) await rm(path.join(images, file), { force: true });
const text = manifestText(plan.manifest);
if (!existsSync(manifestFile) || readFileSync(manifestFile, "utf8") !== text) await writeFile(manifestFile, text);
console.log(`${captured.length} file(s) taken: ${plan.writes.length} changed, ${captured.length - plan.writes.length} unchanged, ${plan.removes.length} removed.`);
if (plan.writes.length || plan.removes.length) console.log("Run npm run docs:write if the manifest is new, then npm run lint:docs.");
