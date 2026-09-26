// Shared ground for the turn-in-flight suites: the pane's hooks, the
// seeding, and the send that learns its run's identity from the request
// the page made. Each suite owns its provider fixture and tool harness;
// these helpers read the page alone.
import { expect, type Page } from "@playwright/test";
import { addLayer, createMap, seedCsv } from "./support";

export const H = 900;
export const PANE = "[data-assistant-pane]";
export const runId = Date.now().toString(36);

export const door = (page: Page) => page.locator("header").getByRole("button", { name: /^(Open|Close) assistant$/ });
export const pane = (page: Page) => page.locator(PANE);
export const paneOpen = (page: Page) => expect(pane(page)).toHaveAttribute("data-open", "true");
export const composer = (page: Page) => pane(page).getByRole("textbox", { name: "Ask the assistant" });
export const sendButton = (page: Page) => pane(page).getByRole("button", { name: "Send", exact: true });
export const stopButton = (page: Page) => pane(page).getByRole("button", { name: "Stop", exact: true });
export const entries = (page: Page) => pane(page).locator("[data-record-entry]");
/** One view per turn, keyed by its run. */
export const turnView = (page: Page, run: string) => pane(page).locator(`[data-turn="${run}"]`);
type Json = Record<string, unknown>;
export async function api(page: Page, method: string, path: string, body?: unknown): Promise<Json> {
  return page.evaluate(async ({ method, path, body }) => {
    const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  }, { method, path, body });
}
export async function seed(page: Page) {
  await page.setViewportSize({ width: 1440, height: H });
  await page.goto("/maps");
  const table = `asst_turn_${runId}_${Math.random().toString(36).slice(2, 6)}`;
  await seedCsv(page, table, "name,lon,lat\nalpha,13.4,52.5\nbeta,13.5,52.6\n");
  const mapId = await createMap(page, `turn ${runId}`);
  const layerId = await addLayer(page, mapId, "Parks", `SELECT * FROM ${table}`);
  return { mapId, layerId, table };
}
/** Arriving on a page: the pane is closed on every page open, so a row
 * that reads it opens it by its door. */
export async function openPane(page: Page) {
  if ((await pane(page).getAttribute("data-open")) !== "true") await door(page).click();
  await paneOpen(page);
}
export async function onBuilder(page: Page, mapId: string) {
  await page.goto(`/maps/${mapId}`);
  await page.waitForSelector("[data-map-layer]");
  await openPane(page);
  await expect(composer(page)).toBeEnabled();
}
export async function box(locator: ReturnType<Page["locator"]>) {
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}
/** Send and learn the run's identity from the request the page made. */
export async function sendAndIdentify(page: Page, text: string): Promise<string> {
  const request = page.waitForRequest((r) => r.url().endsWith("/api/assistant/messages") && r.method() === "POST");
  await composer(page).fill(text);
  await sendButton(page).click();
  return (await request).postDataJSON().runId as string;
}
/** The pane read the outcome before the server settled: its door leads to the settled receipt. */
export async function settleDoor(page: Page) {
  const door = pane(page).getByRole("button", { name: "Check request outcome", exact: true });
  if (await door.count()) await door.click();
}
