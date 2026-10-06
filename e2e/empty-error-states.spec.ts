// Empty and error states: the inventory classes not already held
// elsewhere. Held and mapped, not re-driven: the Data screen's first-run
// empty and zero-match states, the new-layer card's
// loading/failed/loaded truths, dashboard failed/stale/updating states,
// and the unknown-token viewer page (this feature's lifecycle suite).
// Driven here: the first-run empty Maps screen, a zero-row SQL result in
// the workspace and the dock, a zero-row layer, and the deleted-table
// degradation surface in the builder and at the published boundary;
// since the closures, also a failing query's user-vocabulary error text
// and the settings form staying locked over a failed load.
//
// Environment: the documented gate — production standalone,
// DEZFIL_RENDER_CAP_FEATURES=2000, third-party hosts blocked. Run via
// `npm run e2e:states` with DEZFIL_BASE_URL pointing at the server.
import { test, expect, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  FIXTURES_DIR,
  addLayer,
  createMap,
  publishMap,
  routeHouse,
  saveSettled,
  seedCsv,
  trackConsole,
} from "./support";

const runId = Date.now().toString(36);
const tableName = `est_${runId}`;

type ConsoleError = { text: string; url?: string };

/** Consume the browser's expected console shadow of an injected fault
 * (the dashboard-truth pattern). */
async function consumeExpected(errors: ConsoleError[], route: RegExp) {
  const find = () =>
    errors.findIndex((entry) => route.test(entry.url ?? entry.text));
  await expect.poll(find).toBeGreaterThanOrEqual(0);
  errors.splice(find(), 1);
}

/** The three live screens' shared async contract:
 * pending is visible and counts stay silent until resolve; empty appears
 * only after a successful resolve; a failed load offers a retry that
 * issues a fresh request. */
const LIVE_SCREENS = [
  {
    path: "/maps",
    api: "/api/maps",
    pendingLabel: "Reading your maps…",
    emptyName: /New map Start from a blank map/,
    // The one unreachable-server sentence, authored here as a literal
    // on purpose — never imported from the app.
    failedText: "Couldn't load the maps. Is the server reachable?",
    chip: true,
  },
  {
    path: "/data",
    api: "/api/tables",
    pendingLabel: "Reading your tables…",
    emptyName: /Add data Upload a file or import from a source/,
    failedText: "Couldn't load the tables. Is the server reachable?",
    chip: true,
  },
  {
    path: "/connections",
    api: "/api/connections/postgis",
    pendingLabel: "Reading your connections…",
    emptyName: /Add connection Snapshot tables from a PostGIS database/,
    failedText: "Couldn't load the connections. Is the server reachable?",
    chip: false,
  },
] as const;

test("the live screens hold pending truthfully and retry their failed loads", async ({
  page,
  context,
}) => {
  const consoleErrors: ConsoleError[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error")
      consoleErrors.push({ text: msg.text(), url: msg.location().url });
  });
  page.on("pageerror", (err) => consoleErrors.push({ text: String(err) }));

  // Hold every load, including development effect replays. Keep failures
  // armed until retry: aborting once lets a second load resolve empty.
  let armedPath = "";
  let mode: "off" | "hold" | "fail" | "empty" = "off";
  let held: Route[] = [];
  const injectedFailures = new Set<string>();
  await routeHouse(context, {
    handler: async (route) => {
      const url = new URL(route.request().url());
      if (
        mode === "off" ||
        route.request().method() !== "GET" ||
        url.pathname !== armedPath
      )
        return false;
      if (mode === "hold") {
        held.push(route);
        return true;
      }
      if (mode === "fail") {
        injectedFailures.add(route.request().url());
        await route.abort();
        return true;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      });
      return true;
    },
  });

  for (const screen of LIVE_SCREENS) {
    await test.step(`${screen.path}: pending is visible, counts stay silent`, async () => {
      armedPath = screen.api;
      mode = "hold";
      held = [];
      await page.goto(screen.path);
      await expect(page.getByText(screen.pendingLabel)).toBeVisible();
      if (screen.chip) {
        // No chip asserts a number while the request is in flight.
        await expect(
          page.getByRole("button", { name: /^All · \d/ }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "All", exact: true }),
        ).toBeVisible();
      }
      await expect(
        page.getByRole("button", { name: screen.emptyName }),
      ).toHaveCount(0);
      // Release the held answer: only now do the actionable empty state
      // and the zero count appear.
      await expect.poll(() => held.length).toBeGreaterThan(0);
      mode = "empty";
      await Promise.all(held.map((route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      })));
      await expect(
        page.getByRole("button", { name: screen.emptyName }),
      ).toBeVisible();
      if (screen.chip) {
        await expect(
          page.getByRole("button", { name: /^All · 0/ }),
        ).toBeVisible();
      }
    });

    await test.step(`${screen.path}: a failed load offers a retry that succeeds`, async () => {
      mode = "fail";
      await page.goto(screen.path);
      const retry = page.getByRole("button", { name: "Try again" });
      await expect(retry).toBeVisible();
      await expect(page.getByText(screen.failedText)).toBeVisible();
      await consumeExpected(
        consoleErrors,
        new RegExp(screen.api.replaceAll("/", "\\/")),
      );
      mode = "empty";
      await retry.click();
      await expect(
        page.getByRole("button", { name: screen.emptyName }),
      ).toBeVisible();
    });
  }

  mode = "off";
  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url) && !(
      e.text === "Failed to load resource: net::ERR_FAILED" &&
      injectedFailures.has(e.url ?? "")
    ),
  );
  expect(unexpected).toEqual([]);
});

