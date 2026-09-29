import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { withConnection } from "@/lib/duckdb";
import { closeMetadataDb } from "@/lib/metadata/db";
import { listTables } from "@/lib/metadata/tables";
import { createProject, tableProjectIds } from "@/lib/metadata/projects";
import { buildZip, type ZipMember } from "../../../test-support/zip";
import { buildGpkg } from "../../../test-support/gpkg";
import { buildKml } from "../../../test-support/kml";
import { detectFormat } from "./ingest";
import { ingestSource, toIngestResponse } from "./gdal-formats";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  delete process.env.DEZFIL_UPLOAD_MAX_MB;
  closeMetadataDb();
});

afterEach(async () => {
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_UPLOAD_MAX_MB;
  await rm(dir, { recursive: true, force: true });
});

/** Mint shapefile sidecars through the engine's GDAL writer, then bundle
 * the requested sidecars into a zip — the format's own convention. */
/** Mint one shapefile's sidecars into `mint/<key>/` and return them as
 * zip members, optionally under a folder prefix inside the archive. */
async function mintShapefileMembers(options: {
  key: string;
  stem?: string;
  srs?: string;
  includePrj?: boolean;
  count?: number;
  prefix?: string;
}): Promise<ZipMember[]> {
  const {
    key,
    stem = "points",
    srs = "EPSG:4326",
    includePrj = true,
    count = 4,
    prefix = "",
  } = options;
  const shpDir = path.join(dir, "mint", key);
  await rm(shpDir, { recursive: true, force: true });
  await mkdir(shpDir, { recursive: true });
  const shpPath = path.join(shpDir, `${stem}.shp`);
  await withConnection(async (conn) => {
    await conn.run(`
      COPY (
        SELECT i AS id, 'p' || i AS name,
          ${
            srs === "EPSG:4326"
              ? "ST_Point(7.0 + i * 0.01, 51.0 + i * 0.01)"
              : `ST_Transform(ST_Point(7.0 + i * 0.01, 51.0 + i * 0.01), 'EPSG:4326', '${srs}', always_xy := true)`
          } AS geom
        FROM range(${count}) t(i)
      ) TO '${shpPath.replace(/'/g, "''")}' (FORMAT GDAL, DRIVER 'ESRI Shapefile', SRS '${srs}')
    `);
  });
  const members: ZipMember[] = [];
  for (const file of await readdir(shpDir)) {
    if (file.startsWith("tmp_")) continue; // GDAL writer leftovers
    if (!includePrj && file.toLowerCase().endsWith(".prj")) continue;
    members.push({
      name: `${prefix}${file}`,
      data: await readFile(path.join(shpDir, file)),
    });
  }
  return members;
}

async function mintShapefileZip(
  zipName: string,
  options: { srs?: string; stem?: string; includePrj?: boolean } = {},
): Promise<string> {
  const members = await mintShapefileMembers({
    key: options.stem ?? "points",
    ...options,
  });
  const zipPath = path.join(dir, zipName);
  await writeFile(zipPath, buildZip(members));
  return zipPath;
}

async function artifactsOnDisk(): Promise<string[]> {
  const tablesDir = path.join(dir, "data", "tables");
  return existsSync(tablesDir) ? readdir(tablesDir) : [];
}

async function scratchResidue(): Promise<string[]> {
  const tmpDir = path.join(dir, "data", "tmp");
  return existsSync(tmpDir) ? readdir(tmpDir) : [];
}

describe("detectFormat additions", () => {
  it("admits the container formats by extension", () => {
    expect(detectFormat("a.zip")).toBe("shapefile");
    expect(detectFormat("a.GPKG")).toBe("geopackage");
    expect(detectFormat("a.kml")).toBe("kml");
    expect(detectFormat("a.kmz")).toBe("kml");
    expect(() => detectFormat("a.gml")).toThrow(/Supported formats/);
  });
});

