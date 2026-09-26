"use client";

import { useMemo, useState } from "react";
import type { TableListing } from "../api";
import { formatCount } from "../api";
import { GeometryIcon, geometryKind } from "../gallery-icons";
import { IconButton } from "../ui/IconButton";
import { PlayIcon } from "../ui/icons";
import { groupTables } from "../builder/drawer/derived-tables";
import { useRecipes } from "../builder/drawer/use-recipes";
import { matchTables } from "./table-search";
import styles from "./SqlConsole.module.css";

/**
 * The console's table browser (revised): search by table and column
 * name, the builder's grouping (recipe outputs above workspace tables,
 * via the same pure helper), rows with geometry kind, name and row
 * count. Activation selects and previews the table — the columns are
 * read in the preview, never unfolded here — and Open as
 * SQL and insert are the row actions, each the kit's icon button so its
 * name is its hint (the name without the table — the row it sits in is
 * the table's name).
 */
export interface BrowserProps {
  tables: readonly TableListing[];
  columnsOf: (name: string) => readonly string[] | null;
  /** How far the schema inventory has read: a column search that finds
   * nothing says whether columns are still arriving or some failed. */
  progress: { ready: number; failed: number; total: number };
  selected: string | null;
  onActivate: (table: TableListing) => void;
  onOpenAsSql: (table: TableListing) => void;
  onInsertTable: (table: TableListing) => void;
  searchRef?: React.RefObject<HTMLInputElement | null>;
}

function InsertIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6h9a4 4 0 0 1 0 8H9M12 11l-3 3 3 3" />
    </svg>
  );
}

export function ConsoleTableBrowser({
  tables,
  columnsOf,
  selected,
  onActivate,
  onOpenAsSql,
  onInsertTable,
  progress,
  searchRef,
}: BrowserProps) {
  const [query, setQuery] = useState("");
  const { recipes } = useRecipes();
  const matches = useMemo(
    () => matchTables(tables, query, columnsOf),
    [tables, query, columnsOf],
  );
  const columnHit = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of matches) if (x.column) m.set(x.table.name, x.column);
    return m;
  }, [matches]);
  const groups = useMemo(
    () =>
      groupTables(
        matches.map((m) => m.table),
        recipes ?? [],
      ),
    [matches, recipes],
  );

  return (
    <>
      <div className={styles.browserTop}>
        <input
          ref={searchRef}
          className={styles.search}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.preventDefault();
              setQuery("");
            }
          }}
          placeholder={`Search ${tables.length} table${tables.length === 1 ? "" : "s"} and their columns…`}
          aria-label="Search tables"
        />
      </div>
      <div className={styles.browserList} role="group" aria-label="Sources">
        {matches.length === 0 && (
          <p className={styles.browserEmpty} role="status">
            No table or column name matches “{query}”.
            {progress.ready < progress.total - progress.failed && (
              <>
                {" "}
                Columns are still being read ({progress.ready} of {progress.total} tables), so a
                column match may still appear.
              </>
            )}
            {progress.failed > 0 && (
              <>
                {" "}
                {progress.failed === 1 ? "One table's" : `${progress.failed} tables'`} columns could
                not be read; select a table to retry from its preview.
              </>
            )}
          </p>
        )}
        {groups.map((group) => (
          <div key={group.key} data-table-group={group.key}>
            <p className={styles.groupEyebrow}>{group.label}</p>
            {group.tables.map(({ table: t }) => {
              const isSelected = t.name === selected;
              const hit = columnHit.get(t.name);
              return (
                <div
                  key={t.id}
                  role="button"
                  tabIndex={0}
                  className={styles.row}
                  data-name={t.name}
                  aria-label={t.name}
                  data-selected={isSelected || undefined}
                  data-nonspatial={t.geometryColumn === null || undefined}
                  aria-pressed={isSelected}
                  onClick={() => onActivate(t)}
                  onKeyDown={(e) => {
                    // The row's own key, never a nested action's.
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onActivate(t);
                    }
                  }}
                >
                  <span className={styles.rowGlyph} data-kind={geometryKind(t.geometryType, t.geometryColumn)}>
                    <GeometryIcon kind={geometryKind(t.geometryType, t.geometryColumn)} />
                  </span>
                  <span className={styles.rowName}>
                    {t.name}
                    {hit && <span className={styles.colHit}>· {hit}</span>}
                  </span>
                  {/* The meta and the actions share one cell, so revealing
                      the actions moves nothing. */}
                  <span className={styles.rowEnd}>
                    <span className={styles.rowMeta}>{formatCount(t.rowCount)}</span>
                    <span className={styles.rowActs}>
                      <IconButton
                        className={styles.rowAct}
                        action="Open as SQL"
                        icon={<PlayIcon />}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenAsSql(t);
                        }}
                      />
                      <IconButton
                        className={styles.rowAct}
                        action="Insert at the cursor"
                        icon={<InsertIcon />}
                        onClick={(e) => {
                          e.stopPropagation();
                          onInsertTable(t);
                        }}
                      />
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}
