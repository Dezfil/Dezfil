"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { ErrorNote } from "../ui/ErrorNote";
import { Menu, MenuItem } from "../ui/Menu";
import { MoreIcon } from "../ui/icons";
import type { WidgetValues, WidgetValue } from "@/lib/widget-service";
import { renderNoteBody } from "@/lib/note-markdown";
import {
  formatWidgetNumber,
  type MapWidget,
  type WidgetSelection,
} from "@/lib/widgets";
import { SortableCards } from "./SortableCards";
import { failureProse, type AnswerState } from "./dashboard-state";
import styles from "./Widgets.module.css";

/**
 * The stage's dashboard column: formula, category, histogram, and note
 * cards in rail order, shared by the builder and the published viewer.
 * Cards render current values from the batched read; category clicks
 * toggle exclusion and a histogram brush reports a range — the hook owns
 * state. In the builder, cards drag to reorder and carry a overflow menu
 * (options / clear / delete).
 */

type FormulaValue = Extract<WidgetValue, { type: "formula" }>;
type CategoryValue = Extract<WidgetValue, { type: "category" }>;
type HistogramValue = Extract<WidgetValue, { type: "histogram" }>;

function formatCount(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (Number.isInteger(n)) return n.toLocaleString();
  return abs >= 100 ? n.toFixed(0) : n.toFixed(abs >= 1 ? 1 : 2);
}

/** How much room the tallest menu needs before it flips upward. */

/** The card's menu; absent entries hide their row. Behaviour is the kit's
 * Menu contract — it used to declare the roles and implement none of the
 * keyboard model. Two things stay local: the menu portals into the
 * theme-scoped wrapper on a published page so the reader's effective
 * theme reaches it, and the trigger keeps its drag opt-out. */
function CardMenu({
  onOptions,
  onClear,
  onDelete,
  deleteLabel,
}: {
  onOptions?: () => void;
  onClear?: () => void;
  onDelete?: () => void;
  deleteLabel: string;
}) {
  if (!onOptions && !onClear && !onDelete) return null;
  const item = (label: string, act: () => void, danger?: boolean) => (
    <MenuItem onSelect={act} danger={danger}>
      {label}
    </MenuItem>
  );
  return (
    <Menu
      className={styles.menuWrap}
      label="Widget menu"
      triggerClassName={styles.menuBtn}
      triggerProps={{ title: "Widget menu" }}
      // Sortable cards start a drag from any pointer press that is not an
      // input or inside a data-no-dnd subtree: without this the menu press
      // drags the card instead of opening.
      data-no-dnd
      trigger={<MoreIcon />}
      menuClassName={styles.menu}
      portalTarget={(from) => from.closest("[data-published-view]")}
    >
      {onOptions && item("Widget options", onOptions)}
      {onClear && item("Clear selection", onClear)}
      {onDelete && item(deleteLabel, onDelete, true)}
    </Menu>
  );
}

function FormulaCard({
  widget,
  value,
  menu,
}: {
  widget: MapWidget;
  value: FormulaValue | null;
  menu: ReactNode;
}) {
  const constrained =
    value !== null &&
    value.baseline !== null &&
    value.value !== value.baseline;
  return (
    <div className={styles.card} data-widget-card="formula">
      <div className={styles.head}>
        <span className={styles.title}>{widget.title}</span>
        {menu}
      </div>
      <div className={styles.big}>
        {formatWidgetNumber(value?.value ?? null, widget.format)}
        {widget.unit && <small> {widget.unit}</small>}
      </div>
      {widget.note && <div className={styles.caption}>{widget.note}</div>}
      {constrained && (
        <div className={styles.sub}>
          filtered from {formatWidgetNumber(value.baseline, widget.format)}
        </div>
      )}
    </div>
  );
}

