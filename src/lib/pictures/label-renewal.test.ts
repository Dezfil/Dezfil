import { isolatePictureData } from "@/lib/test-support/picture-data";
import { afterAll, beforeEach, expect, it, vi } from "vitest";

/** The renderer stand-in: each appearance answered whole, its master and
 * every kept size in its format, the map's visible layers declared drawn
 * and their inputs read, unless the case troubles that appearance. The
 * attempt's standing is asked after the trouble, as a render asks it
 * while it draws. Every call is recorded. */
const renderer = vi.hoisted(() => ({
  calls: [] as { mapId: string; appearance: "light" | "dark" }[],
  trouble: null as null | { appearance: "light" | "dark"; act: () => Promise<void> | void },
}));
vi.mock("@/lib/export/render-image", async () => {
  const { captureBasemap } = await import("@/lib/thumbnail-evidence");
  const { metadataDb } = await import("@/lib/metadata/db");
  const { pictureWorkScope } = await import("@/lib/auth/scope");
  const { recordPictureInputs } = await import("@/lib/pictures/inputs");
  const { NO_INPUTS } = await import("@/lib/query/evaluation-inputs");
  const png = (width: number, height: number) => {
    const bytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12, "latin1"); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
    return new Uint8Array(bytes);
  };
  const webp = (width: number, height: number) => {
    const bytes = Buffer.alloc(30);
    bytes.write("RIFF", 0, "latin1"); bytes.writeUInt32LE(22, 4); bytes.write("WEBP", 8, "latin1"); bytes.write("VP8X", 12, "latin1");
    bytes.writeUInt32LE(10, 16); bytes.writeUIntLE(width - 1, 24, 3); bytes.writeUIntLE(height - 1, 27, 3);
    return new Uint8Array(bytes);
  };
  return {
    renderMapImage: async (_scope: unknown, input: {
      mapId: string; credential?: string; admitted?: () => void; standing?: () => void;
      definition: { appearance: "light" | "dark"; size: { width: number; height: number } };
      picture: { sizes: { width: number; height: number; type: string }[] };
    }) => {
      input.admitted?.();
      const { appearance } = input.definition;
      renderer.calls.push({ mapId: input.mapId, appearance });
      if (renderer.trouble?.appearance === appearance) await renderer.trouble.act();
      input.standing?.();
      const layers = metadataDb().prepare("SELECT id FROM layers WHERE map_id = ? AND visible = 1").all(input.mapId) as { id: string }[];
      const { scope } = pictureWorkScope(input.credential!);
      for (const layer of layers) recordPictureInputs(scope, layer.id, NO_INPUTS);
      const style = captureBasemap(input.mapId, appearance)!.url;
      return {
        png: png(input.definition.size.width, input.definition.size.height),
        abandoned: [],
        consumed: JSON.stringify({ map: input.mapId, layers, failures: [], unsupported: [], paintedStyle: style, requestedStyle: style }),
        encoded: input.picture.sizes.map((s) => (s.type === "image/png" ? png(s.width, s.height) : webp(s.width, s.height))),
      };
    },
  };
});

import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "@/lib/api/errors";
import { dataDir } from "@/lib/config";
import { resetQueryInstance } from "@/lib/duckdb";
import { webpDimensions } from "@/lib/export/picture-encode";
import { mapWithLayers } from "@/lib/map-access";
import { duplicateMap, createMap } from "@/lib/map-service";
import { copyThumbnail, publishedPictureFormat, readPicture } from "@/lib/map-thumbnails";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { insertLayer } from "@/lib/metadata/maps";
import { NO_INPUTS } from "@/lib/query/evaluation-inputs";
import { defaultStyle } from "@/lib/style/defaults";
import { LABEL_RECIPE_VERSION } from "@/lib/style/label-recipe";
import { copyTemplate } from "@/lib/templates/copy";
import * as shipped from "@/lib/templates/shipped-index";
import { testAccountScope } from "@/lib/test-support/accounts";
import { asEarlierLabels, publishedManifest, sizedPicture } from "@/lib/test-support/picture-sizes";
import { buildTemplate, writeShippedFolder } from "../../../test-support/templates/builder";
import { pictureTarget, publishPicture } from "./publication";
import { PictureService } from "./service";
import { PICTURE_RECIPE, PICTURE_SHAPE } from "./shapes";
import { getPictureState, requestPicture, type PictureState } from "./state";

/**
 * A map's card pictures that show labels are made once more when the way
 * labels are drawn changes: every kept size and, on Auto, both themes,
 * replaced together. A failed, unavailable or overtaken attempt publishes
 * none of a new set, and the ordinary retry rules carry the renewal on. A
 * finished set is not made again by a read, a later look or a restart. A
 * duplicate made before the renewal finishes does not carry the earlier
 * pictures forward as current. A map without visible labels keeps its
 * pictures, and an installed template's files are never rewritten.
 */

