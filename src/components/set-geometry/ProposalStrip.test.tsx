import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GeometryCandidate } from "@/lib/geometry-evidence";
import { ProposalStrip, proposedPair } from "./ProposalStrip";

const candidate = (over: Partial<GeometryCandidate>): GeometryCandidate => ({
  columns: ["column02", "column03"], format: "pair", signal: "content", rule: "content", strength: "weak", sample: { rows: 20, nonNull: 20, readable: 20 },
  crs: { stance: "assumed", srid: null, label: "WGS 84 assumed" }, degreeCompatible: true, reasons: [], applied: false, sourceRetained: true,
  orientations: [{ lon: "column03", lat: "column02" }, { lon: "column02", lat: "column03" }], ...over,
});

describe("the proposal strip", () => {
  it("proposes the dataset's best candidate when it is a weak pair, in its first orientation, and nothing when the best is a non-pair (browser proof c), a strong pair or a consumed one", () => {
    expect(proposedPair([candidate({}), candidate({ columns: ["geom_wkt"], format: "wkt", orientations: undefined })])).toEqual({ format: "pair", columns: ["column03", "column02"] });
    // The field case: the best candidate is WKT, an incidental weak pair sits behind it; no strip.
    expect(proposedPair([candidate({ columns: ["geom_wkt"], format: "wkt", orientations: undefined }), candidate({})])).toBeNull();
    expect(proposedPair([candidate({ columns: ["geom_wkt"], format: "wkt", orientations: undefined })])).toBeNull();
    expect(proposedPair([candidate({ strength: "strong" })])).toBeNull();
    expect(proposedPair([candidate({ sourceRetained: false })])).toBeNull();
    expect(proposedPair(undefined)).toBeNull();
    expect(proposedPair([])).toBeNull();
  });
  it("says the drawn sentence with both columns and carries Set geometry and Not now", () => {
    const html = renderToStaticMarkup(<ProposalStrip pair={{ format: "pair", columns: ["column03", "column02"] }} onSetGeometry={() => {}} onNotNow={() => {}} />);
    expect(html.replace(/<[^>]+>/g, "")).toContain("column03 and column02 look like coordinates.");
    expect(html).toContain("<code>column03</code>");
    expect(html).toContain('data-set-geometry-door="strip"');
    expect(html).toMatch(/<button[^>]*>Not now<\/button>/);
    expect(html).toContain('role="status"');
  });
});
