// Map runtime truth. Browser evidence for the two defects that static tests
// cannot close: the real host composition under initial WebGL failure, and
// actual overlay/label paint at the published zoom-24 boundary.
import { readFileSync } from "node:fs";
import { expect, test, type Page, type BrowserContext } from "@playwright/test";

import { targetColorCount } from "./png-probes";
import {
  addLayer,
  createMap,
  mapSaveArrived,
  patchLayer,
  publishMap,
  readPublished,
  routeHouse,
  seedCsv,
} from "./support";

const runId = Date.now().toString(36);
const FLOOR_24_LABEL_COLOR = [245, 45, 105] as const;
const IMPOSSIBLE_FRAMING_GUIDANCE =
  "This view is too close to frame at this map width. Zoom out slightly, widen the map, or use fullscreen, then try again.";
const zoomReadout = (page: Page) => page.locator("[data-status-zoom]");

const exportDefinition = (zoom: number) => ({
  viewport: {
    lng: 13.4133,
    lat: 52.5219,
    zoom,
    pitch: 0,
    bearing: 0,
  },
  size: { width: 640, height: 360 },
  legend: { visible: false, corner: "bottom-left", size: "m" },
  widgets: [],
  title: null,
  appearance: "light",
  overlayScale: 1,
});

async function exportPng(
  page: Page,
  mapId: string,
  definition: ReturnType<typeof exportDefinition>,
): Promise<{ status: number; body: string; png: Buffer | null }> {
  const result = await page.evaluate(
    async ({ mapId, definition }) => {
      const response = await fetch(`/api/maps/${mapId}/export/image`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definition }),
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!response.ok) {
        return {
          status: response.status,
          body: new TextDecoder().decode(bytes),
          b64: null,
        };
      }
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return { status: response.status, body: "", b64: btoa(binary) };
    },
    { mapId, definition },
  );
  return {
    status: result.status,
    body: result.body,
    png: result.b64 ? Buffer.from(result.b64, "base64") : null,
  };
}

async function denyInitialWebGL(context: BrowserContext) {
  await context.addInitScript(() => {
    const nativeGetContext = HTMLCanvasElement.prototype.getContext;
    const withoutWebGL = function (
      this: HTMLCanvasElement,
      kind: string,
      ...args: unknown[]
    ) {
      if (["webgl", "webgl2", "experimental-webgl"].includes(kind)) {
        const event =
          typeof WebGLContextEvent === "function"
            ? new WebGLContextEvent("webglcontextcreationerror", {
                statusMessage: "injected initial-context failure",
              })
            : new Event("webglcontextcreationerror");
        this.dispatchEvent(event);
        return null;
      }
      return Reflect.apply(nativeGetContext, this, [kind, ...args]);
    };
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: withoutWebGL,
    });
  });
}

