// The server-export flow: the endpoint renders through the app's own
// client in a headless browser the SERVER drives (provisioned via
// DEZFIL_CHROMIUM_PATH — see the runbook). Arms map to the spec's
// criteria: exact dimensions and schema-validated refusals (1),
// per-element probes shared with the card spec plus differentials (2),
// the readiness contract red-proven against the route itself (3),
// published-path independence including an exhausted anonymous rate
// bucket (4), and concurrency without cross-contamination (6). The
// timeout, crash and missing-browser arms live in the renderer's unit
// suite and the container evidence — a second server boot per arm is the
// container run's job, stated in the verification record.
import path from "node:path";
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test as base, expect, type Page } from "@playwright/test";
import {
  FIXTURES_DIR,
  addLayer,
  createMap,
  patchLayer,
  patchMap,
  publishMap,
  routeHouse,
  seedCsv,
} from "./support";
import { markStats, pngStats } from "./png-probes";

import { startLoopbackBasemap, assertBasemapTraffic } from "../scripts/loopback-basemap.mjs";

type Basemaps = Map<string, Awaited<ReturnType<typeof startLoopbackBasemap>>>;
const test = base.extend<{ basemaps: Basemaps }>({
  // Fixtures are per map, including the simultaneous-render arm. A render
  // on one map cannot borrow another's style or tile requests.
  basemaps: async ({ page }, provide) => {
    const basemaps: Basemaps = new Map();
    try {
      await provide(basemaps);
    } finally {
      // Stop any preview before closing its loopback source.
      try {
        await page.goto("about:blank");
      } finally {
        await Promise.all([...basemaps.values()].map((fixture) => fixture.close()));
      }
    }
  },
});

const runId = Date.now().toString(36);
const tableName = `srv_${runId}`;

const KELP = { r: 26, g: 93, b: 74 };
const AMBER = { r: 233, g: 179, b: 91 };

async function seed(page: Page, basemaps?: Basemaps): Promise<{ mapId: string; layerId: string }> {
  await page.goto("/maps");
  const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
  await seedCsv(page, tableName, csv);
  const mapId = await createMap(page, "Server export");
  const layerId = await addLayer(
    page,
    mapId,
    "stations",
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
          { r: KELP.r, g: KELP.g, b: KELP.b, a: 1 },
          { r: AMBER.r, g: AMBER.g, b: AMBER.b, a: 1 },
        ],
      },
      fillOpacity: 1,
      stroke: { r: 12, g: 16, b: 24, a: 1 },
      strokeOpacity: 1,
      strokeWidth: 0,
      pointRadius: 6,
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
  if (basemaps) {
    const fixture = await startLoopbackBasemap();
    basemaps.set(mapId, fixture);
    await patchMap(page, mapId, {
      customBasemap: { url: fixture.styleUrl, name: "Export fixture", force: true },
    });
  }
  return { mapId, layerId };
}

/** A stations-framed definition; overrides compose variants. */
function definition(overrides: Record<string, unknown> = {}) {
  return {
    viewport: { lng: 13.37, lat: 52.5, zoom: 10.5, pitch: 0, bearing: 0 },
    size: { width: 960, height: 540 },
    legend: { visible: true, corner: "bottom-left", size: "m" },
    widgets: ["w-hist"],
    title: { text: "Server render", size: "m" },
    appearance: "light",
    overlayScale: 2,
    ...overrides,
  };
}

