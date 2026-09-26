import { describe, it, expect } from "vitest";
import {
  changedRefs,
  filterRefs,
  listRefs,
  refProblem,
  styleRefs,
  vizRefs,
  type ColumnRef,
} from "@/lib/column-validation";
import type { LayerFieldsResult } from "@/lib/layer-service";
import type { LayerStyle } from "@/lib/style/style";
import type { LayerViz } from "@/lib/viz";

const rgba = { r: 0, g: 0, b: 0, a: 1 };

const baseStyle: LayerStyle = {
  fill: { type: "constant", color: rgba },
  fillOpacity: 1,
  stroke: rgba,
  strokeOpacity: 1,
  strokeWidth: 1,
  pointRadius: 4,
  opacity: 1,
};

const fields: LayerFieldsResult = {
  styling: [
    { name: "name", type: "VARCHAR", numeric: false, kind: "text" },
    { name: "riders", type: "BIGINT", numeric: true, kind: "numeric" },
    { name: "seen_at", type: "TIMESTAMP", numeric: false, kind: "time" },
  ],
  filterable: [
    { name: "name", type: "VARCHAR", numeric: false, kind: "text" },
    { name: "riders", type: "BIGINT", numeric: true, kind: "numeric" },
    { name: "seen_at", type: "TIMESTAMP", numeric: false, kind: "time" },
  ],
  geometryColumns: ["geometry", "dest_geom"],
};

describe("reference extraction", () => {
  it("collects every data-driven style channel with its kind", () => {
    const style: LayerStyle = {
      ...baseStyle,
      fill: {
        type: "quantile",
        attribute: "riders",
        palette: "viridis",
        breaks: [1],
        colors: [rgba, rgba],
      },
      strokeBy: {
        type: "categorical",
        attribute: "name",
        palette: "bold",
        map: [],
        other: rgba,
      },
      pointRadiusBy: { attribute: "riders", domain: [0, 1], range: [1, 10] },
      label: { attribute: "name", size: 12, color: rgba, haloWidth: 1, haloColor: { r: 12, g: 16, b: 24, a: 0.8 } },
    };
    const refs = styleRefs(style);
    expect(refs).toContainEqual({
      family: "styling",
      needs: "numeric",
      name: "riders",
      channel: "fill",
    });
    expect(refs).toContainEqual({
      family: "styling",
      needs: "any",
      name: "name",
      channel: "stroke color",
    });
    expect(refs).toContainEqual({
      family: "styling",
      needs: "numeric",
      name: "riders",
      channel: "point radius",
    });
    expect(refs).toContainEqual({
      family: "styling",
      needs: "any",
      name: "name",
      channel: "label",
    });
  });

  it("a constant style carries no references", () => {
    expect(styleRefs(baseStyle)).toEqual([]);
  });

  it("collects aggregation, weight, endpoint and cluster references", () => {
    const hexbin: LayerViz = {
      type: "hexbin",
      cellKm: 1,
      aggregate: { fn: "sum", attribute: "riders" },
      elevation: { aggregate: { fn: "avg", attribute: "riders" }, height: 100 },
    };
    expect(vizRefs(hexbin)).toEqual([
      {
        family: "filterable",
        needs: "numeric",
        name: "riders",
        channel: "aggregation",
      },
      {
        family: "filterable",
        needs: "numeric",
        name: "riders",
        channel: "elevation aggregation",
      },
    ]);
    expect(
      vizRefs({ type: "hexbin", cellKm: 1, aggregate: { fn: "count" } }),
    ).toEqual([]);
    expect(
      vizRefs({ type: "heatmap", radiusPx: 30, intensity: 1, weight: "riders" }),
    ).toEqual([
      {
        family: "filterable",
        needs: "numeric",
        name: "riders",
        channel: "heatmap weight",
      },
    ]);
    expect(
      vizRefs({
        type: "arc",
        origin: { kind: "geometry", field: "geometry" },
        dest: { kind: "lonlat", lon: "lng", lat: "lat" },
        height: 0.5,
      } as LayerViz),
    ).toEqual([
      {
        family: "geometry",
        needs: "any",
        name: "geometry",
        channel: "origin endpoint",
      },
      {
        family: "filterable",
        needs: "numeric",
        name: "lng",
        channel: "destination endpoint longitude",
      },
      {
        family: "filterable",
        needs: "numeric",
        name: "lat",
        channel: "destination endpoint latitude",
      },
    ]);
    expect(
      vizRefs({
        type: "cluster",
        radiusPx: 40,
        color: { fn: "max", attribute: "riders" },
        showCounts: true,
      }),
    ).toEqual([
      {
        family: "filterable",
        needs: "numeric",
        name: "riders",
        channel: "cluster color aggregation",
      },
    ]);
  });

  it("filter kinds decide the needed field kind", () => {
    const refs = filterRefs([
      { field: "riders", kind: "range", min: 0, max: 1 },
      { field: "seen_at", kind: "timerange", min: null, max: null },
      { field: "name", kind: "values", values: ["a"] },
    ]);
    expect(refs.map((r) => r.needs)).toEqual(["numeric", "time", "any"]);
  });

  it("lists carry existence-only references in their family", () => {
    expect(listRefs(["name"], "styling", "tooltip")).toEqual([
      { family: "styling", needs: "any", name: "name", channel: "tooltip" },
    ]);
    expect(listRefs(null, "filterable", "published fields")).toEqual([]);
  });
});

