import { tableRef } from "./input-ref";
import { ident } from "@/lib/ingest/ingest";
import type { DataTable } from "@/lib/metadata/tables";
import type { MeasurementCrs } from "./measurement";
import { STORED_CRS, intoMeasurement } from "./measurement";

/**
 * The statistics verbs: H3 cell assignment, Getis-Ord Gi\* hotspots, and
 * single-link clustering at a distance threshold.
 *
 * **H3 assigns cells latitude-first.** Every call here passes latitude before
 * longitude, which is the opposite of the coordinate order everything else in
 * this codebase uses. It is the hazard found in the transform strategy,
 * inherited into this family, and the reason `statistics-verbs.test.ts` pins a
 * published cell id and asserts the transposed call gives a different one.
 *
 * **Nothing here resolves its own projection.** The one verb that measures is
 * handed the CRS the compiler resolved, exactly as the metric verbs are.
 */

/** The column names these verbs add. Named here so admission can refuse a
 * collision with the input's own columns before a job exists. */
export const H3_CELL_COLUMN = "h3_cell";
export const HOTSPOT_COLUMNS = ["h3_cell", "value", "gi_star", "neighbour_count"];
export const CLUSTER_COLUMNS = ["cluster_id", "cluster_size"];
/**
 * The scratch columns clustering carries through its own CTEs.
 *
 * They never reach the output — the final select excludes them — but they
 * travel beside the input's columns on the way, and `SELECT *` keeps an
 * input column of the same name while the engine renames *ours*. The next CTE
 * then reads the user's column as a point and fails on a binder error. Refused
 * at admission instead, with the output columns. Found at the cross-model
 * review.
 */
export const CLUSTER_HELPER_COLUMNS = [
  "__dezfil_pt",
  "__dezfil_x",
  "__dezfil_y",
  "__dezfil_id",
  "__dezfil_bx",
  "__dezfil_by",
];

/** H3's own resolution range. Outside it the engine answers null rather than
 * failing, so admission has to know the range itself. */
export const MIN_RESOLUTION = 0;
export const MAX_RESOLUTION = 15;

/** How far a hotspot's neighbourhood may reach. A product judgment, not a
 * measured bound (spec G5): past ten rings "neighbourhood" has stopped being
 * a true description of what is being compared. */
export const MAX_NEIGHBOURS = 10;

/**
 * The largest input clustering accepts (spec G5).
 *
 * **Measured against this generator on the hardened instance**, which is not
 * the same thing as measured against the algorithm. Two shapes decide it: a
 * single chain, which is what a GPS trace is and which stresses the
 * recursion's depth; and points concentrated into a handful of buckets, which
 * stresses the pair-wise work the buckets exist to avoid. The chain is
 * comfortable well past this number. The concentrated case is not: at 10,000
 * rows it takes 1.6 s and at 20,000 it exhausts the instance's whole memory
 * budget, and no interpolation between those is honest.
 *
 * So the bound is the concentrated case's last good size, proven at exactly
 * this number by `statistics-clustering.test.ts`. Above it the run is refused
 * with a number and a next step, which is the point of G5.
 */
export const MAX_CLUSTER_ROWS = 10_000;

/** The representative point of a feature: a point is itself, and anything else
 * is its centroid — which for a concave shape can lie outside the shape, which
 * is why the catalog says "the cell of the centroid". */
function representativePoint(geom: string): string {
  return `ST_Centroid(${geom})`;
}

/** The H3 cell of a geometry, or null where there is nothing to assign. */
function cellOf(geom: string, resolution: number): string {
  const point = representativePoint(geom);
  // Latitude first. Both guards matter: a null geometry has no centroid, and
  // an empty one has a centroid whose coordinates are NaN, which H3 answers
  // for rather than refusing.
  return (
    `CASE WHEN ${geom} IS NULL OR ST_IsEmpty(${geom}) THEN NULL ` +
    `ELSE h3_latlng_to_cell_string(ST_Y(${point}), ST_X(${point}), ${resolution}) END`
  );
}

