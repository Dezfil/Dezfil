// Import-source matrix, part 2: the service-backed sources, each at the exact depth the
// plan's stub-vs-real table states:
//
// - OVERTURE — stubbed at the SERVER boundary (since): the
//   standalone is launched with DEZFIL_OVERTURE_S3_ENDPOINT pointing at
//   a loopback S3 fixture this suite starts itself (port 31878, parquets
//   minted by DuckDB at startup), so the app's own httpfs client, release
//   listing, count, preview and import road run for REAL; only the S3
//   service itself is imitated — labeled, never claimed end-to-end
//   against the real Overture bucket.
// - OSM — stubbed at the SERVER boundary: the standalone is launched with
//   `DEZFIL_OVERPASS_URL=http://127.0.0.1:31877/overpass` (the real
//   deployment seam, the same one unit tests use), so the app's own
//   Overpass client, cache, and ingest road run for REAL against a
//   recorded-shape Overpass payload; only the Overpass service itself is
//   imitated.
// - POSTGIS — real, live-gated: the failure surface is driven
//   unconditionally (no network wait — a closed local port refuses
//   immediately); the end-to-end import runs against the documented local
//   container when DEZFIL_TEST_PG_URL is configured (the same gate and
//   container as `postgis.live.test.ts`), and SKIPS VISIBLY otherwise:
//     docker run --rm -d -p 54329:5432 -e POSTGRES_PASSWORD=test postgis/postgis:16-3.4
//     DEZFIL_TEST_PG_URL=postgres://postgres:test@127.0.0.1:54329/postgres
//
// Environment: the documented gate plus the launch env above. Run via
// `npm run e2e:imports` with DEZFIL_BASE_URL pointing at the server;
// this suite starts the fixture server on 127.0.0.1:31877 itself.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  OVERTURE_FIXTURE_RELEASE,
  consumeExpected,
  expectMapChanged,
  mapShot,
  routeHouse,
  startFixtureServer,
  startOvertureS3Fixture,
  trackConsole,
} from "./support";

const runId = Date.now().toString(36);
const PG_URL = process.env.DEZFIL_TEST_PG_URL;

const openAddData = async (page: Page) => {
  await page.goto("/data");
  await page.getByRole("button", { name: "Add data" }).first().click();
  await expect(page.getByRole("dialog", { name: "Add data" })).toBeVisible();
  // Source picks are scoped to the dialog: imported tables' gallery
  // cards carry same-named source chips behind the scrim.
  return page.getByRole("dialog", { name: "Add data" });
};

/** Reach the PostGIS connection form (past the saved-connections step
 * that earlier runs may have left behind). */
async function openPostgisForm(page: Page) {
  const dialog = await openAddData(page);
  await dialog.getByText("PostGIS", { exact: true }).first().click();
  const newConn = page.getByRole("button", { name: /New connection/ });
  if (await newConn.isVisible().catch(() => false)) await newConn.click();
  await expect(page.getByText("Connect a PostGIS database")).toBeVisible();
}

async function fillPostgisForm(
  page: Page,
  values: {
    name: string;
    host: string;
    port: string;
    database: string;
    username: string;
    password: string;
  },
) {
  const field = (label: string) =>
    page.locator("label", { hasText: label }).locator("input").first();
  await field("Connection name").fill(values.name);
  await field("Host").fill(values.host);
  await field("Port").fill(values.port);
  await field("Database").fill(values.database);
  await field("Username").fill(values.username);
  await field("Password").fill(values.password);
  // The form defaults SSL on (sslmode=require); the documented local
  // container speaks plain TCP — a real user connecting to it must
  // uncheck SSL, and so does the drive.
  const ssl = page
    .locator("label", { hasText: "Require SSL for this connection" })
    .locator("input");
  if (await ssl.isChecked()) await ssl.uncheck();
}

