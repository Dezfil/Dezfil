"use client";

import { useState } from "react";
import type { TableListing } from "../../api";
import { formatCount } from "../../api";
import { GeometryBadge } from "../../GeometryBadge";
import { Spinner } from "../../Spinner";
import { ErrorNote } from "../../ui/ErrorNote";
import { ScopeFilter } from "../../scope/ScopeFilter";
import { scopeRows } from "../../scope/model";
import { groupTables } from "../drawer/derived-tables";
import { useRecipes } from "../drawer/use-recipes";
import { filterTables } from "./catalog-state";
import type { CatalogListing } from "./use-catalog-tables";
import styles from "./AddLayerCatalog.module.css";

interface Props {
  listing: CatalogListing;
  /** The highlighted row, by name — null for a stateless host (the
   * SQL view's browser highlights nothing; the draft is the state). */
  selected: string | null;
  onPick: (table: TableListing) => void;
}

/**
 * The searchable table browser: search over the live listing in its
 * served order (newest first), metadata on every row. Shared by the
 * Tables view and the SQL workbench — one presentation, two selection
 * ownerships. The list states — loading, failed-with-retry,
 * loaded-empty — stay mutually exclusive and each visibly itself (the /
 * pattern).
 *
 * **Grouped (ruling G4): recipe outputs above workspace tables,
 * each derived row carrying the step that wrote it.** This is the
 * surface a user actually turns a table into a layer from, and it is
 * reached without the drawer existing at all — which is why the spec's
 * floor names it explicitly, and the grouping rule stands on that: a grouping
 * that lived only inside the drawer could not satisfy a criterion about
 * inspecting an output *without opening the drawer*.
 *
 * **Scoped (17-A):** one filter row above the search — the project
 * filter — narrows what the browser offers; the grouping, order, search
 * and rows hold unchanged inside the scope; a row is the geometry
 * capsule, the name and the count — the membership tag of left with,
 * the filter above already saying the scope. The filter renders only
 * from a ready world; a pending or failed scoped read keeps its own
 * state and never presents another scope's rows.
 */
export function CatalogTableBrowser({ listing, selected, onPick }: Props) {
  const { world, worldError, offered, offeredError, scope, onScope, onRetry } =
    listing;
  const [query, setQuery] = useState("");
  // The recipes are read here rather than threaded through both parents: the
  // grouping is a property of this presentation, and both call sites get it
  // by rendering the browser at all. A failed load leaves every table under
  // Workspace tables rather than taking the list down.
  const { recipes } = useRecipes();

  if (worldError !== null) {
    return (
      <div className={styles.stateBody}>
        <ErrorNote message={worldError} onRetry={onRetry} />
      </div>
    );
  }
  if (world === null) {
    return (
      <div className={styles.stateBody}>
        <p className={styles.stateHint}>
          <Spinner /> Loading tables…
        </p>
      </div>
    );
  }
  if (world.all.length === 0) {
    return (
      <div className={styles.stateBody}>
        <p className={styles.stateHint}>No tables yet. Import data first.</p>
      </div>
    );
  }

  const rows = scopeRows(world.all, world.projects, (t) => t.projectIds);
  // The filter renders only when the world CONTAINS the active choice
  // (the plan's rule): a scope whose project was deleted must show its
  // refusal below, never the shared control's All-projects fallback
  // face standing in for it.
  const missingActive =
    scope.kind === "project" && !rows.some((r) => r.id === scope.id);
  const filterRow = missingActive ? null : (
    <div className={styles.scopeRow}>
      <ScopeFilter rows={rows} scope={scope} onPick={onScope} size="compact" />
    </div>
  );

  if (offeredError !== null) {
    return (
      <>
        {filterRow}
        <div className={styles.stateBody}>
          <ErrorNote message={offeredError} onRetry={onRetry} />
        </div>
      </>
    );
  }
  if (offered === null) {
    return (
      <>
        {filterRow}
        <div className={styles.stateBody}>
          <p className={styles.stateHint}>
            <Spinner /> Loading tables…
          </p>
        </div>
      </>
    );
  }

  const shown = filterTables(offered, query);
  const groups = groupTables(shown, recipes ?? []);
  return (
    <>
      {filterRow}
      <input
        className={styles.search}
        type="search"
        placeholder={`Search ${offered.length} table${offered.length === 1 ? "" : "s"}…`}
        aria-label="Search tables"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className={styles.tableList} role="group" aria-label="Tables">
        {offered.length === 0 ? (
          <p className={styles.stateHint}>No tables yet. Import data first.</p>
        ) : shown.length === 0 ? (
          <p className={styles.stateHint}>No table name matches “{query}”.</p>
        ) : null}
        {groups.map((group) => (
          <div key={group.key} data-table-group={group.key}>
            <p className={styles.groupEyebrow}>{group.label}</p>
            {group.tables.map(({ table: t }) => {
              return (
                <button
                  key={t.id}
                  className={styles.tableRow}
                  aria-label={t.name}
                  aria-pressed={t.qualifiedName === selected}
                  data-selected={t.qualifiedName === selected || undefined}
                  data-nonspatial={t.geometryColumn === null || undefined}
                  onClick={() => onPick(t)}
                >
                  <GeometryBadge table={t} />
                  <span className={styles.tableName}>{t.name}</span>
                  <span className={styles.tableMeta}>
                    {formatCount(t.rowCount)} rows
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}
