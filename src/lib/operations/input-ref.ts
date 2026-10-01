import { ident } from "@/lib/ingest/ingest";
import type { DataTable } from "@/lib/metadata/tables";

/**
 * A dataset a verb names, resolved to its identity in the evaluation's
 * namespace, with the reference the verb's own SQL uses for it there: the
 * plain name for a plain parameter, the owner-qualified name for a qualified
 * one. Generated SQL and probes read inputs through `tableRef`, never through
 * the bare dataset name, so a qualified input can never bind a same-named
 * dataset of the home instead.
 */
export interface InputTable extends DataTable {
  ref: string;
  /** The reference as compiled, lower-cased: what a binding fence is keyed by. */
  key: string;
}

/** The SQL a verb uses to read an input it resolved. */
export function tableRef(table: DataTable): string {
  return (table as Partial<InputTable>).ref ?? ident(table.name);
}

/** The key a binding fence uses for an input it resolved. */
export function bindingKey(table: DataTable): string {
  return (table as Partial<InputTable>).key ?? table.name.toLowerCase();
}
