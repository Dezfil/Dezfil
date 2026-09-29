import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext } from "@playwright/test";

test("two ordinary accounts and an admin keep same-name uploads and dataset pages private", async ({ browser, request, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const contexts: BrowserContext[] = [];
  const stem = `owned_${randomUUID().replaceAll("-", "")}`;
  const distinct: string[] = [];
  try {
    contexts.push(await browser.newContext({ baseURL, storageState: await request.storageState(), extraHTTPHeaders: { origin } }));
    for (const label of ["First reader", "Second reader"]) {
      const invitation = await request.post("/api/users", { data: { name: label, email: `${randomUUID()}@example.test` } });
      expect(invitation.status()).toBe(201);
      const link = new URL((await invitation.json()).signInUrl);
      const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { origin } });
      contexts.push(context);
      expect((await context.request.post("/api/auth/redeem", { data: {
        secret: new URLSearchParams(link.hash.slice(1)).get("secret"), password: "field notebooks at dawn",
      } })).status()).toBe(200);
      expect(await (await context.request.get("/api/tables")).json()).toEqual([]);
      const page = await context.newPage(); await page.goto("/data");
      await expect(page.getByText(stem, { exact: true })).toHaveCount(0);
    }
    const identities = [];
    for (let i = 0; i < contexts.length; i++) {
      distinct.push(`${stem}_${i}`);
      for (const name of [stem, distinct[i]]) {
        const response = await contexts[i].request.post("/api/tables", { multipart: { file: {
          name: `${name}.csv`, mimeType: "text/csv", buffer: Buffer.from(`sentinel,lat,lon\naccount_${i},52,13\n`),
        } } });
        expect(response.status()).toBe(201); const table = await response.json(); expect(table.name).toBe(name);
        if (name === stem) identities.push(table.id);
      }
    }
    expect(new Set(identities).size).toBe(3);
    for (let i = 0; i < contexts.length; i++) {
      const context = contexts[i];
      const detail = await context.request.get(`/api/tables/${stem}`);
      expect(detail.status()).toBe(200); expect((await detail.json()).preview[0].sentinel).toBe(`account_${i}`);
      const downloaded = await context.request.get(`/api/tables/${stem}/export?format=csv`);
      expect(downloaded.status()).toBe(200); expect(await downloaded.text()).toContain(`account_${i}`);
      const page = await context.newPage(); await page.goto(`/tables/${stem}`);
      await page.getByRole("tab", { name: "Data preview", exact: true }).click();
      await expect(page.getByText(`account_${i}`, { exact: true }).first()).toBeVisible();
      for (const name of distinct.filter((_, j) => j !== i)) {
        const hidden = await context.request.get(`/api/tables/${name}`);
        const missing = await context.request.get("/api/tables/absent-dataset");
        expect(hidden.status()).toBe(404); expect(await hidden.json()).toEqual(await missing.json());
        await page.goto(`/tables/${name}`);
        await expect(page.getByText("The requested resource was not found.", { exact: true })).toBeVisible();
      }
    }
    expect((await contexts[0].request.delete(`/api/tables/${stem}`)).status()).toBe(204);
    expect((await contexts[1].request.get(`/api/tables/${stem}`)).status()).toBe(200);
  } finally {
    for (let i = 0; i < contexts.length; i++) for (const name of [stem, distinct[i]].filter(Boolean)) await contexts[i].request.delete(`/api/tables/${name}`);
    for (const context of contexts) await context.close();
  }
});