function NoteCard({
  widget,
  menu,
}: {
  widget: MapWidget;
  menu: ReactNode;
}) {
  return (
    <div className={styles.card} data-widget-card="note">
      <div className={styles.head}>
        <span className={styles.title}>{widget.title}</span>
        {menu}
      </div>
      <div className={styles.noteBody}>
        {renderNoteBody(widget.note ?? "")}
      </div>
    </div>
  );
}

function CategoryCard({
  widget,
  value,
  selection,
  onToggle,
  menu,
}: {
  widget: MapWidget;
  value: CategoryValue | null;
  selection: WidgetSelection | undefined;
  onToggle: (value: string) => void;
  menu: ReactNode;
}) {
  // Exclusion semantics: everything is active unless named.
  const excluded = new Set(
    selection?.kind === "exclude" ? selection.values : [],
  );
  const rows = value?.categories ?? [];
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <div className={styles.card} data-widget-card="category">
      <div className={styles.head}>
        <span className={styles.title}>{widget.title}</span>
        {menu}
      </div>
      <div data-no-dnd>
        {rows.map((row) => (
          <button
            key={row.value}
            className={styles.crow}
            data-active={excluded.has(row.value) ? undefined : ""}
            onClick={() => onToggle(row.value)}
          >
            <span className={styles.cname} title={row.value}>
              {row.value}
            </span>
            <span className={styles.cbar}>
              <i style={{ width: `${Math.max(2, (row.n / max) * 100)}%` }} />
            </span>
            <span className={styles.cnum}>{formatCount(row.n)}</span>
          </button>
        ))}
        {value?.other !== null && value?.other !== undefined && (
          <div className={styles.otherRow}>
            <span className={styles.cname}>Other</span>
            <span className={styles.cbar}>
              <i
                style={{ width: `${Math.max(2, (value.other / max) * 100)}%` }}
              />
            </span>
            <span className={styles.cnum}>{formatCount(value.other)}</span>
          </div>
        )}
        {rows.length === 0 && (
          <div className={styles.sub}>No categories to show.</div>
        )}
      </div>
    </div>
  );
}

