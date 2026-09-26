// Stop during execution and the confirmation branches ('s approve and
// decline branches): the four cancellation cases against real contract (a
// cancelled provider generation, an interrupted read-only call, a
// dispatched mutation settling to its real outcome, a lost mutation
// outcome recorded uncertain), nothing admitted after cancellation takes
// effect, counted at the tool harness and the provider fixture; and a
// decline with a following call under 0057. The parked turn ended by Stop
// is in assistant-turn.spec.ts.
//
// Environment: the documented gate with the tool harness.
import { test, expect, type Page } from "@playwright/test";
import { assistantProviderFixture } from "./assistant-provider-fixture";
import { assistantToolHarness, harnessTarget } from "./assistant-tool-harness";
import { routeHouse } from "./support";
import { api, composer, onBuilder, pane, seed, sendAndIdentify, settleDoor, stopButton, turnView } from "./assistant-turn-support";

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

test.describe("Stop during execution, four cases, nothing admitted after", () => {
  async function stopAndWatch(page: Page, runId: string) {
    const cancelled = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith(`/api/assistant/runs/${runId}/cancel`));
    await stopButton(page).click();
    await cancelled;
    await expect.poll(async () => (await api(page, "GET", `/api/assistant/runs/${runId}`) as { state: string }).state, { timeout: 15_000 }).not.toBe("running");
  }

  test("a cancelled provider generation: the received text stays, the run is interrupted, no dispatch, no further provider call", async ({ page }) => {
    const { mapId } = await seed(page);
    await onBuilder(page, mapId);
    provider.replies.push({ chunks: ["Partial ", "never arrives."], hold: { chunks: true } });
    const runId = await sendAndIdentify(page, "Say a lot");
    await provider.reached("0:chunk:0");
    await expect(turnView(page, runId).locator("[data-turn-answer]")).toContainText("Partial");
    await stopAndWatch(page, runId);
    await settleDoor(page);
    await expect(pane(page).getByText("The request stopped.", { exact: false })).toBeVisible();
    await expect(composer(page)).toBeEnabled();
    const receipt = await api(page, "GET", `/api/assistant/runs/${runId}`) as { state: string; text: string };
    expect(receipt.state).toBe("interrupted");
    expect(receipt.text).toBe("Partial ");
    await expect(turnView(page, runId).locator("[data-turn-answer]")).toContainText("Partial");
    provider.release("0:chunk:0");
    await page.waitForTimeout(400);
    expect(harness.dispatches).toEqual([]);
    expect(provider.captures).toHaveLength(1);
  });

  test("an interrupted read-only call: the line reads interrupted, no mutation, nothing after", async ({ page }) => {
    const { mapId } = await seed(page);
    await onBuilder(page, mapId);
    harness.barrier("read", (method, path) => method === "POST" && path.startsWith("/api/query"));
    provider.replies.push({ calls: [{ name: "run_sql", args: { sql: "SELECT count(*) FROM range(1000)" } }, { name: "create_map", args: { name: "Never" } }] }, { text: "Never said." });
    const runId = await sendAndIdentify(page, "Count then create");
    await harness.reached("read");
    await expect(turnView(page, runId).locator("[data-record-entry][data-tool='run_sql']")).toHaveAttribute("data-status", "running");
    await stopAndWatch(page, runId);
    harness.release("read");
    await settleDoor(page);
    const line = turnView(page, runId).locator("[data-record-entry][data-tool='run_sql']");
    await expect(line).toHaveAttribute("data-status", "refused");
    // The interruption's own words ride the stream this pane aborted, so the
    // settled line carries the receipt's refusal; the receipt itself records
    // the action refused, never done.
    await expect(line.getByRole("button")).toContainText(/The read was interrupted before completion\.|The action was refused\./);
    expect((await api(page, "GET", `/api/assistant/runs/${runId}`) as { actions: { status: string }[] }).actions[0].status).toBe("refused");
    await expect(turnView(page, runId).locator("[data-record-entry]")).toHaveCount(1);
    await expect(composer(page)).toBeEnabled();
    await page.waitForTimeout(400);
    expect(harness.dispatches.filter((d) => d.path.startsWith("/api/maps")), "no mutation after the stop").toEqual([]);
    const maps = await api(page, "GET", "/api/maps") as unknown as { name: string }[];
    expect(maps.some((m) => m.name === "Never")).toBe(false);
    expect(provider.captures).toHaveLength(1);
  });

  test("a dispatched mutation settles to its real outcome after Stop: the pane waits on the outcome read, then shows it done, the resource changed once", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    harness.barrier("rename", (method, path) => method === "PATCH" && path.startsWith("/api/layers/"));
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Settled after stop" } }, { name: "create_map", args: { name: "Never" } }] }, { text: "Never said." });
    const runId = await sendAndIdentify(page, "Rename then create");
    await harness.reached("rename");
    const cancelled = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith(`/api/assistant/runs/${runId}/cancel`));
    await stopButton(page).click();
    await cancelled;
    // The mutation is still dispatched: the run stays running until it settles, and the pane says so.
    await expect(pane(page).getByText("still settling", { exact: false })).toBeVisible({ timeout: 15_000 });
    expect((await api(page, "GET", `/api/assistant/runs/${runId}`) as { state: string }).state).toBe("running");
    harness.release("rename");
    await expect.poll(async () => (await api(page, "GET", `/api/assistant/runs/${runId}`) as { state: string }).state, { timeout: 15_000 }).toBe("interrupted");
    await pane(page).getByRole("button", { name: "Check request outcome", exact: true }).click();
    const line = turnView(page, runId).locator("[data-record-entry][data-tool='update_layer']");
    await expect(line).toHaveAttribute("data-status", "succeeded");
    await expect(line.getByRole("button")).toContainText("Updated the layer Settled after stop");
    await expect(turnView(page, runId).locator("[data-record-entry]")).toHaveCount(1);
    expect((await api(page, "GET", `/api/layers/${layerId}`) as { name: string }).name).toBe("Settled after stop");
    await page.waitForTimeout(400);
    expect(harness.dispatches.filter((d) => d.method === "PATCH").length).toBe(1);
    expect(harness.dispatches.filter((d) => d.path.startsWith("/api/maps"))).toEqual([]);
    expect(provider.captures).toHaveLength(1);
    await expect(composer(page)).toBeEnabled();
  });

  test("a lost mutation outcome is recorded uncertain after Stop: the resource changed, the line uncertain, nothing after", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    harness.barrier("rename", (method, path) => method === "PATCH" && path.startsWith("/api/layers/"), { lose: true });
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "Lost outcome" } }, { name: "create_map", args: { name: "Never" } }] }, { text: "Never said." });
    const runId = await sendAndIdentify(page, "Rename then create");
    await harness.reached("rename");
    const cancelled = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith(`/api/assistant/runs/${runId}/cancel`));
    await stopButton(page).click();
    await cancelled;
    harness.release("rename");
    await expect.poll(async () => (await api(page, "GET", `/api/assistant/runs/${runId}`) as { state: string }).state, { timeout: 15_000 }).not.toBe("running");
    const door = pane(page).getByRole("button", { name: "Check request outcome", exact: true });
    if (await door.count()) await door.click();
    const line = turnView(page, runId).locator("[data-record-entry][data-tool='update_layer']");
    await expect(line).toHaveAttribute("data-status", "uncertain");
    await expect(line.getByRole("button")).toContainText("The outcome is uncertain. Check the affected data.");
    expect((await api(page, "GET", `/api/layers/${layerId}`) as { name: string }).name, "the mutation happened").toBe("Lost outcome");
    await page.waitForTimeout(400);
    expect(harness.dispatches.filter((d) => d.method === "PATCH").length).toBe(1);
    expect(harness.dispatches.filter((d) => d.path.startsWith("/api/maps"))).toEqual([]);
    expect(provider.captures).toHaveLength(1);
    await expect(composer(page)).toBeEnabled();
  });
});

