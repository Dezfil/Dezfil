import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { createProject, tableProjectIds } from "@/lib/metadata/projects";
import { listTables, getTableByName } from "@/lib/metadata/tables";
import type { Bbox } from "@/lib/bbox";
import {
  parseSelector,
  buildOverpassQl,
  applyEnvelope,
  normalizeQl,
  suggestStem,
  promotedKeys,
} from "./query";
import {
  assembleAndSplit,
  featureWithin,
  filterSplitWithin,
  type ShapedFeature,
} from "./geometry";
import {
  importOsm,
  previewOsm,
  resolveOsmRequest,
  withinShapeOf,
} from "./import";
import { refreshTable } from "@/lib/ingest/refresh";
import { resetRefreshFences } from "@/lib/ingest/fence";
import { resetQueryInstance } from "@/lib/duckdb";
import { boundedEvaluation } from "@/lib/query/bounded";

const BERLIN: Bbox = [13.088, 52.338, 13.761, 52.675];
const ENV = { timeoutS: 60, maxsizeBytes: 512 * 1024 * 1024 };

/* ---------- pure query shaping ---------- */

describe("selectors and QL", () => {
  it("parses key and key=value entries, rejects junk", () => {
    expect(parseSelector("building")).toEqual({ key: "building" });
    expect(parseSelector("amenity=restaurant")).toEqual({
      key: "amenity",
      value: "restaurant",
    });
    expect(parseSelector("amenity=*")).toEqual({ key: "amenity" });
    expect(parseSelector('bad"key=x')).toBeNull();
    expect(parseSelector("")).toBeNull();
  });

  it("compiles the canonical query with Overpass bbox order", () => {
    const ql = buildOverpassQl(
      [{ key: "amenity", value: "restaurant" }, { key: "building" }],
      { bbox: BERLIN },
      ENV,
    );
    expect(ql).toContain("[out:json][timeout:60][maxsize:536870912];");
    expect(ql).toContain(
      `nwr["amenity"="restaurant"](52.338,13.088,52.675,13.761);`,
    );
    expect(ql).toContain(`nwr["building"](52.338,13.088,52.675,13.761);`);
    expect(ql.trim().endsWith("out geom;")).toBe(true);
  });

  it("compiles a drawn ring into an Overpass poly filter", () => {
    const ql = buildOverpassQl(
      [{ key: "building" }],
      {
        ring: [
          [13.2, 52.4],
          [13.6, 52.4],
          [13.4, 52.6],
        ],
      },
      ENV,
    );
    expect(ql).toContain(
      `nwr["building"](poly:"52.400000 13.200000 52.400000 13.600000 52.600000 13.400000");`,
    );
  });

  it("replaces declared settings with the safety envelope", () => {
    const custom = `[out:xml][timeout:900];\nnode["amenity"](50,13,51,14);\nout body;`;
    const bounded = applyEnvelope(custom, ENV, null);
    expect(bounded).toContain("[out:json][timeout:60]");
    expect(bounded).not.toContain("timeout:900");
    expect(bounded).toContain(`node["amenity"](50,13,51,14);`);
  });

  it("substitutes {{bbox}} and refuses other placeholders", () => {
    const withBox = applyEnvelope(
      `nwr["amenity"]({{bbox}}); out geom;`,
      ENV,
      BERLIN,
    );
    expect(withBox).toContain("(52.338,13.088,52.675,13.761)");
    expect(() => applyEnvelope(`nwr["a"]({{bbox}});`, ENV, null)).toThrow(
      /no area/,
    );
    expect(() => applyEnvelope(`nwr["a"]({{center}});`, ENV, BERLIN)).toThrow(
      /placeholders/,
    );
  });

  it("normalizes whitespace for the cache key and derives stems", () => {
    expect(normalizeQl("a\n  b\t c")).toBe("a b c");
    expect(suggestStem([{ key: "amenity", value: "restaurant" }])).toBe(
      "osm_restaurant",
    );
    expect(suggestStem([{ key: "building" }])).toBe("osm_building");
    expect(promotedKeys([{ key: "amenity", value: "restaurant" }])).toEqual([
      "name",
      "amenity",
    ]);
  });
});

