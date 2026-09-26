import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetQueryInstance, withConnection } from "@/lib/duckdb";
import { closeMetadataDb } from "@/lib/metadata/db";
import { measureArtifact } from "./ingest";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "dezfil-measure-"));
  process.env.DEZFIL_DATA_DIR = dir;
  closeMetadataDb();
  resetQueryInstance();
  await mkdir(path.join(dir, "tables"), { recursive: true });
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("source-established geometry at artifact measurement", () => {
  for (const road of ["operation", "PostGIS", "Overture"] as const) {
    it(`retains ${road}'s geometry column when the artifact has zero rows`, async () => {
      const artifact = path.join(dir, "tables", `${road}.parquet`);
      const measured = await withConnection(async (conn) => {
        await conn.run(
          `COPY (SELECT 1 AS id, NULL::GEOMETRY AS geom WHERE false) TO '${artifact}' (FORMAT PARQUET)`,
        );
        return measureArtifact(conn, artifact, "geom");
      });
      expect(measured).toMatchObject({
        geometryColumn: "geom",
        geometryType: null,
        rowCount: 0,
      });
    });
  }

  it("retains an all-null geometry column but never invents one for a non-spatial result", async () => {
    const spatial = path.join(dir, "tables", "all-null.parquet");
    const plain = path.join(dir, "tables", "plain.parquet");
    const [measuredSpatial, measuredPlain] = await withConnection(async (conn) => {
      await conn.run(
        `COPY (SELECT i AS id, NULL::GEOMETRY AS geom FROM range(2) t(i)) TO '${spatial}' (FORMAT PARQUET)`,
      );
      await conn.run(
        `COPY (SELECT i AS id FROM range(2) t(i)) TO '${plain}' (FORMAT PARQUET)`,
      );
      return [
        await measureArtifact(conn, spatial, "geom"),
        await measureArtifact(conn, plain),
      ];
    });
    expect(measuredSpatial).toMatchObject({
      geometryColumn: "geom",
      geometryType: null,
      rowCount: 2,
    });
    expect(measuredPlain).toMatchObject({
      geometryColumn: null,
      geometryType: null,
      rowCount: 2,
    });
  });
});
