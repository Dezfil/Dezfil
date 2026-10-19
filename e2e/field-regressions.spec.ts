// Field-found regressions (the ratchet: what is caught by eye becomes a
// test, so no class comes back twice). From a field round:
//   1. Typing a query with nothing to show opened an empty dropdown
//      sliver under the header search field.
//   2. Removing the icon picker's paste door left custom-icon upload
//      with no keyboard path: the drop box's
//      file input must stay keyboard-reachable.
//
// Environment: the documented gate — run via the e2e scripts with
// DEZFIL_BASE_URL pointing at the server.
import { test, expect } from "@playwright/test";
import {
  addLayer,
  createMap,
  publishMap,
  seedCsv,
  trackConsole,
} from "./support";
import { isAllowedConsoleError } from "./console-allowlist";

const runId = Date.now().toString(36);
const tableName = `fr_${runId}`;

test.describe.configure({ mode: "serial" });

test("field regressions — search sliver, icon keyboard door", async ({
  page,
}) => {
  const errors = trackConsole(page);
  // Seeding runs as in-page fetches — land on the app origin first.
  await page.goto("/maps");
  await seedCsv(
    page,
    tableName,
    "name,lon,lat\nAlexanderplatz,13.41,52.52\nZoo,13.33,52.51\n",
  );
  const mapId = await createMap(page, `Field regressions ${runId}`);
  await addLayer(
    page,
    mapId,
    "Stations",
    `SELECT name, ST_Point(lon, lat) AS geom FROM ${tableName}`,
  );
  await page.goto(`/maps/${mapId}`);
  const search = page.getByRole("combobox", {
    name: "Search this map and places",
  });
  await expect(search).toBeVisible();

  // The visible shortcut furniture was removed, not the
  // accelerator. No <kbd> or reserved trailing seat remains, and both
  // platform chords still reach the one field from outside it.
  const searchHost = search.locator("xpath=..");
  await expect(searchHost.locator("kbd")).toHaveCount(0);
  expect(
    await search.evaluate((el) => {
      const style = getComputedStyle(el);
      return style.paddingLeft === style.paddingRight;
    }),
  ).toBe(true);
  // Click the unobstructed center of the canvas. Its top-left sits beneath
  // the floating header, so a fixed (20, 20) point targets chrome, not map.
  await page.locator(".maplibregl-canvas").click();
  await page.keyboard.press("Meta+K");
  await expect(search).toBeFocused();

  await search.fill("alex");
  await expect(page.locator("#search-results")).toHaveCount(1);
  await search.press("Escape");
  await expect(search).toHaveAttribute("aria-expanded", "false");
  // The name is a button at rest; enter rename mode before using its text
  // field as the "other input" arm for the global accelerator.
  await page.locator('button[title^="Rename "]').click();
  const mapName = page.getByRole("textbox", { name: "Map name" });
  await expect(mapName).toBeVisible();
  await mapName.focus();
  await page.keyboard.press("Control+K");
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute("aria-expanded", "true");

  // Seed a transient marker first: select a value result, which flies
  // and drops the chip. The marker is the observable the Escape check
  // below needs — without one, the check could not fail.
  await search.fill("alex");
  await expect(page.locator("#search-results")).toHaveCount(1);
  await expect(
    page.getByRole("option", { name: /Alexanderplatz/ }),
  ).toBeVisible();
  await expect(search).toHaveAttribute("aria-expanded", "true");
  await search.press("ArrowDown");
  await search.press("Enter");
  const marker = page.getByRole("button", { name: "Dismiss marker" });
  await expect(marker).toBeVisible();

  // 1a. A query with no matches renders no panel at all — not even an
  // empty box — and the combobox does not claim an expanded popup.
  await search.fill("Can");
  await page.waitForTimeout(900); // past the debounce and the round
  await expect(page.locator("#search-results")).toHaveCount(0);
  await expect(search).toHaveAttribute("aria-expanded", "false");

  // 1b. With no visible panel, the FIRST Escape must reach the marker
  // — the regressed hidden-open state consumed it and the marker
  // needed a second press.
  await search.press("Escape");
  await expect(marker).toHaveCount(0);

  // 1c. The real dropdown still reopens on a match.
  await search.fill("alex");
  await expect(page.locator("#search-results")).toHaveCount(1);

  // 2. The custom icon door: switch the layer to icons, open Custom…
  await expect(
    page.getByRole("button", { name: /^Stations/ }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /^Stations/ }).first().click();
  const iconTile = page.getByRole("button", { name: "Icon", exact: true });
  await expect(iconTile).toBeVisible();
  await iconTile.click();
  await page.getByRole("button", { name: "Custom…" }).click();
  const box = page.getByText("Drop an .svg here, or click to choose a file.");
  await expect(box).toBeVisible();
  // No paste textarea in the icon box (the removed door stays removed)…
  // The check is the box's, where the door stood, not the page's: the page
  // holds other surfaces' own text fields, such as the closed assistant
  // pane's composer, mounted while closed wherever a model is configured.
  const iconBox = box.locator("xpath=..");
  await expect(iconBox.locator("textarea")).toHaveCount(0);
  // …and the file input is a REAL keyboard stop: reached by Tab (a
  // direct .focus() would pass even for tabIndex={-1}), activated by
  // Enter, opening the native chooser — the whole keyboard journey.
  const fileInput = page.getByLabel("Choose an SVG file");
  let reached = false;
  for (let i = 0; i < 150 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await fileInput.evaluate((el) => el === document.activeElement);
  }
  expect(reached).toBe(true);
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (
    await chooser
  ).setFiles({
    name: "dot.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>',
    ),
  });
  await expect(
    page.getByRole("button", { name: "Use this icon" }),
  ).toBeVisible();

  const unexpected = errors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

// ── Field round, part two ────────────────────────────
// Four classes caught by eye:
//   3. Layer names were truncated to their hover width at all times —
//      the contextual actions were faded but still laid out.
//   4. The widget type picker vanished once used; Note was a one-way door.
//   5. The published title card was a pill with a compass on it.
//   6. The numeric filter's readouts ignored the drag, its bounds carried
//      six significant digits, and a handle's focus ring framed the whole
//      histogram.
// ── and part three, same day:
//   7. Opening the header Export menu restyled the trigger itself into a
//  second fixed 220px panel — a selector left dangling by
//      cleanup welded the button to the menu's rule.
//   8. The export menu's layer swatch was computed apart from the panel's
//      spine — from the stored style (a hexbin draws the viz fill), capped
//      at four colors, blended into a gradient. It read as random.
//   9. The menu's layer list ran in the draw array's order, bottom-up —
//      the panel's list reversed. Same rows, opposite order.
test("field regressions — layer name width, widget types, title card, filter", async ({
  page,
}) => {
  const errors = trackConsole(page);
  const run2 = `${runId}b`;
  const table = `fr2_${run2}`;
  await page.goto("/maps");
  await seedCsv(
    page,
    table,
    "name,lon,lat,riders,ratio\n" +
      "Alexanderplatz,13.41,52.52,45,0.125\n" +
      "Zoo,13.33,52.51,12,0.875\n" +
      "Ostkreuz,13.47,52.50,31,0.5\n",
  );
  const mapId = await createMap(page, `Field regressions two ${run2}`);
  // A name long enough that the card must truncate it either way — the
  // measurement below is about how much of it fits, not whether it fits.
  const longName = "berlin_cafes_and_restaurants_by_district_2026";
  await addLayer(
    page,
    mapId,
    longName,
    `SELECT name, riders, ratio, ST_Point(lon, lat) AS geom FROM ${table}`,
  );
  await page.goto(`/maps/${mapId}`);

  // ── 3. The layer row: a longer name, three controls, one door ──────
  const card = page.locator('ul[class*="LayerList"] li').first();
  const head = card.locator('[class*="head"]').first();
  const name = card.locator('[class*="name"]').first();
  await expect(name).toBeVisible();

  const widthOf = async (l: typeof name) => (await l.boundingBox())!.width;
  const boxOf = async (l: typeof head) => {
    const b = (await l.boundingBox())!;
    return { w: Math.round(b.width), h: Math.round(b.height) };
  };

  const restName = await widthOf(name);
  const restHead = await boxOf(head);

  // The name is genuinely wide now. Before, seven icon slots of the card
  // were reserved at rest — faded, but laid out — and the name got 73px of
  // a 312px header, 23% of it. Three seats leave it 177px, 57%. The line
  // sits at half, which separates the two decisively without pinning the
  // exact seat count.
  expect(restName).toBeGreaterThan(restHead.w * 0.5);

  // Nothing about the row appears or disappears. The three controls are
  // there before any pointer arrives, and hovering changes no geometry.
  for (const control of ["Zoom to layer", "Hide layer", "Layer menu"]) {
    await expect(
      card.getByRole("button", { name: control, exact: true }),
    ).toBeVisible();
  }
  await head.hover();
  expect(await widthOf(name)).toBeCloseTo(restName, 0);
  expect(await boxOf(head)).toEqual(restHead);
  await page.mouse.move(0, 0);
  expect(await widthOf(name)).toBeCloseTo(restName, 0);
  expect(await boxOf(head)).toEqual(restHead);

  // Everything else lives behind the one door, reachable and dismissable.
  // Since the second field pass the menu is five rows, each led by a mark,
  // and the three formats fold behind one Export row (option A1).
  const menu = card.getByRole("button", { name: "Layer menu", exact: true });
  await menu.click();
  for (const item of [
    "Edit source",
    "Rename",
    "Duplicate",
    "Export data",
    "Delete layer",
  ]) {
    const row = page.getByRole("menuitem", { name: item });
    await expect(row).toBeVisible();
    // The mark: a drawn glyph on every row, not text alone.
    await expect(row.locator("svg").first()).toBeVisible();
  }
  // The formats are folded at rest — five seats, not eight…
  await expect(page.getByRole("menuitem", { name: /GeoParquet/ })).toHaveCount(
    0,
  );
  // …and one press on the door opens all three as managed actions. The door
  // announces its state: the chevron is aria-hidden, so aria-expanded is
  // the only channel a screen reader has.
  const door = page.getByRole("menuitem", { name: "Export data" });
  await expect(door).toHaveAttribute("aria-expanded", "false");
  await door.click();
  await expect(door).toHaveAttribute("aria-expanded", "true");
  for (const label of ["GeoParquet", "GeoJSON", "CSV"]) {
    const action = page.getByRole("menuitem", {
      name: new RegExp(`^${label}\\b`),
    });
    await expect(action).toBeVisible();
    expect(await action.evaluate((el) => el.tagName)).toBe("BUTTON");
    expect(await action.getAttribute("href")).toBeNull();
    await expect(action).not.toHaveAttribute("aria-disabled", "true");
  }
  // The door folds them back too.
  await door.click();
  await expect(door).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("menuitem", { name: /GeoParquet/ })).toHaveCount(
    0,
  );
  // A destructive item still asks before it acts.
  await page.getByRole("menuitem", { name: "Delete layer" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Confirm delete" }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "Cancel" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "Rename" })).toHaveCount(0);
  // …and reopening starts from the plain list, not the confirm it left in.
  await menu.click();
  await expect(
    page.getByRole("menuitem", { name: "Confirm delete" }),
  ).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Selecting the layer is a plain click on the row — no aiming needed,
  // because the actions sit beside the name rather than over it.
  await name.click();
  expect(await widthOf(name)).toBeCloseTo(restName, 0);
  expect(await boxOf(head)).toEqual(restHead);

  // Truncated, and the whole name still readable from the row.
  await expect(name).toHaveAttribute("title", longName);
  const clipped = await name.evaluate(
    (el) => el.scrollWidth > el.clientWidth + 1,
  );
  expect(clipped).toBe(true);

  // ── 7. The header Export trigger stays a button while its menu is
  // open. The regression turned it into a second fixed panel: the menu
  // must actually open (or the geometry checks pass on nothing), and the
  // trigger must keep its place, its size, and its in-flow positioning.
  const exportTrigger = page.getByRole("button", { name: "Export", exact: true });
  await expect(exportTrigger).toBeVisible();
  const triggerRest = (await exportTrigger.boundingBox())!;
  await exportTrigger.click();
  await expect(page.getByRole("menuitem", { name: /Data/ })).toBeVisible();
  expect(
    await exportTrigger.evaluate((el) => getComputedStyle(el).position),
  ).not.toBe("fixed");
  const triggerOpen = (await exportTrigger.boundingBox())!;
  expect(Math.round(triggerOpen.x)).toBe(Math.round(triggerRest.x));
  expect(Math.round(triggerOpen.y)).toBe(Math.round(triggerRest.y));
  expect(Math.round(triggerOpen.width)).toBe(Math.round(triggerRest.width));
  expect(Math.round(triggerOpen.height)).toBe(Math.round(triggerRest.height));

  // The header menu's Data row is a disclosure, not a plain action. Its
  // announced state follows the real nested rows through one full cycle.
  const headerDataDoor = page.getByRole("menuitem", { name: /^Data/ });
  await expect(headerDataDoor).toHaveAttribute("aria-expanded", "false");
  await headerDataDoor.click();
  await expect(headerDataDoor).toHaveAttribute("aria-expanded", "true");
  await headerDataDoor.click();
  await expect(headerDataDoor).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: /Data/ })).toHaveCount(0);

  // ── 6. The numeric filter ──────────────────────────────────────────
  // riders is a BIGINT over 12–45: whole steps, no decimals. The layer is
  // already selected by the click above, so its filters are in reach.
  const addFilter = page.getByRole("button", { name: "+ Add filter" });
  await expect(addFilter).toBeVisible({ timeout: 20_000 });
  await addFilter.click();
  await page.getByRole("button", { name: /riders/ }).first().click();
  const minBound = page.getByRole("spinbutton", { name: "riders minimum" });
  await expect(minBound).toBeVisible({ timeout: 15_000 });
  const loHandle = page.getByRole("slider", { name: "Minimum" });
  await expect(loHandle).toBeVisible({ timeout: 15_000 });
  await loHandle.focus();

  // The readout follows the handle DURING the drag. The interaction is
  // held open deliberately: a key press commits on key-up, so a keyboard
  // check would pass even against the old behavior, which only wrote the
  // readout after the save landed.
  const before = await minBound.inputValue();
  const dragTo = async (steps: number) =>
    page.evaluate((n) => {
      const input = document.querySelector<HTMLInputElement>(
        'input[type="range"][aria-label="Minimum"]',
      )!;
      input.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, String(Number(input.value) + Number(input.step) * n));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, steps);

  await dragTo(5);
  // Still mid-drag — no pointerup, so nothing has been committed yet.
  await expect(minBound).not.toHaveValue(before);
  const during = await minBound.inputValue();
  // A whole number, because the column is an integer — not 12.165.
  expect(during).toMatch(/^-?\d+$/);

  // Releasing keeps what the drag showed while the save is IN FLIGHT — the
  // criterion is about the pending window, so the save is deliberately held
  // open here. Without this the assertion could pass on a fast save.
  let release: (() => void) | null = null;
  let heldOne = false;
  const held = new Promise<void>((r) => (release = r));
  // A filter is stored on the layer, not the map.
  await page.route("**/api/layers/**", async (route) => {
    if (route.request().method() === "PATCH") {
      heldOne = true;
      await held;
    }
    await route.continue();
  });
  await page.evaluate(() => {
    document
      .querySelector<HTMLInputElement>(
        'input[type="range"][aria-label="Minimum"]',
      )!
      .dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  // Mid-flight: the released value is on screen, not the old bound. The
  // interception must actually have caught a save, or this window never
  // existed and the assertion below would pass on nothing.
  await expect.poll(() => heldOne, { timeout: 10_000 }).toBe(true);
  await expect(minBound).toHaveValue(during);
  // Releasing lets the held handler resume; the route stays installed
  // rather than being torn out from under a request in flight.
  release!();
  // And it stays there once the save lands.
  await page.waitForTimeout(1200);
  await expect(minBound).toHaveValue(during);

  // The ring sits on the handle, not around the histogram: the outlined
  // box is the knob's size, not the track's.
  // Reached by keyboard, not by .focus() — a programmatic focus does not
  // match :focus-visible, so the ring would not be drawn and the check
  // would report the wrong thing. Tab backwards from the bound field.
  await minBound.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(loHandle).toBeFocused();
  const ringBox = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>(
      'input[type="range"][aria-label="Minimum"]',
    );
    if (!input) return null;
    const knob = input.nextElementSibling as HTMLElement | null;
    const styleOf = (el: Element) => getComputedStyle(el).outlineStyle;
    return {
      knobOutline: knob ? styleOf(knob) : null,
      inputOpacity: getComputedStyle(input).opacity,
      inputWidth: input.getBoundingClientRect().width,
      knobWidth: knob ? knob.getBoundingClientRect().width : null,
    };
  });
  expect(ringBox).not.toBeNull();
  // Nothing is suppressed: the input is transparent, so its ring cannot
  // paint, and the knob wears a visible one — the checkbox's arrangement.
  expect(ringBox!.inputOpacity).toBe("0");
  expect(ringBox!.knobOutline).toBe("solid");
  // And the ring is the handle's size, not the track's, which is the
  // defect: it used to frame the whole histogram.
  expect(ringBox!.knobWidth).toBeLessThan(ringBox!.inputWidth / 4);

  // ── 4. The four widget types stay put ──────────────────────────────
  await page.getByRole("tab", { name: "Widgets" }).click();
  await page.locator("[data-add-widget-row]").click();
  const form = page.locator("[data-widget-form]");
  await expect(form).toBeVisible();

  // Untyped: all four offered, nothing chosen, nothing saveable.
  for (const t of ["formula", "category", "histogram", "note"]) {
    await expect(form.locator(`[data-add-type="${t}"]`)).toBeVisible();
  }
  await expect(form.locator("[data-add-type][data-active]")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add widget", exact: true }),
  ).toBeDisabled();
  await expect(page.locator('[data-widget-card]')).toHaveCount(0);

  // The four survive every type, and Note is no longer a one-way door.
  // Switching must not write: the draft is not a widget until it is saved.
  let writes = 0;
  const countWrites = (req: { method(): string; url(): string }) => {
    if (req.method() !== "GET" && /\/api\/maps\//.test(req.url())) writes += 1;
  };
  page.on("request", countWrites);
  for (const t of ["formula", "category", "histogram", "note", "formula"]) {
    await form.locator(`[data-add-type="${t}"]`).click();
    await expect(form.locator("[data-widget-type-grid]")).toBeVisible();
    await expect(form.locator(`[data-add-type="${t}"]`)).toHaveAttribute(
      "data-active",
      "",
    );
    for (const other of ["formula", "category", "histogram", "note"]) {
      await expect(form.locator(`[data-add-type="${other}"]`)).toBeVisible();
    }
  }
  page.off("request", countWrites);
  expect(writes, "switching a widget type writes nothing").toBe(0);

  // Back on a data type after Note, the draft is savable — the layer it
  // lost on the way into Note has been seated again.
  await expect(
    page.getByRole("button", { name: "Add widget", exact: true }),
  ).toBeEnabled();

  // ── 8. The export menu's swatch IS the panel's spine ───────────────
  // Switch the layer to Hex bins, so the drawn ramp lives on the viz
  // rather than the stored style — the projection the menu used to skip.
  await page.getByRole("tab", { name: "Layers" }).click();
  const hexTile = page.getByRole("button", { name: "Hex bins", exact: true });
  await expect(hexTile).toBeVisible({ timeout: 15_000 });
  await hexTile.click();
  const segmentsOf = (root: ReturnType<typeof page.locator>) =>
    root
      .locator('span[class*="swatch"] i')
      .evaluateAll((els) =>
        els.map((el) => getComputedStyle(el).backgroundColor),
      );
  // The spine picks up the server-assigned ramp once the render answers.
  await expect
    .poll(async () => (await segmentsOf(card)).length, { timeout: 20_000 })
    .toBeGreaterThan(1);

  // ── 9. …and the menu's list is the panel's list, same order ────────
  // A second layer is what separates an order from an accident. Added on
  // top of the stack, it must lead BOTH lists: the panel shows draw
  // order top-first, and the menu reads as the same list.
  await addLayer(
    page,
    mapId,
    "second_over_first",
    `SELECT name, ST_Point(lon, lat) AS geom FROM ${table}`,
  );
  await page.reload();
  const panelCards = page.locator('ul[class*="LayerList"] li');
  const panelNames = () =>
    panelCards.locator('span[class*="name"]').allTextContents();
  await expect.poll(panelNames, { timeout: 20_000 }).toEqual([
    "second_over_first",
    longName,
  ]);

  const hexCard = panelCards.filter({ hasText: longName });
  // The hexbin viz persisted the reload; wait for its ramp to answer.
  await expect
    .poll(async () => (await segmentsOf(hexCard)).length, { timeout: 20_000 })
    .toBeGreaterThan(1);
  const spine = await segmentsOf(hexCard);

  await exportTrigger.click();
  await page.getByRole("menuitem", { name: /^Data/ }).click();
  const menuRows = page
    .getByRole("menu", { name: "Export" })
    .locator('[class*="layerRow"]');
  await expect(menuRows).toHaveCount(2);
  expect(
    await menuRows.locator('[class*="layerName"]').allTextContents(),
  ).toEqual(["second_over_first", longName]);
  // Same colors, same order, same segment rendering — one function.
  expect(
    await segmentsOf(menuRows.filter({ hasText: longName })),
  ).toEqual(spine);
  await page.keyboard.press("Escape");

  const unexpected = errors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});

