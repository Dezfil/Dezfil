// Mutation ordering and recovery: the guarantees that only show up when
// writes overlap or fail. Everything here is injected at the network
// boundary — delayed responses, dropped requests, dropped responses, key
// auto-repeat — because none of it is reachable by clicking alone. Like
// the core journey: third-party hosts blocked, no sleeps, no retries.
import { test, expect } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const saveSettled = (page: Page) =>
  expect(page.getByText("Saving…", { exact: true })).toBeHidden();

const runId = Date.now().toString(36);
const tableName = `mjourney_${runId}`;

const fixtureCsv = [
  "name,lon,lat,riders",
  "Alexanderplatz,13.4133,52.5219,10450",
  "Hauptbahnhof,13.3696,52.5251,22310",
  "Warschauer Str,13.4499,52.5058,780",
  "Zoologischer Garten,13.3326,52.5073,15600",
].join("\n");

type ConsoleError = { text: string; url?: string };

type JourneyMap = {
  name: string;
  basemap: string | null;
  basemapLayers: Record<string, boolean> | null;
  legendCorner: string | null;
  widgets: { id: string }[];
  layers: { id: string; name: string; style: { opacity: number } }[];
};

const mapIdOf = (page: Page) =>
  new URL(page.url()).pathname.split("/").filter(Boolean).at(-1)!;

/** Layer rows toggle their style panel open/closed on click (same idiom as
 * journey.spec.ts's "a data-driven fill" step) — select only if it isn't
 * already expanded, so a layer left selected from a prior step doesn't get
 * collapsed by a redundant click. */
async function ensureLayerSelected(page: Page, layerName: string) {
  const opacity = page.getByRole("slider", { name: "Layer opacity" });
  if (!(await opacity.isVisible())) {
    await page
      .getByRole("button", { name: new RegExp(`^${layerName}`) })
      .click();
  }
  await expect(opacity).toBeVisible();
  return opacity;
}

