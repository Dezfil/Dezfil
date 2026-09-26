// The note in the transcript (of inside turn presentation): one line among
// the turn's action lines, live and settled, with the 44 px thumbnail read
// from the retained image and the observation's displayed sentence
// withheld from the answer; the two approved interactions (the thumbnail
// opening exactly the retained image, the inspection through the record's
// expander); each lifecycle state's words; a failed check with no
// thumbnail and no observation; the four recovery paths reproducing the
// note from the receipt at zero further dispatches, renders and provider
// calls; and an evicted image saying it is not kept while the facts stay.
//
// Environment: the documented gate with the tool harness plus the render
// stub preload: the instance booted with both preloads,
// DEZFIL_E2E_RENDER_STUB=1 and a retention of two renders
// (DEZFIL_ASSISTANT_LOOK_RETENTION=2), the scripted provider on 3202.
// Renders are counted as the check's dispatches at the harness.
import { test, expect, type Page } from "@playwright/test";
import { assistantProviderFixture } from "./assistant-provider-fixture";
import { assistantToolHarness, harnessTarget } from "./assistant-tool-harness";
import { routeHouse } from "./support";
import { api, onBuilder, openPane, pane, runId, seed, sendAndIdentify, settleDoor, stopButton, turnView } from "./assistant-turn-support";

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

const OBSERVATION = "Five greens read light to dark.";
const looks = () => harness.dispatches.filter((d) => d.path.startsWith("/api/maps/look")).length;
const checkEntry = (page: Page, run: string) => turnView(page, run).locator("[data-record-entry][data-tool='look_at_map']");
const thumb = (page: Page, run: string) => checkEntry(page, run).locator("[data-check-thumb]");
const thumbImage = (page: Page, run: string) => thumb(page, run).locator("img");
const observation = (page: Page, run: string) => checkEntry(page, run).locator("[data-observation]");
const answer = (page: Page, run: string) => turnView(page, run).locator("[data-turn-answer]");
/** A map-changing turn whose observation reply is the given text. */
function scriptCheckedTurn(layerId: string, name: string, observationReply: Parameters<typeof provider.replies.push>[0] = { text: OBSERVATION + " The legend matches the ramp." }) {
  provider.replies.push({ calls: [{ name: "update_layer", args: { id: layerId, name } }] }, { text: `Renamed to ${name}.` }, observationReply);
}
async function settled(page: Page, run: string) {
  await expect(turnView(page, run)).not.toHaveAttribute("data-live", "true", { timeout: 20_000 });
}

test.describe("the gate's wiring", () => {
  test("a scripted map-changing turn dispatches the check through the harness, so a render count can go red", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    scriptCheckedTurn(layerId, "Wired");
    const run = await sendAndIdentify(page, "Rename the layer");
    await settled(page, run);
    expect(looks(), "no check reached the harness: boot the instance with both preloads and DEZFIL_E2E_RENDER_STUB=1").toBe(1);
    expect(provider.captures).toHaveLength(3);
  });
});

