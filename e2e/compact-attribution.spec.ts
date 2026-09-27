// Exercise the two stock attribution controls through their real basemap
// requests. All fixture responses and credit links stay on loopback.
import { createServer, type Server } from "node:http";
import { test, expect, type Page } from "@playwright/test";
import { createMap, routeHouse, seedCsv } from "./support";

let fixture: Server;
let fixtureUrl: string;

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
    const probe = '<details open onload="void 0" ontoggle="document.documentElement.dataset.attributionExecution=\'executed\'"><summary>Credit probe</summary></details>';
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
    await page.goto(`/tables/${name}`);
    const preview = page.locator("[data-preview-map]");
    await expect(preview.locator(".maplibregl-canvas")).toBeVisible();
    return preview;
  }
  const mapId = await createMap(page, `Credit fixture ${Date.now()}`);
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
      if (!await link.isVisible()) await control.locator(".maplibregl-ctrl-attrib-button").click();
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute("href", `${fixtureUrl}/credit`);
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
    const probe = control.locator("details");
    await expect(probe).toHaveCount(1);
    await expect(probe).toHaveAttribute("open", "");
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
    await expect(probe).not.toHaveAttribute("onload", /./);
    await expect(probe).not.toHaveAttribute("ontoggle", /./);
  });
}
