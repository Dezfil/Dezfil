import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { getTableByName } from "@/lib/metadata/tables";
import { withConnection, resetQueryInstance } from "@/lib/duckdb";
import { boundedEvaluation } from "@/lib/query/bounded";
import { buildZip, type ZipMember } from "../../../test-support/zip";
import { buildGpkg, type GpkgLayer } from "../../../test-support/gpkg";
import { importFromUrl } from "./remote";
import { refreshTable } from "./refresh";
import { refreshUnit, resetRefreshFences } from "./fence";
import { retirementsSettled } from "./retire";

let dir: string;
let server: Server;
let base: string;
/** The layers the fixture server currently serves as city.gpkg. */
let servedLayers: GpkgLayer[];

const stations = (
  rows: [number, number, string][],
): GpkgLayer => ({ name: "stations", kind: "points", rows });
const zones = (): GpkgLayer => ({
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
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
  closeMetadataDb();
  resetRefreshFences();
  resetQueryInstance();
  servedLayers = [
    stations([
      [7.1, 51.1, "a"],
      [7.2, 51.2, "b"],
    ]),
    zones(),
  ];

  server = createServer((req, res) => {
    void (async () => {
      // The gpkg is built fresh per request from `servedLayers`, so a test
      // changes the remote file by reassigning it.
      const file = path.join(dir, `served-${Date.now()}-${Math.random()}.gpkg`);
      buildGpkg(file, servedLayers);
      const body = await readFile(file);
      await rm(file, { force: true });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(body);
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_EGRESS_ALLOWLIST;
  await rm(dir, { recursive: true, force: true });
});

async function artifactsOnDisk(): Promise<string[]> {
  return readdir(path.join(dir, "data", "tables"));
}

/** One evaluation through the real door: registration, then the count. */
async function evalCount(name: string): Promise<number> {
  return boundedEvaluation(async (conn) => {
    const reader = await conn.runAndReadAll(
      `SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`,
    );
    return Number((reader.getRowObjectsJson()[0] as { n: unknown }).n);
  }, { scope: testAccountScope() });
}

describe("URL imports of container formats", () => {
  it("binds the primary fixture listener to the address named by its URL", () => {
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
  });

  it("stores url + layer + group provenance for a multi-layer file", async () => {
    const { tables } = await importFromUrl(testAccountScope(), `${base}/city.gpkg`);
    expect(tables.map((t) => t.name)).toEqual(["city_stations", "city_zones"]);
    for (const t of tables) {
      expect(t.source).toBe("url");
      expect(t.sourceParams?.url).toBe(`${base}/city.gpkg`);
      expect(typeof t.sourceParams?.group).toBe("string");
    }
    expect(tables[0].sourceParams?.group).toBe(tables[1].sourceParams?.group);
    // The group is one refresh unit (mirroring OSM).
    expect(refreshUnit(testAccountScope(), tables[0])).toBe(refreshUnit(testAccountScope(), tables[1]));
    expect(refreshUnit(testAccountScope(), tables[0]).startsWith("url:")).toBe(true);
  });

  it("refreshes the whole group from one download and swaps atomically", async () => {
    const { tables } = await importFromUrl(testAccountScope(), `${base}/city.gpkg`);
    const [st, zn] = tables;
    expect(st.rowCount).toBe(2);

    // Bind BOTH members by evaluating them — the transition is a group
    // whose views are already bound when every artifact swaps in one
    // transaction.
    expect(await evalCount(st.name)).toBe(2);
    expect(await evalCount(zn.name)).toBe(1);

    servedLayers = [
      stations([
        [7.1, 51.1, "a"],
        [7.2, 51.2, "b"],
        [7.3, 51.3, "c"],
        [7.4, 51.4, "d"],
      ]),
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
          [
            [8, 52],
            [8.5, 52],
            [8.5, 52.5],
            [8, 52.5],
            [8, 52],
          ],
        ],
      },
    ];
    const answer = await refreshTable(testAccountScope(), st.name);
    expect(answer.name).toBe(st.name);
    expect(answer.rowCount).toBe(4);
    expect(answer.file).not.toBe(st.file);

    // The sibling refreshed too — one group, one download, one commit.
    const sibling = getTableByName(zn.name)!;
    expect(sibling.file).not.toBe(zn.file);
    expect(sibling.importedAt).toBe(answer.importedAt);
    // Recipes survive the swap untouched.
    expect(getTableByName(st.name)!.sourceParams).toEqual(st.sourceParams);

    // The first evaluation after the group refresh answers EVERY member
    // from its new artifact — the refreshed member and the sibling alike;
    // a single-table check would pass with the sibling still bound to its
    // retired artifact.
    expect(await evalCount(st.name)).toBe(4);
    expect(await evalCount(zn.name)).toBe(2);

    await retirementsSettled();
    const remaining = await artifactsOnDisk();
    expect(remaining).toHaveLength(2);
    expect(remaining).not.toContain(path.basename(st.file));
    expect(remaining).not.toContain(path.basename(zn.file));
  });

  it("fails the whole refresh when a stored layer vanished from the file", async () => {
    const { tables } = await importFromUrl(testAccountScope(), `${base}/city.gpkg`);
    const [st, zn] = tables;

    servedLayers = [
      stations([
        [7.1, 51.1, "a"],
        [7.2, 51.2, "b"],
        [7.3, 51.3, "c"],
      ]),
      // zones is gone from the remote file.
    ];
    await expect(refreshTable(testAccountScope(), st.name)).rejects.toMatchObject({
      code: "malformed_file",
      message: expect.stringContaining('no longer contains layer "zones"'),
    });
    // The group was left as it was: same files, same row counts.
    expect(getTableByName(st.name)!.file).toBe(st.file);
    expect(getTableByName(zn.name)!.file).toBe(zn.file);
    expect(getTableByName(st.name)!.rowCount).toBe(2);
    await retirementsSettled();
    expect(await artifactsOnDisk()).toHaveLength(2);
  });

  it("refreshes a single-layer container import through its stored layer", async () => {
    servedLayers = [
      stations([
        [7.1, 51.1, "a"],
        [7.2, 51.2, "b"],
      ]),
    ];
    const { tables } = await importFromUrl(testAccountScope(), `${base}/city.gpkg`);
    expect(tables).toHaveLength(1);
    const before = tables[0];
    expect(before.sourceParams?.layer).toBe("stations");
    expect(before.sourceParams?.group).toBeUndefined();

    servedLayers = [stations([[7.1, 51.1, "solo"]])];
    const after = await refreshTable(testAccountScope(), before.name);
    expect(after.rowCount).toBe(1);
    expect(after.file).not.toBe(before.file);
  });

  it("imports a Shapefile zip from a URL and refreshes each same-stem member from its own layer", async () => {
    // Two shapefiles both named roads.shp, in different folders — the
    // identities must stay distinct through import AND refresh (review
    // round one), and this is the URL road's Shapefile drive.
    const mint = async (counts: {
      north: number;
      south: number;
    }): Promise<Buffer> => {
      const members: ZipMember[] = [];
      for (const [folder, count] of Object.entries(counts)) {
        const shpDir = path.join(
          dir,
          "mint",
          `${folder}-${count}-${Math.random().toString(36).slice(2)}`,
        );
        await (await import("node:fs/promises")).mkdir(shpDir, {
          recursive: true,
        });
        const shpPath = path.join(shpDir, "roads.shp");
        await withConnection(async (conn) => {
          await conn.run(`
            COPY (
              SELECT i AS id, ST_Point(7.0 + i * 0.01, 51.0 + i * 0.01) AS geom
              FROM range(${count}) t(i)
            ) TO '${shpPath.replace(/'/g, "''")}'
            (FORMAT GDAL, DRIVER 'ESRI Shapefile', SRS 'EPSG:4326')
          `);
        });
        for (const file of await readdir(shpDir)) {
          if (file.startsWith("tmp_")) continue;
          members.push({
            name: `${folder}/${file}`,
            data: await readFile(path.join(shpDir, file)),
          });
        }
      }
      return buildZip(members);
    };

    let servedZip = await mint({ north: 4, south: 2 });
    const extra = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/zip" });
      res.end(servedZip);
    });
    await new Promise<void>((resolve) =>
      extra.listen(0, "127.0.0.1", () => resolve()),
    );
    const origin = `http://127.0.0.1:${(extra.address() as AddressInfo).port}`;
    try {
      // Inside the listener's lifetime, so a failed assertion still closes it.
      expect((extra.address() as AddressInfo).address).toBe("127.0.0.1");
      const { tables } = await importFromUrl(testAccountScope(), `${origin}/regions.zip`);
      const byLayer = new Map(
        tables.map((t) => [String(t.sourceParams?.layer), t]),
      );
      expect(byLayer.get("north/roads")?.rowCount).toBe(4);
      expect(byLayer.get("south/roads")?.rowCount).toBe(2);
      expect(tables[0].format).toBe("shapefile");

      servedZip = await mint({ north: 5, south: 3 });
      await refreshTable(testAccountScope(), byLayer.get("north/roads")!.name);
      expect(
        getTableByName(byLayer.get("north/roads")!.name)!.rowCount,
      ).toBe(5);
      expect(
        getTableByName(byLayer.get("south/roads")!.name)!.rowCount,
      ).toBe(3);
    } finally {
      await new Promise<void>((resolve) => extra.close(() => resolve()));
    }
  });

  it("lands a zipped container (.kmz) through the URL download road", async () => {
    const { buildKml } = await import("../../../test-support/kml");
    const { buildZip } = await import("../../../test-support/zip");
    const kmz = buildZip([
      {
        name: "doc.kml",
        data: buildKml([
          {
            name: "Stops",
            points: [
              [7.1, 51.1, "A"],
              [7.2, 51.2, "B"],
            ],
          },
        ]),
      },
    ]);
    const extra = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(kmz);
    });
    await new Promise<void>((resolve) =>
      extra.listen(0, "127.0.0.1", () => resolve()),
    );
    const origin = `http://127.0.0.1:${(extra.address() as AddressInfo).port}`;
    try {
      // Inside the listener's lifetime, so a failed assertion still closes it.
      expect((extra.address() as AddressInfo).address).toBe("127.0.0.1");
      const { tables, skipped } = await importFromUrl(testAccountScope(), `${origin}/daytrip.kmz`);
      expect(tables).toHaveLength(1);
      expect(tables[0].name).toBe("daytrip");
      expect(tables[0].format).toBe("kml");
      expect(tables[0].rowCount).toBe(2);
      expect(tables[0].sourceParams?.layer).toBe("Stops");
      expect(skipped).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => extra.close(() => resolve()));
    }
  });

  it("keeps container uploads not-refreshable", async () => {
    const file = path.join(dir, "harbours.gpkg");
    buildGpkg(file, [stations([[7.1, 51.1, "a"]])]);
    const { ingestSource } = await import("./gdal-formats");
    const { tables } = await ingestSource(testAccountScope(), file, "harbours.gpkg");
    await expect(refreshTable(testAccountScope(), tables[0].name)).rejects.toMatchObject({
      code: "not_refreshable",
    });
  });
});