/**
 * The cell's boundary as geometry in the stored CRS.
 *
 * H3 answers WKT in longitude/latitude order, which is the order the stored CRS
 * is in — so for all but a sliver of the world the text parses directly.
 *
 * **Except across the antimeridian, where a plain parse is not the cell.** A
 * cell straddling ±180° comes back with vertices on both sides of the seam, and
 * read as a planar polygon that is not a small hexagon near the meridian: it is
 * a shape stretching most of the way round the earth, whose fill would cover
 * every other layer on the map. Measured before the repair: the cell at 0°N
 * 179.999°E parsed to an extent from −179.998762 to 179.999305.
 *
 * So a cell that crosses is **split into the two polygons it really is**. The
 * rebuild goes through H3's own vertices rather than its WKT: every vertex with
 * a negative longitude moves east by 360°, which makes the ring continuous; the
 * continuous ring is then clipped against each side of the meridian and the far
 * half shifted back. Both halves are exact — the vertices where the cell meets
 * ±180° are computed by the intersection, not approximated — and the result
 * holds its own centre, which is the assertion that would fail if any step of
 * that were wrong.
 *
 * withheld the shape instead, which kept the map honest and gave a user in Fiji
 * no hexagons. The cheap span test is what keeps every other cell on the cheap
 * path: no H3 cell at any resolution is 180° wide, so a span that wide means one
 * thing.
 */
function boundaryOf(cell: string): string {
  const parsed = `ST_GeomFromText(h3_cell_to_boundary_wkt(${cell}))`;
  /**
   * Rebuilt from the cell's own vertices, made continuous across the seam,
   * then cut at the meridian and the eastern half brought back where it
   * belongs — **or null, when this is not a seam crossing at all.**
   *
   * A wide longitude span is not enough to identify one. A coarse cell near a
   * pole spans more than 180° legitimately: at resolution 0 a cell around 85°N
   * spans 180.3°, and unwrapping it produces a ring that is not a hexagon
   * anywhere and either throws or answers a shape that does not contain its own
   * centre — and one such row would abort the whole query. Found at the
   * cross-model review of this repair.
   *
   * The pair of spans separates them without ambiguity. Unwrapping a genuine
   * seam cell **collapses** it — 360° becomes 0.01° — while a polar cell stays
   * spread across the world: 324.9° at resolution 0. So the rebuild applies
   * only when the unwrapped ring is narrow, and everything else keeps the plain
   * parse, which is what shipped before this repair.
   */
  const split = `(
    WITH vertices AS (
      SELECT generate_subscripts(h3_cell_to_vertexes(${cell}), 1) AS i,
             h3_vertex_to_lng(unnest(h3_cell_to_vertexes(${cell}))) AS lng,
             h3_vertex_to_lat(unnest(h3_cell_to_vertexes(${cell}))) AS lat),
    moved AS (
      SELECT i, CASE WHEN lng < 0 THEN lng + 360 ELSE lng END AS lng, lat
      FROM vertices),
    continuous AS (
      SELECT max(lng) - min(lng) AS span,
             list(ST_Point(lng, lat) ORDER BY i) AS ring,
             first(ST_Point(lng, lat) ORDER BY i) AS head
      FROM moved),
    whole AS (
      SELECT ST_MakePolygon(ST_MakeLine(ring || [head])) AS g
      FROM continuous WHERE span < 180)
    SELECT ST_Union(
      ST_Intersection(g, ST_MakeEnvelope(-180, -90, 180, 90)),
      ST_Translate(ST_Intersection(g, ST_MakeEnvelope(180, -90, 540, 90)), -360, 0))
    FROM whole)`;
  return (
    `ST_SetCRS(CASE WHEN ST_XMax(${parsed}) - ST_XMin(${parsed}) > 180 ` +
    `THEN COALESCE(${split}, ${parsed}) ELSE ${parsed} END, '${STORED_CRS}')`
  );
}

