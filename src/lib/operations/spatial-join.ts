import { tableRef } from "./input-ref";
import { ApiError } from "@/lib/api/errors";
import { ident } from "@/lib/ingest/ingest";
import type { DataTable } from "@/lib/metadata/tables";

/**
 * The spatial join.
 *
 * **It is an enrichment, not a cross product.** One row out per *left* row in,
 * carrying values from the right features that satisfy the predicate. Where
 * several match, the carried values are aggregated by an explicitly chosen
 * aggregate. A join that silently multiplied a user's rows is the classic
 * surprise this verb exists to avoid: you asked to know how many accidents are
 * in each borough and got one row per accident.
 *
 * Two halves of that matter: an unmatched left feature is **kept**, rather than
 * silently deleted from the user's map, and the row count is **the left's**
 * however many right features matched. How that is achieved is below, and it is
 * not the obvious join-and-group.
 *
 * **The predicate and aggregate sets are fixed here**, not by whatever the
 * engine happens to offer. A catalog that advertised whatever it implemented
 * would make its own description unfalsifiable.
 *
 * **No distances, no units, no reprojection.** Every predicate below is
 * topological. Owns what a metre means, and a verb that quietly measured in
 * degrees is exactly the distortion that spec exists to prevent.
 */

/** Read left-relative-to-right: `within` means each left feature inside a
 * right one. */
export const PREDICATES = [
  "intersects",
  "contains",
  "within",
  "touches",
  "crosses",
  "overlaps",
] as const;
export type Predicate = (typeof PREDICATES)[number];

export const AGGREGATES = ["count", "sum", "mean", "min", "max", "any"] as const;
export type Aggregate = (typeof AGGREGATES)[number];

/** The engine function each predicate compiles to, oriented left-then-right. */
const PREDICATE_SQL: Record<Predicate, string> = {
  intersects: "ST_Intersects",
  contains: "ST_Contains",
  within: "ST_Within",
  touches: "ST_Touches",
  crosses: "ST_Crosses",
  overlaps: "ST_Overlaps",
};

/** Aggregates that need a number to work on. */
const NUMERIC: ReadonlySet<Aggregate> = new Set(["sum", "mean", "min", "max"]);

export interface CarriedField {
  aggregate: Aggregate;
  /** A column of the right input. Omitted for `count`, which counts matched
   * features rather than values of a column. */
  field?: string;
  /** What it is called in the output; defaults to a readable derivation. */
  as?: string;
}

export interface SpatialJoinParams {
  left: string;
  right: string;
  predicate: Predicate;
  carry: CarriedField[];
}

/** A column and the type the engine reports for it. */
export interface ColumnType {
  name: string;
  type: string;
}

function isNumeric(type: string): boolean {
  return /INT|DECIMAL|NUMERIC|REAL|DOUBLE|FLOAT|HUGEINT/i.test(type);
}

function defaultAlias(c: CarriedField): string {
  if (c.as) return c.as;
  return c.aggregate === "count" ? "match_count" : `${c.field}_${c.aggregate}`;
}

function refuse(message: string): never {
  throw new ApiError("invalid_request", message, 400);
}

/**
 * Check the join before any SQL is generated.
 *
 * Everything here is knowable from the catalog and the two inputs' schemas, so
 * refusing now gives a coded, specific message instead of an engine error from
 * halfway through a run.
 */
