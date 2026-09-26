import { describe, expect, it } from "vitest";
import type { LayerRenderData } from "@/lib/layer-service";
import { renderGeometryKind, vizTile } from "./render-data";

function render(
  geometryType: LayerRenderData["geometryType"],
  extra: Partial<LayerRenderData> = {},
): LayerRenderData {
  return { layerId: "layer", ok: true, geometryType, ...extra };
}

describe("render geometry metadata", () => {
  it("identifies tiled points while tiles are building and ready", () => {
    expect(
      renderGeometryKind(
        render("POINT", { mode: "tiled", tiles: { state: "building" } }),
      ),
    ).toBe("point");
    expect(
      renderGeometryKind(
        render("POINT", {
          mode: "tiled",
          tiles: { state: "ready", url: "/tiles/{z}/{x}/{y}" },
        }),
      ),
    ).toBe("point");
  });

  it("prefers recognized metadata and falls back to legacy inline GeoJSON", () => {
    const pointGeoJson = {
      type: "FeatureCollection",
      features: [{ geometry: { type: "Point" } }],
    };
    expect(
      renderGeometryKind(
        render("LINESTRING", { mode: "inline", geojson: pointGeoJson }),
      ),
    ).toBe("line");
    expect(
      renderGeometryKind({
        layerId: "legacy",
        ok: true,
        mode: "inline",
        geojson: pointGeoJson,
      }),
    ).toBe("point");
    expect(
      renderGeometryKind({
        layerId: "legacy-generic",
        ok: true,
        mode: "inline",
        // Before DuckDB's generic column descriptor was sent here.
        geometryType: "GEOMETRY" as never,
        geojson: pointGeoJson,
      }),
    ).toBe("point");
  });

  it("disables aggregations and heatmap off point results, with a reason", () => {
    for (const kind of ["line", "polygon", "mixed", null] as const) {
      for (const type of ["hexbin", "grid", "heatmap"] as const) {
        const tile = vizTile(kind, type);
        expect(tile.available).toBe(false);
        expect(tile.reason).toMatch(/needs a point result/);
      }
    }
    for (const type of ["hexbin", "grid", "heatmap"] as const) {
      expect(vizTile("point", type)).toEqual({ available: true });
    }
  });

  it("the geometry tile is always available — the escape path back", () => {
    for (const kind of ["point", "line", "polygon", "mixed", null] as const) {
      expect(vizTile(kind, "points")).toEqual({ available: true });
    }
  });
});