isolatePictureData();
const scope = testAccountScope();
afterAll(() => { resetQueryInstance(); closeMetadataDb(); });
beforeEach(() => {
  metadataDb().exec("DELETE FROM maps");
  renderer.calls.length = 0;
  renderer.trouble = null;
});

const SQL = "SELECT 'Harbour' AS name, ST_Point(13.4, 52.5) AS geometry";
/** A label as an earlier release stored it: the old starting paint, and
 * no choices. */
const EARLIER_LABEL = { attribute: "name", size: 12, color: { r: 255, g: 255, b: 255, a: 1 }, haloWidth: 0, haloColor: { r: 12, g: 16, b: 24, a: 0.8 } };
/** The digest the earlier code wrote for a labelled map: its labels read
 * then without their choices or the recipe, so it is not today's. */
const EARLIER_DIGEST = `v2:${"e".repeat(64)}`;
const earlier = Date.now() - 3_600_000;

interface LayerPlan { label?: boolean; visible?: boolean }
interface EarlierMap { id: string; before: PictureState; manifest: Record<string, unknown>; files: string[] }

const files = (mapId: string) =>
  readdirSync(path.join(dataDir(), "thumbnails")).filter((name) => name.startsWith(`${mapId}.`) && !name.endsWith(".json")).sort();

function addLayer(mapId: string, ordinal: number, { label = true, visible = true }: LayerPlan) {
  const at = new Date().toISOString();
  insertLayer({
    id: randomUUID(), mapId, name: `Places ${ordinal}`, sql: SQL,
    style: { ...defaultStyle("POINT", ordinal), ...(label ? { label: EARLIER_LABEL } : {}) },
    visible, tooltip: null, popup: null, publishedFields: null, inLegend: true, viz: { type: "points" }, filters: [],
    legendTitle: null, legendLabels: null, legendAttrs: null, ordinal, createdAt: at, updatedAt: at,
  });
}

/**
 * A map with its card pictures as an earlier server left them: a whole
 * set of every kept size, framed by this recipe, recording no label
 * recipe, and current. Its row stands at the map's digest, or, upgraded,
 * at the digest the earlier code wrote for its labels.
 */
async function earlierMap(name: string, layers: LayerPlan[], options: { basemap?: string; upgraded?: boolean } = {}): Promise<EarlierMap> {
  const map = createMap(scope, name);
  if (options.basemap) metadataDb().prepare("UPDATE maps SET basemap = ? WHERE id = ?").run(options.basemap, map.id);
  layers.forEach((layer, i) => addLayer(map.id, i, layer));
  const target = pictureTarget(scope, map.id);
  const state = requestPicture(map.id, target.digest, earlier);
  await publishPicture(scope, target, state.requestedGeneration,
    { light: sizedPicture("earlier-light"), ...(target.basemaps.dark ? { dark: sizedPicture("earlier-dark") } : {}) }, NO_INPUTS);
  asEarlierLabels(map.id);
  if (options.upgraded) metadataDb().prepare("UPDATE map_pictures SET digest = ?, published_digest = ? WHERE map_id = ?").run(EARLIER_DIGEST, EARLIER_DIGEST, map.id);
  return { id: map.id, before: getPictureState(map.id)!, manifest: publishedManifest(map.id), files: files(map.id) };
}

function harness(start = Date.now()) {
  let now = start;
  const service = new PictureService({ baseUrl: "http://fixture.test", available: () => true, now: () => now });
  return {
    service,
    advance: (ms: number) => { now += ms; },
    /** Every attempt due, run to its end, until none is left due. */
    settle: async () => { for (let i = 0; i < 8; i++) { service.queue.tick(); await service.queue.drain(); } },
  };
}

const THEMES = ["light", "dark"] as const;
const isEarlier = (bytes: Buffer) => bytes.toString("latin1").startsWith("earlier");
const rendered = (mapId: string) => renderer.calls.filter((call) => call.mapId === mapId).map((call) => call.appearance);

/** The map's whole set is the server's new one: drawn once per appearance,
 * listing every kept size, the framing and label recipes it was made by,
 * every size and both themes answering new bytes, and none of the earlier
 * set's files left. */
