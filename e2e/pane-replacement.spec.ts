// The assistant pane and its replacement contract with Tools (revised by,
// which put the pane right of the stage: the two helpers now sit on
// opposite sides, a replacement moves both edges together as one commit,
// and the pane is a working surface rather than a popover, so an outside
// pointer leaves it open).
//
// Everything is measured — boxes, committed stage edges, live focus —
// never read from a pane's own flag. The contracts: the assistant's door
// is a top-bar control (the stage stack carries none); the pane mirrors
// the Tools drawer's size on the stage's other side; opening either pane
// while the other is open leaves exactly one visible, moves both edges in
// one commit, and leaves focus on the pressed control; the pane dismisses
// by close control, toggle and Escape from inside (focus back to the
// trigger), and an outside pointer leaves it open; a reload brings the
// pane back closed with the stage undisplaced, and its door opens it
// again at the same displaced edge.
//
// Environment: the documented gate (isolated server, fresh data dir).
// Run with DEZFIL_BASE_URL at the server.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import { addLayer, createMap, seedFile, trackConsole } from "./support";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const runId = Date.now().toString(36);
const stations = `pane_${runId}`;

const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 1100, height: 860 };

const PANE = "[data-assistant-pane]";
const DRAWER = "[data-recipe-drawer]";
const TOOLS_DOOR = "[data-tools-control]";
const STAGE = "[data-map-layer]";
/** The visible stage window — the element `--stage-left` actually moves;
 * the map layer itself is inset-0 and its box proves nothing. */
const STAGE_WINDOW = "[data-drag-canvas]";
const trigger = (page: Page) =>
  page
    .locator("header")
    .getByRole("button", { name: /Open assistant|Close assistant/ });

async function boxOf(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  expect(box, `${selector} has a box`).not.toBeNull();
  return box!;
}

/** Wait until an element's box has stopped moving, and return it. */
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

async function seedMap(page: Page): Promise<string> {
  await page.goto("/maps");
  await seedFile(
    page,
    `${stations}.geojson`,
    readFileSync(path.join(FIXTURES_DIR, "stations.geojson"), "utf8"),
    "application/geo+json",
  );
  const mapId = await createMap(page, `pane ${runId}`);
  await addLayer(page, mapId, stations, `SELECT * FROM ${stations}`);
  return mapId;
}

/** Arm the committed-edge counter (the number handed to the camera). */
async function armEdgeCommits(page: Page) {
  await page.waitForSelector(STAGE);
  await page.evaluate(() => {
    const target = document.querySelector("[data-map-layer]")!;
    const window_ = window as unknown as { __edgeCommits: number };
    window_.__edgeCommits = 0;
    new MutationObserver((records) => {
      window_.__edgeCommits += records.length;
    }).observe(target, {
      attributes: true,
      attributeFilter: ["data-stage-edge"],
    });
  });
}

const commits = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __edgeCommits: number }).__edgeCommits,
  );

test.use({ viewport: WIDE });

