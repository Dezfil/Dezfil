import {
  isAggregated,
  isOdViz,
  isTimeBound,
  AGG_VALUE,
  AGG_COUNT,
  AGG_ELEV,
  type LayerFilter,
  type LayerViz,
  type Aggregate,
  type OdViz,
} from "@/lib/viz";
import type { OdEndpoint } from "@/lib/od";

/**
 * The one compilation rule: a layer's effective query is its SQL, refined by
 * its filters, then aggregated by its visualization type. Every consumer —
 * rendering, classification, field stats, publishing — composes the query
 * here and nowhere else, so filters and aggregation cannot mean different
 * things on different paths. Filter values are data: they reach SQL only
 * through the escaping in this module.
 *
 * Aggregated results expose exactly three columns: the aggregate `value`,
 * the feature `count`, and the cell `geometry` (a polygon).
 */

function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function stringLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function numberLiteral(n: number): string {
  if (!Number.isFinite(n)) throw new Error("filter bound must be finite");
  return String(n);
}

/**
 * User SQL made safe for a `(…) AS q` wrapper: a single lexical pass —
 * string literals (with `''` doubling and `e'…'` backslash escapes),
 * quoted identifiers, dollar-quoted literals, nested block comments, and
 * line comments — finds where code ends, so trailing line comments and
 * whitespace are cut without ever touching data; then the trailing
 * semicolon the guard accepts is stripped, including one a comment was
 * hiding. If the text ends inside an unterminated construct, bail to the
 * plain semicolon rule — never edit what cannot be read. SQL that is valid
 * on its own stays valid inside every wrapper, and an editor's
 * comment-toggle cannot break an evaluation.
 */
export function wrappable(sql: string): string {
  const n = sql.length;
  let lastCode = -1;
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      if (nl === -1) break; // trailing line comment runs to the end
      i = nl + 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      // Block comments nest, per the Postgres family. Comments are trivia,
      // not code: one at the tail is cut with the tail (it must not hide a
      // trailing semicolon), while an interior one survives because code
      // follows it.
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth > 0) return sql.replace(/;\s*$/, "");
      continue;
    }
    if (ch === "'") {
      const escapes =
        /[eE]/.test(sql[i - 1] ?? "") && !/[A-Za-z0-9_$]/.test(sql[i - 2] ?? "");
      i++;
      let closed = false;
      while (i < n) {
        if (escapes && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        i++;
      }
      if (!closed) return sql.replace(/;\s*$/, "");
      lastCode = i - 1;
      continue;
    }
    if (ch === '"') {
      i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        i++;
      }
      if (!closed) return sql.replace(/;\s*$/, "");
      lastCode = i - 1;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        if (close === -1) return sql.replace(/;\s*$/, "");
        i = close + tag[0].length;
        lastCode = i - 1;
        continue;
      }
    }
    if (!/\s/.test(ch)) lastCode = i;
    i++;
  }
  return sql.slice(0, lastCode + 1).replace(/;\s*$/, "");
}

function timeLiteral(s: string): string {
  if (!isTimeBound(s)) throw new Error("time filter bound must be ISO-8601");
  return `${stringLiteral(s)}::TIMESTAMP`;
}

function filterClause(f: LayerFilter): string {
  if (f.kind === "range") {
    const parts: string[] = [];
    if (f.min !== null) parts.push(`${ident(f.field)} >= ${numberLiteral(f.min)}`);
    if (f.max !== null) parts.push(`${ident(f.field)} <= ${numberLiteral(f.max)}`);
    // Both bounds open: the filter exists but excludes nothing.
    return parts.length ? parts.join(" AND ") : "TRUE";
  }
  if (f.kind === "timerange") {
    // The cast keeps DATE and TIMESTAMP columns comparing in the time
    // domain regardless of the column's precision.
    const col = `CAST(${ident(f.field)} AS TIMESTAMP)`;
    const parts: string[] = [];
    if (f.min !== null) parts.push(`${col} >= ${timeLiteral(f.min)}`);
    if (f.max !== null) parts.push(`${col} <= ${timeLiteral(f.max)}`);
    return parts.length ? parts.join(" AND ") : "TRUE";
  }
  // Value set. Membership: an empty selection matches nothing (everything
  // deselected). Exclusion (category deactivation): an empty set excludes
  // nothing; a NOT IN drops NULL rows exactly as SQL decides — the client
  // GPU mirror matches this row for row.
  if (f.exclude) {
    if (f.values.length === 0) return "TRUE";
    const list = f.values.map(stringLiteral).join(", ");
    return `CAST(${ident(f.field)} AS VARCHAR) NOT IN (${list})`;
  }
  if (f.values.length === 0) return "FALSE";
  const list = f.values.map(stringLiteral).join(", ");
  return `CAST(${ident(f.field)} AS VARCHAR) IN (${list})`;
}

