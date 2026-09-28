// Dashboard truth states: the failure branches that were found silent.
// Every fault is injected at the network boundary — errored envelopes,
// coded refusals, transport aborts, a mutated view payload — because
// none of it is reachable by clicking alone.
//
// One long-lived router owns every fault, switched by a mutable mode:
// registering and unrouting per step races in-flight handlers and leaves
// requests hanging (reproduced while writing this suite). Like the core
// journey: third-party hosts blocked, no sleeps, no retries.
import { test, expect } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const runId = Date.now().toString(36);
const tableName = `dtruth_${runId}`;

const fixtureCsv = [
  "name,cat,val,lon,lat",
  "r1,alpha,10,13.40,52.50",
  "r2,alpha,20,13.41,52.51",
  "r3,beta,30,13.42,52.52",
  "r4,beta,40,13.43,52.53",
  "r5,gamma,50,13.44,52.54",
  "r6,gamma,60,13.45,52.55",
].join("\n");

type ConsoleError = { text: string; url?: string };

/** What the router does to the dashboard's read lanes right now. */
type Fault =
  | "none"
  | "hold-values"
  | "settle-timeout"
  | "settle-engine-text"
  | "values-abort"
  | "values-rate-limited"
  | "view-errored";

const mapIdOf = (page: Page) =>
  new URL(page.url()).pathname.split("/").filter(Boolean).at(-1)!;

const isValues = (url: string) => /\/widget-values$/.test(url);
const isSettle = (url: string) =>
  /\/api\/layers\/[^/]+\/render$/.test(url) ||
  /\/api\/published\/[^/]+\/render\//.test(url);
const isView = (url: string) => /\/api\/published\/[^/]+$/.test(url);

/** The dashboard has settled: nothing in flight, nothing failed. Clicking
 * a card mid-recomputation races the rail's own re-layout — the read-lane
 * analogue of the write lanes' "Saving…" gate. */
