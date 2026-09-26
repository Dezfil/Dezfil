import type { DuckDBConnection } from "@duckdb/node-api";
import { CANONICAL_CRS, isCanonicalEquivalent } from "@/lib/crs";

function ident(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface ArtifactRelation {
  /** A complete FROM item: either the raw artifact or a guarded projection. */
  from: string;
  /** False only when the artifact schema itself could not be inspected. */
  probed: boolean;
}

/**
 * Present a stored artifact as the relation its registry record describes.
 *
 * Empty and all-null geometry columns lose DuckDB's logical GEOMETRY type when
 * COPY writes Parquet: the physical artifact reads back as BLOB. A registry
 * record can retain that column's identity, so this boundary restores the
 * logical type without rewriting the file. The repair is deliberately narrow:
 * the named column must exist, must physically be BLOB, and must hold no
 * non-null values. A missing column or contradictory artifact remains a usable
 * raw relation instead of making view registration fail.
 *
 * This is also the existing CRS-normalisation boundary. Every WGS84-equivalent
 * geometry is presented under the one canonical label; projected geometry is
 * left untouched.
 */
export async function artifactRelation(
  conn: DuckDBConnection,
  artifact: string,
  geometryColumn: string | null,
): Promise<ArtifactRelation> {
  const raw = `read_parquet(${lit(artifact)})`;
  try {
    const described = await conn.runAndReadAll(
      `DESCRIBE SELECT * FROM ${raw}`,
    );
    const columns = described.getRowObjects() as unknown as {
      column_name: string;
      column_type: string;
    }[];
    const replacements = columns
      .filter((column) => isCanonicalEquivalent(String(column.column_type)))
      .map((column) => {
        const name = ident(String(column.column_name));
        return `ST_SetCRS(${name}, '${CANONICAL_CRS}') AS ${name}`;
      });

    const retainedName = geometryColumn
      ? columns.some(
          (column) =>
            String(column.column_name) === geometryColumn &&
            String(column.column_type).trim().toUpperCase() === "BLOB",
        )
        ? geometryColumn
        : null
      : undefined;
    if (retainedName) {
      const name = ident(retainedName);
      try {
        // Retention is licensed only for a column with no non-null geometry.
        // Ask that exact invariant rather than sampling bytes that could agree
        // for an arbitrary prefix and fail later when the view is queried.
        const nonNull = await conn.runAndReadAll(
          `SELECT 1 FROM ${raw} WHERE ${name} IS NOT NULL LIMIT 1`,
        );
        if (nonNull.getRowObjects().length === 0) {
          replacements.push(
            `ST_SetCRS(ST_GeomFromWKB(${name}), '${CANONICAL_CRS}') AS ${name}`,
          );
        }
      } catch {
        // The record and artifact disagree. Keep the table queryable and let
        // the physical BLOB speak for itself.
      }
    }

    if (replacements.length === 0) return { from: raw, probed: true };
    return {
      from: `(SELECT * REPLACE (${replacements.join(", ")}) FROM ${raw})`,
      probed: true,
    };
  } catch {
    return { from: raw, probed: false };
  }
}
