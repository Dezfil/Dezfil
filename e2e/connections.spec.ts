// Connections home: mocked at the browser's HTTP boundary so the journeys
// hold page behavior, keyboard access, copy, and dress without depending
// on a live source. The disposable-PostGIS suite separately owns the live
// password-rotation, import, and repoint road.
import { test, expect } from "@playwright/test";
import type { BrowserContext, Route } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import { routeHouse, trackConsole } from "./support";
import { exerciseRefusedConnectionPaste, refusedConnectionStrings } from "./connection-paste";

const NOW = "2026-08-31T10:00:00.000Z";
const CHECKED_AT = "2026-08-01T10:00:00.000Z";
const CREATED_AT = "2026-07-01T08:00:00.000Z";

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
});

interface Connection {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  ssl: boolean;
  createdAt: string;
  status: "connected" | "failing" | "no_postgis" | "not_checked_lately" | "never_checked";
  lastCheckedAt: string | null;
  lastCheckError: string | null;
  serverVersion: string | null;
  postgisVersion: string | null;
}

interface Snapshot {
  id: string;
  name: string;
  /** The name its reader types; for the caller's own table, its name. */
  qualifiedName: string;
  sourceFilename: null;
  format: "geoparquet";
  file: string;
  geometryColumn: string | null;
  geometryType: string | null;
  crsAssumed: boolean;
  headerSuspect: boolean;
  rowCount: number;
  createdAt: string;
  source: "postgis";
  sourceParams: Record<string, unknown>;
  importedAt: string;
  /** The documented listing shape: the table page reads the
   * memberships (their absence crashed the page). */
  projectIds: string[];
}

const connected = (overrides: Partial<Connection> = {}): Connection => ({
  id: "c-berlin",
  name: "Berlin warehouse",
  host: "db.internal",
  port: 5432,
  database: "mobility",
  username: "dezfil_ro",
  ssl: true,
  createdAt: CREATED_AT,
  status: "connected",
  lastCheckedAt: CHECKED_AT,
  lastCheckError: null,
  serverVersion: "PostgreSQL 16.4",
  postgisVersion: "3.4.2",
  ...overrides,
});

const roads = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  id: "t-roads",
  name: "roads_snapshot",
  qualifiedName: overrides.name ?? "roads_snapshot",
  sourceFilename: null,
  format: "geoparquet",
  file: "tables/roads_snapshot.parquet",
  geometryColumn: "geom",
  geometryType: "MULTILINESTRING",
  crsAssumed: false,
  headerSuspect: false,
  rowCount: 12_450,
  createdAt: CREATED_AT,
  source: "postgis",
  sourceParams: {
    connectionId: "c-berlin",
    connectionName: "Berlin warehouse",
    schema: "public",
    table: "roads",
    filter: "active = true",
    limit: 20_000,
  },
  importedAt: CHECKED_AT,
  projectIds: [],
  ...overrides,
});

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