test("initial WebGL failure stays map-local and tells both export roads the truth", async ({
  page,
  context,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await denyInitialWebGL(context);
  await routeHouse(context, { basemapStyleStub: true });

  await page.goto("/maps");
  const mapId = await createMap(page, `WebGL truth ${runId}`);
  const token = await publishMap(page, mapId);

  await test.step("builder map fails locally while author actions remain live", async () => {
    await page.goto(`/maps/${mapId}`);
    const alert = page.locator("[data-map-webgl-failed]");
    await expect(alert).toHaveRole("alert");
    await expect(alert).toContainText("WebGL is unavailable");
    await expect(alert).toContainText(/Reload.*browser|hardware acceleration/i);
    await expect(page.getByRole("button", { name: `WebGL truth ${runId}`, exact: true })).toBeVisible();

    const search = page.getByPlaceholder("Search map & places");
    await search.fill("still usable");
    await expect(search).toHaveValue("still usable");

    await page.getByRole("button", { name: "Export", exact: true }).click();
    await page.getByRole("menuitem", { name: /Image/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "Export image" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("[data-map-webgl-failed]")).toBeVisible();
    await dialog.locator("[data-export-download]").click();
    await expect(dialog.getByRole("alert").last()).toContainText(/WebGL/i);
    await expect(dialog.getByRole("alert").last()).not.toContainText(
      /not ready/i,
    );
  });

  await test.step("published map fails locally while reader chrome remains operable", async () => {
    await page.goto(`/v/${token}`);
    await expect(page.getByRole("heading", { name: `WebGL truth ${runId}` })).toBeVisible();
    const alert = page.locator("[data-map-webgl-failed]");
    await expect(alert).toHaveRole("alert");
    await expect(alert).toContainText(/WebGL.*Reload|hardware acceleration/is);
    const root = page.locator("[data-published-view]");
    const before = await root.getAttribute("data-view-theme");
    await page
      .getByRole("button", { name: /Switch to (light|dark) theme/ })
      .click();
    await expect(root).not.toHaveAttribute("data-view-theme", before ?? "");
  });

  await test.step("the bare server composition fails before it can announce ready", async () => {
    await page.addInitScript((definition) => {
      (
        window as unknown as {
          __DEZFIL_EXPORT_DEFINITION__?: unknown;
        }
      ).__DEZFIL_EXPORT_DEFINITION__ = definition;
    }, exportDefinition(12));
    await page.goto(`/render/${mapId}`);
    const failed = page.locator("[data-export-failed]");
    await expect(failed).toHaveAttribute("data-export-failed", /WebGL/i);
    await expect(page.locator('[data-export-ready="true"]')).toHaveCount(0);
  });

  expect(pageErrors).toEqual([]);
});

test("initial WebGL failure stays local in table and SQL preview maps", async ({ page, context }) => {
  await denyInitialWebGL(context);
  await routeHouse(context, { basemapStyleStub: true });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/data");
  const { name } = await seedCsv(page, `preview_gpu_${Date.now()}`, "name,lon,lat\nGPU fixture,13.4,52.5\n");
  const expectLocalFailure = async () => {
    const alert = page.locator("[data-table-webgl-failed]");
    await expect(alert).toBeVisible();
    await expect(alert).toHaveRole("alert");
    await expect(alert).toContainText("WebGL is unavailable");
    await expect(alert).toContainText(/Reload.*browser|hardware acceleration/i);
    await expect(page.locator("[data-preview-map] canvas")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Switch between dark and light theme" })).toBeEnabled();
  };
  try {
    await test.step("table preview", async () => {
      await page.goto(`/tables/${name}`);
      await expectLocalFailure();
      await expect(page.getByText("1 features", { exact: true })).toBeVisible();
    });
    await test.step("SQL result preview", async () => {
      await page.goto("/sql");
      await page.locator(".cm-content").fill(`SELECT * FROM "${name}"`);
      await page.getByRole("button", { name: "Run query" }).click();
      await expect(page.getByRole("cell", { name: "GPU fixture" })).toBeVisible();
      await page.getByRole("tab", { name: "Map", exact: true }).click();
      await expectLocalFailure();
      await expect(page.getByRole("button", { name: "Run query" })).toBeEnabled();
    });
    expect(errors).toEqual([]);
  } finally {
    expect((await page.request.delete(`/api/tables/${name}`)).status()).toBe(204);
  }
});

test("zoom 24 is actual camera and label paint in builder, reader, and server image", async ({
  page,
  context,
}) => {
  await routeHouse(context, { basemapStyleStub: true });
  await page.goto("/maps");
  const table = `z24_${runId}`;
  await seedCsv(
    page,
    table,
    "name,lon,lat\nZOOM_TWENTY_FOUR,13.4133,52.5219\n",
  );
  const mapId = await createMap(page, `Zoom 24 truth ${runId}`);
  const layerId = await addLayer(page, mapId, "zoom-floor label", `SELECT * FROM ${table}`);
  await patchLayer(page, layerId, {
    style: {
      fill: {
        type: "constant",
        color: { r: 245, g: 45, b: 105, a: 0 },
      },
      fillOpacity: 0,
      stroke: { r: 245, g: 45, b: 105, a: 0 },
      strokeOpacity: 0,
      strokeWidth: 0,
      pointRadius: 3,
      opacity: 1,
      label: {
        attribute: "name",
        size: 28,
        color: { r: 245, g: 45, b: 105, a: 1 },
        haloWidth: 0,
        haloColor: { r: 12, g: 16, b: 24, a: 0.8 },
        density: 1,
        zoomFloor: 24,
        cap: 1,
      },
    },
  });
  const paintedLabelPixels = async () => {
    const deck = page.locator("canvas#deckgl-overlay");
    await expect(deck).toBeVisible();
    return targetColorCount(
      page,
      await deck.screenshot(),
      FLOOR_24_LABEL_COLOR,
    );
  };

  await test.step("builder reports and paints its actual zoom", async () => {
    await page.goto(`/maps/${mapId}`);
    // The builder deliberately fits loaded data once, capped at 15. Drive the
    // real shared stage control from that settled camera to the new ceiling;
    // a stored initial 24 would be overwritten by the fit and could produce a
    // transient false pass before the camera settles.
    await expect(zoomReadout(page)).toHaveText("15.00", {
      timeout: 30_000,
    });
    await expect
      .poll(async () =>
        page.evaluate(async (mapId) => {
          const response = await fetch(`/api/maps/${mapId}`, {
            cache: "no-store",
          });
          return ((await response.json()) as { viewport: { zoom: number } })
            .viewport.zoom;
        }, mapId),
      )
      .toBeCloseTo(15, 2);
    const zoomIn = page.getByRole("button", { name: "Zoom in" });
    for (let zoom = 16; zoom <= 24; zoom += 1) {
      const arrived = mapSaveArrived(page);
      await zoomIn.click();
      await arrived;
      await expect(zoomReadout(page)).toHaveText(zoom.toFixed(2));
    }
    await expect
      .poll(async () =>
        page.evaluate(async (mapId) => {
          const response = await fetch(`/api/maps/${mapId}`, {
            cache: "no-store",
          });
          return ((await response.json()) as { viewport: { zoom: number } })
            .viewport.zoom;
        }, mapId),
      )
      .toBeCloseTo(24, 2);
    await expect
      .poll(paintedLabelPixels, { timeout: 30_000 })
      .toBeGreaterThan(10);
  });

  const token = await publishMap(page, mapId);
  await test.step("published reader paints the same floor-24 label", async () => {
    const published = await readPublished<{
      viewport: { zoom: number };
      layers: Array<{
        id: string;
        style: {
          label?: {
            zoomFloor?: number;
            color?: { r: number; g: number; b: number; a: number };
          };
        };
      }>;
    }>(page, token);
    expect(published.viewport.zoom).toBe(24);
    expect(published.layers.find((layer) => layer.id === layerId)?.style.label)
      .toMatchObject({
        zoomFloor: 24,
        color: { r: 245, g: 45, b: 105, a: 1 },
      });

    await page.goto(`/v/${token}`);
    await expect(page.locator("canvas#deckgl-overlay")).toBeVisible();
    // The published surface deliberately starts by fitting its effective
    // data, capped at 15. Allow that documented opening move, observe that
    // its floor-24 label is absent, then drive the real reader control to
    // the shared ceiling. Against the old runtime cap, the control stopped
    // at 22 and this label stayed absent.
    await page.waitForTimeout(2_000);
    expect(await paintedLabelPixels()).toBe(0);
    const zoomIn = page.getByRole("button", { name: "Zoom in" });
    for (let zoom = 16; zoom <= 24; zoom += 1) {
      await zoomIn.click();
      await page.waitForTimeout(1_500);
    }
    await expect
      .poll(paintedLabelPixels, { timeout: 30_000 })
      .toBeGreaterThan(10);
  });

  await test.step("the private image road paints at the accepted boundary", async () => {
    const exported = await exportPng(page, mapId, exportDefinition(24));
    expect(exported.status, exported.body).toBe(200);
    if (!exported.png) throw new Error("zoom-24 export returned no PNG");
    expect(
      await targetColorCount(page, exported.png, FLOOR_24_LABEL_COLOR),
    ).toBeGreaterThan(10);
  });
});

test("narrow zoom-24 framing refuses Image without blocking Data and recovers truthfully", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await routeHouse(context, { basemapStyleStub: true });
  await page.goto("/maps");
  const table = `n58_${runId}`;
  await seedCsv(
    page,
    table,
    "name,lon,lat\nN58_RECOVERY_ROW,13.4133,52.5219\n",
  );
  const mapId = await createMap(page, `N58 framing ${runId}`);
  await addLayer(page, mapId, "n58_points", `SELECT * FROM ${table}`);

  const readStoredZoom = () =>
    page.evaluate(async (id) => {
      const response = await fetch(`/api/maps/${id}`, { cache: "no-store" });
      return ((await response.json()) as { viewport: { zoom: number } })
        .viewport.zoom;
    }, mapId);
  const canvasWidth = async () =>
    (await page.locator("[data-drag-canvas]").boundingBox())?.width ?? 0;
  const exportMenu = () => page.getByRole("menu", { name: "Export" });
  const imageItem = () =>
    exportMenu().getByRole("menuitem", { name: /^Image/ });
  const expectNoImageComposition = async () => {
    await expect(page.locator("[data-export-card]")).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: "Export image" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("radiogroup", {
        name: "Basemap label and symbol size",
      }),
    ).toHaveCount(0);
  };
  const openExportWithKeyboard = async () => {
    const trigger = page.getByRole("button", { name: "Export", exact: true });
    await trigger.focus();
    await trigger.press("ArrowDown");
    await expect(exportMenu()).toBeVisible();
  };
  const expectRefusedImage = async () => {
    const image = imageItem();
    await expect(image).toHaveAttribute("aria-disabled", "true");
    await expect(image.locator("small")).toHaveText(
      IMPOSSIBLE_FRAMING_GUIDANCE,
    );
    await expect(image).toBeFocused();

    // aria-disabled keeps the reason keyboard-reachable. Neither keyboard
    // nor pointer activation may dismiss the menu or create a nominal card.
    await image.press("Enter");
    await expect(exportMenu()).toBeVisible();
    await expectNoImageComposition();
    // Playwright treats aria-disabled as non-actionable, while a real pointer
    // can still hit this focusable button. Force the physical event so the
    // no-op guard itself—not Playwright's actionability policy—is exercised.
    await image.click({ force: true });
    await expect(exportMenu()).toBeVisible();
    await expectNoImageComposition();
  };
  const expectOrdinaryLegalCard = async (openingStep: "M" | "L") => {
    const dialog = page.getByRole("dialog", { name: "Export image" });
    await expect(dialog).toBeVisible();
    // The dialog itself carries data-export-card; search its canvas children
    // directly rather than asking it for a descendant copy of itself.
    await expect(dialog.locator("canvas").first()).toBeVisible({
      timeout: 30_000,
    });
    const mapSizes = dialog.getByRole("radiogroup", {
      name: "Basemap label and symbol size",
    });
    await expect(mapSizes.getByRole("radio")).toHaveCount(4);
    for (const label of ["XS", "S", "M", "L"]) {
      await expect(
        mapSizes.getByRole("radio", { name: label, exact: true }),
      ).toHaveCount(1);
    }
    await expect(
      mapSizes.getByRole("radio", { name: openingStep, exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    return dialog;
  };

  await test.step("a real 1024px builder settles and persists at zoom 24", async () => {
    await page.goto(`/maps/${mapId}`);
    await expect(page.getByText("1 features").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(zoomReadout(page)).toHaveText("15.00", {
      timeout: 30_000,
    });
    await expect.poll(readStoredZoom).toBeCloseTo(15, 2);
    await expect.poll(canvasWidth).toBeLessThan(720);

    const zoomIn = page.getByRole("button", { name: "Zoom in" });
    for (let zoom = 16; zoom <= 24; zoom += 1) {
      const arrived = mapSaveArrived(page);
      await zoomIn.click();
      await arrived;
      await expect(zoomReadout(page)).toHaveText(zoom.toFixed(2));
    }
    await expect.poll(readStoredZoom).toBeCloseTo(24, 2);
  });

  await test.step("Image refuses before composition while the same menu downloads CSV", async () => {
    await openExportWithKeyboard();
    await expectRefusedImage();

    await exportMenu().getByRole("menuitem", { name: /^Data/ }).click();
    const layerRow = exportMenu().locator("[class*=layerRow]", {
      hasText: "n58_points",
    });
    await expect(layerRow).toBeVisible();
    await layerRow.hover();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      layerRow.getByRole("menuitem", { name: "CSV", exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("n58_points.csv");
    const path = await download.path();
    if (!path) throw new Error("CSV download has no local file");
    const csv = readFileSync(path, "utf8");
    expect(csv).toContain("N58_RECOVERY_ROW");
    expect(csv).toContain("POINT");
    await expectNoImageComposition();
  });

  await test.step("fullscreen restores the ordinary legal image card", async () => {
    await page.getByRole("button", { name: "Fullscreen map" }).click();
    await expect(
      page.getByRole("button", { name: "Exit fullscreen map" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect.poll(canvasWidth).toBeGreaterThan(720);

    await openExportWithKeyboard();
    await expect(imageItem()).not.toHaveAttribute("aria-disabled", "true");
    await expect(imageItem().locator("small")).toHaveText(
      "A picture of this map, as a PNG",
    );
    await imageItem().press("Enter");
    const dialog = await expectOrdinaryLegalCard("L");
    await dialog.getByRole("button", { name: "Close" }).click();
  });

  await test.step("returning narrow refuses again, and one zoom-out restores Image", async () => {
    await page.getByRole("button", { name: "Exit fullscreen map" }).click();
    await expect(
      page.getByRole("button", { name: "Fullscreen map" }),
    ).toHaveAttribute("aria-pressed", "false");
    await expect.poll(canvasWidth).toBeLessThan(720);

    await openExportWithKeyboard();
    await expectRefusedImage();
    await page.keyboard.press("Escape");

    const arrived = mapSaveArrived(page);
    await page.getByRole("button", { name: "Zoom out" }).click();
    await arrived;
    await expect(zoomReadout(page)).toHaveText("23.00");
    await expect.poll(readStoredZoom).toBeCloseTo(23, 2);

    await openExportWithKeyboard();
    await expect(imageItem()).not.toHaveAttribute("aria-disabled", "true");
    await imageItem().press("Enter");
    const dialog = await expectOrdinaryLegalCard("M");
    await dialog.getByRole("button", { name: "Close" }).click();
  });
});
