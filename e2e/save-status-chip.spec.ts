import { readThenWriteBrowserSetup } from "./edit-basis";
import type { EditBasis } from "../src/lib/edit-basis";
// The save status leaves the path card for the stage.
//
// Two things are proven here that page-wide text assertions cannot: that
// the header card no longer reserves width for a status nobody can see,
// and that every producer's message, tone, hold and action arrives in the
// stage chip instead. The existing save, retry, import and drawing
// journeys assert page-wide text and would stay green with the status in
// the wrong place, so they are not evidence of the relocation.
import { test, expect, type Page } from "@playwright/test";
import { routeHouse } from "./support";

const runId = Date.now().toString(36);

/** The recorded reservation path.
 *
 * Defect hides at a short path: the card's floor is the layer pane's
 * reach (410 px here), and while the path plus the ~70 px of reserved
 * status width still fits inside that floor the card sits on the pane's
 * edge either way — an equality check there passes BEFORE the change. A
 * long path legitimately exceeds the floor, so an equality check there
 * fails AFTER it. Only a path in the window between the two
 * discriminates: its own width fits the floor, its width plus the
 * reservation does not.
 *
 * Measured on an isolated instance at 1280 and 1440: the reservation is
 * 69.58 px, the window runs from 14 to about 19 of these glyphs, and at
 * 16 the card is 450.58 px wide and overshoots the pane by 40.58 px,
 * while the same path without the reservation lands on the pane's edge
 * (0.00 px). The fixture is a fixed glyph run, not a run-unique name,
 * because its rendered WIDTH is the fixture.
 *
 * The header configuration is fixed with it, because clamps the card's
 * floor to the room its siblings leave: no instance name, no project,
 * the map unpublished, the builder's own search control present, at 1280
 * and 1440 — widths at which the floor is the pane's reach and not the
 * clamp (which the after-measurement re-proves by landing on the pane's
 * edge).
 */
const RESERVATION_PATH = "M".repeat(16);
const RESERVATION_VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
];
/** Past the name's 300 px cap on both surfaces: the card is sized by its
 * content there, so the reservation shows as clearance rather than as an
 * overshoot. */
const LONG_PATH = `Regional accessibility of primary care practices by public transport, weekday morning peak ${runId}`;

const api = (page: Page, method: string, path: string, body?: unknown, basis?: EditBasis) =>
  page.evaluate(
    async ({ method, path, body, basis }) => {
      const r = await fetch(path, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : undefined), ...(basis ? { "X-Edit-Revision": String(basis.editRevision) } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok && r.status !== 204) throw new Error(await r.text());
      return r.status === 204 ? null : ((await r.json()) as unknown);
    },
    { method, path, body, basis },
  );

const card = (page: Page) => page.locator("header > div").first();

/** The card's insets, read from the rendered text as own check
 * reads them: the left inset to the glyph box of the P of Dezfil, the
 * right clearance from the path's last visible character to the border.
 * A hidden node is skipped, which is exactly why an absence check
 * against visible text proves nothing here — the reservation was always
 * invisible. What it can prove is the clearance the reservation left. */
const insets = (page: Page) =>
  page.evaluate(() => {
    const cardEl = document.querySelector("header > div")!;
    const brand = cardEl.querySelector('a[href="/"]')!;
    const nav = cardEl.querySelector('nav[aria-label="Breadcrumb"]')!;
    const walker = document.createTreeWalker(nav, NodeFilter.SHOW_TEXT);
    let last: Node | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!(n.textContent ?? "").trim()) continue;
      const style = getComputedStyle(n.parentElement!);
      if (style.visibility === "hidden" || style.display === "none") continue;
      last = n;
    }
    if (!last) throw new Error("the breadcrumb has no visible text");
    const range = document.createRange();
    range.selectNodeContents(last);
    const glyphs = range.getBoundingClientRect();
    const holder = last.parentElement!;
    const contentRight =
      holder.getBoundingClientRect().right -
      parseFloat(getComputedStyle(holder).paddingRight);
    range.selectNodeContents(brand);
    const p = range.getBoundingClientRect();
    const c = cardEl.getBoundingClientRect();
    return {
      left: p.left - c.left,
      right: c.right - Math.min(glyphs.right, contentRight),
      truncated: glyphs.right > contentRight + 0.5,
      cardWidth: c.width,
    };
  });

const edges = async (page: Page, pane: ReturnType<Page["locator"]>) => {
  await expect(pane).toBeVisible();
  const c = (await card(page).boundingBox())!;
  const p = (await pane.boundingBox())!;
  return { cardRight: c.x + c.width, paneRight: p.x + p.width, cardWidth: c.width };
};

test.afterEach(async ({ request }) => {
  await request
    .patch("/api/settings", { data: { instanceName: null } })
    .catch(() => {});
});

test("the header card stops reserving the status's width, on the recorded path and at a long one", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize(RESERVATION_VIEWPORTS[1]);
  await page.goto("/");
  await api(page, "PATCH", "/api/settings", { instanceName: null });
  const reservationMapId = (
    (await api(page, "POST", "/api/maps", { name: RESERVATION_PATH })) as {
      id: string;
    }
  ).id;
  const longMapId = (
    (await api(page, "POST", "/api/maps", { name: LONG_PATH })) as { id: string }
  ).id;
  const longRecipeId = (
    (await api(page, "POST", "/api/recipes", { name: LONG_PATH })) as {
      recipe: { id: string };
    }
  ).recipe.id;
  const builderPane = page.locator("aside[data-builder-pane]");
  const canvasPane = page.locator("aside[data-canvas-pane]");

  await test.step("the recorded path: the card's right edge lands on the pane's at each named viewport", async () => {
    for (const viewport of RESERVATION_VIEWPORTS) {
      await page.setViewportSize(viewport);
      await page.goto(`/maps/${reservationMapId}`);
      const e = await edges(page, builderPane);
      const overshoot = e.cardRight - e.paneRight;
      console.log(
        `reservation path at ${viewport.width}: card ${e.cardRight.toFixed(2)} (${e.cardWidth.toFixed(2)} wide), pane ${e.paneRight.toFixed(2)}, overshoot ${overshoot.toFixed(2)}`,
      );
      // Soft, so the second viewport is still measured when the first
      // fails: a run that stops early proves only what it reached.
      expect
        .soft(
          Math.abs(overshoot),
          `at ${viewport.width}: the recorded path's card sits on the pane's edge (overshoot ${overshoot.toFixed(2)})`,
        )
        .toBeLessThanOrEqual(1);
    }
  });

  await test.step("a long path on each surface: the status-only clearance is gone, the ordinary padding and the truncation stand", async () => {
    await page.setViewportSize(RESERVATION_VIEWPORTS[1]);
    const surfaces: [string, string, ReturnType<Page["locator"]>][] = [
      ["builder", `/maps/${longMapId}`, builderPane],
      ["workflow canvas", `/workflows/${longRecipeId}`, canvasPane],
    ];
    for (const [name, route, pane] of surfaces) {
      await page.goto(route);
      await expect(pane).toBeVisible();
      const i = await insets(page);
      console.log(
        `long path on the ${name}: card ${i.cardWidth.toFixed(2)} px, left inset ${i.left.toFixed(2)}, right clearance ${i.right.toFixed(2)}${i.truncated ? ", name shortened" : ""}`,
      );
      expect
        .soft(
          i.right,
          `${name}: the right clearance (${i.right.toFixed(2)}) is the left inset (${i.left.toFixed(2)}) and no status width`,
        )
        .toBeLessThanOrEqual(i.left + 0.5);
      expect
        .soft(
          i.right,
          `${name}: the ordinary padding stands (clearance ${i.right.toFixed(2)}, inset ${i.left.toFixed(2)})`,
        )
        .toBeGreaterThanOrEqual(i.left - 0.5);
      expect
        .soft(i.truncated, `${name}: the long name is still shortened at the cap`)
        .toBe(true);
    }
  });
});