function HistogramCard({
  widget,
  value,
  selection,
  onBrush,
  menu,
}: {
  widget: MapWidget;
  value: HistogramValue | null;
  selection: WidgetSelection | undefined;
  onBrush: (min: number | null, max: number | null) => void;
  menu: ReactNode;
}) {
  const domain = value?.domain ?? null;
  const settled: [number | null, number | null] =
    selection?.kind === "range" ? [selection.min, selection.max] : [null, null];
  // The card brushes its own display instantly; the selection commits on
  // release (others settle then).
  const [draft, setDraft] = useState<[number, number] | null>(null);
  const barsRef = useRef<HTMLDivElement | null>(null);

  const span = domain ? domain.max - domain.min : 0;
  const lo = draft?.[0] ?? settled[0] ?? domain?.min ?? 0;
  const hi = draft?.[1] ?? settled[1] ?? domain?.max ?? 0;
  const pct = useCallback(
    (v: number) =>
      domain && span > 0
        ? Math.min(100, Math.max(0, ((v - domain.min) / span) * 100))
        : 0,
    [domain, span],
  );

  const valueAt = useCallback(
    (clientX: number): number => {
      const el = barsRef.current;
      if (!el || !domain || span <= 0) return domain?.min ?? 0;
      const rect = el.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return domain.min + t * span;
    },
    [domain, span],
  );

  // Gestures always release: the window listeners come off on release, on
  // cancellation (touch takeover), and on unmount — never left tracking a
  // pointer that is gone. A cancelled brush commits nothing; this card
  // renders for anonymous readers in the published rail, where a stuck
  // brush would be a phantom cross-filter.
  const teardown = useRef<(() => void) | null>(null);
  useEffect(() => () => teardown.current?.(), []);

  // Keyboard nudges: arrows move a handle by 1% of the domain and the
  // selection settles once, trailing the last tap or the handle's blur —
  // the timeline's idiom, through the same commit path as the pointer,
  // in the builder and the published rail alike.
  const keySettle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingKey = useRef<[number, number] | null>(null);
  const clearKeySettle = useCallback(() => {
    if (keySettle.current) clearTimeout(keySettle.current);
    keySettle.current = null;
    pendingKey.current = null;
  }, []);
  useEffect(() => clearKeySettle, [clearKeySettle]);
  const settleKey = useCallback(() => {
    keySettle.current = null;
    const next = pendingKey.current;
    pendingKey.current = null;
    if (!next || !domain) return;
    setDraft(null);
    // A brush spanning the whole domain means no constraint.
    if (next[0] <= domain.min && next[1] >= domain.max) {
      onBrush(null, null);
    } else {
      onBrush(next[0], next[1]);
    }
  }, [domain, onBrush]);
  const nudge = useCallback(
    (edge: "lo" | "hi") => (e: ReactKeyboardEvent) => {
      if (!domain || span <= 0) return;
      const dir =
        e.key === "ArrowRight" || e.key === "ArrowUp"
          ? 1
          : e.key === "ArrowLeft" || e.key === "ArrowDown"
            ? -1
            : 0;
      if (!dir) return;
      e.preventDefault();
      const step = (dir * span) / 100;
      const next: [number, number] =
        edge === "lo"
          ? [Math.min(Math.max(domain.min, lo + step), hi), hi]
          : [lo, Math.max(Math.min(domain.max, hi + step), lo)];
      pendingKey.current = next;
      setDraft(next);
      if (keySettle.current) clearTimeout(keySettle.current);
      keySettle.current = setTimeout(settleKey, 600);
    },
    [domain, span, lo, hi, settleKey],
  );
  const flushKeySettle = useCallback(() => {
    if (!keySettle.current) return;
    clearTimeout(keySettle.current);
    settleKey();
  }, [settleKey]);

  const drag = useCallback(
    (edge: "lo" | "hi") => (down: ReactPointerEvent) => {
      if (!domain || teardown.current) return;
      // A pointer grab takes over: a pending keyboard settle would race
      // the pointer's own commit, so it is dropped, not flushed.
      clearKeySettle();
      down.preventDefault();
      const start: [number, number] = [lo, hi];
      const move = (e: PointerEvent) => {
        const v = valueAt(e.clientX);
        setDraft(
          edge === "lo"
            ? [Math.min(v, start[1]), start[1]]
            : [start[0], Math.max(v, start[0])],
        );
      };
      const end = () => {
        teardown.current?.();
        teardown.current = null;
      };
      const up = (e: PointerEvent) => {
        end();
        const v = valueAt(e.clientX);
        const next: [number, number] =
          edge === "lo"
            ? [Math.min(v, start[1]), start[1]]
            : [start[0], Math.max(v, start[0])];
        setDraft(null);
        // A brush spanning the whole domain means no constraint.
        if (next[0] <= domain.min && next[1] >= domain.max) {
          onBrush(null, null);
        } else {
          onBrush(next[0], next[1]);
        }
      };
      const cancel = () => {
        end();
        setDraft(null);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      teardown.current = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
      };
    },
    [domain, lo, hi, valueAt, onBrush, clearKeySettle],
  );

  const bins = value?.bins ?? [];
  const maxBin = Math.max(1, ...bins);
  const active = selection !== undefined || draft !== null;
  return (
    <div className={styles.card} data-widget-card="histogram">
      <div className={styles.head}>
        <span className={styles.title}>{widget.title}</span>
        {active && domain && (
          <span className={styles.range}>
            {formatCount(lo)} – {formatCount(hi)}
          </span>
        )}
        {menu}
      </div>
      <div className={styles.hist} data-no-dnd>
        <div className={styles.hbars} ref={barsRef}>
          {bins.map((n, i) => {
            const binLo = domain ? domain.min + (span * i) / bins.length : 0;
            const binHi = domain
              ? domain.min + (span * (i + 1)) / bins.length
              : 0;
            const out = active && domain && (binHi < lo || binLo > hi);
            return (
              <i
                key={i}
                data-out={out ? "" : undefined}
                style={{ height: `${Math.max(4, (n / maxBin) * 100)}%` }}
              />
            );
          })}
          {bins.length === 0 && <div className={styles.sub}>No spread.</div>}
        </div>
        {domain && bins.length > 0 && (
          <>
            <button
              className={styles.brushHandle}
              style={{ left: `${pct(lo)}%` }}
              onPointerDown={drag("lo")}
              onKeyDown={nudge("lo")}
              onBlur={flushKeySettle}
              role="slider"
              aria-label={`${widget.title} range start`}
              aria-orientation="horizontal"
              aria-valuemin={domain.min}
              aria-valuemax={hi}
              aria-valuenow={lo}
              aria-valuetext={formatCount(lo)}
            />
            <button
              className={styles.brushHandle}
              style={{ left: `${pct(hi)}%` }}
              onPointerDown={drag("hi")}
              onKeyDown={nudge("hi")}
              onBlur={flushKeySettle}
              role="slider"
              aria-label={`${widget.title} range end`}
              aria-orientation="horizontal"
              aria-valuemin={lo}
              aria-valuemax={domain.max}
              aria-valuenow={hi}
              aria-valuetext={formatCount(hi)}
            />
          </>
        )}
      </div>
      {domain && (
        <div className={styles.axis}>
          <span>{formatCount(domain.min)}</span>
          <span>{formatCount(domain.max)}</span>
        </div>
      )}
    </div>
  );
}

