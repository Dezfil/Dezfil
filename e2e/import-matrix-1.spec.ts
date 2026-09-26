// Import-source matrix, part 1: the file road — upload in all three
// supported formats through the real dialog, URL import end-to-end
// against a loopback fixture server, and the admission and refusal
// surfaces for the URL road and the object-store schemes.
//
// Stub-vs-real (plan): uploads and the http URL drive are REAL end to
// end — the standalone server fetches the fixture bytes itself, admitted
// by the documented `DEZFIL_EGRESS_ALLOWLIST=127.0.0.1` at server launch
// (the egress guard blocks loopback by default). The refusal branches
// never wait on the network: an un-allowlisted loopback address refuses
// at the guard, and object-store URLs refuse at format admission before
// any fetch. The GeoParquet upload fixture is minted by the product's
// own exporter — real bytes, no committed binary, no network.
//
// Environment: the documented gate plus the launch env above. Run via
// `npm run e2e:imports` with DEZFIL_BASE_URL pointing at the server;
// this suite starts the fixture server on 127.0.0.1:31877 itself.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import { buildZip } from "../test-support/zip";
import { buildGpkg } from "../test-support/gpkg";
import { buildKml } from "../test-support/kml";
import { mintShapefileZip } from "./mint-shapefile";
import {
  FIXTURES_DIR,
  addLayer,
  createMap,
  consumeExpected,
  routeHouse,
  startFixtureServer,
  trackConsole,
} from "./support";

const runId = Date.now().toString(36);
const csvTable = `imx1csv_${runId}`;
const geojsonTable = `imx1gj_${runId}`;
const parquetTable = `imx1pq_${runId}`;
const urlTable = `imx1url_${runId}`;
const shpTable = `imx1shp_${runId}`;
const shpNoPrjTable = `imx1shpnp_${runId}`;
const gpkgBase = `imx1gpkg_${runId}`;
const kmzTable = `imx1kmz_${runId}`;
const urlGpkgBase = `imx1rg_${runId}`;

/** A three-member GeoPackage: two spatial layers plus an attribute table
 * the import must skip. */
async function mintGpkg(): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imx1-gpkg-"));
  try {
    const file = path.join(dir, "fixture.gpkg");
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
    return await readFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function mintKmz(): Buffer {
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
  return buildZip([{ name: "doc.kml", data: kml }]);
}

const EGRESS_COPY =
  "The requested address is not reachable from this server: loopback, " +
  "private-network, link-local, and metadata addresses are blocked by " +
  "default. Specific hosts can be allowed with " +
  "DEZFIL_EGRESS_ALLOWLIST.";

/** Upload in-memory bytes through the real Add-data dialog. */
async function uploadViaDialog(
  page: Page,
  filename: string,
  buffer: Buffer,
  mimeType: string,
  expectLink: string,
) {
  await page.getByRole("button", { name: "Add data" }).first().click();
  await expect(page.getByRole("dialog", { name: "Add data" })).toBeVisible();
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: filename, mimeType, buffer });
  await expect(
    page.getByRole("link", { name: new RegExp(expectLink) }),
  ).toBeVisible({ timeout: 30_000 });
}

