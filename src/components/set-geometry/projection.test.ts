import { describe, expect, it } from "vitest";
import type { PanelChoice } from "./types";
import { CURATED_PROJECTIONS, chooseProjection, effectiveProjectionName, previewable, projectionFieldValue, requestChoice, setFormat, swapPair, typeOtherCode } from "./projection";

const pair: PanelChoice = { format: "pair", columns: ["lon", "lat"], projection: { kind: "implicit", code: null, text: "" } };

describe("the projection rule and the swap", () => {
  it("the swap exchanges the two columns' roles in the request, never their values", () => {
    const swapped = swapPair(pair);
    expect(requestChoice(swapped).columns).toEqual(["lat", "lon"]);
    expect(requestChoice(swapPair(swapped)).columns).toEqual(["lon", "lat"]);
    expect(swapped.projection).toEqual(pair.projection);
  });
  it("explicitly selecting WGS 84 sends 4326; an untouched implicit choice sends no code", () => {
    expect(requestChoice(chooseProjection(pair, "4326"))).toEqual({ format: "pair", columns: ["lon", "lat"], epsg: 4326 });
    expect(requestChoice(pair)).toEqual({ format: "pair", columns: ["lon", "lat"] });
  });
  it("a chosen curated code and a resolved custom code go with the choice", () => {
    expect(requestChoice(chooseProjection(pair, "25833")).epsg).toBe(25833);
    const other = chooseProjection(pair, "other");
    expect(previewable(other)).toBe(false);
    expect(requestChoice(other)).not.toHaveProperty("epsg");
    const typed = typeOtherCode(other, "EPSG:31467");
    expect(previewable(typed)).toBe(true);
    expect(requestChoice(typed).epsg).toBe(31467);
    expect(requestChoice(typeOtherCode(other, "abc"))).not.toHaveProperty("epsg");
    expect(previewable(typeOtherCode(other, "abc"))).toBe(false);
  });
  it("H3 and GeoJSON never send a projection, whatever the field held before the format changed", () => {
    const utm = chooseProjection(pair, "25833");
    for (const format of ["h3", "geojson"] as const) {
      const switched = setFormat(utm, format, [{ name: "cell", type: "VARCHAR" }], null);
      expect(requestChoice(switched)).toEqual({ format, columns: ["cell"] });
      expect(previewable(switched)).toBe(true);
    }
  });
  it("the readout names the projection in effect: the explicit code, the declared record, else WGS 84", () => {
    expect(effectiveProjectionName(requestChoice(pair), null)).toBe("WGS 84");
    expect(effectiveProjectionName(requestChoice(chooseProjection(pair, "25832")), null)).toBe("ETRS89 / UTM 32N");
    expect(effectiveProjectionName(requestChoice(typeOtherCode(chooseProjection(pair, "other"), "31467")), null)).toBe("EPSG:31467");
    expect(effectiveProjectionName(requestChoice(pair), { columns: ["wkt"], format: "wkt", signal: "content", rule: "content", crs: { stance: "declared", srid: 3857, label: "Web Mercator (EPSG:3857)" }, unreadableCount: 0 })).toBe("Web Mercator");
  });
  it("the curated list is the seven drawn entries in the drawn order (03 C)", () => {
    expect(CURATED_PROJECTIONS.map((p) => p.epsg)).toEqual([4326, 3857, 25832, 25833, 3035, 27700, 4269]);
  });
  it("a marked field over an untouched implicit choice holds no chosen code, so choosing WGS 84 from it is a change", () => {
    expect(projectionFieldValue(pair, null, true)).toEqual({ value: "", text: "" });
    expect(projectionFieldValue(pair, null, false).value).toBe("4326");
    expect(projectionFieldValue(chooseProjection(pair, "25832"), null, true).value).toBe("25832");
  });
});
