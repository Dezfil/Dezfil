"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { TableInspection } from "./api";
import { usePathname } from "next/navigation";
import { contributePath, releasePath } from "@/components/shell/path-model";
import { PlainCrumbTail } from "@/components/shell/PlainCrumbTail";
import {
  formatBytes,
  formatCount,
  formatRelativeTime,
  readApiError,
} from "./api";
import { AddToMapDialog, tableSubject } from "./AddToMapDialog";
import { ExportMenu } from "./ExportMenu";
import { datasetQueryHref } from "./dataset-doors";
import { TablePreviewMap } from "./TablePreviewMap";
import { Spinner } from "./Spinner";
import { TablePreviewGrid } from "./TablePreviewGrid";
import { ChoicePreviewMap } from "./set-geometry/ChoicePreviewMap";
import { livePreview } from "./set-geometry/live-preview";
import { SetGeometryPanel } from "./set-geometry/SetGeometryPanel";
import { canSetGeometry } from "./set-geometry/eligibility";
import { ProposalStrip, proposedPair } from "./set-geometry/ProposalStrip";
import { useSetGeometryPanel } from "./set-geometry/use-set-geometry-panel";
import {
  IconAddToMap,
  IconBack,
  IconMap,
  IconRefresh,
  IconSql,
  IconTable,
  IconTrash,
} from "./gallery-icons";
import {
  CrsChip,
  GeometryChip,
  HeaderChip,
  SourceChip,
  sourceTitle,
  isRefreshableImport,
} from "./table-chips";
import { GeometryProvenance } from "./GeometryProvenance";
import { TableRunState } from "./TableRunState";
import { useRecipes } from "./builder/drawer/use-recipes";
import gallery from "./gallery.module.css";
import { TabPanel, Tabs } from "./ui/Tabs";
import { AsyncState, useAsync } from "./ui/AsyncState";
import { CaretIcon, ChevronIcon, GeoPinIcon } from "./ui/icons";
import { ErrorNote } from "./ui/ErrorNote";
import { PostgisProvenance } from "./connections/PostgisProvenance";
import styles from "./TableDetailScreen.module.css";

type Tab = "map" | "data";

/** The dataset detail: header with chips and actions, then two
 * tabs — the table's features on a map, and its first rows. */

/** The detail's path contribution. */
function usePathContribution(table: TableInspection | null): void {
  const pathname = usePathname();
  const name = table?.name ?? null;
  const projectId =
    table && table.projectIds.length === 1 ? table.projectIds[0] : null;
  useEffect(() => {
    if (!name) return;
    contributePath(pathname, { name, projectId });
    return () => releasePath(pathname);
  }, [pathname, name, projectId]);
}

