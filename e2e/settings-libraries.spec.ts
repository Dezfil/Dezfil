// Settings' Libraries tab in a browser: a built-in style hidden leaves the
// builder's picker and the Maps tab's choices; a style added by its address
// is offered, taken by a map and removed while the map keeps it; style
// addresses switched off for single maps close a member's paste door and
// the API refuses the address in the same words; the
// satellite imagery saved, tested, credited and removed; a palette added and
// deleted; Reset then Undo over the Basemaps card, never an added style; and
// a search hit landing on its row. Every journey runs as the browser
// fixture's admin unless it says otherwise, and puts back what it changed.
//
// The instance must run on loopback away from port 3000 with
// DEZFIL_EGRESS_ALLOWLIST=127.0.0.1, so the server may read the style and
// the tile this spec serves from a fixture on this machine; nothing here
// reaches another machine. The satellite journey skips where the server's
// environment sets the tile address.
import { createServer, type Server } from "node:http";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { SINGLE_MAP_STYLES_OFF, SINGLE_MAP_STYLES_SETTING } from "../src/lib/basemap";
import { readThenWriteRequestSetup } from "./edit-basis";
import { isAllowedConsoleError } from "./console-allowlist";
import { closeAll, invitePerson, runTag, type Person } from "./sharing-support";
import { createMap, routeHouse, trackConsole, type ConsoleError } from "./support";

const SETTINGS = "/api/instance/settings";
const LIBRARY = "/api/instance/basemaps";
const SWITCHES = ["basemaps.dark", "basemaps.light", "basemaps.streets", "basemaps.satellite", "basemaps.singleMapStyles"];
/** One gray pixel: the tile every request for imagery gets. */
const TILE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN4+P//fwAJcwPdUbW8XQAAAABJRU5ErkJggg==", "base64");

let fixture: Server;
let fixtureUrl: string;

const basemaps = (page: Page) => page.locator("#card-basemaps");
const satellite = (page: Page) => page.locator("#card-satellite");
const palettes = (page: Page) => page.locator("#card-palettes");
const offer = (page: Page, name: string) => basemaps(page).getByRole("switch", { name: `Offer ${name}`, exact: true });
const answer = (page: Page) => page.locator("#settings-search-heading");
const settingsWrite = (page: Page) => page.waitForResponse(response =>
  new URL(response.url()).pathname === SETTINGS && response.request().method() === "PATCH");

function expectQuiet(errors: ConsoleError[]): void {
  expect(errors.filter(error => !isAllowedConsoleError(error.text, error.url))).toEqual([]);
}

/** Put the five switches and the imagery back to their defaults. */
async function restore(request: APIRequestContext, keys: string[] = SWITCHES): Promise<void> {
  const response = await request.patch(SETTINGS, { data: Object.fromEntries(keys.map(key => [key, null])) });
  expect(response.status()).toBe(200);
}

/** Remove every style this spec added, by its fixture address. */
async function removeOurStyles(request: APIRequestContext): Promise<void> {
  const read = await (await request.get(SETTINGS)).json() as { basemapStyles: { id: string; url: string }[] };
  for (const style of read.basemapStyles.filter(each => each.url.startsWith(fixtureUrl))) {
    expect((await request.delete(`${LIBRARY}/${style.id}`)).status()).toBe(200);
  }
}

async function deleteMap(request: APIRequestContext, id: string): Promise<void> {
  const response = await readThenWriteRequestSetup(request, `/api/maps/${id}`, () => ({ method: "DELETE" }));
  expect(response.status()).toBe(204);
}

/** Open the builder's Basemap tab on a map. */
async function builderBasemaps(page: Page, mapId: string): Promise<void> {
  await page.goto(`/maps/${mapId}`);
  await page.getByRole("tab", { name: "Basemap" }).click();
}

test.beforeEach(async ({ baseURL }) => {
  if (!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname) || new URL(baseURL).port === "3000") {
    throw new Error("requires an isolated loopback DEZFIL_BASE_URL away from port 3000");
  }
});

