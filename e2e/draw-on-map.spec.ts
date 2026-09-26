// Draw on the map — the browser proof of the flow criteria: the pencil
// opens the dock, shape tools commit real rows through the overlay, the
// card counts mixed contents honestly, Escape unwinds one level per
// press and closing announces the saved layer, a selected polygon's
// vertex handles move one vertex durably, the pill's delete removes one
// row, the owner's menu names the cascade and the cascade leaves
// nothing, and the published view carries no draw affordance. Pixel
// baselines for the dock and pill land in both themes.
//
// Environment: the documented verification gate — run with
// DEZFIL_BASE_URL at an isolated instance.
import path from "node:path";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  FIXTURES_DIR,
  createMap,
  patchMap,
  publishMap,
  routeHouse,
  trackConsole,
} from "./support";

const runId = Date.now().toString(36);

/** The current map's sketch summaries, straight from the documented API. */
async function mapSketches(
  page: Page,
  mapId: string,
): Promise<{ table: string; rowCount: number; layerId: string | null }[]> {
  return page.evaluate(async (id) => {
    const r = await fetch(`/api/maps/${id}/sketches`);
    if (!r.ok) throw new Error(await r.text());
    return (await r.json()) as {
      table: string;
      rowCount: number;
      layerId: string | null;
    }[];
  }, mapId);
}

async function sketchRing(
  page: Page,
  table: string,
): Promise<[number, number][]> {
  return page.evaluate(async (name) => {
    const r = await fetch(`/api/sketches/${name}/features`);
    const body = (await r.json()) as {
      features: { kind: string; geometry: { coordinates: [number, number][][] } }[];
    };
    const poly = body.features.find((f) => f.kind === "polygon");
    if (!poly) throw new Error("no polygon feature");
    return poly.geometry.coordinates[0];
  }, table);
}

