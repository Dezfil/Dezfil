import { describe, it, expect } from "vitest";
import {
  BASEMAP_LAYER_GROUPS,
  authoredBasemapVisibility,
  basemapLayerVisibilities,
  basemapLayersApply,
  classifyBasemapLayer,
  presentBasemapGroups,
  type BasemapLayerGroup,
  type StyleLayerLike,
} from "./basemap-layers";
import fixtures from "./basemap-layers.fixtures.json";

/**
 * The fixtures are the three bundled OpenFreeMap styles, trimmed to what the
 * classifier reads (id, type, source-layer). If OpenFreeMap reshapes a
 * style, refreshing this file surfaces the change as a test diff.
 */
const STYLES = fixtures as Record<string, StyleLayerLike[]>;

describe("basemap layer classification", () => {
  it("covers every bundled style, and every hideable layer lands in one group", () => {
    expect(Object.keys(STYLES).sort()).toEqual(["dark", "liberty", "positron"]);
    for (const [style, layers] of Object.entries(STYLES)) {
      expect(layers.length, style).toBeGreaterThan(0);
      const unclassified = layers
        .filter((l) => classifyBasemapLayer(l) === null)
        .map((l) => l.id);
      // Only the background canvas is untouchable — everything else in the
      // bundled styles belongs to exactly one toggleable group.
      expect(unclassified, style).toEqual(["background"]);
      for (const layer of layers) {
        const group = classifyBasemapLayer(layer);
        if (group !== null) expect(BASEMAP_LAYER_GROUPS).toContain(group);
      }
    }
  });

  it("buckets each group's own content and nothing else", () => {
    const sentinels: [string, string, BasemapLayerGroup][] = [
      // [style, layer id, expected group]
      ["dark", "place_city", "labels"],
      ["dark", "highway_name_motorway", "labels"], // street names are labels
      ["dark", "road_oneway", "roads"], // one-way arrows ride with roads
      ["dark", "highway_motorway_inner", "roads"],
      ["dark", "boundary_country_z0-4", "borders"],
      ["dark", "building", "buildings"],
      ["dark", "waterway", "water"],
      ["dark", "landuse_park", "land"],
      ["positron", "airport", "labels"],
      ["positron", "highway-shield-us-interstate", "labels"],
      ["positron", "park", "land"],
      ["liberty", "poi_r20", "labels"],
      ["liberty", "building-3d", "buildings"], // 3D folds into Buildings
      ["liberty", "natural_earth", "land"], // low-zoom earth backdrop
      ["liberty", "aeroway_runway", "roads"],
      ["liberty", "water_name_point_label", "labels"],
    ];
    for (const [style, id, expected] of sentinels) {
      const layer = STYLES[style].find((l) => l.id === id);
      expect(layer, `${style}/${id}`).toBeDefined();
      expect(classifyBasemapLayer(layer!), `${style}/${id}`).toBe(expected);
    }
  });

  it("fails open: unknown content is never hidden", () => {
    expect(
      classifyBasemapLayer({ id: "background", type: "background" }),
    ).toBeNull();
    expect(
      classifyBasemapLayer({
        id: "hillshade",
        type: "fill",
        "source-layer": "hillshade", // not in the schema map
      }),
    ).toBeNull();
  });

  it("toggles never touch imagery styles", () => {
    // The satellite photo is one raster layer, which the classifier calls
    // Land — so a saved "hide Land" would blank the imagery if the canvas
    // applied toggles there. The kind guard is what prevents that.
    expect(
      classifyBasemapLayer({ id: "satellite", type: "raster" }),
    ).toBe("land");
    expect(basemapLayersApply("imagery")).toBe(false);
    expect(basemapLayersApply("vector")).toBe(true);
  });
});

describe("present groups of a loaded style", () => {
  it("reports exactly the groups the classifier finds, in canonical order", () => {
    const layers = [
      { id: "bg", type: "background" },
      { id: "water", type: "fill", "source-layer": "water" },
      { id: "roads", type: "line", "source-layer": "transportation" },
      { id: "place-names", type: "symbol", "source-layer": "place" },
    ];
    expect(presentBasemapGroups(layers)).toEqual([
      "labels",
      "roads",
      "water",
    ]);
  });

  it("an empty or unclassifiable style reports no groups", () => {
    expect(presentBasemapGroups([])).toEqual([]);
    expect(
      presentBasemapGroups([{ id: "bg", type: "background" }]),
    ).toEqual([]);
  });
});

describe("the group-visibility decision", () => {
  const layers: StyleLayerLike[] = [
    { id: "background", type: "background" },
    { id: "water", type: "fill", "source-layer": "water" },
    { id: "road", type: "line", "source-layer": "transportation" },
    { id: "place_city", type: "symbol", "source-layer": "place" },
    { id: "hidden_park", type: "fill", "source-layer": "park" },
  ];
  const authored = new Map<string, "visible" | "none">([
    ["background", "visible"],
    ["water", "visible"],
    ["road", "visible"],
    ["place_city", "visible"],
    ["hidden_park", "none"],
  ]);

  it("reads a style's authored visibilities before anything touches them", () => {
    expect(
      authoredBasemapVisibility([
        { id: "a" },
        { id: "b", layout: { visibility: "none" } },
        { id: "c", layout: { visibility: "visible" } },
      ]),
    ).toEqual(
      new Map([
        ["a", "visible"],
        ["b", "none"],
        ["c", "visible"],
      ]),
    );
  });

  it("hides a toggled-off group's layers and returns every other classified layer to its authored visibility", () => {
    const decided = basemapLayerVisibilities({
      kind: "vector",
      layers,
      toggles: { labels: false, water: false },
      authored: (id) => authored.get(id),
    });
    expect(decided).toEqual([
      { id: "water", visibility: "none" },
      { id: "road", visibility: "visible" },
      { id: "place_city", visibility: "none" },
      { id: "hidden_park", visibility: "none" },
    ]);
    // An authored-hidden layer stays hidden even with its group on.
    const back = basemapLayerVisibilities({
      kind: "vector",
      layers,
      toggles: null,
      authored: (id) => authored.get(id),
    });
    expect(back.find((d) => d.id === "hidden_park")).toEqual({
      id: "hidden_park",
      visibility: "none",
    });
    expect(back.find((d) => d.id === "water")).toEqual({
      id: "water",
      visibility: "visible",
    });
  });

  it("never lists unrecognized content, and an instance with no authored record reads as visible", () => {
    const decided = basemapLayerVisibilities({
      kind: "vector",
      layers,
      toggles: { land: false },
      authored: () => undefined,
    });
    expect(decided.map((d) => d.id)).not.toContain("background");
    expect(decided.find((d) => d.id === "hidden_park")).toEqual({
      id: "hidden_park",
      visibility: "none",
    });
    expect(decided.find((d) => d.id === "road")).toEqual({
      id: "road",
      visibility: "visible",
    });
  });

  it("decides nothing on imagery", () => {
    expect(
      basemapLayerVisibilities({
        kind: "imagery",
        layers,
        toggles: { land: false },
        authored: () => "visible",
      }),
    ).toEqual([]);
  });
});
