import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setupGeometryTest, cleanupGeometryTest, stored } from "@/lib/test-support/geometry";
import { testAccountScope } from "@/lib/test-support/accounts";
import { createMap } from "@/lib/map-service";
import { createLayer, renderLayer, sliderPreviewData, layerFieldStats } from "@/lib/layer-service";
import { tableFeatures } from "@/lib/table-service";
import { classifyFill } from "@/lib/style/classify";
import { computeWidgetValues } from "@/lib/widget-service";
import { searchValues } from "@/lib/search/value-search";
import { publishMap, getPublishedView, resetPublishCache } from "@/lib/publish/publish-service";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { ResultBudget } from "./result-budget";
import { previewOvertureFeatures } from "@/lib/overture/import";
vi.mock("@/lib/overture/remote", async original => ({ ...await original<typeof import("@/lib/overture/remote")>(), ensureOvertureSupport: async () => {} }));
vi.mock("@/lib/overture/query", async original => ({ ...await original<typeof import("@/lib/overture/query")>(), buildOverturePreview: () => "SELECT ST_Point(1,2) AS geometry" }));
let dir: string;
beforeEach(async () => { dir = await setupGeometryTest(); resetPublishCache(); });
afterEach(async () => { vi.restoreAllMocks(); resetPublishCache(); await cleanupGeometryTest(dir); });
it("leaves all nine other reader families outside the opt-in result accountant", async () => {
  const table = await stored("SELECT 7 AS n, 'needle' AS label, ST_Point(1,2) AS geometry", { geometryColumn: "geometry", geometryType: "POINT" });
  const scope = testAccountScope();
  const map = createMap(scope, "Other readers");
  const layer = await createLayer(scope, map.id, { name: "Other readers", sql: `SELECT * FROM ${table.name}` }, { expectedRevision: map.editRevision });
  // A shared evaluation/geometry helper that starts budgeting now breaks this
  // control even with small data. Assert actual outcomes too: broad catches
  // must not swallow the injected refusal into empty/failed results.
  const take = vi.spyOn(ResultBudget.prototype, "take").mockImplementation(() => { throw new Error("Unexpected result accountant on an excluded read"); });
  expect(await renderLayer(scope, layer)).toMatchObject({ ok: true, featureCount: 1 });
  expect(await tableFeatures(scope, table.name)).toMatchObject({ featureCount: 1 });
  expect(await sliderPreviewData(scope, layer)).toMatchObject({ sourceCount: 1, sampledCount: 1 });
  expect(await previewOvertureFeatures({ theme: "buildings", release: "2026-06-17.0", scope: { type: "bbox", bbox: [0, 0, 0.01, 0.01] }, semantics: "intersect" })).toMatchObject({ featureCount: 1 });
  const published = publishMap(scope, map.id, {}, { expectedRevision: readDocumentRevision({ kind: "map", id: map.id })!.editRevision });
  expect((await getPublishedView(published.token, Date.now()))?.layers).toHaveLength(1);
  expect(await layerFieldStats(scope, layer, "n")).toMatchObject({ min: 7, max: 7 });
  expect(await classifyFill(scope, layer.sql, "n", "continuous")).toBeDefined();
  const widgets = await computeWidgetValues(scope, map, [layer], [], { id: "total", type: "formula", layerId: layer.id, title: "Total", field: "n", agg: "sum", aggField: null, unit: null, note: null, format: null, visible: true });
  expect(widgets).toMatchObject({ widgets: [{ id: "total", value: 7 }] });
  expect((await searchValues(scope, [{ layerId: layer.id, layerName: layer.name, sql: layer.sql }], "needle")).values).toHaveLength(1);
  expect(take).not.toHaveBeenCalled();
});