async function exportPng(
  basemaps: Basemaps,
  page: Page,
  mapId: string,
  def: Record<string, unknown>,
): Promise<{
  status: number;
  png: Buffer | null;
  error?: string;
  /** The worded reason — a refusal that cannot say why is half a
   * refusal, so the arms assert on this rather than on the code. */
  message?: string;
}> {
  const fixture = basemaps.get(mapId);
  if (!fixture) throw new Error("server export map has no traffic fixture");
  const zoom = (def.viewport as { zoom: number }).zoom;
  const before = fixture.snapshot(zoom);
  const out = await page.evaluate(
    async ({ mapId, def }) => {
      const r = await fetch(`/api/maps/${mapId}/export/image`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definition: def }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        return {
          status: r.status,
          b64: null,
          error: body?.error?.code ?? "unknown",
          message: body?.error?.message ?? "",
        };
      }
      const buf = new Uint8Array(await r.arrayBuffer());
      let s = "";
      for (const b of buf) s += String.fromCharCode(b);
      return {
        status: r.status, b64: btoa(s), error: null, message: "",
        abandoned: r.headers.get("x-dezfil-export-abandoned"),
      };
    },
    { mapId, def },
  );
  const traffic = fixture.delta(before, zoom);
  console.log(`export ${mapId} ${JSON.stringify({ status: out.status, ...traffic })}`);
  if (out.status === 200) {
    assertBasemapTraffic(traffic);
    expect(out.abandoned, "ordinary exports abandon no basemap request").toBeNull();
  }
  return {
    status: out.status,
    png: out.b64 ? Buffer.from(out.b64, "base64") : null,
    error: out.error ?? undefined,
    message: out.message || undefined,
  };
}

