"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import type { DataTable, TableListing } from "./api";
import {
  formatBytes,
  formatCompactCount,
  readApiError,
  readRecipes,
} from "./api";
import { AddDataDialog } from "./AddDataDialog";
import { useTransientNotice } from "./use-transient-notice";
import { skippedNotice } from "./skipped-members";
import { uploadSettleNotice } from "./upload-settle-notice";
import { useUploadQueue, type UploadQueue } from "./use-upload-queue";
import { SOURCE_COLORS, isRefreshableImport } from "./table-chips";
import { AddToMapDialog, tableSubject } from "./AddToMapDialog";
import { IconGrid, IconList, IconSearch } from "./gallery-icons";
import { TableCard, TableRow, type TableActionsProps } from "./data-cards";
import {
  foldTables,
  shownItems,
  type DataFolder,
  type DataSort,
  type SourceFilter,
} from "./data-folders";
import { ScopeFilter } from "./scope/ScopeFilter";
import {
  datasetProjectFact,
  scopeRows,
  headingLine,
  tileSubLine,
} from "./scope/model";
import { useProjectScope } from "./scope/use-scope";
import { useScopeWorld } from "./scope/use-scope-world";
import {
  FolderCard,
  FolderPane,
  FolderRow,
  NestedIndent,
} from "./WorkflowFolder";
import { useGridColumns } from "./use-grid-columns";
import type { WorkflowListing } from "./workflow-model";
import folderStyles from "./WorkflowFolder.module.css";
import { useViewPrefs } from "./use-view-prefs";
import { AsyncState } from "./ui/AsyncState";
import { ErrorNote } from "./ui/ErrorNote";
import { AddToProjectDialog } from "./projects/AddToProjectDialog";
import { ListHeading } from "./ListHeading";
import { PlusIcon } from "./ui/icons";
import { useAsyncCollection } from "./use-async-collection";
import gallery from "./gallery.module.css";
import styles from "./TablesScreen.module.css";
import { serverUnreachable } from "./failure-copy";
import { ownedByOther } from "./sharing/people";
import { useSignedInSqlName } from "./sharing/signed-in";

export type { DataSort } from "./data-folders";
const DATA_SORTS = ["updated", "name", "rows", "size"] as const;

// a kind missing here compiles, counts under "All", and silently has no
// filter chip — so this list is walked deliberately, not by the typechecker.
const SOURCE_ORDER: TableListing["source"][] = [
  "upload",
  "overture",
  "osm",
  "postgis",
  "url",
  "operation",
  "sketch",
];

const FILTER_LABELS: Record<TableListing["source"], string> = {
  upload: "Files",
  overture: "Overture",
  osm: "OSM",
  postgis: "PostGIS",
  url: "URL",
  operation: "Results",
  sketch: "Sketches",
};

/** The workflows the page folds its outputs into. */
const fetchWorkflows = () => readRecipes("workflow");

/** The catalog load, as a user sentence when the network itself fails —
 * server answers already carry documented sentences. */
