import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { withConnection } from "@/lib/duckdb";
import { closeMetadataDb } from "@/lib/metadata/db";
import { listTables } from "@/lib/metadata/tables";
import { inspectTable, tableFeatures } from "@/lib/table-service";
import { ingestFile, detectFormat, withBlankCoordinateFacts } from "./ingest";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
});

afterEach(async () => {
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const geojson = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "a", value: 1 },
      geometry: { type: "Point", coordinates: [13.4, 52.5] },
    },
    {
      type: "Feature",
      properties: { name: "b", value: 2 },
      geometry: { type: "Point", coordinates: [2.35, 48.85] },
    },
  ],
});

describe("detectFormat", () => {
  it("maps extensions to formats and rejects the rest", () => {
    expect(detectFormat("a.parquet")).toBe("geoparquet");
    expect(detectFormat("a.geojson")).toBe("geojson");
    expect(detectFormat("a.CSV")).toBe("csv");
    expect(() => detectFormat("a.shp")).toThrow(/Supported formats/);
  });
});

describe("blank coordinate probing", () => {
  it("issues no probe when every exact-pair candidate is numeric", async () => {
    const runAndReadAll = vi.fn(() => {
      throw new Error("numeric-only coordinates must not trigger a blank probe");
    });
    const columns = [
      { name: "id", type: "BIGINT" },
      { name: "lon", type: "DOUBLE" },
      { name: "lat", type: "DOUBLE" },
    ];

    await expect(
      withBlankCoordinateFacts(
        { runAndReadAll } as unknown as import("@duckdb/node-api").DuckDBConnection,
        "read_csv('ordinary-spatial.csv')",
        columns,
      ),
    ).resolves.toEqual(columns);
    expect(runAndReadAll).not.toHaveBeenCalled();
  });
});