test("the assistant's door is the top bar's; the stage stack carries none", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);
  await page.waitForSelector(STAGE);

  await expect(trigger(page)).toBeVisible();
  expect(
    await page
      .locator('[class*="stageStack"]')
      .getByRole("button", { name: /assistant/i })
      .count(),
  ).toBe(0);

  // The door sits in the ordered action group where Fit to data stood:
  // after Redo, before Preview.
  const names = await page
    .locator("header button, header a")
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute("aria-label") ?? el.textContent ?? ""),
    );
  const redoAt = names.findIndex((n) => n === "Redo");
  expect(redoAt).toBeGreaterThanOrEqual(0);
  expect(names[redoAt + 1]).toMatch(/Open assistant|Close assistant/);

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("the pane mirrors the Tools slot on the stage's other side: equal size, and a swap moves both edges as one commit", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);
  await armEdgeCommits(page);

  // Tools open: the drawer's settled box and one edge commit.
  await page.locator(TOOLS_DOOR).click();
  await expect(page.locator(DRAWER)).toBeVisible();
  const drawerBox = await settledBox(page, DRAWER);
  const toolsWindow = await settledBox(page, STAGE_WINDOW);
  await expect.poll(() => commits(page)).toBe(1);

  // Swap to the assistant: exactly one pane, the drawer's size and top at
  // the screen's right gutter, and both stage edges moved in one commit.
  await trigger(page).click();
  await expect(page.locator(PANE)).toBeVisible();
  expect(await page.locator(DRAWER).count()).toBe(0);
  const paneBox = await settledBox(page, PANE);
  expect(Math.round(paneBox.x + paneBox.width)).toBe(WIDE.width - 14);
  expect(Math.round(paneBox.y)).toBe(Math.round(drawerBox.y));
  expect(Math.round(paneBox.width)).toBe(Math.round(drawerBox.width));
  expect(Math.round(paneBox.height)).toBe(Math.round(drawerBox.height));
  const paneWindow = await settledBox(page, STAGE_WINDOW);
  expect(Math.round(paneWindow.x)).toBe(Math.round(toolsWindow.x) - 354);
  expect(Math.round(paneWindow.x + paneWindow.width)).toBe(Math.round(toolsWindow.x + toolsWindow.width) - 354);
  await page.waitForTimeout(600);
  expect(await commits(page), "a replacement is one commit").toBe(2);

  // Focus stayed on the pressed control, not the replaced pane's opener.
  await expect(trigger(page)).toBeFocused();

  // Swap back: Tools returns, the pane hides, both edges back in one commit.
  await page.locator(TOOLS_DOOR).click();
  await expect(page.locator(DRAWER)).toBeVisible();
  await expect(page.locator(PANE)).toHaveAttribute("data-open", "false");
  await page.waitForTimeout(600);
  expect(await commits(page), "the swap back is one commit").toBe(3);
  // Focus followed the activation — into the newly opened Tools (whose
  // catalog focuses its own search, its established open behaviour) —
  // and was NOT yanked to the replaced pane's trigger.
  const focusAfterSwapBack = await page.evaluate(() => {
    const active = document.activeElement;
    return {
      inDrawer:
        document
          .querySelector("[data-recipe-drawer]")
          ?.contains(active) === true ||
        document.querySelector("[data-tools-control]") === active,
      onAssistantTrigger:
        active?.getAttribute("aria-label")?.includes("assistant") === true,
    };
  });
  expect(focusAfterSwapBack.inDrawer).toBe(true);
  expect(focusAfterSwapBack.onAssistantTrigger).toBe(false);

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("the pane dismisses by its close control, by Escape from inside with focus return, and by its toggle; an outside pointer leaves it open; it reloads closed", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);
  await page.waitForSelector(STAGE);

  // Open, then the pane's own close control.
  await test.step("close control", async () => {});
  await trigger(page).click();
  await expect(page.locator(PANE)).toHaveAttribute("data-open", "true");
  await page.locator(`${PANE} [aria-label="Close assistant"]`).click();
  await expect(page.locator(PANE)).toHaveAttribute("data-open", "false");

  await test.step("escape", async () => {});
  // Escape with focus inside the pane closes it and returns focus to the
  // trigger (heard only from inside).
  await trigger(page).click();
  await expect(page.locator(PANE)).toHaveAttribute("data-open", "true");
  await page.locator(PANE).getByRole("textbox", { name: "Ask the assistant" }).focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(PANE)).toHaveAttribute("data-open", "false");
  await expect(trigger(page)).toBeFocused();

  await test.step("outside pointer", async () => {});
  // An outside pointer leaves the pane open (answer to its: the pane is a
  // working surface, not a popover). Probed on the workspace rail's quiet
  // middle.
  await trigger(page).click();
  await expect(page.locator(PANE)).toHaveAttribute("data-open", "true");
  const rail = await boxOf(page, 'nav[aria-label="Product navigation"]');
  await page.mouse.click(rail.x + 27, rail.y + rail.height * 0.55);
  await page.waitForTimeout(150);
  await expect(page.locator(PANE)).toHaveAttribute("data-open", "true");
  await trigger(page).click();
  await expect(page.locator(PANE)).toHaveAttribute("data-open", "false");

  // Toggle dismissal: the trigger closes an
  // open pane, not merely opens a closed one.
  await trigger(page).click();
  await expect(page.locator(PANE)).toHaveAttribute("data-open", "true");
  await trigger(page).click();
  await expect(page.locator(PANE)).toHaveAttribute("data-open", "false");

  // Reloaded closed: the pane comes back shut
  // and the stage back at its resting edge; the door opens it again at the
  // same displaced edge, measured on the visible stage window, which is
  // what displacement actually moves (the right edge).
  const resting = await settledBox(page, STAGE_WINDOW);
  await trigger(page).click();
  await expect(page.locator(PANE)).toHaveAttribute("data-open", "true");
  const displaced = await settledBox(page, STAGE_WINDOW);
  expect(Math.round(displaced.x + displaced.width)).toBe(WIDE.width - 14 - 354);
  await page.reload();
  await page.waitForSelector(STAGE);
  await expect(page.locator(PANE)).toHaveAttribute("data-open", "false");
  const reloaded = await settledBox(page, STAGE_WINDOW);
  expect(Math.round(reloaded.x)).toBe(Math.round(resting.x));
  expect(Math.round(reloaded.x + reloaded.width)).toBe(Math.round(resting.x + resting.width));
  await trigger(page).click();
  await expect(page.locator(PANE)).toHaveAttribute("data-open", "true");
  const reopened = await settledBox(page, STAGE_WINDOW);
  expect(Math.round(reopened.x)).toBe(Math.round(displaced.x));
  expect(Math.round(reopened.x + reopened.width)).toBe(Math.round(displaced.x + displaced.width));

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("below the breakpoint the pane overlays: the stage keeps its width", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  const mapId = await seedMap(page);
  await page.setViewportSize(NARROW);
  await page.goto(`/maps/${mapId}`);
  await page.waitForSelector(STAGE);

  const before = await settledBox(page, STAGE_WINDOW);
  await trigger(page).click();
  await expect(page.locator(PANE)).toHaveAttribute("data-open", "true");
  await expect(page.locator(PANE)).toHaveAttribute("data-overlay", "true");
  const after = await settledBox(page, STAGE_WINDOW);
  expect(Math.round(after.x)).toBe(Math.round(before.x));
  expect(Math.round(after.width)).toBe(Math.round(before.width));

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

// From a field round: the pane headers' underline sits on
// the same viewport line as the inspector tab strip's. Measured from the
// rendered boxes — the bordered elements' bottoms — never from the CSS
// numbers that produce them. ("like Layers"): the same headers' titles
// read in the strip's register — the active tab's computed size, weight
// and family — measured the same way, never from the tokens.
test("the Tools and Assistant headers' underline aligns with the inspector tab strip's, and their titles read in its register", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);
  await page.waitForSelector(STAGE);

  // The inspector strip carries its own border (the rail passes its
  // bordered class into the kit Tabs), so the strip's box bottom IS the
  // underline's lower edge. The rail settles in through an entrance
  // animation, so the reading waits for two identical samples.
  const strip = page.getByRole("tablist", { name: "Builder panels" });
  let stripBottom = NaN;
  await expect
    .poll(async () => {
      const a = await strip.evaluate((s) => s.getBoundingClientRect().bottom);
      await page.waitForTimeout(150);
      const b = await strip.evaluate((s) => s.getBoundingClientRect().bottom);
      if (a === b) stripBottom = b;
      return a === b;
    })
    .toBe(true);

  const headBottom = (scope: string, name: string) =>
    page
      .locator(scope)
      .getByRole("heading", { name })
      .evaluate((h) => h.parentElement!.getBoundingClientRect().bottom);
  const register = (el: Element) => {
    const s = getComputedStyle(el);
    return { size: s.fontSize, weight: s.fontWeight, family: s.fontFamily };
  };
  const headRegister = (scope: string, name: string) =>
    page.locator(scope).getByRole("heading", { name }).evaluate(register);
  const stripRegister = await strip
    .locator('[role="tab"][aria-selected="true"]')
    .evaluate(register);

  await page.locator(TOOLS_DOOR).click();
  await expect(page.locator(DRAWER)).toBeVisible();
  const toolsBottom = await headBottom(DRAWER, "Tools");
  expect(
    Math.abs(toolsBottom - stripBottom),
    `Tools header underline at ${toolsBottom}, strip at ${stripBottom}`,
  ).toBeLessThanOrEqual(0.5);
  expect(await headRegister(DRAWER, "Tools"), "the Tools title's register").toEqual(stripRegister);

  await trigger(page).click();
  await expect(page.locator(PANE)).toBeVisible();
  const paneBottom = await headBottom(PANE, "Assistant");
  expect(
    Math.abs(paneBottom - stripBottom),
    `Assistant header underline at ${paneBottom}, strip at ${stripBottom}`,
  ).toBeLessThanOrEqual(0.5);
  expect(await headRegister(PANE, "Assistant"), "the Assistant title's register").toEqual(stripRegister);

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

// The drawer header as a two-segment path ------------------------
//
// The Tools drawer's header is the inspector strip's look with a path's
// semantics: the word Tools and the open tool's name side by side, the
// open one underlined and in the accent, Tools quiet and pressable as the
// way back. Everything below is measured from rendered boxes and computed
// styles — the underline is the segment's own ::after, read the way the
// alignment step above reads the strip's — never from the stylesheet's
// numbers. The chosen arrangement is row C with the glyph on.

/** A segment's underline, read from its ::after: its height (0 where the
 * segment draws none), its colour, and where its lower edge sits in the
 * viewport. */
const underlineOf = (el: Element) => {
  const after = getComputedStyle(el, "::after");
  const height = after.content === "none" ? 0 : parseFloat(after.height) || 0;
  const rect = el.getBoundingClientRect();
  return {
    height,
    color: after.backgroundColor,
    bottom: rect.bottom - (parseFloat(after.bottom) || 0),
  };
};

const registerOf = (el: Element) => {
  const s = getComputedStyle(el);
  return { color: s.color, weight: s.fontWeight, size: s.fontSize, family: s.fontFamily };
};

/** The inspector strip once its entrance animation has settled: two
 * identical readings of its active tab's box. */
async function settledStrip(page: Page) {
  const strip = page.getByRole("tablist", { name: "Builder panels" });
  const active = strip.locator('[role="tab"][aria-selected="true"]');
  let last = "";
  await expect
    .poll(async () => {
      const box = await active.boundingBox();
      const now = box ? `${box.y}:${box.height}` : "";
      const stable = now !== "" && now === last;
      last = now;
      return stable;
    })
    .toBe(true);
  return { strip, active, inactive: strip.locator('[role="tab"][aria-selected="false"]').first() };
}

test("with a tool open the drawer header is two segments — Tools quiet and pressable, the name underlined on the strip's line", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);
  await page.waitForSelector(STAGE);
  const { active, inactive } = await settledStrip(page);
  const stripUnderline = await active.evaluate(underlineOf);
  const activeRegister = await active.evaluate(registerOf);
  const inactiveRegister = await inactive.evaluate(registerOf);

  await page.locator(TOOLS_DOOR).click();
  const drawer = page.locator(DRAWER);
  await expect(drawer).toBeVisible();

  await test.step("the list face: one segment, Tools, underlined; no return", async () => {
    const title = drawer.getByRole("heading", { name: "Tools" });
    await expect(title).toBeVisible();
    expect(await drawer.getByRole("button", { name: "Back to the tools" }).count()).toBe(0);
    const underline = await title.evaluate(underlineOf);
    expect(underline.height, "the list face's Tools segment carries the underline").toBe(2);
    expect(underline.color).toBe(stripUnderline.color);
    expect(
      Math.abs(underline.bottom - stripUnderline.bottom),
      `Tools underline at ${underline.bottom}, the strip's at ${stripUnderline.bottom}`,
    ).toBeLessThanOrEqual(0.5);
  });

  await drawer.locator("[data-operation='buffer']").click();
  await expect(drawer.locator("[data-parameter-form]")).toBeVisible();
  const back = drawer.getByRole("button", { name: "Back to the tools" });
  const title = drawer.getByRole("heading", { name: "Buffer" });

  await test.step("two segments side by side: the word Tools, then the name", async () => {
    // Against main the return is an icon-only control: no visible word.
    await expect(back).toHaveText("Tools");
    await expect(title).toBeVisible();
    const backBox = (await back.boundingBox())!;
    const titleBox = (await title.boundingBox())!;
    expect(backBox.x + backBox.width, "Tools sits left of the name").toBeLessThanOrEqual(titleBox.x + 0.5);
    expect(
      Math.abs(backBox.y + backBox.height - (titleBox.y + titleBox.height)),
      "the two segments share one baseline row",
    ).toBeLessThanOrEqual(0.5);
  });

  await test.step("the name carries the underline, on the strip's line; Tools draws none", async () => {
    const underline = await title.evaluate(underlineOf);
    expect(underline.height, "the open tool's segment carries the underline").toBe(2);
    expect(underline.color).toBe(stripUnderline.color);
    expect(
      Math.abs(underline.bottom - stripUnderline.bottom),
      `name underline at ${underline.bottom}, the strip's at ${stripUnderline.bottom}`,
    ).toBeLessThanOrEqual(0.5);
    expect((await back.evaluate(underlineOf)).height, "Tools draws no underline").toBe(0);
  });

  await test.step("the registers: the name reads as the strip's active tab, Tools as a resting one", async () => {
    expect(await title.evaluate(registerOf)).toEqual(activeRegister);
    const quiet = await back.evaluate(registerOf);
    expect(quiet.color, "Tools is quiet: the resting tab's colour").toBe(inactiveRegister.color);
    expect(quiet.weight).toBe(inactiveRegister.weight);
    expect(quiet.size).toBe(inactiveRegister.size);
  });

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("the header is a path, not a tab strip — the name is a heading and no control, the line holds on the tool's face, the assistant's header is unchanged", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);
  await page.waitForSelector(STAGE);
  const { active } = await settledStrip(page);
  const stripBottom = await active.evaluate((t) => t.parentElement!.getBoundingClientRect().bottom);

  await page.locator(TOOLS_DOOR).click();
  const drawer = page.locator(DRAWER);
  await expect(drawer).toBeVisible();
  await drawer.locator("[data-operation='buffer']").click();
  await expect(drawer.locator("[data-parameter-form]")).toBeVisible();

  await test.step("nothing in the drawer is exposed as a tab or a tablist", async () => {
    expect(await drawer.getByRole("tab").count()).toBe(0);
    expect(await drawer.getByRole("tablist").count()).toBe(0);
  });

  const title = drawer.getByRole("heading", { name: "Buffer" });
  await test.step("the tool's segment says where you are: a heading, reachable as no control", async () => {
    const shape = await title.evaluate((h) => ({
      role: h.getAttribute("role"),
      tabIndex: (h as HTMLElement).tabIndex,
      insideControl: h.closest("button, a, [role='button'], [role='tab'], [role='link']") !== null,
    }));
    expect(shape).toEqual({ role: null, tabIndex: -1, insideControl: false });
    // Pressing it changes nothing: the form is still the face.
    await title.click();
    await expect(drawer.locator("[data-parameter-form]")).toBeVisible();
    await expect(title).toBeVisible();
  });

  await test.step("the header's line holds on the tool's face too", async () => {
    const headBottom = await title.evaluate((h) => h.parentElement!.getBoundingClientRect().bottom);
    expect(
      Math.abs(headBottom - stripBottom),
      `tool-face header underline at ${headBottom}, strip at ${stripBottom}`,
    ).toBeLessThanOrEqual(0.5);
  });

  await test.step("the assistant pane's header: its own title, no return, its own dismiss", async () => {
    await trigger(page).click();
    const pane = page.locator(PANE);
    await expect(pane).toBeVisible();
    const paneTitle = pane.getByRole("heading", { name: "Assistant" });
    await expect(paneTitle).toBeVisible();
    expect(await pane.getByRole("button", { name: "Back to the tools" }).count()).toBe(0);
    expect(await pane.getByRole("tab").count()).toBe(0);
    // The header row carries the title and nothing else in words.
    expect(await paneTitle.evaluate((h) => h.parentElement!.textContent)).toBe("Assistant");
    await expect(pane.locator('[aria-label="Close assistant"]')).toBeVisible();
    expect(await pane.locator("[data-drawer-dismiss]").count()).toBe(0);
  });

  await test.step("the assistant's title keeps the presentation it had: no segment box, no underline, centred in a 12px-padded row", async () => {
    // words and roles cannot see a styling
    // change, so this reads the properties the segment styling touches.
    // The numbers are main's, the presentation: the row centres its
    // children with an 8px gap inside 12px side padding; the title has
    // no padding, no fixed height and no:after, and spans to the
    // dismissal, which is itself centred in the row.
    const pane = page.locator(PANE);
    const paneTitle = pane.getByRole("heading", { name: "Assistant" });
    const dismiss = pane.locator('[aria-label="Close assistant"]');
    const read = await paneTitle.evaluate((h) => {
      const head = h.parentElement!;
      const hs = getComputedStyle(head);
      const ts = getComputedStyle(h);
      const after = getComputedStyle(h, "::after");
      const centre = (r: DOMRect) => r.y + r.height / 2;
      const headRect = head.getBoundingClientRect();
      const titleRect = h.getBoundingClientRect();
      return {
        headAlign: hs.alignItems,
        headGap: hs.gap,
        headPadding: hs.paddingLeft,
        titlePadding: ts.paddingLeft,
        titleFixedHeight: ts.height === "36px",
        underline: after.content === "none" ? 0 : parseFloat(after.height) || 0,
        titleCentreOffset: Math.abs(centre(titleRect) - centre(headRect)),
      };
    });
    expect(read).toEqual({
      headAlign: "center",
      headGap: "8px",
      headPadding: "12px",
      titlePadding: "0px",
      titleFixedHeight: false,
      underline: 0,
      titleCentreOffset: expect.any(Number),
    });
    expect(read.titleCentreOffset, "the title sits centred in the row").toBeLessThanOrEqual(0.5);
    const headBox = await paneTitle.evaluate((h) => {
      const r = h.parentElement!.getBoundingClientRect();
      return { y: r.y, height: r.height };
    });
    const titleBox = (await paneTitle.boundingBox())!;
    const dismissBox = (await dismiss.boundingBox())!;
    expect(
      Math.abs(dismissBox.y + dismissBox.height / 2 - (headBox.y + headBox.height / 2)),
      "the dismissal is centred in the row",
    ).toBeLessThanOrEqual(0.5);
    expect(
      dismissBox.x - (titleBox.x + titleBox.width),
      "the title spans to the dismissal across the 8px gap",
    ).toBeCloseTo(8, 0);
  });

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("the tool's glyph precedes its name in its group's hue, hidden from assistive technology, the heading's name unchanged", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);
  await page.waitForSelector(STAGE);

  await page.locator(TOOLS_DOOR).click();
  const drawer = page.locator(DRAWER);
  await expect(drawer).toBeVisible();
  // The list face names no tool, so it draws no glyph.
  expect(await drawer.locator("[data-face-glyph]").count()).toBe(0);

  await drawer.locator("[data-operation='buffer']").click();
  await expect(drawer.locator("[data-parameter-form]")).toBeVisible();
  const title = drawer.getByRole("heading", { name: "Buffer" });
  const glyph = title.locator("[data-face-glyph]");

  await test.step("one glyph inside the name's segment, before the word, hidden from assistive technology", async () => {
    // Against main the segment carries no glyph at all.
    await expect(glyph).toHaveCount(1);
    await expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(await glyph.locator("svg").count()).toBe(1);
    const glyphBox = (await glyph.boundingBox())!;
    const wordBox = (await title.locator("[data-face-name]").boundingBox())!;
    expect(glyphBox.width).toBeGreaterThan(0);
    expect(glyphBox.x + glyphBox.width, "the glyph sits before the word").toBeLessThanOrEqual(wordBox.x + 0.5);
    // Part of the segment that says where you are: no control around it.
    expect(
      await glyph.evaluate((g) => g.closest("button, a, [role='button']") !== null),
    ).toBe(false);
  });

  await test.step("its colour is the group's hue, not the title's accent", async () => {
    // Buffer files under Proximity; the hue is the same token the
    // catalog's rows draw with, resolved through a probe so the
    // comparison is between two computed colours.
    await expect(glyph).toHaveAttribute("data-grp", "Proximity");
    const colours = await glyph.evaluate((g) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--grp-proximity)";
      document.body.append(probe);
      const hue = getComputedStyle(probe).color;
      probe.remove();
      return {
        glyph: getComputedStyle(g).color,
        hue,
        title: getComputedStyle(g.parentElement!).color,
      };
    });
    expect(colours.glyph).toBe(colours.hue);
    expect(colours.glyph).not.toBe(colours.title);
  });

  await test.step("the heading's accessible name is the tool's name alone", async () => {
    await expect(title).toHaveAccessibleName("Buffer");
  });

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("Tools is the way back — by pointer and by keyboard — and its name says so", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);
  await page.waitForSelector(STAGE);

  await page.locator(TOOLS_DOOR).click();
  const drawer = page.locator(DRAWER);
  await expect(drawer).toBeVisible();
  const picker = drawer.locator("[data-operation-picker]");
  const form = drawer.locator("[data-parameter-form]");
  const openBuffer = async () => {
    await drawer.locator("[data-operation='buffer']").click();
    await expect(form).toBeVisible();
    await expect(picker).toHaveCount(0);
  };
  const back = drawer.getByRole("button", { name: "Back to the tools" });
  const focusInDrawer = () =>
    page.evaluate(() =>
      document.querySelector("[data-recipe-drawer]")?.contains(document.activeElement) === true,
    );

  await openBuffer();
  await test.step("the control is the word Tools, and its accessible name says where it goes", async () => {
    await expect(back).toHaveText("Tools");
    await expect(back).toHaveAccessibleName("Back to the tools");
  });

  await test.step("by pointer: the list face returns, and focus stays in the drawer", async () => {
    await back.click();
    await expect(picker).toBeVisible();
    await expect(form).toHaveCount(0);
    await expect(drawer.getByRole("heading", { name: "Tools" })).toBeVisible();
    expect(await back.count(), "the list face has no return").toBe(0);
    expect(await focusInDrawer(), "focus was not dropped with the pressed control").toBe(true);
  });

  await openBuffer();
  await test.step("by keyboard: Tools is in the tab order beside the dismissal, and Enter returns", async () => {
    await drawer.locator("[data-drawer-dismiss]").focus();
    await page.keyboard.press("Shift+Tab");
    await expect(back).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(picker).toBeVisible();
    await expect(form).toHaveCount(0);
    expect(await focusInDrawer()).toBe(true);
  });

  await openBuffer();
  await test.step("by keyboard: Space returns as well", async () => {
    await drawer.locator("[data-drawer-dismiss]").focus();
    await page.keyboard.press("Shift+Tab");
    await expect(back).toBeFocused();
    await page.keyboard.press("Space");
    await expect(picker).toBeVisible();
    await expect(form).toHaveCount(0);
  });

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("a long tool name truncates — Tools, the glyph and the dismissal stay visible; Tools and the dismissal pressable, the glyph not", async ({
  page,
}) => {
  const consoleErrors = trackConsole(page);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);
  await page.waitForSelector(STAGE);

  await page.locator(TOOLS_DOOR).click();
  const drawer = page.locator(DRAWER);
  await expect(drawer).toBeVisible();
  // The catalog's longest verb; a disabled row fails here loudly rather
  // than letting the case pass on a shorter name.
  const LONG = "Hotspot analysis (Getis-Ord Gi*)";
  const row = drawer.locator("[data-operation='hotspot']");
  await expect(row).toBeEnabled();
  await row.click();
  await expect(drawer.locator("[data-parameter-form]")).toBeVisible();

  const title = drawer.getByRole("heading", { name: LONG });
  const word = title.locator("[data-face-name]");
  const glyph = title.locator("[data-face-glyph]");
  const back = drawer.getByRole("button", { name: "Back to the tools" });
  const dismiss = drawer.locator("[data-drawer-dismiss]");
  const drawerBox = await settledBox(page, DRAWER);
  const inside = (box: { x: number; width: number }, what: string) => {
    expect(box.x, `${what} starts inside the card`).toBeGreaterThanOrEqual(drawerBox.x - 0.5);
    expect(box.x + box.width, `${what} ends inside the card`).toBeLessThanOrEqual(
      drawerBox.x + drawerBox.width + 0.5,
    );
  };
  /** What a pointer at the element's centre would land on: whether it
   * lands at all, whether on the element itself, and whether inside any
   * control. Runs in the page. */
  const hitAtCentre = (el: Element) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      lands: hit !== null,
      self: hit !== null && (hit === el || el.contains(hit)),
      inControl: hit !== null && hit.closest("button, a, [role='button']") !== null,
    };
  };

  await test.step("the name is cut with an ellipsis, not the row", async () => {
    await expect(title).toHaveAccessibleName(LONG);
    const cut = await word.evaluate((w) => ({
      overflowing: w.scrollWidth > w.clientWidth,
      ellipsis: getComputedStyle(w).textOverflow,
    }));
    expect(cut, "the word overflows its box and is drawn with an ellipsis").toEqual({
      overflowing: true,
      ellipsis: "ellipsis",
    });
    const headHeight = await title.evaluate((h) => h.parentElement!.getBoundingClientRect().height);
    expect(headHeight, "the header keeps its one row").toBe(46);
  });

  await test.step("Tools, the glyph and the dismissal are all still visible inside the card", async () => {
    for (const [el, what] of [
      [back, "Tools"],
      [glyph, "the glyph"],
      [dismiss, "the dismissal"],
    ] as const) {
      await expect(el, what).toBeVisible();
      inside((await el.boundingBox())!, what);
    }
    const titleBox = (await title.boundingBox())!;
    const dismissBox = (await dismiss.boundingBox())!;
    expect(titleBox.x + titleBox.width, "the name stops before the dismissal").toBeLessThanOrEqual(
      dismissBox.x + 0.5,
    );
  });

  await test.step("Tools and the dismissal are pressable; the glyph is not", async () => {
    await expect(back).toBeEnabled();
    await expect(dismiss).toBeEnabled();
    expect(await back.evaluate(hitAtCentre)).toEqual({ lands: true, self: true, inControl: true });
    expect(await dismiss.evaluate(hitAtCentre)).toEqual({ lands: true, self: true, inControl: true });
    expect(await glyph.evaluate(hitAtCentre)).toEqual({ lands: true, self: true, inControl: false });
  });

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});
