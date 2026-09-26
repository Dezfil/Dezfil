// Mechanical flows, same tool-harness boot as assistant-picker.spec.ts. Run
// in two boots with a fresh worktree-local DEZFIL_DATA_DIR shared by runner
// and server. First leave DEZFIL_AI_MODELS_OPENAI unset and select --grep
// 'catalogue offer'. Then set it to gpt-5.6-terra and select --grep
// 'one-model offer'. The original picker suite keeps its explicit
// three-model env list. Appearance still refers to page 04, option A.
import { existsSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { assistantProviderFixture } from "./assistant-provider-fixture";
import { assistantToolHarness, harnessTarget } from "./assistant-tool-harness";
import { routeHouse } from "./support";
import { api, composer, onBuilder, pane, seed } from "./assistant-turn-support";

const provider = assistantProviderFixture();
const harness = assistantToolHarness(harnessTarget());
let file: string;
let ownsFile = false;
test.beforeAll(async () => {
  const dir = process.env.DEZFIL_DATA_DIR;
  if (!dir || !path.resolve(dir).startsWith(path.join(process.cwd(), ".claude") + path.sep)) {
    throw new Error("Give runner and server the same fresh data directory under this worktree's .claude directory.");
  }
  file = path.join(dir, "assistant-models.json");
  if (existsSync(file)) throw new Error("The fixture requires an absent instance catalogue; it will not overwrite one.");
  await provider.start(); await harness.start();
});
test.afterAll(async () => { await provider.stop(); await harness.stop(); });
test.beforeEach(async ({ context }) => { provider.reset(); harness.reset(); await routeHouse(context, { basemapStyleStub: true }); });
test.afterEach(async () => {
  if (ownsFile) { await rm(file, { force: true }); await rm(`${file}.next`, { force: true }); ownsFile = false; }
});
const chip = (page: Page) => pane(page).locator("[data-model-picker]");
const menu = (page: Page) => pane(page).locator("[data-model-menu]");
async function put(models: { id: string; name: string; efforts: string[] }[]) {
  ownsFile = true;
  await writeFile(`${file}.next`, JSON.stringify({ openai: models }));
  await rename(`${file}.next`, file);
}
async function open(page: Page, width: number) {
  const { mapId } = await seed(page);
  await page.setViewportSize({ width, height: 900 });
  await onBuilder(page, mapId);
  return mapId;
}
async function assertKeyAlone(page: Page) {
  const status = await api(page, "GET", "/api/assistant");
  expect(status.provider).toBe("openai");
  expect((status.models as { id: string }[]).map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-nova"]);
}
for (const [form, width] of [["docked", 1440], ["overlay", 1040]] as const) {
  test(`catalogue offer: key alone shows the picker in the ${form} pane`, async ({ page }) => {
    await open(page, width); await assertKeyAlone(page);
    await expect(chip(page)).toBeVisible();
    await expect(pane(page).getByText("gpt-5.6-terra", { exact: true })).toHaveCount(0);
    await chip(page).click();
    await expect(menu(page).locator("[data-model]")).toHaveCount(4);
    await expect(menu(page).getByText("gpt-5.6-terra", { exact: true })).toHaveCount(1);
  });
  test(`one-model offer: explicit default env list restores the model line in the ${form} pane`, async ({ page }) => {
    await open(page, width);
    const status = await api(page, "GET", "/api/assistant");
    expect((status.models as { id: string }[]).map((m) => m.id)).toEqual(["gpt-5.6-terra"]);
    await expect(chip(page)).toHaveCount(0);
    await expect(pane(page).getByText("gpt-5.6-terra", { exact: true })).toBeVisible();
  });
}
for (const kind of ["model", "effort"] as const) {
  test(`catalogue offer: stale ${kind} is refused without refresh, preserves the message, and reconciles after remount`, async ({ page }) => {
    await page.goto("/maps"); await assertKeyAlone(page);
    const chosen = { id: "local-choice", name: "Local choice", efforts: ["low", "high"] };
    await put([chosen]);
    const mapId = await open(page, 1440);
    await chip(page).click(); await menu(page).locator('[data-model="local-choice"]').click();
    await chip(page).click(); await menu(page).locator('[data-effort="high"]').click();
    await expect(chip(page)).toContainText("High");
    let statusReads = 0;
    page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/assistant") statusReads += 1; });
    await put(kind === "model" ? [] : [{ ...chosen, efforts: ["low"] }]);
    await expect(chip(page)).toContainText("Local choice");
    await expect(chip(page)).toContainText("High");
    const response = page.waitForResponse((r) => r.url().endsWith("/api/assistant/messages") && r.request().method() === "POST");
    await composer(page).fill("Keep this unsent message");
    await pane(page).getByRole("button", { name: "Send", exact: true }).click();
    const refused = await response;
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error.code).toBe(kind === "model" ? "assistant_model_not_offered" : "assistant_effort_not_offered");
    await expect(composer(page)).toHaveValue("Keep this unsent message");
    await expect(chip(page)).toBeEnabled();
    expect(provider.captures).toHaveLength(0);
    expect(statusReads).toBe(0);
    await page.reload(); await onBuilder(page, mapId);
    expect(statusReads).toBeGreaterThan(0);
    await expect(chip(page)).toContainText(kind === "model" ? "Terra" : "Local choice");
    await expect(chip(page)).not.toContainText("High");
    await chip(page).click();
    await expect(menu(page).locator('[data-effort="default"]')).toHaveAttribute("aria-checked", "true");
  });
}
