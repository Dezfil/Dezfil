import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext } from "@playwright/test";

test("two ordinary accounts and an admin keep map lists and copied map URLs private", async ({ browser, request, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const contexts: BrowserContext[] = [];
  const maps: { id: string; name: string }[] = [];
  const layers: { id: string; name: string }[] = [];
  try {
    const admin = await browser.newContext({ baseURL, storageState: await request.storageState(), extraHTTPHeaders: { origin } });
    contexts.push(admin);
    for (const label of ["First reader", "Second reader"]) {
      const invitation = await request.post("/api/users", { data: { name: label, email: `${randomUUID()}@example.test` } });
      expect(invitation.status()).toBe(201);
      const link = new URL((await invitation.json()).signInUrl);
      const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { origin } });
      contexts.push(context);
      const signed = await context.request.post("/api/auth/redeem", {
        data: { secret: new URLSearchParams(link.hash.slice(1)).get("secret"), password: "field notebooks at dawn" },
      });
      expect(signed.status()).toBe(200);
      expect((await signed.json()).account.isAdmin).toBe(false);
      expect(await (await context.request.get("/api/maps")).json()).toEqual([]);
      const page = await context.newPage();
      await page.goto("/maps");
      await expect(page.getByRole("button", { name: "New map", exact: true }).first()).toBeVisible();
    }
    for (const context of contexts) {
      const name = `Private map ${randomUUID()}`;
      const created = await context.request.post("/api/maps", { data: { name } });
      expect(created.status()).toBe(201);
      maps.push(await created.json());
      const layer = await context.request.post(`/api/maps/${maps.at(-1)!.id}/layers`, {
        data: { name: `Private layer ${randomUUID()}`, sql: "SELECT 1 AS value, ST_Point(13, 52) AS geom" },
      });
      expect(layer.status()).toBe(201);
      layers.push(await layer.json());
    }
    for (let i = 0; i < contexts.length; i++) {
      const page = await contexts[i].newPage();
      await page.goto("/maps");
      await expect(page.getByText(maps[i].name, { exact: true })).toBeVisible();
      for (const other of maps.filter((_, index) => index !== i)) {
        await expect(page.getByText(other.name, { exact: true })).toHaveCount(0);
        const hidden = await contexts[i].request.get(`/api/maps/${other.id}`);
        const missing = await contexts[i].request.get("/api/maps/absent-map");
        expect(hidden.status()).toBe(404);
        expect(await hidden.json()).toEqual(await missing.json());
        for (const suffix of ["history", "thumbnail"]) {
          const hiddenChild = await contexts[i].request.get(`/api/maps/${other.id}/${suffix}`);
          const absentChild = await contexts[i].request.get(`/api/maps/absent-map/${suffix}`);
          expect(hiddenChild.status()).toBe(404);
          expect(await hiddenChild.json()).toEqual(await absentChild.json());
        }
        for (const suffix of ["undo", "redo"]) {
          const hiddenChild = await contexts[i].request.post(`/api/maps/${other.id}/${suffix}`);
          const absentChild = await contexts[i].request.post(`/api/maps/absent-map/${suffix}`);
          expect(hiddenChild.status()).toBe(404);
          expect(await hiddenChild.json()).toEqual(await absentChild.json());
        }
        await page.goto(`/maps/${other.id}`);
        await expect(page.getByText("The requested resource was not found.", { exact: true })).toBeVisible();
        await expect(page.getByText(other.name, { exact: true })).toHaveCount(0);
        await page.goto("/maps/absent-map");
        await expect(page.getByText("The requested resource was not found.", { exact: true })).toBeVisible();
        await page.goto("/maps");
      }
      for (let j = 0; j < contexts.length; j++) {
        if (j === i) continue;
        for (const suffix of ["", "/fields", "/render", "/export/csv", "/tiles/0/0/0"]) {
          const hidden = await contexts[i].request.get(`/api/layers/${layers[j].id}${suffix}`);
          const missing = await contexts[i].request.get(`/api/layers/absent-layer${suffix}`);
          expect(hidden.status()).toBe(404);
          expect(await hidden.json()).toEqual(await missing.json());
        }
        const draft = { id: "preview", type: "formula", layerId: layers[j].id, title: "Count", field: null,
          agg: "count", aggField: null, unit: null, note: null, format: null, visible: true };
        const preview = await contexts[i].request.post(`/api/maps/${maps[i].id}/widget-values`, { data: { draft } });
        expect(preview.status()).toBe(404);
      }
      expect((await contexts[i].request.get(`/api/layers/${layers[i].id}/render`)).status()).toBe(200);
      await page.goto(`/maps/${maps[i].id}`);
      await page.getByRole("button", { name: maps[i].name, exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Map name", exact: true })).toHaveValue(maps[i].name);
    }
  } finally {
    for (let i = 0; i < maps.length; i++) await contexts[i].request.delete(`/api/maps/${maps[i].id}`);
    for (const context of contexts) await context.close();
  }
});
