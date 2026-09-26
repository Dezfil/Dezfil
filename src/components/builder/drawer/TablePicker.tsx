"use client";

import { useEffect, useRef, useState } from "react";
import { formatCount, type TableListing } from "../../api";
import { geometryGlyphType } from "../../geometry-class";
import {
  acceptsTable,
  geometryClass,
  groupTables,
  refusalFor,
} from "./derived-tables";
import { tablesNamedIn } from "./operation-form";
import { armPick, armedPickLabel, disarmPick, usePickMode } from "./pick-mode";
import { GeometryGlyph } from "../../ui/operation-icons";
import { CursorIcon, SearchIcon } from "../../ui/icons";
import type { RecipeSummary } from "./recipe-model";
import styles from "./ParameterForm.module.css";

/**
 * Choosing an input — two modes, Search | Select.
 *
 * **Search shows no list until its field is focused** — nothing is
 * pre-loaded at the user — and, focused, Tool outputs group above Workspace
 * tables, filtered as they type. **Select** arms the builder: the next
 * eligible layer card, or a rendered feature of one, chooses its owning
 * layer's table; a layer that does not resolve to exactly one compatible
 * table refuses in words and leaves the mode armed (D5). A chosen input
 * locks to a row with the two facts that decide whether an operation is
 * legal — feature count and geometry class — and a *Change* action.
 */