async function fetchTables(scope?: string): Promise<TableListing[]> {
  let response: Response;
  // An empty scope value is NOT the unscoped road: it rides through and
  // the server refuses it.
  const path =
    scope !== undefined
      ? `/api/tables?project=${encodeURIComponent(scope)}`
      : "/api/tables";
  try {
    response = await fetch(path, { cache: "no-store" });
  } catch {
    throw new Error(serverUnreachable("load the tables"));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as TableListing[];
}

export function TablesScreen({
  initialPostgisConnectionId = null,
}: {
  initialPostgisConnectionId?: string | null;
}) {
  const router = useRouter();
  // Someone else's dataset is marked with its owner in the lists.
  const me = useSignedInSqlName();
  const othersOwner = (t: TableListing) =>
    ownedByOther(t.owner, me) ? t.owner : null;
  // The catalog load runs through the shared async contract; the edits
  // overlay keeps deletes and refreshes updating in place, without
  // flashing the resolved catalog back to a pending state.
  const { scope, setScope } = useProjectScope();
  const {
    state: listState,
    retry,
    mutate,
    refresh,
  } = useScopeWorld<TableListing>({
    kind: "tables",
    scope,
    fetchUnscoped: fetchTables,
    fetchScoped: (param) => fetchTables(param),
  });
  const world = listState.status === "ready" ? listState.value : null;
  const tables = world?.scoped ?? null;
  // The import context: a named scope files every import made from this
  // page into it, the way the project home's dialog does; All projects
  // and Not in a project file nothing.
  const scopeProjectId = scope.kind === "project" ? scope.id : null;
  const projectNames = useMemo(
    () => new Map((world?.projects ?? []).map((x) => [x.id, x.name])),
    [world],
  );
  const scopeProjectName =
    scopeProjectId !== null ? (projectNames.get(scopeProjectId) ?? null) : null;

  // Mutation and refresh failures are their own dismissible note,
  // separate from the load state.
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(!!initialPostgisConnectionId);
  const [postgisDoor, setPostgisDoor] = useState<string | null>(
    initialPostgisConnectionId,
  );
  const [confirmName, setConfirmName] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [addToMap, setAddToMap] = useState<string | null>(null);
  // Filing: the same dialog Maps opens, over a dataset.
  const [filing, setFiling] = useState<TableListing | null>(null);
  const [filedNote, setFiledNote] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SourceFilter>("all");
  const { view, sort, setView, setSort } = useViewPrefs<DataSort>(
    "data",
    "updated",
    DATA_SORTS,
  );
  const searchRef = useRef<HTMLInputElement>(null);

  // The workflows beside the tables: their own read, so the tables show
  // flat while this is pending or failed and fold when it lands;
  // re-read in place after a delete so a folder's facts and its state
  // words follow.
  const {
    state: workflowsState,
    retry: retryWorkflows,
    replace: replaceWorkflows,
  } = useAsyncCollection<WorkflowListing>(fetchWorkflows, "data-workflows");
  const workflows =
    workflowsState.status === "ready" ? workflowsState.value : null;
  const [workflowsNoteDismissed, setWorkflowsNoteDismissed] = useState(false);
  // A re-read after a change that fails keeps the last fold and says so
  // (found at review); a re-read overtaken by a later one is
  // dropped, so two deletions in flight cannot land out of order.
  const [refreshError, setRefreshError] = useState<{ detail: string } | null>(
    null,
  );
  const refreshSeq = useRef(0);
  const refreshWorkflows = useCallback(async () => {
    // A dismissed failure note does not silence the next failure.
    setWorkflowsNoteDismissed(false);
    if (workflowsState.status !== "ready") {
      retryWorkflows();
      return;
    }
    const seq = ++refreshSeq.current;
    try {
      const next = await fetchWorkflows();
      if (seq !== refreshSeq.current) return;
      replaceWorkflows(next);
      setRefreshError(null);
    } catch (e) {
      if (seq !== refreshSeq.current) return;
      // A failure is a failure whatever its text (an empty message from
      // an unexpected body must still raise the note).
      setRefreshError({ detail: e instanceof Error ? e.message : String(e) });
    }
  }, [workflowsState.status, replaceWorkflows, retryWorkflows]);
  // The open folder: page state, one at a time, kept across
  // the view switch; a search or filter that hides it closes it (below),
  // and one that is gone (its last output deleted) counts as closed.
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null);

  // After an import or another change lands, the listing re-reads in the
  // background and replaces in place — the resolved catalog never flashes
  // back to a spinner.
  const refreshListing = useCallback(async () => {
    try {
      // Before the initial load resolves there is no list to replace — re-request instead, so the
      // import is never invisible. A successful refresh clears any earlier refresh failure.
      if (listState.status === "ready") {
        await refresh();
      } else {
        retry();
      }
      setActionError(null);
    } catch {
      setActionError(
        "The table list couldn't be refreshed. Reload the page to see the newest state.",
      );
    }
  }, [refresh, retry, listState.status]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // The post-import notice outlives the dialog: the first created table
  // closes and unmounts it, so the skips land here.
  const { notice: importNotice, show: showImportNotice } = useTransientNotice();
  // A skip notice says more than a success one and must not be overwritten
  // by it. The import reports skips first, then each created table — and a
  // GeoPackage lands several, so the flag is cleared when the next import
  // opens, never after the first table has been announced.
  const skipped = useRef(false);

  // Every path that closes the dialog settles the file queue the same way (a URL/OSM/PostGIS import
  // closing the host must not leave queued files running invisibly or a settled display stale):
  // stop what has not started, name the stop, drop a settled batch's display.
  const uploadQueueRef = useRef<UploadQueue | null>(null);
  const settleQueueForClose = useCallback(() => {
    const queue = uploadQueueRef.current;
    if (!queue) return;
    const stopped = queue.dismiss();
    if (stopped > 0) {
      showImportNotice(
        stopped === 1
          ? "Stopped. 1 queued file was not started."
          : `Stopped. ${stopped} queued files were not started.`,
      );
    }
    if (queue.current().settled) queue.reset();
  }, [showImportNotice]);

  const onCreated = useCallback(
    (table: DataTable) => {
      void refreshListing();
      settleQueueForClose();
      setDialogOpen(false);
      setPostgisDoor(null);
      // The dialog unmounts on success, so the terminal state is announced
      // here, by the screen that outlives it — unless this import already
      // had something more particular to say.
      if (!skipped.current) showImportNotice(`${table.name} is ready.`);
    },
    [showImportNotice, refreshListing, settleQueueForClose],
  );

  // The file upload batch lives HERE, not in the dialog: the dialog
  // unmounts on close while the request in flight must keep running and
  // report through this screen. Files settle the host as a batch; every
  // other source keeps its close-on-first-table manner.
  const dialogOpenRef = useRef(dialogOpen);
  const uploadQueue = useUploadQueue({
    // The scope's project rides each admitted batch.
    projectId: scopeProjectId,
    // Tables appear in the listing as each file lands.
    onFileImported: () => void refreshListing(),
    // An unconfirmed outcome re-reads the authoritative listing.
    onListingStale: () => void refreshListing(),
    onSettled: (report) => {
      const { text, clean } = uploadSettleNotice(report);
      if (dialogOpenRef.current) {
        // An all-successful batch closes the host with one whole-batch
        // outcome; anything else keeps it open with its notes readable.
        if (clean) {
          setDialogOpen(false);
          showImportNotice(text);
        }
      } else {
        // The host was dismissed mid-batch: the outcome still lands,
        // outside the closed dialog, and the settled
        // batch is dropped so the next open starts fresh.
        showImportNotice(text);
        uploadQueueRef.current?.reset();
      }
    },
  });
  useEffect(() => {
    // Queue events are asynchronous; these mirrors are always fresh by
    // the time a settle or close reads them.
    dialogOpenRef.current = dialogOpen;
    uploadQueueRef.current = uploadQueue;
  });
  const closeAddDialog = useCallback(() => {
    settleQueueForClose();
    setDialogOpen(false);
    setPostgisDoor(null);
  }, [settleQueueForClose]);

  const remove = useCallback(
    async (name: string) => {
      setDeleting(name);
      try {
        const response = await fetch(
          `/api/tables/${encodeURIComponent(name)}`,
          { method: "DELETE" },
        );
        if (!response.ok) {
          setActionError(await readApiError(response));
          return;
        }
        mutate((w) => ({
          ...w,
          all: w.all.filter((t) => t.name !== name),
          scoped: w.scoped.filter((t) => t.name !== name),
        }));
        setActionError(null);
        // A folder the deletion empties out of what is shown (its last
        // output, or its last match under an output-name search) is
        // closed, not merely hidden: it must not reappear open when the
        // search clears (found at review).
        if (openFolder && tables) {
          const remaining = tables.filter((t) => t.name !== name);
          const stillShown = shownItems(foldTables(remaining, workflows), {
            query,
            filter,
            sort,
          }).some((i) => i.kind === "folder" && i.id === openFolder);
          if (!stillShown) setOpenFolder(null);
        }
        void refreshWorkflows();
      } catch {
        setActionError(serverUnreachable("delete the table"));
      } finally {
        setDeleting(null);
        setConfirmName(null);
      }
    },
    [
      mutate,
      refreshWorkflows,
      openFolder,
      tables,
      workflows,
      query,
      filter,
      sort,
    ],
  );

  const sourceCounts = useMemo(() => {
    const counts = new Map<TableListing["source"], number>();
    for (const t of tables ?? []) {
      counts.set(t.source, (counts.get(t.source) ?? 0) + 1);
    }
    return counts;
  }, [tables]);

  // A scope change can hide the active source chip; the filter then
  // READS as All — derived, never a shadow state racing an effect.
  const effectiveFilter: SourceFilter =
    filter !== "all" && tables && !(sourceCounts.get(filter) ?? 0)
      ? "all"
      : filter;
  // The STORED choice resets too (the render-adjust pattern): a
  // vanished chip must not silently reactivate when a later scope
  // holds that source again.
  if (effectiveFilter !== filter) setFilter("all");

  // What the page shows: loose tables and workflow folders, filtered,
  // searched and sorted together.
  const items = useMemo(() => {
    if (!tables) return null;
    return shownItems(foldTables(tables, workflows), {
      query,
      filter: effectiveFilter,
      sort,
    });
  }, [tables, workflows, query, effectiveFilter, sort]);
  const shownOpen =
    openFolder && items?.some((i) => i.kind === "folder" && i.id === openFolder)
      ? openFolder
      : null;
  // Measured whenever the grid stands, not only once a folder is open:
  // the count must be known at the first open, or that first paint puts
  // the pane right after the folder (the refuters' round's placement
  // check, once it could fail, caught the frame).
  const columns = useGridColumns(gridEl, view === "grid");
  // A search or filter that hides the open folder closes it: decided where the search or filter
  // changes, on what the page will show, so a narrowing that keeps the folder keeps it open.
  const closeIfHidden = (next: { query: string; filter: SourceFilter }) => {
    if (!openFolder || !tables) return;
    const survives = shownItems(foldTables(tables, workflows), {
      ...next,
      sort,
    }).some((i) => i.kind === "folder" && i.id === openFolder);
    if (!survives) setOpenFolder(null);
  };
  const folderHandlers = (f: DataFolder) => ({
    onToggle: () => setOpenFolder((cur) => (cur === f.id ? null : f.id)),
    onClose: () => setOpenFolder(null),
    onOpenWorkflow: () => router.push(`/workflows/${f.id}`),
  });

  const manifest = useMemo(() => {
    if (!tables) return null;
    return {
      tables: tables.length,
      rows: tables.reduce((sum, t) => sum + t.rowCount, 0),
      bytes: tables.reduce((sum, t) => sum + (t.sizeBytes ?? 0), 0),
      refreshable: tables.filter(isRefreshableImport).length,
      crsAssumed: tables.filter((t) => t.crsAssumed).length,
    };
  }, [tables]);

  // The quick actions' state stays the screen's (the two-press delete,
  // the add-to-map dialog); the card and row render it (extraction,
  // behaviour-preserving).
  const actionsFor = (t: TableListing): TableActionsProps => ({
    table: t,
    confirming: confirmName === t.name,
    deleting: deleting === t.name,
    onOpen: () => router.push(`/tables/${t.name}`),
    onQuery: () => router.push(`/sql?table=${encodeURIComponent(t.name)}`),
    onAddToMap: () => setAddToMap(t.name),
    onFile: () => setFiling(t),
    onDeletePress: () => {
      if (confirmName === t.name) void remove(t.name);
      else setConfirmName(t.name);
    },
    onDeleteBlur: () => setConfirmName(null),
  });

  return (
    <div
      className={styles.screen}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        // Drop-anywhere carries EVERY dropped file: the batch starts at
        // once and the dialog opens onto it.
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
          e.preventDefault();
          skipped.current = false;
          uploadQueue.add(files);
          setPostgisDoor(null);
          setDialogOpen(true);
        }
      }}
    >
      {/* The one heading. */}
      <ListHeading
        title="Data"
        line={
          world
            ? headingLine({
                scopedTotal: world.scoped.length,
                scope,
                scopeName:
                  scope.kind === "project"
                    ? (projectNames.get(scope.id) ?? null)
                    : null,
                shownCount:
                  items?.reduce(
                    (n, i) =>
                      n + (i.kind === "table" ? 1 : i.matching.length),
                    0,
                  ) ?? world.scoped.length,
              })
            : null
        }
        action={{
          label: "Add data",
          onClick: () => {
            skipped.current = false;
            setPostgisDoor(null);
            setDialogOpen(true);
          },
        }}
      />

      {filedNote && (
        <div className={gallery.notice} role="status">
          {filedNote}
        </div>
      )}
      {filing && (
        <AddToProjectDialog
          subject={{
            kind: "dataset",
            id: filing.id,
            name: filing.name,
            projectIds: filing.projectIds,
          }}
          onClose={() => setFiling(null)}
          onDone={({ projectId, projectName }) => {
            const tableId = filing.id;
            setFiling(null);
            // The immediate truth: the dataset gains the membership now,
            // and an unfiled scope no longer holds it — before the
            // reconciling read, and whether or not it answers.
            const join = (t: TableListing) =>
              t.id === tableId && !t.projectIds.includes(projectId)
                ? { ...t, projectIds: [...t.projectIds, projectId] }
                : t;
            mutate((w) => ({
              ...w,
              projects: w.projects.some((p) => p.id === projectId)
                ? w.projects
                : [{ id: projectId, name: projectName }, ...w.projects],
              all: w.all.map(join),
              scoped:
                scope.kind === "none"
                  ? w.scoped.filter((t) => t.id !== tableId)
                  : w.scoped.map(join),
            }));
            setFiledNote(`${filing.name} added to ${projectName}.`);
            // Reconcile counts and the directory quietly.
            void refresh().catch(() => {});
          }}
        />
      )}
      {actionError && (
        <ErrorNote
          message={actionError}
          onDismiss={() => setActionError(null)}
        />
      )}
      {importNotice && (
        <div className={gallery.notice} role="status">
          {importNotice}
        </div>
      )}
      {workflowsState.status === "failed" && !workflowsNoteDismissed && (
        <ErrorNote
          tone="warn"
          message="The workflows couldn't be read, so every table shows on its own."
          detail={workflowsState.error}
          onRetry={retryWorkflows}
          onDismiss={() => setWorkflowsNoteDismissed(true)}
          data-workflows-note
        />
      )}
      {workflowsState.status === "ready" &&
        refreshError &&
        !workflowsNoteDismissed && (
          <ErrorNote
            tone="warn"
            message="The workflows couldn't be re-read after that change, so a folder may be behind."
            detail={refreshError.detail || null}
            onRetry={() => void refreshWorkflows()}
            onDismiss={() => setWorkflowsNoteDismissed(true)}
            data-workflows-note
            data-workflows-refresh-note
          />
        )}

      <div className={gallery.toolbar}>
        <ScopeFilter
          rows={
            world
              ? scopeRows(world.all, world.projects, (x) => x.projectIds)
              : []
          }
          scope={scope}
          onPick={(id) =>
            setScope(
              id === "all"
                ? { kind: "all" }
                : id === "none"
                  ? { kind: "none" }
                  : { kind: "project", id },
            )
          }
        />
        <label className={gallery.search}>
          <IconSearch />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              closeIfHidden({ query: e.target.value, filter });
            }}
            placeholder="Search data…"
            aria-label="Search data"
          />
          <kbd>/</kbd>
        </label>
        <div className={gallery.chips} role="group" aria-label="Filter tables">
          <button
            className={gallery.filterChip}
            data-on={effectiveFilter === "all" || undefined}
            onClick={() => {
              setFilter("all");
              closeIfHidden({ query, filter: "all" });
            }}
          >
            {/* Counts appear only once the catalog has resolved. */}
            {tables ? (
              <>
                All
                <span className={gallery.chipCount}> · {tables.length}</span>
              </>
            ) : (
              "All"
            )}
          </button>
          {SOURCE_ORDER.filter((s) => (sourceCounts.get(s) ?? 0) > 0).map(
            (s) => (
              <button
                key={s}
                className={gallery.filterChip}
                style={{ "--dot": SOURCE_COLORS[s] } as React.CSSProperties}
                data-on={effectiveFilter === s || undefined}
                onClick={() => {
                  setFilter(s);
                  closeIfHidden({ query, filter: s });
                }}
              >
                <i />
                {FILTER_LABELS[s]}
                <span className={gallery.chipCount}>
                  {" "}
                  · {sourceCounts.get(s)}
                </span>
              </button>
            ),
          )}
        </div>
        <div className={gallery.tail}>
          <label className={gallery.sort}>
            Sort
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as DataSort)}
              aria-label="Sort tables"
            >
              <option value="updated">Recently updated</option>
              <option value="name">Name A–Z</option>
              <option value="rows">Row count</option>
              <option value="size">Size</option>
            </select>
          </label>
          <div className={gallery.viewToggle} role="group" aria-label="View">
            <button
              data-on={view === "grid" || undefined}
              data-hint="Grid view"
              aria-label="Grid view"
              onClick={() => setView("grid")}
            >
              <IconGrid />
            </button>
            <button
              data-on={view === "list" || undefined}
              data-hint="List view"
              aria-label="List view"
              onClick={() => setView("list")}
            >
              <IconList />
            </button>
          </div>
        </div>
      </div>

      <div className={gallery.scroller}>
        <AsyncState
          state={listState}
          onRetry={retry}
          pendingLabel="Reading your tables…"
        >
          {() => (
            <>
              {items &&
                view === "grid" &&
                (items.length > 0 || (tables?.length ?? 0) === 0) && (
                <div className={gallery.dataGrid} ref={setGridEl}>
                  {/* The grid advertises its door (expressly Data
                      Explorer half): the Maps ghost pattern, scaled to
                      a data cell, the grid's first cell at zero as well
                      as with tables (the chosen variant: left, like the
                      others); a search or filter that matches nothing
                      keeps prose alone, no ghost and no grid.
                      Render-only — never part of counts, sorting,
                      filters or the list manifest. */}
                  <button
                    className={`${gallery.ghost} ${gallery.ghostData}`}
                    onClick={() => {
                      skipped.current = false;
                      setPostgisDoor(null);
                      setDialogOpen(true);
                    }}
                  >
                    <span className={gallery.plus}>
                      <PlusIcon />
                    </span>
                    <b>Add data</b>
                    <small>
                      {tileSubLine("data", scope, scopeProjectName)}
                    </small>
                  </button>
                  {(() => {
                    // The open folder's pane after the last cell of its row (the
                    // Add data tile is each row's first cell); before the grid is
                    // measured, right after the folder.
                    const open = shownOpen
                      ? items.findIndex(
                          (i) => i.kind === "folder" && i.id === shownOpen,
                        )
                      : -1;
                    let paneAt = -1;
                    if (open >= 0) {
                      const cols = columns ?? 1;
                      const cell = open + 1;
                      paneAt = Math.min(
                        items.length - 1,
                        cell + (cols - 1 - (cell % cols)) - 1,
                      );
                    }
                    const cells: React.ReactNode[] = [];
                    items.forEach((item, i) => {
                      cells.push(
                        item.kind === "table" ? (
                          <TableCard
                            key={item.table.id}
                            table={item.table}
                            index={i}
                            actions={actionsFor(item.table)}
                            owner={othersOwner(item.table)}
                          />
                        ) : (
                          <FolderCard
                            key={`f-${item.id}`}
                            folder={item}
                            index={i}
                            open={item.id === shownOpen}
                            handlers={folderHandlers(item)}
                          />
                        ),
                      );
                      if (i === paneAt) {
                        const folder = items[open] as DataFolder;
                        cells.push(
                          <FolderPane
                            key={`pane-${folder.id}`}
                            folder={folder}
                            handlers={folderHandlers(folder)}
                          >
                            {folder.matching.map((t, j) => (
                              <TableCard
                                key={t.id}
                                table={t}
                                index={j}
                                actions={actionsFor(t)}
                                owner={othersOwner(t)}
                              />
                            ))}
                          </FolderPane>,
                        );
                      }
                    });
                    return cells;
                  })()}
                </div>
              )}

              {items && view === "list" && items.length > 0 && (
                <div className={gallery.listCard}>
                  <div className={gallery.tableScroll}>
                    <table className={gallery.dataTable}>
                      <thead>
                        <tr>
                          <th>Table name</th>
                          <th>Source</th>
                          <th>Geometry</th>
                          <th className={gallery.numCell}>Rows</th>
                          <th className={gallery.numCell}>Size</th>
                          <th>Project</th>
                          <th className={gallery.numCell}>Last updated</th>
                          <th aria-label="Actions" />
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((item) =>
                          item.kind === "table" ? (
                            <TableRow
                              key={item.table.id}
                              table={item.table}
                              actions={actionsFor(item.table)}
                              owner={othersOwner(item.table)}
                              projectFact={datasetProjectFact(
                                item.table.projectIds,
                                scope,
                                projectNames,
                              )}
                            />
                          ) : (
                            <Fragment key={`f-${item.id}`}>
                              <FolderRow
                                folder={item}
                                open={item.id === shownOpen}
                                handlers={folderHandlers(item)}
                                nameCellClass={styles.nameCell}
                                withProjectCell
                              />
                              {item.id === shownOpen &&
                                item.matching.map((t) => (
                                  <TableRow
                                    key={t.id}
                                    table={t}
                                    actions={actionsFor(t)}
                                    owner={othersOwner(t)}
                                    nested
                                    className={folderStyles.nested}
                                    leading={<NestedIndent />}
                                    onEscape={folderHandlers(item).onClose}
                                    projectFact={datasetProjectFact(
                                      t.projectIds,
                                      scope,
                                      projectNames,
                                    )}
                                  />
                                ))}
                            </Fragment>
                          ),
                        )}
                      </tbody>
                    </table>
                  </div>
                  {manifest && (
                    <div className={gallery.manifest}>
                      <span>
                        <b>{manifest.tables}</b> table
                        {manifest.tables === 1 ? "" : "s"} ·{" "}
                        <b>{formatCompactCount(manifest.rows)}</b> rows ·{" "}
                        <b>{formatBytes(manifest.bytes)}</b> on disk ·{" "}
                        <b>{manifest.refreshable}</b> refreshable import
                        {manifest.refreshable === 1 ? "" : "s"}
                      </span>
                      {manifest.crsAssumed > 0 && (
                        <span className={gallery.manifestFlag}>
                          <i />
                          <b>{manifest.crsAssumed}</b> table
                          {manifest.crsAssumed === 1 ? "" : "s"} with assumed
                          CRS
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {items && items.length === 0 && (tables?.length ?? 0) > 0 && (
                <p className={gallery.empty}>
                  No tables match. Clear the search or filters.
                </p>
              )}

              {tables && tables.length === 0 && view === "list" && (
                // Resolved-empty in list view is the same actionable tile
                // the Maps gallery established, centred; in grid view it
                // is the grid's first cell above.
                <div className={gallery.emptyAction}>
                  <button
                    className={gallery.ghost}
                    onClick={() => {
                      skipped.current = false;
                      setPostgisDoor(null);
                      setDialogOpen(true);
                    }}
                  >
                    <span className={gallery.plus}>
                      <PlusIcon />
                    </span>
                    <b>Add data</b>
                    <small>
                      {tileSubLine("data", scope, scopeProjectName)}
                    </small>
                  </button>
                </div>
              )}
            </>
          )}
        </AsyncState>
      </div>

      <AddDataDialog
        open={dialogOpen}
        projectId={scopeProjectId}
        projectName={scopeProjectName}
        onClose={closeAddDialog}
        onTableCreated={onCreated}
        onPostgisTableCreated={() => {
          void refreshListing();
          setPostgisDoor(null);
        }}
        onSkipped={(s) => {
          skipped.current = s.length > 0;
          showImportNotice(s.length ? skippedNotice(s) : null);
        }}
        uploadQueue={uploadQueue}
        initialPostgisConnectionId={postgisDoor}
      />

      <AddToMapDialog
        key={addToMap ?? "closed"}
        subject={tableSubject(addToMap)}
        onClose={() => setAddToMap(null)}
      />
    </div>
  );
}
