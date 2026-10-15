import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { getLayer as readEditLayer } from "@/lib/metadata/maps";
import { privateTileAccess } from "@/lib/tiles/access";
import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { exportTable, inspectTable, removeTable } from "@/lib/table-service";
import { getTableByName, updateTableGeometryType } from "@/lib/metadata/tables";
import {
  createMap,
  mapWithLayers,
  updateMap,
  removeMap,
  allMaps,
  mapsOverview,
  duplicateMap,
} from "@/lib/map-service";
import { publishMap } from "@/lib/publish/publish-service";
import { listTablesWithSize } from "@/lib/table-service";
import {
  createLayer,
  duplicateLayer,
  updateLayer,
  renderLayer,
  requireLayer,
} from "@/lib/layer-service";
import { getLayer } from "@/lib/metadata/maps";
import { layerCycleColor } from "@/lib/style/palettes";
import { PATCH as patchLayerRoute } from "@/app/api/layers/[id]/route";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "stations.csv");
  await writeFile(
    src,
    "name,lon,lat,riders\na,13.4,52.5,100\nb,13.3,52.4,500\nc,13.2,52.6,900\n",
  );
  await ingestFile(testAccountScope(), src, "stations.csv");
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("maps", () => {
  it("creates, lists, reads, renames, and deletes", async () => {
    const map = createMap(testAccountScope(), "Transit");
    expect(allMaps(testAccountScope()).map((m) => m.id)).toContain(map.id);
    expect(mapWithLayers(testAccountScope(), map.id).name).toBe("Transit");
    updateMap(testAccountScope(), map.id, { name: "Transit v2" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    expect(mapWithLayers(testAccountScope(), map.id).name).toBe("Transit v2");
    await removeMap(testAccountScope(), map.id, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    expect(allMaps(testAccountScope())).toEqual([]);
  });

  it("lists overviews with layer count and colors", async () => {
    const map = createMap(testAccountScope(), "Overview");
    await createLayer(testAccountScope(), map.id, {
      name: "Stations",
      sql: "SELECT * FROM stations",
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    const overview = (await mapsOverview(testAccountScope())).find((m) => m.id === map.id);
    expect(overview?.layerCount).toBe(1);
    expect(overview?.layerColors).toHaveLength(1);
    expect(overview?.layerColors[0]).toMatch(/^rgba\(/);
  });

  it("duplicates a map as an unpublished draft with copied layers", async () => {
    const map = createMap(testAccountScope(), "Original");
    updateMap(testAccountScope(), map.id, {
      viewport: {
        lng: 13.4,
        lat: 52.5,
        zoom: 9,
        pitch: 0,
        bearing: 0,
      },
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "Stations",
      sql: "SELECT * FROM stations",
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    publishMap(testAccountScope(), map.id, {}, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });

    // The custom icon markup rides the copied viz whole.
    await updateLayer(testAccountScope(), layer.id, {
      viz: {
        type: "icon",
        glyph: "marker",
        customSvg:
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><path d="M0 0h4"/></svg>',
      },
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });

    const copy = duplicateMap(testAccountScope(), map.id);
    expect(copy.name).toBe("Original copy");
    expect(copy.publishToken).toBeNull();
    expect(
      (copy.layers[0].viz as { customSvg?: string }).customSvg,
    ).toContain("M0 0h4");
    expect(copy.viewport).toEqual({
      lng: 13.4,
      lat: 52.5,
      zoom: 9,
      pitch: 0,
      bearing: 0,
    });
    expect(copy.layers).toHaveLength(1);
    expect(copy.layers[0].sql).toBe("SELECT * FROM stations");
    expect(copy.layers[0].id).not.toBe(layer.id);
    // The original keeps its publish state and layers.
    expect(mapWithLayers(testAccountScope(), map.id).publishToken).not.toBeNull();
    expect(mapWithLayers(testAccountScope(), map.id).layers).toHaveLength(1);
  });

  it("lists tables with their size on disk", async () => {
    const listing = await listTablesWithSize(testAccountScope());
    const stations = listing.find((t) => t.name === "stations");
    expect(stations?.sizeBytes).toBeGreaterThan(0);
  });

  it("persists viewport round-trips, camera included", () => {
    const map = createMap(testAccountScope(), "m");
    updateMap(testAccountScope(), map.id, {
      viewport: { lng: 13.4, lat: 52.5, zoom: 11, pitch: 45, bearing: -15 },
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    expect(mapWithLayers(testAccountScope(), map.id).viewport).toEqual({
      lng: 13.4,
      lat: 52.5,
      zoom: 11,
      pitch: 45,
      bearing: -15,
    });
  });

  it("persists the basemap choice; null means deployment default", () => {
    const map = createMap(testAccountScope(), "m");
    expect(mapWithLayers(testAccountScope(), map.id).basemap).toBeNull();
    updateMap(testAccountScope(), map.id, { basemap: "light" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    expect(mapWithLayers(testAccountScope(), map.id).basemap).toBe("light");
    updateMap(testAccountScope(), map.id, { basemap: null }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    expect(mapWithLayers(testAccountScope(), map.id).basemap).toBeNull();
  });
});

describe("layers as source of truth", () => {
  it("creates a layer from a spatial result with a default style", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "stations",
      sql: "SELECT * FROM stations",
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    expect(layer.style.fill.type).toBe("constant");
    expect(layer.visible).toBe(true);
    expect(layer.tooltip).toBeNull();
    expect(layer.inLegend).toBe(true);
    expect(requireLayer(testAccountScope(), layer.id).sql).toBe("SELECT * FROM stations");
  });

  it("cycles default layer colors by creation order (kepler cycle)", async () => {
    const map = createMap(testAccountScope(), "m");
    const sql = "SELECT * FROM stations";
    const first = await createLayer(testAccountScope(), map.id, { name: "a", sql }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    const second = await createLayer(testAccountScope(), map.id, { name: "b", sql }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    const fill = (l: typeof first) =>
      l.style.fill.type === "constant" ? l.style.fill.color : null;
    expect(fill(first)).toMatchObject(
      (({ r, g, b }) => ({ r, g, b }))(layerCycleColor(0)),
    );
    expect(fill(second)).toMatchObject(
      (({ r, g, b }) => ({ r, g, b }))(layerCycleColor(1)),
    );
  });

  it("round-trips tooltip fields and legend inclusion", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "stations",
      sql: "SELECT * FROM stations",
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    await updateLayer(testAccountScope(), layer.id, {
      tooltip: ["name", "riders"],
      inLegend: false,
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    const read = requireLayer(testAccountScope(), layer.id);
    expect(read.tooltip).toEqual(["name", "riders"]);
    expect(read.inLegend).toBe(false);
    await updateLayer(testAccountScope(), layer.id, { tooltip: null }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    expect(requireLayer(testAccountScope(), layer.id).tooltip).toBeNull();
  });

  it("round-trips the published-field list; [] and null differ", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "stations",
      sql: "SELECT * FROM stations",
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    expect(layer.publishedFields).toBeNull();

    const set = await updateLayer(testAccountScope(), layer.id, {
      publishedFields: ["riders", "name"],
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    expect(set.publishedFields).toEqual(["riders", "name"]);
    expect(getLayer(layer.id)?.publishedFields).toEqual(["riders", "name"]);

    // The empty list is a real override — the functional core only —
    // distinct from null, which restores the derived projection.
    await updateLayer(testAccountScope(), layer.id, { publishedFields: [] }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    expect(getLayer(layer.id)?.publishedFields).toEqual([]);
    await updateLayer(testAccountScope(), layer.id, { publishedFields: null }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    expect(getLayer(layer.id)?.publishedFields).toBeNull();
  });

  it("published-field list rides the headless PATCH lane", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "stations",
      sql: "SELECT * FROM stations",
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    const patch = (body: unknown, basis: string) =>
      patchLayerRoute(
        testAccountRequest(new Request(`http://localhost/api/layers/${layer.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", "X-Edit-Revision": basis },
          body: JSON.stringify(body),
        })),
        { params: Promise.resolve({ id: layer.id }) },
      );

    const ok = await patch({ publishedFields: ["riders"] }, readEditRevision({ kind: "map", id: map.id })!.editRevision!);
    expect(ok.status).toBe(200);
    expect((await ok.json()).publishedFields).toEqual(["riders"]);
    expect(getLayer(layer.id)?.publishedFields).toEqual(["riders"]);

    const bad = await patch({ publishedFields: [1] }, readEditRevision({ kind: "map", id: map.id })!.editRevision!);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("invalid_request");
    expect(getLayer(layer.id)?.publishedFields).toEqual(["riders"]);
  });

  it("duplicates a layer as a full copy, suffixed, stacked on top", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "stations",
      sql: "SELECT * FROM stations",
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    await updateLayer(testAccountScope(), layer.id, { tooltip: ["name"], inLegend: false }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    await updateLayer(testAccountScope(), layer.id, { publishedFields: ["riders"] }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    await updateLayer(testAccountScope(), layer.id, {
      viz: {
        type: "icon",
        glyph: "cafe",
        customSvg:
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><path d="M0 0h4"/></svg>',
      },
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    const copy = duplicateLayer(testAccountScope(), layer.id, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    expect(copy.id).not.toBe(layer.id);
    expect(copy.name).toBe("stations copy");
    expect(copy.sql).toBe(layer.sql);
    expect(copy.tooltip).toEqual(["name"]);
    // The custom icon markup rides the copied viz.
    expect((copy.viz as { customSvg?: string }).customSvg).toContain(
      "M0 0h4",
    );
    expect(copy.publishedFields).toEqual(["riders"]);
    expect(copy.inLegend).toBe(false);
    expect(copy.ordinal).toBeGreaterThan(layer.ordinal);
    expect(mapWithLayers(testAccountScope(), map.id).layers).toHaveLength(2);
  });

  it("rejects zero-geometry results; multiple geometries render the first", async () => {
    const map = createMap(testAccountScope(), "m");
    await expect(
      createLayer(testAccountScope(), map.id, { name: "x", sql: "SELECT name FROM stations" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    // O→D results carry two geometry columns: allowed, the first is the
    // layer's primary geometry, the rest stay out of props.
    const twin = await createLayer(testAccountScope(), map.id, {
      name: "twin",
      sql: "SELECT geometry, ST_Centroid(geometry) AS g2, name FROM stations",
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    const render = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), twin.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), twin.id)).id) });
    expect(render.ok).toBe(true);
    expect(render.featureCount).toBe(3);
    const feature = (
      render.geojson as {
        features: { properties: Record<string, unknown> }[];
      }
    ).features[0];
    expect(feature.properties.name).toBeDefined();
    expect(feature.properties.g2).toBeUndefined();
  });

  it("editing SQL changes what renders without recreating the layer", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "all",
      sql: "SELECT * FROM stations",
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    const before = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), layer.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layer.id)).id) });
    expect(before.featureCount).toBe(3);

    await updateLayer(testAccountScope(), layer.id, {
      sql: "SELECT * FROM stations WHERE riders > 400",
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    // same layer id, same created_at
    expect(getLayer(layer.id)!.createdAt).toBe(layer.createdAt);
    const after = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), layer.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layer.id)).id) });
    expect(after.featureCount).toBe(2);
    expect(requireLayer(testAccountScope(), layer.id).sql).toBe(
      "SELECT * FROM stations WHERE riders > 400",
    );
  });

  it("renders a zero-row query as a valid empty layer", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "none",
      sql: "SELECT * FROM stations WHERE riders > 100000",
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    const render = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), layer.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layer.id)).id) });
    expect(render.ok).toBe(true);
    expect(render.featureCount).toBe(0);
  });

  it("produces GeoJSON features with non-geometry columns as properties", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "s",
      sql: "SELECT name, riders, geometry FROM stations ORDER BY riders",
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    const render = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), layer.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layer.id)).id) });
    const fc = render.geojson as {
      features: { geometry: unknown; properties: Record<string, unknown> }[];
    };
    expect(fc.features).toHaveLength(3);
    expect(fc.features[0].properties).toMatchObject({ name: "a", riders: 100 });
    expect(fc.features[0].geometry).toMatchObject({ type: "Point" });
    // Points carry no label anchor — they anchor on themselves.
    expect(fc.features[0].properties.__anchor).toBeUndefined();
  });

  it("non-point features carry an interior label anchor", async () => {
    const map = createMap(testAccountScope(), "m");
    // An L-shape: the bounding-box center (2, 2) lies OUTSIDE the polygon,
    // so a naive centroid would anchor the label off the feature.
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "L",
      sql: `SELECT 'L' AS name, ST_GeomFromText(
              'POLYGON((0 0, 4 0, 4 1, 1 1, 1 4, 0 4, 0 0))') AS geometry`,
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    const render = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), layer.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layer.id)).id) });
    const fc = render.geojson as {
      features: { properties: Record<string, unknown> }[];
    };
    const anchor = fc.features[0].properties.__anchor as [number, number];
    expect(anchor).toHaveLength(2);
    const [x, y] = anchor;
    // Inside the L means inside its arms, never the notch around (2, 2).
    expect(x >= 0 && x <= 4 && y >= 0 && y <= 4).toBe(true);
    expect(x <= 1 || y <= 1).toBe(true);
  });
});

describe("deleted table leaves an errored layer", () => {
  it("keeps the layer but renders an error while other layers work", async () => {
    const map = createMap(testAccountScope(), "m");
    const dependent = await createLayer(testAccountScope(), map.id, {
      name: "dependent",
      sql: "SELECT * FROM stations",
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    const independent = await createLayer(testAccountScope(), map.id, {
      name: "independent",
      sql: "SELECT ST_Point(0, 0) AS geometry",
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });

    await removeTable(testAccountScope(), "stations");

    // The layer still exists (spec: deleting a table does not delete layers).
    expect(getLayer(dependent.id)).not.toBeNull();
    const broken = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), dependent.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), dependent.id)).id) });
    expect(broken.ok).toBe(false);
    expect(broken.error?.message).toBe("The query refers to an unknown table.");
    // the layer lane answers unknown-table for a deleted name — the same
    // kind of error a never-imported name gets, no artifact paths.
    expect(broken.error?.code).toBe("sql_error");
    expect(broken.error?.message).not.toMatch(/parquet|tables\//i);

    const working = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), independent.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), independent.id)).id) });
    expect(working.ok).toBe(true);
    expect(working.featureCount).toBe(1);
  });
});

describe("legend attribute overrides", () => {
  const ramp = (attribute: string) => ({
    fill: {
      type: "quantile" as const,
      attribute,
      palette: "teal",
      breaks: [300, 700],
      colors: [
        { r: 1, g: 2, b: 3, a: 1 },
        { r: 4, g: 5, b: 6, a: 1 },
        { r: 7, g: 8, b: 9, a: 1 },
      ],
    },
    fillOpacity: 1,
    stroke: { r: 0, g: 0, b: 0, a: 1 },
    strokeOpacity: 1,
    strokeWidth: 1,
    pointRadius: 5,
    opacity: 1,
  });

  it("persist, round-trip, copy on duplicate, and survive unrelated updates", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "L",
      sql: "SELECT * FROM stations",
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    expect(layer.legendAttrs).toBeNull();
    await updateLayer(testAccountScope(), layer.id, { style: ramp("riders") }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    const withAttrs = await updateLayer(testAccountScope(), layer.id, {
      legendAttrs: { fill: "Riders (daily)" },
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    expect(withAttrs.legendAttrs).toEqual({ fill: "Riders (daily)" });
    const renamed = await updateLayer(testAccountScope(), layer.id, { name: "L2" }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    expect(renamed.legendAttrs).toEqual({ fill: "Riders (daily)" });
    const copy = duplicateLayer(testAccountScope(), layer.id, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    expect(copy.legendAttrs).toEqual({ fill: "Riders (daily)" });
  });

  it("a channel's override drops when its driving attribute changes", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "L",
      sql: "SELECT * FROM stations",
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    await updateLayer(testAccountScope(), layer.id, { style: ramp("riders") }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    await updateLayer(testAccountScope(), layer.id, { legendAttrs: { fill: "Riders" } }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    // Same attribute, new breaks: the override still names the right variable.
    const rebucketed = await updateLayer(testAccountScope(), layer.id, { style: ramp("riders") }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    expect(rebucketed.legendAttrs).toEqual({ fill: "Riders" });
    // Different attribute: the override would lie — dropped to automatic.
    const switched = await updateLayer(testAccountScope(), layer.id, { style: ramp("lat") }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    expect(switched.legendAttrs).toBeNull();
  });

  it("an attribute name can be hidden — distinct from cleared", async () => {
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, {
      name: "L",
      sql: "SELECT * FROM stations",
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    await updateLayer(testAccountScope(), layer.id, { style: ramp("riders") }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });

    // Hidden is an explicit per-channel state and persists.
    const hidden = await updateLayer(testAccountScope(), layer.id, {
      legendAttrs: { fill: null },
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    expect(hidden.legendAttrs).toEqual({ fill: null });

    // Clearing the whole field returns to automatic — never to hidden.
    const cleared = await updateLayer(testAccountScope(), layer.id, { legendAttrs: null }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    expect(cleared.legendAttrs).toBeNull();

    // A hidden marker drops with its channel like any override.
    await updateLayer(testAccountScope(), layer.id, { legendAttrs: { fill: null } }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    const switched = await updateLayer(testAccountScope(), layer.id, { style: ramp("lat") }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    expect(switched.legendAttrs).toBeNull();
  });
});

describe("stale geometry type heals on inspect", () => {
  it("re-measures a stored MIXED and persists the collapse", async () => {
    updateTableGeometryType(getTableByName("stations")!, "MIXED");
    expect(getTableByName("stations")!.geometryType).toBe("MIXED");
    const inspected = await inspectTable(testAccountScope(), "stations");
    expect(inspected.geometryType).toBe("POINT");
    expect(getTableByName("stations")!.geometryType).toBe("POINT");
  });
});

describe("dataset export", () => {
  it("geoparquet streams the stored artifact itself", async () => {
    const file = await exportTable(testAccountScope(), "stations", "geoparquet");
    expect(file.filename).toBe("stations.parquet");
    const { readFile } = await import("node:fs/promises");
    const stored = getTableByName("stations")!;
    const artifact = path.join(process.env.DEZFIL_DATA_DIR!, stored.file);
    expect(file.path).toBe(artifact);
    expect((await readFile(file.path)).length).toBeGreaterThan(0);
    await file.cleanup();
  });

  it("geojson converts and cleans up after itself", async () => {
    const file = await exportTable(testAccountScope(), "stations", "geojson");
    expect(file.filename).toBe("stations.geojson");
    const { readFile, stat } = await import("node:fs/promises");
    const body = JSON.parse(await readFile(file.path, "utf8")) as {
      type: string;
      features: unknown[];
    };
    expect(body.type).toBe("FeatureCollection");
    expect(body.features).toHaveLength(3);
    await file.cleanup();
    await expect(stat(file.path)).rejects.toThrow();
  });

  it("csv renders geometry as WKT", async () => {
    const file = await exportTable(testAccountScope(), "stations", "csv");
    const { readFile } = await import("node:fs/promises");
    const csv = await readFile(file.path, "utf8");
    expect(csv.split("\n")[0]).toContain("name");
    expect(csv).toContain("POINT (");
    await file.cleanup();
  });

  it("refuses GeoJSON for a non-spatial table, allows CSV", async () => {
    const src = path.join(dir, "plain.csv");
    const { writeFile: write } = await import("node:fs/promises");
    await write(src, "label,value\nx,1\ny,2\n");
    await ingestFile(testAccountScope(), src, "plain.csv");
    await expect(exportTable(testAccountScope(), "plain", "geojson")).rejects.toMatchObject({
      code: "invalid_request",
    });
    const file = await exportTable(testAccountScope(), "plain", "csv");
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(file.path, "utf8")).toContain("label,value");
    await file.cleanup();
  });
});
