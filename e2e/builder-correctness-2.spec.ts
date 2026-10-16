// Builder correctness II: the browser-layer regressions for
// (legend/timeline collision, builder and published viewer), (legend
// drafts survive commit echoes), (pointer gestures release on cancel),
// the workbench's no-uninvited-run contract, (text edits never recompute
// widget values), (new-layer card is loading / failed-with-retry /
// loaded — never dead), the compact-width accessible names, and the
// Data-Explorer no-results state.
//
// House rules as in the core journey: third-party hosts blocked for the
// whole run (offline basemap fallback, no tile-provider dependence), one
// long-lived router switched by a mutable fault mode, no sleeps where an
// observable signal exists, no retries.
import { test, expect } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const runId = Date.now().toString(36);
const tableName = `bcorr2_${runId}`;

// Two categories, a numeric field, and a timestamp spread — enough for a
// categorical legend with entries, a histogram brush, and the timeline.
const fixtureCsv = [
  "name,cat,val,ts,lon,lat",
  "r1,alpha,10,2024-01-01T00:00:00Z,13.40,52.50",
  "r2,alpha,20,2024-02-01T00:00:00Z,13.41,52.51",
  "r3,alpha,25,2024-03-01T00:00:00Z,13.46,52.49",
  "r4,beta,30,2024-04-01T00:00:00Z,13.42,52.52",
  "r5,beta,40,2024-05-01T00:00:00Z,13.43,52.53",
  "r6,beta,55,2024-06-01T00:00:00Z,13.44,52.54",
  "r7,beta,60,2024-07-01T00:00:00Z,13.45,52.55",
].join("\n");

type Fault = "none" | "hold-tables" | "slow-layer-patch";

type Box = { x: number; y: number; width: number; height: number };

const disjoint = (a: Box, b: Box) =>
  a.x + a.width <= b.x ||
  b.x + b.width <= a.x ||
  a.y + a.height <= b.y ||
  b.y + b.height <= a.y;

const mapIdOf = (page: Page) =>
  new URL(page.url()).pathname.split("/").filter(Boolean).at(-1)!;

type ConsoleError = { text: string; url?: string };

/** Consume the browser's expected console shadow of an injected fault. */
async function consumeExpected(errors: ConsoleError[], route: RegExp) {
  const find = () =>
    errors.findIndex((entry) => route.test(entry.url ?? entry.text));
  await expect.poll(find).toBeGreaterThanOrEqual(0);
  errors.splice(find(), 1);
}

/** An overlay's settled box: the corners glide on a CSS transition, so a
 * box is read only once two reads 250ms apart agree. */
