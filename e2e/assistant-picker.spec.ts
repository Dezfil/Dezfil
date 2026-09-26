// The model and effort picker in the live pane: where it stands, the
// menu it opens and where that menu fits, the keyboard, the states that
// lock it, and what the tab remembers across navigation, a reload and a
// second tab. Conformance to the visual reference is a judgment call;
// what runs here is mechanical.
//
// Environment: the tool-harness boot, with the instance offering
// more than one model:
//   DEZFIL_AI_MODELS_OPENAI=gpt-5.6-terra,gpt-6-astra,gpt-7-unheard
// The third identity is one the knowledge table does not know, which is
// how the no-effort state is reached; it never has to answer.
import { test, expect, type Page } from "@playwright/test";
import { assistantProviderFixture } from "./assistant-provider-fixture";
import { assistantToolHarness, harnessTarget } from "./assistant-tool-harness";
import { routeHouse } from "./support";
import { api, box, composer, onBuilder, pane, seed, sendAndIdentify } from "./assistant-turn-support";

const provider = assistantProviderFixture();
const harness = assistantToolHarness(harnessTarget());
test.beforeAll(async () => { await provider.start(); await harness.start(); });
test.afterAll(async () => { await provider.stop(); await harness.stop(); });
test.beforeEach(async ({ context, page }) => {
  provider.reset(); harness.reset();
  await routeHouse(context, { basemapStyleStub: true });
  await page.goto("/maps");
  const open = await api(page, "GET", "/api/assistant/pending") as { pending: { runId: string }[] };
  for (const p of open.pending) await api(page, "DELETE", `/api/assistant/runs/${p.runId}`).catch(() => undefined);
});

const chip = (page: Page) => pane(page).locator("[data-model-picker]");
const menu = (page: Page) => pane(page).locator("[data-model-menu]");
const composerRow = (page: Page) => pane(page).locator("form");
/** The chip's words as a person reads them. Its two spans are separated by
 * layout rather than by text, so the parts are joined here and never read
 * out of `textContent`, which would run them together. */
const words = async (locator: ReturnType<Page["locator"]>) =>
  (await locator.evaluate((el) => Array.from(el.childNodes).map((n) => (n.textContent ?? "").trim()).filter(Boolean).join(" ")))
    .replace(/\s+/g, " ").trim();

/** The two widths page 04 draws: the docked pane, and the overlay. */
const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 1040, height: 900 };

/** The pane open on whichever host this page is, and its picker readable. */
async function open(page: Page) {
  await expect(pane(page)).toHaveCount(1);
  if ((await pane(page).getAttribute("data-open")) !== "true") {
    await page.locator("header").getByRole("button", { name: /^Open assistant$/ }).click();
  }
  await expect(chip(page)).toBeVisible();
}

async function openPane(page: Page, size: typeof WIDE) {
  await page.setViewportSize(size);
  const { mapId } = await seed(page);
  await onBuilder(page, mapId);
  await expect(chip(page), "this instance offers one model: boot it with DEZFIL_AI_MODELS_OPENAI naming several").toBeVisible();
  return mapId;
}

test.describe("where the picker stands", () => {
  for (const [name, size] of [["docked", WIDE], ["overlay", NARROW]] as const) {
    test(`stands in the composer's footer at the ${name} width, and the pane's model line is gone`, async ({ page }) => {
      await openPane(page, size);
      const chipBox = await box(chip(page));
      const inputBox = await box(composer(page));
      const formBox = await box(composerRow(page).last());
      expect(chipBox.y, "the chip is not under the input").toBeGreaterThan(inputBox.y + inputBox.height - 2);
      expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(formBox.x + formBox.width + 1);
      // The model line the picker replaces.
      await expect(pane(page).getByText("gpt-5.6-terra", { exact: true })).toHaveCount(0);
      await expect(chip(page)).toContainText("Terra");
    });

    test(`opens its menu inside the pane at the ${name} width`, async ({ page }) => {
      await openPane(page, size);
      await chip(page).click();
      await expect(menu(page)).toBeVisible();
      const m = await box(menu(page));
      const p = await box(pane(page));
      expect(m.x, "the menu escapes the pane on the left").toBeGreaterThanOrEqual(p.x - 1);
      expect(m.x + m.width, "the menu escapes the pane on the right").toBeLessThanOrEqual(p.x + p.width + 1);
      expect(m.y, "the menu escapes the pane at the top").toBeGreaterThanOrEqual(p.y - 1);
      expect(m.y + m.height, "the menu escapes the pane at the bottom").toBeLessThanOrEqual(p.y + p.height + 1);
    });
  }
});

