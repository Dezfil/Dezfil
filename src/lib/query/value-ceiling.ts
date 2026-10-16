import { QueryResultTooLarge } from "@/lib/api/errors";
import { stringByteLength } from "./budget-string";
import { CELL_BYTES } from "./result-budget";

/**
 * One text value a summary read returns (a filter's distinct values, the
 * categories a fill colors or a widget counts, a search match), held to the
 * ceiling the SQL result reader holds one value to: its JSON string length,
 * at most CELL_BYTES (2 MiB). No category or match a person reads comes
 * near it; a crafted column can be any size.
 *
 * The value is projected beside its length, and one over the ceiling stays
 * in the engine as a null, so it is refused without being read into
 * JavaScript. The refusal is the SQL result's own, whose sentence names the
 * per-value ceiling.
 */
export function cappedText(text: string, name: string): string {
  const bytes = stringByteLength(text);
  return `CASE WHEN ${bytes} > ${CELL_BYTES} THEN NULL ELSE ${text} END AS ${name}, ${bytes} AS ${name}_bytes`;
}

/** The value `cappedText` projected as `name` in a row, or the refusal
 * when it passed the ceiling. */
export function cappedValue(row: Record<string, unknown>, name: string): string {
  if (Number(row[`${name}_bytes`]) > CELL_BYTES) throw new QueryResultTooLarge();
  return String(row[name]);
}
