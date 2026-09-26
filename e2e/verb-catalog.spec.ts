// The verb catalog in the drawer.
//
// **The point of this file is what is *not* in the diff.** Twelve verbs were
// added to the catalog and no UI code was written for any of them: the picker
// lists them because the catalog describes them, their forms render from their
// declared parameters, and their rows read the API's own sentence. So the two
// verbs exercised here are the two whose parameter shapes the four proven verbs
// did not have — a list of columns, and a list of aggregates over a group.
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
const stations = `verbs_${runId}`;
const WIDE = { width: 1440, height: 900 };

async function seedMap(page: Page): Promise<string> {
  await page.goto("/data");
  await seedFile(
    page,
    `${stations}.geojson`,
    readFileSync(path.join(FIXTURES_DIR, "stations.geojson"), "utf8"),
    "application/geo+json",
  );
  await page.goto("/maps");
  const mapId = await createMap(page, `verbs ${runId}`);
  await addLayer(page, mapId, `Stations ${runId}`, `SELECT * FROM ${stations}`);
  return mapId;
}

test("every ratified verb is offered, and two new parameter shapes author end to end", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  await page.setViewportSize(WIDE);
  const mapId = await seedMap(page);
  await page.goto(`/maps/${mapId}`);

  await test.step("the picker offers every verb the catalog describes", async () => {
    if ((await page.locator('li[data-selected="true"]').count()) === 0) {
    await page.locator("[data-layer-select]").first().click();
  }
  await page.locator("[data-tools-control]").click();
        await expect(page.locator("[data-operation-picker]")).toBeVisible();
    // Read from the API rather than from a list written here: the picker's job
    // is to show what the instance offers, and a hard-coded expectation would
    // pass while the two drifted.
    const offered = await page.evaluate(async () => {
      const response = await fetch("/api/operations");
      const body = (await response.json()) as { operations: { id: string }[] };
      return body.operations.map((o) => o.id);
    });
    expect(offered.length).toBeGreaterThanOrEqual(16);
    for (const id of offered) {
      await expect(
        page.locator(`[data-operation='${id}']`),
        `the picker offers ${id}`,
      ).toHaveCount(1);
    }
  });

  await test.step("a category heading reads apart from the rows under it", async () => {
    // **The class that has recurred, not the tone of the day.** The
    // headings once rendered in the blurbs' own grey — measured identical
    // at the smoke — which is no hierarchy at all, and the exact shade has
    // been tuned twice since. So this asserts the property that
    // keeps failing (heading distinguishable from the row text under it,
    // and not sunk into the faintest grey) rather than pinning a value
    // that every tuning would have to come back and edit.
    const tones = await page.evaluate(() => {
      const heading = document.querySelector<HTMLElement>(
        "[data-operation-picker] p",
      );
      const blurb = document.querySelector<HTMLElement>(
        "[data-operation-picker] button span span:nth-child(2)",
      );
      if (!heading || !blurb) return null;
      const read = (el: HTMLElement) => getComputedStyle(el).color;
      const luminance = (color: string) => {
        const [r, g, b] = (color.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).map(
          Number,
        );
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      return {
        heading: read(heading),
        blurb: read(blurb),
        headingLuminance: luminance(read(heading)),
        blurbLuminance: luminance(read(blurb)),
      };
    });
    expect(tones).not.toBeNull();
    expect(tones!.heading).not.toBe(tones!.blurb);
    // Whichever way the theme runs, the heading is the stronger of the two
    // against its own background — never the fainter.
    const towardsForeground = await page.evaluate(() => {
      const body = getComputedStyle(document.body).backgroundColor;
      const [r, g, b] = (body.match(/\d+(\.\d+)?/g) ?? ["255", "255", "255"]).map(
        Number,
      );
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? 1 : -1;
    });
    expect(
      (tones!.headingLuminance - tones!.blurbLuminance) * towardsForeground,
    ).toBeGreaterThan(4);
  });

  const dissolved = `dissolved_${runId}`;
  await test.step("a list of columns: dissolve by a field, authored from the form", async () => {
    await page.locator("[data-operation='dissolve']").click();
    await expect(page.locator("[data-parameter-form]")).toBeVisible();
    // The input is pre-filled by the door, so the column list has an input to
    // read its columns from — which is the shape this step is about.
    await page.locator(`[data-param-column='group_by:kind']`).check();
    await page.locator("[data-output-name]").fill(dissolved);
    await page.locator("[data-form-run]").click();
    await expect(page.locator("[data-run-notice]")).toContainText(dissolved, {
      timeout: 90_000,
    });
    // The server's own sentence for a verb no UI code knows about (A1's
    // obligation): the step row left with the pivot, so the guarantee is
    // held where it lives — on the step resource itself.
    const summaries = await page.evaluate(async () => {
      const r = await fetch("/api/recipes", { cache: "no-store" });
      const { recipes } = (await r.json()) as {
        recipes: { steps: { summary?: string }[] }[];
      };
      return recipes.flatMap((x) => x.steps.map((st) => st.summary ?? ""));
    });
    expect(summaries.some((line) => line.includes("merged per kind"))).toBe(true);
  });

  const summary = `summary_${runId}`;
  await test.step("a list of aggregates: group & summarize, and a result with no geometry", async () => {
    await page.locator("[data-run-another]").click();
    await page.locator("[data-operation='group_summarize']").click();
    await expect(page.locator("[data-parameter-form]")).toBeVisible();
    // The list arrives on focus, then the row picks.
    await page.locator("[data-parameter-form] input[type='search']").first().click();
    await page.locator(`[data-table-row='${stations}']`).click();
    await page.locator(`[data-param-column='group_by:kind']`).check();
    // The aggregate editor: an aggregate, and the column it works on.
    await page.locator("[data-carry-add]").click();
    await page.locator("[data-carry-aggregate='0']").selectOption("sum");
    await page.locator("[data-carry-field='0']").selectOption("riders");
    await page.locator("[data-output-name]").fill(summary);

    // **The table-only truth is said before Run**, because this verb's
    // output carries no geometry — the catalog declares it, so the sentence
    // needs no dry run to be honest, and no map action is offered.
    await expect(page.locator("[data-result-note]")).toContainText(/no layer/i);
    await expect(page.locator("[data-on-map]")).toHaveCount(0);

    await page.locator("[data-form-run]").click();
    await expect(page.locator("[data-run-notice]")).toContainText(summary, {
      timeout: 90_000,
    });
  });

  await test.step("both outputs are in the workspace, and the geometryless one says so", async () => {
    const tables = await page.evaluate(async () => {
      const response = await fetch("/api/tables", { cache: "no-store" });
      return ((await response.json()) as {
        name: string;
        geometryType: string | null;
      }[]).map((t) => [t.name, t.geometryType]);
    });
    expect(tables).toContainEqual([dissolved, expect.anything()]);
    expect(tables).toContainEqual([summary, null]);
  });

  expect(consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url))).toEqual([]);
});
