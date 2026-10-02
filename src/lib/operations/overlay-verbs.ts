import { tableRef } from "./input-ref";
import { ApiError } from "@/lib/api/errors";
import { ident } from "@/lib/ingest/ingest";
import type { DataTable } from "@/lib/metadata/tables";

/**
 * The overlay verbs: intersect / clip, union, difference.
 *
 * **Each clips against the *whole* of the other input, not against each of its
 * features.** Intersecting feature-by-feature multiplies rows — a parcel
 * crossing three districts comes back three times — which is the classic
 * spatial-join surprise this phase's join was written to avoid, and it is no
 * more welcome here. So the other input is aggregated into one shape first and
 * the cardinality each verb promises is the one it keeps.
 *
 * They compare geometry from any ingest path: the registered view presents one
 * canonical CRS label, which is where was repaired.
 */

function geometryOf(table: DataTable, verb: string, role: string): string {
  if (!table.geometryColumn) {
    throw new ApiError(
      "invalid_request",
      `"${table.name}" has no geometry column, so it cannot be the ${role} ` +
        `of ${verb}.`,
      400,
    );
  }
  return table.geometryColumn;
}

/** The other input, dissolved to one shape — what "against the whole of it"
 * means, and the reason these verbs do not multiply rows. */
function wholeOf(table: DataTable, column: string): string {
  return `(SELECT ST_Union_Agg(${ident(column)}) FROM ${tableRef(table)} WHERE ${ident(column)} IS NOT NULL)`;
}

/**
 * Intersect / clip: the parts of the input that fall inside the clip.
 *
 * One row out per input feature that survives, carrying its own values. A
 * feature clipped to nothing is **dropped**, not kept as an empty shape: an
 * empty geometry renders as nothing, joins as nothing and counts as one, which
 * is three ways to be misleading.
 */
export function clipSql(input: DataTable, clip: DataTable): string {
  const geom = ident(geometryOf(input, "a clip", "input"));
  const clipGeom = geometryOf(clip, "a clip", "clip");
  const whole = wholeOf(clip, clipGeom);
  // REPLACE, not a working column: the clipped geometry lands under the
  // input column's own name inside the nested selection, so the output's
  // schema is exactly the input's and no column name is reserved — an
  // earlier working-column shape leaked it into `*` and reserved a name a
  // user's own data could carry.
  return `SELECT * FROM (
  SELECT t.* REPLACE (ST_Intersection(t.${geom}, ${whole}) AS ${geom})
  FROM ${tableRef(input)} AS t
  WHERE t.${geom} IS NOT NULL
) AS c
WHERE NOT ST_IsEmpty(${geom})`;
}

/**
 * Difference: the parts of the input that fall **outside** the eraser.
 *
 * Same cardinality rule as the clip, and the same reason for dropping what is
 * left with nothing.
 */
export function differenceSql(input: DataTable, erase: DataTable): string {
  const geom = ident(geometryOf(input, "a difference", "input"));
  const eraseGeom = geometryOf(erase, "a difference", "eraser");
  const whole = wholeOf(erase, eraseGeom);
  return `SELECT * FROM (
  SELECT t.* REPLACE (ST_Difference(t.${geom}, ${whole}) AS ${geom})
  FROM ${tableRef(input)} AS t
  WHERE t.${geom} IS NOT NULL
) AS d
WHERE NOT ST_IsEmpty(${geom})`;
}

/**
 * Union: the overlay union of two inputs — what they share, and what each
 * holds alone.
 *
 * **Every piece says which input it came from** (ruling G2), in a `source`
 * column reading `both`, `left` or `right`. The declined alternative was
 * carrying both inputs' attribute columns onto every piece, which needs a
 * collision rule for every pair of identically named columns and produces a
 * table half full of nulls. What comes out is geometry plus provenance, which
 * is what an overlay union is actually asked for.
 */
export function unionSql(left: DataTable, right: DataTable): string {
  const leftGeom = geometryOf(left, "a union", "left input");
  const rightGeom = geometryOf(right, "a union", "right input");
  const leftWhole = wholeOf(left, leftGeom);
  const rightWhole = wholeOf(right, rightGeom);
  const geom = ident(leftGeom);
  return `SELECT source, piece AS ${geom} FROM (
  SELECT 'both' AS source, ST_Intersection(${leftWhole}, ${rightWhole}) AS piece
  UNION ALL
  SELECT 'left' AS source, ST_Difference(${leftWhole}, ${rightWhole}) AS piece
  UNION ALL
  SELECT 'right' AS source, ST_Difference(${rightWhole}, ${leftWhole}) AS piece
) AS u
WHERE piece IS NOT NULL AND NOT ST_IsEmpty(piece)`;
}
