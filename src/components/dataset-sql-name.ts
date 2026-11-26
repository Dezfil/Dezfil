import { tableReference } from "./sql/sql-draft";

/**
 * A dataset's SQL name: the name the SQL page opens it by as a query. The
 * reader's own dataset is written by its plain name and someone else's
 * with their SQL name, `<sql name>.<name>`, which is the name the reader
 * types (`qualifiedName`, as every listing and read gives it). Each part is
 * bare where SQL reads it bare and quoted where it must be: a reserved
 * word, an uppercase letter, a space, a leading digit. The table page's
 * "In SQL:" line and a Data card show it, so what a person reads there is
 * what they type. A record that carries no typed name is the reader's own,
 * typed by its plain name.
 */
export function datasetSqlName(table: { name: string; qualifiedName?: string | null }): string {
  return tableReference(table.qualifiedName || table.name);
}
