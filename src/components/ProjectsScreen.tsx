"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { readApiError } from "./api";
import {
  IconDownload,
  IconGrid,
  IconList,
  IconPeople,
  IconRename,
  IconSearch,
} from "./gallery-icons";
import { CardDelete } from "./CardDelete";
import { invalidateProjects } from "./shell/use-project-name";
import {
  ProjectCard,
  ProjectRow,
  ProjectsListHead,
} from "./projects/ProjectCollection";
import { useOperations } from "./builder/drawer/use-operations";
import { ExportProjectDialog } from "./projects/ExportProjectDialog";
import { AsyncState } from "./ui/AsyncState";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { ErrorNote } from "./ui/ErrorNote";
import { ListHeading } from "./ListHeading";
import { headingLine } from "./scope/model";
import { PlusIcon, SignOutIcon } from "./ui/icons";
import { LeaveProjectDialog, ownsFiledWork } from "./projects/LeaveProjectDialog";
import { useDepartureNotice } from "./projects/departure-notice";
import { useSignedInSqlName } from "./sharing/signed-in";
import {
  filterProjects,
  PROJECT_SORTS,
  projectPictures,
  sortProjects,
  unfiledCounts,
  unfiledDatasetCount,
  workflowCounts,
  type PictureItem,
  type ProjectOverview,
  type ProjectsSort,
} from "./projects/model";
import { useProjectsWorld, type ProjectsWorld } from "./projects/read";
import { PeopleChip } from "./sharing/PeopleMarks";
import { peopleMark } from "./sharing/people";
import { ShareDialog } from "./sharing/ShareDialog";
import { useProjectPeople } from "./sharing/use-project-people";
import { untilViewSettled, useViewPrefs } from "./use-view-prefs";
import gallery from "./gallery.module.css";
import styles from "./ProjectsScreen.module.css";

/* The Projects list: cards or rows over the composed reads, the picture
   by count, the counts that drop zeros, name-only creation, in-place
   rename, dissolution with its consequence stated, and the unfiled
   summary. View and sort persist through the workspace settings like
   the sibling lists. */

const NAME_MAX = 120;

const count = (n: number, word: string) =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

