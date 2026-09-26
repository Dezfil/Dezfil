// Layer-type matrix, part 2: icon and cluster — the two remaining
// never-browser-driven point visualizations — switched through the real
// style-panel tiles, glyph picked through the real picker, then batched
// publish and per-type read-back. The journey-held types (points, tiled
// point, heatmap, grid, hexbin, cell extrusion) are mapped to their
// existing journey evidence in the verification record, not re-driven
// here.
//
// Environment: the documented gate — production standalone,
// DEZFIL_RENDER_CAP_FEATURES=2000, third-party hosts blocked. Run via
// `npm run e2e:layers` with DEZFIL_BASE_URL pointing at the server.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  FIXTURES_DIR,
  addLayer,
  createMap,
  expectMapChanged,
  layerSaveArrived,
  mapShot,
  publishMap,
  readLayer,
  readPublished,
  routeHouse,
  saveSettled,
  seedCsv,
  seedFile,
  trackConsole,
} from "./support";

const runId = Date.now().toString(36);
const tableName = `mx2pts_${runId}`;

test("icon and cluster: create → style → publish → read-back through the real tiles", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context);

  await test.step("seed: one point table, one map, two layers", async () => {
    await page.goto("/maps");
    const csv = readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8");
    await seedCsv(page, tableName, csv);
  });

  const mapId = await createMap(page, "matrix: icon and cluster");
  let iconId = "";
  let clusterId = "";

  await test.step("icon: the tile switches the viz, the picker sets the glyph", async () => {
    iconId = await addLayer(
      page,
      mapId,
      `${tableName} icons`,
      `SELECT * FROM ${tableName}`,
    );
    await page.goto(`/maps/${mapId}`);
    await expect(
      page.getByRole("button", { name: new RegExp(`^${tableName} icons`) }),
    ).toBeVisible({ timeout: 30_000 });
    const pointsBase = await mapShot(page);

    await page
      .getByRole("button", { name: new RegExp(`^${tableName} icons`) })
      .first()
      .click();
    const iconTile = page.getByRole("button", { name: "Icon", exact: true });
    await expect(iconTile).toBeVisible();
    const switched = layerSaveArrived(page);
    await iconTile.click();
    await switched;
    await expect(iconTile).toHaveAttribute("data-active", "true");
    await expectMapChanged(page, pointsBase);
    await saveSettled(page);

    // The glyph picker announces each glyph by name; pick the cafe.
    const glyphBase = await mapShot(page);
    const cafe = page.getByRole("button", { name: "cafe", exact: true });
    await expect(cafe).toBeVisible();
    const glyphSaved = layerSaveArrived(page);
    await cafe.click();
    await glyphSaved;
    await expectMapChanged(page, glyphBase);
    await saveSettled(page);
    const layer = await readLayer<{
      viz: { type: string; glyph: string; customSvg?: string | null };
    }>(page, iconId);
    // **The glyph is what the picker set, and no custom SVG came with it.**
    // Asserted as two facts rather than as one exact object: the icon viz
    // gained a `customSvg` key when custom icons shipped, and it persists as an
    // explicit null for a curated glyph — so an exact-shape assertion went red
    // against working code and stayed red on `main`. This still fails if a
    // custom SVG leaks in, which is the thing worth catching.
    expect(layer.viz).toMatchObject({ type: "icon", glyph: "cafe" });
    expect(layer.viz.customSvg ?? null).toBeNull();
  });

  await test.step("cluster: the tile aggregates points into count bubbles", async () => {
    clusterId = await addLayer(
      page,
      mapId,
      `${tableName} clusters`,
      `SELECT * FROM ${tableName}`,
    );
    await page.reload();
    const row = page.getByRole("button", {
      name: new RegExp(`^${tableName} clusters`),
    });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.first().click();
    const clusterTile = page.getByRole("button", {
      name: "Cluster",
      exact: true,
    });
    await expect(clusterTile).toBeVisible();
    const base = await mapShot(page);
    const switched = layerSaveArrived(page);
    await clusterTile.click();
    await switched;
    await expect(clusterTile).toHaveAttribute("data-active", "true");
    await expectMapChanged(page, base);
    await saveSettled(page);
    const layer = await readLayer<{
      viz: { type: string; showCounts: boolean };
    }>(page, clusterId);
    expect(layer.viz.type).toBe("cluster");
    expect(layer.viz.showCounts).toBe(true);
  });

  let heatmapId = "";
  let gridId = "";
  await test.step("heatmap and grid ride the same batch for publish read-back", async () => {
    // Their builder truths are journey-held; what the journey never
    // asserted explicitly is their PUBLISHED read-back — two API layers
    // close exactly that gap on this batched publish.
    heatmapId = await addLayer(
      page,
      mapId,
      `${tableName} heat`,
      `SELECT * FROM ${tableName}`,
    );
    gridId = await addLayer(
      page,
      mapId,
      `${tableName} grid`,
      `SELECT * FROM ${tableName}`,
    );
    await page.evaluate(
      async ({ heatmapId, gridId }) => {
        for (const [id, viz] of [
          [
            heatmapId,
            { type: "heatmap", radiusPx: 30, intensity: 1, weight: "riders" },
          ],
          [
            gridId,
            { type: "grid", cellKm: 5, aggregate: { fn: "count" } },
          ],
        ] as const) {
          const r = await fetch(`/api/layers/${id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ viz }),
          });
          if (!r.ok) throw new Error(await r.text());
        }
      },
      { heatmapId, gridId },
    );
  });

  await test.step("publish once; all four types read back; the viewer paints clean", async () => {
    const token = await publishMap(page, mapId);
    type PublishedLayer = {
      id: string;
      viz: { type: string; glyph?: string };
      render: { ok: boolean };
    };
    const view = await readPublished<{ layers: PublishedLayer[] }>(
      page,
      token,
    );
    const byId = new Map(view.layers.map((l) => [l.id, l]));
    expect(byId.get(iconId)?.viz).toMatchObject({
      type: "icon",
      glyph: "cafe",
    });
    expect(byId.get(clusterId)?.viz.type).toBe("cluster");
    expect(byId.get(heatmapId)?.viz.type).toBe("heatmap");
    expect(byId.get(gridId)?.viz.type).toBe("grid");
    for (const id of [iconId, clusterId, heatmapId, gridId]) {
      expect(byId.get(id)?.render.ok).toBe(true);
    }

    await page.goto(`/v/${token}`);
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    await expect(page.getByText("basemap offline · data only")).toBeVisible();
    const unexpected = consoleErrors.filter(
      (e) => !isAllowedConsoleError(e.text, e.url),
    );
    expect(unexpected).toEqual([]);
  });
});

// The mixed family (a test-honesty gate):
// layer-service computes "MIXED" whenever a result carries more than one
// supported geometry type, and any SQL unioning points and polygons
// reaches it — but no browser drive covered the family until this one.
test("mixed geometry: a points∪polygons union renders as one layer; point-only tiles refuse with the documented prose", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context);

  const ptsTable = `mxgp_${runId}`;
  const polysTable = `mxga_${runId}`;
  const pts = readFileSync(path.join(FIXTURES_DIR, "stations.geojson"), "utf8");
  const polys = readFileSync(
    path.join(FIXTURES_DIR, "districts.geojson"),
    "utf8",
  );
  const expectedFeatures =
    (JSON.parse(pts) as { features: unknown[] }).features.length +
    (JSON.parse(polys) as { features: unknown[] }).features.length;

  let mapId = "";
  await test.step("seed: one point table, one polygon table, one union layer", async () => {
    await page.goto("/maps");
    await seedFile(page, `${ptsTable}.geojson`, pts, "application/geo+json");
    await seedFile(page, `${polysTable}.geojson`, polys, "application/geo+json");
    mapId = await createMap(page, `mixed geometry ${runId}`);
    await addLayer(
      page,
      mapId,
      `${ptsTable} mixed`,
      `SELECT name, geom FROM ${ptsTable} UNION ALL SELECT name, geom FROM ${polysTable}`,
    );
    await page.goto(`/maps/${mapId}`);
  });

  const card = () =>
    page.getByRole("button", { name: new RegExp(`^${ptsTable} mixed`) });
  const settledShot = async (): Promise<Buffer> => {
    let last = await mapShot(page);
    await expect
      .poll(
        async () => {
          await page.waitForTimeout(300);
          const next = await mapShot(page);
          const stable = next.equals(last);
          last = next;
          return stable;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    return last;
  };
  // Pixels whose channel delta exceeds antialiasing jitter (measured
  // chrome AA at max channel delta 16) — a family's paint moves thousands.
  // Only the TOP HALF of the shot is compared: the dev SQL dock overlays
  // the bottom of the canvas during the family switches, and its row-count
  // text must not masquerade as geometry paint.
  const diffPixels = (a: Buffer, b: Buffer): Promise<number> =>
    page.evaluate(
      async ({ a, b }) => {
        const decode = async (b64: string) => {
          const img = new Image();
          img.src = `data:image/png;base64,${b64}`;
          await img.decode();
          const canvas = document.createElement("canvas");
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(img, 0, 0);
          return ctx.getImageData(0, 0, img.width, img.height).data;
        };
        const [da, db] = [await decode(a), await decode(b)];
        let n = 0;
        // Top half only (see the comment at the call site).
        const len = Math.floor(Math.min(da.length, db.length) / 2 / 4) * 4;
        for (let i = 0; i < len; i += 4) {
          const delta = Math.max(
            Math.abs(da[i] - db[i]),
            Math.abs(da[i + 1] - db[i + 1]),
            Math.abs(da[i + 2] - db[i + 2]),
          );
          if (delta > 24) n += 1;
        }
        return n;
      },
      { a: a.toString("base64"), b: b.toString("base64") },
    );
  await test.step("the union renders as one mixed-family layer", async () => {
    await expect(card()).toBeVisible({ timeout: 30_000 });
    // Every row of both families landed server-side — the count is the
    // union's, not one family's.
    await expect(card()).toContainText(`${expectedFeatures} features`);
    await saveSettled(page);
  });

  await test.step("both families actually paint: dropping either changes the canvas", async () => {
    // The card count above is the server's number; this step is the
    // client's. Narrow the same layer to each family in turn — if the
    // union render had silently dropped a family, the canvas would not
    // change when that family leaves (a reload
    // re-frames to each family's extent, which would confound the
    // comparison). The SQL changes go through the layer's own source
    // workbench: an in-page update re-renders WITHOUT the load handler's
    // fit-to-bounds, so the camera holds across every shot. A successful
    // update closes the workbench over the re-render.
    const setSql = async (sql: string, arrivedCount: number) => {
      await page
        .locator("li")
        .filter({ hasText: new RegExp(`${ptsTable} mixed`) })
        .getByRole("button", { name: "Layer menu", exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Edit source" }).click();
      const sqlBox = page.getByRole("textbox", { name: "Layer SQL query" });
      await expect(sqlBox).toBeVisible({ timeout: 15_000 });
      await sqlBox.fill(sql);
      await page.getByRole("button", { name: /Update layer/ }).click();
      await expect(
        page.getByRole("dialog", { name: /Layer source/ }),
      ).toBeHidden({ timeout: 30_000 });
      await expect(card()).toContainText(`${arrivedCount} features`, {
        timeout: 30_000,
      });
    };
    const ptsCount = (JSON.parse(pts) as { features: unknown[] }).features
      .length;
    const polysCount = (JSON.parse(polys) as { features: unknown[] }).features
      .length;
    await card().first().click();
    const unionWithDock = await settledShot();
    await setSql(`SELECT name, geom FROM ${ptsTable}`, ptsCount);
    const pointsOnly = await settledShot();
    expect(await diffPixels(unionWithDock, pointsOnly)).toBeGreaterThan(2_000); // the polygons' paint
    await setSql(`SELECT name, geom FROM ${polysTable}`, polysCount);
    const polysOnly = await settledShot();
    expect(await diffPixels(unionWithDock, polysOnly)).toBeGreaterThan(50); // the points' paint
    // Restore the union for the style-panel step, and close the dock.
    await setSql(
      `SELECT name, geom FROM ${ptsTable} UNION ALL SELECT name, geom FROM ${polysTable}`,
      expectedFeatures,
    );
  });

  await test.step("the style panel announces the family and refuses point-only viz with the documented prose", async () => {
    // The family step above leaves the layer selected — click the card
    // only if the panel is not already open (a second click deselects).
    const featuresTile = page.getByRole("button", {
      name: "Features",
      exact: true,
    });
    if (!(await featuresTile.isVisible())) await card().first().click();
    // The base tile announces the mixed family as "Features", and it is
    // the active viz.
    await expect(featuresTile).toBeVisible();
    await expect(featuresTile).toHaveAttribute("data-active", "true");
    // Every point-only visualization refuses with its documented prose —
    // the exact sentences from the render path, not a generic disable.
    const refusals: [string, string][] = [
      ["Heatmap", "A heatmap needs a point result. This layer draws mixed geometry."],
      ["Hex bins", "Hex binning needs a point result. This layer draws mixed geometry."],
      ["Cluster", "Clustering needs a point result. This layer draws mixed geometry."],
      ["Icon", "The icon type needs a point result. This layer draws mixed geometry."],
      ["Grid", "The grid needs a point result. This layer draws mixed geometry."],
    ];
    for (const [label, reason] of refusals) {
      const tile = page.getByRole("button", { name: label, exact: true });
      await expect(tile).toBeDisabled();
      await expect(tile).toHaveAttribute("data-hint", reason);
    }
  });

  const unexpected = consoleErrors.filter(
    (e) => !isAllowedConsoleError(e.text, e.url),
  );
  expect(unexpected).toEqual([]);
});
