import { readDocumentRevision } from "@/lib/metadata/revisions";
import { privateTileAccess } from "@/lib/tiles/access";
import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap, updateMap } from "@/lib/map-service";
import { createLayer, renderLayer, updateLayer, type LayerRenderData } from "@/lib/layer-service";
import { renderLayerWithSelections } from "@/lib/widget-service";
import { createSketch } from "@/lib/sketch/store";
import { defaultStyle } from "@/lib/style/defaults";
import type { Layer } from "@/lib/metadata/maps";
import type { MapWidget } from "@/lib/widgets";

/**
 * A builder render carries what the layer and its map read from features,
 * not every column of the result: a known unused field stays home, the
 * answer is smaller for it, and the geometry, the rows and their order are
 * the query's as before.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const revision = (mapId: string) => ({ expectedRevision: readDocumentRevision({ kind: "map", id: mapId })?.editRevision });

async function wide(sql = "SELECT * FROM w"): Promise<Layer> {
  const src = path.join(dir, "w.csv");
  await writeFile(src, "name,secret,riders,opened,lon,lat\na,s1,10,2024-01-02,1,2\nb,s2,20,2024-03-04,3,4\n");
  await ingestFile(testAccountScope(), src, "w.csv");
  const map = createMap(testAccountScope(), "wide");
  return createLayer(testAccountScope(), map.id, { name: "l", sql }, revision(map.id));
}

const edit = (layer: Layer, fields: Parameters<typeof updateLayer>[2]) =>
  updateLayer(testAccountScope(), layer.id, fields, revision(layer.mapId));

const render = (layer: Layer): Promise<LayerRenderData> =>
  renderLayer(testAccountScope(), layer, undefined, { tileAccess: privateTileAccess(testAccountScope(), layer.id) });

type Features = { features: { geometry: unknown; properties: Record<string, unknown> }[] };
const featuresOf = (answer: LayerRenderData) => (answer.geojson as Features).features;
const keysOf = (answer: LayerRenderData) => Object.keys(featuresOf(answer)[0].properties);
const bytesOf = (answer: LayerRenderData) => Buffer.byteLength(JSON.stringify(answer), "utf8");

it("leaves a known unused field out, strictly smaller than the full row, the rows unchanged", async () => {
  const layer = await wide();
  // Automatic interactions over five columns read all of them: the full
  // row the builder render carried before it was narrowed.
  const full = await render(layer);
  expect(keysOf(full)).toEqual(["name", "secret", "riders", "opened", "lon", "lat"]);

  const narrowed = await render(await edit(layer, { tooltip: ["name"], popup: [] }));
  expect(keysOf(narrowed)).toEqual(["name"]);
  expect(bytesOf(narrowed)).toBeLessThan(bytesOf(full));
  expect(featuresOf(narrowed).map((feature) => feature.geometry)).toEqual(featuresOf(full).map((feature) => feature.geometry));
  expect(featuresOf(narrowed).map((feature) => feature.properties.name)).toEqual(["a", "b"]);
  expect(narrowed.featureCount).toBe(full.featureCount);
});

it("keeps result order over reordered and computed columns", async () => {
  const layer = await wide("SELECT riders * 2 AS doubled, secret, name, ST_Point(lon, lat) AS geom FROM w");
  const style = defaultStyle("POINT");
  const labelled = await edit(layer, {
    tooltip: ["name"],
    popup: [],
    style: { ...style, label: { attribute: "doubled", size: 12, color: { r: 0, g: 0, b: 0, a: 1 }, haloWidth: 1, haloColor: { r: 0, g: 0, b: 0, a: 1 } } },
  });
  const answer = await render(labelled);
  expect(keysOf(answer)).toEqual(["doubled", "name"]);
  expect(featuresOf(answer).map((feature) => feature.properties.doubled)).toEqual([20, 40]);
});

it("carries the fields its map's widgets and docked timeline read, and never the published override", async () => {
  const layer = await edit(await wide(), {
    tooltip: [],
    popup: [],
    publishedFields: ["secret"],
    filters: [{ field: "opened", kind: "timerange", min: null, max: null }],
  });
  const widget: MapWidget = {
    id: "w1", type: "histogram", layerId: layer.id, title: "Riders", field: "riders",
    agg: "count", aggField: null, unit: null, note: null, format: null, visible: false,
  };
  updateMap(testAccountScope(), layer.mapId, { widgets: [widget], widgetsPublished: false }, revision(layer.mapId));
  expect(keysOf(await render(layer))).toEqual(["riders", "opened"]);

  updateMap(testAccountScope(), layer.mapId, { timeline: { layerId: layer.id, field: "opened", speed: 1 } }, revision(layer.mapId));
  const docked = await render(layer);
  expect(docked).toMatchObject({ liveFiltered: true });
  expect(keysOf(docked)).toEqual(["riders", "opened"]);
});

it("narrows the builder's settle preview by the same policy", async () => {
  const layer = await edit(await wide(), {
    tooltip: ["name"],
    popup: [],
    viz: { type: "cluster", radiusPx: 64, color: { fn: "sum", attribute: "riders" }, showCounts: true },
  });
  const settled = await renderLayerWithSelections(testAccountScope(), layer, [{ field: "riders", kind: "range", min: 15, max: null }]);
  expect(keysOf(settled)).toEqual(["name", "riders"]);
  expect(settled.featureCount).toBe(1);
});

it("keeps a drawn sketch's identity and kind with empty interaction lists", async () => {
  const map = createMap(testAccountScope(), "Drawing");
  const polygon = { kind: "polygon", geometry: { type: "Polygon", coordinates: [[[1, 1], [2, 1], [2, 2], [1, 1]]] } };
  const { layerId, featureId } = await createSketch(testAccountScope(), map.id, polygon, revision(map.id));
  const { getLayer } = await import("@/lib/metadata/maps");
  const drawn = await edit(getLayer(layerId)!, { tooltip: [], popup: [] });
  const [feature] = featuresOf(await render(drawn));
  expect(Object.keys(feature.properties)).toEqual(["feature_id", "kind", "__anchor"]);
  expect(feature.properties).toMatchObject({ feature_id: featureId, kind: "polygon" });
});