/** The chip's relationship to the control stack, which is the placement
 * the reference fixes: level with the stack's top, one clear gap right of
 * its box. Asserted as that relationship rather than as coordinates, so
 * it holds wherever a surface puts its stage edge. */
const STACK_GAP = 8;
const cornerAgainstStack = (page: Page, stack: string) =>
  page.evaluate((stackSelector) => {
    const corner = document.querySelector("[data-save-status-corner]");
    const stackEl = document.querySelector(stackSelector);
    if (!corner || !stackEl) throw new Error("no corner or no stack on the stage");
    const c = corner.getBoundingClientRect();
    const s = stackEl.getBoundingClientRect();
    return { top: c.top - s.top, gap: c.left - s.right };
  }, stack);

test("the chip holds its line on the stack across every stage edge", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const mapId = (
    (await api(page, "POST", "/api/maps", { name: `Stage edges ${runId}` })) as {
      id: string;
    }
  ).id;
  const recipeId = (
    (await api(page, "POST", "/api/recipes", {
      name: `Stage edges ${runId}`,
    })) as { recipe: { id: string } }
  ).recipe.id;

  const held = (where: string, r: { top: number; gap: number }) => {
    console.log(`${where}: corner ${r.top.toFixed(2)} px off the stack's top, ${r.gap.toFixed(2)} px right of its box`);
    expect
      .soft(Math.abs(r.top), `${where}: the chip is level with the stack's top`)
      .toBeLessThanOrEqual(1);
    expect
      .soft(r.gap, `${where}: the chip clears the stack by its own gap`)
      .toBeGreaterThanOrEqual(STACK_GAP - 1);
    expect
      .soft(r.gap, `${where}: the chip stays on the stack's line, not adrift of it`)
      .toBeLessThanOrEqual(STACK_GAP + 1);
  };

  await test.step("the builder: at rest, at the narrow breakpoint, in fullscreen, and with the drawer's offset", async () => {
    const stack = "[class*='stageAnchor']";
    await page.goto(`/maps/${mapId}`);
    await expect(page.locator("aside[data-builder-pane]")).toBeVisible();
    held("builder at rest, 1440", await cornerAgainstStack(page, stack));

    // Below 1120 the stage edge takes its narrow value.
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.waitForTimeout(400);
    held("builder at the narrow breakpoint, 1000", await cornerAgainstStack(page, stack));

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Fullscreen map" }).click();
    await expect
      .poll(() => page.evaluate(() => document.body.hasAttribute("data-map-full")))
      .toBe(true);
    await page.waitForTimeout(500);
    held("builder in fullscreen", await cornerAgainstStack(page, stack));

    // The drawer is the only writer of --drawer-offset (MapBuilder's own
    // rule), and fullscreen is where the stage edge reads it. Driving
    // the property exercises the chip's side of that contract; the
    // drawer's own flow is coverage, not this piece's.
    await page.evaluate(() =>
      document.body.style.setProperty("--drawer-offset", "320px"),
    );
    await page.waitForTimeout(500);
    held("builder in fullscreen with the drawer's offset", await cornerAgainstStack(page, stack));
    await page.evaluate(() =>
      document.body.style.removeProperty("--drawer-offset"),
    );
    await page.getByRole("button", { name: "Exit fullscreen map" }).click();
  });

  await test.step("the workflow canvas: in the full view and in the framed one", async () => {
    const stack = "[data-canvas-stage]";
    await page.goto(`/workflows/${recipeId}`);
    await expect(page.locator("[data-canvas-stage]")).toBeVisible();
    held("canvas in the full view", await cornerAgainstStack(page, stack));
    await page.getByRole("button", { name: "Framed view" }).click();
    await page.waitForTimeout(500);
    held("canvas in the framed view", await cornerAgainstStack(page, stack));
  });
});

// ---- the producers at the chip ----

const chipOf = (page: Page, kind: string) =>
  page.locator(`[data-save-status="${kind}"]`);
/** On means the producer's message is standing: the attribute the chip's
 * own entrance reads, and the visibility a reader depends on. */
const expectChipOn = async (page: Page, kind: string, text: RegExp | string) => {
  await expect(chipOf(page, kind)).toHaveAttribute("data-on", "true");
  await expect(chipOf(page, kind)).toBeVisible();
  await expect(chipOf(page, kind)).toContainText(text);
};
/** The card carries the path and nothing else: with the message
 * positively on screen in the chip, the header holds no copy of it, and
 * the chip itself is not inside the header. An absence with a subject. */
const expectNotInTheCard = async (page: Page, text: string) => {
  const inCard = await page.evaluate((t) => {
    const header = document.querySelector("header");
    if (!header) throw new Error("no header on the page");
    const chips = document.querySelectorAll("[data-save-status]");
    if (chips.length === 0) throw new Error("no status chip on the page");
    return {
      text: (header.textContent ?? "").includes(t),
      chipInside: Array.from(chips).some((c) => header.contains(c)),
    };
  }, text);
  expect.soft(inCard.text, `the header card holds no copy of "${text}"`).toBe(false);
  expect.soft(inCard.chipInside, "the chip stands on the stage, not in the header").toBe(false);
};