export function TableDetailScreen({
  name,
  openGeometry = false,
}: {
  name: string;
  /** The open-with-panel address: open the panel on mount. */
  openGeometry?: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [version, setVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [addToMap, setAddToMap] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("map");
  // **Where a derived dataset came from, on the surface a user inspects its
  // features from**. Without it this screen shows an operation's output as an
  // anonymous table: the name of the step that wrote it lives only in the
  // recipe, which is the drawer, which is exactly the surface the guardrail
  // says results must not depend on.
  const { recipes, error: recipesError, reload: reloadRecipes } = useRecipes();
  // The set-geometry panel: one controller per dataset; a successful
  // apply re-reads the dataset the way a refresh does, so the chip, the
  // record line, the primary action and both previews come from the one
  // read the page always uses.
  const reread = useCallback(() => {
    setError(null);
    setVersion((v) => v + 1);
  }, []);

  const { state: tableState, retry: retryTable } = useAsync<TableInspection>(
    async () => {
      const response = await fetch(`/api/tables/${encodeURIComponent(name)}`);
      if (!response.ok) throw new Error(await readApiError(response));
      return (await response.json()) as TableInspection;
    },
    `${name}:${version}`,
  );
  // The panel's controller lives here, above the loading boundary: a re-read renders the pending
  // state and mounts the detail again, and the address must open the panel once, not once per
  // mount. The facts a door opens on are the current read's.
  const read = tableState.status === "ready" ? tableState.value : null;
  const showGeometryData = useCallback(() => setTab("data"), []);
  const panel = useSetGeometryPanel({
    name,
    table: { geometryColumn: read?.geometryColumn ?? null, crsAssumed: read?.crsAssumed ?? false },
    onApplied: reread,
    onOpen: showGeometryData,
  });

  const refresh = useCallback(
    async (release?: string) => {
      setRefreshing(true);
      try {
        const response = await fetch(
          `/api/tables/${encodeURIComponent(name)}/refresh`,
          {
            method: "POST",
            ...(release
              ? {
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ release }),
                }
              : {}),
          },
        );
        if (!response.ok) {
          setError(await readApiError(response));
          return;
        }
        setError(null);
        setVersion((v) => v + 1);
      } finally {
        setRefreshing(false);
      }
    },
    [name],
  );

  const remove = useCallback(async () => {
    const response = await fetch(`/api/tables/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      setError(await readApiError(response));
      return;
    }
    router.push("/data");
  }, [name, router]);

  // Pending, failed-with-retry and content are distinct, and the empty
  // shell is never shown as if the read had finished.
  usePathContribution(tableState.status === "ready" ? tableState.value : null);
  if (tableState.status !== "ready") {
    return (
      <div>
        <Link href="/data" className={styles.backLink}>
          <ChevronIcon /> Data
        </Link>
        <AsyncState
          state={tableState}
          onRetry={retryTable}
          pendingLabel="Reading table…"
        >
          {() => null}
        </AsyncState>
      </div>
    );
  }

  const table = tableState.value;
  // The shell's path model: the table detail contributes its name —
  // plain, not editable — and its project only when membership is
  // unambiguous (several projects contribute none).
  return (
    <TableDetail
      table={table}
      tab={tab}
      setTab={setTab}
      error={error}
      setError={setError}
      confirming={confirming}
      setConfirming={setConfirming}
      refreshing={refreshing}
      refresh={refresh}
      remove={remove}
      addToMap={addToMap}
      setAddToMap={setAddToMap}
      recipes={recipesError ? null : recipes}
      onRunSettled={() => {
        reloadRecipes();
        setVersion((v) => v + 1);
      }}
      panel={panel}
      router={router}
      openGeometry={openGeometry}
    />
  );
}

/** The read dataset's screen, split from the read; the panel it docks is
 * the screen's, handed in so it outlives the read. */
function TableDetail({
  table,
  tab,
  setTab,
  error,
  setError,
  confirming,
  setConfirming,
  refreshing,
  refresh,
  remove,
  addToMap,
  setAddToMap,
  recipes,
  onRunSettled,
  panel,
  router,
  openGeometry,
}: {
  table: TableInspection;
  tab: Tab;
  setTab: (tab: Tab) => void;
  error: string | null;
  setError: (error: string | null) => void;
  confirming: boolean;
  setConfirming: (confirming: boolean) => void;
  refreshing: boolean;
  refresh: (release?: string) => Promise<void>;
  remove: () => Promise<void>;
  addToMap: string | null;
  setAddToMap: (name: string | null) => void;
  recipes: ReturnType<typeof useRecipes>["recipes"] | null;
  onRunSettled: () => void;
  panel: ReturnType<typeof useSetGeometryPanel>;
  router: ReturnType<typeof useRouter>;
  openGeometry: boolean;
}) {
  const panelOpen = panel.state.phase === "open";
  // The inspection in flight (field round): a large dataset's
  // read takes seconds, and the page must show the work from the first
  // click, whichever door opened it, rather than nothing until it lands.
  const opening = panel.state.phase === "opening";
  const answer = panelOpen ? panel.state.preview.answer : null;
  // The doors: only where the API accepts the dataset's source.
  const doors = canSetGeometry(table);
  // The proposal strip over the page's own read: the first weak
  // pair candidate; Not now removes it for this visit.
  const proposal =
    doors && table.geometryColumn === null
      ? proposedPair(table.geometryCandidates)
      : null;
  const [proposalDismissed, setProposalDismissed] = useState(false);
  // The address opens the panel once per dataset, however often the
  // detail mounts; a dataset the API refuses shows the page as shipped
  // with the refusal in its note.
  const { openByAddress } = panel;
  useEffect(() => {
    if (openGeometry) openByAddress();
  }, [openGeometry, openByAddress]);
  // The inspection the panel could not open on (a dataset the API refuses,
  // reached by a door or by address): the page's own note, as the API
  // words it, with the page as shipped behind it.
  const pageError = error ?? panel.state.openError;
  // While the panel is open the grid shows the answer's own rows with its
  // chosen columns tagged and its unreadable rows marked (live-preview.ts).
  const grid = livePreview(panel.state, table);

  return (
    <div className={styles.screen}>
      <PlainCrumbTail name={table.name} owner={table.owner} />
      <div className={styles.head}>
        <Link
          href="/data"
          className={styles.back}
          title="Back to Data"
          aria-label="Back to Data"
        >
          <IconBack />
        </Link>
        <div className={styles.title}>
          <h1>{table.name}</h1>
          <div className={gallery.cardChips}>
            <SourceChip table={table} />
            <GeometryChip table={table} />
            <CrsChip
              table={table}
              onOpen={
                canSetGeometry(table)
                  ? () => panel.open(null, { markProjection: true })
                  : undefined
              }
            />
            <HeaderChip table={table} />
            <span className={gallery.chip}>
              updated {formatRelativeTime(table.importedAt ?? table.createdAt)}
            </span>
          </div>
        </div>
        <div className={styles.actions}>
          {table.geometryColumn ? (
            // The list pages' add button, as the door below: one slot, one
            // treatment whichever state the dataset is in.
            <button
              type="button"
              className={gallery.primary}
              onClick={() => setAddToMap(table.qualifiedName)}
              data-add-to-map="primary"
            >
              <IconAddToMap />
              Add to a map
            </button>
          ) : (
            doors && (
              // The list pages' add button (ListHeading), so the slot reads
              // as one family with Add data and New map. While the
              // inspection is read the door is busy the way the kit's
              // Button is: it cannot fire again, says so, and spins.
              <button
                type="button"
                className={gallery.primary}
                onClick={() => panel.open()}
                disabled={opening}
                aria-busy={opening || undefined}
                data-set-geometry-door="primary"
              >
                <GeoPinIcon />
                {opening && <Spinner size={12} tone="current" />}
                Set geometry
              </button>
            )
          )}
          <button
            className={styles.aux}
            title="Query in SQL"
            aria-label={`Query ${table.name} in SQL`}
            onClick={() => router.push(datasetQueryHref(table))}
          >
            <IconSql />
          </button>
          <ExportMenu
            name={table.name}
            dataset={table}
            spatial={!!table.geometryColumn}
            triggerClassName={styles.aux}
          />
          {isRefreshableImport(table) && (
            <button
              className={styles.aux}
              title="Re-run the stored import"
              aria-label="Re-run the stored import"
              data-busy={refreshing || undefined}
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              <IconRefresh />
            </button>
          )}
          {confirming ? (
            <span className={styles.confirm}>
              Delete this table and its data?
              <button className={styles.dangerBtn} onClick={remove}>
                Delete
              </button>
              <button
                className={styles.quietBtn}
                onClick={() => setConfirming(false)}
              >
                Keep
              </button>
            </span>
          ) : (
            <button
              className={`${styles.aux} ${styles.auxDanger}`}
              title="Delete this table and its data"
              aria-label={`Delete ${table.name}`}
              onClick={() => setConfirming(true)}
            >
              <IconTrash />
            </button>
          )}
        </div>
      </div>

      {proposal && !proposalDismissed && !panelOpen && (
        <ProposalStrip
          pair={proposal}
          onSetGeometry={(seed) => panel.open(seed)}
          onNotNow={() => setProposalDismissed(true)}
        />
      )}

      {pageError && (
        <ErrorNote
          message={pageError}
          onDismiss={() => (error ? setError(null) : panel.controller.dismiss())}
        />
      )}

      <p className={styles.provenance}>
        {table.source === "postgis" ? (
          <PostgisProvenance table={table} />
        ) : (
          sourceTitle(table)
        )}
        <GeometryProvenance
          record={table.geometryRecord}
          onChange={canSetGeometry(table) ? () => panel.open() : undefined}
        />
        <TableRunState
          // A failed read answers `[]` with an error beside it; ownership
          // is then unknown, never "nothing owns it".
          recipes={recipes}
          table={table}
          onSettled={onRunSettled}
        />
        {table.source === "overture" && (
          <button
            className={styles.provenanceAct}
            onClick={() => void refresh("latest")}
            disabled={refreshing}
            title="Move the stored recipe to the newest Overture release and re-import"
          >
            Update to latest release
          </button>
        )}
        {table.importedAt && (
          <> · last run {new Date(table.importedAt).toLocaleString()}</>
        )}
      </p>

      <div className={styles.bodyRow}>
        {(panelOpen || opening) && (
          <SetGeometryPanel
            name={table.name}
            state={panel.state}
            controller={panel.controller}
          />
        )}
        <div className={styles.paneCol}>
          <div className={styles.tabsRow}>
            <Tabs
              group="table-detail"
              label="Table views"
              className={styles.tabs}
              value={tab}
              onChange={setTab}
              tabs={[
                {
                  value: "map" as const,
                  name: "Map preview",
                  label: (
                    <>
                      <IconMap />
                      Map preview
                    </>
                  ),
                },
                {
                  value: "data" as const,
                  name: "Data preview",
                  label: (
                    <>
                      <IconTable />
                      Data preview
                    </>
                  ),
                },
              ]}
            />
            {panelOpen && (
              <span className={styles.liveTag} data-live-tag="">
                <i />
                Preview of the choice
              </span>
            )}
          </div>

          {tab === "map" && (
            <TabPanel group="table-detail" value="map" className={styles.pane}>
              {answer ? (
                <ChoicePreviewMap
                  answer={answer}
                  record={panel.state.preview.answerRecord}
                />
              ) : (
                <TablePreviewMap
                  name={table.qualifiedName}
                  crsAssumed={table.crsAssumed}
                  onSetGeometry={
                    doors && table.geometryColumn === null
                      ? () => panel.open()
                      : undefined
                  }
                />
              )}
            </TabPanel>
          )}

          {tab === "data" && (
            <TabPanel group="table-detail" value="data" className={styles.pane}>
              <TablePreviewGrid
                columns={grid.columns}
                rows={grid.rows}
                tags={grid.tags}
                marks={grid.marks}
              />
              <p className={styles.previewNote}>
                Showing the first {formatCount(grid.rows.length)} of{" "}
                {formatCount(table.rowCount)} rows ·{" "}
                {grid.columns.length} columns · {formatBytes(table.sizeBytes)} on
                disk ·{" "}
                <Link
                  href={datasetQueryHref(table)}
                  className={styles.sqlLink}
                >
                  Open in SQL workspace <CaretIcon />
                </Link>
              </p>
            </TabPanel>
          )}
        </div>
      </div>

      <AddToMapDialog
        key={addToMap ?? "closed"}
        subject={tableSubject(addToMap)}
        onClose={() => setAddToMap(null)}
      />
    </div>
  );
}
