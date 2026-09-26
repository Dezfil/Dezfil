import type { DataTable } from "../api";

/**
 * When a landed file needs the column-matching step (default 1): its
 * answer carries recognition evidence and no applied record. Only the
 * CSV road carries evidence: its candidates, which may be none, and its
 * record, absent when nothing applied. So a CSV with weak candidates
 * stops, a CSV with no candidate at all stops, a strong match never
 * does (its record is applied and the table has its geometry), and
 * every other road, which carries no evidence, lands as today. A table
 * that already has geometry never stops either: the step corrects a
 * plain table, and nothing else.
 */
export function needsStep(table: DataTable): boolean {
  const evidence = table.geometryCandidates !== undefined || table.geometryRecord !== undefined;
  return evidence && (table.geometryRecord ?? null) === null && table.geometryColumn === null;
}

/** The first of a file's tables that needs the step, or none. A CSV
 * lands one table; a container's several carry no evidence. */
export function stepTable(tables: readonly DataTable[]): DataTable | null {
  return tables.find(needsStep) ?? null;
}