async function expectRenewed(map: EarlierMap, appearances: readonly ("light" | "dark")[]) {
  expect(rendered(map.id)).toEqual(appearances);
  const manifest = publishedManifest(map.id);
  expect(manifest).toMatchObject({ sizes: { card: [...PICTURE_SHAPE.widths] }, recipe: PICTURE_RECIPE, labels: LABEL_RECIPE_VERSION });
  expect(manifest.dark === manifest.light).toBe(appearances.length === 1);
  expect(files(map.id).filter((name) => map.files.includes(name))).toEqual([]);
  for (const theme of THEMES) {
    expect(isEarlier((await readPicture(scope, map.id, theme))!.bytes)).toBe(false);
    for (const width of PICTURE_SHAPE.widths) {
      const size = (await readPicture(scope, map.id, theme, { shape: "card", width }))!;
      expect(size.type).toBe("image/webp");
      expect(webpDimensions(size.bytes)?.width).toBe(width);
    }
  }
  const state = getPictureState(map.id)!;
  expect(state).toMatchObject({ state: "current", producer: "server", attemptCount: 0 });
  expect(state.publishedGeneration).toBe(state.requestedGeneration);
  expect(state.publishedGeneration).toBeGreaterThan(map.before.publishedGeneration);
}

/** The map still serves its earlier set exactly, every size and theme. */
async function expectEarlierKept(map: EarlierMap) {
  expect(publishedManifest(map.id)).toEqual(map.manifest);
  expect(files(map.id)).toEqual(map.files);
  for (const theme of THEMES) {
    expect(isEarlier((await readPicture(scope, map.id, theme))!.bytes)).toBe(true);
    for (const width of PICTURE_SHAPE.widths) expect(isEarlier((await readPicture(scope, map.id, theme, { shape: "card", width }))!.bytes)).toBe(true);
  }
  expect(getPictureState(map.id)!.publishedGeneration).toBe(map.before.publishedGeneration);
}

it("renews a labelled map's set drawn by an earlier label recipe as one whole set, both themes on Auto, and leaves maps without visible labels alone", async () => {
  const auto = await earlierMap("Auto, labelled", [{ label: true }]);
  const fixed = await earlierMap("Light, labelled", [{ label: true }], { basemap: "light" });
  const hidden = await earlierMap("Labels on a hidden layer", [{ label: true, visible: false }, { label: false }]);
  const plain = await earlierMap("No labels", [{ label: false }]);
  const h = harness();
  await h.service.look(); await h.settle();

  await expectRenewed(auto, ["light", "dark"]);
  await expectRenewed(fixed, ["light"]);
  for (const kept of [hidden, plain]) {
    expect(rendered(kept.id)).toEqual([]);
    expect(getPictureState(kept.id)).toEqual(kept.before);
    await expectEarlierKept(kept);
  }
});

it("after an upgrade renews a labelled map once: reads, later looks and a restart make nothing again", async () => {
  const auto = await earlierMap("Upgraded", [{ label: true }], { upgraded: true });
  const h = harness();
  await h.service.look(); h.advance(5001); await h.settle();
  await expectRenewed(auto, ["light", "dark"]);

  const renewed = getPictureState(auto.id), manifest = publishedManifest(auto.id), calls = renderer.calls.length;
  for (const theme of THEMES) {
    await readPicture(scope, auto.id, theme);
    await readPicture(scope, auto.id, theme, { shape: "card", width: 720 });
  }
  mapWithLayers(scope, auto.id);
  await h.service.look(); h.advance(3_600_000); await h.settle();
  // A restart: a new service, its first look over the same store.
  const restarted = harness(Date.now() + 7_200_000);
  await restarted.service.look(); restarted.advance(5001); await restarted.settle();

  expect(renderer.calls).toHaveLength(calls);
  expect(getPictureState(auto.id)).toEqual(renewed);
  expect(publishedManifest(auto.id)).toEqual(manifest);
});

it.each([
  ["fails", "failed"],
  ["finds the renderer unavailable", "unavailable"],
  ["is overtaken by an edit", "overtaken"],
] as const)("a renewal that %s publishes no part of a new set, and the next attempt renews it whole", async (_case, kind) => {
  const auto = await earlierMap("Troubled", [{ label: true }]);
  const h = harness();
  renderer.trouble = {
    appearance: "dark",
    act: async () => {
      if (kind === "failed") throw new Error("The renderer stopped.");
      if (kind === "unavailable") throw new ApiError("render_unavailable", "No renderer is available.", 503);
      // An edit lands and is requested while the attempt draws.
      metadataDb().prepare("UPDATE layers SET style = json_set(style, '$.label.size', 14) WHERE map_id = ?").run(auto.id);
      await h.service.request(auto.id);
    },
  };
  await h.service.look(); await h.service.queue.drain();

  // The light appearance was drawn and the dark one troubled: nothing of
  // either is published, and the earlier set is served as it was.
  expect(rendered(auto.id)).toEqual(["light", "dark"]);
  await expectEarlierKept(auto);
  const troubled = getPictureState(auto.id)!;
  if (kind === "failed") expect(troubled).toMatchObject({ state: "failed", attemptCount: 1 });
  if (kind === "unavailable") expect(troubled).toMatchObject({ state: "unavailable" });
  // Overtaken, the attempt counts no failure; the newer request waits its
  // quiet time.
  if (kind === "overtaken") expect(troubled).toMatchObject({ state: "waiting", attemptCount: 0, requestedGeneration: auto.before.requestedGeneration + 2 });

  // The existing rules carry it on: a first failure is tried again at
  // once, a renderer found again at the next look, the overtaking request
  // after its quiet time.
  renderer.trouble = null; renderer.calls.length = 0;
  if (kind === "unavailable") await h.service.look();
  h.advance(5001); await h.settle();
  await expectRenewed(auto, ["light", "dark"]);
});