export function validateSpatialJoin(
  params: SpatialJoinParams,
  left: { table: DataTable; columns: ColumnType[] },
  right: { table: DataTable; columns: ColumnType[] },
): void {
  if (!PREDICATES.includes(params.predicate)) {
    refuse(
      `"${params.predicate}" is not a spatial relationship this operation ` +
        `offers. Choose one of: ${PREDICATES.join(", ")}.`,
    );
  }

  // Which side has no geometry is the useful half of this message.
  if (!left.table.geometryColumn) {
    refuse(
      `The left input "${left.table.name}" has no geometry column, so it ` +
        `cannot be joined spatially.`,
    );
  }
  if (!right.table.geometryColumn) {
    refuse(
      `The right input "${right.table.name}" has no geometry column, so it ` +
        `cannot be joined spatially.`,
    );
  }

  if (params.carry.length === 0) {
    refuse(
      `Choose at least one value to carry across from "${right.table.name}"; ` +
        `a join that carries nothing would only repeat the left input.`,
    );
  }

  const rightColumns = new Map(right.columns.map((c) => [c.name.toLowerCase(), c]));
  const leftNames = new Set(left.columns.map((c) => c.name.toLowerCase()));
  const seen = new Set<string>();

  for (const carried of params.carry) {
    if (!AGGREGATES.includes(carried.aggregate)) {
      refuse(
        `"${carried.aggregate}" is not an aggregate this operation offers. ` +
          `Choose one of: ${AGGREGATES.join(", ")}.`,
      );
    }
    // `count` counts matches rather than values, so it needs no column.
    if (carried.aggregate !== "count") {
      if (!carried.field) {
        refuse(`${carried.aggregate} needs a column of "${right.table.name}".`);
      }
      const column = rightColumns.get(carried.field.toLowerCase());
      if (!column) {
        refuse(
          `"${carried.field}" is not a column of the right input ` +
            `"${right.table.name}".`,
        );
      }
      if (NUMERIC.has(carried.aggregate) && !isNumeric(column.type)) {
        refuse(
          `"${carried.field}" is ${column.type}, which ${carried.aggregate} ` +
            `cannot be taken of. Use count or any value instead.`,
        );
      }
    }

    const alias = defaultAlias(carried);
    if (leftNames.has(alias.toLowerCase())) {
      refuse(
        `The carried value would be called "${alias}", which the left input ` +
          `already has. Give it another name.`,
      );
    }
    if (seen.has(alias.toLowerCase())) {
      refuse(`Two carried values would both be called "${alias}".`);
    }
    seen.add(alias.toLowerCase());
  }
}

/**
 * One carried value, as a correlated subquery over the right input.
 *
 * **Deliberately not a join with grouping.** Grouping would need a key that
 * distinguishes two byte-identical left rows, and a view over a Parquet file
 * has no row identity to use — so a grouped form would silently merge
 * duplicates and break the one-row-per-left-feature promise on exactly the data
 * where it is hardest to notice. A correlated subquery is one row per left row
 * by construction, and the engine decorrelates it into the same join anyway.
 */
function carriedExpression(
  carried: CarriedField,
  predicateSql: string,
  right: DataTable,
  leftGeom: string,
): string {
  const rightName = tableRef(right);
  const rightGeom = `r.${ident(right.geometryColumn!)}`;
  const where = `${predicateSql}(${leftGeom}, ${rightGeom})`;

  if (carried.aggregate === "count") {
    // Zero, never empty: a left feature that matched nothing matched nothing,
    // and an empty count would read as "unknown".
    return `(SELECT count(*) FROM ${rightName} AS r WHERE ${where})`;
  }

  const col = `r.${ident(carried.field!)}`;
  const fn =
    carried.aggregate === "mean"
      ? "avg"
      : carried.aggregate === "any"
        ? "any_value"
        : carried.aggregate;
  return `(SELECT ${fn}(${col}) FROM ${rightName} AS r WHERE ${where})`;
}

/**
 * Generate the join.
 *
 * One row per left feature, whatever matched: unmatched left features survive
 * with `count` = 0 and every other carried value empty, and no left row is ever
 * duplicated or merged.
 */
export function spatialJoinSql(
  params: SpatialJoinParams,
  left: DataTable,
  right: DataTable,
): string {
  const fn = PREDICATE_SQL[params.predicate];
  const leftGeom = `l.${ident(left.geometryColumn!)}`;

  const carried = params.carry
    .map(
      (c) =>
        `${carriedExpression(c, fn, right, leftGeom)} AS ${ident(defaultAlias(c))}`,
    )
    .join(",\n       ");

  // `l.*` first, so the output's geometry is the LEFT input's — the existing
  // first-geometry-column rule then finds it, which is how the declared
  // output geometry and the actual result agree instead of colliding.
  return `SELECT l.*,
       ${carried}
FROM ${tableRef(left)} AS l`;
}
