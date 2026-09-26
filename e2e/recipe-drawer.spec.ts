// The tools drawer's container and its guardrail (plus the dismissal
// carried).
//
// **Everything here is measured, never read from a class.** A class that says
// `wide` proves nothing about a stage that did not move, and the drawer's own
// open flag proves nothing at all — asserting it is the version of the
// guardrail that cannot fail. So: the drawer's box, the stage's box, the
// neighbours' boxes, the committed edge's mutation count, and a hit test at a
// coordinate the drawer covered.
//
// Environment: the documented gate (isolated server, fresh data dir).
// Run with DEZFIL_BASE_URL at the server.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  addLayer,
  createMap,
  patchMap,
  routeHouse,
  seedFile,
  trackConsole,
} from "./support";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const runId = Date.now().toString(36);
const stations = `drawer_${runId}`;

const WIDE = { width: 1440, height: 900 };
/** At and below the shell's one breakpoint the drawer overlays. */
const NARROW = { width: 1100, height: 860 };

async function seedMap(page: Page): Promise<string> {
  await page.goto("/maps");
  await seedFile(
    page,
    `${stations}.geojson`,
    readFileSync(path.join(FIXTURES_DIR, "stations.geojson"), "utf8"),
    "application/geo+json",
  );
  const mapId = await createMap(page, `drawer ${runId}`);
  await addLayer(page, mapId, stations, `SELECT * FROM ${stations}`);
  // A note widget, so the **widget rail** exists to be measured: the rule
  // names three neighbours and a test that measured two would certify a
  // conjunctive claim from one conjunct.
  await patchMap(page, mapId, {
    widgets: [
      {
        id: `w-${runId}`,
        type: "note",
        layerId: null,
        title: "Rail",
        field: null,
        agg: "count",
        aggField: null,
        unit: null,
        note: "Present so the widget rail is on screen.",
        format: null,
        visible: true,
      },
    ],
  });
  return mapId;
}

const drawer = (page: Page) => page.locator("[data-recipe-drawer]");
/** The dashboard column on the stage's right edge. */
const WIDGET_RAIL = '[aria-label="Map widgets"]';

/** Open the drawer through the door, which is also the contracted route. */
async function openDrawer(page: Page) {
  // The door: select a layer (when none is), then Tools — the selection
  // is the context the card's Analyze… used to carry.
  if ((await page.locator('li[data-selected="true"]').count()) === 0) {
    await page.locator("[data-layer-select]").first().click();
  }
  await page.locator("[data-tools-control]").click();
  await expect(drawer(page)).toBeVisible();
}

async function boxOf(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  expect(box, `${selector} has a box`).not.toBeNull();
  return box!;
}

/** Wait until an element's box has stopped moving, and return it.
 *
 * Two animations run on a resize and they are not the same length of time:
 * the drawer's own width, and the stage's `left`, which eases on the panel
 * beat and restarts on every frame of a drag. Measuring the stage the moment
 * the drawer's width reads right catches it mid-flight — 34 px into a 152 px
 * move, in the run that found this. */
async function settledBox(page: Page, selector: string) {
  let last = "";
  await expect
    .poll(async () => {
      const box = await boxOf(page, selector);
      const now = `${Math.round(box.x)}:${Math.round(box.width)}`;
      const stable = now === last;
      last = now;
      return stable;
    })
    .toBe(true);
  return boxOf(page, selector);
}

test("the container is the one geometry the pivot fixes, measured", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize(WIDE);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);

  const closed = {
    stage: await settledBox(page, "[data-drag-canvas]"),
    rail: await boxOf(page, 'nav[aria-label="Product navigation"]'),
    inspector: await boxOf(page, '[role="tablist"][aria-label="Builder panels"]'),
    widgets: await boxOf(page, WIDGET_RAIL),
  };

  await test.step("it opens at 342 — the number, not the inspector's width", async () => {
    await openDrawer(page);
    const box = await boxOf(page, "[data-recipe-drawer]");
    expect(Math.round(box.width)).toBe(342);
  });

  await test.step("no resize, snap or collapse affordance exists", async () => {
    await expect(page.locator("[data-drawer-handle]")).toHaveCount(0);
    await expect(drawer(page)).not.toHaveAttribute("data-collapsed");
    // The head carries no menu at all since the pivot — nothing to collapse,
    // nothing to resize, and no control anywhere in the drawer says either.
    await expect(
      drawer(page).getByRole("button", { name: /collapse|resize/i }),
    ).toHaveCount(0);
  });

  await test.step("opening moves the stage by width plus gutter, and nothing else", async () => {
    const open = {
      // Settled, not sampled: the stage eases its own `left` on the panel
      // beat, so it can still be moving when the drawer is already visible.
      stage: await settledBox(page, "[data-drag-canvas]"),
      rail: await boxOf(page, 'nav[aria-label="Product navigation"]'),
      inspector: await boxOf(page, '[role="tablist"][aria-label="Builder panels"]'),
      widgets: await boxOf(page, WIDGET_RAIL),
    };
    // The one thing that moves, and it moves by the whole bill: 342 + 12.
    expect(Math.round(open.stage.x - closed.stage.x)).toBe(354);
    expect(Math.round(open.rail.x)).toBe(Math.round(closed.rail.x));
    expect(Math.round(open.inspector.x)).toBe(Math.round(closed.inspector.x));
    // All three neighbours, because the criterion names all three.
    expect(Math.round(open.widgets.x)).toBe(Math.round(closed.widgets.x));
  });

  await test.step("the geometry is the same after a reload — nothing is remembered because nothing varies", async () => {
    await page.reload();
    await openDrawer(page);
    await expect
      .poll(async () => Math.round((await boxOf(page, "[data-recipe-drawer]")).width))
      .toBe(342);
  });

  expect(consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
});

