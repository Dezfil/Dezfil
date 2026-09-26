// Single-colour legend rows ('s constant half).
//
// Everything is measured — swatch colours against the stored style,
// row presence across the four surfaces, the export dialog's derived
// state — never a class name. The filled fixture is a point table, the
// stroked fixture a line table; the swatch must show the colour each
// actually draws.
//
// Environment: the documented gate (isolated server, fresh data dir).
// Run with DEZFIL_BASE_URL at the server.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  addLayer,
  createMap,
  publishMap,
  seedFile,
  trackConsole,
} from "./support";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const runId = Date.now().toString(36);
const points = `crow_pts_${runId}`;
const lines = `crow_lin_${runId}`;

const WIDE = { width: 1440, height: 900 };

const rgba = (c: { r: number; g: number; b: number; a: number }) =>
  `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;

async function seedMap(page: Page): Promise<{
  mapId: string;
  fillColor: string;
  strokeColor: string;
}> {
  await page.goto("/maps");
  await seedFile(
    page,
    `${points}.geojson`,
    readFileSync(path.join(FIXTURES_DIR, "stations.geojson"), "utf8"),
    "application/geo+json",
  );
  await seedFile(
    page,
    `${lines}.geojson`,
    readFileSync(path.join(FIXTURES_DIR, "paths.geojson"), "utf8"),
    "application/geo+json",
  );
  const mapId = await createMap(page, `crows ${runId}`);
  await addLayer(page, mapId, points, `SELECT * FROM ${points}`);
  await addLayer(page, mapId, lines, `SELECT * FROM ${lines}`);
  // The stored constant colours are the swatch truth.
  const styles = await page.evaluate(async (id) => {
    const m = (await (
      await fetch(`/api/maps/${id}`, { cache: "no-store" })
    ).json()) as {
      layers: {
        name: string;
        style: {
          fill: { type: string; color?: { r: number; g: number; b: number; a: number } };
          stroke: { r: number; g: number; b: number; a: number };
        };
      }[];
    };
    return m.layers.map((l) => ({
      name: l.name,
      fill: l.style.fill.color ?? null,
      stroke: l.style.stroke,
    }));
  }, mapId);
  const pts = styles.find((s) => s.name.startsWith("crow_pts"))!;
  const lin = styles.find((s) => s.name.startsWith("crow_lin"))!;
  return { mapId, fillColor: rgba(pts.fill!), strokeColor: rgba(lin.stroke) };
}

/** The legend card's constant rows: [title, computed swatch colour]. */
async function constantRows(scope: Page, root = "[data-corner]") {
  const prefix = root ? `${root} ` : "";
  return scope.locator(`${prefix}[class*="constantRow"]`).evaluateAll((rows) =>
    rows.map((row) => ({
      title: row.textContent?.trim() ?? "",
      swatch: window.getComputedStyle(
        row.querySelector('[class*="swatch"]')!,
      ).backgroundColor,
    })),
  );
}

const toRgb = (c: string) =>
  c.replace(/rgba\(([\d, ]+), 1\)/, "rgb($1)");

test.use({ viewport: WIDE });

test("constant rows across builder, published, and both export roads — swatches truthful per geometry", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const consoleErrors = trackConsole(page);
  const { mapId, fillColor, strokeColor } = await seedMap(page);

  // Publish FIRST (the ruling's shape: an existing link, no republish
  // after the feature's state exists — the token minted here is the one
  // asserted at the end, with no second publish call anywhere).
  await page.goto(`/maps/${mapId}`);
  const token = await publishMap(page, mapId);

  // Builder overlay: a legend card exists for a constant-only map, one
  // row per layer, each swatch the drawn colour.
  await expect(page.locator("[data-corner] [class*='constantRow']")).toHaveCount(
    2,
    { timeout: 30_000 },
  );
  const builderRows = await constantRows(page);
  const byTitle = Object.fromEntries(builderRows.map((r) => [r.title, r.swatch]));
  expect(byTitle[points]).toBe(toRgb(fillColor));
  expect(byTitle[lines]).toBe(toRgb(strokeColor));

  // Title edit persists and re-renders; exclusion removes the row.
  await page
    .getByRole("tablist", { name: "Builder panels" })
    .getByRole("tab", { name: "Legend" })
    .click();
  const titleField = page
    .getByRole("textbox", { name: `Legend title, ${points}` })
    .or(page.locator(`input[aria-label*="${points}"]`).first());
  await titleField.fill("Stations set");
  await titleField.blur();
  await expect
    .poll(async () =>
      page.evaluate(async (id) => {
        const m = (await (
          await fetch(`/api/maps/${id}`, { cache: "no-store" })
        ).json()) as { layers: { name: string; legendTitle?: string | null }[] };
        return m.layers.find((l) => l.name.startsWith("crow_pts"))?.legendTitle;
      }, mapId),
    )
    .toBe("Stations set");
  await expect(
    page.locator("[data-corner]").getByText("Stations set"),
  ).toBeVisible();

  // The kit checkbox's input is visually hidden under its drawn box —
  // toggle through the label text, as a user would. (Rows are
  // data-legend-row divs sortable tab.)
  const lineName = page
    .locator("[data-legend-row]")
    .filter({ hasText: lines })
    .getByText(lines, { exact: true });
  await lineName.click();
  await expect(
    page.locator("[data-corner] [class*='constantRow']"),
  ).toHaveCount(1);
  await lineName.click();
  await expect(
    page.locator("[data-corner] [class*='constantRow']"),
  ).toHaveCount(2);
  // The re-inclusion must be durable truth before anything downstream
  // reads the map (the arrival-signal contract): poll the API, not the
  // optimistic row.
  await expect
    .poll(async () =>
      page.evaluate(async (id) => {
        const m = (await (
          await fetch(`/api/maps/${id}`, { cache: "no-store" })
        ).json()) as { layers: { name: string; inLegend?: boolean }[] };
        return m.layers.find((l) => l.name.startsWith("crow_lin"))?.inLegend;
      }, mapId),
    )
    .toBe(true);

  // The export dialog treats the constant-only map as legend-bearing:
  // include armed and checked, the legend's corner blocked for the credit.
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("menuitem", { name: /Image/ }).click();
  const dialog = page.getByRole("dialog", { name: "Export image" });
  const include = dialog.getByRole("switch", { name: /Include the legend/ });
  await expect(include).toBeEnabled();
  await expect(include).toBeChecked();
  await expect(
    dialog
      .getByRole("radiogroup", { name: "Credit corner" })
      .getByRole("radio", { name: "Bottom left", exact: true }),
  ).toBeDisabled();
  // The browser road's composition carries the rows.
  await expect(
    dialog.locator("[class*='constantRow']"),
  ).toHaveCount(2);
  await page.keyboard.press("Escape");

  // The token minted BEFORE the edits above — revisited, never
  // republished: the standing payload carries what the panel needs.
  await page.goto(`/v/${token}`);
  // The published view places its legend without the builder's corner
  // slots — scope by the row itself.
  await expect(page.locator("[class*='constantRow']")).toHaveCount(2, {
    timeout: 30_000,
  });
  const publishedRows = await constantRows(page, "");
  const pubByTitle = Object.fromEntries(
    publishedRows.map((r) => [r.title, r.swatch]),
  );
  expect(pubByTitle["Stations set"]).toBe(toRgb(fillColor));
  expect(pubByTitle[lines]).toBe(toRgb(strokeColor));

  expect(
    consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
  ).toEqual([]);
});

test("the server render composition carries the constant rows", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { mapId } = await seedMap(page);

  // The template the server suite drives the bare route with, widgets
  // empty — this map has none.
  const definition = {
    viewport: { lng: 13.38, lat: 52.5, zoom: 9, pitch: 0, bearing: 0 },
    size: { width: 960, height: 540 },
    legend: { visible: true, corner: "bottom-left", size: "m" },
    widgets: [],
    title: { text: "Server render", size: "m" },
    appearance: "light",
    overlayScale: 2,
  };

  await page.addInitScript((d) => {
    (window as { __DEZFIL_EXPORT_DEFINITION__?: unknown }).__DEZFIL_EXPORT_DEFINITION__ =
      d;
  }, definition);
  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto(`/render/${mapId}`);
  await expect(page.locator("[data-export-root]")).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.locator("[data-export-root] [class*='constantRow']"),
  ).toHaveCount(2, { timeout: 30_000 });
});

test("the browser-downloaded PNG carries the legend's pixels", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { mapId, fillColor } = await seedMap(page);
  const target = fillColor.match(/\d+/g)!.map(Number);

  await page.goto(`/maps/${mapId}`);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("menuitem", { name: /Image/ }).click();
  const dialog = page.getByRole("dialog", { name: "Export image" });
  await expect(dialog).toBeVisible();

  /** Count pixels near the layer's constant colour in the bottom-left
   * region, where the legend card sits — decoded in-browser, the
   * png-probes pattern. */
  const cornerCount = async (png: Buffer) =>
    page.evaluate(
      async ({ b64, rgb }) => {
        const raw = atob(b64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
        const bmp = await createImageBitmap(
          new Blob([bytes], { type: "image/png" }),
        );
        const c = document.createElement("canvas");
        c.width = bmp.width;
        c.height = bmp.height;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(bmp, 0, 0);
        const { data } = ctx.getImageData(0, 0, c.width, c.height);
        const near = (v: number, t: number) => Math.abs(v - t) <= 14;
        let count = 0;
        const x1 = Math.floor(bmp.width * 0.35);
        const y0 = Math.floor(bmp.height * 0.55);
        for (let y = y0; y < bmp.height; y += 1) {
          for (let x = 0; x < x1; x += 1) {
            const i = (y * bmp.width + x) * 4;
            if (
              near(data[i], rgb[0]) &&
              near(data[i + 1], rgb[1]) &&
              near(data[i + 2], rgb[2])
            )
              count += 1;
          }
        }
        return count;
      },
      { b64: png.toString("base64"), rgb: target },
    );

  const download = async () => {
    const waiting = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Download PNG" }).click();
    const file = await (await waiting).path();
    const { readFileSync } = await import("node:fs");
    return readFileSync(file!);
  };

  // With the legend on, the corner region carries the swatch's colour;
  // removing the legend removes its signal (the discriminator — map
  // data cannot fake a delta the toggle controls).
  const withLegend = await cornerCount(await download());
  await dialog
    .getByRole("switch", { name: /Include the legend/ })
    .uncheck();
  const withoutLegend = await cornerCount(await download());
  expect(withLegend).toBeGreaterThan(withoutLegend + 40);
});
