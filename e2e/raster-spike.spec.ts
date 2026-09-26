// The rasterizer spike (plan task 5): BEFORE the export card is wired to
// it, prove the chosen DOM-rasterization dependency (html-to-image)
// preserves the two hardest real overlay elements — the legend (chips,
// ramps, class rows) and a widget card (bars, numbers, Inter type) — at
// capture scale against the real builder DOM. The checks are the ones the
// plan names: exact scaled dimensions, the legend's own chip colors
// present, text ink drawn (fonts embedded, not blanked). A failure here
// stops the plan for revision (spec: hand-drawn re-rendering is not a
// fallback).
//
// This spec is the spike's record; it stays in the suite as a canary over
// the dependency, cheap and self-contained.
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import {
  FIXTURES_DIR,
  addLayer,
  createMap,
  patchLayer,
  patchMap,
  routeHouse,
  seedCsv,
} from "./support";
import { readFileSync } from "node:fs";

const runId = Date.now().toString(36);
const tableName = `spike_${runId}`;

const KELP = { r: 26, g: 93, b: 74 };
const AMBER = { r: 233, g: 179, b: 91 };
const SCALE = 3.2;

async function seed(page: Page): Promise<string> {
  await page.goto("/maps");
  const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
  await seedCsv(page, tableName, csv);
  const mapId = await createMap(page, "Spike");
  const layerId = await addLayer(
    page,
    mapId,
    "alpha",
    `SELECT * FROM "${tableName}"`,
  );
  await patchLayer(page, layerId, {
    style: {
      fill: {
        type: "quantile",
        attribute: "riders",
        palette: "global_warming",
        breaks: [12000],
        colors: [
          { r: KELP.r, g: KELP.g, b: KELP.b, a: 0.9 },
          { r: AMBER.r, g: AMBER.g, b: AMBER.b, a: 0.9 },
        ],
      },
      fillOpacity: 1,
      stroke: { r: 12, g: 16, b: 24, a: 1 },
      strokeOpacity: 1,
      strokeWidth: 0,
      pointRadius: 3,
      opacity: 1,
    },
  });
  await patchMap(page, mapId, {
    widgets: [
      {
        id: "w-hist",
        type: "histogram",
        layerId,
        title: "Riders",
        field: "riders",
        agg: "count",
        aggField: null,
        unit: null,
        note: null,
        format: null,
        visible: true,
      },
    ],
  });
  return mapId;
}

interface RasterProbe {
  width: number;
  height: number;
  nodeWidth: number;
  nodeHeight: number;
  opaque: number;
  ink: number;
  kelp: number;
  amber: number;
}

/** Rasterize `selector` with html-to-image at SCALE and measure the
 * result's pixels in-page. */
async function rasterize(page: Page, selector: string): Promise<RasterProbe> {
  return page.evaluate(
    async ({ selector, scale, kelp, amber }) => {
      type Raster = {
        toCanvas: (
          node: HTMLElement,
          opts: { pixelRatio: number },
        ) => Promise<HTMLCanvasElement>;
      };
      const lib = (window as unknown as { htmlToImage: Raster }).htmlToImage;
      const node = document.querySelector<HTMLElement>(selector);
      if (!node) throw new Error(`no node for ${selector}`);
      const rect = node.getBoundingClientRect();
      const canvas = await lib.toCanvas(node, { pixelRatio: scale });
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let opaque = 0;
      let ink = 0;
      let kelpHits = 0;
      let amberHits = 0;
      const d = img.data;
      const near = (v: number, t: number) => Math.abs(v - t) <= 12;
      for (let i = 0; i < d.length; i += 4) {
        const [r, g, b, a] = [d[i], d[i + 1], d[i + 2], d[i + 3]];
        if (a > 200) opaque += 1;
        // Dark pixels = drawn glyphs or strokes on the light panel.
        if (a > 200 && r < 90 && g < 90 && b < 90) ink += 1;
        if (a > 200 && near(r, kelp.r) && near(g, kelp.g) && near(b, kelp.b))
          kelpHits += 1;
        if (
          a > 200 &&
          near(r, amber.r) &&
          near(g, amber.g) &&
          near(b, amber.b)
        )
          amberHits += 1;
      }
      return {
        width: canvas.width,
        height: canvas.height,
        nodeWidth: rect.width,
        nodeHeight: rect.height,
        opaque,
        ink,
        kelp: kelpHits,
        amber: amberHits,
      };
    },
    { selector, scale: SCALE, kelp: KELP, amber: AMBER },
  );
}

test("spike: html-to-image holds the legend and a widget card at capture scale", async ({
  page,
  context,
}) => {
  await routeHouse(context);
  const mapId = await seed(page);
  await page.goto(`/maps/${mapId}`);
  await expect(page.getByText("12 features").first()).toBeVisible({
    timeout: 30_000,
  });

  await page.addScriptTag({
    path: path.join(
      __dirname,
      "..",
      "node_modules",
      "html-to-image",
      "dist",
      "html-to-image.js",
    ),
  });

  // The legend: real chips in the app's own classes and type.
  const legend = await rasterize(page, '[class*="LegendPanel"][class*="legend"]');
  // Exact scaled dimensions — a clamped or partial raster fails.
  expect(Math.abs(legend.width - legend.nodeWidth * SCALE)).toBeLessThanOrEqual(
    2,
  );
  expect(
    Math.abs(legend.height - legend.nodeHeight * SCALE),
  ).toBeLessThanOrEqual(2);
  // Mostly painted, not a transparent ghost.
  expect(legend.opaque).toBeGreaterThan(
    (legend.width * legend.height) / 2,
  );
  // Both class chips drew in their own colors.
  expect(legend.kelp).toBeGreaterThan(50);
  expect(legend.amber).toBeGreaterThan(50);
  // The legend's text drew — fonts embedded, glyph ink present.
  expect(legend.ink).toBeGreaterThan(200);

  // A widget card: bars and numbers in the rail.
  const widget = await rasterize(page, '[class*="Widgets"][class*="card"]');
  expect(Math.abs(widget.width - widget.nodeWidth * SCALE)).toBeLessThanOrEqual(
    2,
  );
  expect(widget.opaque).toBeGreaterThan((widget.width * widget.height) / 2);
  expect(widget.ink).toBeGreaterThan(150);
});
