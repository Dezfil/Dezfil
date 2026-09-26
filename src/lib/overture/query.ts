import type { Bbox } from "@/lib/bbox";
import { OVERTURE_THEMES, type OvertureTheme } from "./catalogue";
import { OVERTURE_S3_BASE } from "./releases";

/**
 * Pure query shaping for Overture imports — shared by the server importer,
 * the count preview, and the pane's read-only dev-mode display, so what the
 * user sees is what runs.
 *
 * Spatial filtering is two layers: a bbox-column prefilter that lets DuckDB
 * prune remote row groups, and an exact geometry predicate on top. Under
 * `within` the prefilter demands the feature's bbox be inside the area's —
 * which alone eliminates the world-spanning-bbox false positives.
 */

function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** The read expression for a theme at a release (paths joined for DuckDB). */
export function overtureReadExpr(
  theme: OvertureTheme,
  release: string,
): string {
  const paths = OVERTURE_THEMES[theme].paths.map((p) =>
    lit(`${OVERTURE_S3_BASE}/${release}/${p}/*`),
  );
  const union =
    OVERTURE_THEMES[theme].paths.length > 1 ? ", union_by_name=1" : "";
  return `read_parquet([${paths.join(", ")}], hive_partitioning=1${union})`;
}

/** How a drawn or resolved area applies: `within` keeps only
 * features entirely inside; `intersect` also keeps edge-crossers. */
export type AreaSemantics = "within" | "intersect";

export function isAreaSemantics(value: unknown): value is AreaSemantics {
  return value === "within" || value === "intersect";
}

/** Line networks and land/water masses are larger than any sensible drawn
 * area, so they default to intersect (decided). */
export function defaultSemantics(theme: OvertureTheme): AreaSemantics {
  return theme === "transportation" || theme === "base"
    ? "intersect"
    : "within";
}

/** A polygon ring as [lng, lat] pairs; closed automatically. */
export type Ring = [number, number][];

export function isRing(value: unknown): value is Ring {
  return (
    Array.isArray(value) &&
    value.length >= 3 &&
    value.every(
      (p) =>
        Array.isArray(p) &&
        p.length === 2 &&
        p.every((n) => typeof n === "number" && Number.isFinite(n)) &&
        p[0] >= -180 &&
        p[0] <= 180 &&
        p[1] >= -90 &&
        p[1] <= 90,
    )
  );
}

export function ringBbox(ring: Ring): Bbox {
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity;
  for (const [lng, lat] of ring) {
    w = Math.min(w, lng);
    s = Math.min(s, lat);
    e = Math.max(e, lng);
    n = Math.max(n, lat);
  }
  return [w, s, e, n];
}

export function ringWkt(ring: Ring): string {
  const closed =
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
      ? ring
      : [...ring, ring[0]];
  return `POLYGON((${closed.map(([lng, lat]) => `${lng} ${lat}`).join(", ")}))`;
}

/**
 * A resolved scope — geometry work already done by the caller:
 * - country/region: attribute filters (divisions only; exact and cheap)
 * - bbox: a drawn rectangle
 * - shape: any polygon — a drawn ring or a fetched division boundary
 */
export type ResolvedScope =
  | { kind: "country"; code: string }
  | { kind: "region"; code: string }
  | { kind: "bbox"; bbox: Bbox }
  | { kind: "shape"; wkt: string; bbox: Bbox };

export interface OvertureSelection {
  theme: OvertureTheme;
  release: string;
  scope: ResolvedScope;
  /** Applies to geometric scopes; defaulted per theme. */
  semantics: AreaSemantics;
  /** Divisions only: the Overture subtype to import. */
  level?: string;
  /** Places only: category filter. */
  category?: string;
}

function bboxPrefilter(area: Bbox, semantics: AreaSemantics): string {
  const [w, s, e, n] = area;
  if (semantics === "within") {
    return `bbox.xmin >= ${w} AND bbox.xmax <= ${e} AND bbox.ymin >= ${s} AND bbox.ymax <= ${n}`;
  }
  return `bbox.xmin <= ${e} AND bbox.xmax >= ${w} AND bbox.ymin <= ${n} AND bbox.ymax >= ${s}`;
}

function exactPredicate(shapeExpr: string, semantics: AreaSemantics): string {
  const fn = semantics === "within" ? "ST_Within" : "ST_Intersects";
  return `${fn}(geometry, ${shapeExpr})`;
}

/** The WHERE clauses for a selection (exported for the count preview —
 * counting and importing must share one filter). */
