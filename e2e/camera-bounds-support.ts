import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, type Locator, type Page } from "@playwright/test";
import { coveredCamera, type Camera } from "./camera-bounds-oracle";

export { coveredCamera, type Camera } from "./camera-bounds-oracle";
type PaintedCamera = Camera & {
  height: number;
  padding: { top: number; bottom: number; left: number; right: number };
};

export const ordinary: Camera = {
  lng: 12.1234567, lat: 30.1234567, zoom: 10.1234567,
  pitch: 30.1234567, bearing: -17.1234567,
};

/** A real loopback style, also reachable by the server's export browser.
 * No tiles, glyphs or external network timing participate in camera proof. */
export async function startCameraBasemap() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ version: 8, sources: {}, layers: [
      { id: "background", type: "background", paint: { "background-color": "#d8e8d0" } },
    ] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/style.json`,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

export async function paintedCamera(host: Locator): Promise<PaintedCamera> {
  await expect(host).toHaveAttribute("data-camera-painted", "true");
  const value = await host.getAttribute("data-map-camera");
  if (!value) throw new Error("The shared host has no painted camera");
  return JSON.parse(value) as PaintedCamera;
}

export async function expectPaintedCamera(host: Locator, requested: Camera) {
  await expect(host).toBeVisible();
  await expect.poll(async () => {
    const live = await paintedCamera(host);
    const height = await host.evaluate(el => el.clientHeight);
    const expected = coveredCamera(requested, height, live.padding.top, live.padding.bottom);
    // Resize updates the DOM before the renderer paints its new size.
    // Return that transient mismatch to the poller instead of throwing
    // inside the callback, which would abort the retry immediately.
    return Math.max(Math.abs(live.height - height), ...(["lng", "lat", "zoom", "pitch", "bearing"] as const)
      .map(field => Math.abs(live[field] - expected[field])));
  }, { message: `painted camera matches ${JSON.stringify(requested)}` }).toBeLessThan(1e-7);
  // Hold the assertion past startup/resize observers and the camera save
  // debounce, so a transient correct first frame cannot certify a later fit.
  await host.page().waitForTimeout(1_200);
  const live = await paintedCamera(host);
  expect(live.height).toBe(await host.evaluate(el => el.clientHeight));
  const expected = coveredCamera(requested, live.height, live.padding.top, live.padding.bottom);
  for (const field of ["lng", "lat", "zoom", "pitch", "bearing"] as const) {
    expect(live[field], field).toBeCloseTo(expected[field], 7);
  }
  return live;
}

export function imageDefinition(camera: Camera, height = 512) {
  return { viewport: camera, size: { width: 512, height }, mapScale: 1,
    legend: { visible: false, corner: "bottom-left", size: "m" },
    widgets: [], title: null, appearance: "light" };
}

export async function openRender(page: Page, mapId: string, definition: ReturnType<typeof imageDefinition>) {
  await page.addInitScript(def => {
    (window as unknown as { __DEZFIL_EXPORT_DEFINITION__: unknown }).__DEZFIL_EXPORT_DEFINITION__ = def;
  }, definition);
  await page.goto(`/render/${mapId}`);
  await expect(page.locator("[data-export-root]")).toHaveAttribute("data-export-ready", "true", { timeout: 30_000 });
  return page.locator("[data-export-root] [data-map-camera]");
}

export async function openPreview(page: Page) {
  const builderHost = page.locator("[data-map-camera]");
  const builder = await paintedCamera(builderHost);
  const canvasWidth = await page.locator("[data-drag-canvas]").evaluate(el => el.clientWidth);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const image = page.getByRole("menuitem", { name: /^Image/ });
  await expect(image).not.toHaveAttribute("aria-disabled", "true");
  await image.click();
  const dialog = page.getByRole("dialog", { name: "Export image" });
  await expect(dialog).toBeVisible();
  const host = dialog.locator("[data-map-camera]");
  await expect(host).toHaveAttribute("data-camera-painted", "true");
  const width = await host.evaluate(el => el.clientWidth);
  // The definition compensates for its authored composition width. Measure
  // layout pixels, never a screenshot rectangle scaled to fit the dialog.
  const requested = { ...builder, zoom: builder.zoom + Math.log2(width / canvasWidth) };
  await expectPaintedCamera(host, requested);
  return { host, requested, dialog };
}
