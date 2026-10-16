// The browser journey: the core loop through the real UI — upload → SQL
// → layer → data-driven style → publish → published view. Third-party
// hosts are blocked for the whole run, so the journey always exercises
// the product's offline basemap fallback and never depends on
// tile-provider uptime. Every step waits on an observable signal; there
// are no sleeps and (per config) no retries.
//
// Start the target server with DEZFIL_RENDER_CAP_FEATURES=2000, as CI
// does — the over-budget steps build 52,001-feature layers that must
// cross the cap to exercise the tiled road; under the 250,000 default
// they render inline and the tiled assertions cannot be met.
import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { isAllowedConsoleError } from "./console-allowlist";
import { MAP_SHOT_STYLE, tiltDiagnostic } from "./support";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// The header shows a transient "Saving…" whisper only while a write is in
// flight (dropped the persistent Saved badge) — settled means the whisper
// is gone.
const saveSettled = (page: Page) =>
  expect(page.getByText("Saving…", { exact: true })).toBeHidden();

// The whisper is also *transient*: on a fast local write it can appear and
// clear between an action's completion and an assertion's first poll, so
// asserting it visible fails intermittently with no regression behind it.
// Steps that must observe a write starting anchor on an arrival
// signal instead: the layer write's own response, armed before the action
// that triggers it.
const layerSaveArrived = (page: Page) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      /\/api\/layers\/[^/]+$/.test(response.url()),
  );

// The camera persists through the same map PATCH surface but on its own
// latest-wins lane, and a rail or panel resize recenters the map, whose
// moveend then lands a viewport write at an arbitrary later moment — one
// such viewport-only PATCH landed inside a zero-write counting window
// and failed it, with the trace preserved. Zero-write windows assert the
// *edit* surface stays quiet; the camera lane is not an edit and is
// excluded by payload.
const isCameraOnlyWrite = (req: { postData(): string | null }) => {
  const body = req.postData();
  if (!body) return false;
  try {
    const keys = Object.keys(JSON.parse(body) as Record<string, unknown>);
    return keys.length === 1 && keys[0] === "viewport";
  } catch {
    return false;
  }
};

// An undo is one queued step: its request, its answer, then its layers'
// render replacement. Until that settles the history buttons read
// disabled, and a redo chord pressed meanwhile is refused as a press on
// the disabled button would be. A click waits for its button; a chord
// does not, so the chord waits for Redo to come back.
const redoReady = (page: Page) =>
  expect(page.getByRole("button", { name: /^Redo/ })).toBeEnabled();

// Pixel-equality polls clip inside the map card's 22px border-radius:
// the card's own clipped-corner antialiasing is not byte-stable across
// separately composited frames, and the curve is a structural edge of
// the screenshot region, not a maskable node.
const MAP_SHOT_INSET = 12;

// The floating chrome inside the map card. The status pill and timeline
// carry live readouts; the rest (stage stack, corner overlays, offline
// pill, basemap credit) is static, but its rounded-corner antialiasing is
// not byte-stable across separately composited frames, which a byte-exact
// poll then reads as a restyle that never settles. The tooltip is chrome
// too: mask insertion itself synthesizes hover at a parked pointer, so a
// reference shot can catch the bubble mid-arm and never settle again.
const CHROME_MASKS = [
  "[data-status-bar]",
  '[class*="timelineDock"]',
  '[class*="stageStack"]',
  '[class*="overlayCorner"]',
  '[class*="offline"]',
  '[class*="BasemapCredit-module"]',
  "[data-hint-bubble]",
];

// A mask hides whatever it covers, so a masked element that grows over
// the map (a layout defect) would turn a real pixel change into a poll
// that times out as "the map did not change". Each masked element is
// held to a minor share of the shot first, so that defect fails by name.
const MASK_SHARE_MAX = 0.25;

/** The rendered map inside the card, every floating chrome element
 * masked, the clip inset past the card's corner radius by the caller.
 * The save status chip lives inside the clip and fades for 430 ms after
 * every save; the shot holds it out for its own duration (MAP_SHOT_STYLE). */
async function maskedMapShot(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
) {
  const shares = await page.evaluate(
    ({ selectors, clip }) =>
      selectors.map((selector) => {
        let largest = 0;
        for (const element of document.querySelectorAll(selector)) {
          const r = element.getBoundingClientRect();
          const w = Math.min(r.right, clip.x + clip.width) - Math.max(r.left, clip.x);
          const h = Math.min(r.bottom, clip.y + clip.height) - Math.max(r.top, clip.y);
          if (w > 0 && h > 0) largest = Math.max(largest, (w * h) / (clip.width * clip.height));
        }
        return largest;
      }),
    { selectors: CHROME_MASKS, clip },
  );
  CHROME_MASKS.forEach((selector, i) => {
    expect(
      shares[i],
      `the mask ${selector} covers ${Math.round(shares[i] * 100)}% of the map shot`,
    ).toBeLessThan(MASK_SHARE_MAX);
  });
  return page.screenshot({
    style: MAP_SHOT_STYLE,
    clip,
    mask: CHROME_MASKS.map((selector) => page.locator(selector)),
  });
}

// Unique per run so repeated local runs never collide on table names.
const runId = Date.now().toString(36);
const tableName = `bjourney_${runId}`;
const verificationScreens = "test-results/verification-screens";

type ConsoleError = { text: string; url?: string };

type JourneyLayer = {
  id: string;
  name: string;
  sql: string;
  style: { opacity: number };
  filters?: Array<{
    kind: string;
    field: string;
    min?: string | number | null;
    max?: string | number | null;
  }>;
  viz: {
    type: string;
    aggregate?: { fn: string; attribute?: string };
    fill?: { type: string; breaks?: number[] };
  };
};

// Same shape as the headless journey's fixture: a CSV whose lon/lat
// columns become point geometry on ingest — plus a timestamp column so
// the journey can dock the timeline.
const fixtureCsv = [
  "name,lon,lat,riders,seen",
  "Alexanderplatz,13.4133,52.5219,10450,2021-03-01 08:30:00",
  "Hauptbahnhof,13.3696,52.5251,22310,2021-03-01 17:45:00",
  "Warschauer Str,13.4499,52.5058,780,2021-03-02 12:00:00",
  "Zoologischer Garten,13.3326,52.5073,15600,2021-03-03 09:15:00",
].join("\n");

/** Begin a real pointer drag and intentionally leave the pointer held. */
async function beginSliderDrag(
  page: Page,
  slider: Locator,
  targetFraction: number,
) {
  await slider.scrollIntoViewIfNeeded();
  const tagName = await slider.evaluate((element) => element.tagName);
  if (tagName !== "INPUT") {
    const track = slider.locator("..");
    const handleBox = await slider.boundingBox();
    const trackBox = await track.boundingBox();
    await page.mouse.move(
      handleBox!.x + handleBox!.width / 2,
      handleBox!.y + handleBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      trackBox!.x + trackBox!.width * targetFraction,
      handleBox!.y + handleBox!.height / 2,
      { steps: 10 },
    );
    return;
  }
  const box = await slider.boundingBox();
  const min = Number(await slider.getAttribute("min"));
  const max = Number(await slider.getAttribute("max"));
  const value = Number(await slider.inputValue());
  const startFraction = (value - min) / (max - min);
  const x = (fraction: number) =>
    box!.x + 4 + (box!.width - 8) * fraction;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x(startFraction), y);
  await page.mouse.down();
  await page.mouse.move(x(targetFraction), y, { steps: 10 });
}

/** Read one durable layer through the same API the builder reconciles against. */
async function readBuilderLayer(page: Page, name: string): Promise<JourneyLayer> {
  const mapId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1)!;
  return page.evaluate(
    async ({ mapId, name }) => {
      const response = await fetch(`/api/maps/${mapId}`);
      if (!response.ok) throw new Error(await response.text());
      const map = (await response.json()) as { layers: JourneyLayer[] };
      const layer = map.layers.find((candidate) => candidate.name === name);
      if (!layer) throw new Error(`Layer ${name} was not found.`);
      return layer;
    },
    { mapId, name },
  );
}

/** Consume the browser's expected console shadow of an intentional abort. */
async function consumeTransportAbort(errors: ConsoleError[]) {
  const find = () =>
    errors.findIndex(
      (entry) =>
        /net::ERR_/i.test(entry.text) &&
        /\/api\/layers\//.test(entry.url ?? entry.text),
    );
  await expect.poll(find).toBeGreaterThanOrEqual(0);
  errors.splice(find(), 1);
}