/* ---------- geometry assembly ---------- */

const OVERPASS_FIXTURE = {
  version: 0.6,
  elements: [
    {
      type: "node",
      id: 1,
      lat: 52.5,
      lon: 13.4,
      tags: { amenity: "restaurant", name: "Alpha", cuisine: "pizza" },
    },
    {
      type: "way",
      id: 2,
      nodes: [10, 11],
      geometry: [
        { lat: 52.5, lon: 13.4 },
        { lat: 52.51, lon: 13.41 },
      ],
      tags: { highway: "residential", name: "B Street" },
    },
    {
      type: "way",
      id: 3,
      nodes: [20, 21, 22, 20],
      geometry: [
        { lat: 52.5, lon: 13.4 },
        { lat: 52.5, lon: 13.42 },
        { lat: 52.52, lon: 13.42 },
        { lat: 52.5, lon: 13.4 },
      ],
      tags: { building: "yes", amenity: "restaurant", name: "Gamma Hall" },
    },
    {
      type: "relation",
      id: 4,
      tags: { type: "multipolygon", landuse: "forest", name: "Holewood" },
      members: [
        {
          type: "way",
          ref: 30,
          role: "outer",
          geometry: [
            { lat: 52.6, lon: 13.1 },
            { lat: 52.6, lon: 13.3 },
            { lat: 52.7, lon: 13.3 },
            { lat: 52.7, lon: 13.1 },
            { lat: 52.6, lon: 13.1 },
          ],
        },
        {
          type: "way",
          ref: 31,
          role: "inner",
          geometry: [
            { lat: 52.63, lon: 13.15 },
            { lat: 52.63, lon: 13.2 },
            { lat: 52.66, lon: 13.2 },
            { lat: 52.66, lon: 13.15 },
            { lat: 52.63, lon: 13.15 },
          ],
        },
      ],
    },
  ],
};

describe("assembleAndSplit", () => {
  it("splits classes, promotes keys stably, keeps tags as one JSON field", () => {
    const split = assembleAndSplit(OVERPASS_FIXTURE, ["name", "amenity"]);
    expect(split.points).toHaveLength(1);
    expect(split.lines).toHaveLength(1);
    expect(split.polygons).toHaveLength(2); // building way + multipolygon
    expect(split.total).toBe(4);

    const point = split.points[0];
    expect(point.properties.osm_id).toBe("node/1");
    expect(point.properties.name).toBe("Alpha");
    expect(point.properties.amenity).toBe("restaurant");
    const tags = JSON.parse(point.properties.tags!) as Record<string, string>;
    expect(tags.cuisine).toBe("pizza"); // un-promoted, preserved in tags

    // promoted keys are always present, null when absent — stable schema
    const line = split.lines[0];
    expect(line.properties.amenity).toBeNull();
    expect(line.properties.name).toBe("B Street");
  });

  it("assembles multipolygon relations with holes", () => {
    const split = assembleAndSplit(OVERPASS_FIXTURE, ["name"]);
    const forest = split.polygons.find(
      (f) => f.properties.name === "Holewood",
    )!;
    const geometry = forest.geometry as {
      type: string;
      coordinates: number[][][] | number[][][][];
    };
    expect(geometry.type).toMatch(/Polygon/);
    // outer ring + inner hole survive assembly
    const rings =
      geometry.type === "Polygon"
        ? (geometry.coordinates as number[][][])
        : (geometry.coordinates as number[][][][])[0];
    expect(rings).toHaveLength(2);
  });
});

/* ---------- import + refresh against a mock endpoint ---------- */