describe("the echo contract", () => {
  const stored: ColumnRef[] = [
    { family: "styling", needs: "any", name: "gone", channel: "fill" },
  ];

  it("an unchanged stored reference passes through", () => {
    expect(changedRefs(stored, stored)).toEqual([]);
  });

  it("the same column bound to a new kind requirement validates", () => {
    const incoming: ColumnRef[] = [
      { family: "styling", needs: "numeric", name: "gone", channel: "fill" },
    ];
    expect(changedRefs(incoming, stored)).toEqual(incoming);
  });

  it("a new reference validates while echoes alongside it pass", () => {
    const incoming: ColumnRef[] = [
      ...stored,
      { family: "styling", needs: "any", name: "fresh", channel: "label" },
    ];
    expect(changedRefs(incoming, stored)).toEqual([
      { family: "styling", needs: "any", name: "fresh", channel: "label" },
    ]);
  });
});

describe("resolution against the schema", () => {
  it("accepts references that exist with the right kind", () => {
    expect(
      refProblem(
        [
          { family: "styling", needs: "numeric", name: "riders", channel: "fill" },
          { family: "filterable", needs: "time", name: "seen_at", channel: "timerange filter" },
          { family: "geometry", needs: "any", name: "dest_geom", channel: "destination endpoint" },
        ],
        fields,
      ),
    ).toBeNull();
  });

  it("names a missing column and its channel", () => {
    expect(
      refProblem(
        [{ family: "styling", needs: "any", name: "typo", channel: "tooltip" }],
        fields,
      ),
    ).toBe(
      'The tooltip references column "typo", which the layer\'s result does not provide.',
    );
  });

  it("names a kind mismatch with both kinds", () => {
    expect(
      refProblem(
        [{ family: "styling", needs: "numeric", name: "name", channel: "fill" }],
        fields,
      ),
    ).toBe('The fill needs a numeric column; "name" is text.');
    expect(
      refProblem(
        [
          {
            family: "filterable",
            needs: "time",
            name: "riders",
            channel: "timerange filter",
          },
        ],
        fields,
      ),
    ).toBe('The timerange filter needs a time column; "riders" is numeric.');
  });

  it("geometry references resolve only against geometry columns", () => {
    expect(
      refProblem(
        [
          {
            family: "geometry",
            needs: "any",
            name: "name",
            channel: "origin endpoint",
          },
        ],
        fields,
      ),
    ).toBe(
      'The origin endpoint references "name", which is not a geometry column of the layer\'s result.',
    );
  });
});