test.beforeAll(async () => {
  fixture = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    if (/^\/tiles\/\d+\/\d+\/\d+\.png$/.test(path)) {
      response.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" });
      response.end(TILE);
      return;
    }
    if (path.endsWith("/style.json")) {
      response.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      response.end(JSON.stringify({
        version: 8, name: "Fixture chart",
        sources: { chart: { type: "raster", tiles: [`${fixtureUrl}/tiles/{z}/{x}/{y}.png`], tileSize: 256, attribution: "Fixture Office" } },
        layers: [{ id: "chart", type: "raster", source: "chart" }],
      }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  fixtureUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
});

test.describe("Settings · Libraries", () => {
  test.describe.configure({ mode: "serial" });

  test("a built-in style hidden leaves the builder's picker and the Maps tab's choices, and comes back when offered", async ({ page, context, request }) => {
    await routeHouse(context);
    const errors = trackConsole(page);
    let mapId = "";
    await restore(request);
    try {
      await page.goto("/settings/libraries");
      await expect(offer(page, "Streets")).toBeChecked();
      const hidden = settingsWrite(page);
      await offer(page, "Streets").click();
      expect((await hidden).request().postDataJSON()).toEqual({ "basemaps.streets": false });
      await expect(basemaps(page).locator("#lib-style-streets [role=status]")).toHaveText("Saved");
      await expect(offer(page, "Streets")).not.toBeChecked();

      await page.goto("/settings/maps");
      const choices = page.getByRole("radiogroup", { name: "Basemap" }).getByRole("radio");
      await expect(choices).toHaveCount(3);
      await expect(page.getByRole("radiogroup", { name: "Basemap" }).getByRole("radio", { name: "Streets" })).toHaveCount(0);

      mapId = await createMap(page, `Libraries ${runTag()}`);
      await builderBasemaps(page, mapId);
      await expect(page.getByRole("button", { name: "Streets", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Dark", exact: true })).toBeVisible();

      await page.goto("/settings/libraries");
      const offered = settingsWrite(page);
      await offer(page, "Streets").click();
      expect((await offered).request().postDataJSON()).toEqual({ "basemaps.streets": true });
      await builderBasemaps(page, mapId);
      await expect(page.getByRole("button", { name: "Streets", exact: true })).toBeVisible();
    } finally {
      await restore(request);
      if (mapId) await deleteMap(request, mapId);
    }
    expectQuiet(errors);
  });

  test("a style added by its address is offered, taken by a map, and removed from the library while the map keeps it", async ({ page, context, request }) => {
    await routeHouse(context);
    const errors = trackConsole(page);
    const name = `Fixture chart ${runTag()}`;
    const url = `${fixtureUrl}/charts/style.json`;
    let mapId = "";
    try {
      await page.goto("/settings/libraries");
      await basemaps(page).getByRole("button", { name: "Add a style", exact: true }).click();
      await expect(basemaps(page)).toContainText("Its address is public to anyone who sees a map drawn on it, published readers included.");
      await basemaps(page).getByLabel("Name", { exact: true }).fill(name);
      await basemaps(page).getByLabel("Style address", { exact: true }).fill(url);
      const added = page.waitForResponse(response => new URL(response.url()).pathname === LIBRARY && response.request().method() === "POST");
      await basemaps(page).getByRole("button", { name: "Add style", exact: true }).click();
      expect((await added).status()).toBe(201);
      const row = basemaps(page).locator("li").filter({ hasText: name });
      await expect(row).toContainText(new URL(fixtureUrl).host);
      await expect(row.getByRole("status")).toHaveText("Added");
      await expect(row.getByRole("switch", { name: `Offer ${name}` })).toBeChecked();

      mapId = await createMap(page, `Libraries ${runTag()}`);
      await builderBasemaps(page, mapId);
      await page.getByRole("button", { name, exact: true }).click();
      await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute("data-active", "true");
      await expect.poll(async () => (await (await request.get(`/api/maps/${mapId}`)).json()).customBasemap?.url).toBe(url);

      await page.goto("/settings/libraries");
      await row.getByRole("button", { name: `Remove ${name}` }).click();
      const dialog = page.getByRole("dialog", { name: `Remove ${name}` });
      await expect(dialog).toContainText("Maps that already use it keep it.");
      await dialog.getByRole("button", { name: "Remove style", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(basemaps(page).locator("li").filter({ hasText: name })).toHaveCount(0);
      expect((await (await request.get(`/api/maps/${mapId}`)).json()).customBasemap?.url).toBe(url);
    } finally {
      await removeOurStyles(request);
      if (mapId) await deleteMap(request, mapId);
    }
    expectQuiet(errors);
  });

  test("with style addresses off for single maps, a member's builder refuses a pasted address in the instance's words", async ({ page, context, browser, request, baseURL }) => {
    await routeHouse(context);
    const people: Person[] = [];
    await restore(request);
    try {
      await page.goto("/settings/libraries");
      const single = basemaps(page).getByRole("switch", { name: "Style addresses on single maps", exact: true });
      await expect(single).toBeChecked();
      const off = settingsWrite(page);
      await single.click();
      expect((await off).request().postDataJSON()).toEqual({ "basemaps.singleMapStyles": false });

      const member = await invitePerson(browser, request, baseURL!, "Member", runTag());
      people.push(member);
      await routeHouse(member.context);
      const memberPage = await member.context.newPage();
      await memberPage.goto("/maps");
      const mapId = await createMap(memberPage, `Member map ${runTag()}`);
      await builderBasemaps(memberPage, mapId);
      // The paste door is closed, and says why beside it.
      const door = memberPage.getByRole("button", { name: "Custom…" });
      await expect(door).toBeDisabled();
      await expect(door).toHaveAccessibleDescription(SINGLE_MAP_STYLES_OFF);
      await expect(memberPage.getByText(SINGLE_MAP_STYLES_OFF, { exact: true })).toBeVisible();
      // The API refuses a pasted address in the same words, naming the switch, and the map keeps no style.
      const pasted = await readThenWriteRequestSetup(member.api, `/api/maps/${mapId}`, () => ({
        method: "PATCH", options: { data: { customBasemap: { url: `${fixtureUrl}/member/style.json` } } },
      }));
      expect(pasted.status()).toBe(403);
      expect((await pasted.json()).error).toEqual({ code: "basemap_not_offered", message: SINGLE_MAP_STYLES_OFF, setting: SINGLE_MAP_STYLES_SETTING });
      expect((await (await member.api.get(`/api/maps/${mapId}`)).json()).customBasemap).toBeNull();
      // A member never reaches Libraries: its address opens Account.
      await memberPage.goto("/settings/libraries#set-custom-styles");
      await expect(memberPage).toHaveURL(new URL("/settings/account", baseURL).href);
      await expect(memberPage.locator("#card-basemaps")).toHaveCount(0);
    } finally {
      await restore(request);
      await closeAll(people);
    }
  });

  test("the satellite imagery is saved, tested, credited and removed, and Satellite comes and goes in Basemaps", async ({ page, context, request }) => {
    const read = await (await request.get(SETTINGS)).json() as { settings: Record<string, { source: string }> };
    test.skip(read.settings.satelliteUrl.source === "environment", "the server's environment sets the tile address");
    await routeHouse(context);
    const errors = trackConsole(page);
    const template = `${fixtureUrl}/tiles/{z}/{x}/{y}.png`;
    try {
      await page.goto("/settings/libraries");
      await expect(satellite(page)).toContainText("Not set up");
      await expect(offer(page, "Satellite")).toHaveCount(0);
      const address = satellite(page).getByLabel("Satellite tile address", { exact: true });
      await address.fill(template);
      const saved = settingsWrite(page);
      await satellite(page).locator("#set-satellite-address").getByRole("button", { name: "Save", exact: true }).click();
      expect((await saved).request().postDataJSON()).toEqual({ satelliteUrl: template });
      await expect(address).toHaveValue("");
      await expect(satellite(page).locator("#set-satellite-address")).toContainText(fixtureUrl);
      await expect(offer(page, "Satellite")).toBeChecked();

      await satellite(page).getByRole("button", { name: "Test", exact: true }).click();
      await expect(satellite(page).locator("[data-answer]")).toHaveText(/^A tile arrived in [\d,]+ ms$/);
      await expect(satellite(page).locator("[data-answer]")).toHaveAttribute("data-answer", "passed");

      // The row's group carries the same name; the text box is the one to fill.
      const credit = satellite(page).getByRole("textbox", { name: "Credit", exact: true });
      await credit.fill("Imagery © Fixture Office");
      const credited = settingsWrite(page);
      await satellite(page).locator("#set-satellite-credit").getByRole("button", { name: "Save", exact: true }).click();
      expect((await credited).request().postDataJSON()).toEqual({ satelliteAttribution: "Imagery © Fixture Office" });
      await expect(satellite(page).locator("#set-satellite-credit [role=status]")).toHaveText("Saved");

      await satellite(page).getByRole("button", { name: "Remove Satellite tile address", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Remove the saved address" });
      await expect(dialog).toContainText("Satellite leaves the basemap pickers.");
      const removed = settingsWrite(page);
      await dialog.getByRole("button", { name: "Remove address", exact: true }).click();
      expect((await removed).request().postDataJSON()).toEqual({ satelliteUrl: null });
      await expect(satellite(page)).toContainText("Not set up");
      await expect(offer(page, "Satellite")).toHaveCount(0);
    } finally { await restore(request, ["satelliteUrl", "satelliteAttribution"]); }
    expectQuiet(errors);
  });

  test("a palette is added with its colors evenly spaced and deleted after its question", async ({ page, context, request }) => {
    await routeHouse(context);
    const errors = trackConsole(page);
    const label = `Fixture ramp ${runTag()}`;
    try {
      await page.goto("/settings/libraries");
      await palettes(page).getByRole("button", { name: "Add a palette", exact: true }).click();
      await palettes(page).getByLabel("Name", { exact: true }).fill(label);
      await expect(palettes(page).locator('input[type="color"]')).toHaveCount(5);
      await palettes(page).getByRole("button", { name: "Remove the last color" }).click();
      await expect(palettes(page).locator('input[type="color"]')).toHaveCount(4);
      const added = page.waitForResponse(response => new URL(response.url()).pathname === "/api/palettes" && response.request().method() === "POST");
      await palettes(page).getByRole("button", { name: "Add palette", exact: true }).click();
      const body = (await added).request().postDataJSON() as { label: string; stops: { position: number }[] };
      expect(body.label).toBe(label);
      expect(body.stops.map(stop => stop.position)).toEqual([0, 1 / 3, 2 / 3, 1]);
      const row = palettes(page).locator("li").filter({ hasText: label });
      await expect(row).toContainText("4 colors");
      await expect(row.getByRole("status")).toHaveText("Added");

      await row.getByRole("button", { name: `Delete ${label}` }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("Layers that use it keep their colors.");
      await dialog.getByRole("button", { name: "Delete palette", exact: true }).click();
      await expect(palettes(page).locator("li").filter({ hasText: label })).toHaveCount(0);
    } finally {
      const custom = (await (await request.get("/api/palettes")).json()).custom as { name: string; label: string }[];
      for (const palette of custom.filter(each => each.label === label)) await request.delete(`/api/palettes/${palette.name}`);
    }
    expectQuiet(errors);
  });

  test("Reset returns the five switches in one write, never an added style, and Undo puts them back", async ({ page, context, request }) => {
    await routeHouse(context);
    const errors = trackConsole(page);
    await restore(request);
    try {
      expect((await request.patch(SETTINGS, { data: { "basemaps.dark": false, "basemaps.singleMapStyles": false } })).status()).toBe(200);
      const style = await (await request.post(LIBRARY, { data: { name: `Hidden chart ${runTag()}`, url: `${fixtureUrl}/hidden/style.json` } })).json() as { id: string; name: string };
      expect((await request.patch(`${LIBRARY}/${style.id}`, { data: { offered: false } })).status()).toBe(200);

      await page.goto("/settings/libraries");
      const reset = basemaps(page).getByRole("button", { name: "Reset to defaults: Basemaps", exact: true });
      const undo = basemaps(page).getByRole("button", { name: "Undo reset to defaults: Basemaps", exact: true });
      const resetWrite = settingsWrite(page);
      await reset.click();
      expect((await resetWrite).request().postDataJSON()).toEqual(Object.fromEntries(SWITCHES.map(key => [key, null])));
      await expect(offer(page, "Dark")).toBeChecked();
      await expect(offer(page, style.name)).not.toBeChecked();
      await expect(undo).toBeFocused();
      const undoWrite = settingsWrite(page);
      await undo.click();
      expect((await undoWrite).request().postDataJSON()).toEqual({ "basemaps.dark": false, "basemaps.singleMapStyles": false });
      await expect(offer(page, "Dark")).not.toBeChecked();
      const library = (await (await request.get(SETTINGS)).json()).basemapStyles as { id: string; offered: boolean }[];
      expect(library.find(each => each.id === style.id)?.offered).toBe(false);
    } finally {
      await restore(request);
      await removeOurStyles(request);
    }
    expectQuiet(errors);
  });

  test("a search hit opens Libraries and marks its row", async ({ page, context, baseURL }) => {
    await routeHouse(context);
    const errors = trackConsole(page);
    await page.goto("/settings/account");
    const field = page.getByRole("searchbox", { name: "Search settings" });
    await field.fill("style addresses");
    await expect(answer(page)).toHaveText("1 result for “style addresses”");
    await page.getByRole("button", { name: /^Instance \/ Libraries · Style addresses on single maps/ }).click();
    await expect(page).toHaveURL(new URL("/settings/libraries#set-custom-styles", baseURL).href);
    await expect(page.locator("#set-custom-styles")).toHaveAttribute("data-marked", /^(|fading)$/);
    // A typed tile address is never found by what it holds.
    await satellite(page).getByLabel("Satellite tile address", { exact: true }).fill(`${fixtureUrl}/SEEDED-KEY-0010-PATH/{z}/{x}/{y}.png`);
    await field.fill("SEEDED-KEY");
    await expect(answer(page)).toHaveText("No settings match “SEEDED-KEY”");
    await field.fill("");
    await satellite(page).locator("#set-satellite-address").getByRole("button", { name: "Cancel", exact: true }).click();
    expectQuiet(errors);
  });
});