test.describe("the note, live and settled", () => {
  test("the note is the last action line, live with its thumbnail before the words and settled with them, the sentence withheld from the answer", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    scriptCheckedTurn(layerId, "Live", { chunks: [OBSERVATION + " ", "The legend matches the ramp."], hold: { first: true } });
    const run = await sendAndIdentify(page, "Rename the layer");
    await provider.reached("2:first");
    // Live: the check settled, its observation awaited, the thumbnail already a picture.
    const entry = checkEntry(page, run);
    await expect(entry).toHaveAttribute("data-status", "succeeded");
    await expect(observation(page, run)).toHaveAttribute("data-observation-state", "awaited");
    await expect(thumbImage(page, run)).toBeVisible();
    expect(await thumbImage(page, run).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    const box = await thumb(page, run).boundingBox();
    expect(Math.round(box!.width)).toBe(44);
    await expect(entry.locator("[data-check-words]")).toContainText("Checked the map.");
    const order = await turnView(page, run).locator("[data-record-entry]").evaluateAll((els) => els.map((el) => el.getAttribute("data-tool")));
    expect(order).toEqual(["update_layer", "look_at_map"]);
    provider.release("2:first");
    await expect(observation(page, run)).toHaveText(OBSERVATION, { timeout: 15_000 });
    await settled(page, run);
    // Settled: the same line, the same order, the sentence withheld from the answer and the rest kept.
    await expect(observation(page, run)).toHaveAttribute("data-observation-state", "captured");
    await expect(observation(page, run)).toHaveText(OBSERVATION);
    await expect(answer(page, run)).toContainText("Renamed to Live.");
    await expect(answer(page, run)).toContainText("The legend matches the ramp.");
    expect(await answer(page, run).innerText()).not.toContain(OBSERVATION);
    expect(await turnView(page, run).locator("[data-record-entry]").evaluateAll((els) => els.map((el) => el.getAttribute("data-tool")))).toEqual(["update_layer", "look_at_map"]);
    // The record sits above the answer, live and settled.
    const recordBox = (await entry.boundingBox())!; const answerBox = (await answer(page, run).boundingBox())!;
    expect(recordBox.y + recordBox.height).toBeLessThanOrEqual(answerBox.y + 1);
  });
  test("an overlong sentence is cut at a word under 240 characters with its tail in the answer; two identical sentences withhold exactly one", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    const words: string[] = []; for (let i = 0; words.join(" ").length < 400; i += 1) words.push(`word${i}`);
    const long = words.join(" ") + ".";
    scriptCheckedTurn(layerId, "Long", { text: long + " Then a short one." });
    const run = await sendAndIdentify(page, "Rename the layer");
    await settled(page, run);
    const shown = (await observation(page, run).innerText()).trim();
    expect(shown.length).toBeLessThanOrEqual(240);
    expect(shown.endsWith(" ")).toBe(false);
    expect(long.startsWith(shown)).toBe(true);
    expect(long[shown.length]).toBe(" ");
    const answered = await answer(page, run).innerText();
    expect(answered).toContain(long.slice(shown.length + 1));
    expect(answered).toContain("Then a short one.");
    expect(answered).not.toContain(shown);
    scriptCheckedTurn(layerId, "Twice", { text: "Looks fine. Looks fine." });
    const twice = await sendAndIdentify(page, "Rename it again");
    await settled(page, twice);
    await expect(observation(page, twice)).toHaveText("Looks fine.");
    expect((await answer(page, twice).innerText()).match(/Looks fine\./g)).toHaveLength(1);
  });
  test("markdown stays literal on the line; the identifier is off the line; the inspection carries the render identity, state, appearance and sizes and claims no undo", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    scriptCheckedTurn(layerId, "Marked", { text: "**Five** greens read `light` to dark. More." });
    const run = await sendAndIdentify(page, "Rename the layer");
    await settled(page, run);
    await expect(observation(page, run)).toHaveText("**Five** greens read `light` to dark.");
    expect(await observation(page, run).locator("strong, code").count()).toBe(0);
    const entry = checkEntry(page, run);
    expect(await entry.locator("button.line, [data-check-words]").first().innerText()).not.toContain("look_at_map");
    await entry.getByRole("button", { expanded: false }).last().click();
    const inspection = entry.locator("[data-inspection]");
    await expect(inspection).toBeVisible();
    const receipt = await api(page, "GET", `/api/assistant/runs/${run}`) as { actions: { tool: string; render?: { id: string; state: { digest: string }; appearance: string; image: { width: number; height: number; bytes: number }; source: { width: number; height: number } } }[] };
    const facts = receipt.actions.find((a) => a.tool === "look_at_map")!.render!;
    await expect(inspection.locator("[data-render-id]")).toHaveText(facts.id);
    await expect(inspection.locator("[data-render-state]")).toContainText(facts.state.digest);
    await expect(inspection).toContainText(facts.appearance);
    await expect(inspection).toContainText(`${facts.image.width} by ${facts.image.height}`);
    await expect(inspection).toContainText(`${facts.source.width} by ${facts.source.height}`);
    expect(await inspection.locator("[data-history]").count()).toBe(0);
    expect((await inspection.innerText()).toLowerCase()).not.toContain("undo");
    expect((await inspection.innerText()).toLowerCase()).not.toContain("change group");
  });
});

