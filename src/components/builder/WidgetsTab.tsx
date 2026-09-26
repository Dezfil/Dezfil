"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { LayerField } from "@/lib/layer-service";
import { MAX_WIDGETS, type MapWidget } from "@/lib/widgets";
import { SortableCards } from "../widgets/SortableCards";
import type { ReorderHandle } from "../reorder-a11y";
import { GripIcon, PlusIcon } from "../ui/icons";
import { SwitchRow } from "../ui/Switch";
import { WidgetDraftEditor } from "./widget-editor/WidgetDraftEditor";
import {
  draftOf,
  draftValid,
  emptyDraft,
  materialize as materializeDraft,
  nextDraft,
  type Draft,
} from "./widget-editor/draft";
import panel from "./panel.module.css";
import styles from "./WidgetsTab.module.css";

/**
 * The Widgets tab: dashboard cards — widgets and notes — as an accordion
 * of draggable rows. A row expands into its editor in place; adds append a
 * fresh expanded editor. Every change lands through one callback as the
 * full ordered list — the parent PATCHes the map, so undo/redo and the
 * assistant come free.
 */

/** A one-shot request to expand a widget's editor (the rail's ⋮). */
export interface WidgetFocus {
  id: string;
  nonce: number;
}



/** The id an unsaved add previews under; replaced by a real one on save. */
const DRAFT_PREVIEW_ID = "widget-draft-preview";

