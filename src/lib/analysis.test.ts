import { privateTileAccess } from "@/lib/tiles/access";
import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import {
  createLayer,
  updateLayer,
  renderLayer,
  requireLayer,
  layerFields,
  layerFieldStats,
  layerEffectiveSql,
} from "@/lib/layer-service";
import {
  defaultViz,
  isAggregated,
  type AggregatedViz,
  type HexbinViz,
  type LayerFilter,
} from "@/lib/viz";
import { classifyFill } from "@/lib/style/classify";
import type { FillPaint } from "@/lib/style/style";
import { resetTileBuilds, tileBuildsSettled } from "@/lib/tiles/build";

/**
 * Analysis core service behavior: aggregated rendering, viz switch
 * round-trips, filters composing before aggregation, filter seeding, and the
 * headline — an over-cap result becomes visible as cells.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "stations.csv");
  await writeFile(
    src,
    [
      "name,category,lon,lat,riders",
      "alexanderplatz,u,13.410,52.520,900",
      "hackescher,s,13.402,52.523,700",
      "zoo,u,13.330,52.510,500",
      "sudkreuz,s,13.360,52.480,120",
    ].join("\n"),
  );
  await ingestFile(testAccountScope(), src, "stations.csv");
});

afterEach(async () => {
  // A tiled render may have kicked off a background build; let it finish
  // before the directory underneath it disappears.
  await tileBuildsSettled();
  resetTileBuilds();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_RENDER_CAP_FEATURES;
  await rm(dir, { recursive: true, force: true });
});

async function pointLayer() {
  const map = createMap(testAccountScope(), "m");
  return createLayer(testAccountScope(), map.id, {
    name: "Stations",
    sql: "SELECT name, category, riders, geometry FROM stations",
  });
}

/** A deliberately varied grid source for authoritative classification tests. */
async function settlementLayer() {
  const src = path.join(dir, "settlement.csv");
  await writeFile(
    src,
    [
      "label,category,seen,score,lon,lat",
      "a,u,2021-06-01,10,13.0,52.0",
      "b,u,2021-02-01,20,13.1,52.0",
      "c,u,2021-03-01,30,13.2,52.0",
      "d,v,2021-04-01,40,13.3,52.0",
      "e,u,2021-05-01,50,13.4,52.0",
      "f,v,2021-01-01,60,13.5,52.0",
    ].join("\n"),
  );
  await ingestFile(testAccountScope(), src, "settlement.csv");
  const map = createMap(testAccountScope(), "settlement");
  const layer = await createLayer(testAccountScope(), map.id, {
    name: "Settlement",
    sql: "SELECT label, category, seen, score, geometry FROM settlement",
  });
  return updateLayer(testAccountScope(), layer.id, {
    viz: {
      type: "grid",
      cellKm: 1,
      aggregate: { fn: "sum", attribute: "score" },
    },
  });
}

function ramp(fill: FillPaint | undefined) {
  if (fill?.type !== "quantile") throw new Error("expected a ramp fill");
  return fill;
}

function aggregatedViz(layer: Awaited<ReturnType<typeof settlementLayer>>) {
  if (!isAggregated(layer.viz)) throw new Error("expected an aggregated viz");
  return layer.viz;
}

type Feature = { properties: Record<string, unknown> };
function features(render: { geojson?: unknown }): Feature[] {
  return (render.geojson as { features: Feature[] }).features;
}