async function dashboardQuiet(page: Page) {
  await expect(page.locator("[data-settle-status]")).toHaveCount(0);
  await expect(page.locator("[data-rail-error]")).toHaveCount(0);
  await expect(page.locator("[data-card-loading]")).toHaveCount(0);
  await expect(page.locator("[data-widget-rail]")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
}

/** Consume the browser's expected console shadow of an injected fault. */
async function consumeExpected(errors: ConsoleError[], route: RegExp) {
  const find = () =>
    errors.findIndex((entry) => route.test(entry.url ?? entry.text));
  await expect.poll(find).toBeGreaterThanOrEqual(0);
  errors.splice(find(), 1);
}

test("dashboard answers are current, updating, or visibly failed — never silently unfiltered", async ({
  page,
  context,
}) => {
  const consoleErrors: ConsoleError[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error")
      consoleErrors.push({ text: msg.text(), url: msg.location().url });
  });
  page.on("pageerror", (err) => consoleErrors.push({ text: String(err) }));

  let fault: Fault = "none";
  let layerId = "";
  let releaseHeld: (() => void) | null = null;

  const errorBody = (code: string, message: string) =>
    JSON.stringify({ error: { code, message } });
  const erroredEnvelope = (code: string, message: string) =>
    JSON.stringify({ layerId, ok: false, error: { code, message } });

  await context.route("**/*", async (route: Route) => {
    const url = route.request().url();
    let hostname = "";
    try {
      hostname = new URL(url).hostname;
    } catch {
      /* non-URL requests fall through to abort */
    }
    if (!LOCAL_HOSTNAMES.has(hostname)) return route.abort();

    if (fault === "hold-values" && isValues(url) && releaseHeld === null) {
      await new Promise<void>((resolve) => {
        releaseHeld = resolve;
      });
      return route.continue();
    }
    if (fault === "settle-timeout" && isSettle(url)) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: erroredEnvelope(
          "query_timeout",
          "The query exceeded the configured timeout.",
        ),
      });
    }
    if (fault === "settle-engine-text" && isSettle(url)) {
      // The wire's message is raw engine text; a reader must never see it.
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: erroredEnvelope(
          "query_timeout",
          "LINE 1: SELECT engine_secret_detail FROM t",
        ),
      });
    }
    if (fault === "values-abort" && isValues(url)) {
      return route.abort("connectionfailed");
    }
    if (fault === "values-rate-limited" && isValues(url)) {
      return route.fulfill({
        status: 429,
        contentType: "application/json",
        body: errorBody(
          "rate_limited",
          "Too many requests. Please slow down.",
        ),
      });
    }
    if (fault === "view-errored" && isView(url)) {
      const response = await route.fetch();
      const view = (await response.json()) as {
        layers: { id: string; render: Record<string, unknown> }[];
      };
      for (const layer of view.layers) {
        layer.render = {
          layerId: layer.id,
          ok: false,
          error: {
            code: "sql_error",
            message: "LINE 1: SELECT secret_col FROM trips",
          },
        };
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(view),
      });
    }
    return route.continue();
  });

  await test.step("a hexbin map with a category widget is ready", async () => {
    await page.goto("/data");
    await page.getByRole("button", { name: "Add data" }).first().click();
    await page.locator('input[type="file"]').setInputFiles({
      name: `${tableName}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from(fixtureCsv),
    });
    await expect(
      page.getByRole("link", { name: new RegExp(tableName) }),
    ).toBeVisible({ timeout: 30_000 });

    await page.goto("/maps");
    await page.getByRole("button", { name: "New map", exact: true }).click();
    await page.waitForURL(/\/maps\/[^/]+$/);
    await page.getByRole("button", { name: "Add layer", exact: true }).click();
    // Files is the door's default — these steps drive the Tables
    // source, so select it first.
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^Tables/ })
      .click();
    await page.getByRole("button", { name: tableName, exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Add layer", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: tableName }).first(),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Saving…", { exact: true })).toBeHidden();
    await expect
      .poll(
        async () =>
          page.evaluate(async (mapId) => {
            const map = (await (
              await fetch(`/api/maps/${mapId}`, { cache: "no-store" })
            ).json()) as { layers?: { id: string }[] };
            return map.layers?.length ?? 0;
          }, mapIdOf(page)),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);

    // The settle lane needs a computed layer; the dashboard needs a card.
    layerId = await page.evaluate(async (mapId) => {
      const map = (await (
        await fetch(`/api/maps/${mapId}`, { cache: "no-store" })
      ).json()) as { layers: { id: string }[] };
      const id = map.layers[0].id;
      const viz = await fetch(`/api/layers/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          viz: { type: "hexbin", cellKm: 5, aggregate: { fn: "count" } },
        }),
      });
      if (!viz.ok) throw new Error(await viz.text());
      const widgets = await fetch(`/api/maps/${mapId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          widgets: [
            {
              id: "wcat",
              type: "category",
              layerId: id,
              title: "By cat",
              field: "cat",
              agg: "count",
              aggField: null,
              unit: null,
              note: null,
              format: null,
              visible: true,
            },
          ],
        }),
      });
      if (!widgets.ok) throw new Error(await widgets.text());
      return id;
    }, mapIdOf(page));
  });

  await test.step("a never-computed card reads as loading, not as an empty answer", async () => {
    fault = "hold-values";
    await page.reload();
    await expect(page.locator("[data-card-loading]")).toBeVisible();
    await expect(page.locator("[data-card-loading]")).toContainText(
      "Computing…",
    );
    // The loading state precedes the debounced fetch — wait for the held
    // request before releasing it.
    await expect.poll(() => releaseHeld !== null).toBe(true);
    fault = "none";
    releaseHeld!();
    await expect(page.locator("[data-card-loading]")).toHaveCount(0);
    await expect(page.locator('[data-widget-card="category"]')).toContainText(
      "alpha",
    );
  });

  await test.step("a failed settle is visibly failed with the coded reason; retry converges", async () => {
    await dashboardQuiet(page);
    fault = "settle-timeout";
    await page
      .locator('[data-widget-card="category"] button', { hasText: "alpha" })
      .click();
    const failed = page.locator("[data-settle-failed]");
    await expect(failed).toBeVisible();
    await expect(failed).toContainText("Selection not applied");
    await expect(failed).toContainText(
      "The query exceeded the configured timeout.",
    );

    fault = "none";
    await failed.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator("[data-settle-failed]")).toHaveCount(0);
  });

  await test.step("failed values never keep their numbers; retry recovers", async () => {
    await dashboardQuiet(page);
    fault = "values-abort";
    await page
      .locator('[data-widget-card="category"] button', { hasText: "beta" })
      .click();
    const railError = page.locator("[data-rail-error]");
    await expect(railError).toBeVisible();
    await expect(railError).toContainText("Could not reach the server.");
    // The records readout follows: no last number presented as current.
    await expect(page.locator("[data-records]")).toContainText("unavailable");
    await consumeExpected(consoleErrors, /widget-values/);

    fault = "none";
    await railError.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator("[data-rail-error]")).toHaveCount(0);
    await expect(page.locator("[data-records]")).not.toContainText(
      "unavailable",
    );
    // Leave the dashboard unselected for the published half: clicking an
    // excluded category lets it back in (exclusion semantics), and an
    // empty exclusion set is no selection at all.
    for (const category of ["alpha", "beta"]) {
      await dashboardQuiet(page);
      await page
        .locator('[data-widget-card="category"] button', { hasText: category })
        .click();
    }
    await expect(page.locator("[data-settle-status]")).toHaveCount(0);
  });

  let token = "";

  await test.step("the map publishes", async () => {
    token = await page.evaluate(async (mapId) => {
      const r = await fetch(`/api/maps/${mapId}/publish`, { method: "POST" });
      if (!r.ok) throw new Error(await r.text());
      return ((await r.json()) as { token: string }).token;
    }, mapIdOf(page));
    await page.goto(`/v/${token}`);
    await expect(page.locator('[data-widget-card="category"]')).toContainText(
      "alpha",
    );
  });

  await test.step("a reader sees catalogue prose on a failed settle, never engine text", async () => {
    await dashboardQuiet(page);
    fault = "settle-engine-text";
    await page
      .locator('[data-widget-card="category"] button', { hasText: "alpha" })
      .click();
    const failed = page.locator("[data-settle-failed]");
    await expect(failed).toBeVisible();
    await expect(failed).toContainText(
      "The query exceeded the configured timeout.",
    );
    await expect(page.locator("body")).not.toContainText(
      "engine_secret_detail",
    );

    fault = "none";
    await failed.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator("[data-settle-failed]")).toHaveCount(0);
  });

  await test.step("a coded refusal on reader values shows catalogue prose; retry recovers", async () => {
    await dashboardQuiet(page);
    fault = "values-rate-limited";
    await page
      .locator('[data-widget-card="category"] button', { hasText: "beta" })
      .click();
    const railError = page.locator("[data-rail-error]");
    await expect(railError).toBeVisible();
    await expect(railError).toContainText(
      "Too many requests. Retry after the indicated delay.",
    );
    await consumeExpected(consoleErrors, /widget-values/);

    fault = "none";
    await railError.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator("[data-rail-error]")).toHaveCount(0);
  });

  await test.step("a failed published layer is visible and off the legend", async () => {
    fault = "view-errored";
    await page.reload();

    const failed = page.locator("[data-layer-failed]");
    await expect(failed).toBeVisible();
    await expect(failed).toContainText("unavailable");
    await expect(failed).toContainText("The SQL failed to parse or execute.");
    await expect(page.locator("body")).not.toContainText("secret_col");
    // The legend does not advertise the failed layer: its name appears
    // exactly once on the page — in the failed state itself.
    await expect(page.getByText(tableName)).toHaveCount(1);
    fault = "none";
  });

  await test.step("no unexpected console errors escaped", () => {
    const unexpected = consoleErrors.filter(
      (entry) => !isAllowedConsoleError(entry.text, entry.url),
    );
    expect(unexpected).toEqual([]);
  });
});
