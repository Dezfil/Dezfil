import type {
  MapWidget,
  WidgetAgg,
  WidgetFormat,
  WidgetType,
} from "@/lib/widgets";
import { WIDGET_TITLE_MAX } from "@/lib/widgets";

/** The open editor's working copy — a widget being added or edited.
 *
 * `type` is nullable: adding opens the editor with the four type cards
 * and nothing chosen yet, so the selector is the same control in every
 * state instead of vanishing once it has been used. */
export interface Draft {
  /** Editing an existing widget (its id) or adding (null). */
  id: string | null;
  /** Null while an add has not chosen a type yet. */
  type: WidgetType | null;
  layerId: string | null;
  field: string | null;
  agg: WidgetAgg;
  aggField: string | null;
  unit: string | null;
  note: string | null;
  format: WidgetFormat | null;
  title: string;
  /** Whether the user has touched the title (stop auto-suggesting). */
  titled: boolean;
}

/** The selector's four cards, in the order they are offered. */
export const WIDGET_TYPES: readonly WidgetType[] = [
  "formula",
  "category",
  "histogram",
  "note",
];

export function suggestTitle(d: Draft): string {
  if (d.type === null) return "";
  if (d.type === "note") return "Note";
  if (d.type === "formula") {
    return d.agg === "count" ? "Row count" : d.field ? `${d.agg} ${d.field}` : "";
  }
  if (d.type === "category") return d.field ? `By ${d.field}` : "";
  return d.field ?? "";
}

/** A fresh add: no type, nothing chosen. */
export function emptyDraft(): Draft {
  return {
    id: null,
    type: null,
    layerId: null,
    field: null,
    agg: "count",
    aggField: null,
    unit: null,
    note: null,
    format: null,
    title: "",
    titled: false,
  };
}

/** An existing widget, opened for editing. */
export function draftOf(w: MapWidget): Draft {
  return { ...w, id: w.id, titled: true };
}

/**
 * The draft after a patch — the type-switch reset rules in one place.
 *
 * The resets are what they have always been: a type change clears the
 * type-specific settings, and the note survives a data-to-data switch,
 * clearing only when the Note boundary is crossed. What adds is the case
 * the old UI could not reach — arriving at a data type from Note (or from
 * no type at all) has to seat a layer, because Note cleared it and a
 * one-layer map never renders the Layer control to seat it by hand.
 */
export function nextDraft(
  d: Draft,
  patch: Partial<Draft>,
  fallbackLayerId: string | null,
): Draft {
  const next = { ...d, ...patch };
  if (patch.type !== undefined && patch.type !== d.type) {
    next.field = null;
    next.agg = "count";
    next.aggField = null;
    next.unit = null;
    next.format = null;
    if (d.type === "note" || patch.type === "note") next.note = null;
    next.layerId =
      patch.type === "note" || patch.type === null
        ? null
        : (next.layerId ?? fallbackLayerId);
  }
  if (patch.layerId && patch.layerId !== d.layerId) {
    next.field = null;
    next.aggField = null;
  }
  if (!next.titled) next.title = suggestTitle(next);
  return next;
}

/** Whether the draft can be saved. An untyped draft never can — which is
 *  also what keeps it out of the rail's live preview. */
export function draftValid(d: Draft): boolean {
  if (d.type === null) return false;
  if (d.title.trim().length === 0 || d.title.length > WIDGET_TITLE_MAX) {
    return false;
  }
  if (d.type === "note") {
    return d.note !== null && d.note.trim().length > 0;
  }
  if (d.layerId === null) return false;
  if (d.type === "formula") {
    if (d.agg !== "count" && d.field === null) return false;
  } else if (d.field === null) {
    return false;
  }
  if (d.type === "category" && d.agg !== "count" && d.aggField === null) {
    return false;
  }
  return true;
}

/** A valid draft as the widget it would save to (the preview shape). */
export function materialize(d: Draft, id: string, visible: boolean): MapWidget {
  const type = d.type ?? "formula";
  const isNote = type === "note";
  const isFormula = type === "formula";
  return {
    id,
    type,
    layerId: isNote ? null : d.layerId,
    title: d.title.trim(),
    field: isNote || (isFormula && d.agg === "count") ? null : d.field,
    agg: isFormula || type === "category" ? d.agg : "count",
    aggField: type === "category" && d.agg !== "count" ? d.aggField : null,
    unit: isFormula && d.unit?.trim() ? d.unit.trim() : null,
    note: isNote || isFormula ? (d.note?.trim() ? d.note : null) : null,
    format: isFormula ? d.format : null,
    visible,
  };
}
