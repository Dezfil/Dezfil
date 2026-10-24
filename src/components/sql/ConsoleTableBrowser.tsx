"use client";

import { useEffect, useMemo, useState } from "react";
import type { TableListing } from "../api";
import { formatCount } from "../api";
import { GeometryIcon, geometryKind } from "../gallery-icons";
import { IconButton } from "../ui/IconButton";
import { PlayIcon } from "../ui/icons";
import { useRecipes } from "../builder/drawer/use-recipes";
import { readProjectsDirectory } from "../scope/use-scope-world";
import { initials } from "../sharing/people";
import { Face } from "../people/Face";
import { useSignedInSqlName } from "../sharing/signed-in";
import { sourceGroups, type SourceGrouping } from "./source-groups";
import { matchTables } from "./table-search";
import { useSourceGrouping } from "./use-source-grouping";
import styles from "./SqlConsole.module.css";

/**
 * The console's table browser (revised): search by table and column
 * name, rows with geometry kind, name and row count, grouped by person
 * (one's own as "Yours", then each other person's under their name and
 * SQL name) or, at the switch the account remembers, by project. Each
 * row's name is what one types in SQL: someone else's dataset carries
 * their SQL name. Activation selects and previews the table — the
 * columns are read in the preview, never unfolded here — and Open as
 * SQL and insert are the row actions, each the kit's icon button so its
 * name is its hint (the name without the table — the row it sits in is
 * the table's name).
 */
export interface BrowserProps {
  tables: readonly TableListing[];
  /** The columns read for a dataset, by the name its reader types. */
  columnsOf: (name: string) => readonly string[] | null;
  /** How far the schema inventory has read: a column search that finds
   * nothing says whether columns are still arriving or some failed. */
  progress: { ready: number; failed: number; total: number };
  /** The selected dataset, by the name its reader types. */
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
  const me = useSignedInSqlName();
  const [grouping, setGrouping] = useSourceGrouping();
  const projects = useProjectNames();
  const matches = useMemo(
    () => matchTables(tables, query, columnsOf),
    [tables, query, columnsOf],
  );
  const columnHit = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of matches) if (x.column) m.set(x.table.qualifiedName, x.column);
    return m;
  }, [matches]);
  const groups = useMemo(
    () =>
      sourceGroups(
        matches.map((m) => m.table),
        { grouping, me, projects, recipes: recipes ?? [] },
      ),
    [matches, grouping, me, projects, recipes],
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
        <GroupingSwitch grouping={grouping} onGrouping={setGrouping} />
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
            <p className={styles.groupEyebrow}>
              {group.label}
              {group.sqlName && <code className={styles.eyebrowSql}>· {group.sqlName}</code>}
            </p>
            {group.rows.map(({ table: t, qualifier, owner, via }) => {
              const isSelected = t.qualifiedName === selected;
              const hit = columnHit.get(t.qualifiedName);
              return (
                <div
                  key={t.id}
                  role="button"
                  tabIndex={0}
                  className={styles.row}
                  data-name={t.qualifiedName}
                  data-hint={grouping === "person" && via ? via : undefined}
                  aria-label={t.qualifiedName}
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
                    {qualifier && <i className={styles.rowQualifier}>{qualifier}.</i>}
                    {t.name}
                    {hit && <span className={styles.colHit}>· {hit}</span>}
                  </span>
                  {/* The meta and the actions share one cell, so revealing
                      the actions moves nothing. By project the meta is
                      whose dataset it is. */}
                  <span className={styles.rowEnd}>
                    {grouping === "project" && owner ? (
                      <span className={styles.rowWho} data-hint={owner.name} data-row-owner={owner.sqlName}>
                        <Face person={owner} letters={initials(owner.name)} className={styles.rowIni}
                          data-me={owner.sqlName === me || undefined} />
                      </span>
                    ) : (
                      <span className={styles.rowMeta}>{formatCount(t.rowCount)}</span>
                    )}
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

/** The switch on the list: grouped by person or by project, remembered
 * for the account. */
function GroupingSwitch({
  grouping,
  onGrouping,
}: {
  grouping: SourceGrouping;
  onGrouping: (next: SourceGrouping) => void;
}) {
  return (
    <div className={`${styles.tabs} ${styles.grouping}`} role="group" aria-label="Group sources">
      {(["person", "project"] as const).map((g) => (
        <button
          key={g}
          type="button"
          aria-pressed={grouping === g}
          data-on={grouping === g || undefined}
          onClick={() => onGrouping(g)}
        >
          {g === "person" ? "By person" : "By project"}
        </button>
      ))}
    </div>
  );
}

/** The projects the reader reaches, by name, for the project grouping and
 * the person grouping's hover. A failed read groups nothing by project. */
function useProjectNames(): { id: string; name: string }[] {
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    readProjectsDirectory().then(
      (listed) => {
        if (!cancelled) setProjects([...listed].sort((a, b) => a.name.localeCompare(b.name)));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return projects;
}