export function overtureWhereClauses(selection: OvertureSelection): string[] {
  const { theme, scope, semantics } = selection;
  const where: string[] = [];

  if (scope.kind === "country" || scope.kind === "region") {
    if (theme !== "divisions") {
      throw new Error(
        "Country and state scopes resolve to boundary polygons for this theme.",
      );
    }
    where.push(
      scope.kind === "country"
        ? `country = ${lit(scope.code)}`
        : `region = ${lit(scope.code)}`,
    );
  } else if (scope.kind === "bbox") {
    const [w, s, e, n] = scope.bbox;
    where.push(bboxPrefilter(scope.bbox, semantics));
    where.push(
      exactPredicate(`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n})`, semantics),
    );
  } else {
    where.push(bboxPrefilter(scope.bbox, semantics));
    where.push(exactPredicate(`ST_GeomFromText(${lit(scope.wkt)})`, semantics));
  }

  if (theme === "divisions") {
    // Maritime duplicates are noise for boundary work.
    where.push(`coalesce(class, 'land') = 'land'`);
    if (selection.level) where.push(`subtype = ${lit(selection.level)}`);
  }
  if (selection.category && OVERTURE_THEMES[theme].categoryFilter) {
    where.push(`categories."primary" = ${lit(selection.category)}`);
  }
  return where;
}

function promotedColumns(theme: OvertureTheme, presentColumns: string[]): string {
  const promoted: string[] = [];
  if (presentColumns.includes("names") && !presentColumns.includes("name")) {
    promoted.push(`names."primary" AS name`);
  }
  if (
    presentColumns.includes("categories") &&
    !presentColumns.includes("category")
  ) {
    promoted.push(`categories."primary" AS category`);
  }
  return promoted.length > 0 ? `${promoted.join(", ")}, *` : "*";
}

/** The import SELECT for a selection: promoted plain columns (only when the
 * release's schema carries their structs — drift-safe) over the shared
 * WHERE clauses. */
export function buildOvertureQuery(
  selection: OvertureSelection,
  presentColumns: string[],
): string {
  const read = overtureReadExpr(selection.theme, selection.release);
  const select = promotedColumns(selection.theme, presentColumns);
  const where = overtureWhereClauses(selection);
  return `SELECT ${select} FROM ${read} WHERE ${where.join(" AND ")}`;
}

/** The matching COUNT — the preview must count exactly what the import
 * would land. */
export function buildOvertureCount(selection: OvertureSelection): string {
  const read = overtureReadExpr(selection.theme, selection.release);
  const where = overtureWhereClauses(selection);
  return `SELECT count(*) AS n FROM ${read} WHERE ${where.join(" AND ")}`;
}

/** The Run Query preview: the same filters the import
 * would run, returning geometry for the dialog map. One row over the cap
 * is requested so truncation is a fact, not a guess. */
export function buildOverturePreview(
  selection: OvertureSelection,
  cap: number,
): string {
  const read = overtureReadExpr(selection.theme, selection.release);
  const where = overtureWhereClauses(selection);
  return `SELECT ST_AsGeoJSON(geometry) AS geometry FROM ${read} WHERE ${where.join(" AND ")} LIMIT ${cap + 1}`;
}

/** Scoped per-level counts for the divisions theme: one grouped
 * query answers every level at once, sharing the import's filters minus the
 * level itself, with up to three sample names per level. */
export function buildOvertureLevelCounts(selection: OvertureSelection): string {
  if (selection.theme !== "divisions") {
    throw new Error("Level counts apply to the divisions theme only.");
  }
  const unleveled = { ...selection };
  delete unleveled.level;
  const read = overtureReadExpr(selection.theme, selection.release);
  const where = overtureWhereClauses(unleveled);
  return (
    `SELECT subtype, count(*) AS n, ` +
    `list_slice(list(names."primary") FILTER (names."primary" IS NOT NULL), 1, 3) AS samples ` +
    `FROM ${read} WHERE ${where.join(" AND ")} GROUP BY subtype`
  );
}

/** The bbox-recipe form: a drawn rectangle with intersect semantics —
 * its historical meaning, minus the world-spanning-bbox false positives.
 * Stored recipes refresh through this shape unchanged. */
export function buildOvertureSelect(
  theme: OvertureTheme,
  release: string,
  bbox: Bbox,
  presentColumns: string[],
  category?: string,
): string {
  return buildOvertureQuery(
    {
      theme,
      release,
      scope: { kind: "bbox", bbox },
      semantics: "intersect",
      ...(category ? { category } : {}),
    },
    presentColumns,
  );
}
