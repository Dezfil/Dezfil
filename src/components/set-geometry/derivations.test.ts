import { describe, expect, it } from "vitest";
import type { GeometryCandidate } from "@/lib/geometry-evidence";
import { columnTags, countSentence, mapNotice, markedRows, pairHint, panelNotice, readout } from "./derivations";
import type { GeometryPreview, PanelChoice } from "./types";

type Status = GeometryPreview["sample"]["rows"][number]["status"];
function answer(statuses: Status[], over: Partial<GeometryPreview> = {}): GeometryPreview {
  return {
    tableId: "t", revision: "r1", choice: { format: "wkt", columns: ["geom_wkt"] }, canApply: true, issues: [], rowCount: 212,
    unreadableCount: 30, geometryType: "POINT", extent: [8, 50, 9, 51], degreeCompatible: true,
    sample: { rows: statuses.map((status, index) => ({ index, values: {}, status })),
      features: { type: "FeatureCollection", features: statuses.map((s, id) => ({ type: "Feature", id, geometry: s === "readable" ? { type: "Point", coordinates: [8.5, 50.5] } : null, properties: {} })) } },
    ...over,
  };
}
const pair: PanelChoice = { format: "pair", columns: ["column07", "column06"], projection: { kind: "implicit", code: null, text: "" } };
const candidate = (columns: string[], orientations?: { lon: string; lat: string }[]): GeometryCandidate => ({
  columns, format: "pair", signal: "content", rule: "content", strength: "weak", sample: { rows: 20, nonNull: 20, readable: 20 },
  crs: { stance: "assumed", srid: null, label: "WGS 84 assumed" }, degreeCompatible: true, reasons: [], applied: false, sourceRetained: true,
  ...(orientations ? { orientations } : {}),
});

describe("what the panel derives from the API's sample", () => {
  it("the count sentence counts the sample's readable rows and its unreadable rows exactly; missing rows are neither", () => {
    const three = answer(["readable", "readable", "unreadable", "missing", "readable"]);
    expect(countSentence(three)).toEqual({ readable: 3, total: 5, unreadable: 1, kind: "points" });
    expect(countSentence(answer(["readable", "readable"], { geometryType: "LINESTRING" }))?.kind).toBe("lines");
    expect(countSentence(answer(["readable"], { geometryType: "POLYGON" }))?.kind).toBe("polygons");
    expect(countSentence(answer(["readable"], { geometryType: "POINT+POLYGON" }))?.kind).toBe("mixed geometry");
    expect(countSentence(answer(["readable"], { geometryType: "MULTIPOINT" }))?.kind).toBe("points");
    expect(countSentence(null)).toBeNull();
  });
  it("no readable row counts zero and the map says so; the not-degrees issue is the drawn notice on both", () => {
    const none = answer(["unreadable", "missing"], { geometryType: null });
    expect(countSentence(none)).toEqual({ readable: 0, total: 2, unreadable: 1, kind: "geometry" });
    expect(mapNotice(none)).toBe("No sampled row can be read this way.");
    expect(panelNotice(none)).toBeNull();
    const berlin = answer(["projection-required", "projection-required"], { canApply: false, geometryType: null, issues: [{ code: "projection_required", message: "The pair is not in degrees. Choose the projection." }] });
    expect(panelNotice(berlin)).toEqual({ kind: "not-degrees", text: "These numbers are not degrees. Choose the projection they are in." });
    expect(mapNotice(berlin)).toBe("Nothing can be drawn until the projection is chosen.");
    expect(countSentence(berlin)?.readable).toBe(0);
  });
  it("every other issue appears in the notice's place with the API's own sentence", () => {
    const unsupported = answer(["unreadable"], { canApply: false, issues: [{ code: "unsupported_projection", message: "EPSG:999999 cannot be transformed to WGS 84." }] });
    expect(panelNotice(unsupported)).toEqual({ kind: "issue", text: "EPSG:999999 cannot be transformed to WGS 84." });
    expect(mapNotice(unsupported)).toBe("EPSG:999999 cannot be transformed to WGS 84.");
    expect(mapNotice(answer(["readable"]))).toBeNull();
  });
  it("the ambiguity hint shows only when the candidate evidence lists both orientations for the chosen pair", () => {
    const both = candidate(["column06", "column07"], [{ lon: "column07", lat: "column06" }, { lon: "column06", lat: "column07" }]);
    expect(pairHint([both], pair)).toBe(true);
    expect(pairHint([both], { ...pair, columns: ["column06", "column07"] })).toBe(true);
    expect(pairHint([candidate(["column06", "column07"], [{ lon: "column07", lat: "column06" }])], pair)).toBe(false);
    expect(pairHint([both], { ...pair, columns: ["column08", "column09"] })).toBe(false);
    expect(pairHint([both], { ...pair, format: "wkt", columns: ["column01"] })).toBe(false);
  });
  it("the chosen columns are tagged as drawn and the sample's unreadable rows marked by their own index", () => {
    expect(columnTags(pair)).toEqual({ column07: "longitude", column06: "latitude" });
    expect(columnTags({ ...pair, format: "h3", columns: ["cell"] })).toEqual({ cell: "H3 cell" });
    expect(columnTags({ ...pair, format: "wkt", columns: ["geom_wkt"] })).toEqual({ geom_wkt: "geometry" });
    const marks = markedRows(answer(["readable", "unreadable", "missing", "projection-required"]));
    expect(marks).toEqual([false, true, false, true]);
  });
  it("a chosen column named __proto__ is tagged as an own property, never through the prototype", () => {
    const tags = columnTags({ ...pair, columns: ["__proto__", "lat"] });
    expect(Object.hasOwn(tags, "__proto__")).toBe(true);
    expect(tags.lat).toBe("latitude");
    expect(Object.hasOwn(columnTags({ ...pair, format: "wkt", columns: ["__proto__"] }), "__proto__")).toBe(true);
  });
  it("the readout names the sampled count, the drawn type and the projection the answer was read under", () => {
    expect(readout(answer(["readable", "unreadable"], { choice: { format: "pair", columns: ["column07", "column06"], epsg: 25833 } }), null))
      .toEqual(["1 of 2 sampled rows", "POINT", "ETRS89 / UTM 33N"]);
    expect(readout(answer(["readable"], { geometryType: null, choice: { format: "h3", columns: ["cell"] } }), null)).toEqual(["1 of 1 sampled rows", "GEOMETRY", "WGS 84"]);
    expect(readout(answer(["unreadable"]), null)).toBeNull();
  });
});
