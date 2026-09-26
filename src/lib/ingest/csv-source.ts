import type { DuckDBConnection } from "@duckdb/node-api";
import { trustedH3Ready } from "@/lib/duckdb";
import { COORDINATE_PAIRS, isNumericCsvType, suspectCsvHeader, type CsvColumn } from "./csv-geometry";
import { recognizeCsvContent } from "./content-recognition";
import { ident, lit } from "./sql";

const EXACT_COORDINATE_MEMBER_NAMES = new Set(
  COORDINATE_PAIRS.flatMap((pair) => [pair.lon, pair.lat]),
);

/** Attach the one value fact rule 2 needs using the CSV reader relation
 * itself: quoted-empty and empty fields are NULL there; whitespace is not. */
export async function withBlankCoordinateFacts(
  conn: import("@duckdb/node-api").DuckDBConnection,
  from: string,
  columns: readonly CsvColumn[],
): Promise<CsvColumn[]> {
  const candidates = columns.filter(
    (column) =>
      EXACT_COORDINATE_MEMBER_NAMES.has(column.name.toLowerCase()) &&
      !isNumericCsvType(column.type),
  );
  if (candidates.length === 0) return [...columns];

  const aliases = candidates.map((_, index) => `blank_${index}`);
  const probed = await conn.runAndReadAll(
    `SELECT ${candidates
      .map(
        (column, index) =>
          `count(${ident(column.name)}) = 0 AS ${ident(aliases[index])}`,
      )
      .join(", ")} FROM ${from}`,
  );
  const row = probed.getRowObjects()[0] as Record<string, unknown>;
  const allBlank = new Map(
    candidates.map((column, index) => [
      column.name,
      row[aliases[index]] === true,
    ]),
  );
  return columns.map((column) => ({
    ...column,
    ...(allBlank.has(column.name)
      ? { allBlank: allBlank.get(column.name) }
      : {}),
  }));
}

export async function planCsvSource(conn: DuckDBConnection, sourcePath: string) {
  const from = `read_csv(${lit(sourcePath)})`;
  const described = (await conn.runAndReadAll(`DESCRIBE SELECT * FROM ${from}`)).getRowObjects();
  const columns = await withBlankCoordinateFacts(conn, from, described.map(c => ({
    name: String(c.column_name), type: String(c.column_type),
  })));
  return {
    ...await recognizeCsvContent(conn, from, columns, trustedH3Ready),
    headerSuspect: suspectCsvHeader(columns),
  };
}