async function installFixture(
  context: BrowserContext,
  options: { secondSnapshot?: boolean } = {},
) {
  let connections: Connection[] = [
    connected(),
    connected({
      id: "c-hamburg",
      name: "Hamburg planning",
      host: "ep-misty-snow-b1ut47r5.c-5.eu-central-1.aws.planning.internal",
      database: "planning",
      status: "no_postgis",
      postgisVersion: null,
      ssl: false,
    }),
  ];
  let importSeq = 0;
  let snapshots: Snapshot[] = [
    roads(),
    ...(options.secondSnapshot
      ? [
          roads({
            id: "t-cafes",
            name: "cafes_snapshot",
            rowCount: 240,
            sourceParams: {
              connectionId: "c-berlin",
              connectionName: "Berlin warehouse",
              schema: "public",
              table: "cafes",
            },
          }),
        ]
      : []),
  ];
  let listedTables: (Snapshot & { sizeBytes: number })[] = [];
  const submitted: Record<string, unknown>[] = [];
  let refusePatchOnce = false;
  let failNextSave = false;
  const refreshCalls: string[] = [];
  let refreshHeld: string | null = null;
  let refreshStarted: (() => void) | null = null;
  let refreshRelease: (() => void) | null = null;
  let refreshStart = Promise.resolve();
  let refreshGate = Promise.resolve();

  await routeHouse(context, {
    basemapStyleStub: true,
    handler: async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      const method = request.method();

      if (pathname === "/api/connections/postgis" && method === "GET") {
        await json(route, connections);
        return true;
      }
      if (pathname === "/api/connections/postgis" && method === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        submitted.push(body);
        if (failNextSave) {
          failNextSave = false;
          await json(route, { error: { code: "connection_failed", message: "Prior source failure." } }, 502);
          return true;
        }
        const created = connected({
          id: "c-new",
          name: String(body.name),
          host: String(body.host),
          port: Number(body.port),
          database: String(body.database),
          username: String(body.username),
          ssl: Boolean(body.ssl),
          createdAt: "2026-08-31T08:00:00.000Z",
          lastCheckedAt: "2026-08-31T08:00:00.000Z",
        });
        connections = [...connections, created];
        await json(route, created, 201);
        return true;
      }

      const snapshotsMatch = pathname.match(
        /^\/api\/connections\/postgis\/([^/]+)\/snapshots$/,
      );
      if (snapshotsMatch && method === "GET") {
        await json(route, {
          snapshots: snapshots.filter(
            (snapshot) => snapshot.sourceParams.connectionId === snapshotsMatch[1],
          ),
        });
        return true;
      }

      const catalogueMatch = pathname.match(
        /^\/api\/connections\/postgis\/([^/]+)\/tables$/,
      );
      if (catalogueMatch && method === "GET") {
        await json(route, {
          tables: [
            {
              schema: "public",
              table: "roads",
              kind: "table",
              system: false,
              geometryColumn: "geom",
              geometryType: "MULTILINESTRING",
              srid: 4326,
              spatialKind: "geometry",
              approxRows: 12_450,
            },
          ],
        });
        return true;
      }

      const previewMatch = pathname.match(
        /^\/api\/connections\/postgis\/([^/]+)\/preview$/,
      );
      if (previewMatch && method === "POST") {
        await json(route, {
          columns: [
            { name: "id", type: "INTEGER", spatialKind: null },
            { name: "name", type: "VARCHAR", spatialKind: null },
            { name: "geom", type: "GEOMETRY", spatialKind: "geometry" },
          ],
          rows: [{ id: 1, name: "Ring road", geom: "LINESTRING (13 52, 14 53)" }],
        });
        return true;
      }

      const testMatch = pathname.match(
        /^\/api\/connections\/postgis\/([^/]+)\/test$/,
      );
      if (testMatch && method === "POST") {
        const found = connections.find((item) => item.id === testMatch[1])!;
        const updated = { ...found, status: "connected" as const, lastCheckedAt: CHECKED_AT };
        connections = connections.map((item) => item.id === updated.id ? updated : item);
        await json(route, updated);
        return true;
      }

      const connectionMatch = pathname.match(
        /^\/api\/connections\/postgis\/([^/]+)$/,
      );
      if (connectionMatch && method === "PATCH") {
        const body = request.postDataJSON() as Record<string, unknown>;
        submitted.push(body);
        if (failNextSave) {
          failNextSave = false;
          await json(route, { error: { code: "connection_failed", message: "Prior source failure." } }, 502);
          return true;
        }
        const current = connections.find((item) => item.id === connectionMatch[1])!;
        // The client's own guard refuses repoints locally, so no browser
        // path can reach a mirrored server rule here; the flag stands in
        // for the server's refusal to prove the render road.
        if (refusePatchOnce) {
          refusePatchOnce = false;
          await json(
            route,
            {
              error: {
                code: "connection_password_required",
                message:
                  "Enter the password again when changing the host or port, or turning SSL off.",
              },
            },
            400,
          );
          return true;
        }
        const updated = connected({
          ...current,
          ...Object.fromEntries(
            Object.entries(body).filter(([key, value]) => key !== "password" && value !== ""),
          ),
          id: current.id,
        });
        connections = connections.map((item) => item.id === updated.id ? updated : item);
        await json(route, updated);
        return true;
      }
      if (connectionMatch && method === "DELETE") {
        connections = connections.filter((item) => item.id !== connectionMatch[1]);
        await route.fulfill({ status: 204, body: "" });
        return true;
      }

      if (pathname === "/api/imports/postgis" && method === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        // Unique ids and deduplicated names, as the server mints them
        // (registerTable): a repeated import must never collide a key.
        importSeq += 1;
        const desired = String(body.name || body.table);
        const taken = new Set(snapshots.map((snapshot) => snapshot.name));
        let unique = desired;
        for (let n = 2; taken.has(unique); n++) unique = `${desired}_${n}`;
        const imported = roads({
          id: `t-import-${importSeq}`,
          name: unique,
          sourceParams: {
            connectionId: body.connectionId,
            connectionName: "Berlin warehouse",
            schema: body.schema,
            table: body.table,
          },
        });
        snapshots = [...snapshots, imported];
        listedTables = [{ ...imported, sizeBytes: 2048 }];
        await json(route, imported, 201);
        return true;
      }

      if (pathname === "/api/tables" && method === "GET") {
        await json(route, listedTables);
        return true;
      }
      if (pathname === "/api/recipes" && method === "GET") {
        await json(route, { recipes: [] });
        return true;
      }
      const refreshMatch = pathname.match(/^\/api\/tables\/([^/]+)\/refresh$/);
      if (refreshMatch && method === "POST") {
        const name = decodeURIComponent(refreshMatch[1]);
        refreshCalls.push(name);
        if (refreshHeld === name) {
          refreshStarted?.();
          await refreshGate;
          refreshHeld = null;
        }
        const current = snapshots.find((snapshot) => snapshot.name === name)!;
        const refreshed = {
          ...current,
          rowCount: current.rowCount + 1,
          importedAt: NOW,
        };
        snapshots = snapshots.map((snapshot) =>
          snapshot.name === name ? refreshed : snapshot,
        );
        try {
          await json(route, refreshed);
        } catch {
          // A cancelled refresh aborts the request under the held
          // route; fulfilling then throws, and that is the point.
        }
        return true;
      }
      if (/^\/api\/tables\/(roads|roads_2|roads_snapshot)$/.test(pathname) && method === "GET") {
        const imported = listedTables[0] ?? roads();
        await json(route, {
          ...imported,
          columns: [
            { name: "id", type: "INTEGER" },
            { name: "name", type: "VARCHAR" },
          ],
          preview: [{ id: 1, name: "Ring road" }],
          sizeBytes: 2048,
          inputs: null,
        });
        return true;
      }
      if (/^\/api\/tables\/(roads|roads_2|roads_snapshot)\/features$/.test(pathname) && method === "GET") {
        await json(route, {
          ok: false,
          name: "roads_snapshot",
          geometryType: null,
          reason: "Preview omitted by the browser fixture.",
        });
        return true;
      }

      return false;
    },
  });

  return {
    submitted,
    failNextSave: () => { failNextSave = true; },
    deleteLiveConnection: () => {
      connections = connections.filter((item) => item.id !== "c-berlin");
    },
    refusePatchOnce: () => {
      refusePatchOnce = true;
    },
    refreshCalls: () => [...refreshCalls],
    holdRefresh: (name: string) => {
      refreshHeld = name;
      refreshStart = new Promise<void>((resolve) => {
        refreshStarted = resolve;
      });
      refreshGate = new Promise<void>((resolve) => {
        refreshRelease = resolve;
      });
    },
    waitForHeldRefresh: () => refreshStart,
    releaseHeldRefresh: () => refreshRelease?.(),
  };
}

