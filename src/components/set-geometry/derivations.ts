import type { GeometryCandidate, GeometryRecord } from "@/lib/geometry-evidence";
import { effectiveProjectionName } from "./projection";
import type { GeometryPreview, PanelChoice } from "./types";

/** The drawn words for the count sentence. */
export function kindWord(geometryType: string | null): string {
  if (geometryType === null) return "geometry";
  const t = geometryType.toUpperCase();
  if (t.includes("+") || t.includes("MIXED") || t.includes("COLLECTION")) return "mixed geometry";
  if (t.includes("POINT")) return "points";
  if (t.includes("LINE")) return "lines";
  if (t.includes("POLYGON")) return "polygons";
  return "geometry";
}

export interface CountSentence {
  readable: number;
  total: number;
  unreadable: number;
  kind: string;
}

/** The count describes the API's sample: readable rows, unreadable
 * rows exactly; missing rows are neither. */
export function countSentence(answer: GeometryPreview | null): CountSentence | null {
  if (answer === null) return null;
  const rows = answer.sample.rows;
  const readable = rows.filter((r) => r.status === "readable").length;
  const unreadable = rows.filter((r) => r.status === "unreadable").length;
  return { readable, total: rows.length, unreadable, kind: kindWord(answer.geometryType) };
}

export const NOT_DEGREES = "These numbers are not degrees. Choose the projection they are in.";
export const NOTHING_UNTIL_PROJECTION = "Nothing can be drawn until the projection is chosen.";
export const NO_ROW_READS = "No sampled row can be read this way.";
export const AMBIGUOUS_PAIR = "Both columns fit both ranges. If the map is wrong, swap them.";

/** The notice under the controls: the API's `projection_required` is the
 * drawn not-degrees notice; every other issue shows the API's sentence. */
export function panelNotice(answer: GeometryPreview | null): { kind: "not-degrees" | "issue"; text: string } | null {
  const issue = answer?.issues[0];
  if (!issue) return null;
  if (issue.code === "projection_required") return { kind: "not-degrees", text: NOT_DEGREES };
  return { kind: "issue", text: issue.message };
}

/** The map's notice in the plate's place. */
export function mapNotice(answer: GeometryPreview | null): string | null {
  if (answer === null) return null;
  const issue = answer.issues[0];
  if (issue) return issue.code === "projection_required" ? NOTHING_UNTIL_PROJECTION : issue.message;
  return countSentence(answer)?.readable === 0 ? NO_ROW_READS : null;
}

/** The ambiguity hint follows the API's candidate evidence: both
 * orientations listed for the chosen pair, whichever way round. The panel
 * infers no ambiguity of its own. */
export function pairHint(candidates: readonly GeometryCandidate[], choice: PanelChoice): boolean {
  if (choice.format !== "pair" || choice.columns.length !== 2) return false;
  const [a, b] = choice.columns;
  return candidates.some(
    (c) => c.format === "pair" && c.columns.length === 2 && c.columns.includes(a) && c.columns.includes(b) && (c.orientations?.length ?? 0) > 1,
  );
}

export type ColumnTag = "longitude" | "latitude" | "H3 cell" | "geometry";

/** The grid's tags on the chosen columns. Built from computed keys
 * only, so a column named `__proto__` is an own entry rather than a
 * swallowed prototype assignment. */
export function columnTags(choice: Pick<PanelChoice, "format" | "columns">): Record<string, ColumnTag> {
  if (choice.format === "pair") {
    const [lon, lat] = choice.columns;
    return { ...(lon ? { [lon]: "longitude" as const } : {}), ...(lat ? { [lat]: "latitude" as const } : {}) };
  }
  return choice.columns[0] ? { [choice.columns[0]]: choice.format === "h3" ? "H3 cell" : "geometry" } : {};
}

/** Which sample rows the grid marks: those that keep no geometry though
 * they hold a value. Missing rows are not marked. */
export function markedRows(answer: GeometryPreview): boolean[] {
  return answer.sample.rows.map((r) => r.status === "unreadable" || r.status === "projection-required");
}

/** The map's readout while the panel is open: sampled count, the
 * drawn type, the projection the answer was read under; nothing while no
 * row reads. Every part comes from the answer, so a pending replacement
 * never relabels it; the record is the one
 * kept with the answer, never the current inspection's. */
export function readout(answer: GeometryPreview | null, record: GeometryRecord | null): string[] | null {
  const count = countSentence(answer);
  if (!count || count.readable === 0 || answer === null) return null;
  return [`${count.readable} of ${count.total} sampled rows`, answer.geometryType ?? "GEOMETRY", effectiveProjectionName(answer.choice, record)];
}
