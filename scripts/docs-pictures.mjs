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
// the instance is seeded through the documented API and the seeded scenes
// are taken, then the first account's first map is made and the scenes that
// show it are taken, then each later state is made from the one before it
// and its scenes taken (the states of docs-pictures-scenes.mjs, in order).
// Every scene is taken twice from the same instance state, in the app's light
// theme and in its dark theme, chosen the way the app's own switch stores it;
// the dark take is written beside the light one with `.dark` before the
// extension, and shares its frame or crop. The server's outbound requests are
// written down by an observer in its preload chain (its requests to its own
// listener stay inside the run), and the browser's requests off the instance
// are refused; a run in which either went off the instance fails, naming
// each address. The one exception is a scene that shows a map
// (`map: true` in the scene list): it reaches the built-in basemap and is
// taken only once its map is at rest on it, every tile loaded; a basemap
// request that fails fails the run, and so does the basemap's host asked for
// from any other scene (docs-pictures-network.mjs); the run names the
// basemap's styles and tile sets it drew. The assistant scenes talk to a
// scripted model the script serves on loopback beside the server
// (docs-pictures-assistant.mjs); the server's requests to it stay inside the
// run, and a request it has no answer for fails the run. A run also fails on a
// file over its bound, a page drawn in the other theme, or a dark take that
// came out the same as its light take. Only then are files written under
// docs/images/, each one only when its bytes changed, with the manifest
// beside them. Commit what changed.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { answerCameraSaves, cropRectangle, frameContext, openBrowser, pageTheme, rest, takeRecording, takeStill } from "./docs-pictures-capture.mjs";
import { assistantEnvironment, startScriptedModel } from "./docs-pictures-assistant.mjs";
import { assertBuiltCheckout, freePort, makeScratch, seed, serverRequests, startServer, writeCatalogue } from "./docs-pictures-instance.mjs";
import { MANIFEST, manifestText, planRun } from "./docs-pictures-manifest.mjs";
import { problemsMessage, requestsOffInstance } from "./docs-pictures-network.mjs";
import { SCENES, STATES, STATE_SEEDING } from "./docs-pictures-scenes.mjs";
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
let model = null;
const captured = [];
try {
  await writeCatalogue(root, scratch.catalogue);
  model = await startScriptedModel();
  server = await startServer({ root, port, scratch, environment: assistantEnvironment(model.url) });
  browser = await openBrowser();
  // Each state after the fresh one builds on the one before it: the
  // seeding, then each later state's own seeding, in order. A run that
  // takes no scene of a state still makes it when a later state's scenes
  // need it.
  let seeded = null;
  const made = new Set();
  // A scene's crop, found on its light take and shared by its dark take.
  const crops = new Map();
  // The built-in basemap's styles and tile sets the map scenes drew.
  const drawn = new Set();
  for (const [index, state] of STATES.entries()) {
    const scenes = chosen.filter((scene) => scene.state === state);
    if (!scenes.length) continue;
    if (state !== "fresh") seeded ??= await seed(server.base, root);
    for (const earlier of STATES.slice(0, index + 1)) {
      if (made.has(earlier) || !STATE_SEEDING[earlier]) continue;
      await STATE_SEEDING[earlier](seeded.api, root);
      made.add(earlier);
    }
    const cookie = seeded?.cookie ?? null;
    for (const theme of THEMES) {
      const { context, network } = await frameContext(browser, server.base, { cookie, theme });
      try {
        for (const scene of scenes) {
          network.begin(scene);
          const page = await context.newPage();
          let failure = null;
          try {
            if (scene.map === true) await answerCameraSaves(page, server.base);
            await scene.open(page);
            await rest(page, scene);
            const drawn = await pageTheme(page);
            assert.equal(drawn, theme, `${scene.id}: the page is drawn in the ${drawn} theme, not the ${theme} theme the browser chose.`);
            if (!crops.has(scene.id)) crops.set(scene.id, scene.crop ? await cropRectangle(page, scene.crop) : null);
            const take = { theme, crop: crops.get(scene.id) };
            const files = scene.kind === "recording"
              ? await takeRecording(page, scene, path.join(scratch.folder, `${scene.id}.${theme}.webm`), take)
              : await takeStill(page, scene, take);
            for (const file of files) console.log(`${scene.id}: ${file.file}, ${file.width} × ${file.height}${file.length ? `, ${file.length} s` : ""}, ${file.bytes.length} bytes`);
            captured.push(...files);
          } catch (error) {
            failure = error;
          } finally {
            await page.close();
          }
          // What the page asked for decides first: a scene that failed
          // because a request was refused reports the address.
          const problems = network.end();
          if (problems.length) throw new Error(problemsMessage(scene, problems, { theme }), failure ? { cause: failure } : undefined);
          if (failure) throw failure;
        }
      } finally {
        await context.close();
      }
      for (const source of network.sources()) drawn.add(source);
    }
  }
  if (values["keep-requests"]) await copyFile(scratch.requests, path.resolve(values["keep-requests"]));
  const requests = await serverRequests(scratch);
  const outside = requestsOffInstance(requests, server.base, [model.host]);
  assert.ok(outside.length === 0, `The server opened requests off the instance during the run; every picture must come from the run alone:\n${outside.map((row) => `  ${row.method} ${row.host}${row.path}`).join("\n")}`);
  const toModel = requests.filter((row) => row.host === model.host).length;
  console.log(requests.length
    ? `The server opened no request off the instance: the observer's file holds ${requests.length - toModel} to the instance itself and ${toModel} to the scripted model.`
    : "The server opened no request: the observer's file is empty.");
  assert.deepEqual(model.problems, [], `The scripted model was asked for what it has no answer to:\n${model.problems.map((line) => `  ${line}`).join("\n")}`);
  // Two runs that print the same lines drew the same basemap.
  if (drawn.size) console.log(`The map scenes drew the built-in basemap from:\n${[...drawn].sort().map((source) => `  ${source}`).join("\n")}`);
} catch (error) {
  if (server) console.error(server.output().split("\n").slice(-40).join("\n"));
  if (model?.problems.length) console.error(`The scripted model had no answer to:\n${model.problems.map((line) => `  ${line}`).join("\n")}`);
  throw error;
} finally {
  await browser?.close();
  await server?.stop();
  await model?.stop();
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