test("the camera's padding commits once per open and once per close", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize(WIDE);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);

  // `data-stage-edge` is the committed edge itself — the number handed to the
  // camera — so counting its mutations counts commits. Watching the map
  // eventually settle would pass against a per-frame commit too. The map
  // must exist before the observer does, or there is nothing to observe.
  await page.waitForSelector("[data-map-layer]");
  await page.evaluate(() => {
    const target = document.querySelector("[data-map-layer]")!;
    const window_ = window as unknown as { __edgeCommits: number };
    window_.__edgeCommits = 0;
    new MutationObserver((records) => {
      window_.__edgeCommits += records.length;
    }).observe(target, { attributes: true, attributeFilter: ["data-stage-edge"] });
  });
  const commits = () =>
    page.evaluate(
      () => (window as unknown as { __edgeCommits: number }).__edgeCommits,
    );

  await openDrawer(page);
  await settledBox(page, "[data-drag-canvas]");
  // Waited for, then read again after a pause: "exactly one" means no
  // further commit arrived rather than none had yet.
  await expect.poll(commits).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(600);
  expect(await commits(), "one commit for the whole open").toBe(1);

  await page.locator("[data-drawer-dismiss]").click();
  await settledBox(page, "[data-drag-canvas]");
  await expect.poll(commits).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(600);
  expect(await commits(), "and one more for the close").toBe(2);

  expect(consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
});

test("Escape closes one level at a time, and focus returns to the door (the doors that exist)", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize(WIDE);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);

  await test.step("with Select armed, the first Escape only disarms", async () => {
    await openDrawer(page);
    await page.locator("[data-operation='buffer']").click();
    await expect(page.locator("[data-parameter-form]")).toBeVisible();
    // The input arrived pre-filled from the door; free it so the picker's
    // Select mode exists to arm.
    await page.locator("[data-input-change]").first().click();
    await page.locator("[data-pick-select]").first().click();
    await expect(page.locator("[data-pick-armed]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-pick-armed]")).toHaveCount(0);
    await expect(drawer(page)).toBeVisible();
  });

  await test.step("the next Escape closes the drawer and hands focus back", async () => {
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-recipe-drawer]")).toHaveCount(0);
    // The door that opened it — the Tools control — holds focus again,
    // resolved by identity rather than by "something is focused".
    expect(
      await page.evaluate(
        () => document.activeElement?.hasAttribute("data-tools-control") ?? false,
      ),
    ).toBe(true);
  });

  expect(consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
});

test("at and below 1120 px the drawer overlays and the map keeps its width", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize(NARROW);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);

  const closed = await boxOf(page, "[data-drag-canvas]");
  await openDrawer(page);
  await expect(drawer(page)).toHaveAttribute("data-overlay", "true");
  // Still 342 in overlay mode — the drawer does not borrow the narrowed
  // inspector's width.
  expect(Math.round((await boxOf(page, "[data-recipe-drawer]")).width)).toBe(342);
  const open = await boxOf(page, "[data-drag-canvas]");
  expect(Math.round(open.x)).toBe(Math.round(closed.x));
  expect(Math.round(open.width)).toBe(Math.round(closed.width));

  expect(consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
});

/**
 * Part 1 of the guardrail: the drawer is easy to dismiss, from every state it
 * can be in — the catalog mid-choice, a parameter form with unsaved edits,
 * and a run in flight (the chain face left with the pivot).
 */
const STATES = [
  "the catalog mid-choice",
  "a form with edits",
  "a step mid-run",
] as const;

/** Each mid-run entry authors a real run, so each needs its own output. */
let midRun = 0;