test.describe("choosing, and what each model offers", () => {
  test("lists every offered model with its own levels, and a model with no levels brings no effort row", async ({ page }) => {
    await openPane(page, WIDE);
    await chip(page).click();
    await expect(menu(page).locator("[data-model]")).toHaveCount(3);
    await expect(menu(page).locator('[data-effort="minimal"]')).toBeVisible();
    await expect(menu(page).locator('[data-effort="xhigh"]')).toHaveCount(0);

    await menu(page).locator('[data-model="gpt-6-astra"]').click();
    await expect(chip(page)).toContainText("Astra");
    await chip(page).click();
    await expect(menu(page).locator('[data-effort="xhigh"]')).toBeVisible();
    await expect(menu(page).locator('[data-effort="minimal"]')).toHaveCount(0);
    await menu(page).locator('[data-effort="xhigh"]').click();
    expect(await words(chip(page))).toBe("Astra · XHigh");

    // An identity the table knows nothing of: itself, and no effort row.
    await chip(page).click();
    await menu(page).locator('[data-model="gpt-7-unheard"]').click();
    expect(await words(chip(page))).toBe("gpt-7-unheard");
    await chip(page).click();
    await expect(menu(page).locator('[aria-label="Effort"]')).toHaveCount(0);
  });

  test("carries the choice to the request the route receives", async ({ page }) => {
    await openPane(page, WIDE);
    await chip(page).click();
    await menu(page).locator('[data-model="gpt-6-astra"]').click();
    await chip(page).click();
    await menu(page).locator('[data-effort="xhigh"]').click();
    provider.replies.push({ text: "Done." });
    const request = page.waitForRequest((r) => r.url().endsWith("/api/assistant/messages") && r.method() === "POST");
    await composer(page).fill("Say something");
    await pane(page).getByRole("button", { name: "Send", exact: true }).click();
    expect((await request).postDataJSON().choice).toEqual({ model: "gpt-6-astra", effort: "xhigh" });
    await expect(pane(page).getByText("Done.", { exact: true })).toBeVisible();
    expect(provider.captures[0].model).toBe("gpt-6-astra");
  });

  test("carries the whole pair for a model with no levels, and the route accepts it", async ({ page }) => {
    // The pane sends what it holds, neutral level included, for every model
    // it can select. The proof that the route
    // accepts it is the turn completing, not the shape of the request alone.
    await openPane(page, WIDE);
    await chip(page).click();
    await menu(page).locator('[data-model="gpt-7-unheard"]').click();
    provider.replies.push({ text: "Done." });
    const request = page.waitForRequest((r) => r.url().endsWith("/api/assistant/messages") && r.method() === "POST");
    await composer(page).fill("Say something");
    await pane(page).getByRole("button", { name: "Send", exact: true }).click();
    expect((await request).postDataJSON().choice).toEqual({ model: "gpt-7-unheard", effort: "default" });
    await expect(pane(page).getByText("Done.", { exact: true })).toBeVisible();
    expect(provider.captures[0].model).toBe("gpt-7-unheard");
  });
});

test.describe("the keyboard", () => {
  test("opens, moves, selects and dismisses, and Escape closes the menu before the pane", async ({ page }) => {
    await openPane(page, WIDE);
    await chip(page).focus();
    await page.keyboard.press("ArrowDown");
    await expect(menu(page)).toBeVisible();
    const focused = () => page.evaluate(() => document.activeElement?.getAttribute("data-model") ?? document.activeElement?.getAttribute("data-effort") ?? "");
    expect(await focused()).toBe("gpt-5.6-terra");
    await page.keyboard.press("ArrowDown");
    expect(await focused()).toBe("gpt-6-astra");
    await page.keyboard.press("End");
    expect(await focused()).not.toBe("");
    await page.keyboard.press("Home");
    expect(await focused()).toBe("gpt-5.6-terra");

    // Escape closes the menu and returns focus to the chip; the pane stays.
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    await expect(chip(page)).toBeFocused();
    await expect(pane(page)).toHaveAttribute("data-open", "true");
    // A second Escape, with the menu closed, is the pane's own.
    await page.keyboard.press("Escape");
    await expect(pane(page)).toHaveAttribute("data-open", "false");
  });

  test("closes the menu when focus or a pointer leaves it, so no Escape finds one open", async ({ page }) => {
    // Escape belongs to the menu before the
    // pane, but the wrapper only hears the press while the
    // focus is inside it. A menu left open behind a composer the person
    // clicked into takes that priority away: their Escape closes the whole
    // pane, and reopening it shows the menu still standing.
    await openPane(page, WIDE);

    // Focus leaving the picker for the composer, with no pointer involved.
    await chip(page).click();
    await expect(menu(page)).toBeVisible();
    await composer(page).focus();
    await expect(menu(page)).toHaveCount(0);
    await expect(composer(page), "closing on a focus departure took the focus back").toBeFocused();

    // The Escape that follows is the pane's own, and nothing is left open
    // behind it when the pane comes back.
    await page.keyboard.press("Escape");
    await expect(pane(page)).toHaveAttribute("data-open", "false");
    await page.locator("header").getByRole("button", { name: /^Open assistant$/ }).click();
    await expect(pane(page)).toHaveAttribute("data-open", "true");
    await expect(menu(page)).toHaveCount(0);

    // A pointer landing elsewhere in the pane. The open menu covers the
    // composer, so the press is aimed just above the menu's own top edge —
    // inside the pane, outside the menu, which is where a person's next
    // click lands when they have finished with it.
    await chip(page).click();
    await expect(menu(page)).toBeVisible();
    const m = await box(menu(page));
    const p = await box(pane(page));
    expect(m.y - 12, "the menu reaches the top of the pane; aim the press elsewhere").toBeGreaterThan(p.y);
    await page.mouse.click(p.x + p.width / 2, m.y - 12);
    await expect(menu(page)).toHaveCount(0);
  });

  test("selects with Enter from the keyboard alone", async ({ page }) => {
    await openPane(page, WIDE);
    await chip(page).focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(menu(page)).toHaveCount(0);
    await expect(chip(page)).toContainText("Astra");
  });
});