test("the builder: both channels at the chip, live together and on their own lifetimes", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  await routeHouse(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const mapId = (
    (await api(page, "POST", "/api/maps", {
      name: `Builder channels ${runId}`,
    })) as { id: string }
  ).id;
  await page.goto(`/maps/${mapId}`);
  await expect(page.locator("aside[data-builder-pane]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Draw", exact: true })).toBeVisible({ timeout: 30_000 });

  /** A drawing failure, which is a notice the import journeys never
   * reach: the session's first shape cannot be saved and the channel
   * says so in its own words. */
  const drawWithTheSaveCut = async () => {
    await page.route(`**/api/maps/${mapId}/sketches`, (route) =>
      route.request().method() === "POST" ? route.abort() : route.continue(),
    );
    const failed = page.waitForEvent("requestfailed", (request) =>
      request.method() === "POST" && request.url().endsWith(`/api/maps/${mapId}/sketches`),
    );
    await page.getByRole("button", { name: "Draw", exact: true }).click();
    const dock = page.getByRole("toolbar", { name: "Draw tools" });
    await expect(dock).toBeVisible();
    // One click reaches the same save producer without a vertex draft.
    await dock.getByRole("button", { name: "Draw points" }).click();
    await page.mouse.click(700, 300);
    await failed;
  };
  const leaveDrawing = async () => {
    await page.unroute(`**/api/maps/${mapId}/sketches`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("toolbar", { name: "Draw tools" })).toBeHidden();
  };

  await test.step("the notice channel carries a drawing failure, in the warning treatment, with no retry", async () => {
    await drawWithTheSaveCut();
    await expectChipOn(page, "notice", /could not be saved/);
    // The channel's presentation is unchanged by the wording: no danger
    // tone, and no action it never had.
    await expect(chipOf(page, "notice")).not.toHaveAttribute("data-tone", "bad");
    expect
      .soft(
        await chipOf(page, "notice").locator("button").count(),
        "a builder failure gains no Retry",
      )
      .toBe(0);
    await expectNotInTheCard(page, "could not be saved");
    await leaveDrawing();
  });

  await test.step("both channels stand together, in their order, each expiring on its own", async () => {
    // Settle the drawing failure first. A new sketch would otherwise wait
    // behind the held rename in this document's ordered write sequence.
    await drawWithTheSaveCut();
    await expectChipOn(page, "notice", /could not be saved/);
    // A tracked write held open: the saving indication stands until it
    // settles, which is what lets a notice run its whole hold beside it.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/maps/*/sketches", (route) => route.continue());
    await page.route(`**/api/maps/${mapId}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      await held;
      return route.continue();
    });
    // The map's own lane: renaming from the crumb is a tracked write.
    await page
      .locator('nav[aria-label="Breadcrumb"]')
      .getByRole("button", { name: `Builder channels ${runId}`, exact: true })
      .click();
    const nameInput = page.getByLabel("Map name");
    await nameInput.fill(`Builder channels renamed ${runId}`);
    await nameInput.press("Enter");
    await expectChipOn(page, "saving", "Saving…");
    await expectNotInTheCard(page, "Saving…");

    await expectChipOn(page, "notice", /could not be saved/);
    await expectChipOn(page, "saving", "Saving…");
    const order = await page.evaluate(() => {
      const lines = Array.from(document.querySelectorAll("[data-save-status]"));
      const chips = Array.from(document.querySelectorAll("[data-save-status-chip]"));
      const on = lines.filter((c) => c.hasAttribute("data-on"));
      const chip = chips[0];
      return {
        kinds: lines.map((c) => c.getAttribute("data-save-status")),
        onCount: on.length,
        chipCount: chips.length,
        bothInsideTheOneChip: on.every((c) => chip.contains(c)),
        tops: on.map((c) => Math.round(c.getBoundingClientRect().top)),
        chipHeight: Math.round(chip.getBoundingClientRect().height),
      };
    });
    expect.soft(order.onCount, "both channels are on screen at once").toBe(2);
    // The pick over the prototype's two variants: the notice
    // shares the status's home rather than taking a chip of its own.
    expect.soft(order.chipCount, "there is one chip, not one per channel").toBe(1);
    expect.soft(order.bothInsideTheOneChip, "and both channels are lines inside it").toBe(true);
    expect.soft(order.kinds, "the saving indication stands first, as it did in the header").toEqual(["saving", "notice"]);
    expect
      .soft(order.tops[0], "the saving line sits above the notice")
      .toBeLessThan(order.tops[1]);
    // The pill grew to hold both bands rather than choosing between them.
    expect.soft(order.chipHeight, "the pill grew to hold both").toBe(60);

    // The notice's four seconds run out while the save is still in
    // flight: two lifetimes, neither suppressing the other.
    await expect
      .poll(
        () => chipOf(page, "notice").getAttribute("data-on"),
        { message: "the notice expires on its own hold", timeout: 10_000 },
      )
      .toBe(null);
    await expectChipOn(page, "saving", "Saving…");
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Math.round(
              document
                .querySelector("[data-save-status-chip]")!
                .getBoundingClientRect().height,
            ),
          ),
        { message: "the pill shrinks back to one band when the notice goes" },
      )
      .toBe(30);
    await page.unroute(`**/api/maps/${mapId}`);
    release();
    await expect
      .poll(() => chipOf(page, "saving").getAttribute("data-on"), {
        message: "the saving indication clears when its write settles",
        timeout: 20_000,
      })
      .toBe(null);
    await leaveDrawing();
  });

  await test.step("the announcement is per channel, and the header keeps no second copy", async () => {
    const regions = await page.evaluate(() => ({
      saving: document
        .querySelector('[data-save-status="saving"]')
        ?.getAttribute("aria-live") ?? null,
      notice: document
        .querySelector('[data-save-status="notice"]')
        ?.getAttribute("aria-live") ?? null,
      inHeader: document.querySelectorAll("header [aria-live]").length,
    }));
    expect.soft(regions.saving, "the saving indication has no live region").toBe(null);
    expect.soft(regions.notice, "the notice channel still announces politely").toBe("polite");
    expect.soft(regions.inHeader, "no live region is left in the header").toBe(0);
  });

  await test.step("with the map's status bar hidden, the chip still carries a notice and a drawing failure", async () => {
    await page.getByRole("tab", { name: "Basemap" }).click();
    await page
      .locator("li")
      .filter({ hasText: "Status bar" })
      .getByRole("button")
      .click();
    await expect
      .poll(() => page.evaluate(() => document.body.hasAttribute("data-status-pill-hidden")))
      .toBe(true);
    await drawWithTheSaveCut();
    await expectChipOn(page, "notice", /could not be saved/);
    await leaveDrawing();
    // Closing the session announces what it saved: the same channel,
    // still on the chip, with the bar still switched off.
    await expectChipOn(page, "notice", /Sketch|shape/);
    await page
      .locator("li")
      .filter({ hasText: "Status bar" })
      .getByRole("button")
      .click();
  });
});

// ---- the workflow's producers and owner rules, at the chip ----

const canvasPaneOf = (page: Page) => page.locator("[data-canvas-pane]");
const whisperChip = (page: Page) => chipOf(page, "whisper");
const retryInChip = (page: Page) =>
  whisperChip(page).getByRole("button", { name: "Retry" });
const addATool = async (page: Page) => {
  await page.keyboard.press("Escape");
  await canvasPaneOf(page).getByRole("tab", { name: /^Tools/ }).click();
  await canvasPaneOf(page).getByRole("button", { name: "Add Centroid" }).click();
};
const renameTo = async (page: Page, from: string, to: string) => {
  await page
    .locator('nav[aria-label="Breadcrumb"]')
    .getByRole("button", { name: from, exact: true })
    .click();
  const input = page.getByLabel("Workflow name");
  await input.fill(to);
  await input.press("Enter");
};

test("the workflow: every producer speaks at the chip, with its own tone, hold and action", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  await routeHouse(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const name = `Producers ${runId}`;
  const renamed = `Producers renamed ${runId}`;
  const id = (
    (await api(page, "POST", "/api/recipes", { name })) as {
      recipe: { id: string };
    }
  ).recipe.id;
  await page.goto(`/workflows/${id}`);
  await expect(page.locator("[data-canvas-stage]")).toBeVisible();

  await test.step("a rename: Saving…, then Saved for its hold, in the plain treatment", async () => {
    await renameTo(page, name, renamed);
    await expectChipOn(page, "whisper", "Saved");
    await expect(whisperChip(page)).not.toHaveAttribute("data-tone", "bad");
    expect
      .soft(await whisperChip(page).locator("button").count(), "a rename carries no Retry")
      .toBe(0);
    await expectNotInTheCard(page, "Saved");
    await expect
      .poll(() => whisperChip(page).getAttribute("data-on"), {
        message: "the rename's Saved clears on its own hold",
        timeout: 5_000,
      })
      .toBe(null);
  });

  await test.step("a rename that fails: the server's own words, in the danger tone, with no Retry", async () => {
    await page.route(`**/api/recipes/${id}`, (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "internal", message: "The name could not be filed." },
            }),
          })
        : route.continue(),
    );
    await renameTo(page, renamed, `${renamed} again`);
    await expectChipOn(page, "whisper", "The name could not be filed.");
    await expect(whisperChip(page)).toHaveAttribute("data-tone", "bad");
    expect
      .soft(await whisperChip(page).locator("button").count(), "a failed rename carries no Retry")
      .toBe(0);
    await page.unroute(`**/api/recipes/${id}`);
    await expect
      .poll(() => whisperChip(page).getAttribute("data-on"), {
        message: "a failed rename clears on its four seconds",
        timeout: 9_000,
      })
      .toBe(null);
  });

  await test.step("a recipe write: Saved; then its failure, with a Retry that works by pointer", async () => {
    await addATool(page);
    await expectChipOn(page, "whisper", "Saved");
    await expect
      .poll(() => whisperChip(page).getAttribute("data-on"), { timeout: 5_000 })
      .toBe(null);

    const cut = `**/api/recipes/${id}/steps`;
    await page.route(cut, (route) =>
      route.request().method() === "POST" ? route.abort() : route.continue(),
    );
    await addATool(page);
    await expectChipOn(page, "whisper", /Couldn.t save/);
    await expect(whisperChip(page)).toHaveAttribute("data-tone", "bad");
    await expect(retryInChip(page)).toBeVisible();
    await expectNotInTheCard(page, "Couldn’t save");
    // No expiry: it stands until something replaces it.
    await page.waitForTimeout(5_000);
    await expectChipOn(page, "whisper", /Couldn.t save/);
    await expect(retryInChip(page)).toBeVisible();

    await page.unroute(cut);
    const before = ((await api(page, "GET", `/api/recipes/${id}`)) as {
      recipe: { steps: unknown[] };
    }).recipe.steps.length;
    await retryInChip(page).click();
    await expect
      .poll(
        async () =>
          ((await api(page, "GET", `/api/recipes/${id}`)) as {
            recipe: { steps: unknown[] };
          }).recipe.steps.length,
        { message: "the pointer's Retry sent the write again" },
      )
      .toBe(before + 1);
  });

  await test.step("a layout write: Saved; then its failure, with a Retry that works by keyboard", async () => {
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Arrange by dependency" }).click();
    await expectChipOn(page, "whisper", "Saved");
    await expect
      .poll(() => whisperChip(page).getAttribute("data-on"), { timeout: 5_000 })
      .toBe(null);

    const cut = `**/api/recipes/${id}/layout`;
    await page.route(cut, (route) =>
      route.request().method() === "PUT" ? route.abort() : route.continue(),
    );
    await page.getByRole("button", { name: "Arrange by dependency" }).click();
    await expectChipOn(page, "whisper", /Couldn.t save/);
    await expect(retryInChip(page)).toBeVisible();
    await page.unroute(cut);
    // The keyboard's own road to the same control: focus it and press.
    const wrote = page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().includes(`/api/recipes/${id}/layout`),
    );
    await retryInChip(page).focus();
    expect
      .soft(
        await page.evaluate(
          () => document.activeElement?.textContent?.trim() ?? null,
        ),
        "Retry takes keyboard focus",
      )
      .toBe("Retry");
    await page.keyboard.press("Enter");
    await wrote;
  });

  await test.step("a stopped import: its own count, for four seconds, with no tone and no Retry", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let posts = 0;
    await page.route("**/api/tables", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posts += 1;
      // The FIRST upload is held, not the second: the queue runs one
      // file at a time, so holding the head leaves the other two
      // provably not started for as long as the gate stands. Holding a
      // later one leaves a window in which the tail starts while the
      // dialog is being closed, which is how this step failed in a
      // whole-file run and passed alone.
      if (posts === 1) await gate;
      return route.continue();
    });
    await canvasPaneOf(page).getByRole("tab", { name: /^Sources/ }).click();
    await canvasPaneOf(page).getByRole("button", { name: "Add data" }).click();
    await expect(page.getByRole("dialog", { name: "Add data" })).toBeVisible();
    const csv = (n: string) => ({
      name: `${n}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from("name,lon,lat\na,13.4,52.5\n"),
    });
    await page
      .locator('input[type="file"]')
      .setInputFiles([csv(`ssc1_${runId}`), csv(`ssc2_${runId}`), csv(`ssc3_${runId}`)]);
    await expect(page.getByText(/1 of 3/)).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("Escape");
    await expectChipOn(page, "whisper", "Stopped. 2 queued files were not started.");
    await expect(whisperChip(page)).not.toHaveAttribute("data-tone", "bad");
    expect
      .soft(await whisperChip(page).locator("button").count(), "a stopped import carries no Retry")
      .toBe(0);
    release();
    await expect
      .poll(() => whisperChip(page).getAttribute("data-on"), {
        message: "the stopped-import message clears on its four seconds",
        timeout: 9_000,
      })
      .toBe(null);
    await page.unroute("**/api/tables");
  });
});

