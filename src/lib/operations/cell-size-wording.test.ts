import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { formatCellKm } from "@/components/builder/style-panel/size-rows";
import { normalizeViz, HEX_CELL_KM } from "@/lib/viz";

/**
 * The collision, relabelled and **not** migrated.
 *
 * The builder ships a control printing kilometres that are not ground
 * kilometres: the cell edge is a length in web-mercator metres, so a "1.2 km"
 * cell covers about 730 m of ground at Berlin's latitude. With leaving exactly
 * one meaning of "metre" in this product, the same builder would otherwise
 * print "km" for two different lengths in adjacent panels with nothing on
 * screen telling them apart.
 *
 * **Only the words change.** Re-deriving every saved cell size would silently
 * re-tessellate every hex-bin and grid layer already saved or published, on
 * read — a worse defect than an imprecise word, in a surface this phase is not
 * otherwise touching.
 */

const CONTROL = path.join(
  process.cwd(),
  "src/components/builder/style-panel/size-rows.tsx",
);
const DOCS = path.join(process.cwd(), "src/components/DocsScreen.tsx");

const publishedDescription = (): string => {
  const doc = buildOpenApiDocument() as unknown as {
    components: {
      schemas: Record<
        string,
        { properties?: Record<string, { description?: string }> }
      >;
    };
  };
  return doc.components.schemas.Viz?.properties?.cellKm?.description ?? "";
};

describe("the three places agree, and none reads as a ground distance", () => {
  it("names the projection on the control", () => {
    const source = readFileSync(CONTROL, "utf8");
    // Which metre, said in the label rather than left to be discovered.
    expect(source).toMatch(/Cell size \(Mercator\)/);
    expect(source).toMatch(/aria-label="Cell size in web-mercator units"/);
  });

  it("names the projection in the published description, and gives its magnitude", () => {
    const description = publishedDescription();
    expect(description).toMatch(/web-mercator/i);
    // The magnitude, so a reader learns what the difference costs them.
    expect(description).toMatch(/730 m/);
    expect(description).toMatch(/not a ground distance/i);
  });

  it("says nowhere that the number is a ground distance", () => {
    const description = publishedDescription();
    // The failure this relabel exists to prevent is the opposite claim.
    expect(description).not.toMatch(/ground (?:kilometre|km|size)/i);
    expect(readFileSync(CONTROL, "utf8")).not.toMatch(/ground size/i);
  });

  it("does not soften the number, which is exact", () => {
    // "About 1.2 km" would keep the collision and add a false claim about
    // precision: the number is exact, it is simply a length on a projection.
    expect(formatCellKm(1.2)).toBe("1.2 km");
    expect(formatCellKm(0.46)).toBe("460 m");
    expect(publishedDescription()).not.toMatch(/approximately \d|about 1\.2 km/i);
  });

  it("says it on the API reference page a human actually reads", () => {
    // Not "the page imports the document": the page renders endpoint and
    // operation descriptions, **not** schema fields, so the published
    // parameter description never reached a reader. Asserting the import
    // would have been green while the wording was invisible — which is how
    // this check was failing before a review caught it.
    const docs = readFileSync(DOCS, "utf8");
    expect(docs).toMatch(/web-mercator/i);
    expect(docs).toMatch(/730 m/);
    expect(docs).toMatch(/not a ground distance/i);
    // And the other half of the same sentence: everything else is ground.
    expect(docs).toMatch(/ground metres/i);
  });
});

describe("no stored value changes", () => {
  /**
   * Golden values, written here rather than computed, so this compares against
   * the behaviour that shipped rather than against itself. Two executions of
   * the current code agreeing would prove nothing about historical equivalence.
   */
  const GOLDEN: [number, string][] = [
    [1.2, "1.2 km"],
    [1.22, "1.22 km"],
    [0.46, "460 m"],
    [0.02, "20 m"],
    [1000, "1000 km"],
  ];

  it("reads a saved cell size back unchanged", () => {
    for (const [km] of GOLDEN) {
      const saved = { type: "hexbin" as const, cellKm: km, aggregate: { fn: "count" as const } };
      const read = normalizeViz(saved) as { cellKm: number };
      expect(read.cellKm).toBe(km);
    }
  });

  it("formats it to the same strings it formatted before", () => {
    for (const [km, shown] of GOLDEN) expect(formatCellKm(km)).toBe(shown);
  });

  it("keeps the shipped default and the legacy migration target", () => {
    // 1.2 km is the shipped default and 1.22 km is where a legacy H3
    // resolution-7 layer lands. A relabel that moved either would be the
    // migration this spec explicitly does not do.
    expect(HEX_CELL_KM.default).toBe(1.2);
    expect(formatCellKm(1.22)).toBe("1.22 km");
  });
});
