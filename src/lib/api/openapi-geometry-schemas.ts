import { INSPECT_PREVIEW_ROWS } from "@/lib/table-preview-limit";
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (name: string) => ({ anyOf: [ref(name), { type: "null" }] });
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const revision = { type: "string", minLength: 1, description: "Opaque token binding table identity and artifact generation. Do not interpret or construct it." };
const extent = { type: ["array", "null"], items: { type: "number" }, minItems: 4, maxItems: 4, description: "Full WGS84 west, south, east, north bounds; null without a placeable nonempty geometry." };
const mode = { type: "string", enum: ["unmodified", "set", "cleared"], description: "Unmodified means no manual override. Clear removes the override; the next URL refresh resets mode to unmodified and records its fresh automatic recognition." };
const columnList = { type: "array", items: object({ name: { type: "string" }, type: { type: "string" } }) };
const count = { type: "integer", minimum: 0 };
const row = object({ index: count, values: { type: "object", additionalProperties: true }, status: { type: "string", enum: ["readable", "missing", "unreadable", "projection-required"] } });
const feature = object({ type: { type: "string", const: "Feature" }, id: count, geometry: { type: ["object", "null"], additionalProperties: true }, properties: { type: "object", additionalProperties: false } });
export const GEOMETRY_RESOURCE_SCHEMAS = {
  GeometryChoice: {
    ...object({ format: { type: "string", enum: ["wkt", "geojson", "wkb", "h3", "pair"] }, columns: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 2, uniqueItems: true }, epsg: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }),
    required: ["format", "columns"],
    description: "One exact source column, or two distinct numeric or text-typed coordinate columns in x/y order for pair. Numeric text is read tolerantly per row on preview, first set, change and URL replay. Non-null unreadable pairs keep null geometry and are counted; either missing member is a missing input. H3 and GeoJSON forbid epsg. Omission honors declared/inherent CRS, otherwise assumes WGS84. An explicit EPSG is a user declaration; a differing existing declaration refuses. The first projection correction on native/consumed assumed geometry names the stored geometry column and its historical format (wkb without one), with epsg. No further correction is available without retained source values.",
    if: { properties: { format: { const: "pair" } } },
    then: { properties: { columns: { minItems: 2, maxItems: 2 } } },
    else: { properties: { columns: { minItems: 1, maxItems: 1 } } },
    not: { properties: { format: { enum: ["h3", "geojson"] } }, required: ["epsg"] },
  },
  GeometryRequest: object({ expectedRevision: revision, choice: ref("GeometryChoice") }),
  GeometryIssue: object({ code: { type: "string", enum: ["projection_required", "unsupported_projection", "h3_unavailable", "unknown_crs", "conflicting_crs", "source_unavailable"] }, message: { type: "string" } }),
  GeometryInspection: object({ tableId: { type: "string" }, revision, columns: columnList, geometryColumn: { type: ["string", "null"] }, geometryRecord: nullable("GeometryRecord"), currentChoice: { ...nullable("GeometryChoice"), description: "A replayable retained choice, including reconstructable automatic recognition; null for a historical consumed source. Its presence alone does not mean a manual override is stored." }, mode, candidates: { type: "array", items: ref("GeometryCandidate") } }),
  GeometryPreview: object({ tableId: { type: "string" }, revision, choice: ref("GeometryChoice"), canApply: { type: "boolean" }, issues: { type: "array", items: ref("GeometryIssue") }, rowCount: { ...count, maximum: INSPECT_PREVIEW_ROWS, description: "Number of sampled rows, the first 50 source rows at most; not the dataset total." }, unreadableCount: { ...count, description: "Unreadable inputs in the first 50 sampled rows, excluding missing values." }, geometryType: { type: ["string", "null"], description: "Geometry class in the first 50 sampled rows." }, extent: { ...extent, description: "WGS84 bounds of the first 50 sampled rows before map simplification; null without placeable nonempty sample geometry." }, degreeCompatible: { type: ["boolean", "null"], description: "The first 50 sampled rows' decoded nonempty source coordinates before transformation: true if every row fits degrees, false if any does not, null when none has coordinates." }, sample: object({ rows: { type: "array", items: row, maxItems: INSPECT_PREVIEW_ROWS }, features: object({ type: { type: "string", const: "FeatureCollection" }, features: { type: "array", items: feature, maxItems: INSPECT_PREVIEW_ROWS } }) }) }),
  GeometryMutation: object({ table: ref("Table"), revision, currentChoice: nullable("GeometryChoice"), mode, extent }),
  GeometryProjection: object({ epsg: { type: "integer", minimum: 1 }, name: { type: "string" }, unit: { type: ["string", "null"], enum: ["degrees", "metres", null] } }),
  GeometryProjections: object({ projections: { type: "array", items: ref("GeometryProjection") }, resolved: nullable("GeometryProjection") }),
};