async function enter(page: Page, state: (typeof STATES)[number]) {
  await openDrawer(page);
  // The catalog IS the opening face since the cutover — no Add step exists.
  await expect(page.locator("[data-operation-picker]")).toBeVisible();
  if (state === "the catalog mid-choice") return;
  await page.locator("[data-operation='buffer']").click();
  await expect(page.locator("[data-parameter-form]")).toBeVisible();
  // Unsaved edits: a typed distance and a renamed output.
  await page.locator("[data-param='distance']").fill("500");
  await page.locator("[data-output-name]").fill(`unsaved_${runId}_${midRun}`);
  if (state === "a form with edits") return;
  // The fourth state. The acceptance is armed **before** the gesture, so the
  // run is genuinely under way when the drawer is dismissed — a dismissal
  // after it finished would prove nothing about a step mid-run.
  midRun += 1;
  const accepted = page.waitForResponse(
    (r) => /\/steps\/[^/]+\/run$/.test(r.url()) && r.request().method() === "POST",
  );
  await page.locator("[data-form-run]").click();
  await accepted;
}

test("part 1, above 1120 px: one gesture dismisses it and the stage's edge moves", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize(WIDE);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);

  for (const state of STATES) {
    await test.step(`from ${state}`, async () => {
      const closed = await boxOf(page, "[data-drag-canvas]");
      await enter(page, state);
      // The displacement is polled, not read once: under a loaded
      // whole-set run the layout shift can land a beat after the drawer.
      await expect
        .poll(async () => (await boxOf(page, "[data-drag-canvas]")).x, {
          message: "the drawer displaces the stage while it is open",
        })
        .toBeGreaterThan(closed.x);
      const open = await boxOf(page, "[data-drag-canvas]");
      expect(open.x, "the drawer displaces the stage while it is open").toBeGreaterThan(
        closed.x,
      );
      // **The assertion is not the drawer's own flag.** That one cannot fail:
      // a drawer that hid itself while still holding the stage's width would
      // pass it. What is asserted is that the stage came back.
      await page.locator("[data-drawer-dismiss]").click();
      await expect
        .poll(async () => Math.round((await boxOf(page, "[data-drag-canvas]")).x))
        .toBe(Math.round(closed.x));
      // And no confirmation stood in the way — including with unsaved edits.
      await expect(page.locator("[role='dialog']")).toHaveCount(0);
    });
  }

  expect(consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
});

test("part 1, at or below 1120 px: the map is interactive where the drawer was", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize(NARROW);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);

  for (const state of STATES) {
    await test.step(`from ${state}`, async () => {
      await enter(page, state);
      const box = await boxOf(page, "[data-recipe-drawer]");
      const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + 120) };
      // While it is open, that coordinate belongs to the drawer.
      expect(
        await page.evaluate(
          (p) => document.elementFromPoint(p.x, p.y)?.closest("[data-recipe-drawer]") !== null,
          point,
        ),
      ).toBe(true);

      await page.locator("[data-drawer-dismiss]").click();
      await expect(page.locator("[data-recipe-drawer]")).toHaveCount(0);

      // Here the stage's edge cannot move — the drawer overlaid it by design —
      // so asserting on the edge would be the tautological version wearing the
      // enforcing version's clothes. What is asserted is that the pointer now
      // reaches the map at the coordinate the drawer covered, resolved by
      // ancestry rather than by "something is there".
      const hit = await page.evaluate((p) => {
        const el = document.elementFromPoint(p.x, p.y);
        return {
          inDrawer: el?.closest("[data-recipe-drawer]") !== null && el !== null,
          inMap: el?.closest("[data-map-layer]") !== null && el !== null,
        };
      }, point);
      expect(hit.inDrawer).toBe(false);
      expect(hit.inMap, "the map receives the pointer where the drawer was").toBe(true);
    });
  }

  expect(consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
});

test("part 1's riders: no blocking confirmation, and a dismissal does not cancel a run", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize(WIDE);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);

  await test.step("unsaved edits raise no blocking confirmation", async () => {
    await enter(page, "a form with edits");
    await page.locator("[data-drawer-dismiss]").click();
    await expect(page.locator("[data-recipe-drawer]")).toHaveCount(0);
    await expect(page.locator("[role='dialog']")).toHaveCount(0);
  });

  await test.step("dismissing mid-run does not cancel the run, and its outcome stays reachable", async () => {
    await enter(page, "a form with edits");
    const output = `midrun_${runId}`;
    await page.locator("[data-output-name]").fill(output);
    // Arm the acceptance before the gesture: the run must be under way when
    // the drawer goes, or this proves nothing about a run at all.
    const accepted = page.waitForResponse(
      (r) => /\/steps\/[^/]+\/run$/.test(r.url()) && r.request().method() === "POST",
    );
    await page.locator("[data-form-run]").click();
    await accepted;
    await page.locator("[data-drawer-dismiss]").click();
    await expect(page.locator("[data-recipe-drawer]")).toHaveCount(0);

    // The outcome, read from outside the drawer entirely.
    await expect
      .poll(
        async () =>
          await page.evaluate(async (name) => {
            const r = await fetch("/api/tables", { cache: "no-store" });
            const tables = (await r.json()) as { name: string }[];
            return tables.some((t) => t.name === name);
          }, output),
        { timeout: 60_000 },
      )
      .toBe(true);
  });

  expect(consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
});
