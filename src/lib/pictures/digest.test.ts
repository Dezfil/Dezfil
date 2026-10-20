import { describe, expect, it } from "vitest";
import type { MapWithLayers, Layer } from "@/lib/metadata/maps";
import { drawingDigest, firstFormulaDigest, onCurrentFormula, requestDrawing } from "./digest";

const layer = { id: "a", sql: "SELECT * FROM places", visible: true, style: { opacity: 1 }, viz: { type: "points" }, filters: [], ordinal: 0 } as unknown as Layer;
const map = { viewport: { lng: 1, lat: 2, zoom: 3 }, basemap: null, customBasemap: null, basemapLayers: null, timeline: null, layers: [layer, { ...layer, id: "b", sql: "SELECT * FROM roads", ordinal: 1 }] } as unknown as MapWithLayers;
const digest = (value = map, ground = ["light", "dark"], sketches = ["shape-file"]) => drawingDigest(value, ground, sketches);
describe("drawing freshness", () => {
  it.each([
    ["tilt", (m: MapWithLayers) => { m.viewport.pitch = 30; }],
    ["rotation", (m: MapWithLayers) => { m.viewport.bearing = 45; }],
    ["basemap", (m: MapWithLayers) => { m.basemap = "dark"; }],
    ["custom style", (m: MapWithLayers) => { m.customBasemap = { url: "https://example.test/style", name: null, attribution: [] }; }],
    ["basemap groups", (m: MapWithLayers) => { m.basemapLayers = { labels: false }; }],
    ["timeline", (m: MapWithLayers) => { m.timeline = { layerId: "a", field: "time" } as MapWithLayers["timeline"]; }],
    ["SQL", (m: MapWithLayers) => { m.layers[0].sql += " LIMIT 1"; }],
    ["style", (m: MapWithLayers) => { m.layers[0].style.opacity = 0.2; }],
    ["filters", (m: MapWithLayers) => { m.layers[0].filters = [{ field: "v", kind: "values", values: ["one"] }] as Layer["filters"]; }],
    ["visualization", (m: MapWithLayers) => { m.layers[0].viz = { type: "heatmap" } as Layer["viz"]; }],
    ["visibility", (m: MapWithLayers) => { m.layers[0].visible = false; }],
    ["order", (m: MapWithLayers) => { m.layers.reverse(); }],
    ["addition", (m: MapWithLayers) => { m.layers.push({ ...layer, id: "c" }); }],
    ["removal", (m: MapWithLayers) => { m.layers.pop(); }],
  ])("changes for %s", (_name, change) => {
    const changed = structuredClone(map); change(changed);
    expect(digest(changed)).not.toBe(digest());
  });
  it.each(["name", "note", "projectId", "published", "publishToken", "publishedAt", "legendCorner", "legendOrder", "widgets", "widgetsPublished", "updatedAt", "createdAt"])("ignores %s", field => {
    expect(digest({ ...map, [field]: "changed" })).toBe(digest());
  });
  it.each(["name", "tooltip", "popup", "publishedFields", "inLegend", "legendTitle", "legendLabels", "legendAttrs", "updatedAt"])("ignores layer %s", field => {
    expect(digest({ ...map, layers: [{ ...layer, [field]: "changed" }, map.layers[1]] })).toBe(digest());
  });
  it("observes effective ground and drawn shape artifacts", () => {
    expect(digest(map, ["replacement"])).not.toBe(digest());
    expect(digest(map, undefined, ["moved-shape"])).not.toBe(digest());
  });
  it("canonicalizes objects and camera defaults", () => {
    expect(digest({ ...map, viewport: { zoom: 3, lat: 2, lng: 1, pitch: 0, bearing: 0 } })).toBe(digest());
  });
  it("ignores the saved centre and zoom, which the picture no longer draws at", () => {
    expect(digest({ ...map, viewport: { lng: -70, lat: 40, zoom: 9 } })).toBe(digest());
  });
  it("marks its formula, and recognises the first formula's digest as the earlier code wrote it", () => {
    expect(onCurrentFormula(digest())).toBe(true);
    // Written by the first formula for this map before the camera left it.
    const first = "53d9623ff8fa2a7eb6a601ddc7272fee3d7cbb0c79ab1a579bab02d522685853";
    expect(firstFormulaDigest(map, ["light", "dark"], ["shape-file"])).toBe(first);
    expect(onCurrentFormula(first)).toBe(false);
    expect(firstFormulaDigest({ ...map, viewport: { lng: -70, lat: 40, zoom: 9 } }, ["light", "dark"], ["shape-file"])).not.toBe(first);
  });
  it("keeps excluded edits out of generations and ordering; forced refresh advances only requested", () => {
    const first = requestDrawing(null, "a", 100);
    expect(first).toEqual({ digest: "a", requestedGeneration: 1, publishedGeneration: 0, drawingChangedAt: 100 });
    expect(requestDrawing(first, "a", 200)).toEqual(first);
    const refreshed = requestDrawing(first, "a", 300, true);
    expect(refreshed).toEqual({ ...first, requestedGeneration: 2 });
    expect(requestDrawing(refreshed, "b", 400)).toEqual({ ...first, digest: "b", requestedGeneration: 3, drawingChangedAt: 400 });
  });
});
