"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { DataTable, TableListing } from "../../api";
import type { SkippedMember } from "../../skipped-members";
import type { MiniViewport } from "../../MiniMap";
import { UploadZone } from "../../UploadZone";
import type { UploadQueue } from "../../use-upload-queue";
import { UrlImportPane } from "../../UrlImportPane";
import { OverturePane } from "../../OverturePane";
import { OsmPane } from "../../OsmPane";
import { PostgisPane } from "../../connections/PostgisPane";
import {
  CATALOG_SOURCES,
  IMPORT_SOURCES,
  SourceNavButton,
} from "../../SourceNav";
import type {
  CatalogRequest,
  CreateLayerOutcome,
  PostgisLayerOutcome,
  UploadSoftNote,
} from "../use-layer-source-coordinator";
import { ErrorNote } from "../../ui/ErrorNote";
import { CatalogTablesView } from "./CatalogTablesView";
import { CatalogWorkbench } from "./CatalogWorkbench";
import { followName, followSeed, homeLine, impliedQuery, typedInHome } from "./catalog-state";
import { useSignedInSqlName } from "../../sharing/signed-in";
import type { PersonLabel } from "../../sharing/people";
import { parseScope, type ProjectScope } from "../../scope/model";
import { useProjectName } from "../../shell/use-project-name";
import {
  useCatalogTables,
  type CatalogListing,
} from "./use-catalog-tables";
import { Dialog } from "../../ui/Dialog";
import { TabPanel, Tabs, type TabSpec } from "../../ui/Tabs";
import { IconButton } from "../../ui/IconButton";
import { XIcon } from "../../ui/icons";
import { datasetGeometryHref } from "../../dataset-doors";
import styles from "./AddLayerCatalog.module.css";

/** The two ways a file becomes a table. */
const FILE_TABS: readonly TabSpec<"upload" | "url">[] = [
  { value: "upload", label: "Upload file" },
  { value: "url", label: "From URL" },
];

export type { CatalogRequest };

/** The Layers-tab entry (cutover): in the old panel's place, it
 * opens the catalog instead of growing a card in the rail. */
export function AddLayerTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <button className={styles.trigger} onClick={onOpen}>
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M12 5v14M5 12h14" />
      </svg>
      Add layer
    </button>
  );
}

type Source = "tables" | "sql" | "files" | "overture" | "osm" | "postgis";

const SOURCE_TITLES: Record<Source, { title: string; sub: string }> = {
  tables: {
    title: "Tables",
    sub: "Pick a dataset. It becomes this layer's query",
  },
  sql: {
    title: "SQL query",
    sub: "Read-only preview first; a spatial result becomes the layer",
  },
  files: { title: "Files", sub: "Upload or read from a URL" },
  overture: {
    title: "Overture Maps",
    sub: "Curated open data, read straight from S3",
  },
  osm: {
    title: "OpenStreetMap",
    sub: "Query the living map: tags in, tables out",
  },
  postgis: {
    title: "PostGIS",
    sub: "Connect your database, import snapshots",
  },
};