describe("shapefile zip", () => {
  it("lands a declared-WGS84 shapefile as a table named from the zip", async () => {
    const zipPath = await mintShapefileZip("stations.zip");
    const result = await ingestSource(testAccountScope(), zipPath, "stations.zip");
    expect(result.tables).toHaveLength(1);
    const table = result.tables[0];
    expect(table.name).toBe("stations");
    expect(table.format).toBe("shapefile");
    expect(table.rowCount).toBe(4);
    expect(table.geometryType).toBe("POINT");
    expect(table.crsAssumed).toBe(false);
    expect(await scratchResidue()).toEqual([]);
  });

  it("flags a .prj-less shapefile as CRS-assumed", async () => {
    const zipPath = await mintShapefileZip("noprj.zip", { includePrj: false });
    const result = await ingestSource(testAccountScope(), zipPath, "noprj.zip");
    expect(result.tables[0].crsAssumed).toBe(true);
    expect(result.tables[0].rowCount).toBe(4);
  });

  it("reprojects a declared non-WGS84 shapefile and keeps it unflagged", async () => {
    const zipPath = await mintShapefileZip("utm.zip", { srs: "EPSG:32632" });
    const result = await ingestSource(testAccountScope(), zipPath, "utm.zip");
    const table = result.tables[0];
    expect(table.crsAssumed).toBe(false);
    // Back in degrees: the first minted point sits near 7.0 E, 51.0 N.
    const point = await withConnection(async (conn) => {
      const read = await conn.runAndReadAll(
        `SELECT ST_X(geom) AS x, ST_Y(geom) AS y FROM read_parquet('${path
          .join(dir, "data", table.file)
          .replace(/'/g, "''")}') ORDER BY id LIMIT 1`,
      );
      return read.getRowObjects()[0] as { x: number; y: number };
    });
    expect(point.x).toBeCloseTo(7.0, 4);
    expect(point.y).toBeCloseTo(51.0, 4);
  });

  it("fans a zip holding several shapefiles into suffixed tables sharing a group", async () => {
    const zipA = await mintShapefileZip("a.zip", { stem: "roads" });
    const zipB = await mintShapefileZip("b.zip", { stem: "stops" });
    // Rebundle both shapefiles into one zip.
    const members: ZipMember[] = [];
    for (const stem of ["roads", "stops"]) {
      const shpDir = path.join(dir, "mint", stem);
      for (const file of await readdir(shpDir)) {
        if (file.startsWith("tmp_")) continue;
        members.push({
          name: file,
          data: await readFile(path.join(shpDir, file)),
        });
      }
    }
    const bundle = path.join(dir, "bundle.zip");
    await writeFile(bundle, buildZip(members));
    void zipA;
    void zipB;

    const result = await ingestSource(testAccountScope(), bundle, "bundle.zip");
    expect(result.tables.map((t) => t.name).sort()).toEqual([
      "bundle_roads",
      "bundle_stops",
    ]);
    const groups = result.tables.map((t) => t.sourceParams?.group);
    expect(groups[0]).toBeTruthy();
    expect(groups[0]).toBe(groups[1]);
    expect(result.tables.map((t) => t.sourceParams?.layer).sort()).toEqual([
      "roads",
      "stops",
    ]);
  });

  it("keeps distinct identities for same-stem shapefiles in different folders", async () => {
    // north/roads.shp and south/roads.shp must not
    // collapse to one layer identity, or a refresh resolves both to the
    // first dataset.
    const members = [
      ...(await mintShapefileMembers({
        key: "north-roads",
        stem: "roads",
        count: 4,
        prefix: "north/",
      })),
      ...(await mintShapefileMembers({
        key: "south-roads",
        stem: "roads",
        count: 2,
        prefix: "south/",
      })),
    ];
    const zipPath = path.join(dir, "regions.zip");
    await writeFile(zipPath, buildZip(members));
    const result = await ingestSource(testAccountScope(), zipPath, "regions.zip");
    expect(result.tables.map((t) => t.name).sort()).toEqual([
      "regions_north_roads",
      "regions_south_roads",
    ]);
    const byLayer = new Map(
      result.tables.map((t) => [t.sourceParams?.layer, t.rowCount]),
    );
    expect(byLayer.get("north/roads")).toBe(4);
    expect(byLayer.get("south/roads")).toBe(2);
  });

  it("refuses a zip with no shapefile inside, leaving nothing", async () => {
    const zipPath = path.join(dir, "nada.zip");
    await writeFile(
      zipPath,
      buildZip([{ name: "readme.txt", data: "no shapes here" }]),
    );
    await expect(ingestSource(testAccountScope(), zipPath, "nada.zip")).rejects.toMatchObject({
      code: "malformed_file",
    });
    expect(listTables()).toEqual([]);
    expect(await artifactsOnDisk()).toEqual([]);
    expect(await scratchResidue()).toEqual([]);
  });

  it("refuses an over-cap expansion with the coded error before extracting", async () => {
    process.env.DEZFIL_UPLOAD_MAX_MB = "1";
    const zipPath = path.join(dir, "bomb.zip");
    await writeFile(
      zipPath,
      buildZip([{ name: "huge.shp", data: Buffer.alloc(2 * 1024 * 1024) }]),
    );
    await expect(ingestSource(testAccountScope(), zipPath, "bomb.zip")).rejects.toMatchObject({
      code: "archive_too_large",
      status: 413,
    });
    expect(listTables()).toEqual([]);
    expect(await artifactsOnDisk()).toEqual([]);
    expect(await scratchResidue()).toEqual([]);
  });

  it("refuses a truncated zip as malformed, leaving nothing", async () => {
    const whole = buildZip([{ name: "x.shp", data: Buffer.alloc(5000, 3) }]);
    const zipPath = path.join(dir, "cut.zip");
    await writeFile(zipPath, whole.subarray(2000));
    await expect(ingestSource(testAccountScope(), zipPath, "cut.zip")).rejects.toMatchObject({
      code: "malformed_file",
    });
    expect(listTables()).toEqual([]);
    expect(await artifactsOnDisk()).toEqual([]);
    expect(await scratchResidue()).toEqual([]);
  });
});

