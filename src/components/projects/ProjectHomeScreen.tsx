"use client";

import { membershipBody } from "./filing-intent";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { formatRelativeTime, readApiError } from "../api";
import {
  IconDownload,
  IconFolderPlus,
  IconGrid,
  IconList,
} from "../gallery-icons";
import { invalidateProjects } from "../shell/use-project-name";
import { contributePath, releasePath, useInstanceName } from "../shell/path-model";
import { Button } from "../ui/Button";
import { AddDataDialog } from "../AddDataDialog";
import { NewWorkflowDialog } from "../NewWorkflowDialog";
import { skippedNotice } from "../skipped-members";
import { uploadSettleNotice } from "../upload-settle-notice";
import { useUploadQueue } from "../use-upload-queue";
import { Dialog } from "../ui/Dialog";
import { ErrorNote } from "../ui/ErrorNote";
import { Menu, MenuItem } from "../ui/Menu";
import { Spinner } from "../Spinner";
import { useOperations } from "../builder/drawer/use-operations";
import { AddItemsDialog } from "./AddItemsDialog";
import { AttentionArea } from "./AttentionArea";
import { EmptyHome } from "./EmptyHome";
import { ExportProjectDialog } from "./ExportProjectDialog";
import { HomeSections, type HomeView } from "./HomeSections";
import { KindIcon } from "./ProjectPicture";
import { ProjectCrumbTail } from "../shell/ProjectCrumbTail";
import type { PictureBasemaps } from "@/lib/picture-credit";
import { PlainCrumbTail } from "../shell/PlainCrumbTail";
import { RoleLine } from "../sharing/PeopleMarks";
import { MembersLine } from "../sharing/MembersLine";
import { ShareDialog } from "../sharing/ShareDialog";
import { PeopleIcon } from "../ui/icons";
import { useSignedInSqlName } from "../sharing/signed-in";
import { LeaveProjectDialog, ownsFiledWork } from "./LeaveProjectDialog";
import { useDepartureNotice } from "./departure-notice";
import { attentionRows, factsLine, homeStats } from "./home-model";
import {
  useCatalogue,
  useProjectHome,
  type ProjectRecordWire,
} from "./home-read";
import type { RecentItem } from "./recent-model";
import gallery from "../gallery.module.css";
import styles from "./ProjectHome.module.css";

/* The project home, head A without its picture: the heading with the editable note and
   the facts line that says only what exists, the page-wide card/list switch, the
   overflow menu's rename and dissolution, and the sections that exist only for the
   kinds the project holds, from the origin-composed scoped listings. The switch stands
   in its own row under the head, as on the list screens, and a section head is its
   mark, title and count; the lists' own project filter is the path to a scoped list. */

const NAME_MAX = 120;
/** A change landed but the re-read did not: said, with the retry. */
const STALE_AFTER_CHANGE =
  "The change was saved, but the project couldn't be re-read.";

/** The project IS the page's object: its name heads the shell's path, and
 * so the browser title, `<name> · <instance>`, for everyone who reaches
 * it, whether or not they may rename it. */
function ProjectPath({ name }: { name: string }) {
  const pathname = usePathname();
  useEffect(() => {
    contributePath(pathname, { name, projectId: null });
    return () => releasePath(pathname);
  }, [pathname, name]);
  return null;
}

export function ProjectHomeScreen({ id, files, pictureBasemaps }: {
  id: string;
  /** Whether the reader may file their own work into the project now, as
   * the server's reach kernel answered for the page: its owner or an
   * Editor, while its owner is active. */
  files: boolean;
  /** The instance's basemaps, which the line for the map pictures
   * credits. */
  pictureBasemaps?: PictureBasemaps;
}) {
  const home = useProjectHome(id);
  // Keep the reader across route changes to reject departed responses, while
  // drafts, dialogs and busy flags are local to the displayed project visit.
  return <ProjectHomeVisit key={id} id={id} home={home} files={files} pictureBasemaps={pictureBasemaps} />;
}