test("the workflow: each owner rule holds at the chip, asserted one at a time", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  await routeHouse(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  let name = `Owner rules ${runId}`;
  const id = (
    (await api(page, "POST", "/api/recipes", { name })) as {
      recipe: { id: string };
    }
  ).recipe.id;
  await page.goto(`/workflows/${id}`);
  await expect(page.locator("[data-canvas-stage]")).toBeVisible();
  const arrange = () => page.getByRole("button", { name: "Arrange by dependency" });
  const addCentroid = () =>
    canvasPaneOf(page).getByRole("button", { name: "Add Centroid" });
  const layoutRoute = `**/api/recipes/${id}/layout`;
  const stepsRoute = `**/api/recipes/${id}/steps`;
  const stepRoute = `**/api/recipes/${id}/steps/*`;
  const nameRoute = `**/api/recipes/${id}`;

  // The layout route is registered once and steered by a flag: a
  // page.route call between two clicks costs enough to spend the 1.4 s
  // window the expiry rules live in, which would leave them asserting
  // nothing.
  let layoutMode: "pass" | "abort" | "hold" = "pass";
  let releaseLayout: (() => void) | null = null;
  await page.route(layoutRoute, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    if (layoutMode === "abort") return route.abort();
    if (layoutMode === "hold") await new Promise<void>((r) => (releaseLayout = r));
    return route.continue();
  });

  // One node, so Arrange has something to write and the panel something
  // to edit.
  await canvasPaneOf(page).getByRole("tab", { name: /^Tools/ }).click();
  await addCentroid().click();
  await expectChipOn(page, "whisper", "Saved");
  await expect
    .poll(() => whisperChip(page).getAttribute("data-on"), { timeout: 5_000 })
    .toBe(null);

  await test.step("an owner's Saving… or failure cancels that owner's own earlier expiry", async () => {
    await page.keyboard.press("Escape");
    await arrange().click();
    await expectChipOn(page, "whisper", "Saved");
    const armed = Date.now();
    layoutMode = "abort";
    await arrange().click();
    await expectChipOn(page, "whisper", /Couldn.t save/);
    layoutMode = "pass";
    const inside = Date.now() - armed;
    console.log(`cancellation: the failure landed ${inside} ms after the Saved armed its 1400 ms expiry`);
    expect
      .soft(inside, "the failure landed inside the expiry it must cancel")
      .toBeLessThan(1_400);
    await expect(retryInChip(page)).toBeVisible();
    // Past the Saved's own 1.4 s: without the cancellation the earlier
    // timer belongs to this same owner and would take the failure.
    await page.waitForTimeout(2_500);
    await expectChipOn(page, "whisper", /Couldn.t save/);
    await expect(retryInChip(page)).toBeVisible();
  });

  await test.step("an owner's timer clears only that owner's message", async () => {
    await page.route(stepsRoute, (route) =>
      route.request().method() === "POST" ? route.abort() : route.continue(),
    );
    await arrange().click();
    await expectChipOn(page, "whisper", "Saved");
    // Inside the layout's 1.4 s, a recipe failure takes the chip. The
    // layout's timer then fires and must leave it alone.
    await addCentroid().click();
    await expectChipOn(page, "whisper", /Couldn.t save/);
    await page.waitForTimeout(2_000);
    await expectChipOn(page, "whisper", /Couldn.t save/);
    await expect(retryInChip(page)).toBeVisible();
    await page.unroute(stepsRoute);
  });

  await test.step("a repeated timed message from one owner restarts that owner's timer", async () => {
    const next = `${name} two`;
    await renameTo(page, name, next);
    await expectChipOn(page, "whisper", "Saved");
    const armed = Date.now();
    // The second rename's answer is held back, so its own Saved lands
    // well inside the first's 1.4 s rather than 60 ms after it: without
    // a held answer the two deadlines are milliseconds apart and the
    // window this rule lives in cannot be read at all.
    await page.route(nameRoute, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await new Promise((r) => setTimeout(r, 500));
      return route.continue();
    });
    const after = `${name} three`;
    await renameTo(page, next, after);
    name = after;
    await expectChipOn(page, "whisper", "Saved");
    await page.unroute(nameRoute);
    // The first rename's own timer fires 1.4 s after it armed. If the
    // second did not drop it, it takes the second's Saved with it.
    const wait = 1_700 - (Date.now() - armed);
    console.log(`restart: the second Saved landed at +${Date.now() - armed} ms; reading the chip at +1700 ms`);
    if (wait > 0) await page.waitForTimeout(wait);
    expect
      .soft(
        await whisperChip(page).getAttribute("data-on"),
        "the second Saved stands past the first's deadline",
      )
      .toBe("true");
    await expect
      .poll(() => whisperChip(page).getAttribute("data-on"), {
        message: "and still clears on its own",
        timeout: 5_000,
      })
      .toBe(null);
  });

  await test.step("a queued rename shows its refusal after the preceding layout save settles", async () => {
    // The rename waits for the layout response. Component coverage also
    // holds the message against a late success notification from that owner.
    layoutMode = "hold";
    await page.keyboard.press("Escape");
    await arrange().click();
    await expectChipOn(page, "whisper", "Saving…");
    await expect.poll(() => releaseLayout !== null).toBe(true);
    await page.route(nameRoute, (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "internal", message: "The name could not be filed." },
            }),
          })
        : route.continue(),
    );
    await renameTo(page, name, `${name} four`);
    await expectChipOn(page, "whisper", "Saving…");
    const wrote = page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().includes(`/api/recipes/${id}/layout`),
    );
    releaseLayout?.();
    await wrote;
    layoutMode = "pass";
    await expectChipOn(page, "whisper", "The name could not be filed.");
    await page.unroute(nameRoute);
    console.log(`preserved: after the layout success the chip reads ${JSON.stringify(await whisperChip(page).textContent())}`);
    await expectChipOn(page, "whisper", "The name could not be filed.");
    expect
      .soft(
        (await whisperChip(page).textContent()) ?? "",
        "the success did not speak over it",
      )
      .not.toContain("Saved");
    await expect
      .poll(() => whisperChip(page).getAttribute("data-on"), { timeout: 9_000 })
      .toBe(null);
  });

  await test.step("an outstanding recipe-draft failure takes priority over a success, restores its own Retry, and arms no success expiry", async () => {
    // A second node, so a later recipe success can land on one step
    // while the other's draft failure is still outstanding.
    await page.keyboard.press("Escape");
    await canvasPaneOf(page).getByRole("tab", { name: /^Tools/ }).click();
    await addCentroid().click();
    await expectChipOn(page, "whisper", "Saved");
    await expect
      .poll(() => whisperChip(page).getAttribute("data-on"), { timeout: 5_000 })
      .toBe(null);
    const selectNode = async (index: number) => {
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Fit to view" }).click();
      await page.waitForTimeout(400);
      await page.locator("[data-node]").nth(index).locator("[data-v]").first().click();
      const field = page
        .locator("[data-node-panel]")
        .getByRole("textbox", { name: "Dataset name" });
      await expect(field).toBeVisible();
      return field;
    };
    const field = await selectNode(0);
    await page.route(stepRoute, (route) =>
      route.request().method() === "PATCH" ? route.abort() : route.continue(),
    );
    await field.fill(`draft_failure_${runId}`);
    await expectChipOn(page, "whisper", /Couldn.t save/);
    await expect(retryInChip(page)).toBeVisible();
    await page.unroute(stepRoute);

    const wrote = page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().includes(`/api/recipes/${id}/layout`),
    );
    await page.keyboard.press("Escape");
    await arrange().click();
    await wrote;
    // The success is answered by the outstanding draft failure, with its
    // own Retry — and no 1.4 s expiry is armed behind it.
    await expectChipOn(page, "whisper", /Couldn.t save/);
    await expect(retryInChip(page)).toBeVisible();
    await page.waitForTimeout(2_500);
    await expectChipOn(page, "whisper", /Couldn.t save/);
    await expect(retryInChip(page)).toBeVisible();

    // The no-expiry half needs a success of the SAME owner: a layout
    // success arms a layout timer, which the per-owner rule would have
    // discarded anyway, so it cannot tell an armed expiry from none. A
    // recipe success while the other step's draft failure still stands
    // can: an expiry armed here belongs to the owner of the message on
    // screen, and would take its Retry away 1.4 s later.
    const other = await selectNode(1);
    await other.fill(`draft_success_${runId}`);
    await expectChipOn(page, "whisper", /Couldn.t save/);
    await expect(retryInChip(page)).toBeVisible();
    await page.waitForTimeout(2_500);
    await expectChipOn(page, "whisper", /Couldn.t save/);
    await expect(retryInChip(page)).toBeVisible();
  });
});