interface Props {
  request: CatalogRequest;
  onClose: () => void;
  /** A create outcome that settles after the dialog was dismissed
   * (decision 11 allows dismissal mid-flight) surfaces here instead of
   * vanishing with the unmount — the builder's notice channel. */
  onDismissedOutcome?: (message: string) => void;
  /** Coordinator-backed create; durable work survives the dialog. SQL
   * written in the console (a picked dataset) says so and is carried into
   * the map's home. */
  createLayer: (name: string, sql: string, writtenIn?: { kind: "console" }) => Promise<CreateLayerOutcome>;
  /** Edit mode: persist SQL through the existing reconciling save lane.
   * Resolves true when the save was accepted. */
  updateLayer?: (sql: string) => Promise<boolean>;
  /** Edit mode: the layer's save lane's live failure text — the same
   * message the rail banner carries, mirrored inline (spec decision 9). */
  updateFailure?: string | null;
  /** Import completion — the coordinator's batch normalizer. The first
   * created table closes the catalog; the batch settles behind it. */
  onTableImported?: (table: DataTable) => void;
  /** PostGIS waits for this single-table coordinator outcome before it
   * renders any terminal layer claim. */
  onPostgisTableImported: (table: DataTable) => Promise<PostgisLayerOutcome>;
  /** Container members the import skipped — parent-owned. */
  setPendingSkips?: (skipped: SkippedMember[]) => void;
  /** The coordinator-owned file batch: the queue outlives
   * this dialog, so closing never orphans the request in flight. It
   * also carries the held-open soft-outcome notes — files that imported
   * but confirmed no layer. */
  uploadQueue: UploadQueue & { softNotes?: UploadSoftNote[] | null };
  /** Bumped by the coordinator when the authoritative table set may
   * have changed mid-batch — the dataset listing re-reads. */
  listingStamp?: number;
  /** Map-based sources start from the builder's viewport. */
  initialViewport?: MiniViewport | null;
  /** The map's project: the filter's default scope and the
   * import context — imports from a filed map's catalog join it. */
  projectId?: string | null;
  /** The map being added to: the SQL view previews in its home. */
  mapId?: string;
  /** The SQL name of the map's SQL home: the catalogue names datasets as
   * the map's SQL types them. */
  mapHome?: string | null;
  /** The map's owner, named in the line under the scope. */
  mapOwner?: PersonLabel | null;
}

/**
 * The add-layer catalog (Chandlery): the builder's one door for creating
 * a layer — an existing table, a SQL query, or an import — and, scoped,
 * for editing a layer's source. Modal contract: focus contained via an
 * inert background, Esc and scrim dismiss, focus returns to the opener.
 * Closing discards unsubmitted drafts only — submitted work is
 * coordinator-owned and completes regardless (spec decision 11).
 */
