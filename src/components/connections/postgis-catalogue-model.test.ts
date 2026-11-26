import { describe, expect, it } from "vitest";
import {
  catalogueGroups,
  estimateLabel,
  groupIsClosed,
  relationKindLabel,
  spatialFacts,
} from "./postgis-catalogue-model";
import type { PostgisRemoteRelation } from "./postgis-pane-types";

function relation(
  table: string,
  fields: Partial<PostgisRemoteRelation> = {},
): PostgisRemoteRelation {
  return {
    schema: "public",
    table,
    kind: "table",
    system: false,
    geometryColumn: null,
    geometryType: null,
    srid: null,
    spatialKind: null,
    approxRows: 4,
    ...fields,
  };
}

const fixture = [
  relation("attribute"),
  relation("spatial", {
    geometryColumn: "geom",
    geometryType: "POINT",
    srid: 4326,
    spatialKind: "geometry",
  }),
  relation("ordinary_catalog_entry", { system: true }),
  relation("system_status_view", {
    kind: "view",
    system: true,
    approxRows: undefined,
  }),
  relation("other", { schema: "alpha" }),
];

describe("grouped PostGIS catalogue", () => {
  it("puts public first and orders spatial, attribute, then system", () => {
    const groups = catalogueGroups(fixture, "", "all");
    expect(groups.map((group) => group.schema)).toEqual(["public", "alpha"]);
    expect(groups[0]).toMatchObject({ spatialCount: 1, attributeCount: 3 });
    expect(groups[0].relations.map((item) => item.table)).toEqual([
      "spatial",
      "attribute",
      "ordinary_catalog_entry",
      "system_status_view",
    ]);
  });

  it("filters and searches qualified names while revealing collapsed matches", () => {
    expect(
      catalogueGroups(fixture, "alpha.other", "attribute").flatMap((group) =>
        group.relations.map((item) => item.table),
      ),
    ).toEqual(["other"]);
    expect(catalogueGroups(fixture, "", "spatial")[0].relations).toHaveLength(1);
    const closed = new Set(["alpha"]);
    expect(groupIsClosed(closed, "alpha", "")).toBe(true);
    expect(groupIsClosed(closed, "alpha", "other")).toBe(false);
  });

  it("keeps system, kind, geography, and estimate truths independent", () => {
    const systemView = catalogueGroups(fixture, "", "all")
      .flatMap((group) => group.relations)
      .find((item) => item.table === "system_status_view");
    expect(systemView).toMatchObject({ kind: "view", system: true });
    expect(relationKindLabel(systemView!)).toBe("view");
    expect(estimateLabel(systemView!)).toBe("");
    expect(estimateLabel(relation("new", { approxRows: null }))).toBe("not analyzed");
    expect(estimateLabel(relation("empty", { approxRows: 0 }))).toBe("~0 rows");
    // The kind as a plain word; the column type and the SRID as the
    // schema has them, shown beside it in mono.
    expect(
      spatialFacts(
        relation("places", {
          geometryColumn: "geog",
          geometryType: "POINT",
          srid: 4326,
          spatialKind: "geography",
        }),
      ),
    ).toEqual({ type: "geography", kind: "Points", srid: "4326" });
    expect(
      spatialFacts(relation("parcels", { geometryColumn: "geom", geometryType: "MULTIPOLYGON", srid: null, spatialKind: "geometry" })),
    ).toEqual({ type: "geometry", kind: "Polygons", srid: null });
    expect(
      spatialFacts(relation("shapes", { geometryColumn: "geom", geometryType: null, srid: 3857, spatialKind: "geometry" })),
    ).toEqual({ type: "geometry", kind: "Geometry", srid: "3857" });
    expect(spatialFacts(relation("plain", { geometryColumn: null, geometryType: null, srid: null, spatialKind: null }))).toBeNull();
  });
});
