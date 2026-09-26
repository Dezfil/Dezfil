// The PostGIS pane: browser-owned flow and pixel evidence. The source
// boundary is mocked as connections.spec.ts is; the disposable live suite
// separately owns PostgreSQL catalogue and GeoParquet import truth.
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page, Route } from "@playwright/test";
import type { DataTable } from "../src/components/api";
import { createMap, routeHouse, trackConsole } from "./support";
import { isAllowedConsoleError } from "./console-allowlist";

const NOW = "2026-08-31T10:00:00.000Z";
// A month back, as the connections journey pins it: the relative-time label
// then renders a coarse unit that cannot drift between a baseline and its
// comparison minutes later.
const CHECKED_AT = "2026-08-01T10:00:00.000Z";

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
});

const connection = {
  id: "connection-fixture",
  name: "Berlin production",
  host: "db.internal",
  port: 5432,
  database: "mobility",
  username: "reader",
  ssl: true,
  createdAt: NOW,
  updatedAt: NOW,
  status: "connected",
  lastCheckedAt: CHECKED_AT,
  lastCheckError: null,
  serverVersion: "PostgreSQL 17.2",
  postgisVersion: "3.5.2",
};

const relations = [
  {
    schema: "public",
    table: "roads",
    kind: "table",
    system: false,
    geometryColumn: "geom",
    geometryType: "POINT",
    srid: 4326,
    spatialKind: "geometry",
    approxRows: 3,
  },
  {
    schema: "public",
    table: "lookup",
    kind: "table",
    system: false,
    geometryColumn: null,
    geometryType: null,
    srid: null,
    spatialKind: null,
    approxRows: null,
  },
  {
    schema: "analytics",
    table: "districts",
    kind: "materialized_view",
    system: false,
    geometryColumn: "boundary",
    geometryType: "MULTIPOLYGON",
    srid: 4326,
    spatialKind: "geography",
    approxRows: 0,
  },
  {
    schema: "pg_catalog",
    table: "ordinary_extension_member",
    kind: "table",
    system: true,
    geometryColumn: "geom",
    geometryType: "POINT",
    srid: 4326,
    spatialKind: "geometry",
    approxRows: 1,
  },
  {
    schema: "pg_catalog",
    table: "system_view",
    kind: "view",
    system: true,
    geometryColumn: null,
    geometryType: null,
    srid: null,
    spatialKind: null,
  },
] as const;

function fixtureSchemaName(schema: (typeof relations)[number]["schema"]): string {
  const grouped = relations.filter((relation) => relation.schema === schema);
  const spatial = grouped.filter((relation) => relation.spatialKind !== null).length;
  return `${schema} ${spatial} spatial · ${grouped.length - spatial} attribute`;
}

type LayerMode = "created" | "rejected" | "unconfirmed" | "held";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

function importedTable(
  name: string,
  sourceTable: string,
  spatial: boolean,
): DataTable & { sizeBytes: number; projectIds: string[] } {
  // The documented listing shape: every table carries its project
  // memberships; the Data page reads them (an earlier listing shape
  // crashed the page behind the import completion).
  return {
    id: `table-${name}`,
    name,
    projectIds: [],
    sourceFilename: null,
    format: "geoparquet" as const,
    file: `tables/${name}.parquet`,
    geometryColumn: spatial ? "geom" : null,
    geometryType: spatial ? "POINT" : null,
    crsAssumed: false,
    headerSuspect: false,
    rowCount: spatial ? 3 : 2,
    createdAt: NOW,
    source: "postgis" as const,
    sourceParams: {
      connectionId: connection.id,
      connectionName: connection.name,
      schema: "public",
      table: sourceTable,
    },
    importedAt: NOW,
    sizeBytes: 2048,
  };
}

