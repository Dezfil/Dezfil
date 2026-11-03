import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Layer } from "@/lib/metadata/maps";
import type { QuantileFill } from "@/lib/style/style";
import { LegendPanel } from "@/components/map/LegendPanel";
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

/** The class texts the exported image draws: the legend panel the export
 * composition mounts, over the rows this module hands it. */
function drawnClassTexts(layers: Layer[]): string[] {
  const rendered = { state: "ok" as const, value: { ok: true, geometryType: "POLYGON" } as LayerRenderData };
  const rows = renderExportLegendLayers(layers, null, Object.fromEntries(layers.map((l) => [l.id, rendered])));
  const html = renderToStaticMarkup(createElement(LegendPanel, { layers: rows }));
  // Each class row is a list item: a swatch, then its text.
  return [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&"),
  );
}

function classed(breaks: number[], labels: (string | null)[] | null = null): Layer {
  const fill: QuantileFill = {
    type: "quantile",
    attribute: "value",
    palette: "global_warming",
    method: "quantile",
    breaks,
    colors: Array.from({ length: breaks.length + 1 }, (_, i) => ({ r: 50 * i, g: 20, b: 20, a: 1 })),
  };
  const base = layer("collisions", "Collisions by hexagon, 2025");
  return { ...base, style: { ...base.style, fill }, legendLabels: labels };
}

describe("the exported image's class texts", () => {
  it("draws each class as what it holds, never the old open bounds", () => {
    const drawn = drawnClassTexts([classed([1, 2, 3])]);
    expect(drawn).toEqual(["≤ 1", "1 – 2", "2 – 3", "> 3"]);
    // The texts these replaced, which this drawing must not show.
    expect(drawn).not.toContain("< 1");
    expect(drawn).not.toContain("≥ 3");
  });

  it("draws a typed label in its slot, the rest automatic", () => {
    const drawn = drawnClassTexts([classed([4, 14, 27, 42], [null, "a few", null, null, null])]);
    expect(drawn).toEqual(["≤ 4", "a few", "14 – 27", "27 – 42", "> 42"]);
  });
});
