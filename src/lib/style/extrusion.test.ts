import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { open } from "@/lib/metadata/db";
import { insertMap, getMap, updateMapFields } from "@/lib/metadata/maps";
import {
  isValidViz,
  effectiveStyle,
  ELEVATION_HEIGHT,
  AGG_ELEV,
  type HexbinViz,
} from "@/lib/viz";
import { effectiveSql } from "@/lib/query/compile";
import { styleProblem, type LayerStyle, type SizeScale } from "./style";
import { defaultStyle } from "./defaults";
import { extrusionScale, extrusionProps } from "./deck-style";
import { legendFor } from "./legend";

const hexbin = (over: Partial<HexbinViz> = {}): HexbinViz => ({
  type: "hexbin",
  cellKm: 1.2,
  aggregate: { fn: "count" },
  ...over,
});

const HEIGHT_BY: SizeScale = {
  attribute: "stories",
  domain: [1, 40],
  range: [0, 3000],
};

const styled = (over: Partial<LayerStyle> = {}): LayerStyle => ({
  ...defaultStyle("POLYGON", 0),
  ...over,
});

describe("cell elevation model", () => {
  it("validates the elevation config", () => {
    expect(isValidViz(hexbin())).toBe(true);
    expect(
      isValidViz(
        hexbin({
          elevation: { aggregate: { fn: "count" }, height: 3000 },
        }),
      ),
    ).toBe(true);
    expect(
      isValidViz(
        hexbin({
          elevation: {
            aggregate: { fn: "avg", attribute: "speed" },
            height: ELEVATION_HEIGHT.max,
            domain: [0, 120],
          },
        }),
      ),
    ).toBe(true);
    expect(
      isValidViz(
        hexbin({ elevation: { aggregate: { fn: "count" }, height: 1 } }),
      ),
    ).toBe(false);
    expect(
      isValidViz(
        hexbin({
          elevation: {
            aggregate: { fn: "count" },
            height: 3000,
            domain: [10, 0],
          },
        }),
      ),
    ).toBe(false);
  });

  it("emits the reserved elevation column exactly when configured", () => {
    const flat = effectiveSql(
      { sql: "SELECT * FROM t", filters: [], viz: hexbin() },
      "geometry",
    );
    expect(flat).not.toContain(`"${AGG_ELEV}"`);
    const raised = effectiveSql(
      {
        sql: "SELECT * FROM t",
        filters: [],
        viz: hexbin({
          elevation: { aggregate: { fn: "avg", attribute: "speed" }, height: 3000 },
        }),
      },
      "geometry",
    );
    expect(raised).toContain(`avg("speed"::DOUBLE) AS "${AGG_ELEV}"`);
  });
});

describe("height-by style channel", () => {
  it("accepts meters far beyond the pixel cap, still bounded", () => {
    expect(styleProblem(styled({ heightBy: HEIGHT_BY }))).toBeNull();
    expect(
      styleProblem(
        styled({ heightBy: { ...HEIGHT_BY, range: [0, 200_000] } }),
      ),
    ).toMatch(/heightBy/);
  });

  it("is stripped from the effective style of aggregated layers", () => {
    const effective = effectiveStyle(
      styled({ heightBy: HEIGHT_BY }),
      hexbin(),
    );
    expect(effective.heightBy).toBeUndefined();
  });
});

describe("extrusion accessors", () => {
  it("cells map the resolved domain onto [0, height] meters", () => {
    const scale = extrusionScale(
      styled(),
      hexbin({
        elevation: {
          aggregate: { fn: "count" },
          height: 3000,
          domain: [0, 60],
        },
      }),
    );
    expect(scale).not.toBeNull();
    const props = extrusionProps(scale!);
    expect(props.extruded).toBe(true);
    const height = props.getElevation;
    expect(height({ properties: { [AGG_ELEV]: 0 } })).toBe(0);
    expect(height({ properties: { [AGG_ELEV]: 30 } })).toBe(1500);
    expect(height({ properties: { [AGG_ELEV]: 60 } })).toBe(3000);
    expect(height({ properties: { [AGG_ELEV]: 999 } })).toBe(3000);
    expect(height({ properties: {} })).toBe(0);
  });

  it("polygons rise by the style channel; everything else stays flat", () => {
    const scale = extrusionScale(styled({ heightBy: HEIGHT_BY }), {
      type: "points",
    });
    expect(scale).toEqual(HEIGHT_BY);
    expect(extrusionScale(styled(), { type: "points" })).toBeNull();
    expect(extrusionScale(styled(), hexbin())).toBeNull();
    expect(
      extrusionScale(styled({ heightBy: HEIGHT_BY }), {
        type: "heatmap",
        radiusPx: 30,
        intensity: 1,
        weight: null,
      }),
    ).toBeNull();
  });
});

describe("height legend line", () => {
  it("cells get a height row when height encodes something color does not", () => {
    const legend = legendFor(
      styled(),
      hexbin({
        elevation: {
          aggregate: { fn: "avg", attribute: "speed" },
          height: 3000,
          domain: [0, 120],
        },
      }),
    );
    const height = legend?.sizes.find((s) => s.channel === "height");
    expect(height?.attribute).toBe("avg speed");
    expect(height?.labels).toEqual(["0", "120"]);
  });

  it("no height row when it repeats the color's story", () => {
    const legend = legendFor(
      styled(),
      hexbin({
        elevation: { aggregate: { fn: "count" }, height: 3000 },
      }),
    );
    expect(legend?.sizes.find((s) => s.channel === "height")).toBeUndefined();
  });
});

describe("camera persistence", () => {
  let dir: string;
  let db: Database;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
    db = open(path.join(dir, "metadata.sqlite"));
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("stores pitch and bearing, defaulting flat and north-up", () => {
    const now = new Date().toISOString();
    insertMap(
      {
        id: "m1",
        name: "Tilted",
        viewport: { lng: 13.4, lat: 52.5, zoom: 11, pitch: 55, bearing: -20 },
        basemap: null,
        customBasemap: null,
        basemapLayers: null,
        note: null,
        legendCorner: null,
        legendOrder: null,
        timeline: null,
        widgets: [],
        widgetsPublished: true,
        publishToken: null,
        publishedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      db,
    );
    expect(getMap("m1", db)?.viewport).toEqual({
      lng: 13.4,
      lat: 52.5,
      zoom: 11,
      pitch: 55,
      bearing: -20,
    });
    // A camera without the fields stores flat — one whole camera.
    updateMapFields(
      "m1",
      { viewport: { lng: 0, lat: 0, zoom: 2 } },
      db,
    );
    expect(getMap("m1", db)?.viewport).toEqual({
      lng: 0,
      lat: 0,
      zoom: 2,
      pitch: 0,
      bearing: 0,
    });
  });
});
