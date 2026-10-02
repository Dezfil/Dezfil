import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { getLayer as readEditLayer } from "@/lib/metadata/maps";
import { readLayer } from "@/lib/layer-access";
import { privateTileAccess } from "@/lib/tiles/access";
import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import {
  createLayer,
  requireLayer,
  renderLayer,
  sliderPreviewData,
  updateLayer,
} from "@/lib/layer-service";
import {
  aggregateSliderPreview,
  filterSliderPreview,
  passesSliderFilters,
  type SliderPreviewData,
  type SliderPreviewResult,
} from "@/lib/slider-preview";
import type { AggregatedViz, LayerFilter } from "@/lib/viz";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const source = path.join(dir, "preview.csv");
  await writeFile(
    source,
    [
      "name,category,seen,lon,lat,riders",
      "a,u,2021-03-01 08:00:00,13.41,52.52,900",
      "b,s,2021-03-02 09:00:00,13.40,52.51,700",
      "c,u,2021-03-03 10:00:00,13.33,52.50,500",
      "d,s,2021-03-04 11:00:00,13.36,52.48,120",
    ].join("\n"),
  );
  await ingestFile(testAccountScope(), source, "preview.csv");
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_SLIDER_PREVIEW_ROWS;
  await rm(dir, { recursive: true, force: true });
});