describe("empty spatial containers", () => {
  it("retains the declared geometry column and WGS84 certainty", async () => {
    const file = path.join(dir, "empty-points.gpkg");
    buildGpkg(file, [{ name: "empty_points", kind: "points", rows: [] }]);
    const result = await ingestSource(testAccountScope(), file, "empty-points.gpkg");
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]).toMatchObject({
      geometryColumn: "geom",
      geometryType: null,
      rowCount: 0,
      crsAssumed: false,
    });
  });
});

describe("geopackage", () => {
  it("lands a single-layer GeoPackage named from the file", async () => {
    const file = path.join(dir, "harbours.gpkg");
    buildGpkg(file, [
      {
        name: "harbours",
        kind: "points",
        rows: [
          [7.1, 51.1, "alpha"],
          [7.2, 51.2, "beta"],
        ],
      },
    ]);
    const result = await ingestSource(testAccountScope(), file, "harbours.gpkg");
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].name).toBe("harbours");
    expect(result.tables[0].format).toBe("geopackage");
    expect(result.tables[0].rowCount).toBe(2);
    expect(result.tables[0].geometryType).toBe("POINT");
    expect(result.tables[0].crsAssumed).toBe(false);
    expect(result.skipped).toEqual([]);
    // A single spatial layer keeps the plain name — no group.
    expect(result.tables[0].sourceParams?.group).toBeUndefined();
  });

  it("fans a multi-layer GeoPackage into one table per spatial layer and names the skipped attribute table", async () => {
    const file = path.join(dir, "city.gpkg");
    buildGpkg(file, [
      {
        name: "stations",
        kind: "points",
        rows: [
          [7.1, 51.1, "a"],
          [7.2, 51.2, "b"],
          [7.3, 51.3, "c"],
        ],
      },
      {
        name: "zones",
        kind: "polygons",
        rows: [
          [
            [7, 51],
            [7.5, 51],
            [7.5, 51.5],
            [7, 51.5],
            [7, 51],
          ],
        ],
      },
      { name: "lookup", kind: "attributes", rows: [["A", "Alpha"]] },
    ]);
    const result = await ingestSource(testAccountScope(), file, "city.gpkg");
    expect(result.tables.map((t) => t.name)).toEqual([
      "city_stations",
      "city_zones",
    ]);
    expect(result.tables.map((t) => t.rowCount)).toEqual([3, 1]);
    expect(result.tables.map((t) => t.geometryType)).toEqual([
      "POINT",
      "POLYGON",
    ]);
    expect(result.skipped).toEqual([
      {
        layer: "lookup",
        reason: "no geometry: attribute-only content is not imported",
      },
    ]);
    const [a, b] = result.tables;
    expect(a.sourceParams?.group).toBeTruthy();
    expect(a.sourceParams?.group).toBe(b.sourceParams?.group);
    expect(a.sourceParams?.layer).toBe("stations");
    expect(b.sourceParams?.layer).toBe("zones");
    expect(a.createdAt).toBe(b.createdAt);
    // The wire answer enumerates the group.
    const answer = toIngestResponse(result) as unknown as Record<
      string,
      unknown
    >;
    expect(answer.tables).toHaveLength(2);
    expect(answer.skipped).toHaveLength(1);
    expect(answer.name).toBe("city_stations");
  });

  it("refuses an attributes-only GeoPackage naming the skipped members", async () => {
    const file = path.join(dir, "flat.gpkg");
    buildGpkg(file, [
      { name: "lookup", kind: "attributes", rows: [["A", "Alpha"]] },
    ]);
    await expect(ingestSource(testAccountScope(), file, "flat.gpkg")).rejects.toMatchObject({
      code: "malformed_file",
      message: expect.stringContaining("lookup"),
    });
    expect(listTables()).toEqual([]);
    expect(await artifactsOnDisk()).toEqual([]);
  });

  it("rolls the whole group back when a later layer fails mid-import", async () => {
    const file = path.join(dir, "half.gpkg");
    buildGpkg(file, [
      {
        name: "good",
        kind: "points",
        rows: [[7.1, 51.1, "a"]],
      },
      { name: "broken", kind: "corrupt" },
    ]);
    await expect(ingestSource(testAccountScope(), file, "half.gpkg")).rejects.toMatchObject({
      code: "malformed_file",
    });
    // The good layer's artifact was built before the bad one failed —
    // atomicity means it is gone and nothing was registered.
    expect(listTables()).toEqual([]);
    expect(await artifactsOnDisk()).toEqual([]);
  });

  it("refuses bytes that are not a GeoPackage, leaving nothing", async () => {
    const file = path.join(dir, "fake.gpkg");
    await writeFile(file, "not a sqlite database at all");
    await expect(ingestSource(testAccountScope(), file, "fake.gpkg")).rejects.toMatchObject({
      code: "malformed_file",
    });
    expect(listTables()).toEqual([]);
    expect(await artifactsOnDisk()).toEqual([]);
  });

  it("refuses content whose driver is not the declared format", async () => {
    // A GeoJSON document renamed .gpkg must not sneak in via sniffing.
    const file = path.join(dir, "sneaky.gpkg");
    await writeFile(
      file,
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: { type: "Point", coordinates: [1, 2] },
          },
        ],
      }),
    );
    await expect(ingestSource(testAccountScope(), file, "sneaky.gpkg")).rejects.toMatchObject({
      code: "malformed_file",
    });
    expect(listTables()).toEqual([]);
  });
});

