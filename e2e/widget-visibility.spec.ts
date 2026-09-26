// Widget visibility: the eye button kept by a field ruling
// — named for its widget, its pressed state carrying hidden — whose
// pointer and keyboard operation changes visibility and nothing else:
// not the row's expansion, not the tab-level publication setting.
// Persistence through reload, honest published inclusion, and kind-word
// captions.
//
// Environment: the documented gate (isolated server, fresh data dir).
// Run with DEZFIL_BASE_URL at the server.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  addLayer,
  createMap,
  patchMap,
  publishMap,
  seedCsv,
  trackConsole,
} from "./support";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const runId = Date.now().toString(36);
const table = `wsw_${runId}`;

const WIDE = { width: 1440, height: 900 };
test.use({ viewport: WIDE });

const KINDS = ["note", "formula", "category", "histogram"] as const;

async function seedMap(page: Page) {
  await page.goto("/maps");
  const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
  await seedCsv(page, table, csv);
  const mapId = await createMap(page, `switches ${runId}`);
  const layerId = await addLayer(
    page,
    mapId,
    "alpha",
    `SELECT * FROM "${table}"`,
  );
  await patchMap(page, mapId, {
    widgetsPublished: true,
    widgets: [
      {
        id: "w-note",
        type: "note",
        layerId: null,
        title: "Notes",
        field: null,
        agg: "count",
        aggField: null,
        unit: null,
        note: "A note.",
        format: null,
        visible: true,
      },
      {
        id: "w-formula",
        type: "formula",
        layerId,
        title: "Total",
        field: null,
        agg: "count",
        aggField: null,
        unit: null,
        note: null,
        format: null,
        visible: true,
      },
      {
        id: "w-category",
        type: "category",
        layerId,
        title: "By kind",
        field: "kind",
        agg: "count",
        aggField: null,
        unit: null,
        note: null,
        format: null,
        visible: true,
      },
      {
        id: "w-hist",
        type: "histogram",
        layerId,
        title: "Riders",
        field: "riders",
        agg: "count",
        aggField: null,
        unit: null,
        note: null,
        format: null,
        visible: true,
      },
    ],
  });
  return { mapId };
}

const widgetsField = (page: Page, mapId: string) =>
  page.evaluate(async (id) => {
    const r = await fetch(`/api/maps/${id}`, { cache: "no-store" });
    if (!r.ok) throw new Error(await r.text());
    const m = (await r.json()) as {
      widgetsPublished: boolean;
      widgets: { id: string; visible: boolean }[];
    };
    return {
      published: m.widgetsPublished,
      visible: Object.fromEntries(m.widgets.map((w) => [w.id, w.visible])),
    };
  }, mapId);

test("the eye button flips exactly one truth, by pointer and by keyboard", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const consoleErrors = trackConsole(page);
  const { mapId } = await seedMap(page);
  await page.goto(`/maps/${mapId}`);
  await page
    .getByRole("tablist", { name: "Builder panels" })
    .getByRole("tab", { name: "Widgets" })
    .click();

  // Captions read the kind word alone — all four kinds, nothing after.
  await expect(
    page.locator("[data-widget-row] small"),
  ).toHaveText([...KINDS]);

  // Every row carries its named eye button (pressed = hidden); no
  // switch sits inside a widget row — the tab-level published switch
  // is the tab's only one.
  await expect(
    page.locator("[data-widget-row]").getByRole("switch"),
  ).toHaveCount(0);
  for (const title of ["Notes", "Total", "By kind", "Riders"]) {
    await expect(
      page.getByRole("button", { name: `Hide ${title}` }),
    ).toHaveAttribute("aria-pressed", "false");
  }

  // Pointer: one click hides exactly that widget; the row stays
  // collapsed and the tab-level publication setting stays true.
  const riderHead = page.getByRole("button", { name: "Riders widget" });
  await page.getByRole("button", { name: "Hide Riders" }).click();
  await expect(
    page.getByRole("button", { name: "Show Riders" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(riderHead).toHaveAttribute("aria-expanded", "false");
  await expect
    .poll(async () => (await widgetsField(page, mapId)).visible["w-hist"])
    .toBe(false);
  const after = await widgetsField(page, mapId);
  expect(after.published).toBe(true);
  expect(after.visible["w-note"]).toBe(true);
  expect(after.visible["w-formula"]).toBe(true);
  expect(after.visible["w-category"]).toBe(true);

  // It survives a reload.
  await page.reload();
  await page
    .getByRole("tablist", { name: "Builder panels" })
    .getByRole("tab", { name: "Widgets" })
    .click();
  await expect(
    page.getByRole("button", { name: "Show Riders" }),
  ).toHaveAttribute("aria-pressed", "true");

  // Keyboard: Enter on the focused button shows it again, and the row
  // it sits in still does not expand.
  await page.getByRole("button", { name: "Show Riders" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Hide Riders" }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByRole("button", { name: "Riders widget" }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect
    .poll(async () => (await widgetsField(page, mapId)).visible["w-hist"])
    .toBe(true);

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("a refreshed published view includes a widget exactly when its eye is open", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const consoleErrors = trackConsole(page);
  const { mapId } = await seedMap(page);
  await page.goto(`/maps/${mapId}`);
  await page
    .getByRole("tablist", { name: "Builder panels" })
    .getByRole("tab", { name: "Widgets" })
    .click();
  await page.getByRole("button", { name: "Hide By kind" }).click();
  await expect
    .poll(async () => (await widgetsField(page, mapId)).visible["w-category"])
    .toBe(false);

  const token = await publishMap(page, mapId);
  await page.goto(`/v/${token}`);
  await expect(page.getByText("Riders", { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("By kind", { exact: true })).toHaveCount(0);

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});