async function duplicate(id: string, service: PictureService) {
  const copy = duplicateMap(scope, id);
  await copyThumbnail(scope, id, copy.id);
  await service.adopt(copy.id);
  return copy.id;
}

it("a duplicate made before the renewal finishes is made again, not adopted as current; one made after carries the renewed set", async () => {
  const source = await earlierMap("Source", [{ label: true }], { upgraded: true });
  const plain = await earlierMap("Plain source", [{ label: false }]);
  const h = harness();
  // The source's renewal is requested and waits its quiet time.
  await h.service.look();
  expect(getPictureState(source.id)).toMatchObject({ state: "waiting", publishedGeneration: source.before.publishedGeneration });

  const early = await duplicate(source.id, h.service);
  const inherited: EarlierMap = { id: early, before: getPictureState(early)!, manifest: publishedManifest(early), files: files(early) };
  // The earlier pictures came across, and a request beyond them was made
  // at once.
  expect(inherited.files).toHaveLength(source.files.length);
  expect(inherited.before).toMatchObject({ producer: "inherited", publishedGeneration: 1 });
  expect(inherited.before.requestedGeneration).toBeGreaterThan(inherited.before.publishedGeneration);
  const plainCopy = await duplicate(plain.id, h.service);
  expect(getPictureState(plainCopy)).toMatchObject({ state: "current", producer: "inherited" });

  h.advance(5001); await h.settle();
  await expectRenewed(source, ["light", "dark"]);
  await expectRenewed(inherited, ["light", "dark"]);
  expect(rendered(plainCopy)).toEqual([]);
  expect(getPictureState(plainCopy)).toMatchObject({ state: "current", producer: "inherited" });

  const late = await duplicate(source.id, h.service);
  h.advance(5001); await h.settle();
  expect(rendered(late)).toEqual([]);
  expect(getPictureState(late)).toMatchObject({ state: "current", producer: "inherited" });
  expect(publishedManifest(late)).toMatchObject({ labels: LABEL_RECIPE_VERSION });
  expect(await publishedPictureFormat(late)).toMatchObject({ sized: true, recipe: PICTURE_RECIPE, labels: LABEL_RECIPE_VERSION });
});

async function folderHashes(dir: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    hashes[path.relative(dir, file)] = createHash("sha256").update(await readFile(file)).digest("hex");
  }
  return hashes;
}

it("a copy of a labelled template is drawn again with the label recipe, and the installed template's files stay as they are", async () => {
  const root = process.env.DEZFIL_DATA_DIR!;
  const fixture = await buildTemplate(path.join(root, "labelled-template-fixture"), {
    id: "labelled-template",
    edit: (members) => {
      const layer = (members.documents.get("maps/map.json")!.layers as { style: Record<string, unknown> }[])[0];
      layer.style = { ...layer.style, label: EARLIER_LABEL };
    },
  });
  const folder = await writeShippedFolder(path.join(root, "labelled-shipped"), [fixture]);
  const installed = await folderHashes(folder);
  const spy = vi.spyOn(shipped, "shippedTemplatesDir").mockReturnValue(folder);
  try {
    const h = harness();
    const copied = (await copyTemplate(scope, "labelled-template")).members.maps[0].id;
    expect(await publishedPictureFormat(copied)).toMatchObject({ template: true });
    await h.service.adopt(copied); await h.settle();

    const target = pictureTarget(scope, copied);
    expect(rendered(copied)).toEqual(target.basemaps.dark ? ["light", "dark"] : ["light"]);
    expect(getPictureState(copied)).toMatchObject({ state: "current", producer: "server" });
    expect(await publishedPictureFormat(copied)).toEqual({ sized: true, recipe: PICTURE_RECIPE, labels: LABEL_RECIPE_VERSION, template: false });

    await h.service.look(); h.advance(5001); await h.settle();
    expect(rendered(copied)).toHaveLength(target.basemaps.dark ? 2 : 1);
    expect(await folderHashes(folder)).toEqual(installed);
  } finally { spy.mockRestore(); }
});
