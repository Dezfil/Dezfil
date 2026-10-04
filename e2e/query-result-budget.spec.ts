// Run against a provisioned instance. The console and inspection use actual
// oversized results; Add data exercises its existing failed-preview place
// with the exact real-route refusal captured by the console request.
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { routeHouse } from "./support";

const sentence = "The result is too large to return: more than 32 MB in total, or one non-geometry value over 2 MB. Select fewer rows or columns, or shorten the value.";
const sql = "SELECT repeat('x', 1000000) AS payload FROM range(40)";
// Negative controls for the delegated browser observer. These alter only the
// browser's received copy/completion, not server state or production sources.
const seed = process.env.DEZFIL_RESULT_BUDGET_BROWSER_SEED;
test.beforeEach(async ({ page }) => {
  if (seed === "wrong-copy") await page.route("**/api/query", async route => {
    const response = await route.fetch();
    if (response.status() !== 422) return route.fulfill({ response });
    const body = await response.json(); body.error.message = "Seeded wrong refusal sentence.";
    await route.fulfill({ response, json: body });
  });
  if (seed === "stale-busy") await page.addInitScript(() => {
    const native = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await native(...args);
      if (new URL(response.url).pathname === "/api/query" && response.status === 422) return new Promise<Response>(() => {});
      return response;
    };
  });
});
async function typeSql(page: Page, value: string) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("Delete");
  await page.keyboard.insertText(value); await page.keyboard.press("Escape");
}
test("console refusal settles, retains SQL and admits a narrower retry", async ({ page, context }) => {
  await routeHouse(context); await page.goto("/sql");
  await typeSql(page, sql);
  const response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/query" && r.request().method() === "POST");
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  expect((await response).status()).toBe(422);
  const note = page.getByRole("region", { name: "Results", exact: true }).getByRole("alert");
  await expect(note).toContainText("query_result_too_large"); await expect(note).toContainText(sentence);
  await expect(page.getByRole("button", { name: "Run query", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await expect(page.locator(".cm-content")).toHaveText(sql);
  await typeSql(page, "SELECT 42 AS answer"); await page.getByRole("button", { name: "Run query", exact: true }).click();
  await expect(page.getByRole("cell", { name: "42", exact: true })).toBeVisible(); await expect(note).toHaveCount(0);
});
test("refused dataset inspection shows the sentence and cannot open its geometry panel", async ({ page, context }) => {
  await routeHouse(context);
  const name = `budget_${randomUUID().replaceAll("-", "")}`;
  const file = await page.request.post("/api/query/export", { data: { sql: "SELECT repeat('x', 2097151) AS payload, ST_AsWKB(ST_Point(0,0)) AS geometry", format: "geoparquet" } });
  expect(file.status()).toBe(200);
  const uploaded = await page.request.post("/api/tables", { multipart: { file: { name: `${name}.parquet`, mimeType: "application/octet-stream", buffer: await file.body() } } });
  expect(uploaded.status()).toBe(201); const table = await uploaded.json();
  try {
    const response = page.waitForResponse(r => new URL(r.url()).pathname === `/api/tables/${table.name}` && r.request().method() === "GET");
    await page.goto(`/data/${table.name}`); expect((await response).status()).toBe(422);
    await expect(page.getByRole("alert")).toContainText(sentence);
    await expect(page.locator("[data-set-geometry-panel]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Set geometry/ })).toHaveCount(0);
  } finally { expect((await page.request.delete(`/api/tables/${table.name}`)).status()).toBe(204); }
});
test("Add data displays the same refusal in its existing geometry preview error place", async ({ page, context }) => {
  await routeHouse(context); await page.goto("/data");
  const captured = await page.request.post("/api/query", { data: { sql } });
  expect(captured.status()).toBe(422);
  const refusal = await captured.json(); expect(refusal).toEqual({ error: { code: "query_result_too_large", message: sentence } });
  const name = `budget_${randomUUID().replaceAll("-", "")}`;
  let landed: string | undefined;
  const created = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tables" && response.request().method() === "POST");
  await page.route("**/api/tables/*/geometry/preview", route => route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify(refusal) }));
  try {
    await page.getByRole("button", { name: "Add data", exact: true }).first().click();
    await page.locator('input[type="file"]').setInputFiles({ name: `${name}.csv`, mimeType: "text/csv", buffer: Buffer.from("category,count\na,1\nb,2\n") });
    const upload = await created; expect(upload.status()).toBe(201); landed = (await upload.json()).name;
    const dialog = page.getByRole("dialog", { name: "Add data" });
    await expect(dialog.locator("[data-column-matching]")).toBeVisible();
    await expect(dialog.getByRole("alert")).toContainText(sentence);
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  } finally {
    await page.unroute("**/api/tables/*/geometry/preview");
    if (landed) expect((await page.request.delete(`/api/tables/${landed}`)).status()).toBe(204);
  }
});