/** The layer's SQL refined by its filters; without filters, the SQL itself. */
export function filteredSql(sql: string, filters: LayerFilter[]): string {
  const base = wrappable(sql);
  if (filters.length === 0) return base;
  const where = filters.map((f) => `(${filterClause(f)})`).join(" AND ");
  return `SELECT * FROM (${base}) AS filtered WHERE ${where}`;
}

function aggregateExpression(aggregate: Aggregate): string {
  if (aggregate.fn === "count") return "count(*)";
  // The value feeds a numeric ramp; the cast makes non-numeric attributes
  // fail with the engine's own message instead of odd typing.
  return `${aggregate.fn}(${ident(aggregate.attribute)}::DOUBLE)`;
}

/** The optional elevation column: a second aggregate the cells
 * expose for extrusion, reserved and tooltip-hidden. */
function elevationColumn(elevation: Aggregate | undefined): string {
  if (!elevation) return "";
  return `${aggregateExpression(elevation)} AS ${ident(AGG_ELEV)},\n       `;
}

function hexbinSql(
  source: string,
  geom: string,
  cellKm: number,
  aggregate: Aggregate,
  elevation?: Aggregate,
): string {
  // Pointy-top hexagons of edge length `cellKm` tessellating the
  // web-mercator plane — the same math as lib/hex-bin, so the
  // slider-preview worker and this query assign identical cells. Fractional
  // axial coordinates are cube-rounded to the containing cell; the cell
  // polygon is rebuilt from its center at micrometer precision.
  const edge = numberLiteral(cellKm * 1000); // hex edge (circumradius), m
  const sqrt3 = "sqrt(3)";
  const half = `(${edge} / 2)`; // vertex y-offset at ±30°
  const width = `(${sqrt3} * ${edge} / 2)`; // vertex x-offset (inradius)
  const wkt = `printf('POLYGON ((%.6f %.6f, %.6f %.6f, %.6f %.6f, %.6f %.6f, %.6f %.6f, %.6f %.6f, %.6f %.6f))',
         "__cx", "__cy" + ${edge},
         "__cx" + ${width}, "__cy" + ${half},
         "__cx" + ${width}, "__cy" - ${half},
         "__cx", "__cy" - ${edge},
         "__cx" - ${width}, "__cy" - ${half},
         "__cx" - ${width}, "__cy" + ${half},
         "__cx", "__cy" + ${edge})`;
  return `SELECT ${aggregateExpression(aggregate)} AS ${ident(AGG_VALUE)},
       count(*) AS ${ident(AGG_COUNT)},
       ${elevationColumn(elevation)}ST_Transform(ST_GeomFromText(${wkt}), 'EPSG:3857', 'EPSG:4326', true) AS "geometry"
FROM (
  SELECT ${sqrt3} * ${edge} * ("__q" + "__r" / 2) AS "__cx",
         1.5 * ${edge} * "__r" AS "__cy", *
  FROM (
    SELECT CASE WHEN "__dq" > "__dy" AND "__dq" > "__dr" THEN -"__ry" - "__rr" ELSE "__rq" END AS "__q",
           CASE WHEN ("__dq" > "__dy" AND "__dq" > "__dr") OR "__dy" > "__dr" THEN "__rr" ELSE -"__rq" - "__ry" END AS "__r", *
    FROM (
      SELECT abs("__rq" - "__fq") AS "__dq",
             abs("__ry" - (-"__fq" - "__fr")) AS "__dy",
             abs("__rr" - "__fr") AS "__dr", *
      FROM (
        SELECT round("__fq") AS "__rq",
               round(-"__fq" - "__fr") AS "__ry",
               round("__fr") AS "__rr", *
        FROM (
          SELECT (${sqrt3} / 3 * ST_X("__m") - ST_Y("__m") / 3) / ${edge} AS "__fq",
                 (2.0 / 3 * ST_Y("__m")) / ${edge} AS "__fr", *
          FROM (
            SELECT ST_Transform(${geom}, 'EPSG:4326', 'EPSG:3857', true) AS "__m", *
            FROM (${source}) AS "__pts"
            WHERE ${geom} IS NOT NULL AND ST_GeometryType(${geom}) = 'POINT'
          ) AS "__proj"
        ) AS "__frac"
      ) AS "__round"
    ) AS "__delta"
  ) AS "__axial"
) AS "__binned"
GROUP BY "__cx", "__cy"`;
}

