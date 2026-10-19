// Clearing the conversation: what the control removes, what the next
// message's request then carries, what clearing does not touch, and its
// keyboard reach. The claims that matter are read where the pane cannot
// fake them — the body the route actually receives, the messages the
// provider actually sees, and the counters on the server's side of
// loopback — rather than from the pane's own state, which the unit rows in
// src/components/builder/assistant/clear-control.test.tsx already hold.
//
// Environment: the documented gate with the tool harness: the instance
// booted with the harness preload naming 3303 as its own address, the
// scripted provider on 3202. Run with DEZFIL_BASE_URL at the server.
import { test, expect, type Page } from "@playwright/test";
import { assistantProviderFixture } from "./assistant-provider-fixture";
import { assistantToolHarness, harnessTarget } from "./assistant-tool-harness";
import { mapSaveArrived, routeHouse } from "./support";
import { api, composer, onBuilder, pane, seed, sendAndIdentify } from "./assistant-turn-support";

/** Everything the page asks the instance for, from arming to disarming:
 * the pane's own traffic, a cancellation and an abandonment included. A
 * test's verification reads go through the same channel, so they are
 * taken outside the armed window rather than filtered out of it. */
function pageRequests(page: Page) {
  const seen: string[] = [];
  const listen = (request: { url: () => string; method: () => string }) => {
    const url = new URL(request.url());
    // The builder still attempts its timed capture while the retired upload
    // refuses it. That background request is unrelated to clearing the pane.
    if (request.method() === "PUT" && /^\/api\/maps\/[^/]+\/thumbnail$/.test(url.pathname)) return;
    if (url.pathname.startsWith("/api/")) seen.push(`${request.method()} ${url.pathname}`);
  };
  page.on("request", listen);
  return { seen, stop: () => page.off("request", listen) };
}

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

/** The builder persists its viewport on its own debounced schedule, so a
 * map save started before a row begins can land in the middle of it and be
 * read as the clear's doing. Both rows below wait for that traffic to go
 * quiet first: two identical reads of the whole map, taken apart, mean the
 * debounce has flushed. It waits for silence rather than asserting it, so
 * it can never itself be the thing that fails. */
async function mapQuiet(page: Page, mapId: string) {
  let last = JSON.stringify(await api(page, "GET", `/api/maps/${mapId}`));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(300);
    const now = JSON.stringify(await api(page, "GET", `/api/maps/${mapId}`));
    if (now === last) return;
    last = now;
  }
}

const clearControl = (page: Page) => pane(page).getByRole("button", { name: "Clear conversation", exact: true });
const turns = (page: Page) => pane(page).locator("[data-turn]");
/** The words the provider was actually given on its nth call. */
const said = (call: { input: { role?: string; content?: unknown }[] }) => JSON.stringify(call.input);

/** One settled turn, so there is something to clear. */
async function oneTurn(page: Page, message: string, reply: string) {
  provider.replies.push({ text: reply });
  await sendAndIdentify(page, message);
  await expect(pane(page).getByText(reply, { exact: true })).toBeVisible();
}

test.describe("clearing the conversation", () => {
  test("empties the pane with no dialog, and the next message's request carries no history", async ({ page }) => {
    const { mapId } = await seed(page);
    await onBuilder(page, mapId);
    await oneTurn(page, "Remember the number 41", "Noted, 41.");
    await composer(page).fill("and the stations too");

    await expect(clearControl(page)).toBeEnabled();
    await clearControl(page).click();

    // Nothing asks, and nothing is left: the control goes with the
    // conversation, because there is no longer anything to clear.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(turns(page)).toHaveCount(0);
    await expect(pane(page).locator("[data-record-entry]")).toHaveCount(0);
    await expect(composer(page)).toHaveValue("");
    await expect(clearControl(page)).toHaveCount(0);

    // The claim that decides this criterion: the body the route receives.
    provider.replies.push({ text: "I have no idea." });
    const request = page.waitForRequest((r) => r.url().endsWith("/api/assistant/messages") && r.method() === "POST");
    await composer(page).fill("What number did I ask you to remember?");
    await pane(page).getByRole("button", { name: "Send", exact: true }).click();
    const body = (await request).postDataJSON() as { history?: unknown[]; message: string };
    expect(body.history ?? [], "the cleared conversation still reached the route").toEqual([]);
    await expect(pane(page).getByText("I have no idea.", { exact: true })).toBeVisible();

    // And what the model was actually given, which is the point of the
    // history: the second call carries nothing of the first.
    expect(provider.captures).toHaveLength(2);
    expect(said(provider.captures[0])).toContain("Remember the number 41");
    expect(said(provider.captures[1])).not.toContain("Remember the number 41");
    expect(said(provider.captures[1])).not.toContain("Noted, 41.");
  });

  test("is offered only where there is something to clear, and not while a turn is in flight", async ({ page }) => {
    const { mapId } = await seed(page);
    await onBuilder(page, mapId);
    await expect(clearControl(page)).toHaveCount(0);
    provider.replies.push({ chunks: ["Done", "."], hold: { chunks: true } });
    await sendAndIdentify(page, "Take your time");
    await provider.reached("0:chunk:0");
    await expect(clearControl(page)).toBeDisabled();
    provider.release("0:chunk:0");
    await expect(pane(page).getByText("Done.", { exact: true })).toBeVisible();
    await expect(clearControl(page)).toBeEnabled();
  });
});