/**
 * Assign each feature the H3 cell of its representative point.
 *
 * One row in, one row out — including rows with no usable geometry, which keep
 * their place and get no cell. Redrawing is opt-in: by default the input's own
 * geometry passes through untouched.
 */
export function h3CellSql(
  table: DataTable,
  resolution: number,
  boundary: boolean,
): string {
  const source = tableRef(table);
  const geom = table.geometryColumn ? ident(table.geometryColumn) : null;
  if (!geom) {
    // Admission refuses this, but a generator that would silently produce a
    // column of nulls is worse than one that cannot be called.
    throw new Error("h3CellSql needs a geometry column");
  }
  const cell = cellOf(geom, resolution);
  if (!boundary) {
    return `SELECT *, ${cell} AS ${ident(H3_CELL_COLUMN)} FROM ${source}`;
  }
  // Redrawn: the cell's boundary replaces the input's geometry, and a row with
  // no cell has no shape to draw rather than its old one under a new name.
  return (
    `SELECT * REPLACE (CASE WHEN ${cell} IS NULL THEN NULL ` +
    `ELSE ${boundaryOf(cell)} END AS ${geom}), ` +
    `${cell} AS ${ident(H3_CELL_COLUMN)} FROM ${source}`
  );
}

/**
 * Getis-Ord Gi\* over H3 neighbourhoods.
 *
 * **The formula, written out, because a spec that says "z-score" and a query
 * that computes one are not the same claim.** With binary unstandardized
 * weights — one inside the neighbourhood, zero outside — the statistic for
 * cell *i* over an observed universe of *n* cells is
 *
 *     Gi* = (S_i − X̄·m_i) / (S · √((n·m_i − m_i²) / (n − 1)))
 *
 * where *S_i* is the sum of values in the neighbourhood, *m_i* the number of
 * observed cells in it (**including the focal cell**), *X̄* the global mean and
 * *S* the population standard deviation over the whole observed universe.
 *
 * **The universe is what was observed, never what H3 could enumerate** (G2).
 * A cell nobody landed in does not exist here, and neither does one where
 * every summed value was null (G8) — admitting either as a zero would move
 * every other cell's score by inventing an observation.
 *
 * **Two vanishing denominators, answered differently.** A universe with no
 * spread at all has no score for any cell, and admission refuses it before a
 * job exists. A single cell whose neighbourhood happens to cover the whole
 * universe makes `n·m_i − m_i²` zero for that row alone: its score is null,
 * because a cell with nothing to stand out against has no answer, and the rest
 * of the run is perfectly good.
 */
export function hotspotSql(
  table: DataTable,
  resolution: number,
  neighbours: number,
  value: "count" | "sum",
  field: string | null,
): string {
  const source = tableRef(table);
  const geom = ident(table.geometryColumn!);
  const cell = cellOf(geom, resolution);
  // A count counts the rows that landed; a sum adds what they carried. Rows
  // whose value is null contribute nothing to either, and a cell left with no
  // contribution at all is not in the universe (G8) — which `sum(...) IS NULL`
  // says exactly, because summing nothing but nulls answers null.
  const aggregate = value === "count" ? "count(*)" : `sum(${ident(field!)})`;
  // A summed cell whose every value was null contributed nothing, so it never
  // reaches the universe at all (G8) — the filter is what makes that true,
  // rather than a zero standing in for an observation nobody made.
  const contributes =
    value === "count" ? "" : ` AND ${ident(field!)} IS NOT NULL`;
  return `
WITH observed AS (
  SELECT ${cell} AS cell, ${aggregate} AS cell_value
  FROM ${source}
  WHERE ${geom} IS NOT NULL AND NOT ST_IsEmpty(${geom})${contributes}
  GROUP BY 1
  HAVING cell IS NOT NULL AND ${aggregate} IS NOT NULL
),
universe AS (
  SELECT count(*) AS n, avg(cell_value) AS mean, stddev_pop(cell_value) AS sd
  FROM observed
),
neighbourhood AS (
  SELECT d.cell AS focal, n.cell_value AS member_value
  FROM (SELECT cell, unnest(h3_grid_disk(cell, ${neighbours})) AS member FROM observed) d
  JOIN observed n ON n.cell = d.member
),
scored AS (
  SELECT focal AS cell, count(*) AS neighbour_count, sum(member_value) AS local_sum
  FROM neighbourhood GROUP BY 1
)
SELECT o.cell AS ${ident("h3_cell")},
       o.cell_value AS ${ident("value")},
       CASE
         WHEN u.n <= 1 OR u.sd = 0 THEN NULL
         WHEN (u.n * s.neighbour_count - s.neighbour_count * s.neighbour_count) <= 0 THEN NULL
         ELSE (s.local_sum - u.mean * s.neighbour_count)
              / (u.sd * sqrt(
                   (u.n * s.neighbour_count - s.neighbour_count * s.neighbour_count)
                   / (u.n - 1.0)))
       END AS ${ident("gi_star")},
       s.neighbour_count AS ${ident("neighbour_count")},
       ${boundaryOf("o.cell")} AS ${ident("geom")}
FROM observed o
JOIN scored s ON s.cell = o.cell
CROSS JOIN universe u`.trim();
}

