// The Settings page in a browser: a limit kept as it is stepped, Reset to
// defaults then Undo, the leave guard over a link, over back and over a
// jump of several entries from the history list, a search hit landing on
// its row, a member's column, and the sign-in page carrying what General
// stores. Every journey here runs as the browser fixture's
// admin unless it says otherwise, and puts back what it changed.
//
// One journey needs a second instance: start it with
// DEZFIL_OPERATION_QUEUE_MAX set to a number and run this spec with
// DEZFIL_E2E_PINNED_QUEUE_MAX set to the same number. That journey then
// checks the pinned limit drawn locked, and the journey that steps the
// same limit skips; without it, the reverse.
import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { browserAccount } from "../scripts/journey-auth.mjs";
import { isAllowedConsoleError } from "./console-allowlist";
import { closeAll, invitePerson, runTag, type Person } from "./sharing-support";
import { routeHouse, trackConsole, type ConsoleError } from "./support";

const SETTINGS = "/api/instance/settings";
const pinnedQueue = process.env.DEZFIL_E2E_PINNED_QUEUE_MAX;

const column = (page: Page) => page.getByRole("navigation", { name: "Settings" });
const card = (page: Page, title: string) => page.getByRole("region", { name: title, exact: true });
const leaving = (page: Page) => page.getByRole("dialog", { name: "Unsaved changes" });
/** The search's answer heading: a status line, so it is found by its id. */
const answer = (page: Page) => page.locator("#settings-search-heading");
const settingsWrite = (page: Page) => page.waitForResponse(response =>
  new URL(response.url()).pathname === SETTINGS && response.request().method() === "PATCH");

/** Put stored instance settings back to their defaults (null clears a stored value). */
async function restore(request: APIRequestContext, keys: string[]): Promise<void> {
  const response = await request.patch(SETTINGS, { data: Object.fromEntries(keys.map(key => [key, null])) });
  expect(response.status()).toBe(200);
}

function expectQuiet(errors: ConsoleError[]): void {
  expect(errors.filter(error => !isAllowedConsoleError(error.text, error.url))).toEqual([]);
}

/** An admin's tabs, in the column's order: each by its link's name and its
 * pane's id, with what is on screen once the tab has drawn whole. */
const DRAWN: readonly (readonly [label: string, pane: string, parts: readonly string[]])[] = [
  ["Account", "account", ["#account"]],
  ["Tokens", "tokens", ["#tokens li"]],
  ["Appearance", "appearance", ["#set-side-menu"]],
  ["General", "general", ["#card-sign-in"]],
  // Each draws every card at once when its read lands: the last card stands for the tab.
  ["Maps", "maps", ["#card-new-layers"]],
  ["Workflows & SQL", "workflows", ["#card-sql-console"]],
  ["Publishing", "publishing", ["#publishing-export"]],
  ["Data & services", "data", ["#data-who"]],
  ["Limits", "limits", ["#limits-public"]],
  // The data folder's state, not its Checking placeholder.
  ["System", "system", ["#sys-assistant-status", "#sys-data-folder [data-state]"]],
];

/** The pane a tab is drawn in. */
const paneOf = (tab: string) => DRAWN.find(([label]) => label === tab)![1];

/** Open a tab from the column and wait until it has drawn whole. */
async function openTab(page: Page, tab: string): Promise<void> {
  const [, pane, parts] = DRAWN.find(([label]) => label === tab)!;
  await column(page).getByRole("link", { name: tab, exact: true }).click();
  await expect(column(page).getByRole("link", { name: tab, exact: true })).toHaveAttribute("aria-current", "page");
  for (const part of parts) await expect(page.locator(`[data-tab="${pane}"] ${part}`).first()).toBeVisible();
}

/** A frame painted during a change of tab: whether the tab that was on
 * screen and the tab opening are each visible and drawn whole, and whether
 * a loading line is visible on the page. */