async function installFixture(context: BrowserContext) {
  let tables: ReturnType<typeof importedTable>[] = [];
  let tableListReads = 0;
  let layerRequests = 0;
  let layerMode: LayerMode = "created";
  let heldStarted: (() => void) | null = null;
  let heldRelease: (() => void) | null = null;
  let heldStart = Promise.resolve();
  let heldGate = Promise.resolve();
  let previewHeld = false;
  let previewStarted: (() => void) | null = null;
  let previewRelease: (() => void) | null = null;
  let previewStart = Promise.resolve();
  let previewGate = Promise.resolve();

  await routeHouse(context, {
    basemapStyleStub: true,
    handler: async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      const method = request.method();

      if (pathname === "/api/connections/postgis" && method === "GET") {
        await json(route, [connection]);
        return true;
      }
      if (
        pathname === `/api/connections/postgis/${connection.id}/tables` &&
        method === "GET"
      ) {
        await json(route, { tables: relations });
        return true;
      }
      if (
        pathname === `/api/connections/postgis/${connection.id}/preview` &&
        method === "POST"
      ) {
        if (previewHeld) {
          previewStarted?.();
          await previewGate;
          previewHeld = false;
        }
        const body = request.postDataJSON() as { table: string; filter?: string };
        if (body.filter?.includes("missing_column")) {
          await json(
            route,
            {
              error: {
                code: "query_error",
                message: 'Column "missing_column" does not exist.',
              },
            },
            400,
          );
          return true;
        }
        const relation = relations.find((item) => item.table === body.table)!;
        const columns = relation.geometryColumn
          ? [
              { name: "id", type: "INTEGER", spatialKind: null },
              { name: "name", type: "VARCHAR", spatialKind: null },
              {
                name: relation.geometryColumn,
                type: relation.spatialKind === "geography" ? "GEOGRAPHY" : "GEOMETRY",
                spatialKind: relation.spatialKind,
              },
            ]
          : [
              { name: "id", type: "INTEGER", spatialKind: null },
              { name: "label", type: "VARCHAR", spatialKind: null },
            ];
        const rows = body.filter?.includes("1 = 0")
          ? []
          : [
              {
                id: 1,
                name: body.filter ? "Filtered park" : "Tiergarten road",
                label: "Primary",
                ...(relation.geometryColumn
                  ? { [relation.geometryColumn]: "POINT(13.35 52.51)" }
                  : {}),
              },
            ];
        await json(route, { columns, rows });
        return true;
      }
      if (pathname === "/api/imports/postgis" && method === "POST") {
        const body = request.postDataJSON() as {
          name?: string;
          table: string;
        };
        const spatial = body.table !== "lookup";
        const table = importedTable(body.name || body.table, body.table, spatial);
        tables = [...tables.filter((item) => item.name !== table.name), table];
        await json(route, table, 201);
        return true;
      }
      if (pathname === "/api/imports/url" && method === "POST") {
        const table: DataTable & { sizeBytes: number; projectIds: string[] } = {
          ...importedTable("neighbor_url", "neighbor_url", false),
          source: "url" as const,
          sourceParams: { url: "https://fixtures.test/neighbor.csv" },
        };
        tables = [...tables, table];
        await json(route, table, 201);
        return true;
      }
      if (pathname === "/api/tables" && method === "GET") {
        tableListReads += 1;
        await json(route, tables);
        return true;
      }
      if (/^\/api\/tables\/[^/]+$/.test(pathname) && method === "GET") {
        const name = decodeURIComponent(pathname.split("/").at(-1)!);
        const table = tables.find((item) => item.name === name)!;
        await json(route, {
          ...table,
          columns: [
            { name: "id", type: "INTEGER" },
            { name: "name", type: "VARCHAR" },
          ],
          preview: [{ id: 1, name: "Tiergarten road" }],
          inputs: null,
        });
        return true;
      }
      if (/^\/api\/tables\/[^/]+\/features$/.test(pathname) && method === "GET") {
        await json(route, {
          ok: false,
          name: pathname.split("/").at(-2),
          geometryType: null,
          reason: "Map preview omitted by the browser fixture.",
        });
        return true;
      }

      const layerMatch = pathname.match(/^\/api\/maps\/([^/]+)\/layers$/);
      if (layerMatch && method === "POST") {
        layerRequests += 1;
        const mode = layerMode;
        if (mode === "held") {
          heldStarted?.();
          await heldGate;
          layerMode = "created";
        }
        if (mode === "rejected") {
          await json(
            route,
            {
              error: {
                code: "invalid_request",
                message: "The fixture rejected this layer.",
              },
            },
            400,
          );
          return true;
        }
        if (mode === "unconfirmed") {
          await route.fulfill({
            status: 201,
            contentType: "application/json",
            body: "not-json",
          });
          return true;
        }
        await json(
          route,
          {
            id: "layer-postgis",
            mapId: layerMatch[1],
            name: "roads",
            sql: "SELECT * FROM roads",
            style: {
              fill: { type: "constant", color: "#238b45" },
              fillOpacity: 0.7,
              stroke: { type: "constant", color: "#176c36" },
              strokeOpacity: 1,
              strokeWidth: 1,
              pointRadius: 5,
              pointRadiusUnits: "pixels",
            },
            visible: true,
            tooltip: null,
            popup: null,
            publishedFields: null,
            inLegend: true,
            viz: { type: "points" },
            filters: [],
            legendTitle: null,
            legendLabels: null,
            legendAttrs: null,
            ordinal: 0,
            createdAt: NOW,
            updatedAt: NOW,
          },
          201,
        );
        return true;
      }
      if (pathname === "/api/layers/layer-postgis/render" && method === "GET") {
        await json(route, {
          layerId: "layer-postgis",
          ok: true,
          mode: "inline",
          geometryType: "POINT",
          featureCount: 1,
          geojson: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: { id: 1 },
                geometry: { type: "Point", coordinates: [13.35, 52.51] },
              },
            ],
          },
        });
        return true;
      }
      return false;
    },
  });

  return {
    reads: () => tableListReads,
    layerRequests: () => layerRequests,
    setLayerMode: (mode: Exclude<LayerMode, "held">) => {
      layerMode = mode;
    },
    holdNextLayer: () => {
      layerMode = "held";
      heldStart = new Promise<void>((resolve) => {
        heldStarted = resolve;
      });
      heldGate = new Promise<void>((resolve) => {
        heldRelease = resolve;
      });
    },
    waitForHeldLayer: () => heldStart,
    releaseHeldLayer: () => heldRelease?.(),
    holdNextPreview: () => {
      previewHeld = true;
      previewStart = new Promise<void>((resolve) => {
        previewStarted = resolve;
      });
      previewGate = new Promise<void>((resolve) => {
        previewRelease = resolve;
      });
    },
    waitForHeldPreview: () => previewStart,
    releaseHeldPreview: () => previewRelease?.(),
  };
}