test("the canvas's bottom notice and its lock pill are untouched, together, in both views", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  await routeHouse(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const id = (
    (await api(page, "POST", "/api/recipes", { name: `Bottom ${runId}` })) as {
      recipe: { id: string };
    }
  ).recipe.id;
  await page.goto(`/workflows/${id}`);
  await expect(page.locator("[data-canvas-stage]")).toBeVisible();
  await canvasPaneOf(page).getByRole("tab", { name: /^Tools/ }).click();
  await canvasPaneOf(page).getByRole("button", { name: "Add Centroid" }).click();
  await expectChipOn(page, "whisper", "Saved");

  let cutLayout = false;
  await page.route(`**/api/recipes/${id}/layout`, (route) =>
    route.request().method() === "PUT" && cutLayout
      ? route.abort()
      : route.continue(),
  );
  const stack = page.locator("[data-canvas-notice-stack]");
  const pill = page.locator("[data-lock-pill]");
  const transient = page.locator("[data-canvas-notice]:not([data-lock-pill])");
  const lockBtn = () => page.locator("[data-lock]");

  for (const view of ["full", "framed"] as const) {
    await test.step(`the ${view} view: the pill's place, wording, stacking, focus and the transient's hold`, async () => {
      if (view === "framed") {
        await page.getByRole("button", { name: "Framed view" }).click();
        await page.waitForTimeout(500);
      }
      await page.keyboard.press("Escape");
      cutLayout = true;
      await page.getByRole("button", { name: "Arrange by dependency" }).click();
      await expectChipOn(page, "whisper", /Couldn.t save/);
      cutLayout = false;

      await lockBtn().click();
      await expect(page.locator("[data-workflow-canvas]")).toHaveAttribute("data-locked", "true");
      await expect(pill).toContainText("Canvas locked. Nothing moves or links until you");
      await expect(pill).toContainText("unlock");

      // The transient above the pill, both inside the stack, the stack
      // at the flow area's foot and centred on it — and the save chip
      // neither in it nor near it.
      await retryInChip(page).click();
      await expect(transient).toContainText("Canvas locked. Unlock to edit.");
      // Named before the geometry is read, so a pill a transient replaced
      // fails as the defect it is rather than as a missing box.
      await expect(pill, `${view}: the pill stays while a transient stands`).toBeVisible();
      const geometry = await page.evaluate(() => {
        const area = document.querySelector("[data-flow-area]")!.getBoundingClientRect();
        const s = document.querySelector("[data-canvas-notice-stack]")!.getBoundingClientRect();
        const p = document.querySelector("[data-lock-pill]")!.getBoundingClientRect();
        const t = document
          .querySelector("[data-canvas-notice]:not([data-lock-pill])")!
          .getBoundingClientRect();
        const chip = document.querySelector("[data-save-status-corner]")!.getBoundingClientRect();
        return {
          offset: (s.left + s.right) / 2 - (area.left + area.right) / 2,
          fromFoot: area.bottom - s.bottom,
          transientAbovePill: p.top - t.bottom,
          chipInStack: document
            .querySelector("[data-canvas-notice-stack]")!
            .contains(document.querySelector("[data-save-status-corner]")),
          chipAbove: s.top - chip.bottom,
        };
      });
      // own offset: in the full view the stack centres on what the pane
      // leaves free, 219 px right of the flow area's middle; in the
      // framed view the flow area IS that free space.
      const wanted = view === "full" ? 219 : 0;
      console.log(`${view}: notice stack ${geometry.offset.toFixed(1)} px off the flow area's middle (expected ${wanted}), ${geometry.fromFoot.toFixed(1)} px off its foot, the transient ${geometry.transientAbovePill.toFixed(1)} px above the pill`);
      expect
        .soft(
          Math.abs(geometry.offset - wanted),
          `${view}: the stack keeps the place gave it`,
        )
        .toBeLessThanOrEqual(2);
      expect.soft(geometry.fromFoot, `${view}: the stack stays at the flow area's foot`).toBeGreaterThan(0);
      expect.soft(geometry.fromFoot, `${view}: and not adrift of it`).toBeLessThan(120);
      expect.soft(geometry.transientAbovePill, `${view}: the transient stands above the pill`).toBeGreaterThanOrEqual(0);
      expect.soft(geometry.chipInStack, `${view}: the save chip is not in the notice stack`).toBe(false);
      expect.soft(geometry.chipAbove, `${view}: the save chip stands well clear above it`).toBeGreaterThan(100);

      // Its own hold, and the pill outliving it.
      await expect
        .poll(() => transient.count(), {
          message: `${view}: the transient clears on its own hold`,
          timeout: 12_000,
        })
        .toBe(0);
      await expect(pill).toBeVisible();

      // The unlock action takes focus and unlocks.
      const unlock = page.locator("[data-lock-pill] [data-unlock]");
      await unlock.focus();
      expect
        .soft(
          await page.evaluate(() => document.activeElement?.getAttribute("data-unlock") !== null),
          `${view}: the unlock action takes keyboard focus`,
        )
        .toBe(true);
      await page.keyboard.press("Enter");
      await expect(page.locator("[data-workflow-canvas]")).not.toHaveAttribute("data-locked", "true");
      await expect(pill).toHaveCount(0);
    });
  }
});