test("Overture: the real import road through the S3-endpoint seam", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  const overtureTable = `imx2ovt_${runId}`;
  await routeHouse(context, { basemapStyleStub: true });
  // The seam (DEZFIL_OVERTURE_S3_ENDPOINT on the server) points the
  // whole read road — release listing, glob expansion, ranged parquet
  // reads — at this loopback S3 fixture; the app's own httpfs client,
  // count, preview and import then run for REAL.
  const s3 = await startOvertureS3Fixture(31878);
  try {
    // The mini-map inherits its area from the builder's viewport (same
    // fact the OSM drive documents) — seed a Berlin viewport where the
    // fixture's four building polygons live.
    await page.goto("/maps");
    const mapId = await page.evaluate(async () => {
      const r = await fetch("/api/maps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "overture import viewport" }),
      });
      const { id } = (await r.json()) as { id: string };
      const patch = await fetch(`/api/maps/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          viewport: { lng: 13.415, lat: 52.515, zoom: 11, pitch: 0, bearing: 0 },
        }),
      });
      if (!patch.ok) throw new Error(await patch.text());
      return id;
    });
    await page.goto(`/maps/${mapId}`);
    // Canvas base BEFORE the dialog opens (the modal covers the canvas,
    // so a base taken inside it would change on close regardless of
    // paint): the landed layer must actually change these pixels.
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    const preImport = await mapShot(page);
    await page.getByRole("button", { name: "Add layer", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add layer" });
    await expect(dialog).toBeVisible();
    await dialog.getByText("Overture Maps", { exact: true }).first().click();
    // The release picker resolved the fixture's real release — served by
    // the seam's listing endpoint, not a stub. (An <option> is never
    // "visible"; the select's committed value is the assertion.)
    await expect(dialog.locator("#ovt-release")).toHaveValue(
      OVERTURE_FIXTURE_RELEASE,
      { timeout: 15_000 },
    );
    await page.getByRole("button", { name: "Buildings", exact: true }).click();
    await expect(page.getByText("Selected area")).toBeVisible();
    // Run Query counts and previews over the fixture parquet itself.
    await page.getByRole("button", { name: "Run Query", exact: true }).click();
    await expect(page.getByText(/Showing 4 features/)).toBeVisible({
      timeout: 30_000,
    });
    // The source query is one click away, read-only, and live — the
    // settings stay enabled while it is open and the query follows
    // them; nothing here can arm a custom query.
    const srcDrawer = page.getByRole("region", { name: "Source query" });
    await expect(srcDrawer).toBeHidden();
    await page.getByRole("button", { name: "View query", exact: true }).click();
    await expect(srcDrawer).toBeVisible();
    const srcEditor = srcDrawer.getByRole("textbox", {
      name: "Overture source query",
    });
    await expect(srcEditor).toContainText("buildings");
    await page.getByRole("button", { name: "Places", exact: true }).click();
    await expect(srcEditor).toContainText("places");
    await page.getByRole("button", { name: "Buildings", exact: true }).click();
    await expect(srcEditor).toContainText("buildings");
    await srcDrawer.getByRole("button", { name: "Close" }).click();
    await expect(srcDrawer).toBeHidden();
    // The run result invalidated on the theme flip — re-run before the
    // import so the drive keeps asserting the same road as before.
    await page.getByRole("button", { name: "Run Query", exact: true }).click();
    await expect(page.getByText(/Showing 4 features/)).toBeVisible({
      timeout: 30_000,
    });
    await page.locator("#ovt-name").fill(overtureTable);
    await page
      .getByRole("button", { name: "Import as table", exact: true })
      .click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    // A REAL GeoParquet table landed and the builder added it as a layer.
    await expect(
      page.getByRole("button", { name: new RegExp(overtureTable) }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expectMapChanged(page, preImport);
    const listed = await page.evaluate(async (name) => {
      const tables = (await (await fetch("/api/tables")).json()) as {
        name: string;
        rowCount: number;
        source: string;
        geometryColumn: string | null;
      }[];
      return tables.find((t) => t.name === name) ?? null;
    }, overtureTable);
    expect(listed?.source).toBe("overture");
    expect(listed?.rowCount).toBe(4);
    expect(listed?.geometryColumn).not.toBeNull();

    // The FAILURE presentation at the SAME seam depth (the OSM drive's
    // convention): the fixture goes away, the app's own read fails, and
    // the pane presents the documented remote_fetch_failed sentence.
    // (The release list is cached in-process, so the pane still opens.)
    await s3.close();
    await page.getByRole("button", { name: "Add layer", exact: true }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByText("Overture Maps", { exact: true }).first().click();
    await page.getByRole("button", { name: "Buildings", exact: true }).click();
    await expect(page.getByText("Selected area")).toBeVisible();
    await page.getByRole("button", { name: "Run Query", exact: true }).click();
    await expect(dialog.locator('[role="alert"]')).toContainText(
      "Could not read Overture data from S3",
      { timeout: 30_000 },
    );
    await consumeExpected(consoleErrors, /\/api\/imports\/overture/);
  } finally {
    await s3.close();
  }

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

test("OSM: the real import road through the Overpass seam", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  const osmName = `imx2osm_${runId}`;
  await routeHouse(context, { basemapStyleStub: true });
  const fixtures = await startFixtureServer(31877);
  try {
    // The mini-map inherits its area from the builder's viewport; a
    // dialog opened from /data starts world-sized and trips the
    // documented area cap. Real users import from where they look —
    // seed a Berlin viewport and open the dialog in the builder.
    await page.goto("/maps");
    const mapId = await page.evaluate(async () => {
      const r = await fetch("/api/maps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "osm import viewport" }),
      });
      const { id } = (await r.json()) as { id: string };
      const patch = await fetch(`/api/maps/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          viewport: { lng: 13.41, lat: 52.52, zoom: 11, pitch: 0, bearing: 0 },
        }),
      });
      if (!patch.ok) throw new Error(await patch.text());
      return id;
    });
    await page.goto(`/maps/${mapId}`);
    await page.getByRole("button", { name: "Add layer", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add layer" });
    await expect(dialog).toBeVisible();
    await dialog.getByText("OpenStreetMap", { exact: true }).first().click();
    // The inherited rect scope is armed; pick a real preset.
    await page.getByRole("button", { name: "Amenities", exact: true }).click();
    await page.locator("#osm-name").fill(osmName);
    await page
      .getByRole("button", { name: "Import as table", exact: true })
      .click();
    // The SERVER queried the Overpass seam and landed a real GeoParquet
    // table — the points class of the recorded payload's six cafés; the
    // builder adds it as a layer the moment the import returns.
    await expect(
      page.getByRole("button", { name: new RegExp(`${osmName}_points`) }).first(),
    ).toBeVisible({ timeout: 30_000 });
    const listed = await page.evaluate(async (name) => {
      const tables = (await (await fetch("/api/tables")).json()) as {
        name: string;
        rowCount: number;
        source: string;
      }[];
      return tables.find((t) => t.name === name) ?? null;
    }, `${osmName}_points`);
    expect(listed?.source).toBe("osm");
    expect(listed?.rowCount).toBe(6);

    // The query disclosure. Hidden by default, one click away; opening
    // disables the form and both actions; cancel restores the form
    // path; only acceptance arms the custom query — and an accepted
    // custom query drives a real import through the seam.
    const customName = `${osmName}_custom`;
    await page.getByRole("button", { name: "Add layer", exact: true }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByText("OpenStreetMap", { exact: true }).first().click();
    const drawer = page.getByRole("region", { name: "Overpass query" });
    await expect(drawer).toBeHidden();
    // Name it while the form is still live — an armed custom query
    // detaches the form, name field included.
    await page.locator("#osm-name").fill(customName);
    const runBtn = page.getByRole("button", { name: "Run Query", exact: true });
    const importBtn = page.getByRole("button", {
      name: "Import as table",
      exact: true,
    });
    await expect(importBtn).toBeEnabled();
    await page.getByRole("button", { name: "Edit query", exact: true }).click();
    await expect(drawer).toBeVisible();
    await expect(runBtn).toBeDisabled();
    await expect(importBtn).toBeDisabled();
    await expect(dialog.locator("[data-disabled]")).toHaveCount(1);
    // Cancel: the draft dies, the form returns, nothing marked custom.
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(page.getByText("Custom query", { exact: true })).toBeHidden();
    await expect(importBtn).toBeEnabled();
    await expect(dialog.locator("[data-disabled]")).toHaveCount(0);
    // Accept: the edited query is armed, visibly custom, and imports.
    await page.getByRole("button", { name: "Edit query", exact: true }).click();
    const qlEditor = page.getByRole("textbox", {
      name: "Custom Overpass query",
    });
    await expect(qlEditor).toBeVisible();
    await qlEditor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(
      '[out:json][timeout:60];(node["amenity"="cafe"]({{bbox}}););out geom;',
    );
    await page.getByRole("button", { name: "Use query", exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(page.getByText("Custom query", { exact: true })).toBeVisible();
    await expect(dialog.locator("[data-disabled]")).toHaveCount(1);
    await importBtn.click();
    await expect(
      page.getByRole("button", { name: new RegExp(`${customName}_points`) }).first(),
    ).toBeVisible({ timeout: 30_000 });
    const customListed = await page.evaluate(async (name) => {
      const tables = (await (await fetch("/api/tables")).json()) as {
        name: string;
        rowCount: number;
        source: string;
      }[];
      return tables.find((t) => t.name === name) ?? null;
    }, `${customName}_points`);
    expect(customListed?.source).toBe("osm");
    expect(customListed?.rowCount).toBe(6);

    // The FAILURE presentation, at the same seam depth as the success
    // above: the Overpass endpoint answers 504, so the
    // app's own client raises its documented timeout sentence and the
    // pane presents it — dialog still open, nothing landed.
    //
    // A DIFFERENT preset on purpose. Overpass answers cache on disk keyed
    // by endpoint + normalized query (a real product behavior this drive
    // rediscovered): re-running the Amenities query would be served from
    // cache and never reach the armed seam, and a drive that cannot reach
    // the seam cannot prove the seam's failure.
    fixtures.failOverpass(504);
    await page.getByRole("button", { name: "Add layer", exact: true }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByText("OpenStreetMap", { exact: true }).first().click();
    await page.getByRole("button", { name: "Landuse", exact: true }).click();
    await page.locator("#osm-name").fill(`${osmName}_fail`);
    await page
      .getByRole("button", { name: "Import as table", exact: true })
      .click();
    await expect(dialog.locator('[role="alert"]')).toContainText(
      "The Overpass endpoint timed out on this query. Narrow the area or " +
        "the tags and retry.",
    );
    await consumeExpected(consoleErrors, /\/api\/imports\/osm/);
    const after = await page.evaluate(async (name) => {
      const tables = (await (await fetch("/api/tables")).json()) as {
        name: string;
      }[];
      return tables.some((t) => t.name.startsWith(name));
    }, `${osmName}_fail`);
    expect(after).toBe(false);
    fixtures.failOverpass(null);
  } finally {
    await fixtures.close();
  }

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

test("PostGIS: an unreachable server refuses with the documented copy, nothing saved", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await openPostgisForm(page);
  await fillPostgisForm(page, {
    name: "e2e unreachable",
    host: "127.0.0.1",
    port: "1", // a closed local port refuses immediately — no network wait
    database: "postgres",
    username: "postgres",
    password: "wrong",
  });
  await page
    .getByRole("button", { name: "Test & save connection", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "Add data" })
      .locator('[role="alert"]'),
  ).toContainText("The server is unreachable. Check host, port, and network.");
  await consumeExpected(consoleErrors, /\/api\/connections\/postgis/);
  // Tested first, saved only on success: no connection persisted.
  const saved = await page.evaluate(async () => {
    const r = await fetch("/api/connections/postgis");
    return (await r.json()) as { name: string }[];
  });
  expect(saved.find((c) => c.name === "e2e unreachable")).toBeUndefined();

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

test("PostGIS: connect, browse, snapshot — real and end-to-end (live-gated)", async ({
  page,
  context,
}) => {
  test.skip(
    !PG_URL,
    "DEZFIL_TEST_PG_URL not configured — start the documented container " +
      "and set the URL to run the real PostGIS road (see header). " +
      "Skipping VISIBLY, never silently.",
  );
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  const pg = new URL(PG_URL!);
  const target = {
    host: pg.hostname,
    port: pg.port || "5432",
    database: pg.pathname.replace(/^\//, "") || "postgres",
    username: decodeURIComponent(pg.username || "postgres"),
    password: decodeURIComponent(pg.password || ""),
  };

  await test.step("seed the source table in the live PostGIS", async () => {
    const { DuckDBInstance } = await import("@duckdb/node-api");
    // Honor the server's extension-bundle convention (src/lib/duckdb.ts):
    // with DUCKDB_EXTENSION_DIR set, INSTALL resolves locally instead of
    // fetching from extensions.duckdb.org mid-suite.
    const config: Record<string, string> = {};
    if (process.env.DUCKDB_EXTENSION_DIR) {
      config.extension_directory = process.env.DUCKDB_EXTENSION_DIR;
    }
    const instance = await DuckDBInstance.create(":memory:", config);
    const conn = await instance.connect();
    await conn.run("INSTALL postgres; LOAD postgres;");
    const attach =
      `host=${target.host} port=${target.port} dbname=${target.database} ` +
      `user=${target.username} password=${target.password}`;
    await conn.run(
      `ATTACH '${attach.replace(/'/g, "''")}' AS seedpg (TYPE postgres)`,
    );
    for (const sql of [
      "CREATE EXTENSION IF NOT EXISTS postgis",
      "DROP TABLE IF EXISTS public.e2estations",
      `CREATE TABLE public.e2estations (
         id int PRIMARY KEY, name text, riders int,
         geom geometry(Point, 4326))`,
      `INSERT INTO public.e2estations VALUES
        (1, 'Alexanderplatz', 10450, ST_SetSRID(ST_MakePoint(13.4133, 52.5219), 4326)),
        (2, 'Hauptbahnhof', 22310, ST_SetSRID(ST_MakePoint(13.3696, 52.5251), 4326)),
        (3, 'Ostkreuz', 8900, ST_SetSRID(ST_MakePoint(13.4692, 52.5031), 4326)),
        (4, 'Zoo', 15600, ST_SetSRID(ST_MakePoint(13.3326, 52.5073), 4326)),
        (5, 'Gesundbrunnen', 7200, ST_SetSRID(ST_MakePoint(13.3885, 52.5487), 4326))`,
    ]) {
      await conn.run(
        `CALL postgres_execute('seedpg', '${sql.replace(/'/g, "''")}')`,
      );
    }
  });

  const snapshotName = `imx2pg_${runId}`;
  await test.step("connect and browse through the real pane", async () => {
    await openPostgisForm(page);
    await fillPostgisForm(page, {
      name: `e2e live ${runId}`,
      ...target,
    });
    await page
      .getByRole("button", { name: "Test & save connection", exact: true })
      .click();
    // The catalogue lists the seeded table with its geometry and rows.
    const row = page.getByRole("button", { name: /^e2estations.*table/i });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
  });

  await test.step("snapshot lands as a real GeoParquet table", async () => {
    await page
      .locator("label", { hasText: "Table name" })
      .locator("input")
      .fill(snapshotName);
    await page
      .getByRole("button", { name: "Import e2estations" })
      .click();
    await expect(
      page.getByRole("heading", { name: `Imported as ${snapshotName}` }),
    ).toBeVisible({ timeout: 30_000 });
    const listed = await page.evaluate(async (name) => {
      const tables = (await (await fetch("/api/tables")).json()) as {
        name: string;
        rowCount: number;
        source: string;
      }[];
      return tables.find((t) => t.name === name) ?? null;
    }, snapshotName);
    expect(listed?.source).toBe("postgis");
    expect(listed?.rowCount).toBe(5);
  });

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});