export function WidgetsTab({
  map,
  focus,
  onChange,
  onPreview,
  onPublishedToggle,
}: {
  map: MapWithLayers;
  /** Set when a rail card's ⋮ asked for this widget's editor. */
  focus?: WidgetFocus | null;
  onChange: (widgets: MapWidget[]) => void;
  /** The open editor's state as a live widget —
   *  null when no editor is open or the draft is not yet valid. The
   *  parent overlays it so the rail previews edits in real time. */
  onPreview?: (widget: MapWidget | null) => void;
  onPublishedToggle: (on: boolean) => void;
}) {
  const widgets = map.widgets;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [fieldsByLayer, setFieldsByLayer] = useState<
    Record<string, LayerField[]>
  >({});
  const listRef = useRef<HTMLDivElement | null>(null);

  // The rail's ⋮ opens this row's editor — a one-shot request consumed
  // with the render-phase "previous render info" pattern (the NotePanel
  // reconciliation approach), never an effect.
  const [seenFocus, setSeenFocus] = useState<number | null>(null);
  if (focus && focus.nonce !== seenFocus) {
    setSeenFocus(focus.nonce);
    const widget = widgets.find((w) => w.id === focus.id);
    if (widget) setDraft(draftOf(widget));
  }

  // Field options for the draft's layer, cached per layer id.
  const draftLayer = draft?.layerId ?? null;
  useEffect(() => {
    if (!draftLayer || fieldsByLayer[draftLayer]) return;
    let stale = false;
    void fetch(`/api/layers/${draftLayer}/fields`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { filterable?: LayerField[] } | null) => {
        if (!stale && body?.filterable) {
          setFieldsByLayer((prev) => ({
            ...prev,
            [draftLayer]: body.filterable!,
          }));
        }
      });
    return () => {
      stale = true;
    };
  }, [draftLayer, fieldsByLayer]);

  const fields = useMemo(
    () => (draftLayer ? (fieldsByLayer[draftLayer] ?? []) : []),
    [draftLayer, fieldsByLayer],
  );
  const numericFields = useMemo(
    () => fields.filter((f) => f.kind === "numeric"),
    [fields],
  );
  const categoryFields = useMemo(
    // Any non-time field can group; text is the common case, and low-
    // cardinality numerics group fine through the VARCHAR cast.
    () => fields.filter((f) => f.kind !== "time"),
    [fields],
  );

  const patchDraft = useCallback(
    (patch: Partial<Draft>) =>
      setDraft((d) =>
        d === null ? d : nextDraft(d, patch, map.layers[0]?.id ?? null),
      ),
    [map.layers],
  );

  const valid = draft !== null && draftValid(draft);

  const materialize = useCallback(
    (d: Draft): MapWidget =>
      materializeDraft(
        d,
        d.id ?? DRAFT_PREVIEW_ID,
        d.id === null
          ? true
          : (widgets.find((w) => w.id === d.id)?.visible ?? true),
      ),
    [widgets],
  );

  // The rail previews the open editor live: every valid keystroke flows
  // up as an overlay widget; nothing writes until Save. Keyed on the
  // serialized shape so identical states don't churn.
  const previewKey =
    draft && valid ? JSON.stringify(materialize(draft)) : "";
  useEffect(() => {
    if (!onPreview) return;
    onPreview(previewKey ? (JSON.parse(previewKey) as MapWidget) : null);
  }, [previewKey, onPreview]);
  useEffect(() => {
    if (!onPreview) return;
    return () => onPreview(null);
  }, [onPreview]);

  const save = useCallback(() => {
    if (!draft || !valid) return;
    const widget: MapWidget = {
      ...materialize(draft),
      id: draft.id ?? crypto.randomUUID(),
    };
    // Clear the preview in the same commit as the list change, so the
    // saved widget and its preview never coexist for a frame.
    onPreview?.(null);
    onChange(
      draft.id === null
        ? [...widgets, widget]
        : widgets.map((w) => (w.id === draft.id ? widget : w)),
    );
    setDraft(null);
  }, [draft, valid, widgets, onChange, onPreview, materialize]);

  const editor = useMemo(() => draft && (
    <WidgetDraftEditor
      draft={draft}
      valid={valid}
      layers={map.layers}
      categoryFields={categoryFields}
      numericFields={numericFields}
      patchDraft={patchDraft}
      onCancel={() => setDraft(null)}
      save={save}
    />
  ), [
    draft,
    valid,
    map.layers,
    categoryFields,
    numericFields,
    patchDraft,
    save,
  ]);

  const row = useCallback(
    (
      id: string,
      floating: boolean,
      dragging?: boolean,
      handle?: ReorderHandle,
    ) => {
      const w = widgets.find((x) => x.id === id);
      if (!w) return null;
      const expanded = !floating && !dragging && draft?.id === w.id;
      return (
        <div
          className={styles.row}
          data-hidden={w.visible ? undefined : ""}
          data-widget-row
          data-expanded={expanded ? "" : undefined}
        >
          <div
            className={styles.rowHead}
            role="button"
            tabIndex={0}
            aria-label={`${w.title} widget`}
            aria-expanded={expanded}
            onClick={() => setDraft(expanded ? null : draftOf(w))}
            onKeyDown={(e) => {
              // Only the head itself expands — keys on the grip (the
              // keyboard reorder activator) or the row buttons bubble
              // through here and must not toggle the editor.
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setDraft(expanded ? null : draftOf(w));
              }
            }}
          >
            <button
              type="button"
              ref={handle?.ref}
              {...handle?.attributes}
              className={`${styles.grip} ${panel.hint}`}
              data-hint="Drag or Space to reorder"
              aria-label={`Reorder ${w.title}`}
            >
              <GripIcon />
            </button>
            <div className={styles.name}>
              <strong>{w.title}</strong>
              {/* The kind alone (tail) — the field and layer tail
                  retired at the sitting. */}
              <small>{w.type}</small>
            </div>
            {/* The eye button, kept by a field ruling (08-20, misread
                of tail) — the deliberate exception to the switch rule
                for these rows. */}
            <button
              className={styles.rowBtn}
              data-no-dnd
              title={w.visible ? "Hide" : "Show"}
              aria-label={`${w.visible ? "Hide" : "Show"} ${w.title}`}
              aria-pressed={!w.visible}
              onClick={(e) => {
                e.stopPropagation();
                onChange(
                  widgets.map((x) =>
                    x.id === w.id ? { ...x, visible: !x.visible } : x,
                  ),
                );
              }}
            >
              <svg
                viewBox="0 0 24 24"
                width="15"
                height="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
                <circle cx="12" cy="12" r="3" />
                {!w.visible && <path d="M4 4l16 16" />}
              </svg>
            </button>
            <button
              className={styles.rowBtn}
              data-no-dnd
              title={w.type === "note" ? "Delete note" : "Delete widget"}
              aria-label={`${w.type === "note" ? "Delete note" : "Delete widget"} ${w.title}`}
              onClick={(e) => {
                e.stopPropagation();
                if (draft?.id === w.id) {
                  setDraft(null);
                  onPreview?.(null);
                }
                onChange(widgets.filter((x) => x.id !== w.id));
              }}
            >
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15" />
              </svg>
            </button>
          </div>
          {expanded && editor}
        </div>
      );
    },
    [widgets, draft, editor, onChange, onPreview],
  );

  const adding = draft !== null && draft.id === null;
  return (
    <div className={styles.pane} data-widgets-tab ref={listRef}>
      <h4 className={panel.sectionLabel}>Widgets</h4>

      {widgets.length === 0 && !adding && (
        <p className={styles.empty}>No widgets yet.</p>
      )}

      <SortableCards
        ids={widgets.map((w) => w.id)}
        onReorder={(ids) =>
          onChange(
            ids
              .map((id) => widgets.find((w) => w.id === id))
              .filter((w): w is MapWidget => w !== undefined),
          )
        }
        render={row}
        overlayWidth="100%"
        keyboardNames={new Map(widgets.map((w) => [w.id, w.title]))}
      />

      {adding && <div className={styles.row}>{editor}</div>}

      {/* One click opens the editor untyped; the four type cards are the
          editor's own header, so the grid that used to unfold here and
          then disappear is gone. */}
      {!adding && widgets.length < MAX_WIDGETS && (
        <button
          className={styles.add}
          onClick={() => setDraft(emptyDraft())}
          data-add-widget-row
        >
          <PlusIcon /> Add widget
        </button>
      )}

      <div className={styles.toggleRow}>
        <SwitchRow
          label="Show widgets on published view"
          checked={map.widgetsPublished}
          onChange={(e) => onPublishedToggle(e.target.checked)}
        />
      </div>
    </div>
  );
}