async function openPostgis(dialog: ReturnType<Page["getByRole"]>) {
  await dialog.getByRole("button", { name: /^PostGIS/ }).click();
  await dialog.getByRole("button", { name: /Berlin production/ }).click();
  await expect(dialog.getByText("Berlin production", { exact: true })).toBeVisible();
}

async function selectRelation(
  dialog: ReturnType<Page["getByRole"]>,
  name: string,
) {
  await dialog
    .getByRole("button", { name: new RegExp(`^${name}`, "i") })
    .click();
  await expect(dialog.getByRole("heading", { name: new RegExp(name) })).toBeVisible();
}

/** The filter lives behind the import box's reveal. */
async function revealFilter(dialog: ReturnType<Page["getByRole"]>) {
  const filter = dialog.getByLabel(/^Filter/);
  if (!(await filter.isVisible())) {
    await dialog.getByRole("button", { name: "Filter or row limit" }).click();
  }
  await expect(filter).toBeVisible();
  return filter;
}

async function importSelected(
  dialog: ReturnType<Page["getByRole"]>,
  relation: string,
) {
  // The button is constant; the box's title names the source.
  await expect(
    dialog.getByText(new RegExp(`^Import .*\\.${relation} as a snapshot$`)),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
}

async function createWorkflow(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch("/api/recipes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "PostGIS host proof" }),
    });
    if (!response.ok) throw new Error(await response.text());
    return ((await response.json()) as { recipe: { id: string } }).recipe.id;
  });
}