describe("ingestFile", () => {
  it("ingests GeoJSON into a spatial table", async () => {
    const src = path.join(dir, "parks.geojson");
    await writeFile(src, geojson);
    const table = await ingestFile(testAccountScope(), src, "parks.geojson");
    expect(table.name).toBe("parks");
    expect(table.rowCount).toBe(2);
    expect(table.geometryColumn).not.toBeNull();
    expect(table.geometryType).toBe("POINT");
    expect(listTables().map((t) => t.name)).toEqual(["parks"]);
  });

  it("retains geometry identity for an empty GeoJSON and an all-blank recognized WKT CSV", async () => {
    const emptyGeojson = path.join(dir, "empty.geojson");
    await writeFile(
      emptyGeojson,
      JSON.stringify({ type: "FeatureCollection", features: [] }),
    );
    const empty = await ingestFile(testAccountScope(), emptyGeojson, "empty.geojson");
    expect(empty).toMatchObject({
      geometryColumn: "geom",
      geometryType: null,
      rowCount: 0,
      crsAssumed: false,
    });

    const blankWkt = path.join(dir, "blank-wkt.csv");
    await writeFile(blankWkt, "name,wkt\na,\nb,\n");
    const blank = await ingestFile(testAccountScope(), blankWkt, "blank-wkt.csv");
    expect(blank).toMatchObject({
      geometryColumn: "geometry",
      geometryType: null,
      rowCount: 2,
      crsAssumed: true,
    });
  });

  it("ingests a coordinate-free CSV as a non-spatial table", async () => {
    const src = path.join(dir, "plain.csv");
    await writeFile(src, "name,value\na,1\nb,2\nc,3\n");
    const table = await ingestFile(testAccountScope(), src, "plain.csv");
    expect(table.rowCount).toBe(3);
    expect(table.geometryColumn).toBeNull();
    expect(table.geometryType).toBeNull();
    // An ordinary textual header is not suspect — the lenient road
    // itself is not narrowed.
    expect(table.headerSuspect).toBe(false);
  });

  it("the field find's unsplit CSV imports warned, not refused", async () => {
    // The tracked fixture: the pinned engine lands the whole first line
    // as one column's name — signal (a), end to end.
    const bytes = await readFile(
      path.join(process.cwd(), "e2e", "fixtures", "broken-header.csv"),
      "utf8",
    );
    const src = path.join(dir, "unsplit.csv");
    await writeFile(src, bytes);
    const table = await ingestFile(testAccountScope(), src, "unsplit.csv");
    expect(table.headerSuspect).toBe(true);
    expect(table.geometryColumn).toBeNull(); // still the lenient road
  });

  it("a consumed numeric header imports warned through signal (b)", async () => {
    const src = path.join(dir, "years.csv");
    await writeFile(src, "2019,2020,2021\nBerlin,Hamburg,Munich\nx,y,z\n");
    const table = await ingestFile(testAccountScope(), src, "years.csv");
    expect(table.headerSuspect).toBe(true);
    expect(table.rowCount).toBe(2); // the first row was eaten as the header
  });

  it("a warned CSV can still be spatial — the warning is advisory", async () => {
    // A quoted comma-bearing header name beside recognized lon/lat: the
    // named false positive trips signal (a) while geometry recognition
    // proceeds untouched (the rule's unit half).
    const src = path.join(dir, "spatialwarn.csv");
    await writeFile(
      src,
      'name,lon,lat,"note, aside"\nA,13.4,52.5,x\nB,13.5,52.6,y\n',
    );
    const table = await ingestFile(testAccountScope(), src, "spatialwarn.csv");
    expect(table.headerSuspect).toBe(true);
    expect(table.geometryType).toBe("POINT");
  });

  it("a non-CSV source with data-like names never warns", async () => {
    // The warning is a CSV-road verdict: a GeoJSON whose
    // properties would trip both signals stays clean.
    const src = path.join(dir, "oddprops.geojson");
    await writeFile(
      src,
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { "56": 1, "-73.7781": 2, "a,b": 3 },
            geometry: { type: "Point", coordinates: [13.4, 52.5] },
          },
        ],
      }),
    );
    const table = await ingestFile(testAccountScope(), src, "oddprops.geojson");
    expect(table.headerSuspect).toBe(false);
  });

  it("ingests GeoParquet with geometry intact", async () => {
    const src = path.join(dir, "points.parquet");
    await withConnection(async (conn) => {
      await conn.run(
        `COPY (SELECT ST_Point(1, 2) AS geometry, 'x' AS label)
         TO '${src.replace(/'/g, "''")}' (FORMAT PARQUET)`,
      );
    });
    const table = await ingestFile(testAccountScope(), src, "points.parquet");
    expect(table.geometryColumn).toBe("geometry");
    expect(table.geometryType).toBe("POINT");
    expect(table.rowCount).toBe(1);
  });

  it("collapses single+multi of one family; heterogeneous keeps its family mix", async () => {
    const feature = (geometry: object, name: string) => ({
      type: "Feature",
      properties: { name },
      geometry,
    });
    const ring = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ];
    const polygons = JSON.stringify({
      type: "FeatureCollection",
      features: [
        feature({ type: "Polygon", coordinates: [ring] }, "a"),
        feature({ type: "MultiPolygon", coordinates: [[ring]] }, "b"),
      ],
    });
    await writeFile(path.join(dir, "divisions.geojson"), polygons);
    const collapsed = await ingestFile(
      testAccountScope(),
      path.join(dir, "divisions.geojson"),
      "divisions.geojson",
    );
    expect(collapsed.geometryType).toBe("MULTIPOLYGON");

    const heterogeneous = JSON.stringify({
      type: "FeatureCollection",
      features: [
        feature({ type: "Point", coordinates: [13.4, 52.5] }, "a"),
        feature({ type: "Polygon", coordinates: [ring] }, "b"),
      ],
    });
    await writeFile(path.join(dir, "grab-bag.geojson"), heterogeneous);
    const mixed = await ingestFile(
      testAccountScope(),
      path.join(dir, "grab-bag.geojson"),
      "grab-bag.geojson",
    );
    expect(mixed.geometryType).toBe("POINT+POLYGON");
  });

  it("reprojects GeoParquet with a declared projected CRS to WGS84", async () => {
    const src = path.join(dir, "utm.parquet");
    const geo = JSON.stringify({
      version: "1.0.0",
      primary_column: "geometry",
      columns: {
        geometry: {
          encoding: "WKB",
          geometry_types: ["Point"],
          crs: { type: "ProjectedCRS", id: { authority: "EPSG", code: 32633 } },
        },
      },
    });
    await withConnection(async (conn) => {
      await conn.run(
        `COPY (SELECT ST_AsWKB(ST_Point(391390.73133995204, 5817855.24081733)) AS geometry)
         TO '${src.replace(/'/g, "''")}'
         (FORMAT PARQUET, KV_METADATA {geo: '${geo.replace(/'/g, "''")}'})`,
      );
    });
    const table = await ingestFile(testAccountScope(), src, "utm.parquet");
    expect(table.geometryType).toBe("POINT");
    expect(table.crsAssumed).toBe(false);
    const artifact = path
      .join(process.env.DEZFIL_DATA_DIR!, table.file)
      .replace(/'/g, "''");
    const [row] = await withConnection(async (conn) => {
      const r = await conn.runAndReadAll(
        `SELECT ST_X(geometry) AS x, ST_Y(geometry) AS y FROM read_parquet('${artifact}')`,
      );
      return r.getRowObjects() as unknown as { x: number; y: number }[];
    });
    expect(row.x).toBeCloseTo(13.4, 4);
    expect(row.y).toBeCloseTo(52.5, 4);
  });

  it("imports a WKB blob column with no geo metadata under the WGS84 assumption", async () => {
    const src = path.join(dir, "blob.parquet");
    await withConnection(async (conn) => {
      await conn.run(
        `COPY (SELECT ST_AsWKB(ST_Point(13.4, 52.5)) AS geom, 'a' AS name)
         TO '${src.replace(/'/g, "''")}' (FORMAT PARQUET)`,
      );
    });
    const table = await ingestFile(testAccountScope(), src, "blob.parquet");
    expect(table.geometryColumn).toBe("geom");
    expect(table.geometryType).toBe("POINT");
    expect(table.crsAssumed).toBe(true);
  });

  it("falls back to a plain import when a geometry-named blob is not WKB", async () => {
    const src = path.join(dir, "notwkb.parquet");
    await withConnection(async (conn) => {
      await conn.run(
        `COPY (SELECT 'junk'::BLOB AS geometry, 1 AS v)
         TO '${src.replace(/'/g, "''")}' (FORMAT PARQUET)`,
      );
    });
    const table = await ingestFile(testAccountScope(), src, "notwkb.parquet");
    expect(table.geometryColumn).toBeNull();
    expect(table.crsAssumed).toBe(false);
    expect(table.rowCount).toBe(1);
  });

  it("deduplicates colliding table names", async () => {
    const src = path.join(dir, "parks.geojson");
    await writeFile(src, geojson);
    const first = await ingestFile(testAccountScope(), src, "parks.geojson");
    const second = await ingestFile(testAccountScope(), src, "parks.geojson");
    expect(first.name).toBe("parks");
    expect(second.name).toBe("parks_2");
  });

  it("ingests a CSV with a recognized coordinate pair as points", async () => {
    const src = path.join(dir, "stations.csv");
    await writeFile(
      src,
      "name,lon,lat\nalexanderplatz,13.41,52.52\nzoo,13.33,52.51\n",
    );
    const table = await ingestFile(testAccountScope(), src, "stations.csv");
    expect(table.geometryColumn).toBe("geometry");
    expect(table.geometryType).toBe("POINT");
    expect(table.crsAssumed).toBe(true);
    expect(table.rowCount).toBe(2);
  });

  it.each([
    {
      label: "all-blank members",
      filename: "blank-pair.csv",
      csv: 'name,lon,lat\na,,\nb,"",""\n',
      expectedLon: [null, null],
    },
    {
      label: "one numeric and one blank member",
      filename: "blank-lat.csv",
      csv: 'name,lon,lat\na,13.4,\nb,13.5,""\n',
      expectedLon: [13.4, 13.5],
    },
  ])(
    "retains rows and spatial identity for $label",
    async ({ filename, csv, expectedLon }) => {
      const src = path.join(dir, filename);
      await writeFile(src, csv);

      const table = await ingestFile(testAccountScope(), src, filename);
      expect(table).toMatchObject({
        geometryColumn: "geometry",
        geometryType: null,
        crsAssumed: true,
        rowCount: 2,
      });

      const detail = await inspectTable(testAccountScope(), table.name);
      expect(detail.columns.map((column) => column.name)).toEqual([
        "name",
        "lon",
        "lat",
        "geometry",
      ]);
      expect(detail.preview.map((row) => row.lon)).toEqual(expectedLon);
      expect(detail.preview.map((row) => row.lat)).toEqual([null, null]);
      expect(detail.preview.map((row) => row.geometry)).toEqual([null, null]);

      await expect(tableFeatures(testAccountScope(), table.name)).resolves.toMatchObject({
        ok: true,
        geometryType: null,
        featureCount: 0,
      });
    },
  );

  it.each([
    ["lon-lat", "LoN", "lAt"],
    ["lng-lat", "LnG", "LaT"],
    ["long-lat", "LoNg", "LAT"],
    ["longitude-latitude", "LongItude", "LaTitude"],
  ])(
    "recognizes quoted-empty %s columns case-insensitively through the CSV reader",
    async (label, lon, lat) => {
      const filename = `${label}.csv`;
      const src = path.join(dir, filename);
      await writeFile(src, `name,${lon},${lat}\na,"",""\n`);

      const table = await ingestFile(testAccountScope(), src, filename);
      expect(table).toMatchObject({
        geometryColumn: "geometry",
        geometryType: null,
        crsAssumed: true,
        rowCount: 1,
      });
      const detail = await inspectTable(testAccountScope(), table.name);
      expect(detail.columns.map((column) => column.name)).toEqual([
        "name",
        lon,
        lat,
        "geometry",
      ]);
      expect(detail.preview[0]).toMatchObject({
        [lon]: null,
        [lat]: null,
        geometry: null,
      });
    },
  );

  it("recognizes an exact coordinate pair in a header-only CSV", async () => {
    const src = path.join(dir, "header-only.csv");
    await writeFile(src, "name,LoN,lAt\n");

    const table = await ingestFile(testAccountScope(), src, "header-only.csv");
    expect(table).toMatchObject({
      geometryColumn: "geometry",
      geometryType: null,
      crsAssumed: true,
      rowCount: 0,
    });
    const detail = await inspectTable(testAccountScope(), table.name);
    expect(detail.columns.map((column) => column.name)).toEqual([
      "name",
      "LoN",
      "lAt",
      "geometry",
    ]);
    expect(detail.preview).toEqual([]);
  });

  it("builds points only for rows with both numeric members", async () => {
    const src = path.join(dir, "partial-pair.csv");
    await writeFile(
      src,
      'name,lon,lat\ncomplete,13.4,52.5\nno-lon,,52.6\nno-lat,13.6,""\n',
    );

    const table = await ingestFile(testAccountScope(), src, "partial-pair.csv");
    expect(table).toMatchObject({
      geometryColumn: "geometry",
      geometryType: "POINT",
      crsAssumed: true,
      rowCount: 3,
    });
    const detail = await inspectTable(testAccountScope(), table.name);
    expect(String(detail.preview[0].geometry)).toMatch(/^POINT \(13\.4 52\.5\)$/);
    expect(detail.preview.slice(1).map((row) => row.geometry)).toEqual([
      null,
      null,
    ]);
    await expect(tableFeatures(testAccountScope(), table.name)).resolves.toMatchObject({
      ok: true,
      geometryType: "POINT",
      featureCount: 1,
    });
  });

  it("lets a populated prefixed pair outrank a blank-qualified exact pair", async () => {
    const src = path.join(dir, "blank-exact-with-flow-pairs.csv");
    await writeFile(
      src,
      "id,lon,lat,origin_lon,origin_lat,dest_lon,dest_lat\n" +
        "1,,,13.4,52.5,2.35,48.85\n" +
        "2,,,13.5,52.6,2.36,48.86\n",
    );

    const table = await ingestFile(testAccountScope(), src, "blank-exact-with-flow-pairs.csv");
    expect(table).toMatchObject({
      geometryColumn: "geometry",
      geometryType: "POINT",
      crsAssumed: true,
      rowCount: 2,
    });
    await expect(tableFeatures(testAccountScope(), table.name)).resolves.toMatchObject({
      ok: true,
      geometryType: "POINT",
      featureCount: 2,
    });
  });

  it.each([
    ["whitespace", 'name,lon,lat\na," ",\n'],
    ["text", "name,lon,lat\na,not-a-coordinate,52.5\n"],
  ])("keeps %s coordinate content non-spatial", async (label, csv) => {
    const filename = `${label}-pair.csv`;
    const src = path.join(dir, filename);
    await writeFile(src, csv);

    const table = await ingestFile(testAccountScope(), src, filename);
    expect(table).toMatchObject({
      geometryColumn: null,
      geometryType: null,
      crsAssumed: false,
      rowCount: 1,
    });
  });

  it("keeps blank prefixed coordinate pairs non-spatial", async () => {
    const src = path.join(dir, "blank-prefixed.csv");
    await writeFile(
      src,
      'name,origin_lon,origin_lat\na,,\nb,"",""\n',
    );

    const table = await ingestFile(testAccountScope(), src, "blank-prefixed.csv");
    expect(table).toMatchObject({
      geometryColumn: null,
      geometryType: null,
      crsAssumed: false,
      rowCount: 2,
    });
  });

  it("lets an all-blank WKT column outrank usable coordinates", async () => {
    const src = path.join(dir, "blank-wkt-with-pair.csv");
    await writeFile(
      src,
      'name,wkt,lon,lat\na,,13.4,52.5\nb,"",13.5,52.6\n',
    );

    const table = await ingestFile(testAccountScope(), src, "blank-wkt-with-pair.csv");
    expect(table).toMatchObject({
      geometryColumn: "geometry",
      geometryType: null,
      crsAssumed: true,
      rowCount: 2,
    });
    const detail = await inspectTable(testAccountScope(), table.name);
    expect(detail.columns.map((column) => column.name)).toEqual([
      "name",
      "lon",
      "lat",
      "geometry",
    ]);
    expect(detail.preview.map((row) => row.geometry)).toEqual([null, null]);
    await expect(tableFeatures(testAccountScope(), table.name)).resolves.toMatchObject({
      ok: true,
      geometryType: null,
      featureCount: 0,
    });
  });

  it("ingests a CSV with a WKT column, which takes precedence", async () => {
    const src = path.join(dir, "areas.csv");
    await writeFile(
      src,
      'name,wkt,lon,lat\na,"POLYGON ((0 0, 1 0, 1 1, 0 0))",1,2\n',
    );
    const table = await ingestFile(testAccountScope(), src, "areas.csv");
    expect(table.geometryColumn).toBe("geometry");
    expect(table.geometryType).toBe("POLYGON");
    expect(table.crsAssumed).toBe(true);
  });

  it("retains an all-unreadable named WKT column as a weak candidate", async () => {
    const src = path.join(dir, "bad-wkt.csv");
    await writeFile(src, "name,wkt\na,NOT A SHAPE\n");
    await expect(ingestFile(testAccountScope(), src, "bad-wkt.csv")).resolves.toMatchObject({
      rowCount: 1, geometryColumn: null, geometryType: null, crsAssumed: false,
      geometryCandidates: [expect.objectContaining({ columns: ["wkt"], strength: "weak", reasons: ["unreadable"], sourceRetained: true })],
    });
    expect(listTables()).toHaveLength(1);
  });

  it.each(["", "\n", "\r\n\n\r\n"])("refuses an empty CSV before creating durable state (%j)", async csv => {
    const src = path.join(dir, "empty.csv");
    const artifact = path.join(dir, "empty.parquet");
    await writeFile(src, csv);
    const { buildArtifact } = await import("./ingest");
    await expect(buildArtifact(src, "empty.csv", artifact)).rejects.toMatchObject({ code: "malformed_file", status: 422 });
    await expect(readFile(artifact)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(ingestFile(testAccountScope(), src, "empty.csv")).rejects.toMatchObject({ code: "malformed_file", status: 422 });
    expect(listTables()).toEqual([]);
    expect(await readdir(path.join(process.env.DEZFIL_DATA_DIR!, "tables")).catch(() => [])).toEqual([]);
  });

  it("rejects a corrupt file and leaves no partial state", async () => {
    const src = path.join(dir, "broken.geojson");
    await writeFile(src, "this is not json {{{");
    await expect(ingestFile(testAccountScope(), src, "broken.geojson")).rejects.toMatchObject({
      code: "malformed_file",
    });
    expect(listTables()).toEqual([]);
    const artifacts = await readdir(
      path.join(process.env.DEZFIL_DATA_DIR!, "tables"),
    ).catch(() => []);
    expect(artifacts).toEqual([]);
  });

  it("rejects a renamed PNG posing as a supported format", async () => {
    const src = path.join(dir, "image.parquet");
    // PNG magic bytes followed by junk.
    await writeFile(
      src,
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(64, 7),
      ]),
    );
    await expect(ingestFile(testAccountScope(), src, "image.parquet")).rejects.toMatchObject({
      code: "malformed_file",
    });
    expect(listTables()).toEqual([]);
  });

  it("rejects a truncated parquet file, leaving no partial state", async () => {
    const whole = path.join(dir, "whole.parquet");
    await withConnection(async (conn) => {
      await conn.run(
        `COPY (SELECT range AS id, ST_Point(range, range) AS geometry FROM range(1000))
         TO '${whole.replace(/'/g, "''")}' (FORMAT PARQUET)`,
      );
    });
    const bytes = await readFile(whole);
    const src = path.join(dir, "truncated.parquet");
    await writeFile(src, bytes.subarray(0, Math.floor(bytes.length / 2)));
    await expect(ingestFile(testAccountScope(), src, "truncated.parquet")).rejects.toMatchObject({
      code: "malformed_file",
    });
    expect(listTables()).toEqual([]);
    const artifacts = await readdir(
      path.join(process.env.DEZFIL_DATA_DIR!, "tables"),
    ).catch(() => []);
    expect(artifacts).toEqual([]);
  });
});