test("the workflow's whisper announces politely from its new home, once", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await routeHouse(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const name = `Announce ${runId}`;
  const id = (
    (await api(page, "POST", "/api/recipes", { name })) as {
      recipe: { id: string };
    }
  ).recipe.id;
  await page.goto(`/workflows/${id}`);
  await expect(page.locator("[data-canvas-stage]")).toBeVisible();
  await renameTo(page, name, `${name} filed`);
  await expectChipOn(page, "whisper", "Saved");
  const regions = await page.evaluate(() => {
    const chip = document.querySelector('[data-save-status="whisper"]');
    return {
      onTheChip: chip?.getAttribute("aria-live") ?? null,
      inTheHeader: document.querySelectorAll("header [aria-live]").length,
      sayingSaved: Array.from(document.querySelectorAll("[aria-live]")).filter(
        (el) => (el.textContent ?? "").includes("Saved"),
      ).length,
    };
  });
  expect.soft(regions.onTheChip, "the whisper still announces politely").toBe("polite");
  expect.soft(regions.inTheHeader, "no live region is left in the header").toBe(0);
  expect.soft(regions.sayingSaved, "exactly one region says it").toBe(1);
});

test("the published view gains no chip and keeps its stack and legend", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const mapId = (
    (await api(page, "POST", "/api/maps", { name: `Published ${runId}` })) as {
      id: string;
    }
  ).id;
  await readThenWriteBrowserSetup(page, `/api/maps/${mapId}`, () => ({ method: "POST", path: `/api/maps/${mapId}/layers`, body: {
    name: "Ground",
    sql: "SELECT 1 AS n, ST_Point(13.4, 52.5) AS geom",
  } }));
  const token = (
    (await readThenWriteBrowserSetup(page, `/api/maps/${mapId}`, () => ({ method: "POST", path: `/api/maps/${mapId}/publish` })).then(result => result.json)) as { token: string }
  ).token;
  await page.goto(`/v/${token}`);
  await expect(page.getByRole("button", { name: "Zoom in" })).toBeVisible({ timeout: 30_000 });
  const seen = await page.evaluate(() => ({
    chips: document.querySelectorAll("[data-save-status]").length,
    corners: document.querySelectorAll("[data-save-status-corner]").length,
    stack: document.querySelectorAll('[class*="stageStack"]').length,
    legend: document.querySelectorAll('[class*="legend"]').length,
  }));
  expect.soft(seen.chips, "the published view has no status chip").toBe(0);
  expect.soft(seen.corners, "and no corner to hold one").toBe(0);
  expect.soft(seen.stack, "its control stack is still composed").toBeGreaterThan(0);
  expect.soft(seen.legend, "and its legend arrangement stands").toBeGreaterThan(0);
});

/** The visual reference's own numbers for the chosen home: a 30 px
 * glass pill with 12 px of side padding
 * and the pill radius, wearing the shipped status voice — 11 px of the UI
 * face at 500, uppercase on the 0.08em track in the warning ink, and the
 * danger tone dropping both for a sentence — entering on the entrance
 * beat rather than the shipped spans' delayed micro fade. */
const faceOfTheChip = (page: Page, kind: string) =>
  page.evaluate((k) => {
    // The box belongs to the one pill; the voice to the channel's line
    // inside it (one chip, a line per channel).
    const chip = document.querySelector("[data-save-status-chip]") as HTMLElement;
    const line = document.querySelector(`[data-save-status="${k}"]`) as HTMLElement;
    if (!chip || !line) throw new Error("no chip or no line");
    const probe = document.createElement("span");
    probe.style.color = "var(--warn)";
    document.body.appendChild(probe);
    const warn = getComputedStyle(probe).color;
    probe.style.color = "var(--danger)";
    const danger = getComputedStyle(probe).color;
    probe.style.background = "color-mix(in srgb, var(--bg-panel) 93%, transparent)";
    const glass = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const s = getComputedStyle(chip);
    const l = getComputedStyle(line);
    const box = chip.getBoundingClientRect();
    return {
      // What the browser actually rounds the corners by: the computed
      // style reports the specified length, clamped at use time to half
      // the shorter side.
      usedRadius: Math.min(
        parseFloat(s.borderTopLeftRadius),
        box.width / 2,
        box.height / 2,
      ),
      boxHeight: box.height,
      height: s.height,
      padding: `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft}`,
      radius: s.borderTopLeftRadius,
      background: s.backgroundColor,
      glass,
      backdrop: s.backdropFilter,
      shadow: s.boxShadow,
      fontSize: l.fontSize,
      fontWeight: l.fontWeight,
      letterSpacing: l.letterSpacing,
      transform: l.textTransform,
      color: l.color,
      lineHeight: l.height,
      warn,
      danger,
      entrance: s.transitionDuration,
      lineEntrance: l.transitionDuration,
    };
  }, kind);