test.describe("draw on the map", () => {
  test("a session mints data, edits a vertex, and cascades away", async ({
    page,
    context,
  }) => {
    const consoleErrors = trackConsole(page);
    await routeHouse(context);
    await page.goto("/");
    const mapId = await createMap(page, `Draw journey ${runId}`);
    await page.goto(`/maps/${mapId}`);

    // The pencil is the last stage control; it opens the dock.
    const pencil = page.getByRole("button", { name: "Draw", exact: true });
    await expect(pencil).toBeVisible({ timeout: 30_000 });
    await pencil.click();
    const dock = page.getByRole("toolbar", { name: "Draw tools" });
    await expect(dock).toBeVisible();
    await expect(
      page.getByText("Pick a tool. This session’s shapes become one layer"),
    ).toBeVisible();

    // A polygon: three vertices, Enter finishes; the card arrives named.
    await dock.getByRole("button", { name: "Draw a polygon" }).click();
    await page.mouse.click(700, 300);
    await page.mouse.click(900, 300);
    await page.mouse.click(800, 450);
    await page.keyboard.press("Enter");
    await expect(
      page.getByText("Sketch", { exact: true }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => (await mapSketches(page, mapId))[0]?.rowCount, {
        timeout: 15_000,
      })
      .toBe(1);

    // A point joins the same dataset; the card counts the mix honestly.
    await dock.getByRole("button", { name: "Draw points" }).click();
    await page.mouse.click(760, 340);
    await expect(page.getByText("1 point · 1 polygon")).toBeVisible({
      timeout: 20_000,
    });

    // Escape unwinds one level per press: tool, then dock — and closing
    // announces the saved layer.
    await page.keyboard.press("Escape");
    await expect(dock).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dock).toBeHidden();
    await expect(page.getByText(/Sketch saved · 2 shapes/)).toBeVisible();

    const [sketch] = await mapSketches(page, mapId);
    expect(sketch.rowCount).toBe(2);
    const ringBefore = await sketchRing(page, sketch.table);

    // Selecting the polygon shows its handles; dragging one moves that
    // vertex durably — id, kind and vertex count hold.
    await page.mouse.click(800, 350);
    await expect(
      page.getByText("drag a handle to move a vertex"),
    ).toBeVisible({ timeout: 15_000 });
    const handle = page.getByRole("button", { name: "Move vertex 2" });
    await expect(handle).toBeVisible();
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + 60, { steps: 5 });
    await page.mouse.up();
    await expect
      .poll(
        async () => {
          const ring = await sketchRing(page, sketch.table);
          return (
            ring.length === ringBefore.length &&
            (ring[1][0] !== ringBefore[1][0] ||
              ring[1][1] !== ringBefore[1][1])
          );
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    // The pill's delete removes exactly one row.
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect
      .poll(async () => (await mapSketches(page, mapId))[0]?.rowCount, {
        timeout: 15_000,
      })
      .toBe(1);

    // Delete the last feature through the same documented sketch API. The
    // dataset and owning layer stay, now as retained empty spatial data.
    const emptied = await page.evaluate(async (name) => {
      const listed = await fetch(`/api/sketches/${name}/features`);
      const body = (await listed.json()) as { features: { id: string }[] };
      const last = body.features[0];
      if (!last) throw new Error("no final sketch feature");
      const removed = await fetch(
        `/api/sketches/${name}/features/${last.id}`,
        { method: "DELETE" },
      );
      if (!removed.ok) throw new Error(await removed.text());
      const table = await fetch(`/api/tables/${name}`);
      return (await table.json()) as {
        rowCount: number;
        geometryColumn: string | null;
        geometryType: string | null;
      };
    }, sketch.table);
    expect(emptied).toMatchObject({
      rowCount: 0,
      geometryColumn: "geom",
      geometryType: null,
    });
    await expect
      .poll(async () => (await mapSketches(page, mapId))[0]?.rowCount)
      .toBe(0);
    await expect(page.getByText("Sketch", { exact: true }).first()).toBeVisible();

    // The owner's menu names the cascade; confirming leaves nothing —
    // no layer, no dataset.
    await page.getByText("Sketch", { exact: true }).first().click();
    await page.getByRole("button", { name: "Layer menu" }).first().click();
    await page
      .getByRole("menuitem", { name: "Delete layer + dataset…" })
      .click();
    await page
      .getByRole("menuitem", { name: /^Delete “Sketch” and draw_journey_/ })
      .click();
    await expect(page.getByText("Sketch", { exact: true })).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect
      .poll(async () => (await mapSketches(page, mapId)).length, {
        timeout: 15_000,
      })
      .toBe(0);
    await expect
      .poll(
        async () =>
          page.evaluate(async (name) => {
            const r = await fetch(`/api/tables/${name}`);
            return r.status;
          }, sketch.table),
        { timeout: 15_000 },
      )
      .toBe(404);

    expect(
      consoleErrors.filter(
        (e) =>
          !isAllowedConsoleError(e.text, e.url) &&
          // The cascade proof polls the deleted table to its 404 — the
          // browser logs that success condition as a resource error.
          !e.url?.includes(`/api/tables/${sketch.table}`),
      ),
    ).toEqual([]);
  });

  test("the published view carries no draw affordance", async ({
    page,
    context,
  }) => {
    const consoleErrors = trackConsole(page);
    await routeHouse(context);
    await page.goto("/");
    const mapId = await createMap(page, `Draw publish ${runId}`);
    // A sketch through the documented API — the published side renders
    // the layer like any other, and offers no drawing.
    await page.evaluate(async (id) => {
      const r = await fetch(`/api/maps/${id}/sketches`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          feature: {
            kind: "polygon",
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [13.0, 52.0],
                  [13.2, 52.0],
                  [13.1, 52.2],
                  [13.0, 52.0],
                ],
              ],
            },
          },
        }),
      });
      if (!r.ok) throw new Error(await r.text());
    }, mapId);
    const token = await publishMap(page, mapId);
    await page.goto(`/v/${token}`);
    await expect(page.locator('[class*="stageStack"]').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByRole("button", { name: "Draw", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("toolbar", { name: "Draw tools" }),
    ).toHaveCount(0);
    expect(
      consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
    ).toEqual([]);
  });
});

