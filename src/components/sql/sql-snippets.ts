import { identifierFor } from "./sql-draft";

/**
 * Snippets: five editable starting points for the spatial queries people
 * actually write. The selected table fills every role it can — its name,
 * its geometry column — and anything else a snippet needs stays an
 * explicit placeholder in angle brackets. They never run on insertion.
 */

export interface Snippet {
  id: string;
  name: string;
  description: string;
  /** Template: {table} and {geom} are filled; <…> stays a placeholder. */
  template: string;
}

export const SNIPPETS: readonly Snippet[] = [
  {
    id: "within",
    name: "Within a distance",
    description: "rows of {table} near a point",
    template:
      "-- 0.005 degrees is about 500 m at Berlin's latitude; change the point and the distance\n" +
      "SELECT *\nFROM {table}\nWHERE ST_DWithin({geom}, ST_Point(13.405, 52.520), 0.005);",
  },
  {
    id: "points-in-polygons",
    name: "Points in polygons",
    description: "spatial join of {table} onto an areas table",
    template:
      "SELECT p.*, a.name AS area\nFROM {table} p\nJOIN <areas_table> a ON ST_Within(p.{geom}, a.<areas_geometry>);",
  },
  {
    id: "count-by-area",
    name: "Count by area",
    description: "how many of {table} per area",
    template:
      "SELECT a.name, count(*) AS n\nFROM <areas_table> a\nJOIN {table} p ON ST_Within(p.{geom}, a.<areas_geometry>)\nGROUP BY a.name\nORDER BY n DESC;",
  },
  {
    id: "buffer",
    name: "Buffer",
    description: "a ring around every row of {table}",
    template:
      "-- 0.002 degrees is about 200 m at Berlin's latitude\n" +
      "SELECT * EXCLUDE ({geom}), ST_Buffer({geom}, 0.002) AS {geom}\nFROM {table};",
  },
  {
    id: "centroids",
    name: "Centroids",
    description: "one point per shape of {table}",
    template:
      "SELECT * EXCLUDE ({geom}), ST_Centroid({geom}) AS {geom}\nFROM {table};",
  },
];

/** The bounded function list completion offers: at least every function
 * the snippets use, plus the common spatial neighbours. */
export const SPATIAL_FUNCTIONS: readonly string[] = [
  "ST_DWithin",
  "ST_Point",
  "ST_Within",
  "ST_Buffer",
  "ST_Centroid",
  "ST_Area",
  "ST_Length",
  "ST_Distance",
  "ST_Intersects",
  "ST_Contains",
  "ST_Intersection",
  "ST_Union_Agg",
  "ST_X",
  "ST_Y",
  "ST_AsText",
  "ST_GeomFromText",
  "ST_Transform",
  "ST_Simplify",
  "ST_Envelope",
  "ST_ConvexHull",
  "ST_MakeLine",
  "ST_Collect",
  "ST_NPoints",
  "ST_IsValid",
];

export interface SnippetContext {
  table: string | null;
  geometryColumn: string | null;
}

/** Fill a template: the selected table and its geometry column, each
 * quoted when it needs to be — or, when either is unknown (no table, a
 * non-spatial table), an explicit angle-bracket placeholder that reads as
 * "replace me" rather than as a column that happens not to exist. */
export function renderSnippet(snippet: Snippet, ctx: SnippetContext): string {
  const table = ctx.table ? identifierFor(ctx.table) : "<your_table>";
  const geom = ctx.geometryColumn
    ? identifierFor(ctx.geometryColumn)
    : "<geometry_column>";
  return snippet.template.split("{table}").join(table).split("{geom}").join(geom);
}

export function describeSnippet(snippet: Snippet, ctx: SnippetContext): string {
  return snippet.description.split("{table}").join(ctx.table ?? "a table");
}