test.describe("the states that lock the picker", () => {
  test("is disabled with its choice readable while a turn executes, and again while a card waits", async ({ page }) => {
    const mapId = await openPane(page, WIDE);
    await chip(page).click();
    await menu(page).locator('[data-model="gpt-6-astra"]').click();
    const chosen = await words(chip(page));

    provider.replies.push({ chunks: ["Thinking", "…"], hold: { chunks: true } });
    await sendAndIdentify(page, "Take your time");
    await provider.reached("0:chunk:0");
    await expect(pane(page).locator("[data-phase]")).toHaveAttribute("data-phase", "executing");
    await expect(chip(page)).toBeDisabled();
    expect(await words(chip(page))).toBe(chosen);
    await expect(menu(page)).toHaveCount(0);
    provider.release("0:chunk:0");
    await expect(pane(page).getByText("Thinking…", { exact: true })).toBeVisible();
    await expect(chip(page)).toBeEnabled();

    // A card waiting: the same lock, separately exercised.
    provider.replies.push({ calls: [{ name: "publish_map", args: { id: mapId } }] });
    await sendAndIdentify(page, "Publish it");
    await expect(pane(page).locator("[data-confirmation]")).toBeVisible();
    await expect(pane(page).locator("[data-phase]")).toHaveAttribute("data-phase", "parked");
    await expect(chip(page)).toBeDisabled();
    expect(await words(chip(page))).toBe(chosen);
    await expect(menu(page)).toHaveCount(0);
  });

  test("stays locked on the run's own pair while that run's outcome is unknown", async ({ page }) => {
    // The stream ends but the outcome read
    // cannot land, so the pane holds a run it knows nothing about: the
    // recovery door is offered, and the picker must go on reading that
    // run's pair rather than unlocking under it and offering to change a
    // selection the next message would not carry.
    await openPane(page, WIDE);
    await chip(page).click();
    await menu(page).locator('[data-model="gpt-6-astra"]').click();
    const chosen = await words(chip(page));

    const runReads = "**/api/assistant/runs/*";
    await page.route(runReads, (route) => (route.request().method() === "GET" ? route.abort() : route.continue()));
    provider.replies.push({ text: "Done." });
    await composer(page).fill("Say something");
    await pane(page).getByRole("button", { name: "Send", exact: true }).click();
    await expect(pane(page).getByRole("button", { name: "Check request outcome" })).toBeVisible();
    await expect(chip(page)).toBeDisabled();
    expect(await words(chip(page))).toBe(chosen);

    // And it is given back once the run's outcome is known.
    await page.unroute(runReads);
    await pane(page).getByRole("button", { name: "Check request outcome" }).click();
    await expect(chip(page)).toBeEnabled();
    expect(await words(chip(page))).toBe(chosen);
  });
});

test.describe("what the tab remembers", () => {
  test("keeps the choice across the three pages and a reload, and a second tab starts at the default", async ({ page, context }) => {
    const mapId = await openPane(page, WIDE);
    // A workflow of this test's own, so the canvas — the third host that
    // mounts the pane — is reachable. The /workflows list mounts none.
    const made = await api(page, "POST", "/api/recipes", { name: `picker ${Date.now().toString(36)}` });
    const recipeId = (made.recipe as { id: string }).id;
    await chip(page).click();
    await menu(page).locator('[data-model="gpt-6-astra"]').click();
    const chosen = await words(chip(page));
    expect(chosen).toContain("Astra");

    const hosts = [
      { path: "/sql", landmark: '[aria-label="SQL editor"]' },
      { path: `/workflows/${recipeId}`, landmark: "[data-workflow-canvas]" },
      { path: `/maps/${mapId}`, landmark: "[data-map-layer]" },
    ];
    for (const host of hosts) {
      await page.goto(host.path);
      await page.waitForSelector(host.landmark);
      await open(page);
      expect(await words(chip(page)), `the choice was lost on ${host.path}`).toBe(chosen);
    }

    await page.reload();
    await page.waitForSelector("[data-map-layer]");
    await open(page);
    expect(await words(chip(page)), "the choice was lost on reload").toBe(chosen);

    const second = await context.newPage();
    await second.setViewportSize(WIDE);
    await second.goto(`/maps/${mapId}`);
    await second.waitForSelector("[data-map-layer]");
    await open(second);
    expect(await words(chip(second)), "a fresh tab inherited the choice").toContain("Terra");
    await second.close();
  });
});
