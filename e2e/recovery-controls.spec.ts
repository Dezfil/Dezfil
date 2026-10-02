// Recovery drives: the four map-level controls the record names as
// reaching the ordered lane but never individually driven through an
// injected failure — layer reorder, basemap group toggles, the legend
// corner, and the timeline (speed) — each one: a transport failure on
// ITS OWN write surfaces the lane's owned banner, the optimistic state
// rolls back to durable truth, and the very next clean attempt on the
// same control succeeds. Promotes the residual from *plausible* exactly
// as its row prescribed.
//
// Environment: the documented gate — production standalone,
// DEZFIL_RENDER_CAP_FEATURES=2000, third-party hosts blocked. Run via
// `npm run e2e:recovery` with DEZFIL_BASE_URL pointing at the server.
import { test, expect } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  FIXTURES_DIR,
  addLayer,
  consumeExpected,
  createMap,
  mapSaveArrived,
  patchMap,
  routeHouse,
  saveSettled,
  seedCsv,
  trackConsole,
} from "./support";

const runId = Date.now().toString(36);
const tableName = `rec_${runId}`;

const MAP_ROUTE = /\/api\/maps\/[^/]+$/;

const isCameraOnly = (route: Route) => {
  const body = route.request().postData();
  if (!body) return false;
  try {
    const keys = Object.keys(JSON.parse(body) as Record<string, unknown>);
    return keys.length === 1 && keys[0] === "viewport";
  } catch {
    return false;
  }
};

const isMapEdit = (route: Route) =>
  route.request().method() === "PATCH" &&
  MAP_ROUTE.test(route.request().url()) &&
  !isCameraOnly(route);

/** Arm a one-shot lost-request on the next map-lane edit. */
async function armLostRequest(page: Page): Promise<() => Promise<void>> {
  let armed = true;
  const abort = async (route: Route) => {
    if (armed && isMapEdit(route)) {
      armed = false;
      return route.abort("connectionfailed");
    }
    return route.continue();
  };
  await page.route(MAP_ROUTE, abort);
  return () => page.unroute(MAP_ROUTE, abort);
}

