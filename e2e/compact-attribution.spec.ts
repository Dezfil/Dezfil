// Exercise the two stock attribution controls through their real basemap
// requests. All fixture responses and credit links stay on loopback.
import { createServer, type Server } from "node:http";
import { test, expect, type Page } from "@playwright/test";
import { createMap, routeHouse, seedCsv } from "./support";
import { readThenWriteRequestSetup } from "./edit-basis";

let fixture: Server;
let fixtureUrl: string;
let cleanupRoutes: string[] = [];

test.beforeEach(async ({ baseURL }) => {
  if (!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname) || new URL(baseURL).port === "3000") {
    throw new Error("requires an isolated loopback DEZFIL_BASE_URL away from port 3000");
  }
  cleanupRoutes = [];
});

test.afterEach(async ({ request }) => {
  for (const route of cleanupRoutes.reverse()) {
    const response = route.startsWith("/api/maps/")
      ? await readThenWriteRequestSetup(request, route, () => ({ method: "DELETE" }))
      : await request.delete(route);
    expect(response.status(), `clean up ${route}`).toBe(204);
  }
});

test.beforeAll(async () => {
  fixture = createServer((request, response) => {
    if (request.url === "/credit") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Fixture credit</title><p>Local cartography credit</p>");
      return;
    }
    const benign = `<a href="${fixtureUrl}/credit" target="_blank" rel="noopener">Local cartography</a>`;
    // A local DOM marker makes execution observable without any network,
    // data access or application mutation. Adjacent event attributes
    // exercise the sanitizer's live-attribute iteration regression.
    const probe = '<span class="attribution-probe">Probe fixture</span><details open onload="void 0" ontoggle="document.documentElement.dataset.attributionExecution=\'executed\'"><summary>Credit probe</summary></details>';
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      version: 8,
      sources: {
        credit: {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
          attribution: benign + (request.url === "/probe.json" ? probe : ""),
        },
      },
      layers: [{ id: "credit", type: "circle", source: "credit" }],
    }));
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  fixtureUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    fixture.close((error) => error ? reject(error) : resolve()),
  );
});

type Surface = "MiniMap" | "FeaturePreviewMap";

async function openSurface(page: Page, surface: Surface) {
  await page.goto("/data");
  if (surface === "FeaturePreviewMap") {
    const { name } = await seedCsv(page, `credit_${Date.now()}`, "name,value\nfixture,1\n");
    cleanupRoutes.push(`/api/tables/${encodeURIComponent(name)}`);
    await page.goto(`/tables/${name}`);
    const preview = page.locator("[data-preview-map]");
    await expect(preview.locator(".maplibregl-canvas")).toBeVisible();
    return preview;
  }
  const mapId = await createMap(page, `Credit fixture ${Date.now()}`);
  cleanupRoutes.push(`/api/maps/${mapId}`);
  await page.goto(`/maps/${mapId}`);
  // The builder's own stock control is intentionally disabled.
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await expect(page.locator(".maplibregl-ctrl-attrib")).toHaveCount(0);
  await page.getByRole("button", { name: "Add layer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add layer" });
  await dialog.getByText("OpenStreetMap", { exact: true }).click();
  await expect(dialog.locator(".maplibregl-canvas")).toBeVisible();
  return dialog;
}

for (const surface of ["MiniMap", "FeaturePreviewMap"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`${surface}: readable credit and working link in ${theme}`, async ({ page, context }) => {
      await routeHouse(context);
      await context.route("**://tiles.openfreemap.org/**", async (route) => {
        const response = await route.fetch({ url: `${fixtureUrl}/benign.json` });
        await route.fulfill({ response });
      });
      await page.goto("/data");
      const appliedTheme = () => page.evaluate(() => document.documentElement.dataset.theme ?? "light");
      if (await appliedTheme() !== theme) {
        await page.getByRole("button", { name: "Switch between dark and light theme" }).click();
      }
      await expect.poll(appliedTheme).toBe(theme);
      // The catalog is modal: choose the theme before opening it.
      const host = await openSurface(page, surface);
      const control = host.locator(".maplibregl-ctrl-attrib");
      await expect(control).toContainText("Local cartography");
      const link = control.getByRole("link", { name: "Local cartography" });
      const expandCredit = () => expect(async () => {
        if (!await link.isVisible()) await control.locator(".maplibregl-ctrl-attrib-button").click({ timeout: 1_000 });
        await expect(link).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 5_000 });
      await expandCredit();
      await expect(link).toHaveAttribute("href", `${fixtureUrl}/credit`);
      await expect(link).toHaveAttribute("target", "_blank");
      const paint = await control.evaluate((element) => {
        const probe = document.createElement("div");
        probe.style.backgroundColor = "var(--bg-raised)";
        probe.style.color = "var(--fg-muted)";
        document.body.append(probe);
        const expected = { background: getComputedStyle(probe).backgroundColor, color: getComputedStyle(probe).color };
        probe.remove();
        return { expected, actual: { background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color } };
      });
      expect(paint.actual, `${surface}: ${theme} attribution uses theme colors`).toEqual(paint.expected);
      await expandCredit();
      const opened = context.waitForEvent("page");
      await link.click();
      const credit = await opened;
      await expect(credit.getByText("Local cartography credit")).toBeVisible();
      await credit.close();
    });
  }

  test(`${surface}: attribution event attributes never execute`, async ({ page, context }, testInfo) => {
    await routeHouse(context);
    await context.route("**://tiles.openfreemap.org/**", async (route) => {
      const response = await route.fetch({ url: `${fixtureUrl}/probe.json` });
      await route.fulfill({ response });
    });
    const host = await openSurface(page, surface);
    const control = host.locator(".maplibregl-ctrl-attrib");
    await expect(control).toContainText("Local cartography");
    // The sanitizer may remove the unsafe element altogether. Its safe
    // sibling proves this is the probe payload, even after sanitization.
    await expect(control.locator(".attribution-probe")).toHaveText("Probe fixture");
    await expect(control.locator("a").filter({ hasText: "Local cartography" }))
      .toHaveAttribute("href", `${fixtureUrl}/credit`);
    // Let the native toggle event queued by insertion run before reading
    // the marker. Attribute removal below also guards later activation.
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)));
    }));
    const observed = await page.evaluate(() => ({
      execution: document.documentElement.dataset.attributionExecution ?? null,
      attribution: document.querySelector(".maplibregl-ctrl-attrib-inner")?.innerHTML,
    }));
    await testInfo.attach("attribution-observation", {
      body: JSON.stringify({ surface, ...observed }, null, 2),
      contentType: "application/json",
    });
    expect(observed.execution, `${surface}: untrusted attribution executed`).toBeNull();
    await expect(control.locator("[onload], [ontoggle]")).toHaveCount(0);
  });
}
