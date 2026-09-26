// A shapefile minted at run time through DuckDB spatial's GDAL writer (no
// committed binaries), its sidecars bundled as the conventional zip. With
// `includePrj: false` the .prj is dropped, so the upload lands as native
// geometry with WGS 84 assumed and no record. Shared by the import matrix
// and the set-geometry journeys.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildZip, type ZipMember } from "../test-support/zip";

/** Five points at (7.0 + i * 0.01, 51.0 + i * 0.01), written as EPSG:4326. */
export async function mintShapefileZip(options: {
  includePrj: boolean;
}): Promise<Buffer> {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const dir = await mkdtemp(path.join(os.tmpdir(), "imx1-shp-"));
  try {
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    try {
      await conn.run("LOAD spatial");
    } catch {
      await conn.run("INSTALL spatial; LOAD spatial");
    }
    await conn.run(`
      COPY (
        SELECT i AS id, 'p' || i AS name,
               ST_Point(7.0 + i * 0.01, 51.0 + i * 0.01) AS geom
        FROM range(5) t(i)
      ) TO '${path.join(dir, "points.shp").replace(/'/g, "''")}'
      (FORMAT GDAL, DRIVER 'ESRI Shapefile', SRS 'EPSG:4326')
    `);
    conn.closeSync();
    const members: ZipMember[] = [];
    for (const file of await readdir(dir)) {
      if (file.startsWith("tmp_")) continue;
      if (!options.includePrj && file.toLowerCase().endsWith(".prj")) continue;
      members.push({ name: file, data: await readFile(path.join(dir, file)) });
    }
    return buildZip(members);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
