import { describe, it, expect, afterEach } from "vitest";
import { parseReleaseListing, isValidRelease } from "./releases";
import { OVERTURE_THEMES } from "./catalogue";
import {
  isBbox,
  bboxAreaKm2,
  assertAreaWithinBudget,
  buildOvertureSelect,
  overtureReadExpr,
  resolveOvertureParams,
  resolveSelection,
  parseStoredOvertureParams,
  type Bbox,
} from "./import";
import {
  buildOvertureQuery,
  buildOvertureCount,
  buildOvertureLevelCounts,
  buildOverturePreview,
  defaultSemantics,
  isRing,
  ringWkt,
  ringBbox,
  type Ring,
} from "./query";

afterEach(() => {
  delete process.env.DEZFIL_OVERTURE_MAX_KM2;
});

const BERLIN: Bbox = [13.088, 52.338, 13.761, 52.675];

describe("release listing", () => {
  it("parses common prefixes, filters noise, newest first", () => {
    const xml = `
      <ListBucketResult>
        <CommonPrefixes><Prefix>release/</Prefix></CommonPrefixes>
        <CommonPrefixes><Prefix>release/2026-05-20.0/</Prefix></CommonPrefixes>
        <CommonPrefixes><Prefix>release/2026-06-17.0/</Prefix></CommonPrefixes>
        <CommonPrefixes><Prefix>release/not-a-release/</Prefix></CommonPrefixes>
      </ListBucketResult>`;
    expect(parseReleaseListing(xml)).toEqual(["2026-06-17.0", "2026-05-20.0"]);
  });

  it("validates release shapes", () => {
    expect(isValidRelease("2026-06-17.0")).toBe(true);
    expect(isValidRelease("latest")).toBe(false);
    expect(isValidRelease("2026-06-17")).toBe(false);
  });
});

describe("bbox", () => {
  it("validates shape and bounds", () => {
    expect(isBbox(BERLIN)).toBe(true);
    expect(isBbox([13, 52, 12, 53])).toBe(false); // west >= east
    expect(isBbox([13, 52, 14])).toBe(false);
    expect(isBbox([-190, 0, 0, 10])).toBe(false);
  });

  it("approximates Berlin's box near 1,700 km²", () => {
    const area = bboxAreaKm2(BERLIN);
    expect(area).toBeGreaterThan(1_400);
    expect(area).toBeLessThan(2_000);
  });
});

describe("area budget", () => {
  it("scales by theme density and refuses over-budget selections", () => {
    process.env.DEZFIL_OVERTURE_MAX_KM2 = "1000";
    // Berlin (~1,700 km²) is over a 1,000 km² places budget…
    expect(() => assertAreaWithinBudget("places", BERLIN)).toThrow(
      /allows up to/,
    );
    // …but far under divisions' 20× budget.
    expect(() => assertAreaWithinBudget("divisions", BERLIN)).not.toThrow();
    // Buildings at 0.2× is stricter still.
    expect(() => assertAreaWithinBudget("buildings", BERLIN)).toThrow();
  });
});

describe("query shaping", () => {
  it("reads the base theme's two types with schema union", () => {
    const expr = overtureReadExpr("base", "2026-06-17.0");
    expect(expr).toContain("theme=base/type=land");
    expect(expr).toContain("theme=base/type=water");
    expect(expr).toContain("union_by_name=1");
    expect(overtureReadExpr("places", "2026-06-17.0")).not.toContain(
      "union_by_name",
    );
  });

  it("promotes name and category only when their structs exist", () => {
    const withStructs = buildOvertureSelect(
      "places",
      "2026-06-17.0",
      BERLIN,
      ["names", "categories", "geometry"],
      undefined,
    );
    expect(withStructs).toContain(`names."primary" AS name`);
    expect(withStructs).toContain(`categories."primary" AS category`);

    const without = buildOvertureSelect(
      "addresses",
      "2026-06-17.0",
      BERLIN,
      ["geometry", "number", "street"],
      undefined,
    );
    expect(without).toContain("SELECT * FROM");

    const collision = buildOvertureSelect(
      "places",
      "2026-06-17.0",
      BERLIN,
      ["names", "name", "geometry"],
      undefined,
    );
    expect(collision).not.toContain("AS name");
  });

  it("filters by category for places only, with the bbox predicate", () => {
    const sql = buildOvertureSelect(
      "places",
      "2026-06-17.0",
      BERLIN,
      ["names", "categories"],
      "restaurant",
    );
    expect(sql).toContain(`categories."primary" = 'restaurant'`);
    expect(sql).toContain("bbox.xmin <= 13.761");
    const buildings = buildOvertureSelect(
      "buildings",
      "2026-06-17.0",
      BERLIN,
      ["names"],
      "restaurant",
    );
    expect(buildings).not.toContain("restaurant");
  });
});