test("the chip wears the reference's face on both surfaces", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const mapId = (
    (await api(page, "POST", "/api/maps", { name: `Face ${runId}` })) as {
      id: string;
    }
  ).id;
  const name = `Face ${runId}`;
  const recipeId = (
    (await api(page, "POST", "/api/recipes", { name })) as {
      recipe: { id: string };
    }
  ).recipe.id;

  const wearsIt = (where: string, face: Awaited<ReturnType<typeof faceOfTheChip>>) => {
    console.log(`${where}: ${face.height} tall, padding ${face.padding}, radius ${face.radius}, ${face.fontSize}/${face.fontWeight} ${face.transform} on ${face.letterSpacing}, ink ${face.color}, entrance ${face.entrance}`);
    expect.soft(face.height, `${where}: the reference's 30 px pill on one line`).toBe("30px");
    expect.soft(face.lineHeight, `${where}: its line filling that band`).toBe("30px");
    expect.soft(face.padding, `${where}: its 12 px of side padding`).toBe("0px 12px 0px 12px");
    // A single band still rounds to a stadium, which is the reference's
    // look: the cap is above half of 30 px, so the browser clamps to it.
    expect
      .soft(face.usedRadius, `${where}: a single band still ends in a stadium`)
      .toBeCloseTo(face.boxHeight / 2, 1);
    expect
      .soft(parseFloat(face.radius), `${where}: and the cap is the card's, not a literal`)
      .toBe(20);
    expect.soft(face.background, `${where}: the glass wash`).toBe(face.glass);
    expect.soft(face.backdrop, `${where}: the glass blur`).toBe("blur(18px)");
    expect.soft(face.shadow, `${where}: the chrome shadow`).not.toBe("none");
    expect.soft(face.fontSize, `${where}: the status size`).toBe("11px");
    expect.soft(face.fontWeight, `${where}: the status weight`).toBe("500");
    // The entrance beat, not the shipped span's delayed micro fade.
    expect.soft(face.entrance, `${where}: the reference's entrance`).toContain("0.22s");
    expect.soft(face.lineEntrance, `${where}: the line arriving on the same beat`).toContain("0.22s");
  };

  await test.step("the builder's saving indication", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(`**/api/maps/${mapId}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      await held;
      return route.continue();
    });
    await page.goto(`/maps/${mapId}`);
    await expect(page.locator("aside[data-builder-pane]")).toBeVisible();
    await page
      .locator('nav[aria-label="Breadcrumb"]')
      .getByRole("button", { name: `Face ${runId}`, exact: true })
      .click();
    const input = page.getByLabel("Map name");
    await input.fill(`Face renamed ${runId}`);
    await input.press("Enter");
    await expectChipOn(page, "saving", "Saving…");
    const face = await faceOfTheChip(page, "saving");
    wearsIt("the builder's chip", face);
    expect
      .soft(face.color, "the builder's chip keeps the warning ink")
      .toBe(face.warn);
    expect
      .soft(face.transform, "and the quiet uppercase identity")
      .toBe("uppercase");
    expect
      .soft(parseFloat(face.letterSpacing), "on the 0.08em track")
      .toBeCloseTo(0.88, 1);
    release();
    // Left registered: the pattern cannot match the canvas's routes, and
    // unrouting while its handler is still continuing the held request
    // throws "Route is already handled".
    await page.waitForTimeout(300);
  });

  await test.step("the workflow's whisper, in both tones", async () => {
    await page.goto(`/workflows/${recipeId}`);
    await expect(page.locator("[data-canvas-stage]")).toBeVisible();
    await renameTo(page, name, `${name} filed`);
    await expectChipOn(page, "whisper", "Saved");
    const plain = await faceOfTheChip(page, "whisper");
    wearsIt("the canvas's chip", plain);
    expect.soft(plain.color, "the plain tone keeps the warning ink").toBe(plain.warn);
    expect.soft(plain.transform, "and the uppercase identity").toBe("uppercase");

    await page.route(`**/api/recipes/${recipeId}`, (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "internal", message: "The name could not be filed." },
            }),
          })
        : route.continue(),
    );
    await renameTo(page, `${name} filed`, `${name} again`);
    await expectChipOn(page, "whisper", "The name could not be filed.");
    const bad = await faceOfTheChip(page, "whisper");
    console.log(`the canvas's chip, danger tone: ink ${bad.color}, ${bad.transform}, track ${bad.letterSpacing}`);
    expect.soft(bad.color, "the danger tone takes the danger ink").toBe(bad.danger);
    expect.soft(bad.transform, "and drops the uppercase for a sentence").toBe("none");
    expect.soft(bad.letterSpacing, "and its track with it").toBe("normal");
    await page.unroute(`**/api/recipes/${recipeId}`);
  });
});

/** The message a long import outcome carries: partial results and the
 * reasons members were skipped (`src/components/upload-settle-notice.ts`,
 * `src/components/skipped-members.ts` compose these). Sent here through
 * the drawing channel's own failure road, which reads the server's words
 * back verbatim, so the length is real and the route is the shipped one. */
const LONG_NOTICE =
  "Added 3 of 5 tables to this map. berlin_restaurants_2024 was skipped: " +
  "its geometry column holds mixed types. tram_stops_extended was skipped: " +
  "no spatial reference could be read from the file.";