test("connections add, edit, import, provenance and keyboard flows", async ({
  page,
  context,
}) => {
  const errors = trackConsole(page);
  const fixture = await installFixture(context);

  await test.step("the ledger opens by keyboard and Test stays on its row", async () => {
    await page.goto("/connections");
    await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible();
    await expect(page.getByText("Live database connections")).toHaveCount(0);
    const berlin = page.getByRole("link", { name: "Open Berlin warehouse" });
    const hamburg = page.getByRole("link", { name: "Open Hamburg planning" });
    await expect(berlin).toHaveAttribute("href", "/connections/c-berlin");
    const berlinStatus = berlin.locator("[data-status]");
    const hamburgStatus = hamburg.locator("[data-status]");
    await expect(berlinStatus).toHaveAttribute("data-status", "connected");
    await expect(hamburgStatus).toHaveAttribute("data-status", "no_postgis");
    await hamburg.locator("..").getByRole("button", { name: "Test", exact: true }).click();
    await expect(page).toHaveURL(/\/connections$/);
    await expect(hamburgStatus).toHaveAttribute("data-status", "connected");
    await expect(hamburgStatus).toContainText("Connected");
    await expect(berlinStatus).toHaveAttribute("data-status", "connected");
    await expect(berlinStatus).toContainText("Connected");

    await berlin.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/connections\/c-berlin$/);
    await expect(page.getByRole("heading", { name: "Berlin warehouse" })).toBeVisible();
  });

  await test.step("the edit keeps password write-only and preserves the id", async () => {
    const password = page.getByLabel("Password", { exact: true });
    await expect(password).toHaveValue("");
    await page.getByLabel("Connection name").fill("Berlin renamed");
    await password.fill("browser-secret-1");
    await page.getByRole("button", { name: "Test & save changes" }).click();
    await expect(page.getByRole("heading", { name: "Berlin renamed" })).toBeVisible();
    await expect(page).toHaveURL(/\/connections\/c-berlin$/);
    await expect(password).toHaveValue("");
    await expect(page.locator("body")).not.toContainText("browser-secret-1");
    expect(fixture.submitted.at(-1)).toMatchObject({
      name: "Berlin renamed",
      password: "browser-secret-1",
    });
  });

  await test.step("the page menu has no duplicate import entry", async () => {
    const menu = page.getByRole("button", { name: "More actions for Berlin renamed" });
    await menu.click();
    await expect(page.getByRole("menuitem", { name: "Copy server address" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Import tables" })).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  await test.step("Import tables opens the dialog on this page and returns here", async () => {
    await page.getByRole("button", { name: "Import tables" }).first().click();
    // No navigation: the dialog opens over the connection page.
    await expect(page).toHaveURL(/\/connections\/c-berlin$/);
    const dialog = page.getByRole("dialog", { name: "Add data" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Berlin renamed", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: /^roads/i }).click();
    // The button is constant; the title names the source.
    await expect(dialog.getByText("Import public.roads as a snapshot")).toBeVisible();
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "Imported as roads" })).toBeVisible();
    // Closing without navigating returns to the page, snapshots current.
    await dialog.getByRole("button", { name: "Import another" }).click();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/connections\/c-berlin$/);
    await expect(page.getByText("2 tables in your workspace")).toBeVisible();
    // Open table still navigates, explicitly.
    await page.getByRole("button", { name: "Import tables" }).first().click();
    await dialog.getByRole("button", { name: /^roads/i }).click();
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    // The server deduplicates names; the fixture mirrors it.
    await expect(dialog.getByRole("heading", { name: "Imported as roads_2" })).toBeVisible();
    await dialog.getByRole("button", { name: "Open table" }).click();
    await expect(page).toHaveURL(/\/tables\/roads_2$/);
  });

  await test.step("live provenance links; deleted provenance is stored text", async () => {
    await page.goto("/tables/roads_snapshot");
    const live = page.getByRole("link", { name: '"Berlin renamed"' });
    await expect(live).toHaveAttribute("href", "/connections/c-berlin");
    fixture.deleteLiveConnection();
    await page.reload();
    await expect(page.getByText(/from "Berlin warehouse"/)).toBeVisible();
    await expect(page.locator('a[href="/connections/c-berlin"]')).toHaveCount(0);
  });

  await test.step("the add form accepts URL paste and never echoes its secret", async () => {
    await page.goto("/connections/new");
    await page.getByLabel(/Paste a connection URL/).fill(
      "host=new.internal port=5433 dbname=atlas user=reader password=new-secret-1 sslmode=disable",
    );
    await expect(page.getByLabel("Host")).toHaveValue("new.internal");
    await expect(page.getByLabel("Port", { exact: true })).toHaveValue("5433");
    await expect(page.getByText(/SSL not required/).first()).toBeVisible();
    await page.getByLabel("Connection name").fill("New atlas");
    await page.getByRole("button", { name: "Test & save connection" }).click();
    await expect(page).toHaveURL(/\/connections\/c-new$/);
    await expect(page.locator("body")).not.toContainText("new-secret-1");
  });

  await test.step("a long address truncates with the full value on hover", async () => {
    await page.goto("/connections");
    const address = page.getByTitle(
      "ep-misty-snow-b1ut47r5.c-5.eu-central-1.aws.planning.internal:5432",
    );
    await expect(address).toBeVisible();
    const overflows = await address.evaluate(
      (el) => el.scrollWidth > el.clientWidth,
    );
    expect(overflows).toBe(true);
  });

  await test.step("menu controls are named, keyboard-openable, and meet the hit floor", async () => {
    const menu = page.getByRole("button", { name: "More actions for Hamburg planning" });
    await menu.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Import tables" })).toBeFocused();
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(24);
    expect(box!.height).toBeGreaterThanOrEqual(24);
  });

  const unexpected = errors.filter(
    (entry) => !isAllowedConsoleError(entry.text, entry.url),
  );
  expect(unexpected).toEqual([]);
});