test("settings keeps the name locked over data that never arrived", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  // A failure window, not abort-once: the read is made again on every
  // visit to General, so a single-shot stub could race it.
  let failing = true;
  await routeHouse(context, {
    handler: async (route) => {
      if (
        failing &&
        route.request().method() === "GET" &&
        new URL(route.request().url()).pathname === "/api/instance/settings"
      ) {
        await route.abort();
        return true;
      }
      return false;
    },
  });
  await page.goto("/settings/general");
  const instanceField = page.getByLabel("Instance name");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  // General's cards only mount after the instance's settings have loaded.
  // A failed load cannot offer a blind save over missing values.
  await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible();
  await expect(instanceField).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  // The retry issues a fresh request and only then unlocks.
  failing = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(instanceField).toBeEnabled();
  // The aborted window's console shadows are the injected fault's own.
  const unexpected = consoleErrors.filter(
    (e) =>
      !isAllowedConsoleError(e.text, e.url) &&
      !/\/api\/instance\/settings/.test(e.url ?? e.text),
  );
  expect(unexpected).toEqual([]);
});

test("first-run empty Maps screen shows its guidance, never a blank gallery", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  // Earlier suites seeded durable maps — the first-run state is driven
  // at the network boundary with a deterministic empty answer (the
  // pattern for the Data screen).
  let emptyMaps = true;
  await routeHouse(context, {
    handler: async (route) => {
      const url = new URL(route.request().url());
      if (
        emptyMaps &&
        route.request().method() === "GET" &&
        url.pathname === "/api/maps"
      ) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
        return true;
      }
      return false;
    },
  });
  await page.goto("/maps");
  // The screen remembers its last view — pin GRID first so the asserted
  // state is the one under test, whatever an earlier run left behind.
  await page.getByRole("button", { name: "Grid view", exact: true }).click();
  // Grid view's designed first-run state: the counted-empty chips and
  // the ghost tile inviting the first map.
  await expect(page.getByRole("button", { name: /^All · 0/ })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /New map Start from a blank map/ }),
  ).toBeVisible();
  // List view presents the same actionable state — the tile, not a prose
  // shrug (resolved-empty is the screen's first action in both views).
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /New map Start from a blank map/ }),
  ).toBeVisible();
  // And with real maps behind it, a zero-match search is its own
  // designed state, never a blank gallery. The map is seeded HERE so the
  // documented standalone command holds on a fresh data directory too
  // — the stub intercepts only the list GET.
  await page.evaluate(async () => {
    const r = await fetch("/api/maps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "zero-match seed" }),
    });
    if (!r.ok) throw new Error(await r.text());
  });
  emptyMaps = false;
  await page.reload();
  await page.getByLabel("Search maps").fill("zz_nothing_matches_zz");
  await expect(
    page.getByText("No maps match. Clear the search or filters."),
  ).toBeVisible();
  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