describe("aggregated rendering", () => {
  it("hexbin renders cells with value/count and an auto-assigned value fill", async () => {
    const layer = await pointLayer();
    // 3 km-edge cells put alexanderplatz + hackescher together with wide
    // margins; zoo and sudkreuz stay alone (verified against lib/hex-bin).
    const updated = await updateLayer(testAccountScope(), layer.id, {
      viz: { type: "hexbin", cellKm: 3, aggregate: { fn: "count" } },
    });

    const viz = updated.viz as HexbinViz;
    expect(viz.fill).toBeDefined();
    expect(viz.fill?.type).toBe("quantile");
    if (viz.fill?.type === "quantile") {
      expect(viz.fill.attribute).toBe("value");
      expect(viz.fill.palette).toBe("global_warming");
    }

    const render = await renderLayer(updated, undefined, { tileAccess: privateTileAccess(testAccountScope(), (updated).id) });
    expect(render.ok).toBe(true);
    expect(render.featureCount).toBe(3); // two stations share a 3 km cell
    const cell = features(render).find((f) => f.properties.count === 2)!;
    expect(cell.properties.value).toBe(2);

    // style/tooltip pickers see the aggregate columns; filters keep the base
    const fields = await layerFields(updated);
    expect(fields.styling.map((f) => f.name)).toEqual(["value", "count"]);
    expect(fields.filterable.map((f) => f.name)).toEqual([
      "name",
      "category",
      "riders",
    ]);
  });

  it("switching viz back to points loses nothing", async () => {
    const layer = await pointLayer();
    const asHex = await updateLayer(testAccountScope(), layer.id, { viz: defaultViz("hexbin") });
    expect(asHex.style).toEqual(layer.style); // layer style untouched
    const back = await updateLayer(testAccountScope(), layer.id, { viz: { type: "points" } });
    expect(back.style).toEqual(layer.style);
    expect(back.sql).toBe(layer.sql);
    const render = await renderLayer(back, undefined, { tileAccess: privateTileAccess(testAccountScope(), (back).id) });
    expect(render.featureCount).toBe(4);
  });

  it("field stats answer for the aggregate value with a mean", async () => {
    const layer = await pointLayer();
    await updateLayer(testAccountScope(), layer.id, { viz: defaultViz("hexbin") });
    const { layerFieldStats } = await import("@/lib/layer-service");
    const stats = await layerFieldStats(requireLayer(testAccountScope(), layer.id), "value");
    if (stats.kind !== "numeric") throw new Error("expected numeric stats");
    expect(stats.min).not.toBeNull();
    expect(stats.mean).not.toBeNull();
    expect(stats.max).not.toBeNull();
    // The base column keeps answering too, now with a mean.
    const base = await layerFieldStats(requireLayer(testAccountScope(), layer.id), "riders");
    if (base.kind !== "numeric") throw new Error("expected numeric stats");
    expect(base.mean).not.toBeNull();
  });

  it("a label's source follows a viz switch", async () => {
    const layer = await pointLayer();
    const label = {
      attribute: "name",
      size: 12,
      color: { r: 255, g: 255, b: 255, a: 1 },
      haloWidth: 1, haloColor: { r: 12, g: 16, b: 24, a: 0.8 },
    };
    const labeled = await updateLayer(testAccountScope(), layer.id, {
      style: { ...layer.style, label },
    });
    expect(labeled.style.label?.attribute).toBe("name");

    // Points → hexbin: cells label themselves; the stale attribute drops
    // (it would otherwise leave every cell silently unlabeled).
    const asHex = await updateLayer(testAccountScope(), layer.id, { viz: defaultViz("hexbin") });
    expect(asHex.style.label).toBeDefined();
    expect(asHex.style.label?.attribute).toBeUndefined();

    // Hexbin → points: an attribute-less label has nothing to say on
    // simple features — the dead config drops entirely.
    const back = await updateLayer(testAccountScope(), layer.id, { viz: { type: "points" } });
    expect(back.style.label).toBeUndefined();
  });

  it("changing the aggregate reclassifies but keeps ramp choices", async () => {
    const layer = await pointLayer();
    await updateLayer(testAccountScope(), layer.id, { viz: defaultViz("hexbin") });
    const custom = await updateLayer(testAccountScope(), layer.id, {
      viz: {
        type: "hexbin",
        cellKm: 1.22,
        aggregate: { fn: "count" },
        fill: undefined,
      } as HexbinViz,
    });
    // explicitly choose a palette by patching viz with a classified fill
    const withPalette = await updateLayer(testAccountScope(), layer.id, {
      viz: {
        ...(custom.viz as HexbinViz),
        fill: {
          ...(custom.viz as HexbinViz).fill!,
          palette: "ice_and_fire",
        },
      } as HexbinViz,
    });
    expect(((withPalette.viz as HexbinViz).fill as { palette: string }).palette).toBe(
      "ice_and_fire",
    );
    // now change the aggregation → breaks recompute, palette survives
    const changed = await updateLayer(testAccountScope(), layer.id, {
      viz: {
        type: "hexbin",
        cellKm: 3.23,
        aggregate: { fn: "avg", attribute: "riders" },
      },
    });
    const fill = (changed.viz as HexbinViz).fill;
    expect(fill?.type).toBe("quantile");
    if (fill?.type === "quantile") expect(fill.palette).toBe("ice_and_fire");
  });

  it("grid renders square cells", async () => {
    const layer = await pointLayer();
    const updated = await updateLayer(testAccountScope(), layer.id, {
      viz: { type: "grid", cellKm: 1000, aggregate: { fn: "sum", attribute: "riders" } },
    });
    const render = await renderLayer(updated, undefined, { tileAccess: privateTileAccess(testAccountScope(), (updated).id) });
    expect(render.ok).toBe(true);
    expect(render.featureCount).toBe(1);
    expect(features(render)[0].properties.value).toBe(2220);
  });

  it("refuses aggregation on non-point layers", async () => {
    const map = createMap(testAccountScope(), "m");
    const lines = await createLayer(testAccountScope(), map.id, {
      name: "Lines",
      sql: "SELECT ST_MakeLine(ST_Point(0,0), ST_Point(1,1)) AS geometry",
    });
    await expect(
      updateLayer(testAccountScope(), lines.id, { viz: defaultViz("hexbin") }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    await expect(
      updateLayer(testAccountScope(), lines.id, { viz: defaultViz("heatmap") }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
  });

  it("a result over the render cap still renders as cells (the headline)", async () => {
    const layer = await pointLayer();
    process.env.DEZFIL_RENDER_CAP_FEATURES = "3";
    // supersedes the cap error for simple features: over-cap points
    // switch to tiles instead (tiled rendering has its own suite).
    const asPoints = await renderLayer(layer, undefined, { tileAccess: privateTileAccess(testAccountScope(), (layer).id) });
    expect(asPoints.ok).toBe(true);
    expect(asPoints.mode).toBe("tiled");

    const updated = await updateLayer(testAccountScope(), layer.id, {
      viz: { type: "hexbin", cellKm: 3, aggregate: { fn: "count" } },
    });
    const asCells = await renderLayer(updated, undefined, { tileAccess: privateTileAccess(testAccountScope(), (updated).id) });
    expect(asCells.ok).toBe(true);
    expect(asCells.featureCount).toBe(3);
  });

  it("the heatmap keeps its cap with an actionable message", async () => {
    const layer = await pointLayer();
    await updateLayer(testAccountScope(), layer.id, { viz: defaultViz("heatmap") });
    process.env.DEZFIL_RENDER_CAP_FEATURES = "3";
    const render = await renderLayer(requireLayer(testAccountScope(), layer.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layer.id)).id) });
    expect(render.ok).toBe(false);
    expect(render.error?.code).toBe("render_cap_exceeded");
    expect(render.error?.message).toMatch(/hex bins or grid/i);
  });
});

describe("filters", () => {
  it("refine the result and compose before aggregation", async () => {
    const layer = await pointLayer();
    const filtered = await updateLayer(testAccountScope(), layer.id, {
      filters: [
        { field: "riders", kind: "range", min: 400, max: null },
        { field: "category", kind: "values", values: ["u"] },
      ],
    });
    const render = await renderLayer(filtered, undefined, { tileAccess: privateTileAccess(testAccountScope(), (filtered).id) });
    expect(render.featureCount).toBe(2); // alexanderplatz + zoo

    const aggregated = await updateLayer(testAccountScope(), layer.id, { viz: defaultViz("hexbin") });
    const cells = await renderLayer(aggregated, undefined, { tileAccess: privateTileAccess(testAccountScope(), (aggregated).id) });
    const total = features(cells).reduce(
      (s, f) => s + Number(f.properties.count),
      0,
    );
    expect(total).toBe(2); // aggregation sees the filtered rows only

    const cleared = await updateLayer(testAccountScope(), layer.id, {
      filters: [],
      viz: { type: "points" },
    });
    expect((await renderLayer(cleared, undefined, { tileAccess: privateTileAccess(testAccountScope(), (cleared).id) })).featureCount).toBe(4); // restored exactly
  });

  it("settles aggregate breaks from every accepted filter while preserving ramp intent", async () => {
    const layer = await settlementLayer();
    const initialFill = await classifyFill(
      await layerEffectiveSql(layer),
      "value",
      "equal",
      { palette: "ice_and_fire", classes: 4, reversed: true },
    );
    const styled = await updateLayer(testAccountScope(), layer.id, {
      viz: { ...aggregatedViz(layer), fill: initialFill },
    });
    const beforeBreaks = ramp((styled.viz as AggregatedViz).fill).breaks;
    const exactFill = async (current: typeof styled) =>
      classifyFill(await layerEffectiveSql(current), "value", "equal", {
        palette: "ice_and_fire",
        classes: 4,
        reversed: true,
      });

    // Each filter matters independently: removing category admits d (40),
    // removing range admits a (10), and removing time admits b (20).
    const filters: LayerFilter[] = [
      { field: "category", kind: "values" as const, values: ["u"] },
      { field: "score", kind: "range" as const, min: 20, max: null },
      {
        field: "seen",
        kind: "timerange" as const,
        min: "2021-03-01",
        max: null,
      },
    ];
    const filtered = await updateLayer(testAccountScope(), layer.id, { filters });
    const settled = ramp((filtered.viz as AggregatedViz).fill);
    const expected = await exactFill(filtered);

    expect(settled).toEqual(expected);
    expect(settled.breaks).not.toEqual(beforeBreaks);
    expect(settled).toMatchObject({
      method: "equal",
      palette: "ice_and_fire",
      reversed: true,
    });
    expect(settled.colors).toHaveLength(4);

    // Every filter kind is edited and removed independently through the same
    // authoritative path. Each image must classify its own exact result.
    const mutations: LayerFilter[][] = [
      [
        { field: "category", kind: "values", values: ["u", "v"] },
        filters[1],
        filters[2],
      ],
      [
        filters[0],
        { field: "score", kind: "range", min: 30, max: null },
        filters[2],
      ],
      [
        filters[0],
        filters[1],
        {
          field: "seen",
          kind: "timerange",
          min: "2021-04-01",
          max: null,
        },
      ],
      [filters[1], filters[2]],
      [filters[0], filters[2]],
      [filters[0], filters[1]],
      [],
    ];
    let removed = filtered;
    for (const next of mutations) {
      removed = await updateLayer(testAccountScope(), layer.id, { filters: next });
      expect((removed.viz as AggregatedViz).fill).toEqual(
        await exactFill(removed),
      );
    }
    expect((removed.viz as AggregatedViz).fill).toEqual(initialFill);
  });

  it("returns Custom aggregate breaks to their base method and leaves constants alone", async () => {
    const layer = await settlementLayer();
    const named = ramp(
      await classifyFill(await layerEffectiveSql(layer), "value", "natural", {
        palette: "ice_and_fire",
        classes: 4,
        reversed: true,
      }),
    );
    const custom = {
      ...named,
      method: "custom" as const,
      baseMethod: "natural" as const,
      breaks: named.breaks.map((n, i) => n + (i + 1) * 0.01),
    };
    await updateLayer(testAccountScope(), layer.id, {
      viz: { ...aggregatedViz(layer), fill: custom },
    });

    const filtered = await updateLayer(testAccountScope(), layer.id, {
      filters: [{ field: "category", kind: "values", values: ["u"] }],
    });
    const settled = ramp((filtered.viz as AggregatedViz).fill);
    expect(settled.method).toBe("natural");
    expect(settled.baseMethod).toBeUndefined();
    expect(settled.palette).toBe("ice_and_fire");
    expect(settled.reversed).toBe(true);
    expect(settled.colors).toHaveLength(4);
    expect(settled.breaks).not.toEqual(custom.breaks);

    const constant = {
      type: "constant" as const,
      color: { r: 1, g: 2, b: 3, a: 0.7 },
    };
    await updateLayer(testAccountScope(), layer.id, {
      filters: [],
      viz: { ...(filtered.viz as AggregatedViz), fill: constant },
    });
    const constantFiltered = await updateLayer(testAccountScope(), layer.id, {
      filters: [{ field: "category", kind: "values", values: ["v"] }],
    });
    expect((constantFiltered.viz as AggregatedViz).fill).toEqual(constant);
  });

  it("field stats seed range and value controls from the unfiltered result", async () => {
    const layer = await pointLayer();
    await updateLayer(testAccountScope(), layer.id, {
      filters: [{ field: "riders", kind: "range", min: 800, max: null }],
    });
    const riders = await layerFieldStats(layer, "riders");
    expect(riders).toMatchObject({
      field: "riders",
      kind: "numeric",
      numeric: true,
      min: 120,
      max: 900,
    });
    const category = await layerFieldStats(layer, "category");
    expect(category).toMatchObject({ kind: "text", numeric: false, truncated: false });
    if (category.kind === "text") expect(category.values.sort()).toEqual(["s", "u"]);
    await expect(layerFieldStats(layer, "nope")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("numeric stats carry a distribution over the full extent", async () => {
    const layer = await pointLayer();
    const riders = await layerFieldStats(layer, "riders");
    if (riders.kind !== "numeric") throw new Error("expected numeric stats");
    expect(riders.bins.length).toBeGreaterThan(0);
    // Every row lands in exactly one bin; first and last bins hold the extremes.
    expect(riders.bins.reduce((s, n) => s + n, 0)).toBe(4);
    expect(riders.bins[0]).toBeGreaterThan(0); // 120
    expect(riders.bins[riders.bins.length - 1]).toBeGreaterThan(0); // 900
  });

  it("time fields get time kind, ISO extent, and a distribution", async () => {
    const src = path.join(dir, "pings.csv");
    await writeFile(
      src,
      [
        "label,seen,lon,lat",
        "a,2021-03-01 08:30:00,13.40,52.50",
        "b,2021-03-02 09:00:00,13.30,52.40",
        "c,2021-04-01 10:15:00,13.20,52.60",
      ].join("\n"),
    );
    await ingestFile(testAccountScope(), src, "pings.csv");
    const map = createMap(testAccountScope(), "t");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "Pings",
      sql: "SELECT label, seen, geometry FROM pings",
    });

    const fields = await layerFields(layer);
    const seen = fields.filterable.find((f) => f.name === "seen");
    expect(seen?.kind).toBe("time");
    expect(fields.filterable.find((f) => f.name === "label")?.kind).toBe("text");

    const stats = await layerFieldStats(layer, "seen");
    if (stats.kind !== "time") throw new Error("expected time stats");
    expect(stats.min).toBe("2021-03-01T08:30:00");
    expect(stats.max).toBe("2021-04-01T10:15:00");
    expect(stats.bins.reduce((s, n) => s + n, 0)).toBe(3);

    // A time filter is live: the render ships the full result and
    // delegates the brush to the client. The filter still means "c only"
    // everywhere else — the effective query keeps applying it.
    const filtered = await updateLayer(testAccountScope(), layer.id, {
      filters: [{ field: "seen", kind: "timerange", min: "2021-03-15", max: null }],
    });
    const render = await renderLayer(filtered, undefined, { tileAccess: privateTileAccess(testAccountScope(), (filtered).id) });
    expect(render.featureCount).toBe(3);
    expect(render.liveFiltered).toBe(true);
  });
});