for (const theme of ["light", "dark"] as const) {
  test(`dock and pill match their ${theme} baselines`, async ({
    page,
    context,
  }) => {
    await page.addInitScript((t) => {
      window.localStorage.setItem("dezfil-theme", t);
    }, theme);
    await routeHouse(context);
    await page.goto("/");
    const mapId = await createMap(page, `Draw pixels ${theme} ${runId}`);
    await page.goto(`/maps/${mapId}`);
    const pencil = page.getByRole("button", { name: "Draw", exact: true });
    await expect(pencil).toBeVisible({ timeout: 30_000 });
    await pencil.click();
    const dock = page.getByRole("toolbar", { name: "Draw tools" });
    await dock.getByRole("button", { name: "Draw a polygon" }).click();
    await expect(
      page.getByText("Click to place vertices", { exact: false }),
    ).toBeVisible();
    await expect(dock).toHaveScreenshot(`draw-dock-${theme}.png`, {
      animations: "disabled",
      stylePath: path.join(FIXTURES_DIR, "stage-stack-screenshot.css"),
    });
    await expect(
      page.getByRole("status").filter({ hasText: "Polygon" }),
    ).toHaveScreenshot(`draw-pill-${theme}.png`, {
      animations: "disabled",
      stylePath: path.join(FIXTURES_DIR, "stage-stack-screenshot.css"),
    });
  });
}

// — a selected drawn shape looks selected, whatever its kind. One case
// per kind: it draws the kind under test and a companion, arms the
// select tool, and measures the selection on the rendered overlay — not
// on the pill, which already named every kind on main — then deletes by
// the control and, after redrawing, by the key, asserting that the
// selected identifier and no other is what went. Against main the point,
// line, rectangle and circle cases go red at the mark; polygon and
// freehand already drew theirs and stay green throughout.

type SketchKind =
  | "point"
  | "line"
  | "polygon"
  | "rectangle"
  | "circle"
  | "freehand";

const KIND_NAME: Record<SketchKind, string> = {
  point: "Point",
  line: "Line",
  polygon: "Polygon",
  rectangle: "Rectangle",
  circle: "Circle",
  freehand: "Freehand shape",
};

/** The kinds whose selection carries vertex handles. */
const HANDLE_KINDS: SketchKind[] = ["polygon", "freehand"];

/** The overlay's selection mark: the dashed outline the shipped
 * selected-polygon treatment draws, named reference. Matched by class,
 * so the locator finds main's polygon and freehand marks too — they are
 * regression cases, not repairs. */
const SELECTION_MARK = 'svg[class*="overlay"] [class*="draftLine"]';

/** A mark's edges may sit this far from the drawn extent: the 2 px
 * stroke, projection rounding, the freehand sampler's 3 px step. */
const MARK_TOLERANCE_PX = 8;

/** A selected point's ring radius, in screen pixels (selection-mark.ts). */
const POINT_MARK_PX = 12;

