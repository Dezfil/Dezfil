import type { TableInspection } from "../api";
import { columnTags, markedRows, type ColumnTag } from "./derivations";
import type { PanelState } from "./panel-controller";

export interface LivePreview {
  columns: TableInspection["columns"];
  rows: readonly Record<string, unknown>[];
  tags?: Record<string, ColumnTag>;
  marks?: boolean[];
}

/**
 * What the Data preview shows while the panel is open: the answer's own rows, keyed by the
 * inspection's columns, with the answer's chosen columns tagged and its unreadable rows marked.
 * Every part comes from the one answer, so a draft that has moved on cannot relabel the rows of the
 * answer still on the page; with no answer, the page's own preview stands.
 */
export function livePreview(state: PanelState, table: Pick<TableInspection, "columns" | "preview">): LivePreview {
  const answer = state.phase === "open" ? state.preview.answer : null;
  if (!answer || !state.inspection) return { columns: table.columns, rows: table.preview };
  return {
    columns: state.inspection.columns,
    rows: answer.sample.rows.map((r) => r.values),
    tags: columnTags(answer.choice),
    marks: markedRows(answer),
  };
}
