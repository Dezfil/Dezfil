import { describe, it, expect } from "vitest";
import { readoutOf } from "./MapTab";

/**
 * The Map tab's readout over supplied features answers ((d) as
 * amended): the words the read warrants, including a zero-feature
 * answer, which no dataset on this engine can produce today and is
 * proved here rather than live.
 */
describe("the map readout", () => {
  it("says the drawn count, the rows when sampled, the geometry type and the assumption", () => {
    expect(readoutOf({ ok: true, name: "t", geometryType: "POINT", featureCount: 3, sampled: false }, false)).toEqual(["3 features", "POINT"]);
    expect(readoutOf({ ok: true, name: "t", geometryType: "POINT", featureCount: 2000, sampled: true, totalCount: 2100 }, true)).toEqual([
      "2,000 features drawn, of 2,100 rows",
      "POINT",
      "WGS84 assumed",
    ]);
  });

  it("a spatial dataset with nothing drawable reads zero, never a refusal", () => {
    expect(readoutOf({ ok: true, name: "t", geometryType: null, featureCount: 0, sampled: false }, false)).toEqual(["0 features"]);
  });
});