export function WidgetRail({
  widgets,
  values,
  valuesState = { status: "current", error: null },
  audience = "author",
  onRetryValues,
  selections,
  onToggleCategory,
  onBrush,
  onClear,
  onOptions,
  onDelete,
  onReorder,
  widgetsOnlyRef,
  children,
}: {
  widgets: MapWidget[];
  values: WidgetValues | null;
  /** Truth state of the batched values: while updating, prior
   * numbers show only marked stale; failed replaces every data card. */
  valuesState?: AnswerState;
  /** Who is looking: authors keep raw failure detail, readers get the
   * documented catalogue prose keyed on the code. */
  audience?: "author" | "reader";
  /** Re-run a failed values fetch under the same conditions. */
  onRetryValues?: () => void;
  selections: WidgetSelection[];
  onToggleCategory: (widgetId: string, value: string) => void;
  onBrush: (widgetId: string, min: number | null, max: number | null) => void;
  /** Clear a widget's selection (overflow menu). */
  onClear?: (widgetId: string) => void;
  /** Builder only: open the Widgets tab with this widget's editor. */
  onOptions?: (widgetId: string) => void;
  /** Builder only: delete the widget. */
  onDelete?: (widgetId: string) => void;
  /** Builder only: drag-reorder of the visible cards. */
  onReorder?: (visibleIds: string[]) => void;
  /** The widgets-only extent, excluding cards docked through `children`.
   * Legend placement measures this stable box to avoid feedback. */
  widgetsOnlyRef?: Ref<HTMLDivElement>;
  /** Cards docked into the rail (the legend) render after the widgets. */
  children?: ReactNode;
}) {
  const valueById = useMemo(() => {
    const out = new Map<string, WidgetValue>();
    for (const v of values?.widgets ?? []) out.set(v.id, v);
    return out;
  }, [values]);

  const card = useCallback(
    (id: string, floating: boolean) => {
      const w = widgets.find((x) => x.id === id);
      if (!w) return null;
      const selection = selections.find((s) => s.widgetId === w.id);
      const menu = floating ? null : (
        <CardMenu
          onOptions={onOptions ? () => onOptions(w.id) : undefined}
          onClear={
            onClear && selection !== undefined
              ? () => onClear(w.id)
              : undefined
          }
          onDelete={onDelete ? () => onDelete(w.id) : undefined}
          deleteLabel={w.type === "note" ? "Delete note" : "Delete widget"}
        />
      );
      // Notes are authored text — no computation, no truth state.
      if (w.type === "note") return <NoteCard widget={w} menu={menu} />;
      // A failed batch moves every data card to the failed state: no
      // last number presented as current.
      if (valuesState.status === "failed") {
        return (
          <div className={styles.card} data-card-failed>
            <div className={styles.head}>
              <span className={styles.title}>{w.title}</span>
              {menu}
            </div>
            {/* The batch failure's announcing note is the rail banner;
                each failed card mirrors it quietly. */}
            <ErrorNote
              tone="warn"
              announce={false}
              message={failureProse(valuesState.error, audience)}
            />
          </div>
        );
      }
      const v = valueById.get(w.id) ?? null;
      if (v && "error" in v) {
        // One widget could not compute inside a successful batch —
        // failed, with the documented coded reason. The batch
        // succeeded, so no rail-level retry is showing: this card
        // carries its own, or a transient query failure would sit until
        // an unrelated condition changed.
        return (
          <div className={styles.card} data-card-failed>
            <div className={styles.head}>
              <span className={styles.title}>{w.title}</span>
              {menu}
            </div>
            <ErrorNote
              tone="warn"
              message={failureProse(
                { code: v.errorCode ?? "internal", message: v.error },
                audience,
              )}
              onRetry={onRetryValues}
            />
          </div>
        );
      }
      // Never computed and computing now: loading, distinguishable from a
      // computed empty answer. "Updating" counts too — a widget added
      // beside already-answered ones has no entry yet, and an
      // empty-looking card would be exactly the lie the contract forbids.
      if (
        v === null &&
        (valuesState.status === "loading" || valuesState.status === "updating")
      ) {
        return (
          <div className={styles.card} data-card-loading>
            <div className={styles.head}>
              <span className={styles.title}>{w.title}</span>
              {menu}
            </div>
            <div className={styles.cardLoading}>Computing…</div>
          </div>
        );
      }
      const ok = v && !("error" in v) ? v : null;
      if (w.type === "formula") {
        return (
          <FormulaCard
            widget={w}
            value={ok?.type === "formula" ? ok : null}
            menu={menu}
          />
        );
      }
      if (w.type === "category") {
        return (
          <CategoryCard
            widget={w}
            value={ok?.type === "category" ? ok : null}
            selection={selection}
            onToggle={(value) => onToggleCategory(w.id, value)}
            menu={menu}
          />
        );
      }
      return (
        <HistogramCard
          widget={w}
          value={ok?.type === "histogram" ? ok : null}
          selection={selection}
          onBrush={(min, max) => onBrush(w.id, min, max)}
          menu={menu}
        />
      );
    },
    [
      widgets,
      selections,
      valueById,
      valuesState,
      audience,
      onToggleCategory,
      onBrush,
      onClear,
      onOptions,
      onDelete,
      onRetryValues,
    ],
  );

  if (widgets.length === 0 && !children) return null;
  const ids = widgets.map((w) => w.id);
  const hasDataCards = widgets.some((w) => w.type !== "note");
  return (
    <aside
      className={styles.rail}
      aria-label="Map widgets"
      aria-busy={valuesState.status === "updating" || undefined}
      data-widget-rail
      data-values-state={valuesState.status}
      data-draggable={onReorder ? "" : undefined}
    >
      <div
        className={styles.widgetStack}
        data-widget-stack
        ref={widgetsOnlyRef}
      >
        {valuesState.status === "failed" && hasDataCards && (
          <div className={styles.noteFloat} data-rail-error>
            <ErrorNote
              tone="warn"
              message={
                <>
                  Widgets couldn&apos;t update:{" "}
                  {failureProse(valuesState.error, audience)}
                </>
              }
              onRetry={onRetryValues}
            />
          </div>
        )}
        {onReorder ? (
          <SortableCards
            ids={ids}
            onReorder={onReorder}
            render={card}
            overlayWidth={248}
          />
        ) : (
          ids.map((id) => <div key={id}>{card(id, false)}</div>)
        )}
      </div>
      {children}
    </aside>
  );
}