/** Read durable map truth through the same API the builder reconciles against. */
async function readMap(page: Page): Promise<JourneyMap> {
  return page.evaluate(async (mapId) => {
    const response = await fetch(`/api/maps/${mapId}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()) as JourneyMap;
  }, mapIdOf(page));
}

/** Consume the browser's expected console shadow of an intentional abort. */
async function consumeTransportAbort(errors: ConsoleError[], route: RegExp) {
  const find = () =>
    errors.findIndex(
      (entry) =>
        /net::ERR_/i.test(entry.text) && route.test(entry.url ?? entry.text),
    );
  await expect.poll(find).toBeGreaterThanOrEqual(0);
  errors.splice(find(), 1);
}

const isMapPatch = (route: Route) =>
  route.request().method() === "PATCH" &&
  /\/api\/maps\/[^/]+$/.test(route.request().url());

/** The camera writes to the same endpoint; only real edits carry these. */
const isCameraPatch = (route: Route) => {
  const body = route.request().postData() ?? "";
  return body.includes('"viewport"');
};

test("mutations order, recover, and tell the truth", async ({
  page,
  context,
}) => {
  const consoleErrors: ConsoleError[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error")
      consoleErrors.push({ text: msg.text(), url: msg.location().url });
  });
  page.on("pageerror", (err) => consoleErrors.push({ text: String(err) }));

  await context.route("**/*", (route) => {
    let hostname = "";
    try {
      hostname = new URL(route.request().url()).hostname;
    } catch {
      /* non-URL requests fall through to abort */
    }
    if (LOCAL_HOSTNAMES.has(hostname)) return route.continue();
    return route.abort();
  });

  await test.step("a map with one layer is ready", async () => {
    await page.goto("/data");
    await page.getByRole("button", { name: "Add data" }).first().click();
    await page.locator('input[type="file"]').setInputFiles({
      name: `${tableName}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from(fixtureCsv),
    });
    // Residue-proof: the host closes on a clean batch; then narrow the page
    // to this run's table before the wait, so a Data page carrying other
    // suites' tables renders one card, not hundreds.
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 60_000 });
    await page.getByLabel("Search data").fill(tableName);
    // The view preference is workspace-global: the table's link is the
    // grid card's, so ask for the grid (a list row names it in a cell).
    await page.getByRole("button", { name: "Grid view", exact: true }).click();
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
      page.getByRole("button", { name: new RegExp(`^${tableName}`) }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await saveSettled(page);
  });

  await test.step("overlapping map saves settle on the newer edit", async () => {
    // Hold the first real map save open, let the second overtake it on the
    // wire, then release. Applied in arrival order the older basemap would
    // win; the lane must settle on the newer one.
    let held: (() => void) | null = null;
    const holdFirst = async (route: Route) => {
      if (!isMapPatch(route) || isCameraPatch(route) || held !== null) {
        return route.continue();
      }
      await new Promise<void>((resolve) => {
        held = resolve;
      });
      return route.continue();
    };
    await page.route(/\/api\/maps\/[^/]+$/, holdFirst);

    await page.getByRole("tab", { name: "Basemap" }).click();
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await expect.poll(() => held !== null).toBe(true);
    // The second edit is issued while the first is still on the wire.
    await page.getByRole("button", { name: "Light", exact: true }).click();
    held!();
    await saveSettled(page);

    await expect.poll(async () => (await readMap(page)).basemap).toBe("light");
    await page.unroute(/\/api\/maps\/[^/]+$/, holdFirst);
  });

  await test.step("a map save never reverts a newer layer edit", async () => {
    // The map response embeds the whole layer set as the server read it.
    // Hold one open, queue a layer edit, then release: the ordered layer
    // write must land afterwards and survive in the next commit's base.
    await page.getByRole("tab", { name: "Layers" }).click();
    const opacity = await ensureLayerSelected(page, tableName);
    await opacity.scrollIntoViewIfNeeded();

    let held: (() => void) | null = null;
    const holdMapPatch = async (route: Route) => {
      if (!isMapPatch(route) || isCameraPatch(route) || held !== null) {
        return route.continue();
      }
      await new Promise<void>((resolve) => {
        held = resolve;
      });
      return route.continue();
    };
    await page.route(/\/api\/maps\/[^/]+$/, holdMapPatch);

    // The rename control is a button until clicked, then swaps to a bare
    // input with no accessible name (crumb-slot rename) — click to enter
    // edit mode, then fill the CSS-module-classed input.
    await page.locator('button[title^="Rename "]').click();
    const nameInput = page.locator('input[class*="nameInput"]');
    await nameInput.fill(`ordered-${runId}`);
    await nameInput.blur();
    await expect.poll(() => held !== null).toBe(true);

    // The layer edit is visible now, but its write waits for the map save.
    await opacity.fill("0.5");
    await opacity.blur();
    await expect(opacity).toHaveValue("0.5");
    expect((await readMap(page)).layers[0].style.opacity).toBe(1);

    held!();
    await expect
      .poll(async () => (await readMap(page)).layers[0].style.opacity)
      .toBe(0.5);
    await saveSettled(page);
    await page.unroute(/\/api\/maps\/[^/]+$/, holdMapPatch);

    // The stale layer set inside the map response must not have won.
    await expect(opacity).toHaveValue("0.5");
    expect((await readMap(page)).name).toBe(`ordered-${runId}`);

    // And the next layer commit must diff from real truth, not from what
    // the map response carried — the poisoning half of the finding.
    await opacity.fill("0.35");
    await opacity.blur();
    await saveSettled(page);
    await expect
      .poll(async () => (await readMap(page)).layers[0].style.opacity)
      .toBe(0.35);
  });

  await test.step("queued group toggles compose instead of reverting", async () => {
    // Two rapid whole-object edits: hide labels, then hide roads while the
    // first is still on the wire. A body built at call time would carry the
    // stale group set — the second write restoring labels. Built at its
    // turn, the writes compose.
    await page.getByRole("tab", { name: "Basemap" }).click();
    let held: (() => void) | null = null;
    const holdFirst = async (route: Route) => {
      if (!isMapPatch(route) || isCameraPatch(route) || held !== null) {
        return route.continue();
      }
      await new Promise<void>((resolve) => {
        held = resolve;
      });
      return route.continue();
    };
    await page.route(/\/api\/maps\/[^/]+$/, holdFirst);

    const groupEye = (label: string) =>
      page
        .locator('li[class*="groupRow"]', { hasText: label })
        .getByRole("button");
    await groupEye("Labels").click();
    await expect.poll(() => held !== null).toBe(true);
    await groupEye("Roads").click();
    held!();
    await saveSettled(page);
    await page.unroute(/\/api\/maps\/[^/]+$/, holdFirst);

    await expect
      .poll(async () => (await readMap(page)).basemapLayers)
      .toMatchObject({ labels: false, roads: false });

    // Restore both so later steps meet the canonical style.
    await groupEye("Labels").click();
    await saveSettled(page);
    await groupEye("Roads").click();
    await saveSettled(page);
    await expect
      .poll(async () => {
        const groups = (await readMap(page)).basemapLayers;
        return groups?.labels !== false && groups?.roads !== false;
      })
      .toBe(true);
  });

  await test.step("a lost map request rolls back and says so", async () => {
    const before = await readMap(page);
    let abortNext = true;
    const abort = async (route: Route) => {
      if (abortNext && isMapPatch(route) && !isCameraPatch(route)) {
        abortNext = false;
        return route.abort("connectionfailed");
      }
      return route.continue();
    };
    await page.route(/\/api\/maps\/[^/]+$/, abort);

    await page.getByRole("tab", { name: "Basemap" }).click();
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await expect(
      page.getByText(/map save could not be confirmed/i),
    ).toBeVisible();
    await consumeTransportAbort(consoleErrors, /\/api\/maps\//);
    await page.unroute(/\/api\/maps\/[^/]+$/, abort);

    // Reconciled to the server's actual state — the refused edit is gone.
    await expect.poll(async () => (await readMap(page)).basemap).toBe(
      before.basemap,
    );
  });

  await test.step("a lost map response reconciles without a second write", async () => {
    let patches = 0;
    const count = (req: { method(): string; url(): string; postData(): string | null }) => {
      if (
        req.method() === "PATCH" &&
        /\/api\/maps\/[^/]+$/.test(req.url()) &&
        !(req.postData() ?? "").includes('"viewport"')
      ) {
        patches += 1;
      }
    };
    page.on("request", count);

    let loseNext = true;
    const loseResponse = async (route: Route) => {
      if (loseNext && isMapPatch(route) && !isCameraPatch(route)) {
        loseNext = false;
        await route.fetch();
        return route.abort("connectionfailed");
      }
      return route.continue();
    };
    await page.route(/\/api\/maps\/[^/]+$/, loseResponse);

    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await expect(
      page.getByText(/map save could not be confirmed/i),
    ).toBeVisible();
    await consumeTransportAbort(consoleErrors, /\/api\/maps\//);
    await page.unroute(/\/api\/maps\/[^/]+$/, loseResponse);

    // The server committed: the durable value stands, found by re-reading
    // rather than guessing — and the write was never retried.
    await expect.poll(async () => (await readMap(page)).basemap).toBe("dark");
    expect(patches).toBe(1);
    page.off("request", count);
  });

  await test.step("banners have owners and dismiss", async () => {
    // The standing map failure above is still visible; a successful LAYER
    // save must not clear it — that arbitrary coupling was the defect.
    const mapBanner = page.getByText(/map save could not be confirmed/i);
    await expect(mapBanner).toBeVisible();

    await page.getByRole("tab", { name: "Layers" }).click();
    const opacity = await ensureLayerSelected(page, tableName);
    await opacity.fill("0.8");
    await opacity.blur();
    await saveSettled(page);
    await expect(mapBanner).toBeVisible();

    // Its own lane's next success clears it.
    await page.getByRole("tab", { name: "Basemap" }).click();
    await page.getByRole("button", { name: "Light", exact: true }).click();
    await saveSettled(page);
    await expect(mapBanner).toBeHidden();

    // And a standing failure can simply be dismissed.
    let abortNext = true;
    const abort = async (route: Route) => {
      if (abortNext && isMapPatch(route) && !isCameraPatch(route)) {
        abortNext = false;
        return route.abort("connectionfailed");
      }
      return route.continue();
    };
    await page.route(/\/api\/maps\/[^/]+$/, abort);
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await expect(mapBanner).toBeVisible();
    await consumeTransportAbort(consoleErrors, /\/api\/maps\//);
    await page.unroute(/\/api\/maps\/[^/]+$/, abort);

    await page
      .locator("[data-map-error]", { has: mapBanner })
      .getByRole("button", { name: "Dismiss" })
      .click();
    await expect(mapBanner).toBeHidden();
  });

  await test.step("layer banners are owned per layer", async () => {
    // A failed save on one layer must keep its banner through another
    // layer's success — per-layer lanes are lanes too. Only that layer's
    // own next success clears it.
    await page.getByRole("tab", { name: "Layers" }).click();
    const secondLayer = `second_${runId}`;
    await page.getByRole("button", { name: "Add layer", exact: true }).click();
    // Files is the door's default — these steps drive the Tables
    // source, so select it first.
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^Tables/ })
      .click();
    await page.getByRole("button", { name: tableName, exact: true }).click();
    await page.getByPlaceholder("Layer name").fill(secondLayer);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Add layer", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: new RegExp(`^${secondLayer}`) }),
    ).toBeVisible({ timeout: 30_000 });
    await saveSettled(page);

    // The new layer is selected on add; fail a save on it.
    const opacity = page.getByRole("slider", { name: "Layer opacity" });
    await expect(opacity).toBeVisible();
    let abortNext = true;
    const abort = async (route: Route) => {
      if (abortNext && route.request().method() === "PATCH") {
        abortNext = false;
        return route.abort("connectionfailed");
      }
      return route.continue();
    };
    await page.route(/\/api\/layers\/[^/]+$/, abort);
    await opacity.fill("0.6");
    await opacity.blur();
    const layerBanner = page.getByText(/layer save could not be confirmed/i);
    await expect(layerBanner).toBeVisible();
    await consumeTransportAbort(consoleErrors, /\/api\/layers\//);
    await page.unroute(/\/api\/layers\/[^/]+$/, abort);

    // A successful save on the OTHER layer leaves the banner standing.
    // (The value anchors prove the panel switched before the fill: the
    // first layer sits at 0.8 from the ownership step, the failed one
    // rolled back to 1.)
    await page
      .getByRole("button", { name: new RegExp(`^${tableName}`) })
      .click();
    await expect(opacity).toHaveValue("0.8");
    await opacity.fill("0.75");
    await opacity.blur();
    await saveSettled(page);
    await expect(layerBanner).toBeVisible();

    // The failed layer's own next success clears it.
    await page
      .getByRole("button", { name: new RegExp(`^${secondLayer}`) })
      .click();
    await expect(opacity).toHaveValue("1");
    await opacity.fill("0.6");
    await opacity.blur();
    await saveSettled(page);
    await expect(layerBanner).toBeHidden();
  });

  await test.step("a failed widget edit never rolls back past an accepted one", async () => {
    // Two rapid widget edits where only the SECOND fails. The old
    // captured-prior rollback would restore state from before the FIRST —
    // undoing an edit the user was told had landed.
    await page.getByRole("tab", { name: "Widgets", exact: true }).click();
    await page.locator("[data-add-widget-row]").click();
    await page.locator('[data-add-type="note"]').click();
    await page.getByRole("textbox", { name: "Text" }).fill("first");
    await page.getByRole("button", { name: "Add note", exact: true }).click();
    await saveSettled(page);
    await expect(page.locator('[data-widget-card="note"]')).toContainText(
      "first",
    );
    expect((await readMap(page)).widgets).toHaveLength(1);

    // The accepted edit: a second note.
    await page.locator("[data-add-widget-row]").click();
    await page.locator('[data-add-type="note"]').click();
    await page.getByRole("textbox", { name: "Text" }).fill("accepted");
    await page.getByRole("button", { name: "Add note", exact: true }).click();
    await saveSettled(page);
    expect((await readMap(page)).widgets).toHaveLength(2);

    // The failing edit: a third note whose write never reaches the server.
    let abortNext = true;
    const abort = async (route: Route) => {
      if (abortNext && isMapPatch(route) && !isCameraPatch(route)) {
        abortNext = false;
        return route.abort("connectionfailed");
      }
      return route.continue();
    };
    await page.route(/\/api\/maps\/[^/]+$/, abort);
    await page.locator("[data-add-widget-row]").click();
    await page.locator('[data-add-type="note"]').click();
    await page.getByRole("textbox", { name: "Text" }).fill("refused");
    await page.getByRole("button", { name: "Add note", exact: true }).click();
    await expect(
      page.getByText(/map save could not be confirmed/i),
    ).toBeVisible();
    await consumeTransportAbort(consoleErrors, /\/api\/maps\//);
    await page.unroute(/\/api\/maps\/[^/]+$/, abort);

    // Only the refused edit is gone: the accepted one survives on screen
    // and durably — the rollback did not overshoot.
    await expect
      .poll(async () => (await readMap(page)).widgets.length)
      .toBe(2);
    await expect(
      page.locator('[data-widget-card="note"]', { hasText: "accepted" }),
    ).toBeVisible();
    await expect(
      page.locator('[data-widget-card="note"]', { hasText: "refused" }),
    ).toHaveCount(0);
    await page
      .locator("[data-map-error][data-lane='map']")
      .getByRole("button", { name: "Dismiss" })
      .click();
  });

  await test.step("an unreachable server rolls optimistic state back", async () => {
    // The ordinary outage: the PATCH fails AND the recovery read fails.
    // Optimistic widgets must not stand indefinitely as if accepted — the
    // builder falls back to the last server-confirmed state.
    let abortPatch = true;
    let abortGet = true;
    const outage = async (route: Route) => {
      if (abortPatch && isMapPatch(route) && !isCameraPatch(route)) {
        abortPatch = false;
        return route.abort("connectionfailed");
      }
      if (
        !abortPatch &&
        abortGet &&
        route.request().method() === "GET"
      ) {
        abortGet = false;
        return route.abort("connectionfailed");
      }
      return route.continue();
    };
    await page.route(/\/api\/maps\/[^/]+$/, outage);

    await page.locator("[data-add-widget-row]").click();
    await page.locator('[data-add-type="note"]').click();
    await page.getByRole("textbox", { name: "Text" }).fill("outage");
    await page.getByRole("button", { name: "Add note", exact: true }).click();
    await expect(
      page.getByText(/map save could not be confirmed/i),
    ).toBeVisible();
    // Both legs of the outage really happened.
    await consumeTransportAbort(consoleErrors, /\/api\/maps\//);
    await consumeTransportAbort(consoleErrors, /\/api\/maps\//);
    await page.unroute(/\/api\/maps\/[^/]+$/, outage);

    // The optimistic card is rolled back, not left standing; the durable
    // set never changed.
    await expect(
      page.locator('[data-widget-card="note"]', { hasText: "outage" }),
    ).toHaveCount(0);
    await expect
      .poll(async () => (await readMap(page)).widgets.length)
      .toBe(2);
    await page
      .locator("[data-map-error][data-lane='map']")
      .getByRole("button", { name: "Dismiss" })
      .click();
  });

  await test.step("each map-level control surfaces its own failure", async () => {
    // The lane is shared, but each control must actually reach it. Drive
    // a failure through each in turn and require the banner every time.
    const banner = page.getByText(/map save could not be confirmed/i);
    const controls: [string, () => Promise<void>][] = [
      [
        "rename",
        async () => {
          await page.locator('button[title^="Rename "]').click();
          const input = page.locator('input[class*="nameInput"]');
          await input.fill(`renamed-${runId}`);
          await input.blur();
        },
      ],
      [
        "basemap",
        async () => {
          await page.getByRole("tab", { name: "Basemap" }).click();
          await page.getByRole("button", { name: "Dark", exact: true }).click();
        },
      ],
      [
        "widgets",
        async () => {
          await page.getByRole("tab", { name: "Widgets", exact: true }).click();
          await page
            .locator('[data-widget-card="note"]')
            .first()
            .hover();
          await page.locator("[data-add-widget-row]").click();
          await page.locator('[data-add-type="note"]').click();
          await page.getByRole("textbox", { name: "Text" }).fill("x");
          await page
            .getByRole("button", { name: "Add note", exact: true })
            .click();
        },
      ],
    ];

    for (const [name, act] of controls) {
      let abortNext = true;
      const abort = async (route: Route) => {
        if (abortNext && isMapPatch(route) && !isCameraPatch(route)) {
          abortNext = false;
          return route.abort("connectionfailed");
        }
        return route.continue();
      };
      await page.route(/\/api\/maps\/[^/]+$/, abort);
      await act();
      await expect(banner, `${name} must surface its failure`).toBeVisible();
      await consumeTransportAbort(consoleErrors, /\/api\/maps\//);
      await page.unroute(/\/api\/maps\/[^/]+$/, abort);
      await page
        .locator("[data-map-error][data-lane='map']")
        .getByRole("button", { name: "Dismiss" })
        .click();
      await expect(banner).toBeHidden();
    }
  });

  await test.step("held undo applies one step at a time", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    let undos = 0;
    const watch = async (route: Route) => {
      if (/\/api\/maps\/[^/]+\/(undo|redo)$/.test(route.request().url())) {
        undos += 1;
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await route.continue();
        inFlight -= 1;
        return;
      }
      return route.continue();
    };
    await page.route(/\/api\/maps\/[^/]+\/(undo|redo)$/, watch);

    // A held chord auto-repeats; the builder must ignore the repeats and
    // never run two history requests together. `.down()`/`.up()` only take
    // one key at a time (unlike `.press()`'s combo-string shorthand), and
    // Playwright itself marks the second-and-later `.down()` of the same
    // key with `repeat: true` — exactly the OS-level signal a real held key
    // produces, and the signal the builder's guard reads.
    await page.locator("body").click();
    await page.keyboard.down("ControlOrMeta");
    for (let i = 0; i < 6; i++) {
      await page.keyboard.down("z");
    }
    await expect.poll(() => undos).toBeGreaterThan(0);
    await page.keyboard.up("z");
    await page.keyboard.up("ControlOrMeta");
    await saveSettled(page);

    expect(maxConcurrent).toBe(1);
    expect(undos).toBe(1);
    await page.unroute(/\/api\/maps\/[^/]+\/(undo|redo)$/, watch);
  });

  await test.step("a camera failure is silent and self-healing", async () => {
    let abortNext = true;
    const abort = async (route: Route) => {
      if (abortNext && isMapPatch(route) && isCameraPatch(route)) {
        abortNext = false;
        return route.abort("connectionfailed");
      }
      return route.continue();
    };
    await page.route(/\/api\/maps\/[^/]+$/, abort);

    const canvas = page.locator(".maplibregl-canvas");
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await expect.poll(() => abortNext).toBe(false);
    await consumeTransportAbort(consoleErrors, /\/api\/maps\//);
    await page.unroute(/\/api\/maps\/[^/]+$/, abort);

    // No banner: the camera is unrecorded and the next gesture repairs it.
    await expect(page.locator("[data-map-error]")).toHaveCount(0);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await saveSettled(page);
    await expect(page.locator("[data-map-error]")).toHaveCount(0);
  });

  await test.step("no unhandled rejections escaped", () => {
    const unexpected = consoleErrors.filter(
      (entry) => !isAllowedConsoleError(entry.text, entry.url),
    );
    expect(unexpected).toEqual([]);
  });
});