test("repointing requires the password again", async ({
  page,
  context,
}) => {
  const errors = trackConsole(page);
  const fixture = await installFixture(context);
  const RULE =
    "Enter the password again when changing the host or port, or turning SSL off.";
  await page.goto("/connections/c-berlin");
  await expect(page.getByRole("heading", { name: "Berlin warehouse" })).toBeVisible();
  const password = page.getByLabel("Password", { exact: true });

  await test.step("a host change flips the password rule and refuses locally with no request", async () => {
    await expect(password).toHaveAttribute(
      "placeholder",
      "Leave blank to keep the stored one",
    );
    await page.getByLabel("Host").fill("db-two.internal");
    await expect(password).toHaveAttribute("placeholder", RULE);
    const patches = fixture.submitted.length;
    await page.getByRole("button", { name: "Test & save changes" }).click();
    await expect(page.getByText(RULE)).toBeVisible();
    expect(fixture.submitted.length).toBe(patches);
  });

  await test.step("entering the password completes the repoint", async () => {
    await password.fill("moved-secret-1");
    await page.getByRole("button", { name: "Test & save changes" }).click();
    // The settle signal: the notice lands and the saved form has reset,
    // so the next step's edits cannot race the prop-driven refill.
    await expect(page.getByText("Berlin warehouse updated")).toBeVisible();
    await expect(page.getByText(RULE)).toHaveCount(0);
    expect(fixture.submitted.at(-1)).toMatchObject({
      host: "db-two.internal",
      password: "moved-secret-1",
    });
    // The rule placeholder returns to the stored-one form once saved.
    await expect(password).toHaveValue("");
  });

  await test.step("a same-endpoint edit still keeps the stored credential", async () => {
    await page.getByLabel("Connection name").fill("Berlin moved");
    await page.getByRole("button", { name: "Test & save changes" }).click();
    await expect(page.getByText("Berlin moved updated")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Berlin moved" })).toBeVisible();
    expect(fixture.submitted.at(-1)).toMatchObject({ name: "Berlin moved", password: "" });
  });

  await test.step("a passwordless URL naming a new host refuses locally", async () => {
    await page.getByRole("button", { name: "Paste a new connection URL" }).click();
    await page
      .getByLabel(/Paste a connection URL/)
      .fill("postgres://dezfil_ro@db-three.internal:5432/mobility");
    await expect(password).toHaveAttribute("placeholder", RULE);
    const patches = fixture.submitted.length;
    await page.getByRole("button", { name: "Test & save changes" }).click();
    await expect(page.getByText(RULE)).toBeVisible();
    expect(fixture.submitted.length).toBe(patches);
  });

  await test.step("a URL carrying its password repoints", async () => {
    const patches = fixture.submitted.length;
    await page
      .getByLabel(/Paste a connection URL/)
      .fill("postgres://dezfil_ro:url-secret-1@db-three.internal:5432/mobility");
    await page.getByRole("button", { name: "Test & save changes" }).click();
    // Fresh evidence, not a stale notice: the address paragraph carries
    // the new endpoint only after the save lands.
    await expect(page.getByText("db-three.internal:5432/mobility")).toBeVisible();
    await expect.poll(() => fixture.submitted.length).toBeGreaterThan(patches);
    expect(fixture.submitted.at(-1)).toMatchObject({
      host: "db-three.internal",
      password: "url-secret-1",
    });
    await expect(page.getByText(RULE)).toHaveCount(0);
  });

  await test.step("a server refusal renders in the form's own slot", async () => {
    fixture.refusePatchOnce();
    const patches = fixture.submitted.length;
    await page.getByLabel("Connection name").fill("Berlin refused");
    await page.getByRole("button", { name: "Test & save changes" }).click();
    // The request went out (no local refusal fired) and the server's
    // sentence renders in the same slot.
    await expect.poll(() => fixture.submitted.length).toBeGreaterThan(patches);
    await expect(page.getByRole("alert").getByText(RULE)).toBeVisible();
  });

  const unexpected = errors.filter(
    (entry) =>
      !isAllowedConsoleError(entry.text, entry.url) &&
      // The server-refusal step deliberately provokes a 400 on the
      // connection PATCH, and Chromium always logs a failing load.
      !(
        /\/api\/connections\/postgis\/[^/]+$/.test(entry.url ?? "") &&
        entry.text.includes("status of 400")
      ),
  );
  expect(unexpected).toEqual([]);
});

test("refresh waits show live status and cancel stops the run", async ({
  page,
  context,
}) => {
  const errors = trackConsole(page);
  const fixture = await installFixture(context, { secondSnapshot: true });
  await page.goto("/connections/c-berlin");
  await expect(page.getByText("2 tables in your workspace")).toBeVisible();

  await test.step("Cancel beside the busy Refresh all stops before the next row", async () => {
    fixture.holdRefresh("roads_snapshot");
    await page.getByRole("button", { name: "Refresh all" }).click();
    await fixture.waitForHeldRefresh();
    const refreshing = page.getByRole("button", { name: "Refreshing", exact: true });
    await expect(refreshing).toBeDisabled();
    // The rotation is live, not a keyframe name that resolves to
    // nothing.
    expect(
      await refreshing
        .locator("svg")
        .evaluate((el) => getComputedStyle(el).animationName),
    ).not.toBe("none");
    await expect(page.getByText("refreshing…")).toBeVisible();
    expect(
      await page
        .getByText("refreshing…")
        .locator("span")
        .first()
        .evaluate((el) => getComputedStyle(el).animationName),
    ).not.toBe("none");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByText(/^Refresh cancelled\./)).toBeVisible();
    fixture.releaseHeldRefresh();
    // The run is over and the second snapshot was never requested.
    await expect(page.getByRole("button", { name: "Refresh all" })).toBeVisible();
    expect(
      fixture.refreshCalls().filter((name) => name === "cafes_snapshot"),
    ).toEqual([]);
  });

  await test.step("a refreshing row's action becomes its cancel, and cancelled is not failed", async () => {
    fixture.holdRefresh("cafes_snapshot");
    await page.getByRole("button", { name: "Refresh cafes_snapshot" }).click();
    await fixture.waitForHeldRefresh();
    const cancel = page.getByRole("button", {
      name: "Cancel refreshing cafes_snapshot",
    });
    await expect(cancel).toBeVisible();
    await expect(page.getByText("refreshing…")).toBeVisible();
    await cancel.click();
    fixture.releaseHeldRefresh();
    // The row returns to its stored facts, with no failure state. The
    // server may commit after the abandonment; the page honestly keeps
    // the stored facts until something re-reads.
    await expect(page.getByText("refreshing…")).toHaveCount(0);
    await expect(page.getByText("refresh failed")).toHaveCount(0);
    await expect(cancel).toHaveCount(0);
    await expect(page.getByText(/240 rows/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh cafes_snapshot" })).toBeVisible();
  });

  await test.step("Refresh all does not double-start a row already refreshing", async () => {
    await page.goto("/connections/c-berlin");
    fixture.holdRefresh("roads_snapshot");
    const before = fixture.refreshCalls().length;
    await page.getByRole("button", { name: "Refresh roads_snapshot" }).click();
    await fixture.waitForHeldRefresh();
    await page.getByRole("button", { name: "Refresh all", exact: true }).click();
    // The sequential run visits roads first: once cafes has been called,
    // a clobbering second roads call could only have come before it.
    await expect
      .poll(() =>
        fixture
          .refreshCalls()
          .slice(before)
          .filter((name) => name === "cafes_snapshot").length,
      )
      .toBe(1);
    // The run skipped the in-flight row instead of clobbering its
    // controller: one roads call, the user's own.
    expect(
      fixture
        .refreshCalls()
        .slice(before)
        .filter((name) => name === "roads_snapshot"),
    ).toHaveLength(1);
    // The held row's own cancel still owns the original request.
    await page
      .getByRole("button", { name: "Cancel refreshing roads_snapshot" })
      .click();
    fixture.releaseHeldRefresh();
    await expect(page.getByText("refreshing…")).toHaveCount(0);
  });

  await test.step("an uncancelled refresh completes into fresh facts", async () => {
    await page.getByRole("button", { name: "Refresh roads_snapshot" }).click();
    // Scoped to the roads row: the cancelled row's later reconcile may
    // also legitimately read "just now" once the server-side finish lands.
    await expect(page.getByText(/12,4\d\d rows · refreshed just now/)).toBeVisible();
  });

  await test.step("the table page's re-run wait rotates its own symbol", async () => {
    await page.goto("/tables/roads_snapshot");
    fixture.holdRefresh("roads_snapshot");
    const rerun = page.getByRole("button", { name: "Re-run the stored import" });
    await rerun.click();
    await fixture.waitForHeldRefresh();
    expect(
      await rerun
        .locator("svg")
        .evaluate((el) => getComputedStyle(el).animationName),
    ).not.toBe("none");
    fixture.releaseHeldRefresh();
    await expect(rerun).toBeEnabled();
  });

  const unexpected = errors.filter(
    (entry) => !isAllowedConsoleError(entry.text, entry.url),
  );
  expect(unexpected).toEqual([]);
});

test.describe("darwin connection pixels", () => {
  test.skip(
    process.platform !== "darwin",
    "connection pixel baselines are darwin-generated",
  );

  for (const theme of ["light", "dark"] as const) {
    test(`ledger, detail, and add form match the ${theme} references`, async ({
      page,
      context,
    }) => {
      await page.addInitScript((value) => {
        window.localStorage.setItem("dezfil-theme", value);
      }, theme);
      await installFixture(context);

      await page.goto("/connections");
      await expect(page.getByText("Berlin warehouse")).toBeVisible();
      await expect(page.locator("main")).toHaveScreenshot(
        `connections-ledger-${theme}.png`,
        { animations: "disabled" },
      );

      await page.goto("/connections/c-berlin");
      await expect(page.getByRole("heading", { name: "Berlin warehouse" })).toBeVisible();
      await expect(page.locator("main")).toHaveScreenshot(
        `connection-detail-${theme}.png`,
        { animations: "disabled" },
      );

      await page.goto("/connections/new");
      await expect(page.getByRole("heading", { name: "Connect a PostGIS database" })).toBeVisible();
      await expect(page.locator("main")).toHaveScreenshot(
        `connection-new-${theme}.png`,
        { animations: "disabled" },
      );
    });
  }
});

for (const [form, refused] of Object.entries(refusedConnectionStrings)) {
  for (const mode of ["add", "edit"] as const) {
    test(`${mode} form refuses unsupported protection in ${form} paste and saves after correction`, async ({ page, context }) => {
      const fixture = await installFixture(context);
      await page.goto(mode === "add" ? "/connections/new" : "/connections/c-berlin");
      await exerciseRefusedConnectionPaste(page.locator("main"), refused, mode === "add" ? "Test & save connection" : "Test & save changes", fixture);
      await expect(page).toHaveURL(mode === "add" ? /\/connections\/c-new$/ : /\/connections\/c-berlin$/);
      await expect(page.getByRole("heading", { name: "Corrected connection", exact: true })).toBeVisible();
      await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
    });
  }
}
