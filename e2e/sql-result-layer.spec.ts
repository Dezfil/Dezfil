// SQL result → layer: the workspace's on-screen result becomes a layer
// in one action — to a new map and an existing one; the landed layer
// carries exactly the executed SQL; a non-spatial result explains
// itself; a drifted draft is stated and never lands; and both SQL
// surfaces present the same CodeMirror editor. The workspace is the SQL
// console: the table chips are a browser, and the quoted-identifier
// insertion of a quoted identifier is the row's insert action.
//
// Environment: the documented gate (isolated server, fresh data dir);
// everything the flow is not itself testing is API-seeded. Run via
// `npm run e2e:sqlbridge` with DEZFIL_BASE_URL at the server.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  createMap,
  layerSaveArrived,
  routeHouse,
  seedCsv,
  trackConsole,
} from "./support";

const runId = Date.now().toString(36);
const table = `sqlbridge_${runId}`;

// The distinctive opening clause, not the whole sentence: the prose is one
// export shared by both surfaces now, and re-typing it here a third time is
// what let this assertion go stale against working code. A missing or wrong
// explanation still fails; polishing the wording does not.
const NOT_MAPPABLE_COPY = "A layer needs a geometry column.";
const DIVERGED_COPY =
  "The editor changed since this run. The layer gets the query that produced this result.";

/** Replace the workspace editor's content and run it via the keybinding. */
async function runQuery(page: Page, sql: string) {
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.type(sql);
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(
    page.getByText(/rows? ·|1 row|rows/).first(),
  ).toBeVisible({ timeout: 15_000 });
}

async function mapLayers(
  page: Page,
  mapId: string,
): Promise<{ name: string; sql: string }[]> {
  return page.evaluate(async (id) => {
    const r = await fetch(`/api/maps/${id}`, { cache: "no-store" });
    if (!r.ok) throw new Error(await r.text());
    const body = (await r.json()) as {
      layers?: { name: string; sql: string }[];
    };
    return body.layers ?? [];
  }, mapId);
}