test("the four map-level controls fail loudly, roll back, and recover", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  const consoleErrors = trackConsole(page);
  await routeHouse(context);
  const mapBanner = page.getByText(/map save could not be confirmed/i);

  let mapId = "";
  let firstLayer = "";
  await test.step("seed: a map with two layers", async () => {
    await page.goto("/maps");
    const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
    await seedCsv(page, tableName, csv);
    mapId = await createMap(page, "recovery drives");
    firstLayer = await addLayer(
      page,
      mapId,
      `${tableName} alpha`,
      `SELECT * FROM ${tableName}`,
    );
    await addLayer(
      page,
      mapId,
      `${tableName} beta`,
      `SELECT * FROM ${tableName} WHERE kind = 'station'`,
    );
    await page.goto(`/maps/${mapId}`);
    await expect(
      page.getByRole("button", { name: new RegExp(`^${tableName} beta`) }),
    ).toBeVisible({ timeout: 30_000 });
    await saveSettled(page);
  });

  const layerOrder = () =>
    page.evaluate(async (id) => {
      const map = (await (
        await fetch(`/api/maps/${id}`, { cache: "no-store" })
      ).json()) as { layers: { id: string }[] };
      return map.layers.map((l) => l.id);
    }, mapId);

  await test.step("layer reorder: lost request → banner, rollback, clean retry lands", async () => {
    const before = await layerOrder();
    // The drag surface: each layer card carries a drag handle.
    const cardOf = (name: string) =>
      page
        .locator("li", { hasText: name })
        .filter({ has: page.locator('[data-hint="Drag or Space to reorder"]') })
        .first();
    const beta = cardOf(`${tableName} beta`);
    const alpha = cardOf(`${tableName} alpha`);
    await expect(beta).toBeVisible();
    await expect(alpha).toBeVisible();

    // A decisive swap every time: carry whichever card is on top past
    // the other card's lower edge, so the sort index must change.
    const drag = async () => {
      const betaBox = (await beta.boundingBox())!;
      const alphaBox = (await alpha.boundingBox())!;
      const [top, bottomBox] =
        betaBox.y < alphaBox.y ? [beta, alphaBox] : [alpha, betaBox];
      const handle = (await top
        .locator('[data-hint="Drag or Space to reorder"]')
        .boundingBox())!;
      const x = handle.x + handle.width / 2;
      await page.mouse.move(x, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(x, handle.y + 30, { steps: 3 });
      await page.mouse.move(x, bottomBox.y + bottomBox.height - 4, {
        steps: 10,
      });
      await page.mouse.up();
    };

    const disarm = await armLostRequest(page);
    // Residue-proof under load: a drag can fail to register while the
    // page is busy (dnd drops a gesture whose items re-render under it),
    // and the armed abort stays armed until a write goes out, so the
    // gesture is retried until the banner says the lost request was seen.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await drag();
      const seen = await mapBanner
        .waitFor({ state: "visible", timeout: 5_000 })
        .then(() => true, () => false);
      if (seen) break;
    }
    await expect(mapBanner).toBeVisible({ timeout: 15_000 });
    await consumeExpected(consoleErrors, /\/api\/maps\//);
    await disarm();
    // Rolled back to durable truth — and the ROWS re-settled to it, so
    // the retry drags a stable surface, not one mid-reconcile.
    await expect.poll(layerOrder).toEqual(before);
    await expect
      .poll(async () => {
        const b = await beta.boundingBox();
        const a = await alpha.boundingBox();
        return b !== null && a !== null && b.y < a.y;
      })
      .toBe(true);

    // The same control works on the next clean attempt. The reconcile's
    // own re-render can land mid-drag and cancel the sortable gesture
    // (dnd drops a drag when its items change under it) — that is the
    // library's documented behavior, not a lane defect — so the retry
    // re-attempts until its write lands, and the assertion stays on the
    // outcome: the order changes durably and the banner clears. The
    // assertion is the outcome — the order changed durably — so the
    // retry binds to it, not to a write having gone out: under load a
    // gesture can land a write that carries the same order.
    let landed = false;
    for (let attempt = 0; attempt < 4 && !landed; attempt += 1) {
      const patched = page
        .waitForResponse(
          (r) => r.request().method() === "PATCH" && MAP_ROUTE.test(r.url()),
          { timeout: 4_000 },
        )
        .then(
          () => true,
          () => false,
        );
      await drag();
      if (!(await patched)) continue;
      await saveSettled(page);
      landed = JSON.stringify(await layerOrder()) !== JSON.stringify(before);
    }
    expect(landed, "a clean reorder write lands and changes the order").toBe(true);
    await expect.poll(layerOrder).not.toEqual(before);
    await expect(mapBanner).toBeHidden();
  });

  await test.step("basemap group toggle: lost request → banner, rollback, clean retry lands", async () => {
    await page.getByRole("tab", { name: "Basemap" }).click();
    const labelsRow = page.locator("li", { hasText: "Labels" }).first();
    const eye = labelsRow.locator("button");
    await expect(eye).toHaveAttribute("aria-pressed", "true");

    const disarm = await armLostRequest(page);
    await eye.click();
    await expect(mapBanner).toBeVisible({ timeout: 15_000 });
    await consumeExpected(consoleErrors, /\/api\/maps\//);
    await disarm();
    // Reconciled: the group is still visible, durably and on screen.
    await expect(eye).toHaveAttribute("aria-pressed", "true");

    let arrived = mapSaveArrived(page);
    await eye.click();
    await arrived;
    await saveSettled(page);
    await expect(eye).toHaveAttribute("aria-pressed", "false");
    await expect(mapBanner).toBeHidden();
    // Restore for later steps.
    arrived = mapSaveArrived(page);
    await eye.click();
    await arrived;
    await saveSettled(page);
  });

  await test.step("legend corner: lost request → banner, rollback, clean retry lands", async () => {
    await page
      .getByRole("tablist", { name: "Builder panels" })
      .getByRole("tab", { name: "Legend" })
      .click();
    // The corner choice is the map-proxy picker: radios, not plain
    // buttons.
    const topRight = page.getByRole("radio", {
      name: "Top right",
      exact: true,
    });
    const bottomLeft = page.getByRole("radio", {
      name: "Bottom left",
      exact: true,
    });
    await expect(bottomLeft).toHaveAttribute("aria-checked", "true");

    const disarm = await armLostRequest(page);
    await topRight.click();
    await expect(mapBanner).toBeVisible({ timeout: 15_000 });
    await consumeExpected(consoleErrors, /\/api\/maps\//);
    await disarm();
    await expect(bottomLeft).toHaveAttribute("aria-checked", "true");

    const arrived = mapSaveArrived(page);
    await topRight.click();
    await arrived;
    await saveSettled(page);
    await expect(topRight).toHaveAttribute("aria-checked", "true");
    await expect(mapBanner).toBeHidden();
  });

  await test.step("timeline speed: lost request → banner, rollback, clean retry lands", async () => {
    // Dock the timeline for its own step (a timerange filter plus the
    // map-level timeline trio), then drive its speed control.
    await page.evaluate(
      async ({ id, field }) => {
        const r = await (async function readThenWriteSetup() {
const read = await fetch(`/api/layers/${id}`, { cache: "no-store" });
if (!read.ok) throw new Error(await read.text());
const shown = await read.json();
return fetch(`/api/layers/${id}`, {
          method: "PATCH",
          headers: { "X-Edit-Revision": shown.editRevision, "content-type": "application/json" },
          body: JSON.stringify({
            filters: [{ kind: "timerange", field, min: null, max: null }],
          }),
        });
})();
        if (!r.ok) throw new Error(await r.text());
      },
      { id: firstLayer, field: "ts" },
    );
    await patchMap(page, mapId, {
      timeline: { layerId: firstLayer, field: "ts", speed: 1 },
    });
    await page.reload();
    await expect(page.getByTestId("timeline")).toBeVisible({
      timeout: 30_000,
    });
    await saveSettled(page);
    const speed = page.getByRole("button", { name: "Playback speed" });
    await expect(speed).toHaveText("1×");

    const disarm = await armLostRequest(page);
    await speed.click();
    await expect(mapBanner).toBeVisible({ timeout: 15_000 });
    await consumeExpected(consoleErrors, /\/api\/maps\//);
    await disarm();
    await expect(speed).toHaveText("1×");

    const arrived = mapSaveArrived(page);
    await speed.click();
    await arrived;
    await saveSettled(page);
    await expect(speed).toHaveText("2×");
    await expect(mapBanner).toBeHidden();
  });

  await test.step("timeline undock and dock: lost requests → banner, rollback, clean retries land", async () => {
    // The trio's other two controls: the filter row's
    // Playback toggle undocks (timeline: null) and docks the timeline —
    // both map-lane writes, each driven through its own failure. The
    // timeline BAR carries a same-named collapse control, so the row's
    // toggle is pinned by its Playback text.
    await page
      .getByRole("tablist", { name: "Builder panels" })
      .getByRole("tab", { name: "Layers" })
      .click();
    await page
      .getByRole("button", { name: new RegExp(`^${tableName} alpha`) })
      .first()
      .click();
    const rowToggle = page
      .locator("button", { hasText: "Playback" })
      .first();
    await expect(rowToggle).toHaveAttribute("aria-pressed", "true");

    // UNDOCK under a lost request: still docked, banner, then a clean
    // undock lands.
    let disarm = await armLostRequest(page);
    await rowToggle.click();
    await expect(mapBanner).toBeVisible({ timeout: 15_000 });
    await consumeExpected(consoleErrors, /\/api\/maps\//);
    await disarm();
    await expect(page.getByTestId("timeline")).toBeVisible();
    await expect(rowToggle).toHaveAttribute("aria-pressed", "true");
    let arrived = mapSaveArrived(page);
    await rowToggle.click();
    await arrived;
    await saveSettled(page);
    await expect(page.getByTestId("timeline")).toBeHidden();
    await expect(mapBanner).toBeHidden();

    // DOCK under a lost request: still hidden, banner, then a clean dock
    // lands.
    disarm = await armLostRequest(page);
    await rowToggle.click();
    await expect(mapBanner).toBeVisible({ timeout: 15_000 });
    await consumeExpected(consoleErrors, /\/api\/maps\//);
    await disarm();
    await expect(page.getByTestId("timeline")).toBeHidden();
    await expect(rowToggle).toHaveAttribute("aria-pressed", "false");
    arrived = mapSaveArrived(page);
    await rowToggle.click();
    await arrived;
    await saveSettled(page);
    await expect(page.getByTestId("timeline")).toBeVisible();
    await expect(mapBanner).toBeHidden();
  });

  await test.step("the console carries only the injected fault's shadows", async () => {
    // Every transport failure in this suite is one WE injected on the
    // map lane (route.abort("connectionfailed") on /api/maps/{id});
    // Chromium logs the failed-resource line for that class more than
    // once per abort, so the shadows are consumed as a class scoped to
    // exactly the injected code and the injected URL — anything else on
    // the console still fails the suite.
    const injectedShadow = (e: { text: string; url?: string }) =>
      /net::ERR_CONNECTION_FAILED/i.test(e.text) &&
      (e.url ?? "").endsWith(`/api/maps/${mapId}`);
    const unexpected = consoleErrors.filter(
      (e) => !injectedShadow(e) && !isAllowedConsoleError(e.text, e.url),
    );
    expect(unexpected).toEqual([]);
  });
});
