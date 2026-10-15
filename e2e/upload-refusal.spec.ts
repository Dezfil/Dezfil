import { test, expect } from "@playwright/test";
import { routeHouse } from "./support";

for (const [code, status, message] of [
  ["upload_stalled", 408, "The upload sent no body bytes for 60 s. Retry the upload."],
  ["data_processing_timeout", 408, "Upload exceeded the 60 s reception time limit. Adjust Data processing time limit in Settings > Limits."],
  ["upload_too_large", 413, "Upload exceeds the size cap of 1 MB. Adjust Upload size in Settings > Limits."],
] as const) {
  test(`the upload surface shows ${code} and imports the next file`, async ({ page, context }) => {
    await routeHouse(context);
    let first = true;
    await page.route("**/api/tables", async route => {
      if (route.request().method() !== "POST" || !first) { await route.continue(); return; }
      first = false;
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code, message } }) });
    });
    await page.goto("/data");
    await page.getByRole("button", { name: "Add data" }).first().click();
    const name = `recovered_${code}_${Date.now()}`;
    await page.locator('input[type="file"]').setInputFiles([
      { name: "refused.csv", mimeType: "text/csv", buffer: Buffer.from("lon,lat\n1,2\n") },
      { name: `${name}.csv`, mimeType: "text/csv", buffer: Buffer.from("lon,lat\n3,4\n") },
    ]);
    await expect(page.getByRole("dialog", { name: "Add data" }).getByRole("alert").filter({ hasText: message })).toBeVisible();
    await expect.poll(async () => page.evaluate(async () => (await (await fetch("/api/tables")).json()).map((table: { name: string }) => table.name)), { timeout: 30000 }).toContain(name);
  });
}
