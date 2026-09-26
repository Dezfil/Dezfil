import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChoicePreviewMap, fitCenter, sampleCollection } from "./ChoicePreviewMap";
import { NOTHING_UNTIL_PROJECTION, NO_ROW_READS } from "./derivations";
import type { GeometryPreview } from "./types";
import { insetPoint } from "./world-outline";

// The primitive needs a browser; here it is the frame its host lays over.
vi.mock("../map/FeaturePreviewMap", async (original) => ({
  ...(await original<typeof import("../map/FeaturePreviewMap")>()),
  FeaturePreviewMap: ({ geojson, children }: { geojson: unknown; children?: React.ReactNode }) => (
    <div data-mock-map={geojson ? "features" : "empty"}>{children}</div>
  ),
}));

function answer(points: ([number, number] | null)[], over: Partial<GeometryPreview> = {}): GeometryPreview {
  return {
    tableId: "t", revision: "r1", choice: { format: "pair", columns: ["a", "b"] }, canApply: true, issues: [], rowCount: points.length,
    unreadableCount: 0, geometryType: "POINT", extent: null, degreeCompatible: true,
    sample: {
      rows: points.map((p, index) => ({ index, values: {}, status: p ? "readable" : "unreadable" })),
      features: { type: "FeatureCollection", features: points.map((p, id) => ({ type: "Feature", id, geometry: p ? { type: "Point", coordinates: p } : null, properties: {} })) },
    },
    ...over,
  };
}
const render = (a: GeometryPreview) => renderToStaticMarkup(<ChoicePreviewMap answer={a} record={null} />);

describe("the page's Map preview while the panel is open", () => {
  it("the inset marks where the fit sits, from the drawn features' own extent, not the map's default view", () => {
    const somali = answer([[50.05, 8.57], [50.15, 8.63]]);
    expect(fitCenter(sampleCollection(somali))).toEqual([50.1, 8.6]);
    const html = render(somali);
    expect(html).toContain('data-inset-center="50.1,8.6"');
    const [cx, cy] = insetPoint([50.1, 8.6]);
    expect(html).toContain(`<circle class="_marker_${html.match(/_marker_([0-9a-f]+)/)?.[1]}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}"`);
    expect(cx).toBeCloseTo(84.4, 1);
    expect(cy).toBeCloseTo(29.8, 1);
    const berlin = render(answer([[13.405, 52.52]]));
    expect(berlin).toContain('data-inset-center="13.405,52.52"');
  });
  it("the readout carries the sampled count, the type and the projection; the unreadable rows are not drawn", () => {
    const html = render(answer([[10, 20], null, [11, 21]]));
    expect(html.replace(/<[^>]+>/g, " ")).toMatch(/2 of 3 sampled rows\s+POINT\s+WGS 84/);
    expect(html).toContain('data-mock-map="features"');
    expect(sampleCollection(answer([[10, 20], null])).features).toHaveLength(1);
  });
  it("the readout names the projection the answer was read under; the map takes no draft choice", () => {
    const utm33 = answer([[13.405, 52.52]], { choice: { format: "pair", columns: ["a", "b"], epsg: 25833 } });
    const html = render(utm33);
    expect(html.replace(/<[^>]+>/g, " ")).toMatch(/1 of 1 sampled rows\s+POINT\s+ETRS89 \/ UTM 33N/);
    expect(html).not.toContain("UTM 32N");
  });
  it("no readable row draws nothing, shows the drawn notice and no inset; the not-degrees issue shows its own notice", () => {
    const none = render(answer([null, null], { geometryType: null }));
    expect(none).toContain('data-mock-map="empty"');
    expect(none).toContain(NO_ROW_READS);
    expect(none).not.toContain("data-world-inset");
    expect(none).not.toContain("data-choice-readout");
    const berlin = render(answer([null], { canApply: false, geometryType: null, issues: [{ code: "projection_required", message: "api" }] }));
    expect(berlin).toContain(NOTHING_UNTIL_PROJECTION);
    const unsupported = render(answer([null], { canApply: false, issues: [{ code: "unsupported_projection", message: "EPSG:999999 cannot be transformed to WGS 84." }] }));
    expect(unsupported).toContain("EPSG:999999 cannot be transformed to WGS 84.");
  });
});