test("zero-row results and the deleted-table degradation are designed states", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  const consoleErrors = trackConsole(page);
  await routeHouse(context);

  await test.step("seed: a table, a map, a zero-row layer, a doomed layer", async () => {
    await page.goto("/maps");
    const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
    await seedCsv(page, tableName, csv);
    await seedCsv(page, `${tableName}_doomed`, csv);
  });

  await test.step("workspace: a zero-row result presents as 0 rows, not a blank area", async () => {
    await page.goto("/sql");
    const editor = page.getByLabel("SQL editor");
    // The console opens empty: no prefill to race, the mounted editor is
    // the settled signal; replace completely all the same.
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Delete");
    await page.keyboard.type(
      `SELECT * FROM ${tableName} WHERE riders < 0`,
    );
    await page.getByRole("button", { name: "Run query" }).click();
    await expect(page.getByText(/^0$|0\s*rows/).first()).toBeVisible({
      timeout: 30_000,
    });
  });

  await test.step("workspace: a failing query's error speaks SQL, not the probe rewrite", async () => {
    const editor = page.getByLabel("SQL editor");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Delete");
    await page.keyboard.type(`SELECT nope FROM ${tableName}`);
    await page.getByRole("button", { name: "Run query" }).click();
    // The engine's readable diagnosis arrives with its code chip…
    await expect(page.getByText("sql_error")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/Referenced column/)).toBeVisible();
    // …but the internal probe rewrite stays out of the sentence.
    await expect(page.getByText(/LINE \d+:/)).toHaveCount(0);
    await expect(page.getByText(/DESCRIBE/)).toHaveCount(0);
    // The 400 answer's console shadow is the fault's own.
    await consumeExpected(consoleErrors, /\/api\/query/);
  });

  const mapId = await createMap(page, "empty and error states");
  let doomedId = "";
  await test.step("builder: a zero-row layer is an honest count, not an error", async () => {
    await addLayer(
      page,
      mapId,
      `${tableName} zero`,
      `SELECT * FROM ${tableName} WHERE riders < 0`,
    );
    await page.goto(`/maps/${mapId}`);
    const row = page.getByRole("button", {
      name: new RegExp(`^${tableName} zero`),
    });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("0 features")).toBeVisible({
      timeout: 30_000,
    });
    // An empty result is not an errored one.
    await expect(
      page.locator("li[data-errored]", { hasText: `${tableName} zero` }),
    ).toHaveCount(0);
    await saveSettled(page);
  });

  await test.step("workbench: a zero-row preview presents its 0-row header", async () => {
    const row = page
      .locator("li", { hasText: `${tableName} zero` })
      .first();
    await row.getByRole("button", { name: "Layer menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "Edit source" }).click();
    await expect(
      page.getByRole("dialog", { name: /Layer source/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Run preview/ }).click();
    await expect(page.getByText(/0\s*rows/).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.keyboard.press("Escape");
  });

  await test.step("deleted table: the builder degrades the layer visibly, not silently", async () => {
    doomedId = await addLayer(
      page,
      mapId,
      `${tableName} drifted`,
      `SELECT * FROM ${tableName}_doomed`,
    );
    // Publish FIRST (a live reference), then pull the table out from
    // under the layer —-pinned drift degradation.
    const token = await publishMap(page, mapId);
    await page.evaluate(async (name) => {
      const r = await fetch(`/api/tables/${name}`, { method: "DELETE" });
      if (!r.ok) throw new Error(await r.text());
    }, `${tableName}_doomed`);

    await page.goto(`/maps/${mapId}`);
    const erroredRow = page.locator("li[data-errored]", {
      hasText: `${tableName} drifted`,
    });
    await expect(erroredRow).toBeVisible({ timeout: 30_000 });

    // The published boundary answers the documented catalogue sentence
    // for the envelope's code — never the engine's own text.
    const envelope = await page.evaluate(
      async ({ token, id }) => {
        const r = await fetch(`/api/published/${token}`, {
          cache: "no-store",
        });
        const body = (await r.json()) as {
          layers: {
            id: string;
            render: { ok: boolean; error?: { code: string; message: string } };
          }[];
        };
        return body.layers.find((l) => l.id === id)!.render;
      },
      { token, id: doomedId },
    );
    expect(envelope.ok).toBe(false);
    const CATALOGUE: Record<string, string> = {
      sql_error: "The SQL failed to parse or execute.",
      query_failed: "The layer's query failed to execute.",
      internal: "Something went wrong on this server. The detail is in the server log.",
      not_found: "The requested resource was not found.",
    };
    const code = envelope.error?.code ?? "";
    expect(
      Object.keys(CATALOGUE),
      `code ${code} is a documented class`,
    ).toContain(code);
    expect(envelope.error?.message).toBe(CATALOGUE[code]);
    // No engine text crosses: the raw message would name the table.
    expect(JSON.stringify(envelope)).not.toContain(`${tableName}_doomed`);

    // The reader sees the failed-layer state with the same prose.
    await page.goto(`/v/${token}`);
    const failed = page.locator(`[data-layer-failed="${doomedId}"]`);
    await expect(failed).toBeVisible({ timeout: 30_000 });
    await expect(failed).toContainText(CATALOGUE[code]);
  });

  await test.step("the console stayed clean", async () => {
    const unexpected = consoleErrors.filter(
      (e) => !isAllowedConsoleError(e.text, e.url),
    );
    expect(unexpected).toEqual([]);
  });
});