export function ProjectsScreen() {
  const router = useRouter();
  const me = useSignedInSqlName();
  const { notice: departureNotice, clear: clearDeparture } = useDepartureNotice();
  const { state, retry, mutate, refresh } = useProjectsWorld();
  const world = state.status === "ready" ? state.value : null;
  // The workflow miniature's group hues (the same read the home makes).
  const { operations } = useOperations();
  const groupOf = useCallback(
    (operation: string) =>
      operations?.find((o) => o.id === operation)?.group ?? null,
    [operations],
  );

  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Remembered through the workspace settings like the sibling lists:
  // read once on load, written on change.
  const { view, sort, settled, setView, setSort } = useViewPrefs<ProjectsSort>(
    "projects",
    "updated",
    PROJECT_SORTS,
  );
  const [draftName, setDraftName] = useState<string | null>(null);
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState<{ id: string; name: string } | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(departureNotice);
  useEffect(() => clearDeparture(), [clearDeparture]);
  const [leaving, setLeaving] = useState<ProjectOverview | null>(null);
  // The share dialog, the owner's, opened from a card's Share action.
  const [sharing, setSharing] = useState<ProjectOverview | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(
    null,
  );
  const searchRef = useRef<HTMLInputElement>(null);
  // A departure removes the card whose action opened the confirmation, so
  // focus goes to search instead. It moves in an effect of the render that
  // closes the dialog: by then the dialog's own cleanup has released the
  // page behind it and tried its opener. Asked any earlier, the search box
  // is still inert and a browser ignores the call.
  const [departures, setDepartures] = useState(0);
  useEffect(() => {
    if (departures > 0) searchRef.current?.focus();
  }, [departures]);

  // "/" focuses search — unless the user is already typing somewhere.
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

  const shown = useMemo(
    () =>
      world ? sortProjects(filterProjects(world.projects, query), sort) : null,
    [world, query, sort],
  );
  const pictures = useMemo(
    () =>
      world
        ? projectPictures({
            maps: world.maps,
            workflows: world.workflows,
          })
        : new Map<string, PictureItem[]>(),
    [world],
  );
  // A project's people are its owner's to see counted: the projects one
  // owns are asked; one shared with one already says whose it is.
  const ownedIds = useMemo(
    () =>
      (world?.projects ?? [])
        .filter((p) => !p.role || p.role === "owner")
        .map((p) => p.id),
    [world],
  );
  const people = useProjectPeople(ownedIds);
  const markOf = (p: ProjectOverview) => (
    <PeopleChip mark={peopleMark(p, people.get(p.id))} />
  );
  const wfCounts = useMemo(
    () => (world ? workflowCounts(world.workflows) : new Map<string, number>()),
    [world],
  );
  const unfiled = useMemo(
    () =>
      world
        ? unfiledCounts({
            maps: world.maps,
            workflows: world.workflows,
            unfiledDatasets: unfiledDatasetCount(world.tables),
          })
        : null,
    [world],
  );

  const createProject = useCallback(async () => {
    const name = (draftName ?? "").trim();
    if (!name) {
      setNameProblem("Give it a name.");
      return;
    }
    if (name.length > NAME_MAX) {
      setNameProblem(`At most ${NAME_MAX} characters.`);
      return;
    }
    setCreating(true);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const record = (await response.json()) as {
        id: string;
        name: string;
        note: string | null;
        createdAt: string;
        updatedAt: string;
      };
      const fresh: ProjectOverview = {
        ...record,
        mapCount: 0,
        publishedMapCount: 0,
        recipeCount: 0,
        tableCount: 0,
        sizeBytes: 0,
        sizeComplete: true,
      };
      mutate((w) => ({ ...w, projects: [fresh, ...w.projects.filter(project => project.id !== fresh.id)] }));
      invalidateProjects();
      setDraftName(null);
      setActionError(null);
    } catch (e) {
      setNameProblem(
        e instanceof Error ? e.message : "The project couldn't be created.",
      );
    } finally {
      setCreating(false);
    }
  }, [draftName, mutate]);

  const renameProject = useCallback(
    async (id: string, name: string) => {
      const trimmed = name.trim();
      const current = world?.projects.find((p) => p.id === id);
      setEditing(null);
      if (!current || !trimmed || trimmed === current.name) return;
      try {
        const response = await fetch(`/api/projects/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        });
        if (!response.ok) throw new Error(await readApiError(response));
        // The answer carries the advanced updated time: applying it
        // keeps the Recently-updated sort truthful without a reload.
        const record = (await response.json()) as {
          name: string;
          note: string | null;
          updatedAt: string;
        };
        mutate((w) => ({
          ...w,
          projects: w.projects.map((p) =>
            p.id === id ? { ...p, ...record } : p,
          ),
        }));
        invalidateProjects();
        setActionError(null);
      } catch (e) {
        // The confirmed name stays on screen; the refusal is said.
        setActionError(
          e instanceof Error ? e.message : "The project couldn't be renamed.",
        );
      }
    },
    [world, mutate],
  );

  const deleteProject = useCallback(
    async (id: string) => {
      setDeletingId(id);
      try {
        const response = await fetch(`/api/projects/${id}`, {
          method: "DELETE",
        });
        if (!response.ok) throw new Error(await readApiError(response));
        // Dissolution: the project goes; maps and workflows unfile; a
        // shared dataset keeps its other memberships — the quiet refresh
        // below reads the server truth the client cannot derive.
        mutate((w: ProjectsWorld) => ({
          ...w,
          projects: w.projects.filter((p) => p.id !== id),
          maps: w.maps.map((m) =>
            m.projectId === id ? { ...m, projectId: null } : m,
          ),
          workflows: w.workflows.map((wf) =>
            wf.projectId === id ? { ...wf, projectId: null } : wf,
          ),
        }));
        invalidateProjects();
        setActionError(null);
        refresh().catch(() => {
          /* What is shown is already correct except dataset counts;
             the next load reads the truth */
        });
      } catch (e) {
        setActionError(
          e instanceof Error ? e.message : "The project couldn't be deleted.",
        );
      } finally {
        setDeletingId(null);
      }
    },
    [mutate, refresh],
  );

  const open = useCallback(
    (id: string) => router.push(`/projects/${id}`),
    [router],
  );

  const nameCell = (p: ProjectOverview) =>
    editing?.id === p.id ? (
      <input
        className={styles.renameInput}
        value={editing.value}
        autoFocus
        maxLength={NAME_MAX + 1}
        aria-label="Project name"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setEditing({ id: p.id, value: e.target.value })}
        onBlur={() => void renameProject(p.id, editing.value)}
        onKeyDown={(e) => {
          // The card is a link with its own Enter: the edit's keys are
          // the edit's alone (the journey caught the bubble opening the
          // project mid-rename).
          e.stopPropagation();
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setEditing(null);
        }}
      />
    ) : (
      <span className={gallery.cardName}>{p.name}</span>
    );

  const acts = (p: ProjectOverview, rowStyle: string) => {
    // Members export what they can read or end their own grant.
    const owned = !p.role || p.role === "owner";
    return (
      <span className={rowStyle}>
        {owned && (
          <button
            data-hint="Rename project"
            aria-label={`Rename ${p.name}`}
            onClick={(e) => {
              e.stopPropagation();
              setEditing({ id: p.id, value: p.name });
            }}
          >
            <IconRename />
          </button>
        )}
        <button
          data-hint="Export bundle"
          aria-label={`Export ${p.name}`}
          onClick={(e) => {
            e.stopPropagation();
            setExporting({ id: p.id, name: p.name });
          }}
        >
          <IconDownload />
        </button>
        {!owned && (
          <button
            className={gallery.deleteAct}
            data-hint="Leave project"
            aria-label={`Leave ${p.name}`}
            onClick={(e) => {
              e.stopPropagation();
              e.currentTarget.focus();
              setLeaving(p);
            }}
          >
            <SignOutIcon />
          </button>
        )}
        {owned && (
          <button
            data-hint="Share project"
            aria-label={`Share ${p.name}`}
            data-share-action
            onClick={(e) => {
              e.stopPropagation();
              setSharing(p);
            }}
          >
            <IconPeople />
          </button>
        )}
        {owned && (
          <CardDelete
            label={`Delete ${p.name}`}
            armedLabel={`Really delete ${p.name}? Its members stay, unfiled`}
            hint="Delete project"
            question="Delete? Members stay"
            disabled={deletingId === p.id}
            onConfirm={() => deleteProject(p.id)}
          />
        )}
      </span>
    );
  };

  const empty = world !== null && world.projects.length === 0;

  const newTile = (
    <button
      className={gallery.ghost}
      onClick={() => {
        setNameProblem(null);
        setDraftName("");
      }}
    >
      <span className={gallery.plus}>
        <PlusIcon />
      </span>
      <b>New project</b>
      <small>A name, nothing else</small>
    </button>
  );

  return (
    <div className={styles.screen}>
      {/* The one heading: Projects gains the count it never had, silent
          until the read resolves, and loses its sentence; the line
          appears only when a search narrows the list. */}
      <ListHeading
        title="Projects"
        line={
          world && shown
            ? headingLine({
                scopedTotal: world.projects.length,
                scope: { kind: "all" },
                scopeName: null,
                shownCount: shown.length,
              })
            : null
        }
        action={{
          label: "New project",
          onClick: () => {
            setNameProblem(null);
            setDraftName("");
          },
        }}
      />

      {actionError && (
        <ErrorNote
          message={actionError}
          onDismiss={() => setActionError(null)}
        />
      )}

      {/* The toolbar from zero (the pick of the full row from the
          start): the row no longer waits for the first project, so the
          page never changes shape when one lands. */}
      <div className={gallery.toolbar}>
        <label className={gallery.search}>
          <IconSearch />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects…"
            aria-label="Search projects"
          />
          <kbd>/</kbd>
        </label>
        <div className={gallery.tail}>
          <label className={gallery.sort}>
            Sort
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as ProjectsSort)}
              aria-label="Sort projects"
            >
              <option value="updated">Recently updated</option>
              <option value="name">Name A–Z</option>
              <option value="largest">Largest</option>
            </select>
          </label>
          <div className={gallery.viewToggle} role="group" aria-label="View">
            <button
              data-on={(settled && view === "grid") || undefined}
              data-hint="Grid view"
              aria-label="Grid view"
              onClick={() => setView("grid")}
            >
              <IconGrid />
            </button>
            <button
              data-on={(settled && view === "list") || undefined}
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
          state={untilViewSettled(state, settled)}
          onRetry={retry}
          pendingLabel="Reading your projects…"
        >
          {() => (
            <>
              {/* The new-item card is the grid's first cell at zero and
                  afterwards, as on the sibling lists; in list view the
                  resolved-empty state is the same tile, centred. */}
              {shown && view === "grid" && (
                <div className={gallery.grid}>
                  {newTile}
                  {shown.map((p, i) => (
                    <ProjectCard
                      key={p.id}
                      project={p}
                      mark={markOf(p)}
                      picture={pictures.get(p.id) ?? []}
                      workflowCount={wfCounts.get(p.id) ?? 0}
                      groupOf={groupOf}
                      nameCell={nameCell(p)}
                      acts={acts(p, styles.actsRow)}
                      onOpen={() => open(p.id)}
                      delay={Math.min(45 + i * 45, 380)}
                    />
                  ))}
                </div>
              )}

              {!empty && shown && shown.length === 0 && (
                <p className={gallery.empty}>
                  No projects match. Clear the search.
                </p>
              )}

              {empty && view === "list" && (
                <div className={gallery.emptyAction}>{newTile}</div>
              )}

              {!empty && shown && view === "list" && shown.length > 0 && (
                <div className={gallery.listCard}>
                  <ProjectsListHead />
                  {shown.map((p) => (
                    <ProjectRow
                      key={p.id}
                      project={p}
                      mark={markOf(p)}
                      picture={pictures.get(p.id) ?? []}
                      workflowCount={wfCounts.get(p.id) ?? 0}
                      groupOf={groupOf}
                      nameCell={nameCell(p)}
                      acts={acts(p, gallery.rowActs)}
                      onOpen={() => open(p.id)}
                    />
                  ))}
                </div>
              )}

              {!empty && unfiled?.any && (
                <div className={styles.unfiled}>
                  <span>
                    <b>Not in a project:</b> {count(unfiled.maps, "map")} ·{" "}
                    {count(unfiled.workflows, "workflow")} ·{" "}
                    {count(unfiled.datasets, "dataset")}. They work the same.
                  </span>
                </div>
              )}
            </>
          )}
        </AsyncState>
      </div>

      {exportNote && (
        <p className={styles.exportNote} role="status">
          {exportNote}
        </p>
      )}
      {exporting && (
        <ExportProjectDialog
          projectId={exporting.id}
          projectName={exporting.name}
          onClose={() => setExporting(null)}
          onDone={(message) => {
            setExporting(null);
            setExportNote(message);
          }}
        />
      )}
      {leaving && world && (
        <LeaveProjectDialog
          projectId={leaving.id}
          projectName={leaving.name}
          ownsWork={ownsFiledWork(world, leaving.id, me)}
          onClose={() => setLeaving(null)}
          onDone={(notice) => {
            mutate((current) => ({ ...current, projects: current.projects.filter(p => p.id !== leaving.id) }));
            setLeaving(null);
            setExportNote(notice);
            setDepartures((n) => n + 1);
            refresh().catch(() => retry());
          }}
        />
      )}
      {sharing && world && (
        <ShareDialog
          projectId={sharing.id}
          projectName={sharing.name}
          // What the card says it holds: the workflows by the listing,
          // as the card counts them.
          counts={{
            maps: sharing.mapCount,
            workflows: wfCounts.get(sharing.id) ?? 0,
            datasets: sharing.tableCount,
          }}
          tables={world.tables.filter((t) => t.projectIds.includes(sharing.id))}
          onClose={() => setSharing(null)}
          onTransferred={(sentence) => {
            // Handed over: the card re-reads as its new Editor's.
            setSharing(null);
            invalidateProjects();
            setExportNote(sentence);
            refresh().catch(() => {
              /* A failed re-read keeps what is shown; the next load
                 reads the truth */
            });
          }}
        />
      )}

      {draftName !== null && (
        <Dialog
          label="New project"
          onClose={() => {
            if (!creating) setDraftName(null);
          }}
          className={styles.dialog}
        >
          <div className={styles.dialogHead}>
            <strong>New project</strong>
            <small>A name, nothing else.</small>
          </div>
          <label className={styles.nameField}>
            <span>Name</span>
            <input
              autoFocus
              value={draftName}
              maxLength={NAME_MAX + 1}
              disabled={creating}
              onChange={(e) => {
                setDraftName(e.target.value);
                setNameProblem(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createProject();
              }}
            />
          </label>
          {nameProblem && (
            <p className={styles.problem} role="alert">
              {nameProblem}
            </p>
          )}
          <div className={styles.foot}>
            <Button
              variant="quiet"
              onClick={() => setDraftName(null)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void createProject()}
              busy={creating}
            >
              Create
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
