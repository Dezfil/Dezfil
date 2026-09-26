// The exception strip and the permanent re-run home.
//
// Staleness is **seeded, not asserted onto a current output**: with two
// chained one-step outputs, re-running the producer through its own step
// endpoint leaves the reader behind — the same technique the chain suite
// used, surviving the surface it proved.
//
// Environment: the documented gate (isolated server, fresh data dir).
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import { addLayer, createMap, routeHouse, seedFile, trackConsole } from "./support";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const runId = Date.now().toString(36);
const stations = `strip_${runId}`;
const rings = `${stations}_rings`;
const centers = `${stations}_centers`;

const WIDE = { width: 1440, height: 900 };

async function seedWorkspace(page: Page): Promise<string> {
  await page.goto("/data");
  await seedFile(
    page,
    `${stations}.geojson`,
    readFileSync(path.join(FIXTURES_DIR, "stations.geojson"), "utf8"),
    "application/geo+json",
  );
  await page.goto("/maps");
  const mapId = await createMap(page, `strip ${runId}`);
  await addLayer(page, mapId, `Stations ${runId}`, `SELECT * FROM ${stations}`);
  return mapId;
}

/** The step that owns an output table, found through the API. */
async function ownerOf(page: Page, output: string) {
  return page.evaluate(async (name) => {
    const r = await fetch("/api/recipes", { cache: "no-store" });
    const { recipes } = (await r.json()) as {
      recipes: {
        id: string;
        steps: { id: string; output: { name: string } | null }[];
      }[];
    };
    for (const recipe of recipes) {
      for (const step of recipe.steps) {
        if (step.output?.name === name) return { recipe: recipe.id, step: step.id };
      }
    }
    return null;
  }, output);
}

/** Re-run one step through its own endpoint and wait for it to settle. */
async function rerunViaApi(page: Page, owner: { recipe: string; step: string }) {
  return page.evaluate(async ({ recipe, step }) => {
    const accepted = await fetch(
      `/api/recipes/${recipe}/steps/${step}/run`,
      { method: "POST" },
    );
    if (!accepted.ok) return `refused ${accepted.status}: ${await accepted.text()}`;
    // A step's own run is one of the recipe's runs: its one member's
    // job is the attempt to follow.
    const { run } = (await accepted.json()) as { run: { id: string; members: { jobId: string | null }[] } };
    const jobId = run.members[0]?.jobId;
    if (!jobId) return "accepted without an attempt";
    for (;;) {
      const r = await fetch(`/api/operations/runs/${jobId}`, { cache: "no-store" });
      const { run: view } = (await r.json()) as { run: { state: string } };
      if (["succeeded", "failed", "cancelled"].includes(view.state)) return view.state;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }, owner);
}

test("the strip appears on the affected card alone, re-runs in place, and Ignore holds until the state moves", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize(WIDE);
  const mapId = await seedWorkspace(page);
  await page.goto(`/maps/${mapId}`);

  await test.step("two chained outputs, authored through the one-step loop", async () => {
    if ((await page.locator('li[data-selected="true"]').count()) === 0) {
    await page.locator("[data-layer-select]").first().click();
  }
  await page.locator("[data-tools-control]").click();
    await page.locator("[data-operation='buffer']").click();
    await page.locator("[data-param='distance']").fill("250");
    await page.locator("[data-output-name]").fill(rings);
    await expect(page.locator("[data-form-run]")).toBeEnabled({ timeout: 30_000 });
    await page.locator("[data-form-run]").click();
    await expect(page.locator("[data-success-face]")).toBeVisible({ timeout: 90_000 });

    await page.locator("[data-run-another]").click();
    await page.locator("[data-operation='centroid']").click();
    await expect(page.locator("[data-parameter-form]")).toBeVisible();
    await page.locator("[data-parameter-form] input[type='search']").first().click();
    await page.locator(`[data-table-row='${rings}']`).click();
    await page.locator("[data-output-name]").fill(centers);
    await expect(page.locator("[data-form-run]")).toBeEnabled({ timeout: 30_000 });
    await page.locator("[data-form-run]").click();
    await expect(page.locator("[data-success-face]")).toBeVisible({ timeout: 90_000 });
    await page.locator("[data-success-done]").click();
  });

  await test.step("every card is quiet while everything is current", async () => {
    await expect(page.locator("[data-exception-strip]")).toHaveCount(0);
    await expect(page.locator("[data-recipe-note]")).toHaveCount(0);
  });

  const producer = await ownerOf(page, rings);
  expect(producer).not.toBeNull();

  await test.step("re-running the producer marks the reader's card alone", async () => {
    expect(await rerunViaApi(page, producer!)).toBe("succeeded");
    await page.reload();
    const strips = page.locator("[data-exception-strip]");
    await expect(strips).toHaveCount(1);
    await expect(strips.first()).toHaveAttribute("data-exception-strip", "stale");
    // The exact cause copy: the producer's table, and the action.
    await expect(strips.first()).toContainText(`${rings} changed · re-run`);
  });

  await test.step("Re-run replaces the output in place and the strip leaves", async () => {
    await page.locator("[data-strip-rerun]").click();
    await expect(page.locator("[data-exception-strip]")).toHaveCount(0, {
      timeout: 90_000,
    });
    // The layer's card is still there, still quiet — the dataset was
    // replaced under it, not remade beside it. Its display name follows
    // D1's non-door branch: a readable form of the primary input table,
    // because Run another tool starts with no origin layer.
    await expect(
      page
        .locator("[data-layer-list]")
        .getByText(`${rings.replace(/_/g, " ")} (Centroid)`),
    ).toBeVisible();
  });

  await test.step("Ignore survives a reload; another generation re-arms", async () => {
    expect(await rerunViaApi(page, producer!)).toBe("succeeded");
    await page.reload();
    await expect(page.locator("[data-exception-strip]")).toHaveCount(1);
    await page.locator("[data-strip-ignore]").click();
    await expect(page.locator("[data-exception-strip]")).toHaveCount(0);
    await page.reload();
    await expect(page.locator("[data-exception-strip]")).toHaveCount(0);
    // The same public condition, a new input generation: the strip returns.
    expect(await rerunViaApi(page, producer!)).toBe("succeeded");
    await page.reload();
    await expect(page.locator("[data-exception-strip]")).toHaveCount(1);
  });

  await test.step("table detail shows the state and re-runs without a card (the stale half)", async () => {
    await page.goto(`/tables/${centers}`);
    await expect(page.locator("[data-run-state='stale']")).toBeVisible();
    await page.locator("[data-detail-rerun]").click();
    await expect(page.locator("[data-run-state='current']")).toBeVisible({
      timeout: 90_000,
    });
  });

  expect(consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
});