interface Painted { outgoing: boolean; incoming: boolean; loading: boolean }
interface Recorder { change: { from: string; to: string } | null; frames: Painted[] }
const recorder = (page: Page) => page.evaluate(() => (window as unknown as { tabChange: Recorder }).tabChange);

/** Before the page's own scripts: while a change of tab is armed, record
 * every animation frame, up to the first that paints the tab opening
 * whole. */
async function recordFrames(page: Page): Promise<void> {
  await page.addInitScript(drawnBy => {
    const recorder: Recorder = { change: null, frames: [] };
    (window as unknown as { tabChange: Recorder }).tabChange = recorder;
    /** The tab on screen and drawn whole: a visible pane holding its cards. */
    const drawn = (tab: string) => [...document.querySelectorAll(`[data-tab="${tab}"]`)].some(pane =>
      (pane as HTMLElement).checkVisibility() && (drawnBy[tab] ?? []).every(part => pane.querySelector(part) !== null));
    const look = () => {
      const change = recorder.change;
      if (change) {
        const frame: Painted = {
          outgoing: drawn(change.from),
          incoming: drawn(change.to),
          // What a person can read: a hidden pane's text is not drawn.
          loading: /Loading/.test(document.querySelector("main")?.innerText ?? ""),
        };
        recorder.frames.push(frame);
        if (frame.incoming) recorder.change = null;
      }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  }, Object.fromEntries(DRAWN.map(([, pane, parts]) => [pane, parts])));
}

/** Open a tab from the column, recording every frame from the click until
 * the tab is painted whole. Each of those frames shows the tab that was on
 * screen or the tab opening, drawn whole, never an empty or half-drawn
 * pane between them, and none shows a loading line. */
async function openDrawn(page: Page, tab: string): Promise<void> {
  const from = await page.evaluate(() =>
    [...document.querySelectorAll("[data-tab]")].find(pane => (pane as HTMLElement).checkVisibility())?.getAttribute("data-tab") ?? "");
  const to = paneOf(tab);
  await page.evaluate(change => {
    const recorder = (window as unknown as { tabChange: Recorder }).tabChange;
    recorder.frames = [];
    recorder.change = change;
  }, { from, to });
  await openTab(page, tab);
  await expect.poll(async () => (await recorder(page)).change, { message: `${tab}: still recording` }).toBeNull();
  const { frames } = await recorder(page);
  const said = `${from} to ${to}: ${JSON.stringify(frames)}`;
  expect(frames.length, said).toBeGreaterThan(0);
  expect(frames.filter(frame => !frame.outgoing && !frame.incoming), said).toEqual([]);
  expect(frames.filter(frame => frame.loading), said).toEqual([]);
}

test.describe("the Settings page", () => {
  test.describe.configure({ mode: "serial" });

  test("a limit is kept as it is stepped, shows Saved once the server answers, and never holds the page", async ({ page, context, request, baseURL }) => {
    test.skip(!!pinnedQueue, "This instance pins the limit; the pinned journey covers it.");
    await routeHouse(context);
    const errors = trackConsole(page);
    await restore(request, ["operationQueueMax"]);
    try {
      await page.goto("/settings/limits");
      await expect(column(page).getByRole("link", { name: "Limits", exact: true })).toHaveAttribute("aria-current", "page");
      const row = page.locator("#set-tools-waiting");
      const waiting = card(page, "Tools").getByRole("spinbutton", { name: "Tools waiting", exact: true });
      await expect(waiting).toHaveValue("20");
      // No Save anywhere: a number is kept as it changes.
      await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
      const written = settingsWrite(page);
      await waiting.focus();
      await page.keyboard.press("ArrowUp");
      const response = await written;
      expect(response.request().postDataJSON()).toEqual({ operationQueueMax: 21 });
      expect(response.status()).toBe(200);
      await expect(row.getByRole("status")).toHaveText("Saved");
      await expect(row).not.toContainText("runs");
      await page.reload();
      await expect(waiting).toHaveValue("21");
      // System's table names the same row and links back to it.
      await column(page).getByRole("link", { name: "System", exact: true }).click();
      await expect(page).toHaveURL(new URL("/settings/system", baseURL).href);
      const variable = page.locator("#env-dezfil-operation-queue-max");
      await expect(variable.locator("td")).toHaveText(["Tools waiting", "DEZFIL_OPERATION_QUEUE_MAX", "21", "Limits"]);
      await variable.getByRole("link", { name: "Limits", exact: true }).click();
      await expect(page).toHaveURL(new URL("/settings/limits#set-tools-waiting", baseURL).href);
      // A value kept at once never asks before leaving.
      await waiting.focus();
      await page.keyboard.press("ArrowDown");
      await expect(row.getByRole("status")).toHaveText("Saved");
      await column(page).getByRole("link", { name: "General", exact: true }).click();
      await expect(page).toHaveURL(new URL("/settings/general", baseURL).href);
      await expect(leaving(page)).toHaveCount(0);
    } finally { await restore(request, ["operationQueueMax"]); }
    expectQuiet(errors);
  });

  test("a limit the server's environment sets is drawn locked, naming its variable, in Limits and in System", async ({ page, context, request, baseURL }) => {
    test.skip(!pinnedQueue, "Requires an instance started with DEZFIL_OPERATION_QUEUE_MAX and DEZFIL_E2E_PINNED_QUEUE_MAX set to the same number.");
    await routeHouse(context);
    const errors = trackConsole(page);
    // The card's other limits at their defaults, so only the pinned one differs.
    await restore(request, ["operationConcurrency", "operationTimeoutS"]);
    const shown = Number(pinnedQueue).toLocaleString("en-US");
    await page.goto("/settings/limits");
    const tools = card(page, "Tools");
    const pinned = tools.getByRole("textbox", { name: "Tools waiting", exact: true });
    await expect(pinned).toBeDisabled();
    await expect(pinned).toHaveValue(shown);
    await expect(tools.getByRole("spinbutton", { name: "Tools waiting", exact: true })).toHaveCount(0);
    await expect(page.locator("#set-tools-waiting")).toContainText("Set in the server's environment by DEZFIL_OPERATION_QUEUE_MAX.");
    // Pinned away from its default, it still joins no Reset.
    await expect(tools.getByRole("button", { name: /^Reset to defaults/ })).toHaveCount(0);
    await column(page).getByRole("link", { name: "System", exact: true }).click();
    await expect(page).toHaveURL(new URL("/settings/system", baseURL).href);
    await expect(page.locator("#env-dezfil-operation-queue-max td")).toHaveText(["Tools waiting", "DEZFIL_OPERATION_QUEUE_MAX", shown, "Environment"]);
    expectQuiet(errors);
  });

  test("Reset to defaults returns a card in one write, and Undo puts it back", async ({ page, context, request }) => {
    await routeHouse(context);
    const errors = trackConsole(page);
    await restore(request, ["exportRenderConcurrency", "exportRenderTimeoutS"]);
    try {
      await page.goto("/settings/limits");
      const images = card(page, "Image export");
      const atOnce = images.getByRole("spinbutton", { name: "Images at once", exact: true });
      const reset = images.getByRole("button", { name: "Reset to defaults: Image export", exact: true });
      const undo = images.getByRole("button", { name: "Undo reset to defaults: Image export", exact: true });
      await expect(atOnce).toHaveValue("2");
      // At its defaults, the card offers no Reset.
      await expect(reset).toHaveCount(0);
      const stepped = settingsWrite(page);
      await atOnce.focus();
      await page.keyboard.press("ArrowUp");
      expect((await stepped).request().postDataJSON()).toEqual({ exportRenderConcurrency: 3 });
      await expect(reset).toBeVisible();

      const resetWrite = settingsWrite(page);
      await reset.click();
      // Every control the card can change goes back, the one already at its default included.
      expect((await resetWrite).request().postDataJSON()).toEqual({ exportRenderConcurrency: null, exportRenderTimeoutS: null });
      await expect(atOnce).toHaveValue("2");
      await expect(undo).toBeFocused();
      const undoWrite = settingsWrite(page);
      await undo.click();
      expect((await undoWrite).request().postDataJSON()).toEqual({ exportRenderConcurrency: 3 });
      await expect(atOnce).toHaveValue("3");
      await expect(reset).toBeFocused();

      // Unheld by focus or the pointer, Undo goes after its window, and the
      // card, back at its defaults, offers nothing.
      await reset.click();
      await expect(undo).toBeFocused();
      await page.getByRole("heading", { name: "Settings", level: 1 }).click();
      await expect(undo).not.toBeFocused();
      await expect(undo).toHaveCount(0, { timeout: 10_000 });
      await expect(reset).toHaveCount(0);
      await expect(atOnce).toHaveValue("2");

      // A new change in the card lets the Undo go at once.
      await atOnce.focus();
      await page.keyboard.press("ArrowUp");
      await expect(reset).toBeVisible();
      await reset.click();
      await expect(undo).toBeVisible();
      await atOnce.focus();
      await page.keyboard.press("ArrowUp");
      await expect(undo).toHaveCount(0);
      await expect(reset).toBeVisible();
    } finally { await restore(request, ["exportRenderConcurrency", "exportRenderTimeoutS"]); }
    expectQuiet(errors);
  });

  test("leaving a tab with unsaved typed text asks first, over a link and over back", async ({ page, context, request, baseURL }) => {
    await routeHouse(context);
    const errors = trackConsole(page);
    await restore(request, ["signInMessage"]);
    await page.goto("/settings/account");
    await column(page).getByRole("link", { name: "General", exact: true }).click();
    await expect(page).toHaveURL(new URL("/settings/general", baseURL).href);
    const signIn = card(page, "Sign-in");
    const message = signIn.getByLabel("Message", { exact: true });
    await expect(message).toHaveValue("");
    await message.fill("Words that were never saved");
    await expect(signIn.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    await expect(signIn.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();

    // Over a link: the column's Limits.
    await column(page).getByRole("link", { name: "Limits", exact: true }).click();
    await expect(leaving(page)).toContainText("Discard unsaved changes?");
    await expect(leaving(page)).toContainText("Sign-in has changes that are not saved.");
    await leaving(page).getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(leaving(page)).toHaveCount(0);
    await expect(page).toHaveURL(new URL("/settings/general", baseURL).href);
    await expect(message).toHaveValue("Words that were never saved");

    // Over the browser's own Back: the page stays where it is while the question is open.
    await page.goBack();
    await expect(leaving(page)).toContainText("Sign-in has changes that are not saved.");
    await expect(page).toHaveURL(new URL("/settings/general", baseURL).href);
    await expect(message).toHaveValue("Words that were never saved");
    await leaving(page).getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(leaving(page)).toHaveCount(0);
    await expect(page).toHaveURL(new URL("/settings/general", baseURL).href);
    await expect(message).toHaveValue("Words that were never saved");
    // Forward after a kept edit goes nowhere.
    await page.goForward();
    await expect(page).toHaveURL(new URL("/settings/general", baseURL).href);
    await expect(leaving(page)).toHaveCount(0);
    await expect(message).toHaveValue("Words that were never saved");

    // Back again, letting the tab go: the browser goes where it was sent and nothing was kept.
    await page.goBack();
    await leaving(page).getByRole("button", { name: "Discard changes", exact: true }).click();
    await expect(page).toHaveURL(new URL("/settings/account", baseURL).href);
    await expect(card(page, "Account")).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(new URL("/settings/general", baseURL).href);
    await expect(message).toHaveValue("");
    await expect(signIn.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    expect((await (await request.get(SETTINGS)).json()).settings.signInMessage.source).toBe("default");

    // Cancel puts the text back, and then leaving asks nothing.
    await message.fill("Typed, then cancelled");
    await signIn.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(message).toHaveValue("");
    await column(page).getByRole("link", { name: "Account", exact: true }).click();
    await expect(page).toHaveURL(new URL("/settings/account", baseURL).href);
    await expect(leaving(page)).toHaveCount(0);
    expectQuiet(errors);
  });

  test("a jump of several entries past a tab with unsaved text asks; Keep editing comes back, Discard goes", async ({ page, context, request, baseURL }) => {
    await routeHouse(context);
    const errors = trackConsole(page);
    await restore(request, ["signInMessage"]);
    try {
      // Three entries of one document: Account, Tokens, General.
      await page.goto("/settings/account");
      await expect(card(page, "Account")).toBeVisible();
      await column(page).getByRole("link", { name: "Tokens", exact: true }).click();
      await expect(page).toHaveURL(new URL("/settings/tokens", baseURL).href);
      await column(page).getByRole("link", { name: "General", exact: true }).click();
      await expect(page).toHaveURL(new URL("/settings/general", baseURL).href);
      const signIn = card(page, "Sign-in");
      const message = signIn.getByLabel("Message", { exact: true });
      await message.fill("Words that were never saved");
      await expect(signIn.getByRole("button", { name: "Save", exact: true })).toBeVisible();

      // A jump from the history list past Tokens to Account: the page asks and stays.
      await page.evaluate(() => history.go(-3));
      await expect(leaving(page)).toContainText("Sign-in has changes that are not saved.");
      await expect(message).toHaveValue("Words that were never saved");
      await leaving(page).getByRole("button", { name: "Keep editing", exact: true }).click();
      await expect(leaving(page)).toHaveCount(0);
      await expect(page).toHaveURL(new URL("/settings/general", baseURL).href);
      await expect(message).toHaveValue("Words that were never saved");
      // Still held: the browser's own Back asks again.
      await page.goBack();
      await expect(leaving(page)).toContainText("Sign-in has changes that are not saved.");
      await leaving(page).getByRole("button", { name: "Keep editing", exact: true }).click();
      await expect(message).toHaveValue("Words that were never saved");

      // The jump again, letting the tab go: the browser lands where the jump went, and nothing was kept.
      await page.evaluate(() => history.go(-3));
      await leaving(page).getByRole("button", { name: "Discard changes", exact: true }).click();
      await expect(page).toHaveURL(new URL("/settings/account", baseURL).href);
      await expect(card(page, "Account")).toBeVisible();
      expect((await (await request.get(SETTINGS)).json()).settings.signInMessage.source).toBe("default");
    } finally { await restore(request, ["signInMessage"]); }
    expectQuiet(errors);
  });

  test("a search hit opens its tab and marks its row; the keys walk the results; no match says so", async ({ page, context, baseURL }) => {
    await routeHouse(context);
    const errors = trackConsole(page);
    await page.goto("/settings/account");
    await expect(card(page, "Account")).toBeVisible();
    // Record each row the page marks, however briefly the mark holds.
    await page.evaluate(() => {
      const marked: string[] = [];
      (window as unknown as { marked: string[] }).marked = marked;
      new MutationObserver(records => {
        for (const record of records) {
          const element = record.target as Element;
          if (element.getAttribute("data-marked") === "" && element.id) marked.push(element.id);
        }
      }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ["data-marked"] });
    });
    const field = page.getByRole("searchbox", { name: "Search settings" });
    // `/` reaches the field when no field has focus.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("/");
    await expect(field).toBeFocused();

    await field.fill("zz no such setting");
    await expect(answer(page)).toHaveText("No settings match “zz no such setting”");

    await field.fill("tools waiting");
    await expect(answer(page)).toHaveText(/^\d+ results? for “tools waiting”$/);
    const limitsHit = page.getByRole("button", { name: /^Instance \/ Limits · Tools waiting/ });
    const systemHit = page.getByRole("button", { name: /^Instance \/ System · Tools waiting/ });
    await expect(limitsHit).toBeVisible();
    await expect(systemHit).toBeVisible();
    // While the search answers, no tab is marked current.
    await expect(column(page).locator('[aria-current="page"]')).toHaveCount(0);
    // The down arrow walks into the results, the up arrow from the first and Escape go back to the field.
    await page.keyboard.press("ArrowDown");
    await expect(limitsHit).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(field).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("tools waiting");

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new URL("/settings/limits#set-tools-waiting", baseURL).href);
    await expect(field).toHaveValue("");
    await expect(column(page).getByRole("link", { name: "Limits", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#set-tools-waiting")).toBeInViewport();
    await expect.poll(() => page.evaluate(() => (window as unknown as { marked: string[] }).marked)).toContain("set-tools-waiting");

    // Escape in the field clears it and the tab comes back.
    await field.fill("instance name");
    await expect(page.getByRole("button", { name: /^Instance \/ General · Instance name/ })).toBeVisible();
    await field.press("Escape");
    await expect(field).toHaveValue("");
    await expect(card(page, "Tools")).toBeVisible();
    expectQuiet(errors);
  });

  test("a member's column holds Account, Tokens, Appearance and General only, the admins' tabs' addresses open Account, and the search finds nothing beyond them", async ({ browser, request, baseURL }) => {
    const people: Person[] = [];
    try {
      const member = await invitePerson(browser, request, baseURL!, "Member", runTag());
      people.push(member);
      await routeHouse(member.context);
      const page = await member.context.newPage();
      const errors = trackConsole(page);
      // The configuration read is an admin's: a member's pages never ask for it.
      const configurationReads: string[] = [];
      page.on("request", sent => { if (new URL(sent.url()).pathname === SETTINGS) configurationReads.push(sent.url()); });
      await page.goto("/settings/general");
      const links = column(page).getByRole("link");
      await expect(links).toHaveText(["Account", "Tokens", "Appearance", "General"]);
      await expect(column(page).getByRole("link", { name: "Users" })).toHaveCount(0);
      await expect(card(page, "Instance").getByLabel("Instance name", { exact: true })).toBeDisabled();
      await expect(card(page, "Instance")).toContainText("Only admins can change the instance name.");
      await expect(card(page, "Sign-in").getByLabel("Message", { exact: true })).toBeDisabled();
      await expect(card(page, "Sign-in").getByLabel("Landing page", { exact: true })).toBeDisabled();
      await expect(card(page, "Sign-in")).toContainText("Only admins can change the sign-in settings.");
      await expect(page.getByRole("button", { name: /^(Save|Reset to defaults)/ })).toHaveCount(0);

      // An address for a tab a member cannot see opens Account, as any unknown tab does.
      await page.goto("/settings/limits");
      await expect(page).toHaveURL(new URL("/settings/account", baseURL).href);
      await expect(card(page, "Account")).toBeVisible();
      await page.goto("/settings/system#sys-version");
      await expect(page).toHaveURL(new URL("/settings/account", baseURL).href);
      // So do the addresses of what new things start with, a row's included.
      for (const address of ["/settings/maps", "/settings/workflows#set-minimap", "/settings/publishing#set-export-width", "/settings/data#set-geocoder-address"]) {
        await page.goto(address);
        await expect(page).toHaveURL(new URL("/settings/account", baseURL).href);
        await expect(card(page, "Account")).toBeVisible();
        await expect(column(page).getByRole("link")).toHaveText(["Account", "Tokens", "Appearance", "General"]);
      }

      const field = page.getByRole("searchbox", { name: "Search settings" });
      for (const query of ["limit", "users", "DEZFIL_OPERATION_QUEUE_MAX", "version", "basemap", "minimap", "starting width", "workflows"]) {
        await field.fill(query);
        await expect(answer(page)).toHaveText(`No settings match “${query}”`);
        await expect(page.getByRole("button", { name: /^(Instance \/ (Maps|Workflows & SQL|Publishing|Limits|System)|Side menu \/ Users)/ })).toHaveCount(0);
      }
      await field.fill("instance name");
      await expect(page.getByRole("button", { name: /^Instance \/ General · Instance name/ })).toBeVisible();
      expect(configurationReads).toEqual([]);
      expectQuiet(errors);
    } finally { await closeAll(people); }
  });

  test("the sign-in page shows the stored message and contact, and people land on the stored landing page", async ({ page, context, browser, request, baseURL }) => {
    await routeHouse(context);
    const errors = trackConsole(page);
    const keys = ["signInMessage", "lostPasswordContact", "landingPage"];
    const markup = "<b>Use your work email.</b> New here? Ask the GIS team.";
    const visitors: { close(): Promise<void> }[] = [];
    await restore(request, keys);
    try {
      await page.goto("/settings/general");
      const signIn = card(page, "Sign-in");
      await expect(signIn.getByRole("button", { name: /^Reset to defaults/ })).toHaveCount(0);
      await expect(signIn.getByText("Shown as “Forgot your password? An admin can reset it.”")).toBeVisible();
      await signIn.getByLabel("Message", { exact: true }).fill(markup);
      // The contact's line on the sign-in page follows the typing, its own period dropped.
      await signIn.getByLabel("Lost password contact", { exact: true }).fill("the GIS team at gis@example.test.");
      await expect(signIn.getByText("Shown as “Forgot your password? Ask the GIS team at gis@example.test.”")).toBeVisible();
      const saved = settingsWrite(page);
      await signIn.getByRole("button", { name: "Save", exact: true }).click();
      expect(Object.keys((await saved).request().postDataJSON()).sort()).toEqual(["lostPasswordContact", "signInMessage"]);
      await expect(signIn.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
      // A choice is kept as it is made.
      const chosen = settingsWrite(page);
      await signIn.getByLabel("Landing page", { exact: true }).selectOption("maps");
      expect((await chosen).request().postDataJSON()).toEqual({ landingPage: "maps" });

      const visitor = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
      visitors.push(visitor);
      await routeHouse(visitor);
      const entry = await visitor.newPage();
      await entry.goto("/sign-in");
      // The message is text: its markup shows as typed and draws nothing.
      await expect(entry.getByText(markup, { exact: true })).toBeVisible();
      await expect(entry.locator("main b")).toHaveCount(0);
      await expect(entry.getByText("Forgot your password? Ask the GIS team at gis@example.test.", { exact: true })).toBeVisible();
      await entry.getByLabel("Email", { exact: true }).fill(browserAccount.email);
      await entry.getByLabel("Password", { exact: true }).fill(browserAccount.password);
      await entry.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(entry).toHaveURL(new URL("/maps", baseURL).href);

      // A redeemed invitation lands there too.
      const invitation = await request.post("/api/users", { data: { name: "Landing guest", email: `landing-${randomUUID()}@example.test` } });
      expect(invitation.status()).toBe(201);
      const guest = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
      visitors.push(guest);
      await routeHouse(guest);
      const redeem = await guest.newPage();
      await redeem.goto((await invitation.json()).signInUrl);
      await expect(redeem.getByRole("heading", { name: "Choose your password" })).toBeVisible();
      // The message belongs to the sign-in page alone.
      await expect(redeem.getByText(markup)).toHaveCount(0);
      await redeem.getByLabel("Password", { exact: true }).fill("paper cranes at sunrise");
      await redeem.getByRole("button", { name: "Set password", exact: true }).click();
      await expect(redeem).toHaveURL(new URL("/maps", baseURL).href);

      // Reset to defaults returns no message, the built-in line and Home.
      const reset = signIn.getByRole("button", { name: "Reset to defaults: Sign-in", exact: true });
      const resetWrite = settingsWrite(page);
      await reset.click();
      expect((await resetWrite).request().postDataJSON()).toEqual({ signInMessage: null, lostPasswordContact: null, landingPage: null });
      await expect(signIn.getByLabel("Message", { exact: true })).toHaveValue("");
      await expect(signIn.getByLabel("Lost password contact", { exact: true })).toHaveValue("");
      await expect(signIn.getByLabel("Landing page", { exact: true })).toHaveValue("home");
      await expect(signIn.getByRole("button", { name: "Undo reset to defaults: Sign-in", exact: true })).toBeFocused();
      // A visitor who is not signed in, since a signed-in visit to the sign-in page goes Home.
      const later = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
      visitors.push(later);
      await routeHouse(later);
      const fresh = await later.newPage();
      await fresh.goto("/sign-in");
      await expect(fresh.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
      await expect(fresh.getByText("Forgot your password? An admin can reset it.", { exact: true })).toBeVisible();
      await expect(fresh.getByText(markup)).toHaveCount(0);
    } finally {
      await restore(request, keys);
      for (const visitor of visitors) await visitor.close();
    }
    expectQuiet(errors);
  });

  test("the tab starts at the same left edge on every tab while the page's scrollbar takes room", async ({ playwright, baseURL }) => {
    // Headless Chromium hides its scrollbars, and a hidden scrollbar takes no
    // room; a Mac set to show scroll bars always draws one that does.
    const browser = await playwright.chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
    try {
      // Two laptop widths, and a 16-inch laptop's full width, past the shell's
      // 1720 px breakpoint, where the shell centers its content.
      for (const width of [1280, 1440, 1728]) {
        const context = await browser.newContext({ baseURL, storageState: ".claude/browser-auth.json", viewport: { width, height: 900 } });
        try {
          await routeHouse(context);
          const page = await context.newPage();
          const errors = trackConsole(page);
          await page.goto("/settings/account");
          await expect(card(page, "Account")).toBeVisible();
          const seen: Record<string, { left: number; room: number; tall: boolean }> = {};
          for (const [tab] of DRAWN) {
            await openTab(page, tab);
            seen[tab] = await page.locator("[data-tab]").evaluate(element => ({
              left: element.getBoundingClientRect().left,
              room: window.innerWidth - document.documentElement.clientWidth,
              tall: document.documentElement.scrollHeight > document.documentElement.clientHeight,
            }));
          }
          const shown = JSON.stringify(seen);
          // The check can see a shift: some tab is taller than the window and
          // some is not, and the scrollbar takes room on the taller.
          expect(Object.values(seen).some(at => at.tall) && Object.values(seen).some(at => !at.tall), shown).toBe(true);
          expect(Math.max(...Object.values(seen).filter(at => at.tall).map(at => at.room)), shown).toBeGreaterThan(0);
          const edges = Object.fromEntries(Object.entries(seen).map(([tab, at]) => [tab, at.left]));
          expect(edges, `at ${width} px`).toEqual(Object.fromEntries(DRAWN.map(([tab]) => [tab, edges.Account])));
          expectQuiet(errors);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  });

  test("every frame of a change of tab shows a tab drawn whole, the one leaving or the one opening, and no loading line", async ({ page, context, request }) => {
    await routeHouse(context);
    const errors = trackConsole(page);
    await recordFrames(page);
    // The development server builds each route on its first request; build
    // them first, so what is measured is the change of tab and not that.
    for (const address of ["/api/account/tokens", "/api/settings", "/api/instance/settings", "/api/assistant", "/api/health"]) {
      expect((await request.get(address)).status(), address).toBe(200);
    }
    await page.goto("/settings/account");
    await expect(card(page, "Account")).toBeVisible();
    await page.waitForLoadState("networkidle");
    // Each tab's first opening in this visit, then each again.
    for (const [tab] of DRAWN) await openDrawn(page, tab);
    for (const [tab] of DRAWN) await openDrawn(page, tab);
    expectQuiet(errors);
  });
});