async function previewLayer() {
  const map = createMap(testAccountScope(), "preview");
  const layer = await createLayer(testAccountScope(), map.id, {
    name: "Preview",
    sql: "SELECT name, category, seen, riders, geometry FROM preview",
  }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  return updateLayer(testAccountScope(), layer.id, {
    viz: {
      type: "grid",
      cellKm: 5,
      aggregate: { fn: "avg", attribute: "riders" },
    },
    filters: [
      { field: "category", kind: "values", values: ["u"] },
      { field: "riders", kind: "range", min: 800, max: null },
      {
        field: "seen",
        kind: "timerange",
        min: "2021-03-01",
        max: "2021-03-02",
      },
    ],
  }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
}

describe("responsive slider preview input", () => {
  it("applies discrete filters but keeps range/time rows for widening", async () => {
    const layer = await previewLayer();
    const result = await sliderPreviewData(testAccountScope(), layer);
    expect(result).toMatchObject({
      exact: true,
      sourceCount: 2,
      sampledCount: 2,
      fields: [
        { name: "seen", kind: "time" },
        { name: "riders", kind: "numeric" },
      ],
    });
    const features = (result.geojson as {
      features: { properties: Record<string, unknown> }[];
    }).features;
    expect(features.map((feature) => feature.properties.riders).sort()).toEqual([
      500, 900,
    ]);
    expect(Object.keys(features[0].properties).sort()).toEqual([
      "riders",
      "seen",
    ]);
    expect(readLayer(testAccountScope(), layer.id)).toEqual(layer);
  });

  it("returns the same bounded subset and reports its source size", async () => {
    const layer = await previewLayer();
    await updateLayer(testAccountScope(), layer.id, { filters: [] }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    process.env.DEZFIL_SLIDER_PREVIEW_ROWS = "2";
    const first = await sliderPreviewData(testAccountScope(), requireLayer(testAccountScope(), layer.id));
    const second = await sliderPreviewData(testAccountScope(), requireLayer(testAccountScope(), layer.id));
    expect(first).toMatchObject({
      exact: false,
      sourceCount: 4,
      sampledCount: 2,
      budget: 2,
    });
    expect(second.geojson).toEqual(first.geojson);
  });

  it("matches DuckDB cells and values for filtered grid and H3 previews", async () => {
    let layer = await previewLayer();
    for (const type of ["grid", "hexbin"] as const) {
      layer = await updateLayer(testAccountScope(), layer.id, {
        viz:
          type === "grid"
            ? {
                type,
                cellKm: 5,
                aggregate: { fn: "avg", attribute: "riders" },
              }
            : {
                type,
                cellKm: 1.22,
                aggregate: { fn: "avg", attribute: "riders" },
              },
      }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
      const source = await sliderPreviewData(testAccountScope(), layer);
      const local = aggregateSliderPreview(
        source,
        layer.viz as AggregatedViz,
        layer.filters,
      );
      const server = await renderLayer(testAccountScope(), layer, undefined, { tileAccess: privateTileAccess(testAccountScope(), (layer).id) });
      expect(canonical(local)).toEqual(canonical({ geojson: server.geojson }));
    }
  });

  it("matches all aggregate functions and preserves SQL NULL filter rules", async () => {
    let layer = await previewLayer();
    layer = await updateLayer(testAccountScope(), layer.id, { filters: [] }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    const aggregates: AggregatedViz["aggregate"][] = [
      { fn: "count" },
      { fn: "sum", attribute: "riders" },
      { fn: "avg", attribute: "riders" },
      { fn: "min", attribute: "riders" },
      { fn: "max", attribute: "riders" },
    ];
    for (const aggregate of aggregates) {
      layer = await updateLayer(testAccountScope(), layer.id, {
        viz: { type: "grid", cellKm: 1000, aggregate },
      }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
      const local = aggregateSliderPreview(
        await sliderPreviewData(testAccountScope(), layer),
        layer.viz as AggregatedViz,
        layer.filters,
      );
      const server = await renderLayer(testAccountScope(), layer, undefined, { tileAccess: privateTileAccess(testAccountScope(), (layer).id) });
      expect(canonical(local)).toEqual(canonical({ geojson: server.geojson }));
    }

    const open: LayerFilter[] = [
      { field: "riders", kind: "range", min: null, max: null },
    ];
    const bounded: LayerFilter[] = [
      { field: "riders", kind: "range", min: 0, max: null },
    ];
    expect(passesSliderFilters({ riders: null }, open)).toBe(true);
    expect(passesSliderFilters({ riders: null }, bounded)).toBe(false);
  });

  it("marks bounded work approximate and scales count and sum magnitudes", () => {
    const source: SliderPreviewData = {
      layerId: "bounded",
      exact: false,
      sourceCount: 4,
      sampledCount: 2,
      budget: 2,
      fields: [{ name: "value", kind: "numeric" }],
      geojson: {
        type: "FeatureCollection",
        features: [1, 3].map((value) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [13.4, 52.5] },
          properties: { value },
        })),
      },
    };
    const count = aggregateSliderPreview(
      source,
      { type: "grid", cellKm: 1000, aggregate: { fn: "count" } },
      [],
    );
    expect(count.approximate).toBe(true);
    expect(count.geojson.features[0].properties).toMatchObject({
      value: 4,
      count: 4,
    });
    const sum = aggregateSliderPreview(
      source,
      {
        type: "grid",
        cellKm: 1000,
        aggregate: { fn: "sum", attribute: "value" },
      },
      [],
    );
    expect(sum.geojson.features[0].properties).toMatchObject({
      value: 8,
      count: 4,
    });
  });

  it("re-aggregates the reserved elevation value for extruded cells", async () => {
    let layer = await previewLayer();
    layer = await updateLayer(testAccountScope(), layer.id, {
      filters: [],
      viz: {
        type: "grid",
        cellKm: 1000,
        aggregate: { fn: "count" },
        elevation: {
          aggregate: { fn: "avg", attribute: "riders" },
          height: 3000,
        },
      },
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    const source = await sliderPreviewData(testAccountScope(), layer);
    const local = aggregateSliderPreview(
      source,
      layer.viz as AggregatedViz,
      layer.filters,
    );
    const server = await renderLayer(testAccountScope(), layer, undefined, { tileAccess: privateTileAccess(testAccountScope(), (layer).id) });
    const elevOf = (result: { geojson: unknown }) =>
      (result.geojson as SliderPreviewResult["geojson"]).features.map(
        (feature) => feature.properties.elev,
      );
    expect(canonical(local)).toEqual(canonical({ geojson: server.geojson }));
    expect(elevOf(local).sort()).toEqual(elevOf({ geojson: server.geojson }).sort());
    expect(elevOf(local).every((v) => typeof v === "number")).toBe(true);
  });

  it("keeps original geometry for non-aggregated filter fallbacks", async () => {
    const map = createMap(testAccountScope(), "line preview");
    let layer = await createLayer(testAccountScope(), map.id, {
      name: "Lines",
      sql: `SELECT riders,
              ST_GeomFromText('LINESTRING (13.4 52.5, 13.5 52.6)') AS geometry
            FROM preview`,
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    layer = await updateLayer(testAccountScope(), layer.id, {
      filters: [
        { field: "riders", kind: "range", min: 600, max: null },
      ],
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    const source = await sliderPreviewData(testAccountScope(), layer);
    const result = filterSliderPreview(source, layer.filters);
    expect(source.sourceCount).toBe(4);
    expect(result.geojson.features).toHaveLength(2);
    expect(result.geojson.features[0].geometry.type).toBe("LineString");
  });
});

function canonical(input: { geojson: unknown }): unknown[] {
  const geojson = input.geojson as SliderPreviewResult["geojson"];
  return geojson.features
    .map((feature) => {
      const ring = (feature.geometry.coordinates as [number, number][][])[0];
      const vertices = ring
        .slice(0, -1)
        .map(([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`)
        .sort();
      return {
        vertices,
        value: feature.properties.value,
        count: feature.properties.count,
      };
    })
    .sort((a, b) => JSON.stringify(a.vertices).localeCompare(JSON.stringify(b.vertices)));
}
