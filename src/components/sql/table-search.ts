import type { TableListing } from "../api";

/**
 * Search in the Tables tab: a query narrows by table name and by column
 * name; a row matched only through a column carries that column so the
 * row can show it. Columns are known only once a table's schema has
 * been read — an unread table matches by name alone. Pure.
 */
export interface TableMatch {
  table: TableListing;
  /** The matching column, when the name itself did not match. */
  column: string | null;
}

export function matchTables(
  tables: readonly TableListing[],
  query: string,
  columnsOf: (name: string) => readonly string[] | null,
): TableMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return tables.map((table) => ({ table, column: null }));
  const out: TableMatch[] = [];
  for (const table of tables) {
    if (table.qualifiedName.toLowerCase().includes(q)) {
      out.push({ table, column: null });
      continue;
    }
    const col = (columnsOf(table.qualifiedName) ?? []).find((c) =>
      c.toLowerCase().includes(q),
    );
    if (col) out.push({ table, column: col });
  }
  return out;
}
