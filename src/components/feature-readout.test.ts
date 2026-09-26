import { describe, it, expect } from "vitest";
import { featureCountReadout } from "./feature-readout";

/**
 * The shared count sentence: rows are never called features. A sampled
 * read says what was drawn against the table's rows; an unsampled read
 * says its features, zero included.
 */
describe("the features readout's count sentence", () => {
  it("a sampled read says the features drawn, of the table's rows", () => {
    expect(featureCountReadout({ featureCount: 2000, sampled: true, totalCount: 2100 })).toBe("2,000 features drawn, of 2,100 rows");
  });

  it("an unsampled read says its features, zero included", () => {
    expect(featureCountReadout({ featureCount: 3, sampled: false })).toBe("3 features");
    expect(featureCountReadout({ featureCount: 0 })).toBe("0 features");
  });

  it("never calls rows features", () => {
    expect(featureCountReadout({ featureCount: 5, sampled: true, totalCount: 9 })).not.toMatch(/of 9 features/);
  });
});