let dir: string;
let server: Server;
let hits = 0;
let fixture: unknown = OVERPASS_FIXTURE;
let failNext = false;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetRefreshFences();
  resetQueryInstance();
  hits = 0;
  fixture = OVERPASS_FIXTURE;
  failNext = false;

  server = createServer((_req, res) => {
    hits += 1;
    if (failNext) {
      res.writeHead(500);
      res.end("splat");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(fixture));
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  process.env.DEZFIL_OVERPASS_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/interpreter`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_OVERPASS_URL;
  delete process.env.DEZFIL_OSM_MAX_KM2;
  await rm(dir, { recursive: true, force: true });
});

describe("within semantics", () => {
  const feature = (geometry: unknown): ShapedFeature => ({
    type: "Feature",
    properties: {},
    geometry,
  });
  const insidePoint = feature({ type: "Point", coordinates: [13.4, 52.5] });
  const outsidePoint = feature({ type: "Point", coordinates: [14.5, 52.5] });
  const crossingLine = feature({
    type: "LineString",
    coordinates: [
      [13.4, 52.5],
      [14.5, 52.5],
    ],
  });

  it("keeps only features entirely inside a bbox or ring", () => {
    const shape = { bbox: BERLIN } as const;
    expect(featureWithin(insidePoint, shape)).toBe(true);
    expect(featureWithin(outsidePoint, shape)).toBe(false);
    expect(featureWithin(crossingLine, shape)).toBe(false);
    const ring = {
      ring: [
        [13.0, 52.3],
        [13.8, 52.3],
        [13.8, 52.7],
        [13.0, 52.7],
      ] as [number, number][],
    };
    expect(featureWithin(insidePoint, ring)).toBe(true);
    expect(featureWithin(outsidePoint, ring)).toBe(false);
  });

  it("filters a split result and recounts", () => {
    const split = {
      points: [insidePoint, outsidePoint],
      lines: [crossingLine],
      polygons: [],
      total: 3,
    };
    const filtered = filterSplitWithin(split, { bbox: BERLIN });
    expect(filtered.points).toHaveLength(1);
    expect(filtered.lines).toHaveLength(0);
    expect(filtered.total).toBe(1);
  });

  it("resolves ring areas into poly queries with budgets and semantics", () => {
    const ring: [number, number][] = [
      [13.2, 52.4],
      [13.6, 52.4],
      [13.4, 52.6],
    ];
    const resolved = resolveOsmRequest({
      selectors: ["building"],
      ring,
      semantics: "within",
    });
    expect(resolved.finalQl).toContain("poly:");
    expect(resolved.semantics).toBe("within");
    expect(withinShapeOf(resolved)).toEqual({ ring });
    // Default is intersect — no post-filter shape.
    const intersecting = resolveOsmRequest({
      selectors: ["building"],
      ring,
    });
    expect(intersecting.semantics).toBe("intersect");
    expect(withinShapeOf(intersecting)).toBeNull();
    expect(() =>
      resolveOsmRequest({ selectors: ["building"], ring, semantics: "near" }),
    ).toThrow(/within.*intersect/);
  });
});

describe("feature-geometry areas", () => {
  const twoParts = {
    type: "MultiPolygon",
    coordinates: [
      [
        [
          [13.2, 52.4],
          [13.3, 52.4],
          [13.3, 52.5],
          [13.2, 52.5],
          [13.2, 52.4],
        ],
      ],
      [
        [
          [13.5, 52.4],
          [13.6, 52.4],
          [13.6, 52.5],
          [13.5, 52.5],
          [13.5, 52.4],
        ],
      ],
    ],
  };
  const withHole = {
    type: "Polygon",
    coordinates: [
      [
        [13.0, 52.0],
        [14.0, 52.0],
        [14.0, 53.0],
        [13.0, 53.0],
        [13.0, 52.0],
      ],
      [
        [13.4, 52.4],
        [13.6, 52.4],
        [13.6, 52.6],
        [13.4, 52.6],
        [13.4, 52.4],
      ],
    ],
  };

  it("compiles one poly filter per outer ring, closing duplicate dropped", () => {
    const ql = buildOverpassQl(
      [{ key: "building" }],
      { geometry: twoParts as never },
      ENV,
    );
    const polys = ql.match(/poly:"/g) ?? [];
    expect(polys).toHaveLength(2);
    expect(ql).toContain(
      `poly:"52.400000 13.200000 52.400000 13.300000 52.500000 13.300000 52.500000 13.200000"`,
    );
  });

  it("the within filter honors parts and holes", () => {
    const point = (lng: number, lat: number): ShapedFeature => ({
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [lng, lat] },
    });
    const resolved = resolveOsmRequest({
      selectors: ["building"],
      geometry: withHole,
      semantics: "within",
    });
    const shape = withinShapeOf(resolved)!;
    expect(featureWithin(point(13.2, 52.2), shape)).toBe(true);
    expect(featureWithin(point(13.5, 52.5), shape)).toBe(false);
    expect(featureWithin(point(14.5, 52.5), shape)).toBe(false);
    const parts = withinShapeOf(
      resolveOsmRequest({
        selectors: ["building"],
        geometry: twoParts,
        semantics: "within",
      }),
    )!;
    expect(featureWithin(point(13.25, 52.45), parts)).toBe(true);
    expect(featureWithin(point(13.55, 52.45), parts)).toBe(true);
    expect(featureWithin(point(13.4, 52.45), parts)).toBe(false);
  });

  it("rejects malformed geometries and stores the shape in provenance form", () => {
    expect(() =>
      resolveOsmRequest({
        selectors: ["building"],
        geometry: { type: "Point", coordinates: [13, 52] },
      }),
    ).toThrow(/Polygon or MultiPolygon/);
    const resolved = resolveOsmRequest({
      selectors: ["building"],
      geometry: withHole,
    });
    expect(resolved.geometry).toEqual(withHole);
    expect(resolved.semantics).toBe("intersect");
  });
});

describe("importOsm", () => {
  it("lands split tables sharing a stem and one group", async () => {
    const tables = await importOsm(testAccountScope(), {
      selectors: ["amenity=restaurant", "building", "highway", "landuse"],
      bbox: BERLIN,
      name: "osm_mix",
    });
    expect(tables.map((t) => t.name).sort()).toEqual([
      "osm_mix_lines",
      "osm_mix_points",
      "osm_mix_polygons",
    ]);
    const groups = new Set(tables.map((t) => t.sourceParams?.group));
    expect(groups.size).toBe(1);
    expect(tables.every((t) => t.source === "osm")).toBe(true);
    const points = tables.find((t) => t.name === "osm_mix_points")!;
    expect(points.rowCount).toBe(1);
    expect(points.geometryColumn).toBe("geom");
    const polys = tables.find((t) => t.name === "osm_mix_polygons")!;
    expect(polys.rowCount).toBe(2);
  });

  it("serves an identical re-import from the cache", async () => {
    await importOsm(testAccountScope(), { selectors: ["building"], bbox: BERLIN, name: "c1" });
    const before = hits;
    await importOsm(testAccountScope(), { selectors: ["building"], bbox: BERLIN, name: "c2" });
    expect(hits).toBe(before); // no second endpoint hit
  });

  it("lands overlapping imports with distinct names, never a 500", async () => {
    // Two concurrent imports deriving the same names: the artifact build
    // between derivation and registration used to make the second one
    // trip the UNIQUE constraint. Registration now derives at insert time.
    const [first, second] = await Promise.all([
      importOsm(testAccountScope(), { selectors: ["building"], bbox: BERLIN, name: "race" }),
      importOsm(testAccountScope(), { selectors: ["building"], bbox: BERLIN, name: "race" }),
    ]);
    const names = [...first, ...second].map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // all distinct
    expect(names.length).toBeGreaterThan(0);
  });

  it("refuses empty results, oversized areas, and junk", async () => {
    fixture = { version: 0.6, elements: [] };
    await expect(
      importOsm(testAccountScope(), { selectors: ["aeroway=spaceport"], bbox: BERLIN }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(listTables()).toEqual([]);

    process.env.DEZFIL_OSM_MAX_KM2 = "100";
    expect(() =>
      resolveOsmRequest({ selectors: ["building"], bbox: BERLIN }),
    ).toThrow(/allow up to/);
    delete process.env.DEZFIL_OSM_MAX_KM2;

    expect(() => resolveOsmRequest({})).toThrow(/selectors/);
    expect(() => resolveOsmRequest({ selectors: ["building"] })).toThrow(
      /area/,
    );
  });

  it("maps endpoint failures specifically and registers nothing", async () => {
    failNext = true;
    await expect(
      importOsm(testAccountScope(), { selectors: ["building"], bbox: BERLIN }),
    ).rejects.toMatchObject({ code: "remote_fetch_failed" });
    expect(listTables()).toEqual([]);
  });
});

describe("previewOsm — Run Query", () => {
  it("returns the import's features and a later import reuses the cache", async () => {
    const preview = await previewOsm({
      selectors: ["building"],
      bbox: BERLIN,
    });
    expect(preview.featureCount).toBeGreaterThan(0);
    expect(preview.truncated).toBe(false);
    expect(preview.geojson.features).toHaveLength(preview.featureCount);
    expect(hits).toBe(1);
    const tables = await importOsm(testAccountScope(), { selectors: ["building"], bbox: BERLIN });
    expect(tables.length).toBeGreaterThan(0);
    // The preview's fetch serves the import — one endpoint hit total.
    expect(hits).toBe(1);
  });

  it("applies the within filter exactly like the import", async () => {
    const everything = await previewOsm({
      selectors: ["building"],
      bbox: BERLIN,
    });
    const tightRing: [number, number][] = [
      [13.39, 52.51],
      [13.42, 52.51],
      [13.42, 52.53],
      [13.39, 52.53],
    ];
    const filtered = await previewOsm({
      selectors: ["building"],
      ring: tightRing,
      semantics: "within",
    });
    expect(filtered.featureCount).toBeLessThan(everything.featureCount);
  });
});

describe("refreshTable for OSM groups", () => {
  it("re-runs once, bypasses the cache, updates every member", async () => {
    const tables = await importOsm(testAccountScope(), {
      selectors: ["amenity=restaurant", "highway"],
      bbox: BERLIN,
      name: "grp",
    });
    expect(tables.map((t) => t.name).sort()).toEqual([
      "grp_lines",
      "grp_points",
      "grp_polygons",
    ]);

    // The source changes: the restaurant node disappears; a second street
    // appears. The refresh must reflect both, across members, in one go.
    fixture = {
      version: 0.6,
      elements: [
        OVERPASS_FIXTURE.elements[1],
        { ...OVERPASS_FIXTURE.elements[1], id: 5 },
        OVERPASS_FIXTURE.elements[2],
        OVERPASS_FIXTURE.elements[3],
      ],
    };
    // Bind every member by evaluating it before the swap: the dangerous
    // transition is a bound group whose artifacts all change in one
    // transaction.
    const evalCount = (name: string) =>
      boundedEvaluation(async (conn) => {
        const reader = await conn.runAndReadAll(
          `SELECT count(*) AS n FROM "${name}"`,
        );
        return Number((reader.getRowObjectsJson()[0] as { n: unknown }).n);
      });
    expect(await evalCount("grp_points")).toBe(1);
    expect(await evalCount("grp_lines")).toBe(1);

    const hitsBefore = hits;
    await refreshTable(testAccountScope(), "grp_points");
    expect(hits).toBe(hitsBefore + 1); // one fetch, cache bypassed

    expect(getTableByName("grp_points")?.rowCount).toBe(0); // vanished → empty
    expect(getTableByName("grp_lines")?.rowCount).toBe(2);
    expect(getTableByName("grp_polygons")?.rowCount).toBe(2);

    // And the first evaluation after the swap answers every member from
    // its new artifact (the OSM group implementation) — including the
    // member the refresh was NOT entered through.
    expect(await evalCount("grp_points")).toBe(0);
    expect(await evalCount("grp_lines")).toBe(2);
    expect(await evalCount("grp_polygons")).toBe(2);
  });

  it("fences the whole group as one unit: members contend, not just names", async () => {
    await importOsm(testAccountScope(), {
      selectors: ["amenity=restaurant", "highway"],
      bbox: BERLIN,
      name: "unit",
    });
    // A refresh entered through one member holds the group; a second entered
    // through a *different* member conflicts — the unit is the group.
    const first = refreshTable(testAccountScope(), "unit_points");
    await expect(refreshTable(testAccountScope(), "unit_lines")).rejects.toMatchObject({
      code: "refresh_in_flight",
      status: 409,
    });
    await first;
    // Settled: any member may refresh again.
    await expect(refreshTable(testAccountScope(), "unit_lines")).resolves.toBeTruthy();
  });

  it("cleans every candidate when a member build dies mid-group", async () => {
    await importOsm(testAccountScope(), {
      selectors: ["amenity=restaurant", "highway"],
      bbox: BERLIN,
      name: "hardy",
    });
    const before = getTableByName("hardy_points")!;
    const tablesDir = path.join(process.env.DEZFIL_DATA_DIR!, "tables");
    // Injection: the artifact directory refuses writes, so the first
    // member's candidate build fails at the build stage — after the fetch,
    // unlike the endpoint-down case.
    await chmod(tablesDir, 0o555);
    try {
      await expect(refreshTable(testAccountScope(), "hardy_points")).rejects.toThrow();
    } finally {
      await chmod(tablesDir, 0o755);
    }
    // The group is untouched and the directory holds exactly the
    // registered artifacts — no candidate survived the failure.
    const after = getTableByName("hardy_points")!;
    expect(after.file).toBe(before.file);
    expect(after.rowCount).toBe(before.rowCount);
    const files = await readdir(tablesDir);
    const registered = listTables().map((t) => path.basename(t.file));
    expect(files.sort()).toEqual(registered.sort());
  });

  it("leaves the whole group intact when the endpoint is down — and no candidate files", async () => {
    await importOsm(testAccountScope(), {
      selectors: ["amenity=restaurant", "highway"],
      bbox: BERLIN,
      name: "safe",
    });
    const before = getTableByName("safe_points")!;
    failNext = true;
    await expect(refreshTable(testAccountScope(), "safe_points")).rejects.toMatchObject({
      code: "remote_fetch_failed",
    });
    const after = getTableByName("safe_points")!;
    expect(after.file).toBe(before.file);
    expect(after.rowCount).toBe(before.rowCount);
    // The artifact directory holds exactly the registered artifacts — the
    // failed group refresh stranded nothing.
    const files = await readdir(
      path.join(process.env.DEZFIL_DATA_DIR!, "tables"),
    );
    const registered = listTables().map((t) => path.basename(t.file));
    expect(files.sort()).toEqual(registered.sort());
  });
});

describe("the project context", () => {
  it("files every created class table in the same act", async () => {
    const p = createProject(testAccountScope(), { name: "A" });
    const tables = await importOsm(testAccountScope(), {
      selectors: ["amenity=restaurant", "highway"],
      bbox: BERLIN,
      name: "filed",
      projectId: p.id,
    });
    expect(tables.length).toBeGreaterThan(1);
    const memberships = tableProjectIds();
    for (const t of tables) expect(memberships.get(t.id)).toEqual([p.id]);

    // A refresh rewrites the data under the same identity, so the
    // membership survives untouched.
    await refreshTable(testAccountScope(), tables[0].name);
    expect(tableProjectIds().get(tables[0].id)).toEqual([p.id]);
  });

  it("an unknown project unwinds every class, including the in-flight artifact", async () => {
    // The membership failure lands on the FIRST class after its artifact
    // was built and its registration succeeded inside the transaction —
    // exactly the current-class residue the widened unwind exists for.
    await expect(
      importOsm(testAccountScope(), {
        selectors: ["amenity=restaurant", "highway"],
        bbox: BERLIN,
        name: "doomed",
        projectId: "p-vanished",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(listTables().length).toBe(0);
    const tablesDir = path.join(process.env.DEZFIL_DATA_DIR!, "tables");
    expect(await readdir(tablesDir).catch(() => [])).toEqual([]);
  });
});