async function settledBox(page: Page, sel: string): Promise<Box> {
  let last = await page.locator(sel).boundingBox();
  await expect
    .poll(
      async () => {
        await page.waitForTimeout(250);
        const next = await page.locator(sel).boundingBox();
        const stable =
          last !== null &&
          next !== null &&
          JSON.stringify(last) === JSON.stringify(next);
        last = next;
        return stable;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  expect(last, `${sel} has a box`).not.toBeNull();
  return last!;
}

/** Assert the two overlays' settled boxes do not intersect. */
async function expectDisjoint(
  page: Page,
  aSel: string,
  bSel: string,
): Promise<void> {
  const a = await settledBox(page, aSel);
  const b = await settledBox(page, bSel);
  expect(
    disjoint(a, b),
    `${aSel} ${JSON.stringify(a)} must not intersect ${bSel} ${JSON.stringify(b)}`,
  ).toBe(true);
}

test.describe.configure({ mode: "serial" });

test("builder correctness II — the browser regressions", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  const consoleErrors: ConsoleError[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error")
      consoleErrors.push({ text: msg.text(), url: msg.location().url });
  });
  page.on("pageerror", (err) => consoleErrors.push({ text: String(err) }));

  let fault: Fault = "none";
  let releaseTables: (() => void) | null = null;
  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    const url = request.url();
    let hostname = "";
    try {
      hostname = new URL(url).hostname;
    } catch {
      /* fall through to abort */
    }
    if (hostname === "tiles.openfreemap.org") {
      // A deterministic stub, not the network: an empty style lets
      // maplibre reach "load", so the mini-map projects its drawn
      // vertices — the vertex-drag surface is unreachable offline
      // otherwise. No source or tile is ever fetched.
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ version: 8, sources: {}, layers: [] }),
      });
    }
    if (!LOCAL_HOSTNAMES.has(hostname)) return route.abort();

    if (fault === "hold-tables" && /\/api\/tables$/.test(url)) {
      // Parked: the loading state must be observable and stable — a hung
      // load and a failed one are different truths. Releasing the park
      // turns it into a network failure.
      await new Promise<void>((resolve) => {
        releaseTables = resolve;
      });
      return route.abort("connectionfailed");
    }
    if (
      fault === "slow-layer-patch" &&
      request.method() === "PATCH" &&
      /\/api\/layers\/[^/]+$/.test(url)
    ) {
      // The write lands server-side immediately; only its echo is held —
      // the throttled-network shape the row names.
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 700));
      return route.fulfill({ response });
    }
    return route.continue();
  });

  let layerId = "";
  let viewToken = "";

  await test.step("seed: table, categorical layer, timeline, widgets, published view", async () => {
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
    const catalog = page.getByRole("dialog", { name: "Add layer" });
    const sourceNav = catalog.getByRole("navigation", {
      name: "Layer sources",
    });
    // Field round: the shared dialog's shorter default won the
    // CSS cascade and clipped the final line of the catalog rail footnote.
    // Scroll geometry names that defect directly; a sibling-path or text-
    // presence assertion would pass while the same line stayed invisible.
    expect(
      await sourceNav.evaluate(
        (nav) => nav.scrollHeight <= nav.clientHeight,
      ),
      "the add-layer source rail fits without clipping at the supported desktop viewport",
    ).toBe(true);
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

    const seeded = await page.evaluate(async (mapId) => {
      const map = (await (
        await fetch(`/api/maps/${mapId}`, { cache: "no-store" })
      ).json()) as { editRevision: string; layers: { id: string; style: Record<string, unknown> }[] };
      const id = map.layers[0].id;
      // A categorical fill so the legend has entries and a channel.
      const style = {
        ...map.layers[0].style,
        fill: {
          type: "categorical",
          attribute: "cat",
          palette: "vivid",
          map: [
            { value: "alpha", color: { r: 214, g: 96, b: 77, a: 0.9 } },
            { value: "beta", color: { r: 67, g: 147, b: 195, a: 0.9 } },
          ],
          other: { r: 180, g: 180, b: 180, a: 0.9 },
        },
      };
      let r = await fetch(`/api/layers/${id}`, {
        method: "PATCH",
        headers: { "X-Edit-Revision": map.editRevision, "content-type": "application/json" },
        body: JSON.stringify({
          style,
          filters: [{ kind: "timerange", field: "ts", min: null, max: null }],
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      r = await fetch(`/api/maps/${mapId}`, {
        method: "PATCH",
        headers: { "X-Edit-Revision": (await r.json()).editRevision, "content-type": "application/json" },
        body: JSON.stringify({
          timeline: { layerId: id, field: "ts", speed: 1 },
          widgets: [
            {
              id: "whist",
              type: "histogram",
              layerId: id,
              title: "Values",
              field: "val",
              agg: "count",
              aggField: null,
              unit: null,
              note: null,
              format: null,
              visible: true,
            },
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
      if (!r.ok) throw new Error(await r.text());
      const pub = await (async function readThenWritePublicationSetup() { const basis = await (await fetch(`/api/maps/${mapId}`)).json(); return fetch(`/api/maps/${mapId}/publish`, { headers: { "X-Edit-Revision": basis.editRevision }, method: "POST" }); })();
      if (!pub.ok) throw new Error(await pub.text());
      const { token } = (await pub.json()) as { token: string };
      return { id, token };
    }, mapIdOf(page));
    layerId = seeded.id;
    viewToken = seeded.token;
    expect(layerId).not.toBe("");
    expect(viewToken).not.toBe("");
  });

  await test.step("fullscreen glyph is coherent in both states (field round)", async () => {
    // The entry icon had accidentally combined the four fullscreen corners
    // with two diagonals from the fit/expand-arrow idiom. Hold the corrected
    // drawing as well as the state swap; an action-only assertion would pass
    // while the malformed visible mark returned.
    const enter = page.getByRole("button", { name: "Fullscreen map" });
    await expect(enter.locator("svg:visible")).toHaveCount(1);
    await expect(enter.locator("svg:visible path")).toHaveAttribute(
      "d",
      "M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6",
    );
    await enter.click();
    const exit = page.getByRole("button", { name: "Exit fullscreen map" });
    await expect(exit).toHaveAttribute("aria-pressed", "true");
    await expect(exit.locator("svg:visible")).toHaveCount(1);
    await exit.click();
    const restored = page.getByRole("button", { name: "Fullscreen map" });
    await expect(restored).toHaveAttribute("aria-pressed", "false");
    await expect(restored.locator("svg:visible")).toHaveCount(1);
  });

  await test.step("legend and timeline never overlap in the builder (1440 and 1024)", async () => {
    await page.reload();
    const legendCorner =
      '[class*="overlayCorner"][data-corner="bottom-left"]';
    const timeline = '[data-testid="timeline"]';
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 1024, height: 600 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(page.locator(timeline)).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(legendCorner)).toBeVisible();
      await expectDisjoint(page, legendCorner, timeline);
    }
  });

  await test.step("the lift is geometry-aware: a wide canvas grounds the legend beside the bar (field round)", async () => {
    const legendCorner =
      '[class*="overlayCorner"][data-corner="bottom-left"]';
    const timeline = '[data-testid="timeline"]';
    await page.setViewportSize({ width: 2000, height: 900 });
    await expect(page.locator(timeline)).toBeVisible({ timeout: 30_000 });
    // Still disjoint — but side by side now, not stacked: the corner
    // keeps its resting 16px bottom instead of taking the lift.
    await expectDisjoint(page, legendCorner, timeline);
    const canvas = await settledBox(page, "[data-drag-canvas]");
    const legend = await settledBox(page, legendCorner);
    const ground = canvas.y + canvas.height - 16;
    expect(
      Math.abs(legend.y + legend.height - ground),
      "legend rests at its grounded bottom on a wide canvas",
    ).toBeLessThanOrEqual(2);
  });

  await test.step("hiding the status bar drops the timeline into the freed band (field round)", async () => {
    const timeline = '[data-testid="timeline"]';
    const before = await settledBox(page, timeline);
    await page.getByRole("tab", { name: "Basemap" }).click();
    const eye = page
      .locator("li")
      .filter({ hasText: "Status bar" })
      .getByRole("button");
    await eye.click();
    // The dock rests where the pill sat: its resting 60px bottom gives
    // way to the pill's 16px — a 44px drop.
    const after = await settledBox(page, timeline);
    expect(Math.round(after.y - before.y)).toBe(44);
    await eye.click();
    const restored = await settledBox(page, timeline);
    expect(Math.round(restored.y - before.y)).toBe(0);
  });

  await test.step("with the bar lowered, the basemap credit lifts clear at narrow widths", async () => {
    const timeline = '[data-testid="timeline"]';
    const credit = '[data-drag-canvas] > [class*="mapCredit"]';
    await page.setViewportSize({ width: 1024, height: 600 });
    const eye = page
      .locator("li")
      .filter({ hasText: "Status bar" })
      .getByRole("button");
    // Hide the pill: the dock drops into the band the credit occupies at
    // this width, so the credit must glide above the bar.
    await eye.click();
    await expect(page.locator(timeline)).toBeVisible();
    await expectDisjoint(page, credit, timeline);
    await eye.click();
  });

  await test.step("compact header controls expose their full accessible names at 1024×600", async () => {
    await page.setViewportSize({ width: 1024, height: 600 });
    // Accessible names retain the action prefix while disclosing the target.
    // The visible text label is display:none at this width.
    for (const name of [/^Undo/, /^Redo/]) {
      await expect(
        page.getByRole("button", { name }),
      ).toBeVisible();
    }
    await expect(
      page.getByRole("link", { name: "Preview", exact: true }),
    ).toBeVisible();
  });

  await test.step("Fit to data left the header for the stage stack, directly after tilt", async () => {
    // Scoped, so placement is proven — a global name lookup would pass
    // with the button in the wrong toolbar.
    await expect(
      page.locator("header").getByRole("button", { name: "Fit to data" }),
    ).toHaveCount(0);
    const stack = page.locator('[class*="stageStack"]').first();
    await expect(
      stack.getByRole("button", { name: "Fit to data", exact: true }),
    ).toBeVisible();
    const names = await stack
      .locator("button")
      .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
    const tiltAt = names.findIndex(
      (n) => n === "Tilt the map" || n === "Back to flat",
    );
    expect(tiltAt).toBeGreaterThanOrEqual(0);
    expect(names[tiltAt + 1]).toBe("Fit to data");
    // And the glyph is one fit picture: the toolbar's whole-map fit and the layer row's
    // zoom-to-layer draw byte-identical SVG content — only the
    // wrapper's tier (size, stroke) differs. Asserted against the live
    // row icon, so neither side can drift alone.
    const fitSvg = stack
      .getByRole("button", { name: "Fit to data", exact: true })
      .locator("svg");
    // The row icon lives on the Layers tab; earlier steps left Basemap.
    await page.getByRole("tab", { name: "Layers" }).click();
    const rowSvg = page
      .getByRole("button", { name: "Zoom to layer" })
      .first()
      .locator("svg");
    await expect(rowSvg, "a layer row's zoom icon exists").toBeVisible();
    const inner = (svg: typeof fitSvg) => svg.evaluate((el) => el.innerHTML);
    expect(await inner(fitSvg), "one idea, one picture").toBe(
      await inner(rowSvg),
    );
    // The equality alone is same-source (both render one shared glyph
    // tree), so the shape itself is pinned independently: the target is a
    // circle of radius 6
    // with the four compass ticks.
    await expect(fitSvg.locator("circle")).toHaveAttribute("r", "6");
    await expect(fitSvg.locator("path")).toHaveAttribute(
      "d",
      "M12 2v3M12 19v3M2 12h3M19 12h3",
    );
  });

  await test.step("retirements: a stored Dev-mode value restores nothing", async () => {
    // The toggle, its dock, the chip panel, and the toolbar Add-data
    // entry are gone — and a legacy persisted preference must not
    // resurrect any of them.
    await page.evaluate(() =>
      window.localStorage.setItem("dezfil-devmode", "true"),
    );
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Fit to data", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Dev mode", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Add data", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel("Layer SQL", { exact: true })).toHaveCount(0);
    expect(
      await page.evaluate(() => document.body.hasAttribute("data-map-dev")),
    ).toBe(false);
    await page.evaluate(() =>
      window.localStorage.removeItem("dezfil-devmode"),
    );
  });

  await test.step("a commit echo does not discard the second field's draft or focus", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page
      .getByRole("tablist", { name: "Builder panels" })
      .getByRole("tab", { name: "Legend" })
      .click();
    const title = page.locator('input[title="Legend title"]');
    await expect(title).toBeVisible();
    const firstEntry = page.locator('[class*="entryRow"] input').first();
    await expect(firstEntry).toBeVisible();

    fault = "slow-layer-patch";
    await title.click();
    await title.fill("Trips by kind");
    const echo = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        /\/api\/layers\/[^/]+$/.test(response.url()),
    );
    // Clicking into the entry field blurs the title — the commit departs,
    // its echo held 700ms by the router — and typing continues meanwhile.
    await firstEntry.click();
    await firstEntry.fill("First bucket");
    await echo;
    // The echo has landed: the draft and focus must have survived it.
    await expect(firstEntry).toBeFocused();
    await expect(firstEntry).toHaveValue("First bucket");
    await expect(title).toHaveValue("Trips by kind");
    // The canvas legend keeps mirroring the surviving draft after the
    // echo lands: the builder drops the layer's live
    // entry when the echo arrives, and the editor republishes the draft
    // it preserved — canvas and editor must agree without another
    // keystroke.
    await expect(
      page.locator('[class*="overlayCorner"][data-corner="bottom-left"]'),
    ).toContainText("First bucket");
    const labelsEcho = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        /\/api\/layers\/[^/]+$/.test(response.url()),
    );
    await firstEntry.press("Enter");
    await labelsEcho;
    fault = "none";
    await expect(page.getByText("Saving…", { exact: true })).toBeHidden();
    // Both edits settled durably.
    const settled = await page.evaluate(async (id) => {
      const layer = (await (
        await fetch(`/api/layers/${id}`, { cache: "no-store" })
      ).json()) as { legendTitle: string | null; legendLabels: (string | null)[] | null };
      return { title: layer.legendTitle, label: layer.legendLabels?.[0] ?? null };
    }, layerId);
    expect(settled).toEqual({ title: "Trips by kind", label: "First bucket" });
  });

  await test.step("title keystrokes recompute nothing; a field change recomputes once", async () => {
    await page
      .getByRole("tablist", { name: "Builder panels" })
      .getByRole("tab", { name: "Widgets" })
      .click();
    await page.getByRole("button", { name: /By cat/ }).first().click();
    const titleInput = page
      .locator('label:has-text("Title") input')
      .first();
    await expect(titleInput).toBeVisible();
    // Let the editor's opening reads settle before counting.
    await page.waitForTimeout(700);

    let valuesRequests = 0;
    const count = (req: { url(): string; method(): string }) => {
      if (req.method() === "POST" && /\/widget-values$/.test(req.url()))
        valuesRequests += 1;
    };
    page.on("request", count);
    await titleInput.click();
    await titleInput.pressSequentially(" renamed", { delay: 30 });
    // Past the read debounce plus margin: text-only edits must stay silent.
    await page.waitForTimeout(800);
    expect(valuesRequests).toBe(0);

    // A computing change still recomputes.
    await page
      .locator('label:has-text("Group by") select')
      .first()
      .selectOption("name");
    await expect.poll(() => valuesRequests, { timeout: 5_000 }).toBe(1);
    await page.waitForTimeout(500);
    expect(valuesRequests).toBe(1);
    page.off("request", count);
    // Leave the editor without saving the field change.
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  await test.step("the edit workbench never runs SQL uninvited", async () => {
    // The retired dock auto-ran the selected layer's SQL and held the
    // answer. Its successor is stricter: opening a layer's source
    // workbench issues NO query until Run preview is asked for — and
    // reopening asks for nothing again.
    await page
      .getByRole("tablist", { name: "Builder panels" })
      .getByRole("tab", { name: "Layers" })
      .click();
    let queryRequests = 0;
    const count = (req: { url(): string; method(): string }) => {
      if (req.method() === "POST" && /\/api\/query$/.test(req.url()))
        queryRequests += 1;
    };
    page.on("request", count);
    const row = page
      .locator("li", { hasText: new RegExp(tableName) })
      .first();
    await row.getByRole("button", { name: "Layer menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "Edit source" }).click();
    const dialog = page.getByRole("dialog", { name: /Layer source/ });
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(800);
    expect(queryRequests).toBe(0);
    // An explicit run executes exactly once.
    await page.getByRole("button", { name: /Run preview/ }).click();
    await expect
      .poll(() => queryRequests, { timeout: 15_000 })
      .toBe(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // Reopening asks for nothing until asked.
    await row.getByRole("button", { name: "Layer menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "Edit source" }).click();
    await expect(page.getByRole("dialog", { name: /Layer source/ })).toBeVisible();
    await page.waitForTimeout(800);
    expect(queryRequests).toBe(1);
    page.off("request", count);
    await page.keyboard.press("Escape");
  });

  await test.step("a table click writes the whole statement, idempotently, and runs nothing", async () => {
    // The chip idiom retired: a click in the SQL view's browser replaces
    // the draft with `SELECT * FROM <table>` — a hand-edit included —
    // and never issues a query on its own.
    let queryRequests = 0;
    const count = (req: { url(): string; method(): string }) => {
      if (req.method() === "POST" && /\/api\/query$/.test(req.url()))
        queryRequests += 1;
    };
    page.on("request", count);
    await page.getByRole("button", { name: "Add layer", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add layer" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "SQL query" }).click();
    const editor = page.getByRole("textbox", { name: "New layer SQL" });
    await expect(editor).toBeVisible();
    const rowBtn = dialog.getByRole("button", {
      name: tableName,
      exact: true,
    });
    await rowBtn.click();
    await expect(editor).toHaveText(`SELECT * FROM ${tableName}`);
    // Idempotent: a second click leaves exactly one statement.
    await rowBtn.click();
    await expect(editor).toHaveText(`SELECT * FROM ${tableName}`);
    // A hand-edited draft is replaced, not appended to (gate ruling).
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" WHERE 1=1");
    await expect(editor).toHaveText(
      `SELECT * FROM ${tableName} WHERE 1=1`,
    );
    await rowBtn.click();
    await expect(editor).toHaveText(`SELECT * FROM ${tableName}`);
    await page.waitForTimeout(500);
    expect(queryRequests).toBe(0);
    page.off("request", count);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  await test.step("the new-layer card is loading, then failed with retry, then recovered", async () => {
    // A fresh builder holds no dataset list yet; the list fetch is parked
    // so the loading truth is stable and observable — a hung load reads
    // as loading, not as a dead blank and not as a failure.
    fault = "hold-tables";
    await page.reload();
    await page.getByRole("button", { name: "Add layer", exact: true }).click();
    // Files is the door's default — these steps drive the Tables
    // source, so select it first.
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^Tables/ })
      .click();
    await expect(page.getByText("Loading tables…")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Retry", exact: true }),
    ).toBeHidden();

    // Released as a failure: the error and its retry appear, card open.
    await expect.poll(() => releaseTables !== null).toBe(true);
    releaseTables!();
    releaseTables = null;
    // This surface moved onto the shared note ("Try again"); the suite
    // missed the rename in the CI-off window.
    const retry = page.getByRole("button", { name: "Try again", exact: true });
    await expect(retry).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Loading tables…")).toBeHidden();
    await expect(page.getByRole("dialog", { name: "Add layer" })).toBeVisible();
    await consumeExpected(consoleErrors, /\/api\/tables/);

    fault = "none";
    await retry.click();
    // Recovery without closing the card: the dataset chips appear.
    await expect(
      page.getByRole("button", { name: tableName, exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("dialog", { name: "Add layer" })).toBeVisible();
    // Pick the dataset, then collapse: the retained pick must never ride
    // invisibly into a later attempt.
    await page.getByRole("button", { name: tableName, exact: true }).click();
    await page.getByRole("button", { name: "Close", exact: true }).click();

    // Reopening with a previously loaded list re-establishes truth from
    // scratch: loading shows — never the stale chips
    // — and a failure surfaces even though a list was once loaded.
    fault = "hold-tables";
    await page.getByRole("button", { name: "Add layer", exact: true }).click();
    // Files is the door's default — these steps drive the Tables
    // source, so select it first.
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^Tables/ })
      .click();
    await expect(page.getByText("Loading tables…")).toBeVisible();
    await expect(
      page.getByRole("button", { name: tableName, exact: true }),
    ).toBeHidden();
    // The earlier pick has no visible chip to stand on while the list
    // loads or after it fails — the submit stays disabled, so an
    // invisible stale selection can never be added.
    const addLayer = page.getByRole("dialog").getByRole("button", {
      name: "Add layer",
      exact: true,
    });
    await expect(addLayer).toBeDisabled();
    await expect.poll(() => releaseTables !== null).toBe(true);
    releaseTables!();
    releaseTables = null;
    await expect(retry).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: tableName, exact: true }),
    ).toBeHidden();
    await expect(addLayer).toBeDisabled();
    await consumeExpected(consoleErrors, /\/api\/tables/);
    fault = "none";
    await retry.click();
    await expect(
      page.getByRole("button", { name: tableName, exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    // The catalog's state is transient: closing discarded the earlier
    // pick entirely, so the recovered list opens with nothing selected
    // and the submit still disabled — stronger than the old panel's
    // re-confirmation, and the same invariant: no invisible stale
    // selection can ever be added. A fresh pick arms it.
    await expect(
      page.getByRole("button", { name: tableName, exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await expect(addLayer).toBeDisabled();
    await page.getByRole("button", { name: tableName, exact: true }).click();
    await expect(
      page.getByRole("button", { name: tableName, exact: true }),
    ).toHaveAttribute("data-selected", "true");
    await expect(addLayer).toBeEnabled();
    await page.getByRole("button", { name: "Close", exact: true }).click();
  });

  await test.step("a surface leaving the screen mid-brush releases the gesture", async () => {
    const card = page.locator('[data-widget-card="histogram"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    const handle = card.getByLabel("Range end");
    await expect(handle).toBeVisible();

    let rangeCommits = 0;
    const count = (req: {
      url(): string;
      method(): string;
      postData(): string | null;
    }) => {
      if (
        req.method() === "POST" &&
        /\/widget-values$/.test(req.url()) &&
        (req.postData() ?? "").includes('"range"')
      )
        rangeCommits += 1;
    };
    page.on("request", count);

    await page
      .getByRole("tablist", { name: "Builder panels" })
      .getByRole("tab", { name: "Widgets" })
      .click();
    const deleteBtn = page
      .locator('[class*="rowHead"]', { hasText: "Values" })
      .locator('button[title="Delete widget"]');
    await expect(deleteBtn).toBeVisible();
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 50, box.y + box.height / 2, { steps: 4 });
    await expect(card.locator('[class*="range"]')).toBeVisible();
    // The surface leaves the screen mid-gesture: the widget is deleted
    // under the drag (a dispatched activation — the pointer stays down),
    // unmounting the card.
    await deleteBtn.dispatchEvent("click");
    await expect(card).toBeHidden();
    // Later movement and release change nothing and commit nothing.
    await page.mouse.move(box.x - 150, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    expect(rangeCommits).toBe(0);
    page.off("request", count);

    // Undo restores the widget — the deletion was one durable step.
    await expect(page.getByText("Saving…", { exact: true })).toBeHidden();
    await page.getByRole("button", { name: /^Undo/ }).click();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Saving…", { exact: true })).toBeHidden();
  });

  await test.step("a cancelled mini-map rect drag stops tracking the pointer", async () => {
    // The catalog opens from the Layers tab (the toolbar entry retired).
    await page
      .getByRole("tablist", { name: "Builder panels" })
      .getByRole("tab", { name: "Layers" })
      .click();
    await page.getByRole("button", { name: "Add layer", exact: true }).click();
    // The rail entry carries a description in its accessible name.
    await page.getByText("OpenStreetMap", { exact: true }).first().click();
    const rect = page.locator('[class*="rect"]').first();
    await expect(rect).toBeVisible({ timeout: 15_000 });
    const handle = page.locator('[data-corner="se"]').first();
    await expect(handle).toBeVisible();

    const before = (await rect.boundingBox())!;
    const start = (await handle.boundingBox())!;
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x - 40, start.y - 40, { steps: 4 });
    const during = (await rect.boundingBox())!;
    // The gesture is live: dragging the SE corner inward shrank the rect.
    expect(during.width).toBeLessThan(before.width);
    await page.evaluate(() =>
      window.dispatchEvent(new PointerEvent("pointercancel")),
    );
    const cancelled = (await rect.boundingBox())!;
    // Movement after cancellation changes nothing.
    await page.mouse.move(start.x - 120, start.y - 120, { steps: 4 });
    await page.waitForTimeout(200);
    const after = (await rect.boundingBox())!;
    expect(after).toEqual(cancelled);
    await page.mouse.up();

    // A second drag, then the mode switches under it:
    // the picker swaps surfaces while the mini-map stays mounted — a
    // dispatched activation, the pointer stays down. The hidden rect
    // must not keep following the pointer, and the next drag must not
    // find the gesture still armed.
    const s2 = (await handle.boundingBox())!;
    await page.mouse.move(s2.x + s2.width / 2, s2.y + s2.height / 2);
    await page.mouse.down();
    await page.mouse.move(s2.x - 30, s2.y - 30, { steps: 3 });
    const atSwitch = (await rect.boundingBox())!;
    await page
      .getByRole("radio", { name: "Polygon", exact: true })
      .dispatchEvent("click");
    await expect(rect).toBeHidden();
    // Movement while the surface is gone must mutate nothing; switching
    // back reveals the rect exactly as it was left.
    await page.mouse.move(s2.x - 120, s2.y - 120, { steps: 3 });
    await page.waitForTimeout(200);
    await page.mouse.up();
    await page.getByRole("radio", { name: "BBox", exact: true }).click();
    await expect(rect).toBeVisible();
    expect((await rect.boundingBox())!).toEqual(atSwitch);
    // The released gesture does not block the next one.
    const s3 = (await handle.boundingBox())!;
    await page.mouse.move(s3.x + s3.width / 2, s3.y + s3.height / 2);
    await page.mouse.down();
    await page.mouse.move(s3.x + 25, s3.y + 25, { steps: 3 });
    const resumed = (await rect.boundingBox())!;
    expect(resumed.width).toBeGreaterThan(atSwitch.width);
    await page.mouse.up();
  });

  await test.step("a cancelled mini-map vertex drag stops tracking; unmount mid-drag releases", async () => {
    // Same dialog: switch the area to a drawn polygon. The stubbed
    // basemap style lets the mini-map reach "load" and project vertices.
    await page.getByRole("radio", { name: "Polygon", exact: true }).click();
    const drawTab = page.getByRole("radio", { name: "Draw", exact: true });
    if (await drawTab.isVisible()) await drawTab.click();
    const mini = page.locator('[class*="wrap"] [class*="map"]').first();
    await expect(mini).toBeVisible();
    const m = (await mini.boundingBox())!;
    const cx = m.x + m.width / 2;
    const cy = m.y + m.height / 2;
    for (const [dx, dy] of [
      [-60, -40],
      [60, -40],
      [0, 50],
    ]) {
      await page.mouse.click(cx + dx, cy + dy);
    }
    await page.getByRole("button", { name: "Finish (Enter)" }).click();
    const vertex = page.locator('circle[class*="polyVertex"]').first();
    await expect(vertex).toBeVisible();

    const start = (await vertex.boundingBox())!;
    await page.mouse.move(
      start.x + start.width / 2,
      start.y + start.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(start.x - 30, start.y - 30, { steps: 4 });
    const during = (await vertex.boundingBox())!;
    // The drag is live: the vertex followed the pointer.
    expect(during.x).not.toBe(start.x);
    await page.evaluate(() =>
      window.dispatchEvent(new PointerEvent("pointercancel")),
    );
    const cancelled = (await vertex.boundingBox())!;
    // Movement after cancellation changes nothing.
    await page.mouse.move(start.x - 110, start.y - 110, { steps: 4 });
    await page.waitForTimeout(200);
    const after = (await vertex.boundingBox())!;
    expect(after).toEqual(cancelled);
    await page.mouse.up();

    // A second drag, then the surface leaves the screen mid-gesture:
    // Escape closes the dialog and unmounts the mini-map with the
    // pointer still down — the teardown must release cleanly (the final
    // zero-unexpected-console-errors assertion holds the proof).
    const v2 = (await vertex.boundingBox())!;
    await page.mouse.move(v2.x + v2.width / 2, v2.y + v2.height / 2);
    await page.mouse.down();
    await page.mouse.move(v2.x - 25, v2.y - 25, { steps: 3 });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Add layer" })).toBeHidden();
    await page.mouse.move(v2.x - 90, v2.y - 90, { steps: 3 });
    await page.mouse.up();
  });

  await test.step("published viewer: legend and timeline never overlap (1440 and 1024)", async () => {
    await page.goto(`/v/${viewToken}`);
    const corner = '[class*="cornerBottomLeft"]';
    const timeline = '[data-testid="timeline"]';
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 1024, height: 600 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(page.locator(timeline)).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(corner)).toBeVisible();
      await expectDisjoint(page, corner, timeline);
    }
  });

  await test.step("published viewer: a wide viewport grounds the legend beside the bar (field round)", async () => {
    const corner = '[class*="cornerBottomLeft"]';
    const timeline = '[data-testid="timeline"]';
    await page.setViewportSize({ width: 2000, height: 900 });
    await expect(page.locator(timeline)).toBeVisible({ timeout: 30_000 });
    await expectDisjoint(page, corner, timeline);
    // Grounded at the viewer's resting 44px bottom, not the 138px lift.
    const legend = await settledBox(page, corner);
    expect(
      Math.abs(legend.y + legend.height - (900 - 44)),
      "viewer legend rests at its grounded bottom on a wide viewport",
    ).toBeLessThanOrEqual(2);
  });

  await test.step("a cancelled brush on the published rail commits no phantom selection", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const card = page.locator('[data-widget-card="histogram"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    const handle = card.getByLabel("Range end");
    await expect(handle).toBeVisible();

    let rangeCommits = 0;
    const count = (req: {
      url(): string;
      method(): string;
      postData(): string | null;
    }) => {
      if (
        req.method() === "POST" &&
        /\/widget-values$/.test(req.url()) &&
        (req.postData() ?? "").includes('"range"')
      )
        rangeCommits += 1;
    };
    page.on("request", count);

    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 60, box.y + box.height / 2, { steps: 5 });
    // The draft is live on the card…
    await expect(card.locator('[class*="range"]')).toBeVisible();
    // …and cancellation ends the gesture without committing it.
    await page.evaluate(() =>
      window.dispatchEvent(new PointerEvent("pointercancel")),
    );
    await expect(card.locator('[class*="range"]')).toBeHidden();
    await page.mouse.move(box.x - 160, box.y + box.height / 2, { steps: 5 });
    await page.waitForTimeout(600);
    expect(rangeCommits).toBe(0);
    await expect(card.locator('[class*="range"]')).toBeHidden();
    await page.mouse.up();

    // A completed drag still commits — the gesture itself is intact.
    const again = (await handle.boundingBox())!;
    await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
    await page.mouse.down();
    await page.mouse.move(again.x - 60, again.y + again.height / 2, {
      steps: 5,
    });
    await page.mouse.up();
    await expect(card.locator('[class*="range"]')).toBeVisible();
    await expect.poll(() => rangeCommits, { timeout: 5_000 }).toBe(1);
    page.off("request", count);
  });

  // Every console error is either an allowed offline shadow or a bug.
  const unexpected = consoleErrors.filter(
    (entry) => !isAllowedConsoleError(entry.text, entry.url),
  );
  expect(unexpected).toEqual([]);
});

test("the Data Explorer never leaves a blank result area on zero matches", async ({
  page,
  context,
}) => {
  // The empty-catalog state is driven at the network boundary (a
  // deterministic [] response) rather than by emptying the server —
  // earlier tests in this serial file seed durable tables.
  let emptyCatalog = false;
  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    let hostname = "";
    try {
      hostname = new URL(request.url()).hostname;
    } catch {
      /* fall through */
    }
    if (!LOCAL_HOSTNAMES.has(hostname)) return route.abort();
    if (
      emptyCatalog &&
      request.method() === "GET" &&
      /\/api\/tables$/.test(request.url())
    ) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      });
    }
    return route.continue();
  });

  // An empty catalog shows the actionable add-data tile, never a blank
  // area.
  emptyCatalog = true;
  await page.goto("/data");
  await expect(
    page.getByRole("button", {
      name: /Add data Upload a file or import from a source/,
    }),
  ).toBeVisible();
  emptyCatalog = false;

  await page.reload();
  const search = page.getByRole("textbox", { name: "Search data" });
  await expect(search).toBeVisible();
  const noResults = page.getByText(
    "No tables match. Clear the search or filters.",
    { exact: true },
  );
  // The catalog is non-empty (the serial file seeded it): rows first.
  await expect(page.getByRole("link", { name: /bcorr2_/ }).first()).toBeVisible();

  // Search-only zero match, grid then list view.
  await search.fill("zz_nothing_matches_this_zz");
  await expect(noResults).toBeVisible();
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await expect(noResults).toBeVisible();

  // Search + source-filter combination, list then grid view.
  const chips = page.getByRole("group", { name: "Filter tables" });
  await chips.getByRole("button", { name: /^Files/ }).click();
  await expect(noResults).toBeVisible();
  await page.getByRole("button", { name: "Grid view", exact: true }).click();
  await expect(noResults).toBeVisible();

  // Clearing search and filter restores the catalog with no leftover
  // empty-state text.
  await search.fill("");
  await chips.getByRole("button", { name: /^All/ }).click();
  await expect(noResults).toBeHidden();
  await expect(page.getByRole("link", { name: /bcorr2_/ }).first()).toBeVisible();
});
