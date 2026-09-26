// Layer-type matrix, part 1: the never-browser-driven geometry families
// and O→D visualizations — line geometry (paths), polygon geometry
// (districts), arc, and O→D line — each carried through create → style →
// publish → read-back on one batched map (checker note: publish once,
// assert read-back per type).
//
// Render truth per layer: the map card's pixels CHANGE from the settled
// pre-layer base when the layer arrives, and change again when its style
// channel goes data-driven (discipline: inset clip, chrome masked,
// change-detection only). Read-back truth: the published payload carries
// each layer's viz type and styled channels byte-honestly, and the
// published viewer paints with a clean console.
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
  patchLayer,
  publishMap,
  readLayer,
  readPublished,
  routeHouse,
  saveSettled,
  seedFile,
  trackConsole,
} from "./support";

const runId = Date.now().toString(36);
const pathsTable = `mx1paths_${runId}`;
const districtsTable = `mx1districts_${runId}`;
const flowsTable = `mx1flows_${runId}`;

test("geometry families and O→D visualizations: create → style → publish → read-back", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsole(page);
  await routeHouse(context);

  await test.step("seed: line, polygon, and flow tables through the API", async () => {
    await page.goto("/maps");
    await seedFile(
      page,
      `${pathsTable}.geojson`,
      readFileSync(path.join(FIXTURES_DIR, "paths.geojson")),
      "application/geo+json",
    );
    await seedFile(
      page,
      `${districtsTable}.geojson`,
      readFileSync(path.join(FIXTURES_DIR, "districts.geojson")),
      "application/geo+json",
    );
    await seedFile(
      page,
      `${flowsTable}.csv`,
      readFileSync(path.join(FIXTURES_DIR, "flows.csv")),
      "text/csv",
    );
  });

  const mapId = await createMap(page, "matrix: geometries and O→D");
  await page.goto(`/maps/${mapId}`);
  await expect(
    page.getByRole("tablist", { name: "Builder panels" }),
  ).toBeVisible();

  /** Add a layer through the API, reveal it with a reload, and require
   * the canvas pixels to move off the settled pre-layer base. */
  async function addAndSeeRendered(name: string, sql: string) {
    const base = await mapShot(page);
    const layerId = await addLayer(page, mapId, name, sql);
    await page.reload();
    await expect(
      page.getByRole("button", { name: new RegExp(`^${name}`) }),
    ).toBeVisible({ timeout: 30_000 });
    await expectMapChanged(page, base);
    await saveSettled(page);
    return layerId;
  }

  /** Restyle through the API and require the canvas to move again. A
   * style patch merges over the layer's current style — the API takes
   * whole-object writes. */
  async function styleAndSeeRendered(
    layerId: string,
    body: { style?: Record<string, unknown>; viz?: Record<string, unknown> },
  ) {
    const styled = await mapShot(page);
    const write: Record<string, unknown> = {};
    if (body.style) {
      const current = await readLayer<{ style: Record<string, unknown> }>(
        page,
        layerId,
      );
      write.style = { ...current.style, ...body.style };
    }
    if (body.viz) write.viz = body.viz;
    await patchLayer(page, layerId, write);
    await page.reload();
    await expectMapChanged(page, styled);
    await saveSettled(page);
  }

  let pathsId = "";
  let districtsId = "";
  let arcId = "";
  let odLineId = "";

  await test.step("line geometry: paths render and take a data-driven stroke", async () => {
    pathsId = await addAndSeeRendered(
      pathsTable,
      `SELECT * FROM ${pathsTable}`,
    );
    // The geometry family announces itself in the style panel: Path tile.
    await page
      .getByRole("button", { name: new RegExp(`^${pathsTable}`) })
      .click();
    await expect(
      page.getByRole("button", { name: "Path", exact: true }),
    ).toBeVisible();
    await styleAndSeeRendered(pathsId, {
      style: {
        strokeBy: {
          type: "categorical",
          attribute: "kind",
          palette: "vivid",
          map: [
            { value: "rail", color: { r: 214, g: 96, b: 77, a: 1 } },
            { value: "path", color: { r: 67, g: 147, b: 195, a: 1 } },
          ],
          other: { r: 180, g: 180, b: 180, a: 1 },
        },
        strokeWidthBy: {
          attribute: "traffic",
          domain: [340, 9100],
          range: [1, 8],
        },
      },
    });
  });

  await test.step("polygon geometry: districts render and take a continuous fill", async () => {
    districtsId = await addAndSeeRendered(
      districtsTable,
      `SELECT * FROM ${districtsTable}`,
    );
    await page
      .getByRole("button", { name: new RegExp(`^${districtsTable}`) })
      .first()
      .click();
    await expect(
      page.getByRole("button", { name: "Polygons", exact: true }),
    ).toBeVisible();
    await styleAndSeeRendered(districtsId, {
      style: {
        fill: {
          type: "continuous",
          attribute: "population",
          palette: "viridis",
          domain: [14000, 154000],
          stops: [
            { r: 68, g: 1, b: 84, a: 0.85 },
            { r: 33, g: 145, b: 140, a: 0.85 },
            { r: 253, g: 231, b: 37, a: 0.85 },
          ],
        },
      },
    });
  });

  /** Map an O→D endpoint through its REAL select, when the pane still asks
   * for it (the origin_/dest_ stems let the builder infer some on switch). */
  const mapEndpoint = async (label: string, option: string) => {
    const select = page
      .locator("span", { hasText: label })
      .locator("xpath=following-sibling::select[1]");
    if (
      (await select.count()) > 0 &&
      (await select.inputValue().catch(() => "")) === ""
    ) {
      const saved = layerSaveArrived(page);
      await select.selectOption({ label: option });
      await saved;
    }
  };

  await test.step("arc: the real Arc tile and endpoint selects swing origin → destination", async () => {
    arcId = await addAndSeeRendered(
      `${flowsTable} arcs`,
      `SELECT * FROM ${flowsTable}`,
    );
    // Driven through the builder controls: the Arc
    // tile switches the viz, and the endpoint selects map the pairs.
    await page
      .getByRole("button", { name: new RegExp(`^${flowsTable} arcs`) })
      .first()
      .click();
    const arcTile = page.getByRole("button", { name: "Arc", exact: true });
    await expect(arcTile).toBeVisible();
    const pointsBase = await mapShot(page);
    const switched = layerSaveArrived(page);
    await arcTile.click();
    await switched;
    await expect(arcTile).toHaveAttribute("data-active", "true");

    // Endpoints: the flows table's origin_/dest_ stems infer on switch
    // where the builder can; whichever endpoint the pane still asks
    // for is mapped through its real select.
    await mapEndpoint("Origin", "origin_lon + origin_lat");
    await mapEndpoint("Destination", "dest_lon + dest_lat");
    await expect
      .poll(async () => {
        const layer = await readLayer<{
          viz: { type: string; origin: unknown; dest: unknown };
        }>(page, arcId);
        return (
          layer.viz.type === "arc" &&
          layer.viz.origin !== null &&
          layer.viz.dest !== null
        );
      })
      .toBe(true);
    // The arcs paint: the canvas moves off the points base.
    await expectMapChanged(page, pointsBase);
    await saveSettled(page);
  });

  await test.step("O→D line: the real Line tile, endpoint selects and target-color control", async () => {
    odLineId = await addAndSeeRendered(
      `${flowsTable} lines`,
      `SELECT * FROM ${flowsTable}`,
    );
    // Driven through the builder controls, same road
    // as the arc: a broken Line tile, endpoint select or target-color
    // control now reddens this step instead of passing on stored state.
    await page
      .getByRole("button", { name: new RegExp(`^${flowsTable} lines`) })
      .first()
      .click();
    const lineTile = page.getByRole("button", { name: "Line", exact: true });
    await expect(lineTile).toBeVisible();
    const pointsBase = await mapShot(page);
    const switched = layerSaveArrived(page);
    await lineTile.click();
    await switched;
    await expect(lineTile).toHaveAttribute("data-active", "true");
    await mapEndpoint("Origin", "origin_lon + origin_lat");
    await mapEndpoint("Destination", "dest_lon + dest_lat");
    // The target gradient is its own control: the checkbox commits the
    // builder's default target color, which the published read-back below
    // asserts by value.
    const blend = page.getByLabel("Blend toward a target color");
    await expect(blend).toBeVisible();
    const blended = layerSaveArrived(page);
    await blend.click();
    await blended;
    await expect
      .poll(async () => {
        const layer = await readLayer<{
          viz: { type: string; origin: unknown; dest: unknown; targetColor?: unknown };
        }>(page, odLineId);
        return (
          layer.viz.type === "line" &&
          layer.viz.origin !== null &&
          layer.viz.dest !== null &&
          layer.viz.targetColor != null
        );
      })
      .toBe(true);
    await expectMapChanged(page, pointsBase);
    await saveSettled(page);
  });

  let token = "";
  await test.step("publish once; the payload reads back every type and channel", async () => {
    token = await publishMap(page, mapId);
    type PublishedLayer = {
      id: string;
      viz: {
        type: string;
        targetColor?: unknown;
        origin?: unknown;
        dest?: unknown;
      };
      style: Record<string, unknown>;
      render: {
        ok: boolean;
        geojson?: {
          features: { geometry: { type: string; coordinates: unknown[] } }[];
        };
      };
    };
    const view = await readPublished<{ layers: PublishedLayer[] }>(
      page,
      token,
    );
    const byId = new Map(view.layers.map((l) => [l.id, l]));
    expect(byId.get(pathsId)?.viz.type).toBe("points");
    expect(
      (byId.get(pathsId)?.style.strokeBy as { attribute?: string })?.attribute,
    ).toBe("kind");
    expect(
      (byId.get(pathsId)?.style.strokeWidthBy as { attribute?: string })
        ?.attribute,
    ).toBe("traffic");
    expect(byId.get(districtsId)?.viz.type).toBe("points");
    expect(
      (byId.get(districtsId)?.style.fill as { attribute?: string })?.attribute,
    ).toBe("population");
    // The published wire nulls O→D endpoint mappings BY DESIGN: the
    // mappings are consumed server-side, the column names never ship,
    // and the published line geometry embodies each pair — the
    // read-back truth to assert is the embodied geometry.
    for (const [id, what] of [
      [arcId, "arc"],
      [odLineId, "line"],
    ] as const) {
      const layer = byId.get(id)!;
      expect(layer.viz.type).toBe(what);
      expect(layer.viz.origin).toBeNull();
      expect(layer.viz.dest).toBeNull();
      expect(layer.render.ok).toBe(true);
      const features = layer.render.geojson?.features ?? [];
      expect(features.length).toBe(8);
      for (const f of features) {
        expect(f.geometry.type).toBe("LineString");
        expect(f.geometry.coordinates.length).toBe(2);
      }
    }
    expect(byId.get(odLineId)?.viz.targetColor).toEqual({
      r: 122,
      g: 78,
      b: 147,
      a: 1,
    });
  });

  await test.step("the published viewer paints all four, console clean", async () => {
    await page.goto(`/v/${token}`);
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    await expect(page.getByText("basemap offline · data only")).toBeVisible();
    // The styled channels reached the viewer's legend.
    await expect(page.getByText(pathsTable)).toBeVisible();
    await expect
      .poll(async () => page.locator("li").count())
      .toBeGreaterThan(1);
    const unexpected = consoleErrors.filter(
      (e) => !isAllowedConsoleError(e.text, e.url),
    );
    expect(unexpected).toEqual([]);
  });
});
