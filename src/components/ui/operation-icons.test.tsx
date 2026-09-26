import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OPERATIONS } from "@/lib/operations/catalog";
import { OPERATION_GLYPHS, OperationGlyph } from "./operation-icons";

/**
 * Both directions of the symbol contract: every served symbol has a drawn
 * glyph — a verb falling to the fallback is a review finding, not a quiet
 * circle — and every drawn glyph is served by some verb, so the set
 * carries no dead weight.
 */
describe("served symbols and drawn glyphs", () => {
  it("every served symbol resolves to a drawn glyph", () => {
    for (const operation of OPERATIONS) {
      expect(OPERATION_GLYPHS[operation.symbol], `${operation.id} → ${operation.symbol}`).toBeDefined();
    }
  });

  it("every drawn glyph is served by at least one verb", () => {
    const served = new Set(OPERATIONS.map((o) => o.symbol));
    for (const symbol of Object.keys(OPERATION_GLYPHS)) {
      expect(served.has(symbol), symbol).toBe(true);
    }
  });

  it("an unknown symbol draws the fallback rather than nothing", () => {
    const html = renderToStaticMarkup(<OperationGlyph symbol="not_a_symbol" />);
    expect(html).toContain("<svg");
    expect(html).toContain('viewBox="0 0 40 40"');
  });
});

/** The set's own facts: the drawings differ as geometry, not just
 * as keys; every pictogram is decoration. */
describe("the two-tone set", () => {
  const geometryOf = (symbol: string) =>
    renderToStaticMarkup(<OperationGlyph symbol={symbol} />).replace(/class="[^"]*"/g, "");

  it("the twenty-one drawings are pairwise distinct as geometry", () => {
    const symbols = OPERATIONS.map((o) => o.symbol);
    expect(new Set(symbols).size).toBe(21);
    const drawings = symbols.map(geometryOf);
    expect(new Set(drawings).size).toBe(21);
  });

  it("the formerly shared pairs differ where they used to blur", () => {
    expect(geometryOf("filter")).not.toBe(geometryOf("filter_location"));
    expect(geometryOf("stats")).not.toBe(geometryOf("summarize"));
  });

  it("every pictogram, the fallback included, stays out of the accessibility tree", () => {
    for (const symbol of [...OPERATIONS.map((o) => o.symbol), "not_a_symbol"]) {
      expect(renderToStaticMarkup(<OperationGlyph symbol={symbol} />)).toContain('aria-hidden="true"');
    }
  });
});