test.describe("task 14: the confirmation branches", () => {
  test("a decline with a following call: the continuation wears the running controls, its call runs and is recorded, then Send", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    provider.replies.push({ calls: [{ name: "publish_map", args: { id: mapId } }] });
    const runId = await sendAndIdentify(page, "Publish, and if not, rename");
    const card = pane(page).locator("[data-confirmation]");
    await expect(card).toBeVisible();
    harness.barrier("rename", (method, path) => method === "PATCH" && path.startsWith("/api/layers/"));
    provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name: "After the decline" } }] }, { text: "Not published; renamed instead." });
    await card.getByRole("button", { name: "Cancel", exact: true }).click();
    await harness.reached("rename");
    await expect(pane(page).locator("[data-slot-control]")).toHaveAttribute("data-slot-control", "stop");
    await expect(turnView(page, runId).locator("[data-record-entry][data-tool='update_layer']")).toHaveAttribute("data-status", "running");
    harness.release("rename");
    await expect(pane(page).getByText("Not published; renamed instead.", { exact: true })).toBeVisible();
    await expect(pane(page).locator("[data-slot-control]")).toHaveAttribute("data-slot-control", "send");
    const entries = turnView(page, runId).locator("[data-record-entry]");
    await expect(entries).toHaveCount(2);
    await expect(entries.nth(0)).toHaveAttribute("data-tool", "publish_map");
    await expect(entries.nth(0).getByRole("button")).toContainText("You cancelled it, so this was not done.");
    await expect(entries.nth(1)).toHaveAttribute("data-status", "succeeded");
    expect((await api(page, "GET", `/api/maps/${mapId}`) as { publishToken: string | null }).publishToken).toBeNull();
    expect((await api(page, "GET", `/api/layers/${layerId}`) as { name: string }).name).toBe("After the decline");
    expect(harness.dispatches.filter((d) => d.path.includes("/publish")).length).toBe(0);
    // The turn's exchange, the continuation after the decline, and the continuation after its call.
    expect(provider.captures).toHaveLength(3);
  });
});

