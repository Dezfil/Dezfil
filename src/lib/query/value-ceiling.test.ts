import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DuckDBVarCharVector } from "@duckdb/node-api";
import { setupGeometryTest, cleanupGeometryTest, stored } from "@/lib/test-support/geometry";
import { testAccountScope } from "@/lib/test-support/accounts";
import { createMap } from "@/lib/map-service";
import { createLayer, layerFieldStats } from "@/lib/layer-service";
import { classifyFill } from "@/lib/style/classify";
import { computeWidgetValues } from "@/lib/widget-service";
import { searchValues } from "@/lib/search/value-search";
import type { MapWidget } from "@/lib/widgets";
import { CELL_BYTES } from "./result-budget";

/**
 * The summary reads (a filter's distinct values, categorical classes,
 * widget categories, search matches) return a handful of text values, each
 * held to the ceiling the SQL result reader holds one value to. A value
 * over it is refused with that reader's own coded refusal, and is never
 * read into JavaScript whole.
 */

let dir: string;
beforeEach(async () => { dir = await setupGeometryTest(); });
afterEach(async () => { vi.restoreAllMocks(); await cleanupGeometryTest(dir); });

/** A JSON string of exactly the ceiling: its text and two quotes. */
const AT_CEILING = CELL_BYTES - 2;
const TOO_LARGE = { code: "query_result_too_large", status: 422 };

/** Far below the ceiling, above the engine's own short texts (names,
 * types, view definitions) a read converts on the way. */
const UNREAD = 65_536;

/** The longest text the engine handed JavaScript while `run` ran. */
async function longestText(run: () => Promise<unknown>): Promise<number> {
  let longest = 0;
  const item = DuckDBVarCharVector.prototype.getItem;
  vi.spyOn(DuckDBVarCharVector.prototype, "getItem").mockImplementation(function (this: DuckDBVarCharVector, index: number) {
    const text = item.call(this, index);
    if (text !== null) longest = Math.max(longest, Buffer.byteLength(text));
    return text;
  });
  try { await run(); } catch { /* the outcome is asserted separately */ } finally { vi.restoreAllMocks(); }
  return longest;
}

/** A map with one layer over three features: a short label, the same label
 * again, and one label one byte over the ceiling; `fits` holds a value at
 * exactly the ceiling. */
async function fixture() {
  const table = await stored(`SELECT * FROM (VALUES
      ('needle a', repeat('y', ${AT_CEILING}), 1, ST_Point(1, 2)),
      ('needle a', 'short', 2, ST_Point(2, 3)),
      ('needle ' || repeat('n', ${AT_CEILING - 6}), 'short', 3, ST_Point(3, 4))
    ) AS t(label, fits, n, geometry)`, { geometryColumn: "geometry", geometryType: "POINT" });
  const scope = testAccountScope();
  const map = createMap(scope, "Summary values");
  const layer = await createLayer(scope, map.id, { name: "Summary values", sql: `SELECT * FROM ${table.name}` }, { expectedRevision: map.editRevision });
  return { scope, map, layer };
}

const widget = (id: string, type: "category" | "formula", field: string): MapWidget => ({
  id, type, layerId: "", title: id, field, agg: type === "formula" ? "sum" : "count", aggField: null,
  unit: null, note: null, format: null, visible: true,
} as MapWidget);

describe("summary reads hold each text value to the SQL result's per-value ceiling", () => {
  it("statistics: a filter's distinct values refuse a value over the ceiling unread, and admit one at it", async () => {
    const { scope, layer } = await fixture();
    await expect(layerFieldStats(scope, layer, "label")).rejects.toMatchObject(TOO_LARGE);
    expect(await longestText(() => layerFieldStats(scope, layer, "label"))).toBeLessThan(UNREAD);
    const fits = await layerFieldStats(scope, layer, "fits");
    expect(fits).toMatchObject({ kind: "text", truncated: false });
    expect(fits.kind === "text" && fits.values.map((v) => v.length).sort((a, b) => a - b)).toEqual([5, AT_CEILING]);
  });

  it("classification: categorical classes refuse a value over the ceiling unread", async () => {
    const { scope, layer } = await fixture();
    await expect(classifyFill(scope, layer.sql, "label", "categorical")).rejects.toMatchObject(TOO_LARGE);
    expect(await longestText(() => classifyFill(scope, layer.sql, "label", "categorical"))).toBeLessThan(UNREAD);
    const fits = await classifyFill(scope, layer.sql, "fits", "categorical");
    expect(fits.type === "categorical" && fits.map.map((m) => m.value.length).sort((a, b) => a - b)).toEqual([5, AT_CEILING]);
  });

  it("widgets: the category widget answers the coded refusal, and the others keep working", async () => {
    const { scope, map, layer } = await fixture();
    const widgets = [widget("labels", "category", "label"), widget("total", "formula", "n"), widget("fits", "category", "fits")]
      .map((w) => ({ ...w, layerId: layer.id }));
    const values = await computeWidgetValues(scope, { ...map, widgets }, [layer], []);
    expect(values.widgets).toEqual([
      { id: "labels", error: expect.stringContaining("one non-geometry value over 2 MB"), errorCode: "query_result_too_large" },
      { id: "total", type: "formula", value: 6, baseline: 6 },
      { id: "fits", type: "category", categories: [{ value: "short", n: 2 }, { value: "y".repeat(AT_CEILING), n: 1 }], other: null },
    ]);
    expect(values.layers).toEqual([{ layerId: layer.id, count: 3, total: 3 }]);
    expect(await longestText(() => computeWidgetValues(scope, { ...map, widgets: widgets.slice(0, 2) }, [layer], []))).toBeLessThan(UNREAD);
  });

  it("value search: a layer whose match is over the ceiling is named with the coded refusal, and the others still answer", async () => {
    const { scope, layer } = await fixture();
    const other = { layerId: "other", layerName: "Other", sql: "SELECT 'needle b' AS label, ST_Point(5, 6) AS geometry" };
    const answer = await searchValues(scope, [{ layerId: layer.id, layerName: layer.name, sql: layer.sql }, other], "needle");
    expect(answer.refusedLayers).toEqual([{
      layerId: layer.id,
      layerName: layer.name,
      error: expect.stringContaining("one non-geometry value over 2 MB"),
      errorCode: "query_result_too_large",
    }]);
    // None of the refused layer's matches is answered, the short ones
    // included: a layer answers whole or not at all.
    expect(answer.values).toEqual([{ layerId: "other", layerName: "Other", field: "label", value: "needle b", point: [5, 6] }]);
    expect(await longestText(() => searchValues(scope, [{ layerId: layer.id, layerName: layer.name, sql: layer.sql }], "needle"))).toBeLessThan(UNREAD);
    // A match at exactly the ceiling is answered whole.
    const fits = await searchValues(scope, [{ layerId: layer.id, layerName: layer.name, sql: layer.sql }], "yyyy");
    expect(fits.refusedLayers).toEqual([]);
    expect(fits.values.map((v) => v.value.length)).toEqual([AT_CEILING]);
  });
});