export function AddLayerCatalog({
  request,
  onClose,
  onDismissedOutcome,
  createLayer,
  updateLayer,
  updateFailure = null,
  onTableImported,
  onPostgisTableImported,
  setPendingSkips,
  uploadQueue,
  listingStamp = 0,
  initialViewport = null,
  projectId = null,
  mapId,
  mapHome = null,
  mapOwner = null,
}: Props) {
  const editing = request.kind === "edit";
  // The non-spatial note's door (04): the catalog closes, its
  // unsubmitted draft discarded as rules, and the builder is left for
  // the dataset page at its open-with-panel address.
  const router = useRouter();
  const setGeometry = useCallback(
    (table: TableListing) => {
      onClose();
      router.push(datasetGeometryHref(table));
    },
    [onClose, router],
  );
  // Dismissal mid-flight is allowed (decision 11); an outcome settling
  // after unmount reroutes to the builder's notice channel. The body
  // must re-arm the ref: StrictMode's simulated remount runs the
  // cleanup on the SAME instance, and a false ref here means a
  // successful create can never close the dialog (sweep catch).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Files first: the door's default is the upload zone; editing an
  // existing layer still opens straight on SQL.
  const [source, setSource] = useState<Source>(editing ? "sql" : "files");
  const [filesTab, setFilesTab] = useState<"upload" | "url">("upload");
  // A finished import closes the catalog; the coordinator settles the
  // batch behind it (selection, framing, one notice).
  const imported = useCallback(
    (table: DataTable) => {
      onClose();
      onTableImported?.(table);
    },
    [onClose, onTableImported],
  );
  // Edit mode is pinned to the layer captured at open (spec decision 9):
  // the draft starts from its saved SQL and nothing follows selection.
  const [editDraft, setEditDraft] = useState(
    request.kind === "edit" ? request.sql : "",
  );

  // The browsing scope: one per opening, defaulted to the map's project
  // when filed and All projects when not — a derived default, recorded
  // in the spec. Presentation state stays transient.
  const [scope, setScope] = useState<ProjectScope>(() =>
    projectId != null ? { kind: "project", id: projectId } : { kind: "all" },
  );

  // Selection and the name-follow rule (spec decision 3). A pick is
  // only real while the offered list still has it — and a scope change
  // that resolves without it CLEARS the stored pick,
  // so it can never silently resurrect under a later scope.
  // A pick is held by the name its reader types, which tells two
  // same-named datasets apart.
  const [pickedName, setPickedName] = useState<string | null>(null);
  const settleOffered = useCallback((offered: TableListing[]) => {
    setPickedName((current) =>
      current !== null && !offered.some((t) => t.qualifiedName === current)
        ? null
        : current,
    );
  }, []);

  // The reads (extracted at the touch): the base world per attempt and
  // mid-batch stamp, the active scope keyed so a superseded answer
  // never repaints a newer one.
  const { listing: reads } = useCatalogTables({
    scope,
    listingStamp,
    onOffered: settleOffered,
  });
  const pickScope = useCallback((id: string) => {
    setScope(parseScope(id === "all" ? null : id));
  }, []);
  // Names as the map's SQL types them: on someone else's map one's own
  // datasets carry one's SQL name, and one line under the scope says so.
  const me = useSignedInSqlName();
  const typed = useCallback((t: TableListing) => typedInHome(t, mapHome), [mapHome]);
  const listing: CatalogListing = {
    ...reads,
    scope,
    onScope: pickScope,
    typed,
    homeLine: homeLine(mapHome, mapOwner, me, reads.offered ?? []),
  };
  const offered = reads.offered;
  const picked =
    pickedName !== null && offered !== null
      ? (offered.find((t) => t.qualifiedName === pickedName) ?? null)
      : null;

  // The import wing's stated trade: imports made from a filed map's
  // catalog join its project, whatever the browser shows — short
  // wording on the map's own project, the fuller one under any other
  // scope; an unfiled map carries no line. The name resolves through
  // the shell's cached directory, NOT the catalog's own reads: the
  // surfaces that send the context are usable while those reads settle,
  // so the promise must not wait on them; the
  // catalog's directory read backstops.
  const shellName = useProjectName(projectId);
  const projectName =
    projectId !== null
      ? (shellName ??
        reads.world?.projects.find((p) => p.id === projectId)?.name ??
        null)
      : null;
  const importLine =
    projectName === null
      ? null
      : scope.kind === "project" && scope.id === projectId
        ? `Imported datasets join ${projectName}.`
        : `Imported datasets join ${projectName}, this map's project.`;
  const [name, setName] = useState("");
  const prevAutoRef = useRef<string | null>(null);
  const pick = useCallback((t: TableListing) => {
    // Capture before mutating: the updater runs after this handler, so
    // reading the ref inside it would compare against the NEW pick and
    // freeze the auto-name on the first table.
    const previousAuto = prevAutoRef.current;
    setName((n) => followName(n, previousAuto, t.name));
    prevAutoRef.current = t.name;
    setPickedName(t.qualifiedName);
  }, []);

  // Inline commit outcome: rejection and
  // uncertainty stay beside the draft; success closes — selection,
  // framing, and history are the coordinator's.
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // The SQL draft and the table-to-SQL carry (spec decision 4): seeding
  // follows the same ownership rule as the name — never over the user's
  // own SQL.
  const [sqlDraft, setSqlDraft] = useState("");
  const prevSeedRef = useRef<string | null>(null);
  const switchToSql = useCallback(() => {
    setSqlDraft((d) => {
      const next = followSeed(d, prevSeedRef.current, picked ? typed(picked) : null);
      if (next !== d) prevSeedRef.current = next;
      return next;
    });
    setCreateError(null);
    setSource("sql");
  }, [picked, typed]);
  const switchToTables = useCallback(() => {
    setCreateError(null);
    setSource("tables");
  }, []);
  const switchSource = useCallback((next: Source) => {
    setCreateError(null);
    setSource(next);
  }, []);

  const settleCreate = useCallback(
    (outcome: CreateLayerOutcome) => {
      if (outcome.kind === "created") {
        if (mountedRef.current) onClose();
        return;
      }
      if (mountedRef.current) {
        setCreateError(outcome.message);
      } else {
        // The dialog was dismissed while the create was in flight — the
        // failure must not vanish with it.
        onDismissedOutcome?.(outcome.message);
      }
    },
    [onClose, onDismissedOutcome],
  );
  const submitPick = useCallback(async () => {
    if (busy || picked === null || picked.geometryColumn === null) return;
    setBusy(true);
    setCreateError(null);
    // The pick names the dataset as the console does, and that is where
    // the server carries it from: another person's map gets its identity.
    const outcome = await createLayer(
      name.trim() || picked.name,
      impliedQuery(picked.qualifiedName),
      { kind: "console" },
    );
    setBusy(false);
    settleCreate(outcome);
  }, [busy, picked, name, createLayer, settleCreate]);
  const submitSql = useCallback(async () => {
    if (busy || sqlDraft.trim() === "") return;
    setBusy(true);
    setCreateError(null);
    const outcome = await createLayer(name, sqlDraft);
    setBusy(false);
    settleCreate(outcome);
  }, [busy, sqlDraft, name, createLayer, settleCreate]);
  const submitUpdate = useCallback(async () => {
    if (busy || updateLayer === undefined || editDraft.trim() === "") return;
    setBusy(true);
    const accepted = await updateLayer(editDraft);
    setBusy(false);
    // Success closes — the canvas re-render and the confirmation notice
    // are visible behind the dialog. Failure keeps the draft beside the
    // lane's own message (the updateFailure mirror).
    if (accepted) onClose();
  }, [busy, updateLayer, editDraft, onClose]);

  const title =
    request.kind === "add"
      ? "Add layer"
      : `Layer source: ${request.layerName}`;

  if (request.kind === "edit") {
    return (
      <Dialog
        label={title}
        onClose={onClose}
        className={styles.dialog}
        data-wide
      >
        <div className={styles.main}>
          <header className={styles.head}>
            <div className={styles.headTitle}>
              <strong>{title}</strong>
              <small>Scoped to this layer. The map updates on save</small>
            </div>
            <IconButton
              className={styles.close}
              tone="chrome"
              action="Close"
              icon={<XIcon />}
              onClick={onClose}
            />
          </header>
          <div className={styles.sqlView}>
            <CatalogWorkbench
              listing={listing}
              mapId={mapId}
              draft={editDraft}
              onDraft={setEditDraft}
              mode="edit"
              savedSql={request.sql}
              busy={busy}
              error={updateFailure}
              errorMirrored
              onCommit={() => void submitUpdate()}
            />
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      label={title}
      onClose={onClose}
      className={styles.dialog}
      data-wide={source === "sql" || source === "postgis" || undefined}
      data-map-source={source === "overture" || source === "osm" || undefined}
    >
      <nav className={styles.nav} aria-label="Layer sources">
        <h2 className={styles.navTitle}>{title}</h2>
        <div className={styles.navGroup}>Sources</div>
        <SourceNavButton
          spec={CATALOG_SOURCES.tables}
          active={source === "tables"}
          onSelect={switchToTables}
        />
        <SourceNavButton
          spec={CATALOG_SOURCES.sql}
          active={source === "sql"}
          onSelect={switchToSql}
        />
        <div className={styles.navGroup}>Import</div>
        {(["files", "overture", "osm", "postgis"] as const).map((key) => (
          <SourceNavButton
            key={key}
            spec={IMPORT_SOURCES[key]}
            active={source === key}
            onSelect={() => switchSource(key)}
          />
        ))}
        <span className={styles.navSpace} />
      </nav>
      <div className={styles.main}>
        <header className={styles.head}>
          {source === "files" ? (
            <Tabs
              group="catalog-files"
              label="File sources"
              className={styles.tabs}
              value={filesTab}
              onChange={setFilesTab}
              tabs={FILE_TABS}
            />
          ) : (
            <div className={styles.headTitle}>
              <strong>{SOURCE_TITLES[source].title}</strong>
              <small>{SOURCE_TITLES[source].sub}</small>
            </div>
          )}
          <IconButton
            className={styles.close}
            tone="chrome"
            action="Close"
            icon={<XIcon />}
            onClick={onClose}
          />
        </header>
        {source === "tables" ? (
          <CatalogTablesView
            listing={listing}
            picked={picked}
            onPick={pick}
            name={name}
            onName={setName}
            busy={busy}
            error={createError}
            onDismissError={() => setCreateError(null)}
            onCreate={() => void submitPick()}
            onSetGeometry={setGeometry}
          />
        ) : source === "sql" ? (
          <div className={styles.sqlView}>
            <CatalogWorkbench
              listing={listing}
              mapId={mapId}
              draft={sqlDraft}
              onDraft={setSqlDraft}
              mode="add"
              busy={busy}
              error={createError}
              onDismissError={() => setCreateError(null)}
              onCommit={() => void submitSql()}
            />
            <footer className={styles.foot}>
              <label className={styles.nameField}>
                <span>Layer name</span>
                <input
                  value={name}
                  placeholder="Untitled layer"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            </footer>
          </div>
        ) : source === "overture" ? (
          <div className={styles.paneFill}>
            <OverturePane
              initialViewport={initialViewport}
              onTableCreated={imported}
              projectId={projectId}
            />
            {importLine !== null && (
              <p className={styles.scopeNote}>{importLine}</p>
            )}
          </div>
        ) : source === "osm" ? (
          <div className={styles.paneFill}>
            <OsmPane
              initialViewport={initialViewport}
              onTableCreated={imported}
              projectId={projectId}
            />
            {importLine !== null && (
              <p className={styles.scopeNote}>{importLine}</p>
            )}
          </div>
        ) : source === "postgis" ? (
          <div className={styles.paneFill}>
            <PostgisPane
              context="addlayer"
              onLayerTableCreated={onPostgisTableImported}
              onStaleLayerOutcome={onDismissedOutcome}
              onDone={onClose}
              projectId={projectId}
            />
            {importLine !== null && (
              <p className={styles.scopeNote}>{importLine}</p>
            )}
          </div>
        ) : filesTab === "upload" ? (
          <TabPanel
            group="catalog-files"
            value="upload"
            className={styles.importPane}
          >
            <UploadZone queue={uploadQueue} />
            {/* The held-open account: files that imported but confirmed
                no layer keep this catalog open, named. */}
            {(uploadQueue.softNotes ?? []).map((note, i) => (
              <ErrorNote
                // Two files can share a basename (dragged from
                // different directories) — the index disambiguates,
                // and it is stable: the list is only ever replaced
                // wholesale at settlement, never reordered.
                key={`${i}:${note.filename}`}
                tone="warn"
                message={`${note.filename}: ${note.outcomes.join(" · ")}`}
              />
            ))}
            <p className={styles.stateHint}>
              A file with several layers lands as one table each.
            </p>
            {importLine !== null && (
              <p className={styles.scopeNote}>{importLine}</p>
            )}
          </TabPanel>
        ) : (
          <TabPanel
            group="catalog-files"
            value="url"
            className={styles.importPane}
          >
            <UrlImportPane
              onTableCreated={imported}
              onSkipped={setPendingSkips}
              projectId={projectId}
            />
            {importLine !== null && (
              <p className={styles.scopeNote}>{importLine}</p>
            )}
          </TabPanel>
        )}
      </div>
    </Dialog>
  );
}
