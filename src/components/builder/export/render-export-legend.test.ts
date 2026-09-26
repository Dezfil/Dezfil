import { describe, expect, it } from "vitest";
import type { Layer } from "@/lib/metadata/maps";
import type { LayerRenderData } from "@/lib/layer-service";
import { defaultStyle } from "@/lib/style/defaults";
import { POINTS_VIZ } from "@/lib/viz";
import { renderExportLegendLayers } from "./render-export-legend";

function layer(id: string, name: string): Layer {
  return {
    id,
    mapId: "map",
    name,
    sql: "SELECT 1",
    style: defaultStyle("POINT"),
    visible: true,
    tooltip: null,
    popup: null,
    publishedFields: null,
    inLegend: true,
    viz: POINTS_VIZ,
    filters: [],
    legendTitle: null,
    legendLabels: null,
    legendAttrs: null,
    ordinal: 0,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
}

describe("server export legend composition", () => {
  it("omits a failed layer's legend row", () => {
    const rendered = {
      state: "ok" as const,
      value: { ok: true, geometryType: "POINT" } as LayerRenderData,
    };
    const failed = {
      state: "ok" as const,
      value: {
        ok: false,
        error: { code: "query_error", message: "No such column" },
      } as LayerRenderData,
    };

    const rows = renderExportLegendLayers(
      [layer("drawn", "Drawn layer"), layer("failed", "Failed layer")],
      null,
      { drawn: rendered, failed },
    );

    expect(rows.map((row) => row.name)).toEqual(["Drawn layer"]);
  });
});