test("the core loop through the real UI", async ({ page, context }) => {
  await mkdir(verificationScreens, { recursive: true });
  // The approximate-preview badge is born mid-step, so a screenshot mask
  // cannot neutralize it: the mask box itself would appear in only one of
  // two compared frames and flip the comparison exactly like the badge. Painting it transparent
  // removes it from every
  // frame alike — while its own step still asserts DOM visibility, which
  // opacity does not affect. Injected per document so reloads keep it.
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent =
        '[class*="previewBadge"] { opacity: 0 !important; }';
      document.head.appendChild(style);
    });
  });
  const consoleErrors: ConsoleError[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error")
      consoleErrors.push({ text: msg.text(), url: msg.location().url });
  });
  page.on("pageerror", (err) => {
    consoleErrors.push({ text: String(err) });
  });

  // Determinism by construction: nothing outside the instance is reachable.
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

  await test.step("the instance is ready", async () => {
    // The root is Home, the signed-in person's own page; the data hub
    // lives at /data. Home greets the person by the first word of their
    // display name, "Welcome back" once work of their own leads it.
    await page.goto("/");
    await expect(page.locator('[data-health="ready"]')).toBeVisible();
    const name = await page.evaluate(async () => {
      const response = await fetch("/api/account");
      return ((await response.json()) as { account: { name: string } }).account.name;
    });
    const first = name.trim().split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      new RegExp(`^Welcome(?: back)?, ${first}$`),
    );
  });

  await test.step("an uploaded file becomes a table", async () => {
    await page.goto("/data");
    // The data hub is the Data gallery (called Data; the heading carries
    // its count pill, so the name is matched by prefix).
    await expect(
      page.getByRole("heading", { name: /^Data(\s|$)/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add data" }).first().click();
    await page.locator('input[type="file"]').setInputFiles({
      name: `${tableName}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from(fixtureCsv),
    });
    // The row appears once upload + GeoParquet conversion finish.
    // Residue-proof: the host closes on a clean batch; then narrow the page
    // to this run's table before the wait, so a Data page carrying other
    // suites' tables renders one card, not hundreds.
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 60_000 });
    await page.getByLabel("Search data").fill(tableName);
    // The view preference is workspace-global: the table's link is the
    // grid card's, so ask for the grid (a list row names it in a cell).
    await page.getByRole("button", { name: "Grid view", exact: true }).click();
    const row = page.getByRole("link", { name: new RegExp(tableName) });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText("4 rows");
  });

  await test.step("the dataset detail previews map and data", async () => {
    await page.getByRole("link", { name: `Open ${tableName}` }).click();
    await expect(page.getByRole("heading", { name: tableName })).toBeVisible();
    // Map preview is the default tab; its readout stays truthful even
    // with the basemap host blocked (features are local).
    await expect(page.getByText("4 features")).toBeVisible({
      timeout: 15_000,
    });
    // The map must actually occupy the pane — MapLibre's own stylesheet
    // once won the cascade and collapsed the container to 0px height.
    const canvasBox = await page.locator(".maplibregl-canvas").boundingBox();
    expect(canvasBox?.height ?? 0).toBeGreaterThan(300);
    await page.getByRole("tab", { name: "Data preview" }).click();
    await expect(
      page.getByRole("cell", { name: "Hauptbahnhof" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Back to Data" }).click();
    await expect(
      page.getByRole("heading", { name: /^Data(\s|$)/ }),
    ).toBeVisible();
  });

  await test.step("SQL returns the rows", async () => {
    await page.goto("/sql");
    // The workspace editor is CodeMirror — a contenteditable carrying
    // the label, not an input, so its text is read and replaced by
    // keystroke (the idiom the other workspace specs already use).
    const editor = page.getByLabel("SQL editor");
    // The console opens empty: no automatic seed to race, so the mounted
    // editor is the settled signal. The editor is lazily imported — wait
    // for it to be on the page, then type.
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    await page.keyboard.type(
      `SELECT * FROM ${tableName} ORDER BY riders DESC;`,
    );
    await page.getByRole("button", { name: "Run query" }).click();
    // The result's own count: the assistant, where one is configured,
    // repeats it with the run's time in its context line.
    await expect(
      page.getByRole("region", { name: "Results" }).getByText("4 rows", { exact: true }),
    ).toBeVisible();
    // The result grid itself, not just the meta line.
    await expect(
      page.getByRole("cell", { name: "Hauptbahnhof" }),
    ).toBeVisible();
  });

  await test.step("a new map opens the builder", async () => {
    await page.goto("/maps");
    // exact — the gallery's ghost tile also says "New map".
    await page.getByRole("button", { name: "New map", exact: true }).click();
    await page.waitForURL(/\/maps\/[^/]+$/);
    await expect(page.locator('button[title^="Rename "]')).toBeVisible();
  });

  await test.step("the SQL result becomes a rendered layer", async () => {
    await page.getByRole("button", { name: "Add layer", exact: true }).click();
    // Files is the door's default — these steps drive the Tables
    // source, so select it first.
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^Tables/ })
      .click();
    // The table row prefills the layer name; the implied query is
    // submitted unshown.
    await page.getByRole("button", { name: tableName, exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Add layer", exact: true })
      .click();
    await expect(page.getByText("4 features")).toBeVisible({
      timeout: 30_000,
    });
  });

  await test.step("a data-driven fill builds a real legend", async () => {
    // A freshly added layer is auto-selected; select it only if the style
    // panel isn't already expanded (clicking the label toggles selection).
    const fillLabel = page.getByText("Fill", { exact: true });
    if (!(await fillLabel.isVisible())) {
      await page
        .getByRole("button", { name: new RegExp(`^${tableName}`) })
        .click();
    }
    await expect(fillLabel).toBeVisible();
    // The first select after the "Fill" group label is the fill attribute
    // (Visualization's size select and Outline's mirror offer the same
    // attribute options, so position is the discriminator).
    await fillLabel
      .locator("xpath=following::select[1]")
      // Plain attribute labels since the restyle.
      .selectOption({ label: "riders" });
    // The canvas legend overlay now carries the layer title and classes.
    const legend = page.locator("[data-corner]", {
      hasText: tableName,
    });
    await expect(legend).toBeVisible();
    await expect
      .poll(async () => legend.locator("li").count())
      .toBeGreaterThan(1);
  });

  await test.step("undo reverts the styling; redo restores it", async () => {
    // The data-driven fill was the newest recorded step. Undo returns the
    // layer to its constant fill — which, shows the compact swatch row
    // instead of vanishing: the class rows going and the single row
    // arriving is the observable signal.
    const legend = page.locator("[data-corner]", { hasText: tableName });
    const undo = page.getByRole("button", { name: "Undo" });
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(legend).toBeVisible();
    await expect.poll(async () => legend.locator("li").count()).toBe(0);
    // Redo through the keyboard chord — the other half of the surface.
    await redoReady(page);
    await page.keyboard.press("ControlOrMeta+Shift+Z");
    await expect
      .poll(async () => legend.locator("li").count())
      .toBeGreaterThan(1);
    await expect(legend).toBeVisible();
    await expect
      .poll(async () => legend.locator("li").count())
      .toBeGreaterThan(1);
    await saveSettled(page);
  });

  await test.step("continuous scale, custom palette, gradient legend", async () => {
    const legend = page.locator("[data-corner]", { hasText: tableName });
    // The two-mode Scale switch: continuous drops the class rows for a
    // gradient ramp, in the panel and the legend alike.
    await page.getByRole("button", { name: "Continuous", exact: true }).click();
    await expect(legend.locator("[data-ramp]")).toBeVisible();
    await expect.poll(async () => legend.locator("li").count()).toBe(0);

    // Build and save a custom palette in the picker's stop editor; saving
    // applies it, so the head shows the new name and the ramp recolors.
    await page
      .getByRole("button", { name: /Choose fill palette: Global Warming/ })
      .click();
    await page.getByRole("button", { name: /New palette/ }).click();
    await page.getByPlaceholder("Save as…").fill("Journey palette");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("button", {
        name: "Choose fill palette: Journey palette",
      }),
    ).toBeVisible();
    await expect(legend.locator("[data-ramp]")).toBeVisible();

    // Classified restores the discrete rows — with the custom palette
    // sampled into classes (custom works in both modes).
    await page.getByRole("button", { name: "Classified", exact: true }).click();
    await expect
      .poll(async () => legend.locator("li").count())
      .toBeGreaterThan(1);
    await saveSettled(page);
  });

  await test.step("appearance and classification sliders preview locally and save once", async () => {
    let patches = 0;
    let refetches = 0;
    const counter = (req: { method(): string; url(): string }) => {
      if (req.method() === "PATCH" && /\/api\/layers\/[^/]+$/.test(req.url()))
        patches += 1;
      if (req.method() === "GET" && /\/api\/layers\/[^/]+\/render/.test(req.url()))
        refetches += 1;
    };
    page.on("request", counter);
    // The canvas renders full-viewport behind a clipped card window — the
    // card frame, not the canvas, is the visible map area a
    // pixel poll must compare (the raw canvas would drag the inspector,
    // header, and toasts into the shot).
    const canvasBox = await page
      .locator('[class*="canvasCol"]')
      .boundingBox();
    const mapShot = () =>
      maskedMapShot(page, {
        x: canvasBox!.x + MAP_SHOT_INSET,
        y: canvasBox!.y + MAP_SHOT_INSET,
        width: canvasBox!.width - MAP_SHOT_INSET * 2,
        height: canvasBox!.height - MAP_SHOT_INSET * 2,
      });
    const opacity = page.getByRole("slider", { name: "Layer opacity" });
    await expect(opacity).toHaveValue("1");

    // A real transport rejection must unwind the appearance draft, reconcile
    // to durable state, and leave the very next gesture usable.
    const settled = await mapShot();
    let abortNextPatch = true;
    const abort = async (route: import("@playwright/test").Route) => {
      if (abortNextPatch && route.request().method() === "PATCH") {
        abortNextPatch = false;
        await route.abort("connectionfailed");
      } else {
        await route.continue();
      }
    };
    await page.route(/\/api\/layers\/[^/]+$/, abort);
    await beginSliderDrag(page, opacity, 0.45);
    expect(patches).toBe(0);
    await expect
      .poll(async () => !(await mapShot()).equals(settled))
      .toBe(true);
    await page.mouse.up();
    await expect.poll(() => patches).toBe(1);
    await expect(
      page.getByText(/layer save could not be confirmed/i),
    ).toBeVisible();
    await expect(opacity).toHaveValue("1");
    // Pixel-settle polls get a patient window: under machine load the
    // restyle + repaint can take well past the default 15s (observed flake).
    await expect
      .poll(async () => (await mapShot()).equals(settled), { timeout: 30_000 })
      .toBe(true);
    await consumeTransportAbort(consoleErrors);
    await page.unroute(/\/api\/layers\/[^/]+$/, abort);

    // Immediate successful movement (without reload) is an exact canvas
    // restyle: one release PATCH. Undo crosses only that accepted gesture,
    // proving the aborted preview never entered history.
    patches = 0;
    refetches = 0;
    await beginSliderDrag(page, opacity, 0.6);
    expect(patches).toBe(0);
    await expect(opacity).not.toHaveValue("1");
    const appearancePreview = await page.screenshot({
      clip: canvasBox!,
      path: `${verificationScreens}/appearance-preview.png`,
    });
    await test.info().attach("appearance-preview", {
      body: appearancePreview,
      contentType: "image/png",
    });
    await page.mouse.up();
    await expect.poll(() => patches).toBe(1);
    await saveSettled(page);
    expect(refetches).toBe(0);
    const releasedOpacity = await opacity.inputValue();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(opacity).toHaveValue("1");
    await redoReady(page);
    await page.keyboard.press("ControlOrMeta+Shift+Z");
    await expect(opacity).toHaveValue(releasedOpacity);

    // The inverse uncertain outcome matters too: let the server commit, then
    // lose only its response. Recovery must keep that durable value, issue no
    // mutation retry, and expose exactly one undoable history step.
    let loseNextResponse = true;
    const loseResponse = async (route: import("@playwright/test").Route) => {
      if (loseNextResponse && route.request().method() === "PATCH") {
        loseNextResponse = false;
        await route.fetch();
        await route.abort("connectionfailed");
      } else {
        await route.continue();
      }
    };
    await page.route(/\/api\/layers\/[^/]+$/, loseResponse);
    patches = 0;
    // The redo above restyles the canvas asynchronously — the slider value
    // settles before the repaint does. An eager capture here can freeze a
    // stale or mid-repaint frame the post-undo canvas never re-matches
    // (observed in CI). Accept the reference only once it has left the
    // unwound render and held steady across two consecutive shots.
    let beforeResponseLoss = await mapShot();
    await expect
      .poll(
        async () => {
          const next = await mapShot();
          const ready =
            next.equals(beforeResponseLoss) && !next.equals(settled);
          beforeResponseLoss = next;
          return ready;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    await beginSliderDrag(page, opacity, 0.72);
    const responseLostOpacity = await opacity.inputValue();
    expect(responseLostOpacity).not.toBe(releasedOpacity);
    await page.mouse.up();
    await expect.poll(() => patches).toBe(1);
    await expect(opacity).toHaveValue(responseLostOpacity);
    await expect
      .poll(async () => (await readBuilderLayer(page, tableName)).style.opacity)
      .toBe(Number(responseLostOpacity));
    const afterResponseLoss = await mapShot();
    expect(afterResponseLoss.equals(beforeResponseLoss)).toBe(false);
    await consumeTransportAbort(consoleErrors);
    await page.unroute(/\/api\/layers\/[^/]+$/, loseResponse);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(opacity).toHaveValue(releasedOpacity);
    await expect
      .poll(async () => (await mapShot()).equals(beforeResponseLoss), {
        timeout: 30_000,
      })
      .toBe(true);
    await redoReady(page);
    await page.keyboard.press("ControlOrMeta+Shift+Z");
    await expect(opacity).toHaveValue(responseLostOpacity);
    await expect
      .poll(async () => (await mapShot()).equals(afterResponseLoss), {
        timeout: 30_000,
      })
      .toBe(true);

    // Moving away and returning to the exact start is a no-op release.
    patches = 0;
    const box = await opacity.boundingBox();
    const min = Number(await opacity.getAttribute("min"));
    const max = Number(await opacity.getAttribute("max"));
    const start = Number(await opacity.inputValue());
    const startFraction = (start - min) / (max - min);
    const x = (fraction: number) =>
      box!.x + 4 + (box!.width - 8) * fraction;
    const y = box!.y + box!.height / 2;
    await page.mouse.move(x(startFraction), y);
    await page.mouse.down();
    await page.mouse.move(x(0.3), y, { steps: 4 });
    await page.mouse.move(x(startFraction), y, { steps: 4 });
    await expect(opacity).toHaveValue(String(start));
    await page.mouse.up();
    await page.evaluate(
      () => new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
    );
    expect(patches).toBe(0);

    // Boundary movement is also an exact appearance preview, but it keeps
    // its release-time nice-number snapping behavior.
    const boundary = page
      .getByRole("slider", { name: /Class boundary/ })
      .first();
    await expect(boundary).toBeVisible();
    patches = 0;
    refetches = 0;
    const beforeBoundary = await boundary.inputValue();
    await beginSliderDrag(page, boundary, 0.7);
    expect(patches).toBe(0);
    await expect(boundary).not.toHaveValue(beforeBoundary);
    await page.mouse.up();
    await expect.poll(() => patches).toBe(1);
    await saveSettled(page);
    expect(refetches).toBe(0);
    page.off("request", counter);
  });

  await test.step("heatmap styling previews locally and settles once", async () => {
    // No write is in flight before this fire-and-forget edit starts.
    // Observe the full transition so the later radius commit is guaranteed
    // to be the newest history entry. The arrival signal is the write's
    // own response, armed before the click — asserting the transient
    // "Saving…" whisper here raced a fast save: a write that settles
    // before the assertion's first poll fails the step with no regression
    // behind it (reproduced with an instant stubbed write).
    const heatmapSaved = layerSaveArrived(page);
    await page.getByRole("button", { name: "Heatmap", exact: true }).click();
    await heatmapSaved;
    await saveSettled(page);
    await expect(page.getByRole("slider", { name: "Radius" })).toBeVisible();
    await saveSettled(page);

    let patches = 0;
    let refetches = 0;
    const counter = (req: { method(): string; url(): string }) => {
      if (req.method() === "PATCH" && /\/api\/layers\/[^/]+$/.test(req.url()))
        patches += 1;
      if (req.method() === "GET" && /\/api\/layers\/[^/]+\/render/.test(req.url()))
        refetches += 1;
    };
    page.on("request", counter);

    // The canvas renders full-viewport behind a clipped card window — the
    // card frame, not the canvas, is the visible map area a
    // pixel poll must compare (the raw canvas would drag the inspector,
    // header, and toasts into the shot).
    const canvasBox = await page
      .locator('[class*="canvasCol"]')
      .boundingBox();
    const mapShot = () =>
      maskedMapShot(page, {
        x: canvasBox!.x + MAP_SHOT_INSET,
        y: canvasBox!.y + MAP_SHOT_INSET,
        width: canvasBox!.width - MAP_SHOT_INSET * 2,
        height: canvasBox!.height - MAP_SHOT_INSET * 2,
      });
    // A rejected release restores both the control and the authoritative
    // full-quality surface; the transient drag still never writes.
    const settled = await mapShot();
    let rejectNextPatch = true;
    const reject = async (route: import("@playwright/test").Route) => {
      if (rejectNextPatch && route.request().method() === "PATCH") {
        rejectNextPatch = false;
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "invalid_request", message: "forced failure" },
          }),
        });
      } else {
        await route.continue();
      }
    };
    await page.route(/\/api\/layers\/[^/]+$/, reject);
    const intensity = page.getByRole("slider", { name: "Intensity" });
    await beginSliderDrag(page, intensity, 0.7);
    expect(patches).toBe(0);
    await expect
      .poll(async () => !(await mapShot()).equals(settled))
      .toBe(true);
    await page.mouse.up();
    await expect(page.getByText("forced failure")).toBeVisible();
    await expect(intensity).toHaveValue("1");
    await expect
      .poll(async () => (await mapShot()).equals(settled), { timeout: 30_000 })
      .toBe(true);
    const expectedConsoleFailure = consoleErrors.findIndex(
      (entry) =>
        entry.text.includes("status of 400") &&
        /\/api\/layers\//.test(entry.url ?? ""),
    );
    expect(expectedConsoleFailure).toBeGreaterThanOrEqual(0);
    consoleErrors.splice(expectedConsoleFailure, 1);
    await page.unroute(/\/api\/layers\/[^/]+$/, reject);

    // A successful drag stays local under the pointer, then emits one PATCH
    // and no render-data refetch. One undo must jump to the pre-drag value,
    // proving the gesture is one history step rather than many ticks.
    patches = 0;
    refetches = 0;
    const radius = page.getByRole("slider", { name: "Radius" });
    const beforeRadius = await mapShot();
    await beginSliderDrag(page, radius, 0.72);
    expect(patches).toBe(0);
    await expect(radius).not.toHaveValue("30");
    await expect
      .poll(async () => !(await mapShot()).equals(beforeRadius))
      .toBe(true);
    await page.mouse.up();
    // The release's PATCH counter is the arrival signal; the transient
    // whisper is not asserted visible (a fast save can clear it
    // before the first poll).
    await expect.poll(() => patches).toBe(1);
    await saveSettled(page);
    expect(refetches).toBe(0);
    const releasedRadius = await radius.inputValue();

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(radius).toHaveValue("30");
    await redoReady(page);
    await page.keyboard.press("ControlOrMeta+Shift+Z");
    await expect(radius).toHaveValue(releasedRadius);

    // Reload reads only the durable released value; no intermediate draft
    // exists outside this builder session.
    await page.reload();
    await saveSettled(page);
    await page
      .getByRole("button", { name: new RegExp(`^${tableName}`) })
      .click();
    await expect(page.getByRole("button", { name: "Heatmap" })).toHaveAttribute(
      "data-active",
      "true",
    );
    await expect(page.getByRole("slider", { name: "Radius" })).toHaveValue(
      releasedRadius,
    );

    // The same interaction quality applies to delegated heatmap filters.
    // Their release refetches once to re-evaluate the over-cap fallback,
    // but the drag itself remains local and latest-value live.
    await page.getByRole("button", { name: "+ Add filter" }).click();
    await page.getByRole("button", { name: /riders/ }).click();
    const heatMax = page.getByRole("slider", { name: "Maximum" });
    await expect(heatMax).toBeVisible();
    const heatAllVisible = await mapShot();
    patches = 0;
    refetches = 0;
    await beginSliderDrag(page, heatMax, 0.55);
    expect(patches).toBe(0);
    await expect
      .poll(async () => !(await mapShot()).equals(heatAllVisible))
      .toBe(true);
    await page.mouse.up();
    await expect.poll(() => patches).toBe(1);
    await expect.poll(() => refetches).toBe(1);
    await saveSettled(page);

    // Restore the full filter range but keep the filter card: the next beat
    // reuses it to retain point-layer live-filter regression check.
    await page.getByPlaceholder("22310").fill("");
    await page.getByPlaceholder("22310").blur();
    await expect.poll(() => patches).toBe(2);
    await expect.poll(() => refetches).toBe(2);
    await saveSettled(page);
    await expect(heatMax).toHaveValue("22310");
    page.off("request", counter);

  });

  await test.step("grid cell size and aggregated filters re-aggregate under the pointer", async () => {
    const gridButton = page.getByRole("button", { name: "Grid", exact: true });
    const gridSaved = layerSaveArrived(page);
    await gridButton.click();
    await gridSaved;
    await saveSettled(page);
    await expect(gridButton).toHaveAttribute("data-active", "true");

    // Use a varied numeric distribution: fine cells make membership changes
    // visible during preview, while summing riders guarantees that filtering
    // materially changes the durable classification boundaries.
    const showSelect = page
      .getByText("Show", { exact: true })
      .locator("..")
      .locator("select");
    await showSelect.selectOption("sum");
    const attributeSelect = page
      .getByText("of", { exact: true })
      .locator("..")
      .locator("select");
    await attributeSelect.selectOption("riders");
    await expect
      .poll(async () => (await readBuilderLayer(page, tableName)).viz.aggregate)
      .toMatchObject({ fn: "sum", attribute: "riders" });

    let patches = 0;
    let refetches = 0;
    const counter = (req: { method(): string; url(): string }) => {
      if (req.method() === "PATCH" && /\/api\/layers\/[^/]+$/.test(req.url()))
        patches += 1;
      if (req.method() === "GET" && /\/api\/layers\/[^/]+\/render/.test(req.url()))
        refetches += 1;
    };
    page.on("request", counter);
    // The canvas renders full-viewport behind a clipped card window — the
    // card frame, not the canvas, is the visible map area a
    // pixel poll must compare (the raw canvas would drag the inspector,
    // header, and toasts into the shot).
    const canvasBox = await page
      .locator('[class*="canvasCol"]')
      .boundingBox();
    const mapShot = () =>
      maskedMapShot(page, {
        x: canvasBox!.x + MAP_SHOT_INSET,
        y: canvasBox!.y + MAP_SHOT_INSET,
        width: canvasBox!.width - MAP_SHOT_INSET * 2,
        height: canvasBox!.height - MAP_SHOT_INSET * 2,
      });
    const cellSize = page.getByRole("slider", { name: "Cell size" });
    // The continuous log track: 5 km sits at position 306 of 600; the
    // typable readout is the human-facing value.
    const defaultCellPosition = "306";
    await expect(cellSize).toHaveValue(defaultCellPosition);
    await expect(
      page.getByRole("textbox", { name: "Cell size value" }),
    ).toHaveValue("5 km");
    const settledCells = await mapShot();

    await beginSliderDrag(page, cellSize, 0.25);
    expect(patches).toBe(0);
    await expect(cellSize).not.toHaveValue(defaultCellPosition);
    await expect
      .poll(async () => !(await mapShot()).equals(settledCells))
      .toBe(true);
    const exactGridPreview = await page.screenshot({
      clip: canvasBox!,
      path: `${verificationScreens}/exact-grid-preview.png`,
    });
    await test.info().attach("exact-grid-preview", {
      body: exactGridPreview,
      contentType: "image/png",
    });
    await expect(page.getByText("Approximate preview")).toHaveCount(0);
    await page.mouse.up();
    await expect.poll(() => patches).toBe(1);
    await expect.poll(() => refetches).toBe(1);
    await saveSettled(page);
    const releasedCellSize = await cellSize.inputValue();

    // One undo/redo traverses the entire cell-size gesture.
    page.off("request", counter);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(cellSize).toHaveValue(defaultCellPosition);
    await redoReady(page);
    await page.keyboard.press("ControlOrMeta+Shift+Z");
    await expect(cellSize).toHaveValue(releasedCellSize);
    await saveSettled(page);

    // The existing riders filter is no longer GPU-delegated in Grid mode;
    // its worker preview must still update cells continuously and settle once.
    const cellLabels = page.getByLabel("Cell values as labels");
    await cellLabels.click();
    await expect(cellLabels).toBeChecked();
    await saveSettled(page);
    patches = 0;
    refetches = 0;
    page.on("request", counter);
    const maxThumb = page.getByRole("slider", { name: "Maximum" });
    const authoritativeMax = await maxThumb.inputValue();
    const beforeFilter = await readBuilderLayer(page, tableName);
    expect(beforeFilter.viz.type).toBe("grid");
    const beforeBreaks = beforeFilter.viz.fill?.breaks;
    expect(beforeBreaks).toBeDefined();
    const allCells = await mapShot();

    // Query-shaping recovery uses a genuine transport abort too. The failed
    // gesture must clear its worker preview, restore exact cells and breaks,
    // and permit the same control to succeed immediately without a reload.
    let abortNextPatch = true;
    const abort = async (route: import("@playwright/test").Route) => {
      if (abortNextPatch && route.request().method() === "PATCH") {
        abortNextPatch = false;
        await route.abort("connectionfailed");
      } else {
        await route.continue();
      }
    };
    await page.route(/\/api\/layers\/[^/]+$/, abort);
    await beginSliderDrag(page, maxThumb, 0.55);
    expect(patches).toBe(0);
    await expect
      .poll(async () => !(await mapShot()).equals(allCells))
      .toBe(true);
    await page.mouse.up();
    await expect.poll(() => patches).toBe(1);
    await expect(
      page.getByText(/layer save could not be confirmed/i),
    ).toBeVisible();
    await expect(maxThumb).toHaveValue(authoritativeMax);
    await expect
      .poll(async () => (await mapShot()).equals(allCells), { timeout: 30_000 })
      .toBe(true);
    await expect(page.getByText("Approximate preview")).toHaveCount(0);
    // A save that never reached the server is retired against the map's
    // own read: the exact cells come back from the render already held,
    // with no render request.
    expect(refetches).toBe(0);
    const afterFailure = await readBuilderLayer(page, tableName);
    expect(afterFailure.viz.fill?.breaks).toEqual(beforeBreaks);
    await consumeTransportAbort(consoleErrors);
    await page.unroute(/\/api\/layers\/[^/]+$/, abort);

    patches = 0;
    refetches = 0;
    await beginSliderDrag(page, maxThumb, 0.55);
    expect(patches).toBe(0);
    await expect(maxThumb).not.toHaveValue(authoritativeMax);
    await expect
      .poll(async () => !(await mapShot()).equals(allCells))
      .toBe(true);
    await page.mouse.up();
    await expect.poll(() => patches).toBe(1);
    await expect.poll(() => refetches).toBe(1);
    await saveSettled(page);
    const settledFilter = await readBuilderLayer(page, tableName);
    expect(settledFilter.viz.fill?.breaks).not.toEqual(beforeBreaks);

    // Restore the open bound through the precise input, then return to the
    // point fast path for its dedicated regression beat below.
    await page.getByPlaceholder("22310").fill("");
    await page.getByPlaceholder("22310").blur();
    await saveSettled(page);
    page.off("request", counter);
    const pointsButton = page.getByRole("button", { name: "Points", exact: true });
    await pointsButton.click();
    await expect(pointsButton).toHaveAttribute("data-active", "true");
    await saveSettled(page);
  });

  await test.step("a numeric slider filters the map live, mid-drag", async () => {
    // Live filters: dragging a range slider moves points in and out of the
    // map with ZERO writes; the release settles exactly one PATCH. The
    // filter created in the preceding heatmap beat is reused here.
    let patches = 0;
    let refetches = 0;
    const counter = (req: { method(): string; url(): string }) => {
      if (req.method() === "PATCH" && /\/api\/layers\//.test(req.url()))
        patches += 1;
      if (req.method() === "GET" && /\/api\/layers\/[^/]+\/render/.test(req.url()))
        refetches += 1;
    };
    // The canvas renders full-viewport behind a clipped card window — the
    // card frame, not the canvas, is the visible map area a
    // pixel poll must compare (the raw canvas would drag the inspector,
    // header, and toasts into the shot).
    const canvasBox = await page
      .locator('[class*="canvasCol"]')
      .boundingBox();
    const mapShot = () =>
      maskedMapShot(page, {
        x: canvasBox!.x + MAP_SHOT_INSET,
        y: canvasBox!.y + MAP_SHOT_INSET,
        width: canvasBox!.width - MAP_SHOT_INSET * 2,
        height: canvasBox!.height - MAP_SHOT_INSET * 2,
      });
    // The whole beat — adding the filter, dragging, committing, clearing —
    // must never refetch render data: the canvas is filtering client-side.
    page.on("request", counter);
    const maxThumb = page.getByRole("slider", { name: "Maximum" });
    await expect(maxThumb).toBeVisible();
    await maxThumb.scrollIntoViewIfNeeded();
    await saveSettled(page);
    const allVisible = await mapShot();
    patches = 0; // the add itself wrote once, by design
    // Grab the max thumb (it starts at the extent's right edge) and drag
    // it to ~55% — Hauptbahnhof (22,310) and Zoo (15,600) must vanish
    // while the pointer is still down.
    const track = await maxThumb.boundingBox();
    const y = track!.y + track!.height / 2 + 1;
    await page.mouse.move(track!.x + track!.width - 6, y);
    await page.mouse.down();
    await page.mouse.move(track!.x + track!.width * 0.55, y, { steps: 8 });
    await expect(maxThumb).not.toHaveValue("22310");
    await expect
      .poll(async () => !(await mapShot()).equals(allVisible))
      .toBe(true);
    expect(patches).toBe(0); // dragging never writes…
    await page.mouse.up();
    await expect.poll(async () => patches).toBe(1); // …the release does, once
    await saveSettled(page);

    // The precise bound input commits instantly too — clearing the max
    // brings every point back without any data refetch.
    const maxBound = page.getByPlaceholder("22310");
    await maxBound.fill("");
    await maxBound.blur();
    await saveSettled(page);
    expect(refetches).toBe(0);
    page.off("request", counter);
  });

  await test.step("an over-budget aggregation stays bounded and visibly approximate", async () => {
    const mapId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1)!;
    const largeName = `bounded_${runId}`;
    const largeLayer = await page.evaluate(
      async ({ mapId, largeName, tableName }) => {
        const response = await (async function readThenWriteSetup() {
const read = await fetch(`/api/maps/${mapId}`, { cache: "no-store" });
if (!read.ok) throw new Error(await read.text());
const shown = await read.json();
return fetch(`/api/maps/${mapId}/layers`, {
          method: "POST",
          headers: { "X-Edit-Revision": shown.editRevision, "content-type": "application/json" },
          body: JSON.stringify({
            name: largeName,
            sql: `SELECT
                    ST_Point(
                      ST_X(p.geometry) + (r.i % 250) * 0.00002,
                      ST_Y(p.geometry) + floor(r.i / 250) * 0.00002
                    ) AS geometry
                  FROM (SELECT geometry FROM ${tableName} LIMIT 1) AS p
                  CROSS JOIN range(0, 52001) AS r(i)`,
          }),
        });
})();
        if (!response.ok) throw new Error(await response.text());
        return (await response.json()) as { id: string; sql: string };
      },
      { mapId, largeName, tableName },
    );

    await page.reload();
    await saveSettled(page);
    const largeRow = page.getByRole("button", { name: new RegExp(`^${largeName}`) });
    await expect(largeRow).toContainText(/preparing tiles|tiled/, {
      timeout: 30_000,
    });
    await largeRow.click();

    // Tiled point metadata must keep the complete visualization selector
    // available before the layer is switched away from Points.
    for (const choice of ["Points", "Hex bins", "Grid", "Heatmap"]) {
      await expect(
        page.getByRole("button", { name: choice, exact: true }),
      ).toBeVisible();
    }
    const pointsButton = page.getByRole("button", {
      name: "Points",
      exact: true,
    });
    await expect(pointsButton).toHaveAttribute("data-active", "true");
    await expect(largeRow).toContainText("tiled", { timeout: 30_000 });

    const beforeSwitch = await readBuilderLayer(page, largeName);
    expect(beforeSwitch.viz.type).toBe("points");
    expect(beforeSwitch.sql).toBe(largeLayer.sql);

    const gridButton = page.getByRole("button", { name: "Grid", exact: true });
    const tiledGridSaved = layerSaveArrived(page);
    await gridButton.click();
    await tiledGridSaved;
    await saveSettled(page);
    await expect(gridButton).toHaveAttribute("data-active", "true");
    const afterSwitch = await readBuilderLayer(page, largeName);
    expect(afterSwitch.viz.type).toBe("grid");
    expect(afterSwitch.sql).toBe(largeLayer.sql);

    // The valid tiled-point switch is durable and never rewrites layer SQL.
    await page.reload();
    await saveSettled(page);
    await page
      .getByRole("button", { name: new RegExp(`^${largeName}`) })
      .click();
    await expect(
      page.getByRole("button", { name: "Grid", exact: true }),
    ).toHaveAttribute("data-active", "true");
    const afterReload = await readBuilderLayer(page, largeName);
    expect(afterReload.viz.type).toBe("grid");
    expect(afterReload.sql).toBe(largeLayer.sql);

    let patches = 0;
    let refetches = 0;
    const counter = (req: { method(): string; url(): string }) => {
      if (req.method() === "PATCH" && /\/api\/layers\/[^/]+$/.test(req.url()))
        patches += 1;
      if (req.method() === "GET" && /\/api\/layers\/[^/]+\/render/.test(req.url()))
        refetches += 1;
    };
    page.on("request", counter);
    // The canvas renders full-viewport behind a clipped card window — the
    // card frame, not the canvas, is the visible map area a
    // pixel poll must compare (the raw canvas would drag the inspector,
    // header, and toasts into the shot).
    const canvasBox = await page
      .locator('[class*="canvasCol"]')
      .boundingBox();
    const mapShot = () =>
      maskedMapShot(page, {
        x: canvasBox!.x + MAP_SHOT_INSET,
        y: canvasBox!.y + MAP_SHOT_INSET,
        width: canvasBox!.width - MAP_SHOT_INSET * 2,
        height: canvasBox!.height - MAP_SHOT_INSET * 2,
      });
    const before = await mapShot();
    const cellSize = page.getByRole("slider", { name: "Cell size" });
    await beginSliderDrag(page, cellSize, 0.65);
    expect(patches).toBe(0);
    await expect(page.getByText("Approximate preview")).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(async () => !(await mapShot()).equals(before), { timeout: 30_000 })
      .toBe(true);
    const boundedGridPreview = await page.screenshot({
      clip: canvasBox!,
      path: `${verificationScreens}/bounded-grid-preview.png`,
    });
    await test.info().attach("bounded-grid-preview", {
      body: boundedGridPreview,
      contentType: "image/png",
    });
    await page.mouse.up();
    await expect.poll(() => patches, { timeout: 30_000 }).toBe(1);
    await expect.poll(() => refetches, { timeout: 30_000 }).toBe(1);
    await expect(page.getByText("Approximate preview")).toBeHidden();
    await saveSettled(page);
    const boundedGridSettled = await page.screenshot({
      clip: canvasBox!,
      path: `${verificationScreens}/bounded-grid-settled.png`,
    });
    await test.info().attach("bounded-grid-settled", {
      body: boundedGridSettled,
      contentType: "image/png",
    });
    page.off("request", counter);

    // Preview data is builder-only and ephemeral; remove the stress layer so
    // the published-view beat below proves only the intended layer survives.
    await page.evaluate(async (layerId) => {
      const response = await (async function readThenWriteSetup() {
const read = await fetch(`/api/layers/${layerId}`, { cache: "no-store" });
if (!read.ok) throw new Error(await read.text());
const shown = await read.json();
return fetch(`/api/layers/${layerId}`, { headers: { "X-Edit-Revision": shown.editRevision },
        method: "DELETE",
      });
})();
      if (!response.ok) throw new Error(await response.text());
    }, largeLayer.id);
    await page.reload();
    await saveSettled(page);
    await page
      .getByRole("button", { name: new RegExp(`^${tableName}`) })
      .click();
  });

  await test.step("a time filter docks the map timeline and plays", async () => {
    // A time filter on the timestamp field, seeded from its real extent —
    // adding it docks the map-bottom timeline by itself.
    await page.getByRole("button", { name: "+ Add filter" }).click();
    await page.getByRole("button", { name: /seen/ }).click();
    const timeline = page.getByTestId("timeline");
    await expect(timeline).toBeVisible();
    // The widget's own close collapses; the row's labeled toggle re-docks.
    await timeline.getByRole("button", { name: "Collapse timeline" }).click();
    await expect(timeline).toBeHidden();
    await page
      .getByRole("button", { name: "Show on map timeline" })
      .click();
    await expect(timeline).toBeVisible();
    const readout = page.getByTestId("timeline-window");
    await expect(readout).toContainText("Mar 1, 2021");
    // The window must move PIXELS, not just the readout — a docked-late
    // filter extension once sat inert while the widget played happily.
    // Deterministic check: all points under the full window, then a
    // narrowed bound (only the Mar 3 point qualifies) must repaint.
    // The canvas renders full-viewport behind a clipped card window — the
    // card frame, not the canvas, is the visible map area a
    // pixel poll must compare (the raw canvas would drag the inspector,
    // header, and toasts into the shot).
    const canvasBox = await page
      .locator('[class*="canvasCol"]')
      .boundingBox();
    const mapShot = () =>
      // The canvas minus the widget strip; the legend is static across
      // both states, so it cannot fake a difference. The 182px margin
      // keeps the timeline dock's rounded corner fully out of the shot,
      // and the inset plus chrome masks keep every other card edge and
      // floating overlay out too — edge antialiasing wobbles across
      // repaints, which is not a map pixel (finding, generalized by:
      // exact-equality polls must not straddle a card edge).
      maskedMapShot(page, {
        x: canvasBox!.x + MAP_SHOT_INSET,
        y: canvasBox!.y + MAP_SHOT_INSET,
        width: canvasBox!.width - MAP_SHOT_INSET * 2,
        height: canvasBox!.height - 182 - MAP_SHOT_INSET,
      });
    const allVisible = await mapShot();
    const minBound = page.getByPlaceholder("2021-03-01T08:30:00");
    await minBound.fill("2021-03-03T00:00:00");
    await minBound.blur();
    await saveSettled(page);
    await expect
      .poll(async () => !(await mapShot()).equals(allVisible))
      .toBe(true);
    await minBound.fill("");
    await minBound.blur();
    await expect
      .poll(async () =>
        (await readBuilderLayer(page, tableName)).filters?.find(
          (filter) => filter.kind === "timerange" && filter.field === "seen",
        )?.min ?? null,
      )
      .toBeNull();
    await saveSettled(page);

    // A timeline release follows the same rollback contract as the filter
    // row. Abort the real PATCH, then prove the live window and GPU filter
    // return to authoritative state before the same handle succeeds without
    // a reload.
    const startThumb = timeline.getByRole("slider", { name: "Window start" });
    const authoritativeStart = await startThumb.getAttribute("aria-valuenow");
    expect(authoritativeStart).not.toBeNull();
    const authoritativeTimeMap = await mapShot();
    let abortNextPatch = true;
    const abort = async (route: import("@playwright/test").Route) => {
      if (abortNextPatch && route.request().method() === "PATCH") {
        abortNextPatch = false;
        await route.abort("connectionfailed");
      } else {
        await route.continue();
      }
    };
    await page.route(/\/api\/layers\/[^/]+$/, abort);
    await beginSliderDrag(page, startThumb, 0.45);
    await expect(startThumb).not.toHaveAttribute(
      "aria-valuenow",
      authoritativeStart!,
    );
    await expect
      .poll(async () => !(await mapShot()).equals(authoritativeTimeMap))
      .toBe(true);
    await page.mouse.up();
    await expect(
      page.getByText(/layer save could not be confirmed/i),
    ).toBeVisible();
    await expect(startThumb).toHaveAttribute(
      "aria-valuenow",
      authoritativeStart!,
    );
    await expect
      .poll(async () => (await mapShot()).equals(authoritativeTimeMap), {
        timeout: 30_000,
      })
      .toBe(true);
    await expect(page.getByText("Approximate preview")).toHaveCount(0);
    await consumeTransportAbort(consoleErrors);
    await page.unroute(/\/api\/layers\/[^/]+$/, abort);

    let recoveryPatches = 0;
    const recoveryCounter = (req: { method(): string; url(): string }) => {
      if (req.method() === "PATCH" && /\/api\/layers\/[^/]+$/.test(req.url()))
        recoveryPatches += 1;
    };
    page.on("request", recoveryCounter);
    await beginSliderDrag(page, startThumb, 0.45);
    await expect(startThumb).not.toHaveAttribute(
      "aria-valuenow",
      authoritativeStart!,
    );
    await page.mouse.up();
    await expect.poll(() => recoveryPatches).toBe(1);
    // A time bound is stored to the second, and once the save lands the
    // handle shows the stored bound; until then it holds the released
    // position, fractional milliseconds and all.
    const released = Number(await startThumb.getAttribute("aria-valuenow"));
    const recoveredStart = String(Math.floor(released / 1000) * 1000);
    await expect
      .poll(async () => {
        const min = (await readBuilderLayer(page, tableName)).filters?.find(
          (filter) => filter.kind === "timerange" && filter.field === "seen",
        )?.min;
        return typeof min === "string"
          ? Date.parse(`${min.replace(" ", "T")}Z`)
          : min;
      })
      .toBe(Number(recoveredStart));
    await saveSettled(page);
    await expect(startThumb).toHaveAttribute("aria-valuenow", recoveredStart);
    page.off("request", recoveryCounter);

    // One undo crosses the accepted recovery gesture, not the aborted one.
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(startThumb).toHaveAttribute(
      "aria-valuenow",
      authoritativeStart!,
    );
    await expect
      .poll(async () => (await mapShot()).equals(authoritativeTimeMap), {
        timeout: 30_000,
      })
      .toBe(true);
    await redoReady(page);
    await page.keyboard.press("ControlOrMeta+Shift+Z");
    await expect(startThumb).toHaveAttribute("aria-valuenow", recoveredStart);
    await saveSettled(page);

    // Play: the window sweeps — the readout visibly moves — and pausing
    // settles it as the filter (one write; the cleared Saving… whisper is the signal).
    const before = await readout.textContent();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect
      .poll(async () => readout.textContent())
      .not.toBe(before);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await saveSettled(page);
    // Keyboard nudges settle once, after the taps stop — one write per
    // keystroke is exactly the chatter the spec forbids.
    let patches = 0;
    const counter = (req: { method(): string; url(): string }) => {
      if (req.method() === "PATCH" && /\/api\/layers\//.test(req.url()))
        patches += 1;
    };
    page.on("request", counter);
    await page.getByRole("slider", { name: "Window start" }).focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
    expect(patches).toBe(0); // taps never write…
    await expect.poll(async () => patches).toBe(1); // …the pause after does, once
    page.off("request", counter);
    await saveSettled(page);
  });

  await test.step("dashboard cards cross-filter by exclusion", async () => {
    // A fresh layer carries the dashboard: it has no stored filters, so
    // the widget numbers are the fixture's plain truth — the first layer's
    // settled time window stays out of these assertions.
    await page.getByRole("tab", { name: "Layers", exact: true }).click();
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
    await saveSettled(page);

    await page.getByRole("tab", { name: "Widgets", exact: true }).click();

    // A count formula: the add button unfolds the four type tiles — its
    // headline must equal the fixture's row count, i.e. The same
    // aggregate computed in SQL.
    await page.locator("[data-add-widget-row]").click();
    await page.locator('[data-add-type="formula"]').click();
    await page
      .getByRole("combobox", { name: "Layer", exact: true })
      .selectOption({ index: 1 });
    // The rail previews the unsaved editor live: the card materializes
    // with the suggested title and a real computed number BEFORE Add is
    // pressed — and typing retitles it — all with zero writes.
    let previewWrites = 0;
    const previewCounter = (req: {
      method(): string;
      url(): string;
      postData(): string | null;
    }) => {
      if (
        req.method() === "PATCH" &&
        /\/api\/maps\//.test(req.url()) &&
        !isCameraOnlyWrite(req)
      )
        previewWrites += 1;
    };
    page.on("request", previewCounter);
    const formulaCard = page.locator('[data-widget-card="formula"]');
    await expect(formulaCard).toBeVisible();
    await expect(formulaCard).toContainText("Row count");
    await expect(formulaCard).toContainText("4");
    await page
      .getByRole("textbox", { name: "Title", exact: true })
      .fill("Stations");
    await expect(formulaCard).toContainText("Stations");
    expect(previewWrites).toBe(0);
    page.off("request", previewCounter);
    await page.getByRole("button", { name: "Add widget", exact: true }).click();
    await saveSettled(page);
    await expect(formulaCard).toBeVisible();
    await expect(formulaCard).toContainText("4");

    // A category widget over the station names.
    await page.locator("[data-add-widget-row]").click();
    await page.locator('[data-add-type="category"]').click();
    await page
      .getByRole("combobox", { name: "Layer", exact: true })
      .selectOption({ index: 1 });
    await page
      .getByRole("combobox", { name: "Group by" })
      .selectOption("name");
    await page.getByRole("button", { name: "Add widget", exact: true }).click();
    await saveSettled(page);
    const categoryCard = page.locator('[data-widget-card="category"]');
    await expect(categoryCard).toBeVisible();
    await expect(categoryCard).toContainText("Hauptbahnhof");

    // A note card: authored text on the rail, no data — the body
    // renders the markdown subset (field fix: bold survives).
    await page.locator("[data-add-widget-row]").click();
    await page.locator('[data-add-type="note"]').click();
    await page
      .getByRole("textbox", { name: "Text" })
      .fill("Fixture stations, **counted** live.");
    await page.getByRole("button", { name: "Add note", exact: true }).click();
    await saveSettled(page);
    const noteCard = page.locator('[data-widget-card="note"]');
    await expect(noteCard).toContainText("Fixture stations, counted live.");
    await expect(noteCard.locator("strong")).toHaveText("counted");

    // Clicking a category DEACTIVATES it: its rows leave the map, the
    // formula narrows and keeps its unfiltered value beside it, and the
    // record readout reflects every active constraint — all with zero
    // writes (selections are session state, never persisted). No chips
    // anywhere; the faint row is the state.
    let widgetWrites = 0;
    const writeCounter = (req: {
      method(): string;
      url(): string;
      postData(): string | null;
    }) => {
      if (
        req.method() === "PATCH" &&
        /\/api\/maps\//.test(req.url()) &&
        !isCameraOnlyWrite(req)
      )
        widgetWrites += 1;
    };
    page.on("request", writeCounter);
    const hbf = categoryCard.getByRole("button", { name: /Hauptbahnhof/ });
    await expect(hbf).toHaveAttribute("data-active", "");
    await hbf.click();
    await expect(hbf).not.toHaveAttribute("data-active", "");
    await expect(formulaCard).toContainText("filtered from 4");
    await expect(formulaCard).toContainText("3");
    await expect(page.locator("[data-records]")).toContainText("3 of 4");
    // The widget itself never filters itself — all four rows stay listed,
    // the others still active.
    await expect(
      categoryCard.getByRole("button", { name: /Alexanderplatz/ }),
    ).toHaveAttribute("data-active", "");
    // Reactivating restores the unconstrained dashboard. No chip surface.
    await hbf.click();
    await expect(hbf).toHaveAttribute("data-active", "");
    await expect(formulaCard).not.toContainText("filtered from");
    expect(await page.locator("[data-widget-chip]").count()).toBe(0);
    expect(widgetWrites).toBe(0);
    page.off("request", writeCounter);

    // The card's ⋮ menu clears a selection and jumps to its editor.
    await hbf.click();
    await categoryCard.getByTitle("Widget menu").click();
    await page.getByRole("menuitem", { name: "Clear selection" }).click();
    await expect(formulaCard).not.toContainText("filtered from");
    await categoryCard.getByTitle("Widget menu").click();
    await page.getByRole("menuitem", { name: "Widget options" }).click();
    await expect(page.locator("[data-widget-form]")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
  });

  await test.step("rail cards drag to reorder", async () => {
    // Grab the note card by its title and carry it to the top slot. The
    // field-fix regression built a corrupted list on release — the server
    // bounced it with a 400 and the card snapped back — so this beat
    // asserts the write lands, no error banner shows, and the new order
    // survives a reload.
    const rail = page.locator("[data-widget-rail]");
    const cards = rail.locator("[data-widget-card]");
    await expect(cards.first()).toHaveAttribute("data-widget-card", "formula");
    const note = rail.locator('[data-widget-card="note"]');
    const noteBox = (await note.boundingBox())!;
    const targetBox = (await cards.first().boundingBox())!;
    const x = noteBox.x + noteBox.width / 2;
    await page.mouse.move(x, noteBox.y + 14);
    await page.mouse.down();
    // Clear the 5px activation gate, then glide up to the first slot.
    await page.mouse.move(x, noteBox.y + 44, { steps: 3 });
    await page.mouse.move(x, targetBox.y + 10, { steps: 12 });
    await page.mouse.up();
    await expect(cards.first()).toHaveAttribute("data-widget-card", "note");
    // The release dim is a one-shot reveal animation, not held state
    // (round-2 field fix): the dropped card settles at full opacity.
    await expect
      .poll(async () =>
        note.evaluate((el) => getComputedStyle(el.parentElement!).opacity),
      )
      .toBe("1");
    await saveSettled(page);
    await expect(page.locator("[data-map-error]")).toHaveCount(0);
    await page.reload();
    await expect(
      page.locator("[data-widget-rail] [data-widget-card]").first(),
    ).toHaveAttribute("data-widget-card", "note");
  });

  await test.step("3D: tilt persists with the camera and cells extrude", async () => {
    // Sequenced after the pixel-equality steps on purpose: a pitched
    // camera loads a burst of horizon basemap tiles, and a rate-limited
    // public CDN can latch the offline chip — harmless here, fatal to
    // pixel polls.
    const mapId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1)!;
    const pitchOf = () =>
      page.evaluate(async (id) => {
        const response = await fetch(`/api/maps/${id}`);
        const m = (await response.json()) as {
          viewport: { pitch?: number };
        };
        return m.viewport.pitch ?? 0;
      }, mapId);

    // The stage-stack tilt toggle eases the camera; gesture end persists
    // the full camera (pitch and bearing) with the viewport. A panel
    // padding ease still settling from the previous step can cancel the
    // tilt motion (last camera call wins), so the poll re-clicks while
    // the toggle still reads flat — convergent either way.
    const tiltBtn = page.getByRole("button", { name: /Tilt the map|Back to flat/ });
    await expect
      .poll(
        async () => {
          if ((await tiltBtn.getAttribute("aria-pressed")) !== "true") {
            await tiltBtn.click();
          }
          return pitchOf();
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(30);
    // The status pill sheds readouts whole when its band between the
    // legend card and the basemap credit runs short, pitch first. At this
    // window the band holds four; the readout is read with room for five.
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: 1600, height: viewport.height });
    await expect(
      page.locator("[data-status-bar]").getByText("Pitch", { exact: true }),
    ).toBeVisible();
    await page.setViewportSize(viewport);

    // Extrude hex bins on a fresh scratch layer (the stress layer is long
    // deleted, and the fixture layer carries the docked timeline): the
    // elevation config settles server-side with a resolved domain, so
    // heights mean the same across the layer.
    const threeDName = `threed_${runId}`;
    const threeDLayer = await page.evaluate(
      async ({ mapId, threeDName, tableName }) => {
        const response = await (async function readThenWriteSetup() {
const read = await fetch(`/api/maps/${mapId}`, { cache: "no-store" });
if (!read.ok) throw new Error(await read.text());
const shown = await read.json();
return fetch(`/api/maps/${mapId}/layers`, {
          method: "POST",
          headers: { "X-Edit-Revision": shown.editRevision, "content-type": "application/json" },
          body: JSON.stringify({
            name: threeDName,
            sql: `SELECT geometry FROM ${tableName}`,
          }),
        });
})();
        if (!response.ok) throw new Error(await response.text());
        return (await response.json()) as { id: string };
      },
      { mapId, threeDName, tableName },
    );
    await page.reload();
    await saveSettled(page);
    await page
      .getByRole("button", { name: new RegExp(`^${threeDName}`) })
      .first()
      .click();
    await page.getByRole("button", { name: "Hex bins", exact: true }).click();
    await page.getByText("Extrude cells (3D)").click();
    await expect
      .poll(
        async () =>
          page.evaluate(async (id) => {
            const response = await fetch(`/api/maps/${id}`);
            const m = (await response.json()) as {
              layers: {
                viz?: { type?: string; elevation?: { domain?: unknown } };
              }[];
            };
            const cells = m.layers.find((l) => l.viz?.type === "hexbin");
            return Array.isArray(cells?.viz?.elevation?.domain);
          }, mapId),
        { timeout: 15_000 },
      )
      .toBe(true);

    // Round-trip off, then drop the scratch layer — the publish beat
    // expects the map exactly as the earlier steps left it.
    await page.getByText("Extrude cells (3D)").click();
    await page.getByRole("button", { name: "Points", exact: true }).click();
    // Let the viz writes and their render fetches settle before the layer
    // disappears — a trailing fetch against a deleted id logs a 404.
    await saveSettled(page);
    await page.evaluate(async (layerId) => {
      const response = await (async function readThenWriteSetup() {
const read = await fetch(`/api/layers/${layerId}`, { cache: "no-store" });
if (!read.ok) throw new Error(await read.text());
const shown = await read.json();
return fetch(`/api/layers/${layerId}`, { headers: { "X-Edit-Revision": shown.editRevision },
        method: "DELETE",
      });
})();
      if (!response.ok) throw new Error(await response.text());
    }, threeDLayer.id);
    await page.reload();
    await saveSettled(page);
    // Two consecutive persisted-zero reads a quiet window apart: the
    // camera persists on gesture-end AFTER the ease, so a single 0 can
    // be the stale pre-tilt value with a late 55 still inbound — the
    // published view then opens pitched (the diagnostic's exact
    // payload). Re-click whenever the live control reads pressed.
    await expect
      .poll(
        async () => {
          if ((await tiltBtn.getAttribute("aria-pressed")) === "true") {
            await tiltBtn.click();
            return -1;
          }
          const first = await pitchOf();
          if (first !== 0) return first;
          await page.waitForTimeout(600);
          return pitchOf();
        },
        { timeout: 30_000 },
      )
      .toBe(0);
    await saveSettled(page);
  });

  const publishedUrl = await test.step("publishing yields a link", async () => {
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await page.getByRole("button", { name: "Publish map" }).click();
    await expect(page.getByText("Published · just now")).toBeVisible();
    const link =
      (await page
        .locator("[data-publish-url]")
        .getAttribute("data-publish-url")) ?? "";
    expect(link).toMatch(/\/v\/.+/);
    return link;
  });

  await test.step("the published view shows the map, read-only", async () => {
    let previewReads = 0;
    const previewCounter = (req: { method(): string; url(): string }) => {
      if (/\/api\/layers\/[^/]+\/slider-preview/.test(req.url())) {
        previewReads += 1;
      }
    };
    page.on("request", previewCounter);
    await page.goto(publishedUrl);
    await expect(
      page.getByRole("heading", { name: "Untitled map" }),
    ).toBeVisible();
    // The map canvas is up; with all tile hosts blocked the documented
    // offline fallback must announce itself rather than break the page.
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    await expect(
      page.getByText("basemap offline · data only"),
    ).toBeVisible();
    // The styled legend made it to the viewer: its title is the layer name,
    // and its class rows are the only list items on this chrome-free page.
    // (First match: a second constant layer would also print its name on
    // the overlay; this one styled layer, whose title appears in the legend
    // heading.)
    await expect(page.getByText(tableName).first()).toBeVisible();
    await expect
      .poll(async () => page.locator("li").count())
      .toBeGreaterThan(1);
    await expect(page.getByText("made with Dezfil")).toBeVisible();
    // The dashboard reached the viewer live: the rail shows — note card
    // included — and a read-only visitor deactivates a category: the row
    // dims, the formula narrows. No edit capability, no chips.
    await expect(page.locator("[data-widget-rail]")).toBeVisible();
    await expect(page.locator('[data-widget-card="note"]')).toContainText(
      "Fixture stations, counted live.",
    );
    const viewerFormula = page.locator('[data-widget-card="formula"]');
    await expect(viewerFormula).toContainText("4");
    const viewerHbf = page
      .locator('[data-widget-card="category"]')
      .getByRole("button", { name: /Hauptbahnhof/ });
    await viewerHbf.click();
    await expect(viewerHbf).not.toHaveAttribute("data-active", "");
    await expect(viewerFormula).toContainText("filtered from 4");
    expect(await page.locator("[data-widget-chip]").count()).toBe(0);
    // The docked timeline reached the viewer: histogram widget, playable.
    await expect(page.getByTestId("timeline")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Play", exact: true }),
    ).toBeEnabled();
    // No builder or workspace chrome of any kind.
    await expect(page.getByRole("link", { name: "Data" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Share" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Basemap" })).toHaveCount(0);
    await expect(page.getByText("Approximate preview")).toHaveCount(0);
    expect(previewReads).toBe(0);
    page.off("request", previewCounter);
  });

  await test.step("published readers get the tilt control", async () => {
    const tilt = page.getByRole("button", { name: "Tilt the map" });
    try {
      await expect(tilt).toBeVisible();
    } catch (error) {
      // A bare timeout taught nothing twice — name the failed stage
      // before rethrowing, so the next firing is diagnostic.
      console.log(await tiltDiagnostic(page, consoleErrors));
      throw error;
    }
    await tilt.click();
    await expect(
      page.getByRole("button", { name: "Back to flat" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Back to flat" }).click();
    await expect(
      page.getByRole("button", { name: "Tilt the map" }),
    ).toBeVisible();
  });

  await test.step("the console stayed clean", async () => {
    const unexpected = consoleErrors.filter(
      (e) => !isAllowedConsoleError(e.text, e.url),
    );
    expect(unexpected).toEqual([]);
  });
});
