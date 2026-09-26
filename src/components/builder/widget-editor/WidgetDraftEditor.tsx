"use client";

import type { Layer } from "@/lib/metadata/maps";
import type { LayerField } from "@/lib/layer-service";
import {
  WIDGET_TITLE_MAX,
  WIDGET_UNIT_MAX,
  WIDGET_NOTE_MAX,
  WIDGET_FORMATS,
  type WidgetAgg,
  type WidgetFormat,
  type WidgetType,
} from "@/lib/widgets";
import type { ReactNode } from "react";
import type { Draft } from "./draft";
import { WIDGET_TYPES } from "./draft";
import styles from "../WidgetsTab.module.css";

/** Minimal glyphs in the visualization grid's voice. */
function tileIcon(paths: ReactNode): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths}
    </svg>
  );
}

const TYPE_LABELS: Record<WidgetType, string> = {
  formula: "Formula",
  category: "Category",
  histogram: "Histogram",
  note: "Note",
};

const TYPE_ICONS: Record<WidgetType, ReactNode> = {
  formula: tileIcon(<path d="M9.5 4 7.5 20M16.5 4l-2 16M4 9.5h16M4 14.5h16" />),
  category: tileIcon(<path d="M4 6h12M4 12h16M4 18h8" />),
  histogram: tileIcon(<path d="M5 20v-9M10 20V5M15 20v-8M20 20v-5" />),
  note: tileIcon(
    <>
      <rect x="4.5" y="4.5" width="15" height="15" rx="3" />
      <path d="M8.5 10h7M8.5 14h4.5" />
    </>,
  ),
};

const FORMAT_LABELS: Record<WidgetFormat, string> = {
  compact: "Compact (12.3k)",
  percent: "Percent (1.0%)",
  percent2: "Percent (1.00%)",
  integer: "Integer",
  decimal1: "1 decimal",
  decimal2: "2 decimals",
};

/** The draft's form: the type-specific fields, the title, and the actions.
 *  Extracted from WidgetsTab — behavior unchanged. */
export function WidgetDraftEditor({
  draft,
  valid,
  layers,
  categoryFields,
  numericFields,
  patchDraft,
  onCancel,
  save,
}: {
  draft: Draft;
  valid: boolean;
  layers: Layer[];
  categoryFields: LayerField[];
  numericFields: LayerField[];
  patchDraft: (patch: Partial<Draft>) => void;
  onCancel: () => void;
  save: () => void;
}) {
  return (
    <div className={styles.form} data-widget-form data-no-dnd>
      {/* The one type control, present in every draft state — new, and
          all four types. It used to be two: a four-tile grid that
          started an add and then disappeared, and a three-way segment
          inside the editor that omitted Note, so leaving a note meant
          cancelling and starting over. */}
      <div className={styles.typeGrid} data-widget-type-grid>
        {WIDGET_TYPES.map((t) => {
          const needsLayer = t !== "note" && layers.length === 0;
          return (
            <button
              key={t}
              className={styles.typeTile}
              data-add-type={t}
              data-active={draft.type === t ? "" : undefined}
              aria-pressed={draft.type === t}
              disabled={needsLayer}
              data-hint={needsLayer ? "Add a layer first" : undefined}
              data-hint-always={needsLayer ? "" : undefined}
              aria-describedby={needsLayer ? `widget-reason-${t}` : undefined}
              onClick={() => patchDraft({ type: t })}
            >
              {needsLayer && (
                <span id={`widget-reason-${t}`} hidden>
                  Add a layer first
                </span>
              )}
              {TYPE_ICONS[t]}
              {TYPE_LABELS[t]}
            </button>
          );
        })}
      </div>

      {draft.type !== null && draft.type !== "note" && layers.length > 1 && (
        <label className={styles.field}>
          Layer
          <select
            value={draft.layerId ?? ""}
            onChange={(e) => patchDraft({ layerId: e.target.value })}
          >
            {layers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {draft.type === "formula" && (
        <label className={styles.field}>
          Aggregate
          <select
            value={draft.agg}
            onChange={(e) => patchDraft({ agg: e.target.value as WidgetAgg })}
          >
            {["count", "sum", "avg", "min", "max"].map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      )}

      {draft.type !== null &&
        draft.type !== "note" &&
        !(draft.type === "formula" && draft.agg === "count") && (
          <label className={styles.field}>
            {draft.type === "category" ? "Group by" : "Field"}
            <select
              value={draft.field ?? ""}
              onChange={(e) => patchDraft({ field: e.target.value || null })}
            >
              <option value="">Choose a field…</option>
              {(draft.type === "category" ? categoryFields : numericFields).map(
                (f) => (
                  <option key={f.name} value={f.name}>
                    {f.name}
                  </option>
                ),
              )}
            </select>
          </label>
        )}

      {draft.type === "category" && (
        <label className={styles.field}>
          Rank by
          <select
            value={draft.agg}
            onChange={(e) => patchDraft({ agg: e.target.value as WidgetAgg })}
          >
            <option value="count">count</option>
            <option value="sum">sum of…</option>
            <option value="avg">avg of…</option>
          </select>
        </label>
      )}

      {draft.type === "category" && draft.agg !== "count" && (
        <label className={styles.field}>
          Over field
          <select
            value={draft.aggField ?? ""}
            onChange={(e) => patchDraft({ aggField: e.target.value || null })}
          >
            <option value="">Choose a field…</option>
            {numericFields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {draft.type !== null && (
        <label className={styles.field}>
          Title
          <input
            value={draft.title}
            maxLength={WIDGET_TITLE_MAX}
            onChange={(e) =>
              patchDraft({ title: e.target.value, titled: true })
            }
          />
        </label>
      )}

      {draft.type === "formula" && (
        <>
          <label className={styles.field}>
            Unit
            <input
              value={draft.unit ?? ""}
              maxLength={WIDGET_UNIT_MAX}
              placeholder="km/h, trips, %…"
              onChange={(e) =>
                patchDraft({ unit: e.target.value || null })
              }
            />
          </label>
          <label className={styles.field}>
            Format
            <select
              value={draft.format ?? ""}
              onChange={(e) =>
                patchDraft({
                  format: (e.target.value || null) as WidgetFormat | null,
                })
              }
            >
              <option value="">Automatic</option>
              {WIDGET_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {FORMAT_LABELS[f]}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            Note
            <input
              value={draft.note ?? ""}
              maxLength={WIDGET_NOTE_MAX}
              placeholder="Caption under the number"
              onChange={(e) => patchDraft({ note: e.target.value || null })}
            />
          </label>
        </>
      )}

      {draft.type === "note" && (
        <label className={styles.field}>
          Text
          <textarea
            value={draft.note ?? ""}
            maxLength={WIDGET_NOTE_MAX}
            rows={4}
            placeholder={
              "Supports **bold**, *italic*, [links](https://…) " +
              'and "- " lists.'
            }
            onChange={(e) => patchDraft({ note: e.target.value || null })}
          />
        </label>
      )}

      <div className={styles.formActions}>
        <button onClick={onCancel}>Cancel</button>
        <button className={styles.save} disabled={!valid} onClick={save}>
          {draft.id === null
            ? draft.type === "note"
              ? "Add note"
              : "Add widget"
            : "Save"}
        </button>
      </div>
    </div>
  );
}