test.describe("server-side image export", () => {
  test("renders, refuses, stays independent of publishing, and holds under concurrency", async ({
    page,
    context,
    basemaps,
  }) => {
    await routeHouse(context);
    const { mapId } = await seed(page, basemaps);

    await test.step("exact pixels, every element present", async () => {
      const { status, png } = await exportPng(basemaps, page, mapId, definition());
      expect(status).toBe(200);
      if (!png) throw new Error("no PNG returned");
      expect(png.readUInt32BE(16)).toBe(960);
      expect(png.readUInt32BE(20)).toBe(540);
      const stats = await pngStats(page, png);
      const kelpTotal = stats.kelpLeft + stats.kelpCenter + stats.kelpRight;
      expect(kelpTotal).toBeGreaterThan(60);
      expect(stats.kelpBottomLeft).toBeGreaterThan(30);
      expect(stats.amberBottomLeft).toBeGreaterThan(30);
      expect(stats.inkTopLeft).toBeGreaterThan(100);
      expect(stats.inkBottomRight).toBeGreaterThan(20);
      expect(stats.accentTopRight).toBeGreaterThan(30);
    });

    await test.step("removing each element removes its signal", async () => {
      const { png } = await exportPng(
        basemaps,
        page,
        mapId,
        definition({
          legend: { visible: false, corner: "bottom-left", size: "m" },
          widgets: [],
          title: null,
        }),
      );
      if (!png) throw new Error("no PNG returned");
      const stats = await pngStats(page, png);
      expect(stats.amberBottomLeft).toBeLessThanOrEqual(2);
      expect(stats.accentTopRight).toBeLessThanOrEqual(8);
      expect(stats.inkTopLeft).toBeLessThanOrEqual(40);
    });

    await test.step("schema refusals name the field", async () => {
      const over = await exportPng(
        basemaps,
        page,
        mapId,
        definition({ size: { width: 99_999, height: 540 } }),
      );
      expect(over.status).toBe(400);
      expect(over.error).toBe("invalid_request");
      const unknownField = await exportPng(basemaps, page, mapId, {
        ...definition(),
        aspect: "16:9",
      });
      expect(unknownField.status).toBe(400);
      const badAppearance = await exportPng(
        basemaps,
        page,
        mapId,
        definition({ appearance: "sepia" }),
      );
      expect(badAppearance.status).toBe(400);
    });

    await test.step("publishing and its exhausted rate bucket change nothing", async () => {
      const token = await publishMap(page, mapId);
      // Exhaust the anonymous published-view bucket for this window.
      const exhausted = await page.evaluate(async (token) => {
        let last = 200;
        for (let i = 0; i < 70; i += 1) {
          const r = await fetch(`/api/published/${token}`);
          last = r.status;
          if (last === 429) break;
        }
        return last;
      }, token);
      expect(exhausted).toBe(429);
      // The private map-id export rides its own road, untouched.
      const { status, png } = await exportPng(basemaps, page, mapId, definition());
      expect(status).toBe(200);
      if (!png) throw new Error("no PNG returned");
      const stats = await pngStats(page, png);
      expect(
        stats.kelpLeft + stats.kelpCenter + stats.kelpRight,
      ).toBeGreaterThan(60);
    });

    await test.step("every conjunct — hidden layers, stored filters, projection", async () => {
      // A restrictive published-field projection must change nothing:
      // same probe counts before and after (the projection narrows the
      // published wire's properties, never the private render).
      const before = await exportPng(basemaps, page, mapId, definition());
      if (!before.png) throw new Error("no baseline PNG");
      const beforeStats = await pngStats(page, before.png);
      await page.evaluate(async (id) => {
        const maps = await fetch(`/api/maps/${id}`).then((r) => r.json());
        const layer = maps.layers[0];
        await fetch(`/api/layers/${layer.id}`, {
          method: "PATCH",
          headers: { "X-Edit-Revision": maps.editRevision, "content-type": "application/json" },
          body: JSON.stringify({ publishedFields: ["name"] }),
        });
      }, mapId);
      const after = await exportPng(basemaps, page, mapId, definition());
      if (!after.png) throw new Error("no post-projection PNG");
      const afterStats = await pngStats(page, after.png);
      const total = (s: typeof beforeStats) =>
        s.kelpLeft + s.kelpCenter + s.kelpRight;
      expect(
        Math.abs(total(afterStats) - total(beforeStats)),
      ).toBeLessThanOrEqual(total(beforeStats) * 0.1);

      // A stored filter narrows what the export draws: fewer data
      // pixels than the unfiltered baseline (4 stations → 1).
      await page.evaluate(async (id) => {
        const maps = await fetch(`/api/maps/${id}`).then((r) => r.json());
        const layer = maps.layers[0];
        await fetch(`/api/layers/${layer.id}`, {
          method: "PATCH",
          headers: { "X-Edit-Revision": maps.editRevision, "content-type": "application/json" },
          body: JSON.stringify({
            filters: [
              { field: "riders", kind: "range", min: 10000, max: null },
            ],
          }),
        });
      }, mapId);
      const filtered = await exportPng(basemaps, page, mapId, definition());
      if (!filtered.png) throw new Error("no filtered PNG");
      const filteredStats = await pngStats(page, filtered.png);
      expect(total(filteredStats)).toBeLessThan(total(beforeStats) * 0.6);

      // A hidden layer is absent: hide it and the data pixels leave
      // entirely (legend off too — its chips would count).
      await page.evaluate(async (id) => {
        const maps = await fetch(`/api/maps/${id}`).then((r) => r.json());
        const layer = maps.layers[0];
        await fetch(`/api/layers/${layer.id}`, {
          method: "PATCH",
          headers: { "X-Edit-Revision": maps.editRevision, "content-type": "application/json" },
          body: JSON.stringify({ visible: false, filters: [] }),
        });
      }, mapId);
      const hidden = await exportPng(
        basemaps,
        page,
        mapId,
        definition({
          legend: { visible: false, corner: "bottom-left", size: "m" },
          widgets: [],
        }),
      );
      if (!hidden.png) throw new Error("no hidden-layer PNG");
      const hiddenStats = await pngStats(page, hidden.png);
      expect(total(hiddenStats)).toBeLessThanOrEqual(2);

      // Restore for the following arms.
      await page.evaluate(async (id) => {
        const maps = await fetch(`/api/maps/${id}`).then((r) => r.json());
        const layer = maps.layers[0];
        await fetch(`/api/layers/${layer.id}`, {
          method: "PATCH",
          headers: { "X-Edit-Revision": maps.editRevision, "content-type": "application/json" },
          body: JSON.stringify({ visible: true, publishedFields: null }),
        });
      }, mapId);
    });

    await test.step("the scale still sets the composition's extent", async () => {
      // The same camera and output size at a higher scale lays the
      // composition out in a SMALLER space, which frames tighter ground.
      // This arm proved it by mark size; pinned the marks to their share
      // (the field round's directive), so the honest signal left is the
      // extent itself: the tight frame crops stations the wide one
      // shows, so it carries strictly fewer mark pixels. A renderer that
      // ignores the scale draws two identical images and fails the
      // comparison in this direction too.
      const tight = await exportPng(
        basemaps,
        page,
        mapId,
        definition({
          overlayScale: 3,
          legend: { visible: false, corner: "bottom-left", size: "m" },
          widgets: [],
          title: null,
        }),
      );
      const wide = await exportPng(
        basemaps,
        page,
        mapId,
        definition({
          overlayScale: 1,
          legend: { visible: false, corner: "bottom-left", size: "m" },
          widgets: [],
          title: null,
        }),
      );
      if (!tight.png || !wide.png) throw new Error("scale renders failed");
      const tightStats = await pngStats(page, tight.png);
      const wideStats = await pngStats(page, wide.png);
      const total = (s: typeof wideStats) =>
        s.kelpLeft + s.kelpCenter + s.kelpRight;
      // Both measured at all — the vacuity guard — then the crop.
      expect(total(wideStats)).toBeGreaterThan(200);
      expect(total(tightStats)).toBeGreaterThan(0);
      expect(total(tightStats)).toBeLessThan(total(wideStats) * 0.8);
    });

    await test.step("two simultaneous distinct renders, no cross-contamination", async () => {
      const { mapId: secondMapId } = await seed(page, basemaps);
      const [a, b] = await Promise.all([
        exportPng(
          basemaps,
          page,
          mapId,
          definition({
            size: { width: 640, height: 360 },
            title: { text: "AAAA", size: "l" },
          }),
        ),
        exportPng(
          basemaps,
          page,
          secondMapId,
          definition({
            size: { width: 800, height: 600 },
            title: null,
            legend: { visible: false, corner: "bottom-left", size: "m" },
            widgets: [],
          }),
        ),
      ]);
      if (!a.png || !b.png) throw new Error("a concurrent render failed");
      expect(a.png.readUInt32BE(16)).toBe(640);
      expect(a.png.readUInt32BE(20)).toBe(360);
      expect(b.png.readUInt32BE(16)).toBe(800);
      expect(b.png.readUInt32BE(20)).toBe(600);
      const statsA = await pngStats(page, a.png);
      const statsB = await pngStats(page, b.png);
      // A carries its big title; B must not have inherited it (or the
      // legend, or the rail).
      expect(statsA.inkTopLeft).toBeGreaterThan(80);
      expect(statsB.inkTopLeft).toBeLessThanOrEqual(40);
      expect(statsB.amberBottomLeft).toBeLessThanOrEqual(2);
      expect(statsB.accentTopRight).toBeLessThanOrEqual(8);
    });
  });

  test("the readiness contract is load-bearing — red-proven on the route", async ({
    page,
    context,
  }) => {
    await routeHouse(context);
    const { mapId } = await seed(page);
    const def = definition();

    // Drive the bare route directly with a HELD widget-values answer: the
    // ready attribute must not appear while an input is unsettled — a
    // screenshot taken then (the seeded early-screenshot defect) fails
    // the element probes because the composition is not final.
    let releaseValues: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseValues = r;
    });
    await context.route("**/widget-values", async (route) => {
      await gate;
      await route.continue();
    });
    await page.addInitScript((d) => {
      (
        window as { __DEZFIL_EXPORT_DEFINITION__?: unknown }
      ).__DEZFIL_EXPORT_DEFINITION__ = d;
    }, def);
    await page.setViewportSize({ width: 960, height: 540 });
    await page.goto(`/render/${mapId}`);
    await expect(page.locator("[data-export-root]")).toBeVisible({
      timeout: 30_000,
    });
    // Held input ⇒ no readiness, even with the map long settled.
    await page.waitForTimeout(2_500);
    await expect(page.locator('[data-export-ready="true"]')).toHaveCount(0);
    // The release settles the input; readiness follows.
    releaseValues();
    await expect(page.locator('[data-export-ready="true"]')).toBeVisible({
      timeout: 30_000,
    });
  });
});

