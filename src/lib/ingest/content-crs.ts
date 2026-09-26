import type { DuckDBConnection } from "@duckdb/node-api";
import type { GeometryFormat } from "@/lib/geometry-evidence";
import { declarationSql } from "./content-decoders";
import { ident } from "./sql";

/** Min/max suffices for the one-declaration or conflicting verdict. Combine
 * the unreadable WKT declaration check with it in one source-column pass. */
export async function readCrsDeclarations(conn: DuckDBConnection, from: string, format: GeometryFormat, column: string) {
  if (format !== "wkt" && format !== "wkb") return { declarations: [], unknown: false };
  const unknown = format === "wkt"
    ? `regexp_matches(CAST(source_value AS VARCHAR), '(?i)^\\s*SRID\\s*=') AND declaration_value IS NULL` : "false";
  const r = (await conn.runAndReadAll(`SELECT min(declaration_value) lo, max(declaration_value) hi, bool_or(${unknown}) unknown_declaration
    FROM (SELECT ${ident(column)} AS source_value, ${declarationSql(format, column)} declaration_value FROM ${from})`)).getRowObjects()[0];
  return { declarations: r.lo === null ? [] : r.lo === r.hi ? [Number(r.lo)] : [Number(r.lo), Number(r.hi)], unknown: r.unknown_declaration === true };
}
