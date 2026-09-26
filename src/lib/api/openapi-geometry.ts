/** CSV upload contract. Prose is independently pinned against ingest. */
export const CSV_GEOMETRY_DESCRIPTION =
  "CSV geometry recognition uses names first, in order: a " +
  "text column named wkt/geometry/geom is parsed as WKT; " +
  "lon/lat, lng/lat, long/lat, or longitude/latitude pairs " +
  "become point geometry when each member is numeric or contains " +
  "no non-blank values; when a member qualifies only by being " +
  "blank, a numeric prefixed pair takes precedence. Empty and " +
  "quoted-empty fields are blank; whitespace-only text is not. " +
  "A row missing either member has null geometry. A prefixed pair " +
  "(origin_lon/origin_lat, pickup_longitude/…) becomes the point when " +
  "it is the origin pair or the only one. Safe prefixed x/y retains " +
  "that name priority; bare x/y and easting/northing are weak candidates. " +
  "Unsafe names yield to the next eligible name, then to content. " +
  "A named WKT column with sampled non-null values but none readable " +
  "stays weak with an unreadable reason and retains its source text; " +
  "a strong content reading of that same column may apply instead. " +
  "Content recognition samples the first 1,000 reader rows, excluding " +
  "NULLs from each format's denominator. WKT/EWKT, GeoJSON geometry objects " +
  "(not Features or FeatureCollections), WKB hex including EWKB SRIDs, " +
  "and validated H3 cells are supported. An H3 cell becomes its boundary " +
  "polygon; unavailable validation yields only an unvalidated weak hint. " +
  "A content column is strong only when every sampled non-null value " +
  "reads in that format, with at least one readable value. When some but " +
  "not all read, it is weak with its sampled count. Strong ties use source " +
  "column order. Content numeric pairs are always weak; unnamed pairs need " +
  "at least 50% of complete sampled rows in a possible degree orientation, " +
  "and ambiguous axes remain marked. The chosen mapping is checked over " +
  "the entire input for finite longitude/x in [-180,180] and latitude/y " +
  "in [-90,90], including every geometry vertex and values after the sample. " +
  "A consistent declared CRS is reprojected to WGS84 under the file-ingest " +
  "contract; conflicting declarations and untransformable SRIDs stay weak " +
  "with reasons. Unknown declarations never become a WGS84 assumption. " +
  "Undeclared degree-compatible WKT/WKB and eligible named pairs assume " +
  "WGS84; GeoJSON and H3 are inherently WGS84 and declarations are not " +
  "assumptions. Selected unreadable non-null values keep their rows with " +
  "NULL geometry and a full-input unreadable count; missing inputs do not " +
  "increment that count. Content roads retain source columns and add a " +
  "distinct geometry column; named WKT keeps its replacement behavior. " +
  "The geometryCandidates evidence retains alternatives, source identities, " +
  "sample observations, axis roles, CRS and reasons. The geometryRecord " +
  "identifies the applied choice, source CRS stance and full unreadable " +
  "count, persisted for table inspection. Legacy records remain absent. " +
  "Without an eligible mapping the CSV lands as a plain table with all " +
  "source rows and columns and no CRS assumption. Local and URL CSV imports " +
  "share these rules; refresh replaces automatic evidence with its artifact " +
  "atomically, and failure keeps both old versions. " +
  "A CSV whose detected column names betray a broken read: a name " +
  "containing a comma (the header was never split), or most names numeric " +
  "or blank (the first data row was taken as the header) imports with " +
  "`headerSuspect: true`. The warning is advisory: it refuses nothing " +
  "and changes nothing about recognition.";

const columns = { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 };
const format = { type: "string", enum: ["wkt", "geojson", "wkb", "h3", "pair"] };
const signal = { type: "string", enum: ["name", "content"] };
const rule = { type: "string", enum: ["wkt-name", "exact-pair", "prefixed-pair", "content"] };
const crs = { $ref: "#/components/schemas/GeometryCrs" };

export const GEOMETRY_EVIDENCE_SCHEMAS = {
  GeometryCrs: {
    type: "object",
    properties: {
      stance: { type: "string", enum: ["assumed", "inherent", "declared", "unknown", "conflicting"] },
      srid: { type: ["integer", "null"], description: "Declared source SRID, or 4326 for inherent WGS84. Null when absent or unresolved." },
      label: { type: "string", description: "Source CRS short name for the record sentence; artifacts always hold WGS84 coordinates." },
    },
    required: ["stance", "srid", "label"],
  },
  GeometrySample: {
    type: "object",
    properties: {
      rows: { type: "integer", minimum: 0, maximum: 1000 },
      nonNull: { type: "integer", minimum: 0, description: "Non-NULL inputs, or complete pairs, in the sampled reader rows." },
      readable: { type: ["integer", "null"], minimum: 0, description: "Sampled readable inputs. Null when an optional validator is unavailable, never an invented zero." },
    },
    required: ["rows", "nonNull", "readable"],
  },
  GeometryCandidate: {
    type: "object",
    properties: {
      columns, format, signal, rule, crs,
      strength: { type: "string", enum: ["strong", "weak"] },
      sample: { $ref: "#/components/schemas/GeometrySample" },
      degreeCompatible: { type: ["boolean", "null"], description: "Whether retained source coordinates fit degree ranges: full-input evidence for decoded geometry and eligible name matches, sampled evidence for numeric hints. A declared projected source may be false while its transformed output safely applies. Null for unvalidated hints." },
      reasons: { type: "array", items: { type: "string" }, description: "Reasons preventing automatic use, including partial readability, unsafe placement, CRS conflicts, unavailable H3 or numeric/axis ambiguity." },
      orientations: {
        type: "array", description: "Possible longitude/x and latitude/y roles; two entries mean ambiguous axes.",
        items: { type: "object", properties: { lon: { type: "string" }, lat: { type: "string" } }, required: ["lon", "lat"] },
      },
      applied: { type: "boolean" },
      sourceRetained: { type: "boolean", description: "False when a selected named-WKT source was replaced. Its original name is historical evidence, not a selectable stored column." },
    },
    required: ["columns", "format", "signal", "rule", "crs", "strength", "sample", "degreeCompatible", "reasons", "applied", "sourceRetained"],
  },
  GeometryRecord: {
    type: "object",
    properties: {
      columns, format, crs,
      signal: { type: "string", enum: ["name", "content", "manual"] },
      rule: { type: "string", enum: ["wkt-name", "exact-pair", "prefixed-pair", "content", "manual"] },
      unreadableCount: { type: "integer", minimum: 0, description: "Unreadable non-NULL selected inputs over the full input, not the recognition sample. Missing pair members are not unreadable." },
    },
    required: ["columns", "format", "signal", "rule", "crs", "unreadableCount"],
  },
};