export function TablePicker({
  tables,
  recipes,
  mapId,
  accepts,
  value,
  onPick,
  onPickContext,
  label,
}: {
  tables: TableListing[];
  recipes: RecipeSummary[];
  /** The current map, when a picker has one: its sketches
   * group first as "Drawn on this map". Context-free callers omit it. */
  mapId?: string | null;
  /** The geometry classes this input takes. */
  accepts: readonly string[];
  value: string | null;
  onPick: (name: string) => void;
  /** The layer a Select pick arrived through, for D1's display name —
   * null on a Search pick and on Change. */
  onPickContext?: (layerName: string | null) => void;
  label: string;
}) {
  const [query, setQuery] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const pick = usePickMode();
  // **The store IS the mode**: Select is active exactly while this
  // input's arm is the armed one, so the store's own Escape disarm reads
  // back as Search with no state to keep in step.
  const armedHere = pick.armed?.label === label;

  const arm = () =>
    armPick({
      label,
      tryLayer: (layer) => {
        const named = tablesNamedIn(layer.sql, tables);
        if (named.length !== 1) {
          return (
            `“${layer.name}” reads ${named.length === 0 ? "no registered table" : `${named.length} tables`}, ` +
            `so it cannot choose one for ${label}. Pick the table in Search, ` +
            `or use the SQL tool for the layer's own query.`
          );
        }
        if (!acceptsTable(accepts, named[0])) {
          return `“${layer.name}” holds ${geometryClass(named[0])}. ${refusalFor(accepts, named[0])}`;
        }
        onPickContext?.(layer.name);
        onPick(named[0].name);
        return null;
      },
    });

  // Keep the armed closure current — the resolver closes over the table
  // list and accepts, and a stale closure would answer with old truth. The
  // store is an external system, so this is exactly what an effect is for;
  // no React state moves here.
  const armRef = useRef(arm);
  useEffect(() => {
    armRef.current = arm;
  });
  useEffect(() => {
    if (armedPickLabel() === label) armRef.current();
  }, [label, tables, accepts, onPick, onPickContext]);
  // Unmounting while armed — the drawer closed, the face changed — disarms,
  // so no dead closure keeps eating card clicks.
  useEffect(
    () => () => {
      if (armedPickLabel() === label) disarmPick();
    },
    [label],
  );

  if (value !== null) {
    const chosen = tables.find((t) => t.name === value);
    return (
      <div
        className={styles.locked}
        data-input-locked={label}
        role="group"
        aria-label={label}
      >
        <span className={styles.tableName}>{value}</span>
        {chosen && (
          <span className={styles.tableMeta}>
            {formatCount(chosen.rowCount)} features · {geometryClass(chosen)}
          </span>
        )}
        <button
          type="button"
          className={styles.change}
          data-input-change
          onClick={() => {
            setListOpen(false);
            onPickContext?.(null);
            onPick("");
          }}
        >
          Change
        </button>
      </div>
    );
  }

  const matching = tables.filter((t) =>
    t.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const groups = groupTables(matching, recipes, mapId ? { mapId } : null);

  return (
    <div
      className={styles.picker}
      role="group"
      aria-label={label}
      // The list closes when focus LEAVES the picker, not when it moves
      // from the field to a row — Tab must reach the rows, or Search has
      // no keyboard path at all.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setListOpen(false);
        }
      }}
    >
      <div className={styles.modes} role="group" aria-label={`How to choose ${label}`}>
        <button
          type="button"
          className={styles.modeBtn}
          data-pick-search
          aria-pressed={!armedHere}
          onClick={disarmPick}
        >
          <SearchIcon /> Search
        </button>
        <button
          type="button"
          className={styles.modeBtn}
          data-pick-select
          aria-pressed={armedHere}
          onClick={arm}
        >
          <CursorIcon /> Select
        </button>
      </div>

      {armedHere ? (
        <div className={styles.armed} data-pick-armed role="status">
          <p>
            Click a layer in the panel on the left, or click one of its
            features on the map. A feature picks <strong>its layer</strong>,
            never the single feature. Esc backs out.
          </p>
          {pick.refusal && (
            <p className={styles.problem} data-pick-refusal role="alert">
              {pick.refusal}
            </p>
          )}
        </div>
      ) : (
        <>
          <input
            className={styles.search}
            type="search"
            value={query}
            aria-label={`Search tables for ${label}`}
            placeholder={`Search ${tables.length} table${tables.length === 1 ? "" : "s"}…`}
            onFocus={() => setListOpen(true)}
            onChange={(e) => {
              setQuery(e.target.value);
              setListOpen(true);
            }}
            onKeyDown={(e) => {
              // An open list consumes the first Escape: the list closes,
              // the field and its value stay, and only the next press
              // reaches the drawer.
              if (e.key === "Escape" && listOpen) {
                e.preventDefault();
                setListOpen(false);
              }
            }}
          />
          {/* **No list until the field is focused**. Rows pick on
              pointer-down, before the blur that closes the list. Only this
              region scrolls — the modes and the field hold still above it
              (field round). */}
          {listOpen && (
            <div className={styles.rows} data-table-rows>
              {groups.length === 0 ? (
                <p className={styles.pickerEmpty}>
                  No table name matches “{query}”.
                </p>
              ) : (
                <TableRows groups={groups} accepts={accepts} onPick={onPick} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The grouped rows, focused-list half of Search — a pure piece of the
 * picker, exported so the capability tests can hold the catalog's metadata
 * against the rows without driving focus through static markup.
 */
export function TableRows({
  groups,
  accepts,
  onPick,
}: {
  groups: ReturnType<typeof groupTables>;
  accepts: readonly string[];
  onPick: (name: string) => void;
}) {
  return (
    <>
      {groups.map((group) => (
        <div key={group.key} className={styles.group} data-table-group={group.key}>
          <p className={styles.eyebrow}>{group.label}</p>
          {group.tables.map(({ table }) => {
            const usable = acceptsTable(accepts, table);
            return (
              <button
                key={table.id}
                type="button"
                className={styles.tableRow}
                data-table-row={table.name}
                disabled={!usable}
                data-hint={usable ? undefined : refusalFor(accepts, table)}
                data-hint-always={usable ? undefined : ""}
                aria-describedby={
                  usable ? undefined : `table-reason-${table.name}`
                }
                // The glyph is aria-hidden, so the class it shows joins the
                // accessible name — a screen reader hears what a sighted
                // user sees before choosing.
                aria-label={`${table.name}, ${formatCount(table.rowCount)} features, ${geometryClass(table)}`}
                // Pointer: mousedown only holds focus so the blur that
                // closes the list waits for the click; the pick itself is
                // the click, which is also what Enter and Space dispatch —
                // keyboard users choose exactly like pointer users.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(table.name)}
              >
                {!usable && (
                  <span id={`table-reason-${table.name}`} hidden>
                    {refusalFor(accepts, table)}
                  </span>
                )}
                <span className={styles.tableGlyph}>
                  <GeometryGlyph geometryType={geometryGlyphType(table)} />
                </span>
                {/* Two compact lines and nothing else:
                    the glyph already says the class, the group already
                    says the provenance. */}
                <span className={styles.tableText}>
                  <span className={styles.tableName}>{table.name}</span>
                  <span className={styles.tableMeta}>
                    {formatCount(table.rowCount)} features
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </>
  );
}