function ProjectHomeVisit({ id, home, files, pictureBasemaps }: {
  id: string;
  home: ReturnType<typeof useProjectHome>;
  files: boolean;
  pictureBasemaps?: PictureBasemaps;
}) {
  const router = useRouter();
  const me = useSignedInSqlName();
  const departure = useDepartureNotice();
  const [leaving, setLeaving] = useState(false);
  const {
    state, retry, beginSave, acceptSave, ownsSave, refresh,
    confirmMembership, beginAction, ownsAction,
  } = home;
  const { operations } = useOperations();
  const groupOf = useCallback(
    (operation: string) =>
      operations?.find((o) => o.id === operation)?.group ?? null,
    [operations],
  );
  const opLabel = useCallback(
    (operation: string) =>
      operations?.find((o) => o.id === operation)?.label ?? operation,
    [operations],
  );
  // The page-wide switch: session state of this
  // mounted home; every load starts in cards (owns persistence).
  const [view, setView] = useState<HomeView>("cards");
  // The empty home's roads (behaviors 7 to 10).
  const [naming, setNaming] = useState(false);
  const [addingData, setAddingData] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [creatingMap, setCreatingMap] = useState(false);
  // A change landed but the re-read did not: said, with the retry.
  const [stale, setStale] = useState(false);
  // The project-first picker (behaviors 11 and 12, page 23).
  const [picking, setPicking] = useState(false);
  const instanceName = useInstanceName();

  const [actionError, setActionError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // The share dialog, the owner's: opened from the head's Share action or
  // its members line.
  const [sharing, setSharing] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // After a successful delete the route is dead: nothing repaints while
  // the navigation lands.
  const [left, setLeft] = useState(false);

  const world = state.status === "ready" ? state.value : null;
  // Dialog callbacks belong to the render that opened them. A late result
  // must not post its notice in a different project or a later visit.
  const renderedAction = beginAction();
  const isEmpty =
    world !== null &&
    world.maps.length + world.workflows.length + world.tables.length === 0;
  // The workspace catalogue, read only while the project is empty and
  // takes additions, or the picker is open.
  const catalogue = useCatalogue((isEmpty && files) || picking);
  const exclude = useMemo(
    () => ({
      maps: new Set(world?.maps.map((m) => m.id) ?? []),
      workflows: new Set(world?.workflows.map((w) => w.id) ?? []),
      tables: new Set(world?.tables.map((t) => t.id) ?? []),
    }),
    [world],
  );
  // Imports made from this home land in this project (the queue captures
  // the scope per admitted batch; the dialog's panes carry it too).
  const uploadQueue = useUploadQueue({
    projectId: id,
    onFileImported: () => void confirmMembership(),
    onListingStale: () => void refresh(),
    // The queue reads its options through a ref, so this closure sees
    // the dialog's current state when a batch settles.
    onSettled: (report) => {
      const { text, clean } = uploadSettleNotice(report);
      if (addingData && clean) {
        setAddingData(false);
        setExportNote(text);
      }
    },
  });
  const attention = useMemo(
    () => (world ? attentionRows(world.workflows) : []),
    [world],
  );
  const stats = useMemo(
    () =>
      world
        ? homeStats({
            maps: world.maps,
            workflows: world.workflows,
            tables: world.tables,
          })
        : null,
    [world],
  );

  const rename = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      setNameDraft(null);
      if (!world || !trimmed || trimmed === world.record.name) return;
      const save = beginSave("name");
      try {
        const response = await fetch(`/api/projects/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        });
        if (!response.ok) throw new Error(await readApiError(response));
        const record = (await response.json()) as ProjectRecordWire;
        invalidateProjects();
        if (!acceptSave(save, record)) return;
        setActionError(null);
      } catch (e) {
        if (!ownsSave(save)) return;
        setActionError(
          e instanceof Error ? e.message : "The project couldn't be renamed.",
        );
      }
    },
    [id, world, beginSave, acceptSave, ownsSave],
  );

  const saveNote = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      setNoteDraft(null);
      const current = world?.record.note ?? null;
      const next = trimmed === "" ? null : trimmed;
      if (!world || next === current) return;
      const save = beginSave("note");
      try {
        const response = await fetch(`/api/projects/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note: next }),
        });
        if (!response.ok) throw new Error(await readApiError(response));
        const record = (await response.json()) as ProjectRecordWire;
        if (!acceptSave(save, record)) return;
        setActionError(null);
      } catch (e) {
        if (!ownsSave(save)) return;
        setActionError(
          e instanceof Error ? e.message : "The note couldn't be saved.",
        );
      }
    },
    [id, world, beginSave, acceptSave, ownsSave],
  );

  /* A recent row's Add: that one object, nothing
     else; a map or workflow leaves its former project, said. */
  const addRecent = useCallback(
    async (item: RecentItem) => {
      if (!world) return;
      const action = beginAction();
      setAddingId(item.id);
      const change =
        item.kind === "map"
          ? { addMaps: [item.id] }
          : item.kind === "workflow"
            ? { addRecipes: [item.id] }
            : { addTables: [item.id] };
      try {
        const response = await fetch(`/api/projects/${id}/members`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(membershipBody({ members: change, bases: item.kind === "dataset" ? {} : {
            [`${item.kind}:${item.id}`]: (item.kind === "map" ? item.map.editRevision : item.workflow.editRevision) ?? "",
          } })),
        });
        if (!response.ok) throw new Error(await readApiError(response));
        invalidateProjects();
        if (!ownsAction(action)) return;
        const former =
          item.kind !== "dataset" && item.where.length > 0
            ? item.where[0]
            : null;
        setExportNote(
          former
            ? `Moved ${item.name} into ${world.record.name}; it left ${former}.`
            : `Added ${item.name} to ${world.record.name}.`,
        );
        setActionError(null);
        // The change landed; a failed re-read is said, never left stale.
        if (!(await confirmMembership()) && ownsAction(action)) setStale(true);
      } catch (e) {
        if (!ownsAction(action)) return;
        setActionError(
          e instanceof Error ? e.message : "The change couldn't be applied.",
        );
      } finally {
        if (ownsAction(action)) setAddingId(null);
      }
    },
    [id, world, confirmMembership, beginAction, ownsAction],
  );

  const newMap = useCallback(async () => {
    if (creatingMap) return;
    const action = beginAction();
    setCreatingMap(true);
    try {
      const response = await fetch("/api/maps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Untitled map", projectId: id }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const map = (await response.json()) as { id: string };
      if (!ownsAction(action)) return;
      router.push(`/maps/${map.id}`);
    } catch (e) {
      if (!ownsAction(action)) return;
      setActionError(
        e instanceof Error ? e.message : "The map couldn't be created.",
      );
      setCreatingMap(false);
    }
  }, [id, router, creatingMap, beginAction, ownsAction]);

  const dissolve = useCallback(async () => {
    const action = beginAction();
    setDeleting(true);
    try {
      const response = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readApiError(response));
      invalidateProjects();
      if (!ownsAction(action)) return;
      setLeft(true);
      router.push("/projects");
    } catch (e) {
      if (!ownsAction(action)) return;
      setActionError(
        e instanceof Error ? e.message : "The project couldn't be deleted.",
      );
      setConfirmingDelete(false);
    } finally {
      if (ownsAction(action)) setDeleting(false);
    }
  }, [id, router, beginAction, ownsAction]);

  if (left) return null;

  if (state.status === "pending") {
    return (
      <div className={styles.stateBlock}>
        <Spinner />
        <span>Reading the project…</span>
      </div>
    );
  }
  if (state.status === "missing") {
    return (
      <div className={styles.stateBlock}>
        <p>{state.message}</p>
        <Link href="/projects" className={styles.backLink}>
          Projects
        </Link>
      </div>
    );
  }
  if (state.status === "failed") {
    return (
      <div className={styles.stateBlock}>
        <ErrorNote message={state.error} onRetry={retry} />
      </div>
    );
  }

  const { record, maps, workflows, tables, names, lastRuns } = state.value;
  const hasContent = maps.length + workflows.length + tables.length > 0;
  // How the reader stands to the project, as its read says: its owner
  // keeps the whole head; its people get the role line, and renaming, the
  // note stay the owner's; a member's menu holds Leave. Add to project, the picker and the
  // empty home's offers follow whether the reader may file here now.
  const role = record.role ?? "owner";
  const owns = role === "owner";

  return (
    <div className={styles.screen}>
      <ProjectPath name={record.name} />
      {owns ? (
        <ProjectCrumbTail
          projectId={id}
          name={record.name}
          onRename={(next) => void rename(next)}
        />
      ) : (
        <PlainCrumbTail name={record.name} />
      )}
      <div className={styles.heading}>
        <div className={styles.headLeft}>
          {nameDraft !== null ? (
            <input
              className={styles.nameInput}
              value={nameDraft}
              autoFocus
              maxLength={NAME_MAX + 1}
              aria-label="Project name"
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => void rename(nameDraft)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setNameDraft(null);
              }}
            />
          ) : (
            <h1>{record.name}</h1>
          )}
          {!owns && record.owner && (
            <RoleLine owner={record.owner} role={role} />
          )}
          {owns && <MembersLine projectId={id} onOpen={() => setSharing(true)} />}
          {owns ? (
          <div className={styles.noteLine}>
            {noteDraft !== null ? (
              <input
                className={styles.noteInput}
                value={noteDraft}
                autoFocus
                aria-label="Project note"
                onChange={(e) => setNoteDraft(e.target.value)}
                onBlur={() => void saveNote(noteDraft)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setNoteDraft(null);
                }}
              />
            ) : (
              <>
                {record.note && <span>{record.note}</span>}
                <button
                  className={styles.noteEdit}
                  onClick={() => setNoteDraft(record.note ?? "")}
                >
                  {record.note ? "edit" : "add a note"}
                </button>
              </>
            )}
          </div>
          ) : (
            record.note && (
              <div className={styles.noteLine}>
                <span>{record.note}</span>
              </div>
            )
          )}
          {stats && (
            <div className={styles.stats} data-facts>
              {factsLine(stats, record, formatRelativeTime).map((f, i) => (
                <span key={f.key} className={styles.factWrap}>
                  {i > 0 && <i />}
                  <span data-fact={f.key}>
                    {f.kind && (
                      <span className={styles.factGlyph} aria-hidden>
                        <KindIcon kind={f.kind} />
                      </span>
                    )}
                    {f.value && <b>{f.value}</b>}
                    {f.value ? " " : ""}
                    {f.label}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className={styles.headActs} data-head-acts>
          {files && (
            <Button size="chrome" onClick={() => setPicking(true)}>
              <IconFolderPlus /> Add to project
            </Button>
          )}
          {hasContent && (
            <Button size="chrome" onClick={() => setExporting(true)}>
              <IconDownload /> Export project
            </Button>
          )}
          {owns && (
            <Button size="chrome" onClick={() => setSharing(true)} data-share-action>
              <PeopleIcon /> Share
            </Button>
          )}
          <Menu
            label="Project actions"
            triggerLabel="More"
            trigger="⋯"
            className={styles.menuWrap}
            triggerClassName={styles.menuTrigger}
            menuClassName={styles.menu}
          >
            {owns ? (
              <>
                <MenuItem onSelect={() => setNameDraft(record.name)}>Rename</MenuItem>
                <MenuItem danger onSelect={() => setConfirmingDelete(true)}>Delete project</MenuItem>
              </>
            ) : (
              <MenuItem danger onSelect={() => setLeaving(true)}>Leave project</MenuItem>
            )}
          </Menu>
        </div>
      </div>

      {actionError && (
        <ErrorNote
          message={actionError}
          onDismiss={() => setActionError(null)}
        />
      )}
      {stale && (
        <ErrorNote
          message={STALE_AFTER_CHANGE}
          onRetry={() => {
            setStale(false);
            retry();
          }}
          onDismiss={() => setStale(false)}
        />
      )}
      {exportNote && (
        <p className={styles.exportNote} role="status">
          {exportNote}
        </p>
      )}
      {exporting && (
        <ExportProjectDialog
          projectId={id}
          projectName={record.name}
          onClose={() => setExporting(false)}
          onDone={(message) => {
            if (!ownsAction(renderedAction)) return;
            setExporting(false);
            setExportNote(message);
          }}
        />
      )}

      {sharing && (
        <ShareDialog
          projectId={id}
          projectName={record.name}
          counts={{ maps: maps.length, workflows: workflows.length, datasets: tables.length }}
          tables={tables}
          onClose={() => setSharing(false)}
          onTransferred={(sentence) => {
            // Handed over: the home re-reads as its new Editor's.
            setSharing(false);
            invalidateProjects();
            if (!ownsAction(renderedAction)) return;
            setExportNote(sentence);
            void refresh().then((ok) => {
              if (!ok && ownsAction(renderedAction)) setStale(true);
            });
          }}
        />
      )}

      {/* The view switch stands where the list screens keep theirs: the
          tail of the toolbar row under the head, on the shared toolbar
          rules, only while there is content to switch. */}
      {hasContent && (
        <div className={gallery.toolbar} data-switch-row>
          <div className={gallery.tail}>
            <div className={gallery.viewToggle} role="group" aria-label="View">
              <button
                data-on={view === "cards" || undefined}
                data-hint="Grid view"
                aria-label="Grid view"
                onClick={() => setView("cards")}
              >
                <IconGrid />
              </button>
              <button
                data-on={view === "list" || undefined}
                data-hint="List view, every section"
                aria-label="List view"
                onClick={() => setView("list")}
              >
                <IconList />
              </button>
            </div>
          </div>
        </div>
      )}

      <div className={styles.scroller} data-home-content>
        {/* Its call to run again is for those who may run: not a Viewer. */}
        {role !== "viewer" && (
          <AttentionArea
            rows={attention}
            workflows={workflows}
            opLabel={opLabel}
            onChanged={confirmMembership}
            followRuns
          />
        )}
        {hasContent ? (
          <HomeSections
            projectId={id}
            maps={maps}
            workflows={workflows}
            tables={tables}
            names={names}
            lastRuns={lastRuns}
            view={view}
            groupOf={groupOf}
            pictureBasemaps={pictureBasemaps}
          />
        ) : !files ? (
          <p className={gallery.empty}>This project is empty.</p>
        ) : (
          <EmptyHome
            projectId={id}
            projectName={record.name}
            instanceName={instanceName}
            catalogue={catalogue.state}
            exclude={exclude}
            names={names}
            groupOf={groupOf}
            busyId={addingId}
            creatingMap={creatingMap}
            onAdd={(item) => void addRecent(item)}
            onNewMap={() => void newMap()}
            onNewWorkflow={() => setNaming(true)}
            onAddData={() => setAddingData(true)}
            onRetryCatalogue={catalogue.retry}
            pictureBasemaps={pictureBasemaps}
          />
        )}
      </div>

      {picking && (
        <AddItemsDialog
          projectId={id}
          projectName={record.name}
          catalogue={catalogue.state}
          names={names}
          members={{ workflows: exclude.workflows, tables: exclude.tables }}
          onRetryCatalogue={catalogue.retry}
          onClose={() => setPicking(false)}
          onDone={(outcome) => {
            invalidateProjects();
            if (!ownsAction(renderedAction)) return;
            setPicking(false);
            setExportNote(outcome);
            setActionError(null);
            void confirmMembership().then((ok) => {
              if (!ok && ownsAction(renderedAction)) setStale(true);
            });
            void catalogue.reload();
          }}
        />
      )}
      {naming && (
        <NewWorkflowDialog projectId={id} onClose={() => setNaming(false)} />
      )}
      <AddDataDialog
        open={addingData}
        projectId={id}
        projectName={world?.record.name ?? null}
        onClose={() => setAddingData(false)}
        onTableCreated={() => {
          if (!ownsAction(renderedAction)) return;
          setAddingData(false);
          void confirmMembership();
        }}
        onPostgisTableCreated={() => void confirmMembership()}
        onSkipped={(skipped) => {
          if (!ownsAction(renderedAction)) return;
          if (skipped.length) setExportNote(skippedNotice(skipped));
        }}
        uploadQueue={uploadQueue}
      />

      {leaving && (
        <LeaveProjectDialog
          projectId={id}
          projectName={record.name}
          ownsWork={ownsFiledWork(state.value, id, me)}
          onClose={() => setLeaving(false)}
          onDone={(notice) => {
            if (!ownsAction(renderedAction)) return;
            departure.remember(notice);
            setLeft(true);
            router.push("/projects");
          }}
        />
      )}
      {confirmingDelete && (
        <Dialog
          label="Delete project"
          onClose={() => {
            if (!deleting) setConfirmingDelete(false);
          }}
          className={styles.dialog}
        >
          <div className={styles.dialogHead}>
            <strong>Delete {record.name}?</strong>
            <small>
              The project dissolves: its maps and workflows stay, unfiled; a
              dataset shared with another project keeps that membership.
              Nothing is deleted but the project itself.
            </small>
          </div>
          <div className={styles.dialogFoot}>
            <Button
              variant="quiet"
              onClick={() => setConfirmingDelete(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => void dissolve()}
              busy={deleting}
            >
              Delete project
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
