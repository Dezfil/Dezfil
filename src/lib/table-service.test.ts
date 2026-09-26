import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { insertTable, listTables } from "@/lib/metadata/tables";
import { getTileRecord, upsertTileRecord } from "@/lib/metadata/tiles";
import { ingestFile } from "@/lib/ingest/ingest";
import { withConnection } from "@/lib/duckdb";
import { retirementsSettled } from "@/lib/ingest/retire";
import { tileArchivePath } from "@/lib/tiles/paths";
import {
  exportTable,
  inspectTable,
  removeTable,
  tableFeatures,
} from "./table-service";

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

async function ingestSample() {
  const src = path.join(dir, "stations.csv");
  await writeFile(
    src,
    "name,lon,lat\nalexanderplatz,13.41,52.52\nzoo,13.33,52.51\n",
  );
  return ingestFile(src, "stations.csv");
}

async function seedRetainedEmpty(
  name: string,
  rows: "zero" | "all-null",
) {
  const rel = path.join("tables", `${name}.parquet`);
  const abs = path.join(process.env.DEZFIL_DATA_DIR!, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await withConnection(async (conn) => {
    const select =
      rows === "zero"
        ? "SELECT 1 AS id, ST_AsWKB(NULL::GEOMETRY) AS geom WHERE false"
        : "SELECT i AS id, ST_AsWKB(NULL::GEOMETRY) AS geom FROM range(2) t(i)";
    await conn.run(
      `COPY (${select}) TO '${abs.replace(/'/g, "''")}' (FORMAT PARQUET)`,
    );
  });
  insertTable({
    id: `${name}-id`,
    name,
    sourceFilename: null,
    format: "geoparquet",
    file: rel,
    geometryColumn: "geom",
    geometryType: null,
    crsAssumed: false,
    headerSuspect: false,
    rowCount: rows === "zero" ? 0 : 2,
    createdAt: new Date().toISOString(),
    source: "operation",
    sourceParams: null,
    importedAt: null,
  });
  return { abs, bytes: await readFile(abs) };
}

describe("direct reads of retained empty geometry", () => {
  for (const rows of ["zero", "all-null"] as const) {
    it(`serves detail, features, and every export for ${rows} geometry`, async () => {
      const name = rows === "zero" ? "zero_direct" : "null_direct";
      const stored = await seedRetainedEmpty(name, rows);
      const detail = await inspectTable(name);
      expect(detail.columns.find((column) => column.name === "geom")?.type).toContain(
        "GEOMETRY",
      );
      expect(detail.preview).toHaveLength(rows === "zero" ? 0 : 2);
      expect(detail.preview.map((row) => row.geom)).toEqual(
        rows === "zero" ? [] : [null, null],
      );

      const features = await tableFeatures(name);
      expect(features).toMatchObject({ ok: true, featureCount: 0 });

      const parquet = await exportTable(name, "geoparquet");
      expect(parquet.path).toBe(stored.abs);
      expect(await readFile(parquet.path)).toEqual(stored.bytes);

      const geojson = await exportTable(name, "geojson");
      try {
        const collection = JSON.parse(await readFile(geojson.path, "utf8")) as {
          type: string;
          features: { geometry: unknown }[];
          crs?: unknown;
        };
        expect(collection.type).toBe("FeatureCollection");
        expect(collection.features).toHaveLength(rows === "zero" ? 0 : 2);
        expect(collection.features.map((feature) => feature.geometry)).toEqual(
          rows === "zero" ? [] : [null, null],
        );
        expect(collection.crs).toBeDefined();
      } finally {
        await geojson.cleanup();
      }

      const csv = await exportTable(name, "csv");
      try {
        const text = await readFile(csv.path, "utf8");
        expect(text).toBe(rows === "zero" ? "id,geom\n" : "id,geom\n0,\n1,\n");
      } finally {
        await csv.cleanup();
      }
    });
  }
});

describe("inspectTable", () => {
  it("presents a typed WGS84-equivalent artifact under the canonical detail label", async () => {
    const stored = await ingestSample();
    const artifact = path.join(process.env.DEZFIL_DATA_DIR!, stored.file);
    const storedType = await withConnection(async (conn) => {
      const result = await conn.runAndReadAll(
        `SELECT column_type FROM (DESCRIBE SELECT * FROM read_parquet('${artifact.replace(/'/g, "''")}')) WHERE column_name = 'geometry'`,
      );
      return String(
        (result.getRowObjects() as unknown as { column_type: string }[])[0]
          .column_type,
      );
    });
    expect(storedType).toBe("GEOMETRY('OGC:CRS84')");

    const inspection = await inspectTable(stored.name);
    expect(
      inspection.columns.find((column) => column.name === "geometry")?.type,
    ).toBe("GEOMETRY('EPSG:4326')");
  });

  it("returns schema and a WKT geometry preview", async () => {
    await ingestSample();
    const inspection = await inspectTable("stations");
    expect(inspection.rowCount).toBe(2);
    expect(inspection.columns.map((c) => c.name)).toEqual([
      "name",
      "lon",
      "lat",
      "geometry",
    ]);
    expect(inspection.preview).toHaveLength(2);
    expect(String(inspection.preview[0].geometry)).toMatch(/^POINT \(/);
  });

  it("raises not_found for an unknown table", async () => {
    await expect(inspectTable("nope")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });
});

describe("tableFeatures", () => {
  afterEach(() => {
    delete process.env.DEZFIL_RENDER_CAP_FEATURES;
  });

  it("serves features as GeoJSON with stable ids", async () => {
    await ingestSample();
    const result = await tableFeatures("stations");
    expect(result.ok).toBe(true);
    expect(result.featureCount).toBe(2);
    const fc = result.geojson as {
      features: { id: number; geometry: { type: string } }[];
    };
    expect(fc.features.map((f) => f.id)).toEqual([0, 1]);
    expect(fc.features[0].geometry.type).toBe("Point");
  });

  it("refuses honestly over the render cap", async () => {
    await ingestSample();
    process.env.DEZFIL_RENDER_CAP_FEATURES = "1";
    const result = await tableFeatures("stations");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/render cap/);
  });

  it("raises not_found for an unknown table", async () => {
    await expect(tableFeatures("nope")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("removeTable", () => {
  it("removes the registry entry and the artifact", async () => {
    const table = await ingestSample();
    const artifact = path.join(process.env.DEZFIL_DATA_DIR!, table.file);
    await access(artifact);
    await removeTable("stations");
    expect(listTables()).toEqual([]);
    // The artifact retires behind in-flight readers; none here, so promptly.
    await retirementsSettled();
    await expect(access(artifact)).rejects.toThrow();
  });

  it("raises not_found when deleting an unknown table", async () => {
    await expect(removeTable("nope")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("reclaims dependent layers' tile records and archives", async () => {
    await ingestSample();
    const db = metadataDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO maps (id, name, created_at, updated_at) VALUES ('m1', 'm', ?, ?)`,
    ).run(now, now);
    const seedLayer = (id: string, sql: string) => {
      db.prepare(
        `INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at)
         VALUES (?, 'm1', 'l', ?, '{}', 0, ?, ?)`,
      ).run(id, sql, now, now);
      upsertTileRecord({
        layerId: id,
        state: "ready",
        fingerprint: "f1",
        error: null,
        featureCount: 10,
        builtAt: now,
      });
    };
    seedLayer("layer-dep", "SELECT * FROM stations");
    seedLayer("layer-other", "SELECT * FROM other_things");
    const archive = tileArchivePath("layer-dep");
    await mkdir(path.dirname(archive), { recursive: true });
    await writeFile(archive, "pmtiles");

    await removeTable("stations");
    // The dependent stops serving the deleted data: record and archive
    // both reclaimed. The unrelated layer is untouched.
    expect(getTileRecord("layer-dep")).toBeNull();
    await expect(access(archive)).rejects.toThrow();
    expect(getTileRecord("layer-other")).not.toBeNull();
  });
});
