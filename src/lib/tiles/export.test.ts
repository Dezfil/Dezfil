import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { exportGeoJsonSeq } from "./export";
import { ensureTileDirs, tileScratchDir, tilesDir } from "./paths";

/**
 * The tile export path: the effective result streams to newline-delimited
 * GeoJSON inside the scratch directory — and nowhere else. The fence tests
 * are the adversarial half: the scratch is the only writable surface the
 * hardened instance gained.
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
  ensureTileDirs();
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const SQL = "SELECT name, category, riders, geometry FROM stations";
const COLUMNS = ["name", "category", "riders"];

type Feature = {
  type: string;
  geometry: { type: string } | null;
  properties: Record<string, unknown>;
};

async function readSeq(file: string): Promise<Feature[]> {
  const text = await readFile(file, "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Feature);
}

describe("tile export", () => {
  it("streams the result as one GeoJSON feature per line", async () => {
    const out = path.join(tileScratchDir(), "layer.geojsonl");
    const written = await exportGeoJsonSeq(testAccountScope(),
      { sql: SQL, filters: [], geometryColumn: "geometry", columns: COLUMNS },
      out,
    );
    expect(written).toBe(4);
    const features = await readSeq(out);
    expect(features).toHaveLength(4);
    expect(features[0].type).toBe("Feature");
    expect(features[0].geometry?.type).toBe("Point");
    const names = features.map((f) => f.properties.name).sort();
    expect(names).toEqual(["alexanderplatz", "hackescher", "sudkreuz", "zoo"]);
  });

  it("exports exactly the listed columns — the projection happens at the SELECT", async () => {
    const out = path.join(tileScratchDir(), "projected.geojsonl");
    const written = await exportGeoJsonSeq(testAccountScope(),
      { sql: SQL, filters: [], geometryColumn: "geometry", columns: ["name"] },
      out,
    );
    expect(written).toBe(4);
    const features = await readSeq(out);
    for (const f of features) {
      expect(Object.keys(f.properties)).toEqual(["name"]);
    }
  });

  it("applies the layer's filters before exporting", async () => {
    const out = path.join(tileScratchDir(), "filtered.geojsonl");
    const written = await exportGeoJsonSeq(testAccountScope(),
      {
        sql: SQL,
        filters: [{ field: "riders", kind: "range", min: 400, max: null }],
        geometryColumn: "geometry",
        columns: COLUMNS,
      },
      out,
    );
    expect(written).toBe(3);
    const features = await readSeq(out);
    expect(features.every((f) => Number(f.properties.riders) >= 400)).toBe(true);
  });

  it("drops NULL geometries like the inline render path", async () => {
    const out = path.join(tileScratchDir(), "nulls.geojsonl");
    const written = await exportGeoJsonSeq(testAccountScope(),
      {
        sql: `SELECT name, CASE WHEN riders > 400 THEN geometry END AS geometry
              FROM stations`,
        filters: [],
        geometryColumn: "geometry",
        columns: ["name"],
      },
      out,
    );
    expect(written).toBe(3);
  });

  it("rejects user SQL that is not a read-only SELECT", async () => {
    const out = path.join(tileScratchDir(), "evil.geojsonl");
    await expect(
      exportGeoJsonSeq(testAccountScope(),
        {
          sql: `COPY (SELECT 1) TO '${path.join(dir, "escape.csv")}'`,
          filters: [],
          geometryColumn: "geometry",
          columns: COLUMNS,
        },
        out,
      ),
    ).rejects.toMatchObject({ code: "sql_rejected" });
  });

  it("fence: refuses to write outside the scratch directory", async () => {
    // One level up — where served archives live — must stay unwritable.
    const out = path.join(tilesDir(), "escape.geojsonl");
    await expect(
      exportGeoJsonSeq(testAccountScope(), { sql: SQL, filters: [], geometryColumn: "geometry", columns: COLUMNS }, out),
    ).rejects.toMatchObject({ code: "sql_error" });
  });

  it("fence: refuses to write over a data artifact", async () => {
    const out = path.join(dir, "data", "metadata.sqlite");
    await expect(
      exportGeoJsonSeq(testAccountScope(), { sql: SQL, filters: [], geometryColumn: "geometry", columns: COLUMNS }, out),
    ).rejects.toMatchObject({ code: "sql_error" });
  });
});