test("the builder: a long notice keeps its tail and a fast save keeps its exit", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  await routeHouse(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const name = `Round one ${runId}`;
  const mapId = (
    (await api(page, "POST", "/api/maps", { name })) as { id: string }
  ).id;
  await page.goto(`/maps/${mapId}`);
  await expect(page.locator("aside[data-builder-pane]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Draw", exact: true })).toBeVisible({ timeout: 30_000 });

  await test.step("a notice too long for one line wraps inside the stage; nothing is lost off the edge", async () => {
    await page.route(`**/api/maps/${mapId}/sketches`, (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "internal", message: LONG_NOTICE },
            }),
          })
        : route.continue(),
    );
    const refused = page.waitForResponse((response) =>
      response.request().method() === "POST" && response.url().endsWith(`/api/maps/${mapId}/sketches`),
    );
    await page.getByRole("button", { name: "Draw", exact: true }).click();
    const dock = page.getByRole("toolbar", { name: "Draw tools" });
    await expect(dock).toBeVisible();
    await dock.getByRole("button", { name: "Draw points" }).click();
    await page.mouse.click(700, 300);
    expect((await refused).status()).toBe(500);
    await expectChipOn(page, "notice", "no spatial reference could be read");

    const read = await page.evaluate(() => {
      const line = document.querySelector(
        '[data-save-status="notice"]',
      ) as HTMLElement;
      const chip = document.querySelector("[data-save-status-chip]") as HTMLElement;
      const stage = document.querySelector("[data-drag-canvas]") as HTMLElement;
      const c = chip.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      // A rectangular fit is not legibility:
      // the pill's corners are an `overflow: hidden` boundary that curves
      // INTO the box, so a row can sit inside the rectangle and still
      // lose characters to the curve. Measured against the used radius —
      // the computed style reports what was specified, and the browser
      // clamps it to half the shorter side — row by rendered row.
      const spec = parseFloat(getComputedStyle(chip).borderTopLeftRadius);
      const r = Math.min(spec, c.width / 2, c.height / 2);
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      const rows: DOMRect[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!(n.textContent ?? "").trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        rows.push(...Array.from(range.getClientRects()));
      }
      const eatenAt = (dy: number) =>
        dy < r ? r - Math.sqrt(Math.max(0, r * r - (r - dy) * (r - dy))) : 0;
      let clearance = Infinity;
      for (const q of rows) {
        for (const dy of [q.top - c.top, c.bottom - q.bottom]) {
          const eaten = eatenAt(dy);
          clearance = Math.min(
            clearance,
            q.left - c.left - eaten,
            c.right - q.right - eaten,
          );
        }
      }
      return {
        text: (line.textContent ?? "").trim(),
        clippedBy: line.scrollWidth - line.clientWidth,
        chipClippedBy: chip.scrollWidth - chip.clientWidth,
        height: Math.round(c.height),
        insideBy: s.right - c.right,
        width: Math.round(c.width),
        rows: rows.length,
        usedRadius: r,
        cornerClearance: rows.length > 0 ? clearance : Number.NaN,
      };
    });
    console.log(`long notice: chip ${read.width} x ${read.height} px over ${read.rows} rendered rows, ${read.insideBy.toFixed(1)} px inside the stage's right edge, overflowing its line by ${read.clippedBy} px; used corner radius ${read.usedRadius.toFixed(1)} px, worst row clears the curve by ${read.cornerClearance.toFixed(2)} px`);
    expect
      .soft(read.text, "the whole message is on screen, tail and all")
      .toBe(LONG_NOTICE);
    expect
      .soft(read.clippedBy, "nothing runs past the line's own box")
      .toBeLessThanOrEqual(1);
    expect
      .soft(read.chipClippedBy, "and nothing past the pill's")
      .toBeLessThanOrEqual(1);
    expect
      .soft(read.height, "it wrapped rather than staying on one band")
      .toBeGreaterThan(30);
    expect
      .soft(read.insideBy, "the pill ends inside the stage")
      .toBeGreaterThan(0);
    expect
      .soft(read.rows, "the message really did render on several rows")
      .toBeGreaterThan(1);
    expect
      .soft(
        read.cornerClearance,
        "no rendered row meets the corner's curve, which clips inside the rectangle",
      )
      .toBeGreaterThanOrEqual(0);

    await page.unroute(`**/api/maps/${mapId}/sketches`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("toolbar", { name: "Draw tools" })).toBeHidden();
  });

  await test.step("a fast save: the words outlive the counter, so the chip closes on something legible", async () => {
    // Sampled per frame, as GEOMETRY. The
    // round-1 proof watched mutations and so measured whether the words
    // were retained in the DOM, which a collapsed `overflow: hidden` box
    // clips without touching the DOM at all — a check that could not
    // have caught the very defect it was written for. What is read here
    // is the box the words stand in and whether it is on screen.
    await page.evaluate(() => {
      const el = document.querySelector('[data-save-status="saving"]')!;
      const w = window as unknown as {
        __exit: { t: number; on: boolean; h: number; vis: string; op: number; text: string }[];
      };
      w.__exit = [];
      const start = performance.now();
      const tick = () => {
        const style = getComputedStyle(el);
        w.__exit.push({
          t: performance.now() - start,
          on: el.hasAttribute("data-on"),
          h: el.getBoundingClientRect().height,
          vis: style.visibility,
          op: parseFloat(style.opacity),
          text: (el.textContent ?? "").trim(),
        });
        if (performance.now() - start < 3_000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    // A real, unheld tracked write: it settles in tens of milliseconds,
    // which is the case that flashed.
    await page
      .locator('nav[aria-label="Breadcrumb"]')
      .getByRole("button", { name, exact: true })
      .click();
    const input = page.getByLabel("Map name");
    await input.fill(`${name} filed`);
    await input.press("Enter");
    await expect
      .poll(() => chipOf(page, "saving").getAttribute("data-on"), {
        message: "the write settles",
        timeout: 20_000,
      })
      .toBe(null);
    await page.waitForTimeout(3_200);

    const trace = await page.evaluate(
      () =>
        (
          window as unknown as {
            __exit: { t: number; on: boolean; h: number; vis: string; op: number; text: string }[];
          }
        ).__exit,
    );
    // On screen: the words are there, they have a box to stand in, and
    // that box is painted. A retained string in a zero-height
    // `overflow: hidden` box is none of these.
    //
    // Opacity is deliberately NOT part of this. The fade curve is the
    // header span's own and unchanged by this piece — a browser shortens
    // a transition reversed mid-flight, so a short save's fade is short —
    // and folding it in would make the check measure how long the write
    // took rather than whether the box outlived it. It is logged instead.
    const onScreen = (s: (typeof trace)[number]) =>
      s.text === "Saving…" && s.h >= 20 && s.vis === "visible";
    const shown = trace.findIndex((s) => s.on && onScreen(s));
    const off = trace.findIndex((s, i) => i > shown && shown >= 0 && !s.on);
    let last = -1;
    for (let i = trace.length - 1; i > off && off >= 0; i--) {
      if (onScreen(trace[i])) {
        last = i;
        break;
      }
    }
    const held = last >= 0 && off >= 0 ? trace[last].t - trace[off].t : 0;
    console.log(
      `fast save: ${trace.length} frames; on screen from frame ${shown}, marked off at frame ${off} (${off >= 0 ? Math.round(trace[off].t) : "-"} ms), last frame still on screen ${last} — ${Math.round(held)} ms of readable exit, the box ${off >= 0 ? trace[off].h.toFixed(1) : "-"} px tall when the counter settled, opacity ${off >= 0 ? trace[off].op.toFixed(2) : "-"} there and ${last >= 0 ? trace[last].op.toFixed(2) : "-"} at the last frame`,
    );
    console.log(
      "fast save, the trace's own shape:" +
        JSON.stringify(
          trace
            .filter(
              (s, i) =>
                i === 0 ||
                s.on !== trace[i - 1].on ||
                s.text !== trace[i - 1].text ||
                Math.round(s.h) !== Math.round(trace[i - 1].h) ||
                s.vis !== trace[i - 1].vis,
            )
            .slice(0, 12)
            .map((s) => ({ t: Math.round(s.t), on: s.on, h: Math.round(s.h), vis: s.vis, op: Number(s.op.toFixed(2)), text: s.text })),
        ),
    );
    expect
      .soft(shown, "the saving indication was on screen at all (the trace can see one)")
      .toBeGreaterThanOrEqual(0);
    expect
      .soft(off, "and was marked off when its counter settled")
      .toBeGreaterThan(shown);
    expect
      .soft(off >= 0 ? trace[off].h : 0, "with its box still standing at that moment")
      .toBeGreaterThanOrEqual(20);
    expect
      .soft(held, "the exit stays on screen long enough to read, as the header span's did")
      .toBeGreaterThanOrEqual(300);
    // And it does end: a box that never closes is a different defect.
    expect
      .soft(
        trace.length > 0 ? onScreen(trace[trace.length - 1]) : true,
        "and the chip does close in the end",
      )
      .toBe(false);
    // The resting box is a box of nothing: a collapsed line that keeps a
    // padding band leaves the pill standing invisibly over the map.
    expect
      .soft(
        trace.length > 0 ? trace[trace.length - 1].h : 1,
        "and closes to nothing, not to a band of padding",
      )
      .toBeLessThanOrEqual(0.5);
  });
});