test.describe("what clearing does not do", () => {
  test("dispatches nothing, cancels nothing and abandons nothing the server holds", async ({ page }) => {
    const { mapId } = await seed(page);
    await onBuilder(page, mapId);

    // A turn that leaves the server something to hold: a settled run with
    // a receipt, and a product dispatch behind it.
    provider.replies.push({ calls: [{ name: "list_tables", args: {} }] }, { text: "Listed." });
    const runId = await sendAndIdentify(page, "List the tables");
    await expect(pane(page).getByText("Listed.", { exact: true })).toBeVisible();

    // Verification reads, taken before the window is armed, with the map's
    // own background saves already flushed.
    await mapQuiet(page, mapId);
    const before = {
      receipt: await api(page, "GET", `/api/assistant/runs/${runId}`),
      pending: await api(page, "GET", "/api/assistant/pending"),
      dispatches: harness.dispatches.length,
      reads: harness.reads.length,
      providerCalls: provider.captures.length,
    };
    expect(before.dispatches + before.reads, "no loop request reached the harness: boot the instance with the harness preload").toBeGreaterThan(0);

    const watch = pageRequests(page);
    await clearControl(page).click();
    await expect(turns(page)).toHaveCount(0);
    // A stray request would be dispatched in the same tick as the click;
    // this window is long enough for one to appear and be counted.
    await page.waitForTimeout(500);
    watch.stop();

    expect(watch.seen, "clearing dispatched something").toEqual([]);
    expect(harness.dispatches.length, "clearing reached a product operation").toBe(before.dispatches);
    expect(harness.reads.length, "clearing read a product operation").toBe(before.reads);
    expect(provider.captures.length, "clearing called the provider").toBe(before.providerCalls);

    // Verification reads again, outside the window: what the server holds
    // is exactly what it held, so nothing was cancelled or abandoned.
    expect(await api(page, "GET", `/api/assistant/runs/${runId}`)).toEqual(before.receipt);
    expect(await api(page, "GET", "/api/assistant/pending")).toEqual(before.pending);
  });

  test("the counters detect a request and a dispatch, so the zeroes above are findings", async ({ page }) => {
    const { mapId } = await seed(page);
    await onBuilder(page, mapId);
    await oneTurn(page, "First", "First done.");

    // The page counter, against one deliberate request in its window.
    const watch = pageRequests(page);
    await api(page, "GET", "/api/assistant/pending");
    await page.waitForTimeout(100);
    watch.stop();
    expect(watch.seen).toContain("GET /api/assistant/pending");

    // The harness counter, against one deliberate product dispatch: the
    // later submission is counted here, separately from the clear's window.
    const before = harness.dispatches.length + harness.reads.length;
    provider.replies.push({ calls: [{ name: "list_tables", args: {} }] }, { text: "Listed." });
    await sendAndIdentify(page, "List the tables");
    await expect(pane(page).getByText("Listed.", { exact: true })).toBeVisible();
    expect(harness.dispatches.length + harness.reads.length).toBeGreaterThan(before);
  });
});

test.describe("what clearing leaves alone", () => {
  test("leaves the map, its undo history and the remembered choice exactly as they were", async ({ page }) => {
    const { mapId } = await seed(page);
    await onBuilder(page, mapId);

    // A pick to remember, where the instance offers one; where it offers
    // a single model there is no picker and nothing to preserve, and the
    // row says so rather than passing silently. The last offered model is
    // the one with no levels of its own, so the turn below also carries
    // the provider-default entry for such a model through the route.
    const chip = pane(page).locator("[data-model-picker]");
    const picked = await chip.count() > 0;
    if (picked) {
      await chip.click();
      const items = pane(page).locator("[data-model-menu] [data-model]");
      await items.last().click();
    }
    const chipBefore = picked ? await chip.textContent() : null;

    // A map edit, so the undo history has a step to lose.
    const undo = page.getByRole("button", { name: /^Undo/ });
    const zoomed = mapSaveArrived(page);
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await zoomed;
    await oneTurn(page, "Say something", "Something.");
    await mapQuiet(page, mapId);
    const before = {
      map: await api(page, "GET", `/api/maps/${mapId}`),
      layers: await api(page, "GET", `/api/maps/${mapId}/layers`),
      undoEnabled: await undo.isEnabled(),
    };

    await clearControl(page).click();
    await expect(turns(page)).toHaveCount(0);

    // Each compared on its own, so one holding does not stand for another.
    expect(await api(page, "GET", `/api/maps/${mapId}`), "the map changed").toEqual(before.map);
    expect(await api(page, "GET", `/api/maps/${mapId}/layers`), "the layers changed").toEqual(before.layers);
    expect(await undo.isEnabled(), "the undo history changed").toBe(before.undoEnabled);
    if (picked) expect(await chip.textContent(), "the remembered choice changed").toBe(chipBefore);
    else expect(chip, "this instance offers one model, so no choice was exercised here").toHaveCount(0);
  });
});

test.describe("the clear control from the keyboard", () => {
  test("is reached by tabbing, activated by Enter, and leaves focus in the composer", async ({ page }) => {
    const { mapId } = await seed(page);
    await onBuilder(page, mapId);
    await oneTurn(page, "Buffer the parks", "Buffered.");

    // Reached from the keyboard rather than by a click, and named while
    // it is reached, which is what a screen reader will say. The control
    // stands in the pane's header, above the transcript, so it lies
    // backwards from the composer; forwards from there are the picker and
    // the Send slot, and then the page behind the pane.
    await composer(page).focus();
    const named = async () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? "");
    let hops = 0;
    while (await named() !== "Clear conversation" && hops < 8) { await page.keyboard.press("Shift+Tab"); hops += 1; }
    expect(await named(), "the clear control was not reachable by Tab from the composer").toBe("Clear conversation");

    await page.keyboard.press("Enter");
    await expect(turns(page)).toHaveCount(0);
    await expect(composer(page)).toBeFocused();
  });
});