describe("kml / kmz", () => {
  it("lands a single-folder KML as one table", async () => {
    const file = path.join(dir, "stops.kml");
    await writeFile(
      file,
      buildKml([
        {
          name: "Stops",
          points: [
            [7.1, 51.1, "A"],
            [7.2, 51.2, "B"],
          ],
        },
      ]),
    );
    const result = await ingestSource(testAccountScope(), file, "stops.kml");
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].name).toBe("stops");
    expect(result.tables[0].format).toBe("kml");
    expect(result.tables[0].rowCount).toBe(2);
    expect(result.tables[0].geometryType).toBe("POINT");
    // KML is WGS84 by specification — declared, never assumed.
    expect(result.tables[0].crsAssumed).toBe(false);
  });

  it("fans a multi-folder KML into one table per folder", async () => {
    const file = path.join(dir, "trip.kml");
    await writeFile(
      file,
      buildKml([
        { name: "Stops", points: [[7.1, 51.1, "A"]] },
        { name: "Sights", points: [[7.3, 51.3, "C"]] },
      ]),
    );
    const result = await ingestSource(testAccountScope(), file, "trip.kml");
    expect(result.tables.map((t) => t.name).sort()).toEqual([
      "trip_sights",
      "trip_stops",
    ]);
    expect(result.tables[0].sourceParams?.group).toBe(
      result.tables[1].sourceParams?.group,
    );
  });

  it("lands a .kmz through the same container road", async () => {
    const kml = buildKml([
      {
        name: "Stops",
        points: [
          [7.1, 51.1, "A"],
          [7.2, 51.2, "B"],
          [7.3, 51.3, "C"],
        ],
      },
    ]);
    const file = path.join(dir, "packed.kmz");
    await writeFile(file, buildZip([{ name: "doc.kml", data: kml }]));
    const result = await ingestSource(testAccountScope(), file, "packed.kmz");
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].name).toBe("packed");
    expect(result.tables[0].rowCount).toBe(3);
    expect(await scratchResidue()).toEqual([]);
  });

  it("refuses a .kmz with no KML document inside", async () => {
    const file = path.join(dir, "empty.kmz");
    await writeFile(file, buildZip([{ name: "notes.txt", data: "hi" }]));
    await expect(ingestSource(testAccountScope(), file, "empty.kmz")).rejects.toMatchObject({
      code: "malformed_file",
    });
    expect(listTables()).toEqual([]);
    expect(await scratchResidue()).toEqual([]);
  });

  it("refuses malformed KML, leaving nothing", async () => {
    const file = path.join(dir, "broken.kml");
    await writeFile(file, "<kml><Document><Folder>never closed");
    await expect(ingestSource(testAccountScope(), file, "broken.kml")).rejects.toMatchObject({
      code: "malformed_file",
    });
    expect(listTables()).toEqual([]);
    expect(await artifactsOnDisk()).toEqual([]);
  });
});