test.describe("the lifecycle states the pane words", () => {
  test("completed with no text, and interrupted by Stop during the observation, each read for a person, never as silence", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    scriptCheckedTurn(layerId, "Quiet", { chunks: [] });
    const quiet = await sendAndIdentify(page, "Rename the layer");
    await settled(page, quiet);
    await expect(observation(page, quiet)).toHaveAttribute("data-observation-state", "silent");
    await expect(observation(page, quiet)).toHaveText("The model said nothing about it.");
    await expect(thumbImage(page, quiet)).toBeVisible();
    scriptCheckedTurn(layerId, "Stopped", { chunks: ["The map ", "shows."], hold: { first: true } });
    const stopped = await sendAndIdentify(page, "Rename it again");
    await provider.reached("5:first");
    await expect(observation(page, stopped)).toHaveAttribute("data-observation-state", "awaited");
    const before = looks();
    await stopButton(page).click();
    // The cancellation lands server-side before the fixture is let go, so the held observation is what the departure interrupts.
    await expect.poll(async () => (await api(page, "GET", `/api/assistant/runs/${stopped}`) as { state: string }).state, { timeout: 15_000 }).not.toBe("running");
    provider.release("5:first");
    await settleDoor(page);
    await settled(page, stopped);
    await expect(observation(page, stopped)).toHaveAttribute("data-observation-state", "interrupted");
    await expect(observation(page, stopped)).toHaveText("The request stopped before the model described it.");
    await expect(thumbImage(page, stopped)).toBeVisible();
    expect(looks()).toBe(before);
  });
});

test.describe("the thumbnail opens exactly the retained image", () => {
  test("reached and activated from the keyboard, no render, focus back on the thumbnail", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    scriptCheckedTurn(layerId, "Opened");
    const run = await sendAndIdentify(page, "Rename the layer");
    await settled(page, run);
    const receipt = await api(page, "GET", `/api/assistant/runs/${run}`) as { actions: { tool: string; render?: { id: string } }[] };
    const renderId = receipt.actions.find((a) => a.tool === "look_at_map")!.render!.id;
    // Reached by keyboard: Tab from the composer until the thumbnail holds focus.
    await pane(page).getByRole("textbox", { name: "Ask the assistant" }).focus();
    let focused = false;
    for (let i = 0; i < 40 && !focused; i += 1) { await page.keyboard.press("Shift+Tab"); focused = await thumb(page, run).evaluate((el) => el === document.activeElement); }
    expect(focused, "the thumbnail is reachable by keyboard").toBe(true);
    const before = looks(); const captures = provider.captures.length;
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "The image the model was given" });
    await expect(dialog).toBeVisible();
    const opened = dialog.locator("img");
    await expect(opened).toHaveAttribute("src", new RegExp(`/api/maps/look/${renderId}(?!.*thumbnail)`));
    expect(await opened.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([1024, 640]);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(await thumb(page, run).evaluate((el) => el === document.activeElement), "focus returns to the thumbnail").toBe(true);
    expect(looks()).toBe(before); expect(provider.captures.length).toBe(captures);
  });
});