/**
 * Single-link clustering at a distance threshold.
 *
 * **Three things make this survivable, and each was measured** (spec G5, G7).
 *
 * *The points are bucketed at `distance / √2`*, so a bucket's diagonal is the
 * threshold and everything sharing a bucket is mutually within it. Those
 * points therefore collapse to **one node** by construction and never enter
 * the pair-wise join — which is what turns 20,000 coincident points, the
 * duplicate-GPS-fix case, from a quadratic self-join into nothing.
 *
 * *Two buckets are tested for connection, not their points for pairing.* The
 * question an edge answers is whether **any** pair across two adjacent buckets
 * is within the threshold, so it is asked as an existence check per bucket
 * pair rather than as a join over their points. Enumerating the pairs and
 * de-duplicating afterwards is the same answer and a different program: at
 * 20,000 points concentrated into a handful of buckets it materialized
 * hundreds of millions of rows and exhausted the instance's memory budget,
 * which is how this arrived — a scale proof at the accepted maximum, failing.
 *
 * *The recursion shortcuts.* A node hooks to the smallest label among its
 * neighbours **and to its own label's label**; without the second half the
 * depth is the chain's length, which is 84 s on a 5,000-point chain against
 * 2.3 s with it. This is a refinement inside the recursive
 * connected-components shape the phase ratified, not a different mechanism.
 *
 * **The id is stable** because the ordinal it derives from is taken in
 * projected coordinate order rather than from the engine's row order, which is
 * not guaranteed across runs. A re-run of the same data recolors nothing.
 */
