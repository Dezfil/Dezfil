import { describe, expect, it } from "vitest";
import { recognizeCsvGeometry } from "@/lib/ingest/csv-geometry";
import { buildOpenApiDocument } from "./openapi";

/**
 * The published CSV wording: the Table schema documents the
 * suspect-header state, and the upload operation's description carries
 * all four required parts — the recognition rules, both warning
 * signals, and the advisory nature. Each part is pinned separately so a
 * criterion cannot close on a fraction of itself.
 */
describe("the upload contract's CSV wording", () => {
  const doc = buildOpenApiDocument() as unknown as {
    paths: Record<
      string,
      { post?: { description?: string } }
    >;
    components: {
      schemas: Record<
        string,
        { properties?: Record<string, { type?: string }> }
      >;
    };
  };

  it("the Table schema documents the warning state", () => {
    expect(
      doc.components.schemas.Table.properties?.headerSuspect?.type,
    ).toBe("boolean");
  });

  it("the upload description carries the four parts", () => {
    const description = doc.paths["/api/tables"].post?.description ?? "";
    // The recognition rules — every documented direct pair, not a
    // sample of them: an incomplete enumeration is an incomplete contract.
    expect(description).toMatch(/wkt\/geometry\/geom/);
    expect(description).toMatch(/lon\/lat/);
    expect(description).toMatch(/lng\/lat/);
    expect(description).toMatch(/long\/lat/);
    expect(description).toMatch(/longitude\/latitude/);
    // Signal (a): the unsplit header.
    expect(description).toMatch(/name containing a comma/);
    // Signal (b): the consumed header.
    expect(description).toMatch(/most names numeric or blank/);
    // The advisory effect.
    expect(description).toMatch(/advisory/);
    expect(description).toMatch(/headerSuspect/);
  });

  it("holds the published blank-pair wording against rule 2", () => {
    const description = doc.paths["/api/tables"].post?.description ?? "";
    const recognized = recognizeCsvGeometry([
      { name: "LoN", type: "DOUBLE" },
      { name: "lAt", type: "VARCHAR", allBlank: true },
    ]);

    // This is intentionally two-sided: changing recognition alone breaks the
    // first value; changing the independently authored prose alone breaks the
    // remaining values.
    expect({
      recognized,
      numericOrBlank: description.includes(
        "each member is numeric or contains no non-blank values",
      ),
      readerBlanks: description.includes(
        "Empty and quoted-empty fields are blank",
      ),
      whitespaceIsText: description.includes("whitespace-only text is not"),
      missingMember: description.includes(
        "A row missing either member has null geometry",
      ),
      blankYieldsToPrefixed: description.includes(
        "when a member qualifies only by being blank, a numeric prefixed pair takes precedence",
      ),
    }).toEqual({
      recognized: { kind: "point", lon: "LoN", lat: "lAt" },
      numericOrBlank: true,
      readerBlanks: true,
      whitespaceIsText: true,
      missingMember: true,
      blankYieldsToPrefixed: true,
    });
  });
});

// prose clauses and real-reader outcomes are independent assertions.
describe("published content-recognition contract", () => {
  const document = buildOpenApiDocument() as unknown as {
    paths: Record<string, { post: { description: string } }>;
    components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
  };
  const description = document.paths["/api/tables"].post.description;
  it.each([
    /names first/i, /WKT\/EWKT/, /GeoJSON geometry objects/, /WKB hex/, /H3 cell/,
    /first 1,000 reader rows/, /every sampled non-null value/, /some but not all/,
    /numeric pairs.*always weak/i, /prefixed x\/y.*bare x\/y/,
    /named WKT column.*none readable.*stays weak.*retains its source text/,
    /entire input/, /declared CRS.*reproject/i, /conflicting.*untransformable/,
    /unreadable.*NULL geometry/i, /full-input unreadable count/,
    /geometryCandidates/, /geometryRecord/,
  ])("publishes clause %s", clause => {
    expect(description).toMatch(clause);
  });
  it.each(["geometryRecord", "geometryCandidates"])("Table exposes %s", field => {
    expect(document.components.schemas.Table.properties).toHaveProperty(field);
  });
  it.each([
    ["GeometryRecord", ["columns", "format", "signal", "rule", "crs", "unreadableCount"]],
    ["GeometryCandidate", ["columns", "format", "signal", "rule", "strength", "sample", "crs", "degreeCompatible", "reasons", "orientations", "applied", "sourceRetained"]],
    ["GeometrySample", ["rows", "nonNull", "readable"]],
    ["GeometryCrs", ["stance", "srid", "label"]],
  ] as const)("documents the complete %s evidence", (schema, fields) => {
    for (const field of fields) expect(document.components.schemas[schema]?.properties).toHaveProperty(field);
  });
});