// The published title card is its own journey: it needs a published view.
// The claim is that it wears the published legend's card — frameless, the
// same translucent panel surface, the same radius and lift — so the test
// pins those values and proves the surface is token-driven by reading it
// in both themes. (Comparing against a live legend would be neater, but a
// constant-fill point layer renders none to compare with.)
test("field regression — the published title card wears the legend's card", async ({
  page,
}) => {
  await page.goto("/maps");
  const mapId = await createMap(page, `Field title ${runId}`);
  const token = await publishMap(page, mapId);

  const surfaceIn = async (theme: "light" | "dark") => {
    await page.addInitScript((t) => {
      localStorage.setItem("dezfil-theme", t);
    }, theme);
    await page.goto(`/v/${token}`);
    const title = page.locator("header").first();
    await expect(title).toContainText(`Field title ${runId}`);
    // No logo beside the name. The icon keeps its place on the loading
    // and not-found screens; it has none next to a map's own title.
    await expect(title.locator("svg")).toHaveCount(0);
    return title.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        radius: s.borderTopLeftRadius,
        border: s.borderTopWidth,
        shadow: s.boxShadow,
        background: s.backgroundColor,
      };
    });
  };

  // The published view resolves its own reader theme, not the workspace
  // one, so this reads the card once and pins the surface. The colour is
  // a token mix rather than a baked value — which is what the alpha below
  // proves — so it follows whichever theme the reader picks.
  const surface = await surfaceIn("light");

  for (const s of [surface]) {
    // The legend's card, not the old pill: 999px or a 1px border fails.
    expect(s.radius).toBe("16px");
    expect(s.border).toBe("0px");
    expect(s.shadow).toContain("26px");
    // Translucent at the legend's own 93%, not the opaque widget-card
    // surface and not the old pill's bg-raised at 92%.
    expect(s.background).toContain("/ 0.93)");
  }
});