test.describe("the map's drawn size, on the server road", () => {
  test("the step changes the drawing, not the ground; and the new refusals bite", async ({
    page,
    context,
    basemaps,
  }) => {
    await routeHouse(context);
    const { mapId } = await seed(page, basemaps);

    await test.step("same ground, same marks — the step is the basemap's", async () => {
      // Two exports differing ONLY in the map's drawn size, with EVERY
      // overlay disabled: no legend, no widgets, no title, so the
      // measured pixels are the data and nothing else — the invariant
      // overlays would otherwise satisfy the floor while masking the
      // data entirely (found at review). The data's share DROPPED at
      // the finer step; the field round ruled that wrong, so this is
      // that arm inverted: the share now holds.
      const bare = {
        legend: { visible: false, corner: "bottom-left", size: "m" },
        widgets: [] as string[],
        title: null as null,
      };
      const coarse = await exportPng(
        basemaps,
        page,
        mapId,
        definition({
          ...bare,
          mapScale: 2,
          overlayScale: undefined,
          viewport: { lng: 13.37, lat: 52.5, zoom: 10.5, pitch: 0, bearing: 0 },
        }),
      );
      const fine = await exportPng(
        basemaps,
        page,
        mapId,
        definition({
          ...bare,
          mapScale: 1,
          overlayScale: undefined,
          viewport: { lng: 13.37, lat: 52.5, zoom: 11.5, pitch: 0, bearing: 0 },
        }),
      );
      expect(coarse.status, coarse.message).toBe(200);
      expect(fine.status, fine.message).toBe(200);
      const a = await markStats(page, coarse.png!);
      const b = await markStats(page, fine.png!);

      // Same pixels out — the step is not a size control.
      expect(b.width).toBe(a.width);
      expect(b.height).toBe(a.height);
      // Marks were measured at all — the vacuity guard.
      expect(a.share).toBeGreaterThan(0.001);
      expect(b.share).toBeGreaterThan(0.001);
      // Same ground: the data's centre of mass sits in the same place.
      expect(Math.abs(b.cx - a.cx)).toBeLessThan(0.04);
      expect(Math.abs(b.cy - a.cy)).toBeLessThan(0.04);
      // Same marks: the data's share is invariant. The neutral raster
      // fixture supplies basemap pixels and traffic, but has no detail
      // whose refinement could establish the basemap's visual resolution.
      expect(Math.abs(b.share - a.share)).toBeLessThan(a.share * 0.15);
    });

    await test.step("an awkward shape lands exactly the pixels asked for", async () => {
      // Nothing here is a round number and 913:667 is no preset\'s ratio;
      // the check is against the REQUEST, not against a number the
      // renderer derived from the same state.
      const odd = await exportPng(
        basemaps,
        page,
        mapId,
        definition({
          size: { width: 913, height: 667 },
          mapScale: 1,
          overlayScale: undefined,
        }),
      );
      expect(odd.status, odd.error).toBe(200);
      const stats = await markStats(page, odd.png!);
      expect(stats.width).toBe(913);
      expect(stats.height).toBe(667);
    });

    await test.step("a scale that cannot lay out in whole pixels is refused, not rounded", async () => {
      // Found by the criterion above on its first run: 913x667 at scale
      // 1.37 came back 913x666. An image a pixel short is a wrong number
      // presented as a fact, so the definition is refused with the
      // reason instead.
      const fractional = await exportPng(
        basemaps,
        page,
        mapId,
        definition({
          size: { width: 913, height: 667 },
          mapScale: 1.37,
          overlayScale: undefined,
        }),
      );
      expect(fractional.status).toBe(400);
      expect(fractional.message ?? "").toMatch(/whole composition pixels/);
    });

    await test.step("an image too narrow for its credit is refused", async () => {
      const tiny = await exportPng(
        basemaps,
        page,
        mapId,
        definition({ size: { width: 200, height: 150 } }),
      );
      expect(tiny.status).toBe(400);
      expect(tiny.message ?? "").toMatch(/480/);
    });

    await test.step("the working canvas is bounded, with the reason", async () => {
      const vast = await exportPng(
        basemaps,
        page,
        mapId,
        definition({
          size: { width: 3000, height: 2000 },
          mapScale: 0.25,
          overlayScale: undefined,
        }),
      );
      expect(vast.status).toBe(400);
      expect(vast.message ?? "").toMatch(/composition pixels/);
    });

    await test.step("a definition from before this feature still renders", async () => {
      // The earlier field name, and nothing else — exactly what an
      // agent could have written the day before.
      const legacy = await exportPng(
        basemaps,
        page,
        mapId,
        definition({ overlayScale: 2, mapScale: undefined }),
      );
      expect(legacy.status, legacy.error).toBe(200);
      const stats = await markStats(page, legacy.png!);
      expect(stats.width).toBe(960);
      expect(stats.height).toBe(540);
      expect(stats.share).toBeGreaterThan(0.001);
    });

    await test.step("the override travels the server road and draws the data unchanged", async () => {
      // What this arm can prove here: an override in the definition is
      // accepted, renders, and does not disturb the data. What it CANNOT
      // prove is labels or roads disappearing: the neutral raster fixture
      // has no such content groups. Its pixels and traffic establish the
      // basemap loaded; the override's visual effect remains unmeasured.
      const plain = await exportPng(basemaps, page, mapId, definition());
      const overridden = await exportPng(
        basemaps,
        page,
        mapId,
        definition({ basemapLayers: { labels: false, roads: false } }),
      );
      expect(plain.status, plain.message).toBe(200);
      expect(overridden.status, overridden.message).toBe(200);
      const a = await markStats(page, plain.png!);
      const b = await markStats(page, overridden.png!);
      expect(b.width).toBe(a.width);
      expect(Math.abs(b.share - a.share)).toBeLessThan(0.002);
    });
  });
});

