// The four recovery paths against the same run's receipt: a dropped
// stream, a navigation during execution, a reload during a live run and a
// lost approval response each reproduce the receipt's identities, order
// and known outcomes, omitted detail marked, the message once, and zero
// further product dispatches (the tool harness) and provider calls (the
// fixture).
//
// Environment: the documented gate with the tool harness.
import { test, expect, type Page } from "@playwright/test";
import { assistantProviderFixture } from "./assistant-provider-fixture";
import { assistantToolHarness, harnessTarget } from "./assistant-tool-harness";
import { routeHouse } from "./support";
import { api, onBuilder, openPane, pane, runId, seed, sendAndIdentify, turnView } from "./assistant-turn-support";

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

test.describe("the four recovery paths against the same run's receipt", () => {
  type Receipt = { id: string; state: string; actions: { id: string; status: string }[]; confirmations?: { id: string; decision: string; callId?: string }[]; incomplete: boolean };
  /** The entries the receipt says the pane should show: its actions in
   * order, then the settled gates no action carries. */
  function expectedFromReceipt(receipt: Receipt): { id: string; status: string }[] {
    const ran = new Set(receipt.actions.map((a) => a.id));
    const gates = (receipt.confirmations ?? []).filter((c) => c.decision === "superseded" || !(c.callId && ran.has(c.callId))).map((c) => ({ id: `confirmation:${c.id}`, status: "refused" }));
    return [...receipt.actions.map((a) => ({ id: a.id, status: a.status === "attempted" ? "running" : a.status })), ...gates];
  }
  async function shown(page: Page, runId: string) {
    return pane(page).locator(`[data-turn="${runId}"] [data-record-entry]`).evaluateAll((els) => els.map((el) => ({ id: el.getAttribute("data-record-entry")!, status: el.getAttribute("data-status")! })));
  }
  async function agreesWithReceipt(page: Page, runId: string, message: string) {
    const receipt = await api(page, "GET", `/api/assistant/runs/${runId}`) as unknown as Receipt;
    await expect.poll(() => shown(page, runId), { timeout: 15_000 }).toEqual(expectedFromReceipt(receipt));
    await expect(pane(page).locator("[data-turn-message]").filter({ hasText: message })).toHaveCount(1);
    if (receipt.incomplete) await expect(pane(page).getByText("omitted", { exact: false })).toBeVisible();
    return receipt;
  }

  test("a dropped stream, a navigation during execution, a reload during a live run and a lost approval response each recover the receipt with zero replay", async ({ page }) => {
    const { mapId, layerId, table } = await seed(page);
    const recipe = await api(page, "POST", "/api/recipes", { name: `turn workflow ${runId}` }) as { recipe: { id: string } };
    void table;
    await onBuilder(page, mapId);
    // Path 1: a dropped stream.
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Dropped" } }] }, { text: "Renamed after the drop." });
    await page.route("**/api/assistant/messages", async (route) => { const response = await route.fetch(); await response.body(); await route.abort("connectionreset"); }, { times: 1 });
    const dropped = await sendAndIdentify(page, "Drop me");
    await expect(pane(page).getByText("Renamed after the drop.", { exact: true })).toBeVisible({ timeout: 15_000 });
    let dispatches = harness.dispatches.length; let captures = provider.captures.length;
    await agreesWithReceipt(page, dropped, "Drop me");
    await page.waitForTimeout(300);
    expect(harness.dispatches.length).toBe(dispatches); expect(provider.captures.length).toBe(captures);
    // Path 2: a navigation during execution.
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Departed" } }] }, { text: "Still thinking.", holdMs: 8000 });
    const departed = await sendAndIdentify(page, "Depart me");
    await expect(turnView(page, departed).locator("[data-record-entry][data-tool='update_layer']")).toHaveAttribute("data-status", "succeeded");
    await expect.poll(() => provider.captures.length).toBe(captures + 2);
    dispatches = harness.dispatches.length; captures = provider.captures.length;
    await page.getByRole("link", { name: "SQL", exact: true }).click();
    await expect(page.getByLabel("SQL editor")).toBeVisible();
    await openPane(page);
    const door = pane(page).getByRole("button", { name: "Check request outcome", exact: true });
    await expect.poll(async () => { if (await door.count()) await door.click(); return (await api(page, "GET", `/api/assistant/runs/${departed}`) as { state: string }).state; }, { timeout: 15_000 }).not.toBe("running");
    if (await door.count()) await door.click();
    await agreesWithReceipt(page, departed, "Depart me");
    await page.waitForTimeout(300);
    expect(harness.dispatches.length).toBe(dispatches); expect(provider.captures.length).toBe(captures);
    // Path 3: a reload during a live run.
    await page.getByRole("link", { name: "Maps", exact: true }).click();
    await page.getByRole("link", { name: `turn ${runId}` }).first().click();
    await page.waitForSelector("[data-map-layer]");
    await openPane(page);
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Reloaded" } }] }, { text: "Still thinking after the rename.", holdMs: 8000 });
    const reloaded = await sendAndIdentify(page, "Reload me");
    await expect(turnView(page, reloaded).locator("[data-record-entry][data-tool='update_layer']")).toHaveAttribute("data-status", "succeeded");
    await expect.poll(() => provider.captures.length).toBe(captures + 2);
    dispatches = harness.dispatches.length; captures = provider.captures.length;
    await page.reload();
    await page.waitForSelector("[data-map-layer]");
    await openPane(page);
    await expect.poll(async () => { if (await door.count()) await door.click(); return (await api(page, "GET", `/api/assistant/runs/${reloaded}`) as { state: string }).state; }, { timeout: 15_000 }).not.toBe("running");
    if (await door.count()) await door.click();
    await agreesWithReceipt(page, reloaded, "Reload me");
    await page.waitForTimeout(300);
    expect(harness.dispatches.length).toBe(dispatches); expect(provider.captures.length).toBe(captures);
    // Path 4: a lost approval response.
    provider.replies.push({ calls: [{ name: "publish_map", args: { id: mapId } }] }, { text: "Published after the loss." });
    const approved = await sendAndIdentify(page, "Publish me");
    await expect(pane(page).locator("[data-confirmation]")).toBeVisible();
    await page.route("**/api/assistant/messages", async (route) => { const response = await route.fetch(); await response.body(); await route.abort("connectionreset"); }, { times: 1 });
    await pane(page).locator("[data-confirmation]").getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(pane(page).getByText("Published after the loss.", { exact: true })).toBeVisible({ timeout: 15_000 });
    dispatches = harness.dispatches.length; captures = provider.captures.length;
    const receipt = await agreesWithReceipt(page, approved, "Publish me");
    expect(receipt.actions.find((a) => a.id)).toBeTruthy();
    expect((await api(page, "GET", `/api/maps/${mapId}`) as { publishToken: string | null }).publishToken).toEqual(expect.any(String));
    expect(harness.dispatches.filter((d) => d.path.includes("/publish")).length, "one publish dispatch").toBe(1);
    await page.waitForTimeout(300);
    expect(harness.dispatches.length).toBe(dispatches); expect(provider.captures.length).toBe(captures);
    void recipe;
  });
});
