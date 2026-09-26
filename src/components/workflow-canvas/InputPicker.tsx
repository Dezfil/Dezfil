"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { usePopoverDismiss } from "../ui/Popover";
import { ChevronIcon, SearchIcon } from "../ui/icons";
import { GeometryGlyph } from "../ui/operation-icons";
import { currentOption, type PickerOption } from "./node-panel-model";
import styles from "./InputPicker.module.css";

/**
 * The input picker: the node panel's choice of a named input. Closed, a
 * row like the pane's for what is chosen (glyph, name, fact), or *not
 * set*; open, a popover with its search focused and three groups, the
 * refused rows greyed with their reason on a second line. A combobox to
 * the keyboard: arrows traverse every row so each reason can be read,
 * Enter chooses an accepted one, Escape closes and returns focus. The
 * choice itself is the panel's: this control only says what was picked.
 */

export interface PickerGroups {
  accepted: PickerOption[];
  refused: PickerOption[];
  elsewhere: PickerOption[];
}

type Row = { key: string; option: PickerOption | null; refused: boolean };

const kindOf = (o: PickerOption | null): string => (o ? (o.kind === "none" || o.kind === "unknown" ? "none" : "spatial") : "none");

export function InputPicker({
  id,
  name,
  label,
  current,
  options,
  disabled = false,
  disabledReason = null,
  onPick,
}: {
  id: string;
  /** The input's stable name, for the tests' hooks. */
  name: string;
  label: string;
  current: string | null;
  options: PickerGroups;
  disabled?: boolean;
  /** Why the picker is inert, said to assistive technology. */
  disabledReason?: string | null;
  onPick: (value: string | null) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();

  const chosen = useMemo(() => currentOption(current, options), [current, options]);
  const q = query.trim().toLowerCase();
  const keep = (o: PickerOption) => !q || o.label.toLowerCase().includes(q);
  const groups = useMemo(
    () =>
      [
        { key: "canvas", title: "On the canvas", rows: options.accepted.filter(keep), refused: false },
        { key: "tables", title: "Workspace tables", rows: options.elsewhere.filter(keep), refused: false },
        { key: "refused", title: "Not accepted here", rows: options.refused.filter(keep), refused: true },
      ].filter((g) => g.rows.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options, q],
  );
  // The flat order the arrows walk: *not set* first on an unfiltered list.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (!q) out.push({ key: "unset", option: null, refused: false });
    for (const g of groups) for (const o of g.rows) out.push({ key: rowKey(g.key, o), option: o, refused: g.refused });
    return out;
  }, [groups, q]);
  const rowId = (key: string) => `${listId}-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  // An inert picker is closed (an unsettled or locked node), and stays
  // closed once the node is settled again: the stored state resets with
  // the transition, in render.
  if (disabled && opened) setOpened(false);
  const open = opened && !disabled;
  // The active row, kept inside the list as the filter shortens it.
  const activeIndex = rows.length ? Math.min(active, rows.length - 1) : 0;
  const close = () => {
    setOpened(false);
    setQuery("");
  };
  const openIt = () => {
    if (disabled) return;
    setQuery("");
    setActive(0);
    setOpened(true);
  };
  usePopoverDismiss({ open, onClose: close, contentRef: pop, triggerRef: trigger });
  useEffect(() => {
    if (open) search.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const el = document.getElementById(rowId(rows[activeIndex]?.key ?? ""));
    el?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, open]);

  const choose = (row: Row) => {
    if (row.refused) return;
    onPick(row.option ? row.option.name : null);
    close();
    trigger.current?.focus();
  };
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!rows.length) return;
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : Math.max(0, rows.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[activeIndex];
      if (row) choose(row);
    } else if (e.key === "Escape") {
      // The picker's own Escape: closed here, before the canvas's document
      // listener would read the key as "clear the selection" and close the panel.
      e.preventDefault();
      e.stopPropagation();
      close();
      trigger.current?.focus();
    } else if (e.key === "Tab") {
      close();
    }
  };
  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (open) close();
      else openIt();
    }
  };

  const activeRow = open ? rows[activeIndex] : undefined;
  const chosenRefused = chosen !== null && chosen.reason !== null;
  const whyId = `${listId}-current-why`;
  return (
    <div className={styles.wrap} data-input-picker={name}>
      <button
        ref={trigger}
        type="button"
        id={id}
        className={styles.trigger}
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={activeRow ? rowId(activeRow.key) : undefined}
        aria-describedby={chosenRefused ? whyId : disabledReason ? `${listId}-inert` : undefined}
        disabled={disabled}
        data-input={name}
        data-value={chosen?.name ?? ""}
        data-refused={chosenRefused || undefined}
        onClick={() => (open ? close() : openIt())}
        onKeyDown={onTriggerKey}
      >
        <span className={styles.glyph} data-kind={kindOf(chosen)}>
          <GeometryGlyph geometryType={chosen ? glyphType(chosen.kind) : null} />
        </span>
        {chosen ? (
          <>
            <span className={styles.name}>{chosen.label}</span>
            <span className={styles.fact}>{chosen.node ? <span className={styles.nodeTag}>node</span> : chosen.fact}</span>
          </>
        ) : (
          <>
            <span className={styles.name} data-unset>
              not set
            </span>
            <span className={styles.fact} />
          </>
        )}
        <ChevronIcon />
      </button>
      {chosenRefused ? (
        <p className={styles.currentWhy} id={whyId} data-current-refused>
          Not accepted: {chosen.reason}
        </p>
      ) : null}
      {disabledReason ? (
        <span id={`${listId}-inert`} hidden>
          {disabledReason}
        </span>
      ) : null}
      {open ? (
        <div ref={pop} className={styles.pop} data-picker-pop>
          <div className={styles.search}>
            <SearchIcon />
            <input
              ref={search}
              type="text"
              value={query}
              placeholder="Search sources…"
              aria-label={`Search ${label.toLowerCase()}`}
              aria-controls={listId}
              aria-activedescendant={activeRow ? rowId(activeRow.key) : undefined}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onSearchKey}
            />
          </div>
          <ul id={listId} role="listbox" aria-label={label} className={styles.list}>
            {!q ? (
              <li
                id={rowId("unset")}
                role="option"
                aria-selected={current === null || current === ""}
                className={`${styles.row} ${styles.unset}`}
                data-active={activeRow?.key === "unset" || undefined}
                data-on={current === null || current === "" || undefined}
                onMouseEnter={() => setActive(0)}
                onClick={() => choose({ key: "unset", option: null, refused: false })}
              >
                <span className={styles.glyph} data-kind="none">
                  <GeometryGlyph geometryType={null} />
                </span>
                <span className={styles.name}>not set</span>
                <span className={styles.fact} />
              </li>
            ) : null}
            {groups.map((g) => (
              <li key={g.key} role="presentation">
                <p className={styles.eyebrow} id={`${listId}-${g.key}`}>
                  {g.title}
                </p>
                <ul role="group" aria-labelledby={`${listId}-${g.key}`} className={styles.group} data-picker-group={g.key}>
                  {g.rows.map((o) => {
                    const key = rowKey(g.key, o);
                    const on = o.name !== "" && current !== null && current.toLowerCase() === o.name.toLowerCase();
                    const whyRow = `${rowId(key)}-why`;
                    return (
                      <li
                        key={key}
                        id={rowId(key)}
                        role="option"
                        aria-selected={on}
                        aria-disabled={g.refused || undefined}
                        aria-describedby={g.refused ? whyRow : undefined}
                        className={styles.row}
                        data-active={activeRow?.key === key || undefined}
                        data-on={on || undefined}
                        data-refused={g.refused || undefined}
                        data-option={o.name || undefined}
                        onMouseEnter={() => setActive(rows.findIndex((r) => r.key === key))}
                        onClick={() => choose({ key, option: o, refused: g.refused })}
                      >
                        <span className={styles.glyph} data-kind={kindOf(o)}>
                          <GeometryGlyph geometryType={glyphType(o.kind)} />
                        </span>
                        <span className={styles.name}>{o.label}</span>
                        <span className={styles.fact}>{o.node ? <span className={styles.nodeTag}>{o.fact === "not named" ? "not named" : "node"}</span> : o.fact}</span>
                        {g.refused ? (
                          <span className={styles.why} id={whyRow}>
                            {o.reason}
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
            {rows.length === 0 ? (
              <li role="presentation" className={styles.none}>
                No source matches “{query.trim()}”.
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** A row's key: its name, or its node's id for an output not named yet. */
const rowKey = (group: string, o: PickerOption) => `${group}:${o.name || `#${o.id ?? o.label}`}`;

/** The geometry type string the shared glyph draws for a class. */
function glyphType(kind: PickerOption["kind"]): string | null {
  if (kind === "point") return "POINT";
  if (kind === "line") return "LINESTRING";
  if (kind === "polygon") return "POLYGON";
  return null;
}