function gridSql(
  source: string,
  geom: string,
  cellKm: number,
  aggregate: Aggregate,
  elevation?: Aggregate,
): string {
  const size = numberLiteral(cellKm * 1000); // web-mercator meters
  return `SELECT ${aggregateExpression(aggregate)} AS ${ident(AGG_VALUE)},
       count(*) AS ${ident(AGG_COUNT)},
       ${elevationColumn(elevation)}ST_Transform(ST_MakeEnvelope("__x0", "__y0", "__x0" + ${size}, "__y0" + ${size}),
                    'EPSG:3857', 'EPSG:4326', true) AS "geometry"
FROM (
  SELECT floor(ST_X("__m") / ${size}) * ${size} AS "__x0",
         floor(ST_Y("__m") / ${size}) * ${size} AS "__y0", *
  FROM (
    SELECT ST_Transform(${geom}, 'EPSG:4326', 'EPSG:3857', true) AS "__m", *
    FROM (${source}) AS "__pts"
    WHERE ${geom} IS NOT NULL AND ST_GeometryType(${geom}) = 'POINT'
  ) AS "__proj"
) AS "__grid"
GROUP BY "__x0", "__y0"`;
}

/** The reserved geometry column an O→D result exposes: the
 * origin→destination pair as a two-point line, first in the SELECT so the
 * render path's first-geometry rule always finds it. */
export const OD_GEOMETRY = "__od";

function endpointExpression(endpoint: OdEndpoint): string {
  if (endpoint.kind === "geometry") return ident(endpoint.field);
  // ST_Point takes x (longitude) then y (latitude); the cast surfaces a
  // non-numeric mapping as the engine's own message.
  return `ST_Point(${ident(endpoint.lon)}::DOUBLE, ${ident(endpoint.lat)}::DOUBLE)`;
}

function endpointPresent(endpoint: OdEndpoint): string {
  if (endpoint.kind === "geometry") return `${ident(endpoint.field)} IS NOT NULL`;
  return `${ident(endpoint.lon)} IS NOT NULL AND ${ident(endpoint.lat)} IS NOT NULL`;
}

/**
 * The O→D result for EXPORT: the same two-point line, but no column
 * leaves — mapped geometry endpoints stay in the result, because a data
 * export that silently drops the origin and destination columns loses
 * exactly what the spec forbids losing. The render path keeps `odSql`
 * (one geometry for downstream); the export's multi-geometry rule
 * serializes the extra geometry columns to WKT.
 */
export function odExportSql(source: string, viz: OdViz): string {
  if (!viz.origin || !viz.dest) {
    throw new Error(
      "Choose the origin and destination fields for this visualization.",
    );
  }
  return `SELECT ST_MakeLine(${endpointExpression(viz.origin)}, ${endpointExpression(viz.dest)}) AS ${ident(OD_GEOMETRY)}, *
FROM (${source}) AS "__pts"
WHERE ${endpointPresent(viz.origin)} AND ${endpointPresent(viz.dest)}`;
}

function odSql(source: string, viz: OdViz): string {
  if (!viz.origin || !viz.dest) {
    throw new Error(
      "Choose the origin and destination fields for this visualization.",
    );
  }
  // Mapped geometry endpoints leave the result so downstream consumers see
  // one geometry; other columns pass through for styling and tooltips.
  const excluded = [viz.origin, viz.dest]
    .filter((e): e is OdEndpoint & { kind: "geometry" } => e.kind === "geometry")
    .map((e) => ident(e.field));
  const exclude = excluded.length ? ` EXCLUDE (${excluded.join(", ")})` : "";
  return `SELECT ST_MakeLine(${endpointExpression(viz.origin)}, ${endpointExpression(viz.dest)}) AS ${ident(OD_GEOMETRY)}, *${exclude}
FROM (${source}) AS "__pts"
WHERE ${endpointPresent(viz.origin)} AND ${endpointPresent(viz.dest)}`;
}

export interface CompileInput {
  sql: string;
  filters: LayerFilter[];
  viz: LayerViz;
}

/**
 * The effective query for a layer. `geometryColumn` is the geometry column
 * of the layer's own result; aggregation needs it to bin, other types ignore
 * it. Points and heatmap render the (filtered) rows themselves.
 */
export function effectiveSql(
  input: CompileInput,
  geometryColumn: string | null,
): string {
  const filtered = filteredSql(input.sql, input.filters);
  if (isOdViz(input.viz)) return odSql(filtered, input.viz);
  if (!isAggregated(input.viz)) return filtered;
  if (!geometryColumn) {
    throw new Error("aggregation requires the layer's geometry column");
  }
  const geom = ident(geometryColumn);
  return input.viz.type === "hexbin"
    ? hexbinSql(
        filtered,
        geom,
        input.viz.cellKm,
        input.viz.aggregate,
        input.viz.elevation?.aggregate,
      )
    : gridSql(
        filtered,
        geom,
        input.viz.cellKm,
        input.viz.aggregate,
        input.viz.elevation?.aggregate,
      );
}