describe("scopes and semantics", () => {
  const base = {
    release: "2026-06-17.0",
    semantics: "within" as const,
  };

  it("defaults follow the data's shape", () => {
    expect(defaultSemantics("places")).toBe("within");
    expect(defaultSemantics("divisions")).toBe("within");
    expect(defaultSemantics("transportation")).toBe("intersect");
    expect(defaultSemantics("base")).toBe("intersect");
  });

  it("country and state scopes are attribute filters for divisions", () => {
    const country = buildOvertureQuery(
      { ...base, theme: "divisions", scope: { kind: "country", code: "DE" } },
      [],
    );
    expect(country).toContain(`country = 'DE'`);
    expect(country).not.toContain("ST_");
    const state = buildOvertureQuery(
      {
        ...base,
        theme: "divisions",
        scope: { kind: "region", code: "DE-HE" },
        level: "county",
      },
      [],
    );
    expect(state).toContain(`region = 'DE-HE'`);
    expect(state).toContain(`subtype = 'county'`);
    expect(state).toContain(`coalesce(class, 'land') = 'land'`);
  });

  it("attribute scopes refuse non-division themes", () => {
    expect(() =>
      buildOvertureQuery(
        { ...base, theme: "places", scope: { kind: "country", code: "DE" } },
        [],
      ),
    ).toThrow(/boundary polygons/);
  });

  it("within demands containment in both prefilter and predicate", () => {
    const sql = buildOvertureQuery(
      { ...base, theme: "buildings", scope: { kind: "bbox", bbox: BERLIN } },
      [],
    );
    expect(sql).toContain(`bbox.xmin >= 13.088`);
    expect(sql).toContain(`bbox.xmax <= 13.761`);
    expect(sql).toContain("ST_Within(geometry, ST_MakeEnvelope(");
  });

  it("intersect keeps the overlap prefilter with an exact predicate", () => {
    const sql = buildOvertureQuery(
      {
        ...base,
        theme: "transportation",
        scope: { kind: "bbox", bbox: BERLIN },
        semantics: "intersect",
      },
      [],
    );
    expect(sql).toContain(`bbox.xmin <= 13.761`);
    expect(sql).toContain("ST_Intersects(geometry, ST_MakeEnvelope(");
  });

  it("shape scopes carry the polygon and its prefilter bbox", () => {
    const ring: Ring = [
      [13.2, 52.4],
      [13.6, 52.4],
      [13.4, 52.6],
    ];
    expect(isRing(ring)).toBe(true);
    expect(isRing([[13.2, 52.4]])).toBe(false);
    const wkt = ringWkt(ring);
    expect(wkt).toBe("POLYGON((13.2 52.4, 13.6 52.4, 13.4 52.6, 13.2 52.4))");
    expect(ringBbox(ring)).toEqual([13.2, 52.4, 13.6, 52.6]);
    const sql = buildOvertureQuery(
      {
        ...base,
        theme: "places",
        scope: { kind: "shape", wkt, bbox: ringBbox(ring) },
      },
      [],
    );
    expect(sql).toContain(`ST_Within(geometry, ST_GeomFromText('POLYGON((`);
  });

  it("count and import share one filter", () => {
    const selection = {
      ...base,
      theme: "divisions" as const,
      scope: { kind: "region" as const, code: "DE-HE" },
      level: "county",
    };
    const where = buildOvertureQuery(selection, []).split(" WHERE ")[1];
    expect(buildOvertureCount(selection)).toContain(` WHERE ${where}`);
    expect(buildOvertureCount(selection)).toContain("count(*)");
  });

  it("the bbox form is an intersect rectangle with an exact predicate", () => {
    const sql = buildOvertureSelect("divisions", "2026-06-17.0", BERLIN, []);
    expect(sql).toContain("ST_Intersects(geometry, ST_MakeEnvelope(");
    expect(sql).toContain(`bbox.xmin <= 13.761`);
  });
});

