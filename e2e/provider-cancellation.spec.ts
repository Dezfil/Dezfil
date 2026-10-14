import { expect, test, type Request } from "@playwright/test";
import { provisionJourney } from "../scripts/journey-auth.mjs";
import { journeyApi } from "../scripts/journey-http.mjs";
import { captureBasis } from "../scripts/revision-fixtures.mjs";
import { heldProvider, until, assertClosed, evidence } from "../scripts/held-provider.mjs";
import { routeHouse } from "./support";

test("caller-driven provider closure and current UI", async ({ page, context, baseURL }) => {
  expect(process.env.DEZFIL_DATA_DIR, "use an isolated scratch directory").toBeTruthy();
  const fixture = await heldProvider(4319);
  const rows: unknown[] = [], errors: string[] = [];
  let credentials: Awaited<ReturnType<typeof provisionJourney>> | undefined;
  let mapId: string | undefined;
  try {
    credentials = await provisionJourney(baseURL!);
    const api = journeyApi(baseURL!, { token: credentials.token });
    const made = await api("POST", "/api/maps", { body: { name: "Provider browser fixture" } });
    expect(made.status).toBe(201); mapId = made.json.id;
    await context.addCookies([{ name: credentials.cookie!.split("=")[0], value: credentials.cookie!.split("=").slice(1).join("="), url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
    // Only basemap imagery is stubbed. Search and inspection use real app routes.
    await routeHouse(context, { basemapStyleStub: true });
    page.on("pageerror", error => errors.push(error.message));
    const visit = async () => {
      await page.goto(`/maps/${mapId}`);
      await expect(page.getByRole("combobox", { name: "Search this map and places" })).toBeVisible();
    };
    const noStaleError = async () => {
      await expect(page.getByText("The check request itself failed.")).toHaveCount(0);
      await expect(page.getByText("Place search could not run.", { exact: true })).toHaveCount(0);
    };
    type Arm = ReturnType<typeof fixture.arm>;
    const depart = async (arm: Arm, action: () => Promise<unknown>) => {
      const predicate = (r: Request) => arm.road === "search"
        ? r.url().includes(`/search?q=${encodeURIComponent(arm.id)}`) && r.url().includes("places=1")
        : r.url().endsWith("/api/basemap/inspect") && r.postData()?.includes(arm.id) === true;
      const failure = page.waitForEvent("requestfailed", { predicate, timeout: 5_000 }).then(request => ({ at: performance.now(), error: request.failure()?.errorText }));
      // Retain the old request set when Enter starts another check for the same URL.
      const old = { ...arm, requests: [...arm.requests] };
      await action();
      const observed = await failure;
      expect(observed.error).toMatch(/ABORT|CANCEL/i);
      try {
        await assertClosed(old, observed.at);
      } finally {
        rows.push({ id: arm.id, departedAt: observed.at, sockets: evidence(old) });
      }
      await noStaleError();
    };
    await visit();
    const search = page.getByRole("combobox", { name: "Search this map and places" });
    for (const action of ["supersession", "departure"]) {
      const held = fixture.arm("search", "body", `browser-search-${action}`);
      await search.fill(held.id); await search.press("Enter");
      await until(() => held.held, "submitted search did not reach provider");
      if (action === "supersession") {
        const next = fixture.arm("search", "normal", "browser-search-current");
        await depart(held, () => search.fill(next.id));
        await search.press("Enter");
        await expect(page.getByRole("option").filter({ hasText: "Harbour" })).toBeVisible();
        await noStaleError();
      } else {
        await depart(held, () => page.goto("/maps")); await visit();
        const next = fixture.arm("search", "normal", "browser-search-returned");
        await search.fill(next.id); await search.press("Enter");
        await expect(page.getByRole("option").filter({ hasText: "Harbour" })).toBeVisible();
        await noStaleError();
      }
    }
    for (const action of ["replacement", "edit", "Cancel", "panel departure"]) {
      await page.getByRole("tab", { name: "Basemap", exact: true }).click();
      await page.getByRole("button", { name: "Custom…" }).click();
      const url = page.getByRole("textbox", { name: "Style URL" });
      const held = fixture.arm("inspect", "body", `browser-inspect-${action.replaceAll(" ", "-")}`);
      await url.fill(held.url); await page.getByRole("button", { name: "Check", exact: true }).click();
      await until(() => held.held, "advisory check did not reach provider");
      if (action === "replacement") {
        await depart(held, () => url.press("Enter"));
        await until(() => held.requests.length === 2, "replacement check did not reach provider");
        await expect(page.getByRole("button", { name: "Checking…", exact: true })).toBeVisible();
        const replacement = { ...held, requests: held.requests.slice(1) };
        await depart(replacement, () => page.getByRole("button", { name: "Cancel", exact: true }).click());
      } else if (action === "edit") {
        await depart(held, () => url.fill(`${fixture.origin}/style/edited`));
        await expect(page.getByRole("button", { name: "Use this style", exact: true })).toHaveCount(0);
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
      } else if (action === "Cancel") {
        await depart(held, () => page.getByRole("button", { name: "Cancel", exact: true }).click());
      } else {
        await depart(held, () => page.getByRole("tab", { name: "Layers", exact: true }).click());
        await page.getByRole("tab", { name: "Basemap", exact: true }).click();
      }
      const normal = fixture.arm("inspect", "normal", `browser-inspect-recovery-${action.replaceAll(" ", "-")}`);
      await page.getByRole("button", { name: "Custom…" }).click();
      await url.fill(normal.url); await page.getByRole("button", { name: "Check", exact: true }).click();
      await expect(page.getByText("Fixture style · 1 layer · 1 source", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Use this style", exact: true })).toBeVisible();
      await noStaleError(); await page.getByRole("button", { name: "Cancel", exact: true }).click();
    }
    expect(errors).toEqual([]);
  } finally {
    await test.info().attach("provider-closure", { body: JSON.stringify(rows, null, 2), contentType: "application/json" });
    await fixture.close();
    if (credentials) {
      const api = journeyApi(baseURL!, { token: credentials.token });
      if (mapId) {
        const current = await api("GET", `/api/maps/${mapId}`);
        expect((await api("DELETE", `/api/maps/${mapId}`, { basis: captureBasis(current.json) })).status).toBe(204);
      }
      expect((await credentials.fetch(`${baseURL}/api/account/tokens/${credentials.tokenId}`, { method: "DELETE" })).status).toBe(200);
    }
  }
});