test.use({ viewport: { width: 1440, height: 900 } });

test("picker, grouped browse, filtered preview, every Add data host, and neighboring close behavior", async ({
  page,
  context,
}) => {
  const errors = trackConsole(page);
  const fixture = await installFixture(context);
  await page.goto("/workflows");
  const workflowId = await createWorkflow(page);
  const hosts = [
    {
      path: "/data",
      open: () => page.getByRole("button", { name: "Add data" }).first().click(),
    },
    {
      path: "/sql",
      open: () => page.getByRole("button", { name: "Add data", exact: true }).click(),
    },
    {
      path: `/workflows/${workflowId}`,
      open: () => page.getByRole("button", { name: "Add data", exact: true }).click(),
    },
  ];

  for (const [index, host] of hosts.entries()) {
    await test.step(`PostGIS completion remains mounted in host ${index + 1}`, async () => {
      await page.goto(host.path);
      await host.open();
      const dialog = page.getByRole("dialog", { name: "Add data" });
      await expect(dialog).toBeVisible();
      await openPostgis(dialog);

      if (index === 0) {
        for (const schema of ["public", "analytics", "pg_catalog"] as const) {
          await expect(
            dialog.getByRole("button", { name: fixtureSchemaName(schema) }),
          ).toBeVisible();
        }
        await dialog.getByRole("button", { name: "pg_catalog" }).click();
        await dialog.getByLabel("Search relations").fill("system_view");
        // Rows carry the tile, the name, and the estimate alone; kind and
        // system marks render in the detail column.
        const systemViewRow = dialog.getByRole("button", { name: /^system_view/i });
        await expect(systemViewRow).toBeVisible();
        await expect(systemViewRow.getByText("view", { exact: true })).toHaveCount(0);
        await expect(systemViewRow.getByText("system", { exact: true })).toHaveCount(0);
        await systemViewRow.click();
        await expect(dialog.getByText("view", { exact: true })).toBeVisible();
        await expect(dialog.getByText("system", { exact: true })).toBeVisible();
        await dialog
          .getByLabel("Search relations")
          .fill("ordinary_extension_member");
        await dialog
          .getByRole("button", { name: /^ordinary_extension_member/i })
          .click();
        await expect(dialog.getByText("system", { exact: true })).toBeVisible();
        await dialog.getByLabel("Search relations").fill("");
        await dialog.getByRole("button", { name: "Attribute", exact: true }).click();
        await expect(dialog.getByText("lookup", { exact: true })).toBeVisible();
        await expect(dialog.getByText("roads", { exact: true })).toBeHidden();
        await dialog.getByRole("button", { name: "All", exact: true }).click();
        await selectRelation(dialog, "districts");
        await expect(dialog.getByRole("heading", { name: "analytics.districts" })).toBeVisible();
        // The fact renders once: the detail panel.
        await expect(
          dialog.getByText("geography · MULTIPOLYGON · 4326", { exact: true }),
        ).toHaveCount(1);
        // The column chips fold behind the title row's count (08):
        // until they open, only the preview header says GEOGRAPHY;
        // opening adds the chip.
        await expect(dialog.getByText("GEOGRAPHY", { exact: true })).toHaveCount(1);
        await dialog.getByRole("button", { name: "3 columns" }).click();
        await expect(dialog.getByText("GEOGRAPHY", { exact: true })).toHaveCount(2);
        await dialog.getByRole("button", { name: "3 columns" }).click();
        await expect(dialog.getByText("GEOGRAPHY", { exact: true })).toHaveCount(1);
      }

      await selectRelation(dialog, "roads");
      await expect(dialog.getByText("Tiergarten road", { exact: true })).toBeVisible();
      const filter = await revealFilter(dialog);
      await filter.fill("category = 'park'");
      await expect(dialog.getByText("Filtered park", { exact: true })).toBeVisible();
      // The reveal cannot close while the filter holds text.
      await dialog.getByRole("button", { name: "Filter or row limit" }).click();
      await expect(filter).toBeVisible();
      await filter.fill("missing_column = 1");
      await expect(dialog.getByText('Column "missing_column" does not exist.')).toBeVisible();
      await expect(dialog.getByText("Preview", { exact: true })).toBeVisible();
      await expect(dialog.getByRole("heading", { name: "public.roads" })).toBeVisible();
      await filter.fill("category = 'park'");
      await expect(dialog.getByText("Filtered park", { exact: true })).toBeVisible();

      const readsBefore = fixture.reads();
      // The done card must not wait for the preview: hold the refetch the
      // filter change triggers, import through it, and the card appears
      // while the preview is still open.
      fixture.holdNextPreview();
      await filter.fill("category = 'held'");
      await fixture.waitForHeldPreview();
      await importSelected(dialog, "roads");
      await expect(dialog.getByRole("heading", { name: "Imported as roads" })).toBeVisible();
      fixture.releaseHeldPreview();
      await expect.poll(fixture.reads).toBeGreaterThan(readsBefore);
      await dialog.getByRole("button", { name: "Import another" }).click();
      await expect(dialog.getByText("Berlin production", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Close" }).click();
    });
  }

  await test.step("the neighboring URL source still closes on completion", async () => {
    await page.goto("/data");
    await page.getByRole("button", { name: "Add data" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add data" });
    await dialog.getByRole("tab", { name: "From URL" }).click();
    await dialog.getByLabel("File URL").fill("https://fixtures.test/neighbor.csv");
    await dialog.getByRole("button", { name: "Import as table" }).click();
    await expect(dialog).toBeHidden();
  });

  expect(
    errors.filter(
      (entry) =>
        !isAllowedConsoleError(entry.text, entry.url) &&
        // The bad-filter exercise deliberately provokes 400s from the
        // preview operation, and Chromium always logs a failing load.
        !(
          entry.url?.includes("/preview") &&
          entry.text.includes("status of 400")
        ),
    ),
  ).toEqual([]);
});

test("Add layer waits for confirmation and preserves every honest terminal outcome", async ({
  page,
  context,
}) => {
  const errors = trackConsole(page);
  const fixture = await installFixture(context);
  await page.goto("/maps");
  const mapId = await createMap(page, "PostGIS layer outcomes");
  await page.goto(`/maps/${mapId}`);

  const open = async () => {
    await page.getByRole("button", { name: "Add layer", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add layer" });
    await openPostgis(dialog);
    return dialog;
  };

  let dialog = await open();
  await selectRelation(dialog, "roads");
  await importSelected(dialog, "roads");
  await expect(
    dialog.getByRole("heading", { name: "Added to the map as roads" }),
  ).toBeVisible();
  expect(fixture.layerRequests()).toBe(1);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();

  dialog = await open();
  await selectRelation(dialog, "lookup");
  const requestsBeforeAttribute = fixture.layerRequests();
  await importSelected(dialog, "lookup");
  await expect(dialog.getByRole("heading", { name: "Imported as lookup" })).toBeVisible();
  await expect(dialog.getByText(/no geometry for a layer/i)).toBeVisible();
  await expect(dialog.getByText(/Added to the map/)).toHaveCount(0);
  expect(fixture.layerRequests()).toBe(requestsBeforeAttribute);
  await dialog.getByRole("button", { name: "Import another" }).click();

  fixture.setLayerMode("rejected");
  await selectRelation(dialog, "roads");
  await importSelected(dialog, "roads");
  await expect(dialog.getByRole("heading", { name: "Imported as roads" })).toBeVisible();
  await expect(dialog.getByText("The fixture rejected this layer.")).toBeVisible();
  await expect(dialog.getByText(/Added to the map/)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Import another" }).click();

  fixture.setLayerMode("unconfirmed");
  await selectRelation(dialog, "roads");
  await importSelected(dialog, "roads");
  await expect(
    dialog.getByRole("heading", { name: "Layer creation unconfirmed for roads" }),
  ).toBeVisible();
  await expect(dialog.getByText(/nothing was retried/i)).toBeVisible();
  await expect(dialog.getByText(/Added to the map/)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Import another" }).click();

  // The done card appears at import completion: with the coordinator
  // held, the card is visible with its pending line and no layer claim;
  // releasing settles it into the confirmed heading.
  fixture.setLayerMode("created");
  fixture.holdNextLayer();
  await selectRelation(dialog, "roads");
  await importSelected(dialog, "roads");
  await fixture.waitForHeldLayer();
  await expect(dialog.getByRole("heading", { name: "Imported as roads" })).toBeVisible();
  await expect(dialog.getByText("Adding to the map…")).toBeVisible();
  await expect(dialog.getByText(/Added to the map/)).toHaveCount(0);
  fixture.releaseHeldLayer();
  await expect(
    dialog.getByRole("heading", { name: "Added to the map as roads" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Import another" }).click();

  fixture.holdNextLayer();
  await selectRelation(dialog, "roads");
  await importSelected(dialog, "roads");
  await fixture.waitForHeldLayer();
  await dialog.getByRole("button", { name: "Close" }).click();
  fixture.releaseHeldLayer();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Added roads to this map", { exact: true })).toBeVisible();

  expect(
    errors.filter(
      (entry) =>
        !isAllowedConsoleError(entry.text, entry.url) &&
        // The rejected-outcome exercise deliberately answers 400 on the
        // layers route, and Chromium always logs a failing resource load.
        !(
          /\/api\/maps\/[^/?#]+\/layers(?:[?#]|$)/.test(entry.url ?? "") &&
          entry.text.includes("status of 400")
        ),
    ),
  ).toEqual([]);
});

test.describe("darwin PostGIS pane pixels", () => {
  test.skip(
    process.platform !== "darwin",
    "PostGIS pane pixel baselines are darwin-generated",
  );

  for (const theme of ["light", "dark"] as const) {
    test(`picker, browse preview, and completion match the ${theme} references`, async ({
      page,
      context,
    }) => {
      await page.addInitScript((value) => {
        window.localStorage.setItem("dezfil-theme", value);
      }, theme);
      await installFixture(context);
      await page.goto("/data");
      await page.getByRole("button", { name: "Add data" }).first().click();
      const dialog = page.getByRole("dialog", { name: "Add data" });
      await dialog.getByRole("button", { name: /^PostGIS/ }).click();
      await expect(dialog.getByText("Berlin production", { exact: true })).toBeVisible();
      await expect(dialog).toHaveScreenshot(`postgis-picker-${theme}.png`, {
        animations: "disabled",
      });

      await dialog.getByRole("button", { name: /Berlin production/ }).click();
      await selectRelation(dialog, "roads");
      await expect(dialog.getByText("Tiergarten road", { exact: true })).toBeVisible();
      await expect(dialog).toHaveScreenshot(`postgis-browse-${theme}.png`, {
        animations: "disabled",
      });

      await importSelected(dialog, "roads");
      await expect(dialog.getByRole("heading", { name: "Imported as roads" })).toBeVisible();
      await expect(dialog).toHaveScreenshot(`postgis-done-${theme}.png`, {
        animations: "disabled",
      });
    });
  }
});