describe("request validation", () => {
  it("rejects unknown themes, bad boxes, malformed releases", async () => {
    await expect(
      resolveOvertureParams({ theme: "planets", bbox: BERLIN }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      resolveOvertureParams({ theme: "places", bbox: [1, 2, 3] }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      resolveOvertureParams({
        theme: "places",
        bbox: BERLIN,
        release: "latest-and-greatest",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("passes explicit releases through without touching the network", async () => {
    const params = await resolveOvertureParams({
      theme: "divisions",
      bbox: BERLIN,
      release: "2026-05-20.0",
      name: "berlin_admin",
    });
    expect(params.release).toBe("2026-05-20.0");
    expect(params.requestedName).toBe("berlin_admin");
    expect(OVERTURE_THEMES[params.theme].label).toBe("Divisions");
  });
});

describe("import params", () => {
  const release = "2026-06-17.0";

  it("legacy bbox requests become intersect rectangles", async () => {
    const p = await resolveOvertureParams({
      theme: "divisions",
      bbox: BERLIN,
      release,
    });
    expect(p.scope).toEqual({ type: "bbox", bbox: BERLIN });
    expect(p.semantics).toBe("intersect");
  });

  it("scoped requests default semantics per theme, overridable", async () => {
    const p = await resolveOvertureParams({
      theme: "places",
      scope: { type: "country", code: "de" },
      release,
    });
    expect(p.semantics).toBe("within");
    const t = await resolveOvertureParams({
      theme: "transportation",
      scope: { type: "bbox", bbox: BERLIN },
      release,
    });
    expect(t.semantics).toBe("intersect");
    const flipped = await resolveOvertureParams({
      theme: "transportation",
      scope: { type: "bbox", bbox: BERLIN },
      semantics: "within",
      release,
    });
    expect(flipped.semantics).toBe("within");
  });

  it("rejects malformed scopes, semantics, and misplaced levels", async () => {
    await expect(
      resolveOvertureParams({
        theme: "places",
        scope: { type: "country", code: "DEU" },
        release,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      resolveOvertureParams({
        theme: "places",
        scope: { type: "bbox", bbox: BERLIN },
        semantics: "overlaps",
        release,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      resolveOvertureParams({
        theme: "places",
        scope: { type: "bbox", bbox: BERLIN },
        level: "county",
        release,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("attribute scopes skip the budget; drawn shapes are checked", async () => {
    process.env.DEZFIL_OVERTURE_MAX_KM2 = "1";
    const attribute = await resolveSelection({
      theme: "divisions",
      release,
      scope: { type: "state", code: "de-he" },
      semantics: "within",
      level: "county",
    });
    expect(attribute.scope).toEqual({ kind: "region", code: "DE-HE" });
    await expect(
      resolveSelection({
        theme: "places",
        release,
        scope: { type: "bbox", bbox: BERLIN },
        semantics: "within",
      }),
    ).rejects.toMatchObject({ code: "area_too_large" });
    await expect(
      resolveSelection({
        theme: "places",
        release,
        scope: {
          type: "polygon",
          ring: [
            [13.2, 52.4],
            [13.6, 52.4],
            [13.4, 52.6],
          ],
        },
        semantics: "within",
      }),
    ).rejects.toMatchObject({ code: "area_too_large" });
  });

  it("stored provenance round-trips both generations", () => {
    const legacy = parseStoredOvertureParams(
      { theme: "divisions", bbox: BERLIN, release },
      "t",
    );
    expect(legacy.scope).toEqual({ type: "bbox", bbox: BERLIN });
    expect(legacy.semantics).toBe("intersect");

    const modern = parseStoredOvertureParams(
      {
        theme: "divisions",
        scope: { type: "state", code: "DE-HE", label: "Hessen" },
        semantics: "within",
        level: "county",
        release,
      },
      "t",
    );
    expect(modern.level).toBe("county");
    expect(modern.scope).toMatchObject({ type: "state", code: "DE-HE" });

    expect(() => parseStoredOvertureParams({ theme: "divisions" }, "t")).toThrow(
      /incomplete Overture recipe/,
    );
  });
});

describe("feature scopes and level counts", () => {
  const release = "2026-06-17.0";
  const feature = {
    type: "MultiPolygon",
    coordinates: [
      [
        [
          [13.2, 52.4],
          [13.3, 52.4],
          [13.3, 52.5],
          [13.2, 52.5],
          [13.2, 52.4],
        ],
      ],
      [
        [
          [13.5, 52.4],
          [13.6, 52.4],
          [13.6, 52.5],
          [13.5, 52.5],
          [13.5, 52.4],
        ],
      ],
    ],
  };

  it("a layer feature's geometry becomes a shape scope, holes and parts intact", async () => {
    const p = await resolveOvertureParams({
      theme: "places",
      scope: { type: "feature", geometry: feature, label: "my_layer" },
      release,
    });
    expect(p.semantics).toBe("within");
    const selection = await resolveSelection(p);
    expect(selection.scope).toMatchObject({
      kind: "shape",
      bbox: [13.2, 52.4, 13.6, 52.5],
    });
    expect((selection.scope as { wkt: string }).wkt).toMatch(
      /^MULTIPOLYGON\(\(\(13\.2 52\.4/,
    );
  });

  it("rejects non-polygonal or over-budget feature geometries", async () => {
    await expect(
      resolveOvertureParams({
        theme: "places",
        scope: { type: "feature", geometry: { type: "Point", coordinates: [13, 52] } },
        release,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const huge = {
      type: "Polygon",
      coordinates: [
        Array.from({ length: 20_002 }, (_, i) => [
          13 + (i % 100) * 0.001,
          52 + Math.floor(i / 100) * 0.001,
        ]),
      ],
    };
    await expect(
      resolveOvertureParams({
        theme: "places",
        scope: { type: "feature", geometry: huge },
        release,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("feature scopes round-trip through stored provenance", () => {
    const p = parseStoredOvertureParams(
      {
        theme: "buildings",
        scope: { type: "feature", geometry: feature, label: "my_layer" },
        semantics: "intersect",
        release,
      },
      "t",
    );
    expect(p.scope).toMatchObject({ type: "feature" });
    expect(p.semantics).toBe("intersect");
  });

  it("level counts group by subtype with the level filter dropped", () => {
    const sql = buildOvertureLevelCounts({
      theme: "divisions",
      release,
      scope: { kind: "shape", wkt: "POLYGON((13 52, 14 52, 14 53, 13 52))", bbox: BERLIN },
      semantics: "within",
      level: "county",
    });
    expect(sql).toContain("GROUP BY subtype");
    expect(sql).toContain("count(*) AS n");
    expect(sql).toContain(`coalesce(class, 'land') = 'land'`);
    expect(sql).toContain("ST_Within(geometry");
    expect(sql).not.toContain("subtype =");
  });

  it("the Run Query preview shares the import's filters and states its cap", () => {
    const sql = buildOverturePreview(
      {
        theme: "divisions",
        release,
        scope: { kind: "region", code: "DE-BE" },
        semantics: "within",
        level: "locality",
      },
      2000,
    );
    expect(sql).toContain("ST_AsGeoJSON(geometry)");
    expect(sql).toContain(`region = 'DE-BE'`);
    expect(sql).toContain(`subtype = 'locality'`);
    expect(sql).toContain("LIMIT 2001");
  });

  it("level counts work for attribute scopes and refuse other themes", () => {
    const sql = buildOvertureLevelCounts({
      theme: "divisions",
      release,
      scope: { kind: "region", code: "DE-BE" },
      semantics: "within",
    });
    expect(sql).toContain(`region = 'DE-BE'`);
    expect(() =>
      buildOvertureLevelCounts({
        theme: "places",
        release,
        scope: { kind: "bbox", bbox: BERLIN },
        semantics: "within",
      }),
    ).toThrow(/divisions theme only/);
  });
});