test.describe("a failed check", () => {
  test("shows its failure words, no thumbnail and no observation, and the answer stands", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    // The stub's failure sentinel is a map whose name carries "[render-fails]".
    await api(page, "PATCH", `/api/maps/${mapId}`, { name: `turn ${runId} [render-fails]` });
    scriptCheckedTurn(layerId, "Failed", { text: "This would have been the observation." });
    const run = await sendAndIdentify(page, "Rename the layer");
    await settled(page, run);
    const entry = checkEntry(page, run);
    await expect(entry).toHaveAttribute("data-status", "refused");
    await expect(entry.locator("[data-failure-code]")).toHaveAttribute("data-failure-code", "render_failed");
    await expect(entry.locator("[data-failure-code]")).toHaveText("The picture could not be taken.");
    expect(await thumbImage(page, run).count()).toBe(0);
    expect(await observation(page, run).count()).toBe(0);
    await expect(answer(page, run)).toContainText("Renamed to Failed.");
    expect(await answer(page, run).innerText()).not.toContain("This would have been the observation.");
    expect(await entry.innerText()).not.toMatch(/\b(GET|POST|PATCH|DELETE)\b|\/api\/|\b[45]\d\d\b|—/);
  });
});

test.describe("recovery and retention", () => {
  test("a dropped stream, a navigation during execution, a reload and a lost approval each rebuild the note from the receipt with the thumbnail re-read, at zero further work", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    const rebuilt = async (run: string, observed: RegExp) => {
      const receipt = await api(page, "GET", `/api/assistant/runs/${run}`) as { actions: { tool: string; render?: { id: string }; observation?: { state: string; text?: string } }[] };
      const check = receipt.actions.find((a) => a.tool === "look_at_map")!;
      expect(check.render).toBeTruthy();
      await expect(checkEntry(page, run)).toHaveAttribute("data-status", "succeeded");
      await expect(observation(page, run)).toHaveAttribute("data-observation-state", check.observation!.state);
      if (check.observation!.text) await expect(observation(page, run)).toHaveText(check.observation!.text);
      await expect(observation(page, run)).toHaveText(observed);
      await expect(thumbImage(page, run)).toBeVisible();
      expect(await thumbImage(page, run).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    };
    // Path 1: a dropped stream.
    scriptCheckedTurn(layerId, "Dropped", { text: "Dropped but seen." });
    await page.route("**/api/assistant/messages", async (route) => { const response = await route.fetch(); await response.body(); await route.abort("connectionreset"); }, { times: 1 });
    const dropped = await sendAndIdentify(page, "Drop me");
    await settled(page, dropped);
    let dispatches = harness.dispatches.length; let captures = provider.captures.length;
    await rebuilt(dropped, /Dropped but seen\./);
    await page.waitForTimeout(300);
    expect(harness.dispatches.length).toBe(dispatches); expect(provider.captures.length).toBe(captures);
    // Path 2: a navigation during execution (the observation held).
    scriptCheckedTurn(layerId, "Departed", { chunks: ["Departed and seen."], hold: { first: true } });
    const departed = await sendAndIdentify(page, "Depart me");
    await provider.reached("5:first");
    await page.getByRole("link", { name: "SQL", exact: true }).click();
    await expect(page.getByLabel("SQL editor")).toBeVisible();
    provider.release("5:first");
    await openPane(page);
    const door = pane(page).getByRole("button", { name: "Check request outcome", exact: true });
    await expect.poll(async () => { if (await door.count()) await door.click(); return (await api(page, "GET", `/api/assistant/runs/${departed}`) as { state: string }).state; }, { timeout: 15_000 }).not.toBe("running");
    if (await door.count()) await door.click();
    dispatches = harness.dispatches.length; captures = provider.captures.length;
    await rebuilt(departed, /Departed and seen\.|The request stopped before the model described it\./);
    await page.waitForTimeout(300);
    expect(harness.dispatches.length).toBe(dispatches); expect(provider.captures.length).toBe(captures);
    // Path 3: a reload during a live run.
    await page.getByRole("link", { name: "Maps", exact: true }).click();
    await page.getByRole("link", { name: `turn ${runId}` }).first().click();
    await page.waitForSelector("[data-map-layer]");
    await openPane(page);
    scriptCheckedTurn(layerId, "Reloaded", { chunks: ["Reloaded and seen."], hold: { first: true } });
    const reloaded = await sendAndIdentify(page, "Reload me");
    await provider.reached("8:first");
    await page.reload();
    await page.waitForSelector("[data-map-layer]");
    provider.release("8:first");
    await openPane(page);
    await expect.poll(async () => { if (await door.count()) await door.click(); return (await api(page, "GET", `/api/assistant/runs/${reloaded}`) as { state: string }).state; }, { timeout: 15_000 }).not.toBe("running");
    if (await door.count()) await door.click();
    dispatches = harness.dispatches.length; captures = provider.captures.length;
    await rebuilt(reloaded, /Reloaded and seen\.|The request stopped before the model described it\./);
    await page.waitForTimeout(300);
    expect(harness.dispatches.length).toBe(dispatches); expect(provider.captures.length).toBe(captures);
    // Path 4: a lost approval response, the check following the settled continuation.
    provider.replies.push({ calls: [{ name: "delete_layer", args: { id: layerId } }] }, { text: "Deleted after the loss." }, { text: "The layer is gone from the map." });
    const approved = await sendAndIdentify(page, "Delete the layer");
    await expect(pane(page).locator("[data-confirmation]")).toBeVisible();
    await page.route("**/api/assistant/messages", async (route) => { const response = await route.fetch(); await response.body(); await route.abort("connectionreset"); }, { times: 1 });
    await pane(page).locator("[data-confirmation]").getByRole("button", { name: "Confirm", exact: true }).click();
    await settled(page, approved);
    dispatches = harness.dispatches.length; captures = provider.captures.length;
    await rebuilt(approved, /The layer is gone from the map\./);
    expect(harness.dispatches.filter((d) => d.path.includes(`/api/layers/${layerId}`) && d.method === "DELETE").length, "one deletion dispatch").toBe(1);
    await page.waitForTimeout(300);
    expect(harness.dispatches.length).toBe(dispatches); expect(provider.captures.length).toBe(captures);
  });
  test("under a retention of two, the first check's image is evicted; after a navigation away and back its note re-reads nothing, keeps the facts and says the picture is not kept, while the latest re-reads its image; no render dispatched", async ({ page }) => {
    const { mapId, layerId } = await seed(page);
    await onBuilder(page, mapId);
    const runs: string[] = [];
    for (const name of ["One", "Two", "Three"]) {
      scriptCheckedTurn(layerId, name, { text: `Seen ${name}.` });
      const run = await sendAndIdentify(page, `Rename to ${name}`);
      await settled(page, run);
      runs.push(run);
    }
    const before = looks(); const captures = provider.captures.length;
    // The transcript is the tab's working state: it survives a navigation, and the pane re-reads every thumbnail on the way back.
    await page.getByRole("link", { name: "SQL", exact: true }).click();
    await expect(page.getByLabel("SQL editor")).toBeVisible();
    await page.getByRole("link", { name: "Maps", exact: true }).click();
    await page.getByRole("link", { name: `turn ${runId}` }).first().click();
    await page.waitForSelector("[data-map-layer]");
    await openPane(page);
    await expect(thumbImage(page, runs[2])).toBeVisible();
    expect(await thumbImage(page, runs[2]).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await expect(thumb(page, runs[0])).toHaveAttribute("data-image", "unavailable");
    await expect(checkEntry(page, runs[0]).locator("[data-check-words]")).toContainText("The picture is not kept.");
    await expect(observation(page, runs[0])).toHaveText("Seen One.");
    await checkEntry(page, runs[0]).getByRole("button", { expanded: false }).last().click();
    await expect(checkEntry(page, runs[0]).locator("[data-inspection] [data-render-id]")).not.toBeEmpty();
    await page.waitForTimeout(300);
    expect(looks()).toBe(before); expect(provider.captures.length).toBe(captures);
  });
});