test("a spatial result becomes a layer; the executed SQL is the layer's truth", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context);

  await page.goto("/data");
  await seedCsv(
    page,
    table,
    "name,lat,lon\nalpha,51.1,7.1\nbeta,51.2,7.2\ngamma,51.3,7.3\n",
  );

  await test.step("the workspace presents the shared CodeMirror editor", async () => {
    await page.goto("/sql");
    await expect(page.locator(".cm-editor")).toBeVisible({ timeout: 15_000 });
    // Highlighting is present: the SQL grammar tokenizes keywords.
    await page.locator(".cm-content").click();
    await page.keyboard.type("SELECT 1;");
    await expect(page.locator(".cm-line span").first()).toBeVisible();
  });

  await test.step("the row's insert action puts the quoted identifier at the cursor", async () => {
    // Place the caret MID-buffer: select all, retype a frame, then walk
    // left past the trailing ";" so the insertion must land inside the
    // text — an append or a comment would fail both assertions.
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("SELECT * FROM ;");
    await page.keyboard.press("ArrowLeft");
    // The row's actions show on hover (and on focus); insert is one of them.
    const row = page.locator(`[data-name="${table}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.hover();
    await row.getByRole("button", { name: "Insert at the cursor", exact: true }).click();
    const text = await page
      .locator(".cm-content")
      .evaluate((el) => el.textContent ?? "");
    expect(text).toContain(`SELECT * FROM "${table}";`);
    expect(text).not.toContain("--");
    // Still on /sql — the action is an insertion, not navigation.
    expect(new URL(page.url()).pathname).toBe("/sql");
  });

  const executed = `SELECT * FROM ${table}`;
  let newMapId = "";

  await test.step("promote to a new map: the builder opens with the layer selected", async () => {
    await runQuery(page, executed);
    const promote = page.getByRole("button", { name: "Add as map layer" });
    await expect(promote).toBeEnabled();
    await promote.click();
    const dialog = page.getByRole("dialog", {
      name: /Add This result to a map/,
    });
    await expect(dialog).toBeVisible();
    // The usual editable name field, prefilled (spec decision 2).
    const nameField = dialog.getByLabel("Layer name");
    await expect(nameField).toHaveValue("Query result");
    await page.getByRole("button", { name: /New map/ }).click();
    await page.waitForURL(/\/maps\/[a-f0-9-]+\?layer=/, { timeout: 20_000 });
    newMapId = page.url().match(/\/maps\/([a-f0-9-]+)/)![1];
    // Selected on arrival, not merely present (spec decision 2).
    await expect(
      page.locator('[data-selected="true"]', {
        hasText: "Query result",
      }),
    ).toBeVisible({ timeout: 20_000 });
  });

  await test.step("the landed layer's SQL is byte-identical to the executed query", async () => {
    const layers = await mapLayers(page, newMapId);
    const landed = layers.find((l) => l.name === "Query result");
    expect(landed?.sql).toBe(executed);
  });

  let targetMapId = "";
  await test.step("promote to an existing map picked in the dialog", async () => {
    targetMapId = await createMap(page, `sqlbridge target ${runId}`);
    await page.goto("/sql");
    await runQuery(page, executed);
    await page.getByRole("button", { name: "Add as map layer" }).click();
    await page
      .getByRole("button", { name: new RegExp(`sqlbridge target ${runId}`) })
      .click();
    await page.waitForURL(new RegExp(`/maps/${targetMapId}`), {
      timeout: 20_000,
    });
    const layers = await mapLayers(page, targetMapId);
    expect(layers).toHaveLength(1);
    expect(layers[0].sql).toBe(executed);
  });

  await test.step("the table cards still walk through the same dialog unchanged", async () => {
    // The dialog became SQL-scoped; the table origin must behave exactly
    // as before (spec: no behavioral fork).
    await page.goto("/data");
    await page
      .getByRole("button", { name: `Add ${table} to a map` })
      .first()
      .click();
    await expect(
      page.getByRole("dialog", { name: `Add ${table} to a map` }),
    ).toBeVisible();
    await page.getByRole("button", { name: /New map/ }).click();
    await page.waitForURL(/\/maps\/[a-f0-9-]+/, { timeout: 20_000 });
    const tableMapId = page.url().match(/\/maps\/([a-f0-9-]+)/)![1];
    const layers = await mapLayers(page, tableMapId);
    expect(layers).toHaveLength(1);
    expect(layers[0].name).toBe(table);
    expect(layers[0].sql).toBe(`SELECT * FROM ${table}`);
  });

  await test.step("a non-spatial result explains why it cannot land", async () => {
    await page.goto("/sql");
    await runQuery(page, "SELECT 1 AS x");
    await expect(
      page.getByRole("button", { name: "Add as map layer" }),
    ).toBeDisabled();
    await expect(page.getByText(NOT_MAPPABLE_COPY, { exact: false })).toBeVisible();
  });

  await test.step("a drifted draft is stated, stays untouched, and a chosen name lands", async () => {
    await runQuery(page, executed);
    await page.locator(".cm-content").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" -- edited after the run");
    await expect(page.getByText(DIVERGED_COPY)).toBeVisible();
    await page.getByRole("button", { name: "Add as map layer" }).click();
    // The promotion flow leaves the draft exactly as edited.
    await expect(page.locator(".cm-content")).toContainText(
      "-- edited after the run",
    );
    const dialog = page.getByRole("dialog", {
      name: /Add This result to a map/,
    });
    await dialog.getByLabel("Layer name").fill(`bridge named ${runId}`);
    await page.getByRole("button", { name: /New map/ }).click();
    await page.waitForURL(/\/maps\/[a-f0-9-]+\?layer=/, { timeout: 20_000 });
    const divergedMapId = page.url().match(/\/maps\/([a-f0-9-]+)/)![1];
    const layers = await mapLayers(page, divergedMapId);
    expect(layers[0]?.sql).toBe(executed);
    expect(layers[0]?.name).toBe(`bridge named ${runId}`);
  });

  await test.step("the workbench presents the same editor, tokenizing alike", async () => {
    // The landed layer's card opens its scoped source workbench holding
    // the same SQL — tokenized by the same grammar (highlight spans).
    await page
      .locator("li", { hasText: new RegExp(`bridge named ${runId}`) })
      .first()
      .getByRole("button", { name: "Layer menu", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Edit source" }).click();
    const editor = page.locator(".cm-editor").last();
    await expect(editor).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator(".cm-editor .cm-line span").last(),
    ).toBeVisible();
    // Mod-Enter drives the workbench's own run — the read-only preview;
    // the durable save stays on Update layer.
    await page.locator(".cm-content").last().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" LIMIT 2");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(page.getByText(/2\s*rows/).first()).toBeVisible({
      timeout: 15_000,
    });
    const saved = layerSaveArrived(page);
    await page.getByRole("button", { name: /Update layer/ }).click();
    await saved;
  });

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});