// A basemap tile that never answers: the export must not spend its whole
// budget waiting on one external request. A loopback raster style serves
// a one-pixel tile for every request but the first, which it holds open
// for ever; on the branch the renderer abandons it at the per-request
// budget, the page settles, the image comes back with the count in its
// header. Against `main` this answers the coded timeout at the export
// budget.
test.describe("the export outlives a stalled basemap request", () => {
  test("one tile that never answers costs at most the per-request budget, said in a header", async ({
    page,
    context,
  }) => {
    test.setTimeout(240_000);
    await routeHouse(context);
    const { mapId } = await seed(page);
    const ONE_PX = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    const held: ServerResponse[] = [];
    let served = 0;
    let tiles = "";
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      // The page fetches the style and its tiles cross-origin: without
      // the CORS header the style fails to load and the page settles on
      // its offline fallback, which is not the case under test.
      const cors = { "access-control-allow-origin": "*" };
      if (url.pathname === "/style.json") {
        res.writeHead(200, { "content-type": "application/json", ...cors });
        res.end(
          JSON.stringify({
            version: 8,
            sources: { t: { type: "raster", tiles: [tiles], tileSize: 256 } },
            layers: [{ id: "t", type: "raster", source: "t" }],
          }),
        );
        return;
      }
      if (url.pathname.startsWith("/tiles/")) {
        served += 1;
        // The first VIEWPORT tile asked for never answers; every other one
        // does. The map prefetches parent tiles too (a lower zoom), and a
        // parent that never arrives does not hold the map's idle — only a
        // tile the viewport needs does, which is what the stall is about.
        const z = Number(url.pathname.split("/")[2]);
        if (held.length === 0 && z >= 10) {
          held.push(res);
          return;
        }
        res.writeHead(200, { "content-type": "image/png", ...cors });
        res.end(ONE_PX);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    tiles = `http://127.0.0.1:${port}/tiles/{z}/{x}/{y}.png`;
    try {
      await patchMap(page, mapId, {
        customBasemap: {
          url: `http://127.0.0.1:${port}/style.json`,
          name: "Stalling tiles",
          force: true,
        },
      });
      const started = Date.now();
      const r = await page.request.post(`/api/maps/${mapId}/export/image`, {
        data: { definition: definition() },
        timeout: 200_000,
      });
      const elapsed = Date.now() - started;
      const body = r.status() === 200 ? "" : await r.text();
      expect(r.status(), body).toBe(200);
      expect(r.headers()["content-type"]).toBe("image/png");
      expect(r.headers()["x-dezfil-export-abandoned"]).toBe(
        "1; hosts=127.0.0.1",
      );
      // A decodable PNG of the definition's size, not merely a 200 with the
      // right content type: the signature and the IHDR.
      const png = await r.body();
      expect(png.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([960, 540]);
      // Well inside the export budget: the per-request bound plus the settle.
      expect(elapsed).toBeLessThan(60_000);
      expect(served).toBeGreaterThan(1);
    } finally {
      for (const h of held) h.destroy();
      server.close();
    }
  });
});
