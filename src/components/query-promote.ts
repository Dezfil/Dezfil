import type { QueryResult } from "./query-types";

/**
 * Result-to-layer promotion facts. Pure: the workspace holds the
 * executed SQL next to its result and asks these two questions — can
 * this result be a layer, and has the editor drifted since the run.
 */

/** A result can become a layer when it carries a geometry column — the
 * query answer's column types keep the engine's geometry marker even
 * though the preview shows WKT. The server's layer validation remains
 * the authority at landing time. */
export function resultIsMappable(result: QueryResult): boolean {
  return result.columns.some((c) => c.type.startsWith("GEOMETRY"));
}

/** The explanation the disabled action carries — re-exported from the one
 * dependency-free module that holds it, so the two surfaces cannot drift into
 * two sentences the way they did before **and** a client bundle importing this
 * never reaches the engine. */
export { NOT_MAPPABLE_COPY } from "@/lib/layer-copy";

/** Whether the editor draft has drifted from the SQL that produced the
 * on-screen result. Whitespace-only edits are not drift — the executed
 * SQL was trimmed on its way out. */
export function draftDiverged(executedSql: string, draft: string): boolean {
  return executedSql !== draft.trim();
}

/** The sentence shown when promoting a diverged result (spec decision 1:
 * the executed SQL lands, stated, never a forced re-run). */
export const DIVERGED_COPY =
  "The editor changed since this run. The layer gets the query that produced this result.";