describe("the container road's project context", () => {
  async function bundleOf(stems: string[]): Promise<string> {
    for (const stem of stems) await mintShapefileZip(`${stem}.zip`, { stem });
    const members: ZipMember[] = [];
    for (const stem of stems) {
      const shpDir = path.join(dir, "mint", stem);
      for (const file of await readdir(shpDir)) {
        if (file.startsWith("tmp_")) continue;
        members.push({ name: file, data: await readFile(path.join(shpDir, file)) });
      }
    }
    const bundle = path.join(dir, "group.zip");
    await writeFile(bundle, buildZip(members));
    return bundle;
  }

  it("files every table of the group in the same transaction", async () => {
    const p = createProject(testAccountScope(), { name: "A" });
    const bundle = await bundleOf(["roads", "stops"]);
    const result = await ingestSource(testAccountScope(), bundle, "group.zip", {
      source: "upload",
      sourceParams: null,
      projectId: p.id,
    });
    expect(result.tables.length).toBe(2);
    const memberships = tableProjectIds();
    for (const t of result.tables) expect(memberships.get(t.id)).toEqual([p.id]);
  });

  it("an unknown project rolls the whole group back: no tables, no artifacts", async () => {
    const bundle = await bundleOf(["roads", "stops"]);
    await expect(
      ingestSource(testAccountScope(), bundle, "group.zip", {
        source: "upload",
        sourceParams: null,
        projectId: "p-vanished",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(listTables().length).toBe(0);
    const tablesDir = path.join(process.env.DEZFIL_DATA_DIR!, "tables");
    expect(await readdir(tablesDir).catch(() => [])).toEqual([]);
  });
});