export function clusterByDistanceSql(
  table: DataTable,
  distance: number,
  crs: MeasurementCrs,
): string {
  const source = tableRef(table);
  const geom = ident(table.geometryColumn!);
  // Through the shared strategy, never a transform of its own: the axis
  // override and the direction live in one place, and the sweep in
  // `catalog-verbs.test.ts` is what keeps them there.
  const projected = intoMeasurement(representativePoint(geom), crs.crs);
  // A bucket whose side is distance/√2 has the threshold as its diagonal, so
  // any two points inside one are within the threshold of each other — which
  // is what makes the collapse below sound.
  const side = distance / Math.SQRT2;
  /**
   * How far the neighbour search reaches, in buckets — and it is **two**, not
   * one.
   *
   * The bucket is sized for the *collapse*, and the search has to be sized for
   * the *threshold*. A separation of `distance` is `√2` bucket sides, so two
   * points well inside the threshold can land two bucket indexes apart when
   * the first sits near the top of its bucket: measured, a pair 72.43 m apart
   * under a 100 m threshold came back as **two clusters** with a ±1 search.
   * Found at the cross-model review; the regression is in
   * `statistics-clustering.test.ts`.
   */
  const REACH = Math.ceil(Math.SQRT2);
  return `
WITH RECURSIVE placed AS (
  SELECT *, CASE WHEN ${geom} IS NULL OR ST_IsEmpty(${geom}) THEN NULL
                 ELSE ${projected} END AS __dezfil_pt
  FROM ${source}
),
pts AS (
  SELECT *, ST_X(__dezfil_pt) AS __dezfil_x, ST_Y(__dezfil_pt) AS __dezfil_y
  FROM placed WHERE __dezfil_pt IS NOT NULL
),
ordered AS (
  SELECT *, row_number() OVER (ORDER BY __dezfil_x, __dezfil_y) AS __dezfil_id
  FROM pts
),
bucketed AS (
  SELECT __dezfil_id, __dezfil_x, __dezfil_y,
         floor(__dezfil_x / ${side}) AS __dezfil_bx,
         floor(__dezfil_y / ${side}) AS __dezfil_by
  FROM ordered
),
nodes AS (
  SELECT __dezfil_bx, __dezfil_by, min(__dezfil_id) AS node
  FROM bucketed GROUP BY 1, 2
),
edges AS (
  SELECT na.node AS a, nb.node AS b
  FROM nodes na
  JOIN nodes nb
    ON nb.__dezfil_bx BETWEEN na.__dezfil_bx - ${REACH} AND na.__dezfil_bx + ${REACH}
   AND nb.__dezfil_by BETWEEN na.__dezfil_by - ${REACH} AND na.__dezfil_by + ${REACH}
   AND (na.__dezfil_bx <> nb.__dezfil_bx OR na.__dezfil_by <> nb.__dezfil_by)
  WHERE EXISTS (
    SELECT 1 FROM bucketed p, bucketed q
    WHERE p.__dezfil_bx = na.__dezfil_bx AND p.__dezfil_by = na.__dezfil_by
      AND q.__dezfil_bx = nb.__dezfil_bx AND q.__dezfil_by = nb.__dezfil_by
      AND (p.__dezfil_x - q.__dezfil_x) * (p.__dezfil_x - q.__dezfil_x)
        + (p.__dezfil_y - q.__dezfil_y) * (p.__dezfil_y - q.__dezfil_y)
          <= ${distance * distance})
),
cc USING KEY (node) AS (
  SELECT node, node AS label FROM nodes
  UNION ALL
  SELECT cand.node, min(cand.lab) FROM (
      SELECT c.node AS node, l.label AS lab
      FROM recurring.cc c JOIN cc l ON l.node = c.label
      UNION ALL
      SELECT e.b AS node, c.label AS lab
      FROM recurring.cc c JOIN edges e ON e.a = c.node
    ) cand
    JOIN cc cur ON cur.node = cand.node
    WHERE cand.lab < cur.label
    GROUP BY cand.node
),
labelled AS (
  SELECT b.__dezfil_id, cc.label AS cluster
  FROM bucketed b
  JOIN nodes n ON n.__dezfil_bx = b.__dezfil_bx AND n.__dezfil_by = b.__dezfil_by
  JOIN cc ON cc.node = n.node
),
sized AS (SELECT cluster, count(*) AS size FROM labelled GROUP BY 1)
SELECT o.* EXCLUDE (__dezfil_pt, __dezfil_x, __dezfil_y, __dezfil_id),
       l.cluster AS ${ident("cluster_id")},
       s.size AS ${ident("cluster_size")}
FROM ordered o
LEFT JOIN labelled l ON l.__dezfil_id = o.__dezfil_id
LEFT JOIN sized s ON s.cluster = l.cluster
UNION ALL
SELECT p.* EXCLUDE (__dezfil_pt),
       NULL AS ${ident("cluster_id")}, NULL AS ${ident("cluster_size")}
FROM placed p WHERE p.__dezfil_pt IS NULL`.trim();
}