test("upload formats, URL end-to-end, and the refusal surfaces", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context);
  const remoteGpkg = await mintGpkg();
  const fixtures = await startFixtureServer(31877, {
    files: { "remote.gpkg": remoteGpkg },
  });

  try {
    await page.goto("/data");
  // The view preference is workspace-global: ask for the grid.
  await page.getByRole("button", { name: "Grid view", exact: true }).click();

    await test.step("upload: CSV through the dialog", async () => {
      await uploadViaDialog(
        page,
        `${csvTable}.csv`,
        readFileSync(path.join(FIXTURES_DIR, "stations.csv")),
        "text/csv",
        csvTable,
      );
    });

    await test.step("upload: GeoJSON through the dialog", async () => {
      await uploadViaDialog(
        page,
        `${geojsonTable}.geojson`,
        readFileSync(path.join(FIXTURES_DIR, "stations.geojson")),
        "application/geo+json",
        geojsonTable,
      );
    });

    await test.step("upload: GeoParquet through the dialog (bytes minted by the exporter)", async () => {
      const b64 = await page.evaluate(async (name) => {
        const r = await fetch(`/api/tables/${name}/export?format=geoparquet`);
        if (!r.ok) throw new Error(await r.text());
        const bytes = new Uint8Array(await r.arrayBuffer());
        let s = "";
        for (const b of bytes) s += String.fromCharCode(b);
        return btoa(s);
      }, csvTable);
      await uploadViaDialog(
        page,
        `${parquetTable}.parquet`,
        Buffer.from(b64, "base64"),
        "application/octet-stream",
        parquetTable,
      );
    });

    await test.step("upload: Shapefile zip — declared CRS, and the.prj-less flag", async () => {
      await uploadViaDialog(
        page,
        `${shpTable}.zip`,
        await mintShapefileZip({ includePrj: true }),
        "application/zip",
        shpTable,
      );
      await uploadViaDialog(
        page,
        `${shpNoPrjTable}.zip`,
        await mintShapefileZip({ includePrj: false }),
        "application/zip",
        shpNoPrjTable,
      );
    });

    await test.step("upload: multi-layer GeoPackage lands one table per spatial layer", async () => {
      await uploadViaDialog(
        page,
        `${gpkgBase}.gpkg`,
        await mintGpkg(),
        "application/octet-stream",
        `${gpkgBase}_stations`,
      );
      await expect(
        page.getByRole("link", { name: new RegExp(`${gpkgBase}_zones`) }),
      ).toBeVisible({ timeout: 30_000 });

      // The skipped attribute member is visible AFTER the dialog closed
      // — a transient notice naming member and reason.
      await expect(
        page.getByRole("dialog", { name: "Add data" }),
      ).toHaveCount(0);
      const notice = page.getByRole("status");
      await expect(notice).toContainText("Skipped 1 member");
      await expect(notice).toContainText("lookup");
      await expect(notice).toContainText("no geometry");
      // Transient per the existing notice pattern: it expires on its own.
      await expect(notice).toHaveCount(0, { timeout: 10_000 });
    });

    await test.step("upload: KMZ through the same container road", async () => {
      await uploadViaDialog(
        page,
        `${kmzTable}.kmz`,
        mintKmz(),
        "application/vnd.google-earth.kmz",
        kmzTable,
      );
      // Nothing was skipped here — no notice appears. The skip notice
      // fires before the created table renders its link, so absence
      // after the link is a settled fact, not a race.
      await expect(
        page.getByRole("status").filter({ hasText: "Skipped" }),
      ).toHaveCount(0);
    });

    await test.step("the landed container tables carry the measured facts", async () => {
      const tables = await page.evaluate(async () => {
        return (await (await fetch("/api/tables")).json()) as {
          name: string;
          rowCount: number;
          geometryType: string | null;
          crsAssumed: boolean;
          format: string;
        }[];
      });
      const byName = new Map(tables.map((t) => [t.name, t]));
      expect(byName.get(shpTable)).toMatchObject({
        rowCount: 5,
        geometryType: "POINT",
        crsAssumed: false,
        format: "shapefile",
      });
      expect(byName.get(shpNoPrjTable)).toMatchObject({
        rowCount: 5,
        geometryType: "POINT",
        crsAssumed: true,
      });
      expect(byName.get(`${gpkgBase}_stations`)).toMatchObject({
        rowCount: 3,
        geometryType: "POINT",
        format: "geopackage",
      });
      expect(byName.get(`${gpkgBase}_zones`)).toMatchObject({
        rowCount: 1,
        geometryType: "POLYGON",
      });
      expect(byName.get(kmzTable)).toMatchObject({
        rowCount: 3,
        geometryType: "POINT",
        format: "kml",
      });
    });

    await test.step("upload: the file source's own refusal presentation", async () => {
      // The third source's failure half: bytes the
      // server refuses come back as the documented format sentence in the
      // upload zone's alert — the dialog stays open, nothing lands.
      await page.getByRole("button", { name: "Add data" }).first().click();
      const dialog = page.getByRole("dialog", { name: "Add data" });
      await expect(dialog).toBeVisible();
      await page.locator('input[type="file"]').setInputFiles({
        name: "not-geodata.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("name,lon,lat\nnope,0,0\n"),
      });
      await expect(dialog.locator('[role="alert"]')).toContainText(
        'Unsupported file type ".txt". Supported formats: GeoParquet ' +
          "(.parquet, .geoparquet), GeoJSON (.geojson, .json), CSV (.csv), " +
          "Shapefile (.zip), GeoPackage (.gpkg), KML (.kml, .kmz).",
      );
      await expect(dialog).toBeVisible();
      // The refused upload's expected console shadow (a 415 on the upload
      // XHR), consumed like every other injected-refusal shadow here.
      await consumeExpected(consoleErrors, /\/api\/tables/);
      await page.keyboard.press("Escape");
      const landed = await page.evaluate(async () => {
        const tables = (await (await fetch("/api/tables")).json()) as {
          name: string;
        }[];
        return tables.some((t) => t.name.includes("not-geodata"));
      });
      expect(landed).toBe(false);
    });

    await test.step("URL refusals: egress guard, scheme admission, format admission — no network waits", async () => {
      await page.getByRole("button", { name: "Add data" }).first().click();
      await page.getByRole("tab", { name: "From URL" }).click();
      const url = page.getByLabel("File URL");
      const importBtn = page.getByRole("button", { name: /Import as table/ });
      const alert = page
        .getByRole("dialog", { name: "Add data" })
        .locator('[role="alert"]');

      // An un-allowlisted loopback address: the documented egress refusal.
      await url.fill(`http://127.0.0.2:31877/files/stations.geojson`);
      await importBtn.click();
      await expect(alert).toContainText(EGRESS_COPY);
      await consumeExpected(consoleErrors, /\/api\/imports\/url/);

      // An unsupported scheme names what IS supported.
      await url.fill("ftp://example.com/data.geojson");
      await importBtn.click();
      await expect(alert).toContainText(
        'Unsupported URL scheme "ftp:". Supported: https://, http://, s3://, gs://, az://.',
      );
      await consumeExpected(consoleErrors, /\/api\/imports\/url/);

      // Each object-store scheme passes scheme admission and refuses at
      // format admission — before any fetch, so nothing waits on a store.
      for (const objectUrl of [
        "s3://fixture-bucket/data.txt",
        "gs://fixture-bucket/data.txt",
        "az://fixture-account/data.txt",
      ]) {
        await url.fill(objectUrl);
        await importBtn.click();
        await expect(alert).toContainText('Unsupported file type ".txt"');
        await consumeExpected(consoleErrors, /\/api\/imports\/url/);
      }
    });

    await test.step("URL import end-to-end: the server reads the fixture host through the allowlist", async () => {
      const url = page.getByLabel("File URL");
      await url.fill(`${fixtures.origin}/files/stations.geojson`);
      const name = page.getByLabel("Table name");
      await name.fill(urlTable);
      await page.getByRole("button", { name: /Import as table/ }).click();
      await expect(
        page.getByRole("link", { name: new RegExp(urlTable) }),
      ).toBeVisible({ timeout: 30_000 });
    });

    await test.step("URL import of a multi-layer GeoPackage fans out identically", async () => {
      await page.getByRole("button", { name: "Add data" }).first().click();
      await page.getByRole("tab", { name: "From URL" }).click();
      const url = page.getByLabel("File URL");
      await url.fill(`${fixtures.origin}/files/remote.gpkg`);
      const name = page.getByLabel("Table name");
      await name.fill(urlGpkgBase);
      await page.getByRole("button", { name: /Import as table/ }).click();
      await expect(
        page.getByRole("link", { name: new RegExp(`${urlGpkgBase}_stations`) }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByRole("link", { name: new RegExp(`${urlGpkgBase}_zones`) }),
      ).toBeVisible({ timeout: 30_000 });
    });

    await test.step("every landed table renders as a layer", async () => {
      await page.goto("/maps");
      const mapId = await createMap(page, "import matrix renders");
      const cases: [string, number][] = [
        [csvTable, 12],
        [geojsonTable, 6],
        [parquetTable, 12],
        [urlTable, 6],
        [shpTable, 5],
        [shpNoPrjTable, 5],
        [`${gpkgBase}_stations`, 3],
        [`${gpkgBase}_zones`, 1],
        [kmzTable, 3],
        [`${urlGpkgBase}_stations`, 3],
        [`${urlGpkgBase}_zones`, 1],
      ];
      for (const [table, features] of cases) {
        const layerId = await addLayer(
          page,
          mapId,
          table,
          `SELECT * FROM ${table}`,
        );
        const render = await page.evaluate(async (id) => {
          const r = await fetch(`/api/layers/${id}/render`);
          if (!r.ok) throw new Error(await r.text());
          return (await r.json()) as { featureCount?: number; mode?: string };
        }, layerId);
        expect(render.featureCount, `${table} renders`).toBe(features);
      }
      // The batched map paints in the builder with a clean console.
      await page.goto(`/maps/${mapId}`);
      await expect(page.locator(".maplibregl-canvas")).toBeVisible();
      await expect(
        page.getByRole("button", { name: new RegExp(csvTable) }).first(),
      ).toBeVisible({ timeout: 30_000 });
    });

    await test.step("builder: the skip notice reaches the whisper after the dialog closes", async () => {
      await page.getByRole("button", { name: "Add layer", exact: true }).click();
      // The rail entry carries a description in its accessible name.
      await page.getByText("Files", { exact: true }).first().click();
      await expect(
        page.getByRole("dialog", { name: "Add layer" }),
      ).toBeVisible();
      await page.locator('input[type="file"]').setInputFiles({
        name: `${gpkgBase}b.gpkg`,
        mimeType: "application/octet-stream",
        buffer: await mintGpkg(),
      });
      await expect(
        page.getByRole("dialog", { name: "Add layer" }),
      ).toHaveCount(0, { timeout: 30_000 });
      await expect(page.getByText(/Skipped 1 member/)).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByText(/lookup \(no geometry/)).toBeVisible();
      // Both spatial members became builder layers through the dialog
      // road — the fan-out itself, not just the notice.
      await expect(
        page.getByRole("button", { name: new RegExp(`${gpkgBase}b_stations`) }).first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByRole("button", { name: new RegExp(`${gpkgBase}b_zones`) }).first(),
      ).toBeVisible();
    });

    const unexpected = consoleErrors.filter(
      (e) => !isAllowedConsoleError(e.text, e.url),
    );
    expect(unexpected).toEqual([]);
  } finally {
    await fixtures.close();
  }
});