interface Extent {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Placement {
  draw: (page: Page, dock: Locator) => Promise<void>;
  /** Where a click selects it. */
  at: [number, number];
  /** The screen extent its mark must cover afterwards. */
  extent: Extent;
}

/** Each kind's gesture around a centre, and the extent it leaves. */
function placement(kind: SketchKind, cx: number, cy: number): Placement {
  const arm = (dock: Locator, name: string) =>
    dock.getByRole("button", { name }).click();
  const drag = async (page: Page, points: [number, number][]) => {
    await page.mouse.move(points[0][0], points[0][1]);
    await page.mouse.down();
    for (const [x, y] of points.slice(1))
      await page.mouse.move(x, y, { steps: 12 });
    await page.mouse.up();
  };
  switch (kind) {
    case "point":
      return {
        draw: async (page, dock) => {
          await arm(dock, "Draw points");
          await page.mouse.click(cx, cy);
        },
        at: [cx, cy],
        extent: {
          x: cx - POINT_MARK_PX,
          y: cy - POINT_MARK_PX,
          w: 2 * POINT_MARK_PX,
          h: 2 * POINT_MARK_PX,
        },
      };
    case "line":
      return {
        draw: async (page, dock) => {
          await arm(dock, "Draw a line");
          await page.mouse.click(cx - 100, cy);
          await page.mouse.click(cx + 100, cy);
          await page.keyboard.press("Enter");
        },
        at: [cx, cy],
        extent: { x: cx - 100, y: cy, w: 200, h: 0 },
      };
    case "polygon":
      return {
        draw: async (page, dock) => {
          await arm(dock, "Draw a polygon");
          await page.mouse.click(cx - 100, cy - 60);
          await page.mouse.click(cx + 100, cy - 60);
          await page.mouse.click(cx, cy + 80);
          await page.keyboard.press("Enter");
        },
        at: [cx, cy],
        extent: { x: cx - 100, y: cy - 60, w: 200, h: 140 },
      };
    case "rectangle":
      return {
        draw: async (page, dock) => {
          await arm(dock, "Draw a rectangle");
          await drag(page, [
            [cx - 80, cy - 60],
            [cx + 80, cy + 60],
          ]);
        },
        at: [cx, cy],
        extent: { x: cx - 80, y: cy - 60, w: 160, h: 120 },
      };
    case "circle":
      return {
        draw: async (page, dock) => {
          await arm(dock, "Draw a circle");
          await drag(page, [
            [cx, cy],
            [cx + 60, cy],
          ]);
        },
        at: [cx, cy],
        extent: { x: cx - 60, y: cy - 60, w: 120, h: 120 },
      };
    case "freehand":
      return {
        draw: async (page, dock) => {
          await arm(dock, "Draw freehand");
          await drag(page, [
            [cx - 80, cy - 60],
            [cx + 80, cy - 60],
            [cx + 80, cy + 60],
            [cx - 80, cy + 60],
            [cx - 80, cy - 60],
          ]);
        },
        at: [cx, cy],
        extent: { x: cx - 80, y: cy - 60, w: 160, h: 120 },
      };
  }
}

interface SketchFeature {
  id: string;
  kind: string;
  geometry: { type: string; coordinates: unknown };
}

/** The sketch's rows, straight from the documented API. */
async function sketchFeatures(
  page: Page,
  table: string,
): Promise<SketchFeature[]> {
  return page.evaluate(async (name) => {
    const r = await fetch(`/api/sketches/${name}/features`);
    if (!r.ok) throw new Error(await r.text());
    return ((await r.json()) as { features: SketchFeature[] }).features;
  }, table);
}

const featureIds = async (page: Page, table: string) =>
  (await sketchFeatures(page, table)).map((f) => f.id).sort();

/** Click a drawn shape with the select tool armed and wait for the pill
 * to name it — the precondition, which main already meets, not the
 * evidence. The click repeats slowly (never inside a double-click) in
 * case the layer's refresh had not painted the shape yet. */
async function selectAt(page: Page, [x, y]: [number, number], name: string) {
  await expect
    .poll(
      async () => {
        await page.mouse.click(x, y);
        const pills = await page.getByRole("status").allTextContents();
        return pills.some((t) => t.includes(name) && t.includes("Delete"));
      },
      { timeout: 20_000, intervals: [1_000] },
    )
    .toBe(true);
}

/** The builder re-frames the data when a minted layer reloads it: wait
 * for the zoom readout to leave its starting value and hold still. */
async function cameraSettled(page: Page, startZoom: number) {
  const readout = page.locator("[data-status-zoom]");
  let prev = NaN;
  await expect
    .poll(
      async () => {
        const z = parseFloat((await readout.textContent()) ?? "");
        const held = Number.isFinite(z) && z !== startZoom && z === prev;
        prev = z;
        return held;
      },
      { timeout: 20_000, intervals: [500] },
    )
    .toBe(true);
}

/** The mark's rendered box against the drawn extent, edge by edge. */
async function expectMarkOver(page: Page, extent: Extent, label: string) {
  const mark = page.locator(SELECTION_MARK);
  await expect(mark, `${label}: one selection mark on the map`).toHaveCount(1);
  const box = await mark.boundingBox();
  expect(box, `${label}: the mark has a rendered box`).not.toBeNull();
  const edges = {
    left: Math.abs(box!.x - extent.x),
    top: Math.abs(box!.y - extent.y),
    right: Math.abs(box!.x + box!.width - (extent.x + extent.w)),
    bottom: Math.abs(box!.y + box!.height - (extent.y + extent.h)),
  };
  for (const [edge, off] of Object.entries(edges))
    expect(
      off,
      `${label}: the mark's ${edge} edge is ${off.toFixed(1)} px from the drawn extent`,
    ).toBeLessThanOrEqual(MARK_TOLERANCE_PX);
}

for (const kind of Object.keys(KIND_NAME) as SketchKind[]) {
  // The companion already draws its mark on main, so the "moves rather
  // than doubles" step cannot manufacture a red for the polygon case.
  const companion: SketchKind = kind === "polygon" ? "freehand" : "polygon";
  const under = placement(kind, 800, 320);
  const other = placement(companion, 1000, 500);

  test(`a selected ${kind} looks selected on the map, and its delete removes it`, async ({
    page,
    context,
  }) => {
    const consoleErrors = trackConsole(page);
    await routeHouse(context);
    await page.goto("/");
    const mapId = await createMap(page, `Draw select ${kind} ${runId}`);
    // A city zoom, so a screen-drawn circle projects as one and the
    // drawn extents below hold within their tolerance.
    await patchMap(page, mapId, {
      viewport: { lng: 13.4, lat: 52.52, zoom: 12 },
    });
    await page.goto(`/maps/${mapId}`);
    const pencil = page.getByRole("button", { name: "Draw", exact: true });
    await expect(pencil).toBeVisible({ timeout: 30_000 });
    await pencil.click();
    const dock = page.getByRole("toolbar", { name: "Draw tools" });
    await expect(dock).toBeVisible();
    const rows = () =>
      expect.poll(
        async () => (await mapSketches(page, mapId))[0]?.rowCount ?? 0,
        { timeout: 20_000 },
      );

    // The first commit mints the layer, and the builder re-frames the
    // data on that reload (the load handler's fit-to-bounds); appends
    // and deletes do not reload. So an anchor polygon goes first, the
    // camera settles on it, the anchor leaves through the pill, and only
    // then are the measured shapes drawn: from here the screen positions
    // hold. The stage's middle is inside the framed anchor.
    await placement("polygon", 800, 320).draw(page, dock);
    await rows().toBe(1);
    const [sketch] = await mapSketches(page, mapId);
    await cameraSettled(page, 12);
    await dock.getByRole("button", { name: "Select a drawn shape" }).click();
    await selectAt(page, [858, 390], "Polygon");
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await rows().toBe(0);

    await under.draw(page, dock);
    await rows().toBe(1);
    await other.draw(page, dock);
    await rows().toBe(2);
    await dock.getByRole("button", { name: "Select a drawn shape" }).click();

    // One row per kind, so the kind names the identifier.
    const before = await sketchFeatures(page, sketch.table);
    const idOf = (k: SketchKind) => {
      const rows = before.filter((f) => f.kind === k);
      expect(rows, `one ${k} row`).toHaveLength(1);
      return rows[0].id;
    };
    const underId = idOf(kind);
    const otherId = idOf(companion);

    // the mark on the map, over the shape's own extent.
    await selectAt(page, under.at, KIND_NAME[kind]);
    await expectMarkOver(page, under.extent, kind);
    // handles for polygon and freehand only, one per vertex.
    const ring = before.find((f) => f.id === underId)!.geometry.coordinates;
    const expectedHandles = HANDLE_KINDS.includes(kind)
      ? (ring as [number, number][][])[0].length - 1
      : 0;
    await expect(
      page.getByRole("button", { name: /^Move vertex \d+$/ }),
    ).toHaveCount(expectedHandles);

    // selecting another moves the mark; Done clears it.
    await selectAt(page, other.at, KIND_NAME[companion]);
    await expectMarkOver(page, other.extent, `${companion} (companion)`);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.locator(SELECTION_MARK)).toHaveCount(0);

    // Criterion 3 by the control: the selected identifier goes, the
    // other stays; the mark goes with it.
    await selectAt(page, under.at, KIND_NAME[kind]);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect
      .poll(() => featureIds(page, sketch.table), { timeout: 20_000 })
      .toEqual([otherId]);
    await expect(page.locator(SELECTION_MARK)).toHaveCount(0);

    // Criterion 3 by the key, on a fresh row of the same kind.
    await under.draw(page, dock);
    await rows().toBe(2);
    await dock.getByRole("button", { name: "Select a drawn shape" }).click();
    const redrawn = (await sketchFeatures(page, sketch.table)).filter(
      (f) => f.kind === kind,
    );
    expect(redrawn).toHaveLength(1);
    expect(redrawn[0].id).not.toBe(underId);
    await selectAt(page, under.at, KIND_NAME[kind]);
    await page.keyboard.press("Delete");
    await expect
      .poll(() => featureIds(page, sketch.table), { timeout: 20_000 })
      .toEqual([otherId]);

    expect(
      consoleErrors.filter((e) => !isAllowedConsoleError(e.text, e.url)),
    ).toEqual([]);
  });
}
