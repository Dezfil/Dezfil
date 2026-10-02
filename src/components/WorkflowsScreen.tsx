"use client";

import { LastChanged } from "./sharing/LastChanged";
import { editHeaders } from "@/lib/edit-basis";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { readApiError, readRecipes } from "./api";
import { serverUnreachable } from "./failure-copy";
import { useOperations } from "./builder/drawer/use-operations";
import {
  IconDuplicate,
  IconFolderPlus,
  IconGrid,
  IconList,
  IconOpen,
  IconSearch,
  IconTrash,
} from "./gallery-icons";
import { useViewPrefs } from "./use-view-prefs";
import { ProjectTag } from "./MapsScreen";
import { ScopeFilter } from "./scope/ScopeFilter";
import { ListHeading } from "./ListHeading";
import { headingLine, scopeRows, tileSubLine, unreachedProjects } from "./scope/model";
import { useProjectScope } from "./scope/use-scope";
import { useScopeWorld } from "./scope/use-scope-world";
import { WorkflowStatusChip } from "./WorkflowStatusChip";
import { AsyncState } from "./ui/AsyncState";
import { NewWorkflowDialog } from "./NewWorkflowDialog";
import { ErrorNote } from "./ui/ErrorNote";
import { AddToProjectDialog } from "./projects/AddToProjectDialog";
import { actionLabel } from "./projects/add-model";
import { PlusIcon } from "./ui/icons";
import { WorkflowThumb } from "./WorkflowThumb";
import { OwnerPill } from "./sharing/PeopleMarks";
import { ownedByOther } from "./sharing/people";
import { useSignedInSqlName } from "./sharing/signed-in";
import {
  datasetWord,
  matchesQuery,
  nodeWord,
  passesFilter,
  sortWorkflows,
  sourceWord,
  WORKFLOW_SORTS,
  type WorkflowListing,
  type WorkflowsFilter,
  type WorkflowsSort,
} from "./workflow-model";
import gallery from "./gallery.module.css";
import styles from "./WorkflowsScreen.module.css";

/**
 * The workflows list: the Maps gallery, card for card, over the recipes
 * whose origin is *workflow*. Every fact on a card — the status, the counts,
 * the graph's reads — is the API's; the page renders and never classifies.
 */


const fetchWorkflows = () => readRecipes("workflow");

/** The scoped listing keeps the workflow origin composed (a
 * filed builder-origin recipe must change neither counts nor results). */
async function fetchWorkflowsScoped(param: string): Promise<WorkflowListing[]> {
  let response: Response;
  try {
    response = await fetch(
      `/api/recipes?origin=workflow&project=${encodeURIComponent(param)}`,
      { cache: "no-store" },
    );
  } catch {
    throw new Error(serverUnreachable("load the workflows"));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  return ((await response.json()) as { recipes: WorkflowListing[] }).recipes;
}

export function WorkflowsScreen() {
  const router = useRouter();
  // Someone else's workflow is marked with its owner; filing and deleting
  // stay theirs.
  const me = useSignedInSqlName();
  const othersOwner = (w: WorkflowListing) =>
    ownedByOther(w.owner, me) ? w.owner : null;
  const { scope, setScope } = useProjectScope();
  const {
    state: listState,
    retry,
    mutate,
    refresh,
  } = useScopeWorld<WorkflowListing>({
    kind: "workflows",
    scope,
    fetchUnscoped: fetchWorkflows,
    fetchScoped: fetchWorkflowsScoped,
  });
  const world = listState.status === "ready" ? listState.value : null;
  const workflows = world?.scoped ?? null;
  const { operations } = useOperations();
  const groupOf = useCallback(
    (operation: string) =>
      operations?.find((o) => o.id === operation)?.group ?? null,
    [operations],
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<WorkflowsFilter>("all");
  const { view, sort, setView, setSort } = useViewPrefs<WorkflowsSort>(
    "workflows",
    "edited",
    WORKFLOW_SORTS,
  );
  // Per-card delete, as maps: first click arms, second deletes.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Filing: the same dialog Maps opens, over a workflow.
  const [filing, setFiling] = useState<WorkflowListing | null>(null);
  const [filedNote, setFiledNote] = useState<string | null>(null);
  // Creation lives in the shared name dialog.
  const [naming, setNaming] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

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

  const reload = useCallback(async () => {
    // The scope-aware quiet re-read keeps results and counts coherent.
    await refresh();
  }, [refresh]);


  const duplicateWorkflow = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        const response = await fetch(`/api/recipes/${id}/duplicate`, {
          method: "POST",
        });
        if (!response.ok) throw new Error(await readApiError(response));
        await reload();
        setActionError(null);
      } catch (e) {
        setActionError(
          e instanceof Error
            ? e.message
            : "The workflow couldn't be duplicated.",
        );
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  const deleteWorkflow = useCallback(
    async (item: WorkflowListing) => {
      const { id } = item;
      setBusyId(id);
      setConfirmId(null);
      try {
        const response = await fetch(`/api/recipes/${id}`, {
          method: "DELETE",
          headers: item.editRevision ? editHeaders({ editRevision: item.editRevision }) : undefined,
        });
        if (!response.ok) throw new Error(await readApiError(response));
        await reload();
        setActionError(null);
      } catch (e) {
        setActionError(
          e instanceof Error ? e.message : "The workflow couldn't be deleted.",
        );
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  const counts = useMemo(() => {
    if (!workflows) return null;
    return {
      all: workflows.length,
      attention: workflows.filter((w) => passesFilter(w, "attention")).length,
      never: workflows.filter((w) => passesFilter(w, "never")).length,
    };
  }, [workflows]);

  const shown = useMemo(() => {
    if (!workflows) return null;
    return sortWorkflows(
      workflows.filter(
        (w) => passesFilter(w, filter) && matchesQuery(w, query),
      ),
      sort,
    );
  }, [workflows, filter, query, sort]);

  const open = (id: string) => router.push(`/workflows/${id}`);

  // A list row is itself the button that opens, so it carries no second
  // control of the same name; the grid card's pill keeps Open.
  const quickActions = (
    w: WorkflowListing,
    rowStyle: string,
    withOpen: boolean,
  ) => {
    const live = w.summary.liveOutputs;
    const armed = confirmId === w.id;
    const mine = othersOwner(w) === null;
    return (
      <span className={rowStyle}>
        {mine && (
          <button
            data-hint={actionLabel("workflow", !!w.projectId)}
            aria-label={`${actionLabel("workflow", !!w.projectId)}: ${w.name}`}
            onClick={(e) => {
              e.stopPropagation();
              setFiling(w);
            }}
          >
            <IconFolderPlus />
          </button>
        )}
        {withOpen && (
          <button
            data-hint="Open"
            aria-label={`Open ${w.name}`}
            onClick={(e) => {
              e.stopPropagation();
              open(w.id);
            }}
          >
            <IconOpen />
          </button>
        )}
        <button
          data-hint="Duplicate"
          aria-label={`Duplicate ${w.name}`}
          disabled={busyId === w.id}
          onClick={(e) => {
            e.stopPropagation();
            void duplicateWorkflow(w.id);
          }}
        >
          <IconDuplicate />
        </button>
        {mine && (
          <button
            className={gallery.deleteAct}
            data-confirm={armed || undefined}
            disabled={busyId === w.id}
            data-hint={
              armed
                ? live > 0
                  ? `Click again to delete. Its ${live} ${datasetWord(live)} stay in Data.`
                  : "Click again to delete. It has no datasets that would stay."
                : "Delete workflow"
            }
            aria-label={armed ? `Confirm deleting ${w.name}` : `Delete ${w.name}`}
            onClick={(e) => {
              e.stopPropagation();
              if (armed) void deleteWorkflow(w);
              else setConfirmId(w.id);
            }}
            onBlur={() => setConfirmId(null)}
          >
            {armed ? `Delete? ${live} stay` : <IconTrash />}
          </button>
        )}
      </span>
    );
  };

  const newTile = (
    <button
      className={gallery.ghost}
      onClick={() => setNaming(true)}
    >
      <span className={gallery.plus}>
        <PlusIcon />
      </span>
      <b>New workflow</b>
      <small>
        {tileSubLine(
          "workflow",
          scope,
          scope.kind === "project"
                  ? (world?.projects.find((x) => x.id === scope.id)?.name ?? null)
                  : null,
        )}
      </small>
    </button>
  );

  return (
    <div className={styles.screen}>
      {/* The one heading. A pending or refused scope must not quietly
          create unfiled: creation waits for a ready world. */}
      <ListHeading
        title="Workflows"
        line={
          world
            ? headingLine({
                scopedTotal: world.scoped.length,
                scope,
                scopeName:
                  scope.kind === "project"
                    ? (world.projects.find((x) => x.id === scope.id)?.name ??
                      null)
                    : null,
                shownCount: shown?.length ?? world.scoped.length,
              })
            : null
        }
        action={{
          label: "New workflow",
          onClick: () => setNaming(true),
          disabled: !world,
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
            kind: "workflow",
            id: filing.id,
            name: filing.name,
            projectId: filing.projectId,
            editRevision: filing.editRevision,
          }}
          onClose={() => setFiling(null)}
          onWithdrawn={({ projectIds, refusal }) => {
            const workflowId = filing.id;
            setFiling(null);
            // Out of a project one no longer reaches: in no project now,
            // before the reconciling read answers and whether or not it does.
            const out = (x: WorkflowListing) =>
              x.id === workflowId && x.projectId !== null && projectIds.includes(x.projectId)
                ? { ...x, projectId: null }
                : x;
            mutate((w) => ({ ...w, all: w.all.map(out), scoped: w.scoped.map(out) }));
            if (refusal) setActionError(refusal);
            else setFiledNote(`${filing.name} taken out of ${unreachedProjects(projectIds.length)}.`);
            void reload().catch(() => {});
          }}
          onDone={({ projectId, projectName }) => {
            const workflowId = filing.id;
            const moved = !!filing.projectId;
            setFiling(null);
            // The immediate truth (the rule the Maps screen keeps): the
            // workflow's own fact changes and a scope that no longer
            // holds it loses it, before the reconciling read answers —
            // and whether or not it does.
            mutate((w) => ({
              ...w,
              projects: w.projects.some((p) => p.id === projectId)
                ? w.projects
                : [{ id: projectId, name: projectName }, ...w.projects],
              all: w.all.map((x) =>
                x.id === workflowId ? { ...x, projectId } : x,
              ),
              scoped:
                scope.kind === "all"
                  ? w.scoped.map((x) =>
                      x.id === workflowId ? { ...x, projectId } : x,
                    )
                  : w.scoped.filter((x) => x.id !== workflowId),
            }));
            setFiledNote(
              `${filing.name} ${moved ? "moved" : "added"} to ${projectName}.`,
            );
            // Reconcile counts and the directory quietly.
            void reload().catch(() => {});
          }}
        />
      )}
      {actionError && (
        <ErrorNote
          message={actionError}
          onDismiss={() => setActionError(null)}
        />
      )}

      <div className={gallery.toolbar}>
        <ScopeFilter
          rows={
            world
              ? scopeRows(world.all, world.projects, (w) =>
                  w.projectId ? [w.projectId] : [],
                )
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
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search workflows…"
            aria-label="Search workflows"
          />
          <kbd>/</kbd>
        </label>
        <div
          className={gallery.chips}
          role="group"
          aria-label="Filter workflows"
        >
          {(
            [
              ["all", "All"],
              ["attention", "Needs attention"],
              ["never", "Never run"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={gallery.filterChip}
              data-on={filter === key || undefined}
              onClick={() => setFilter(key)}
            >
              {label}
              {/* Counts appear only once the list has resolved. */}
              {counts && (
                <span className={gallery.chipCount}> · {counts[key]}</span>
              )}
            </button>
          ))}
        </div>
        <div className={gallery.tail}>
          <label className={gallery.sort}>
            Sort
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as WorkflowsSort)}
              aria-label="Sort workflows"
            >
              <option value="edited">Recently edited</option>
              <option value="created">Recently created</option>
              <option value="name">Name A–Z</option>
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
          pendingLabel="Reading your workflows…"
        >
          {() => (
            <>
              {shown && view === "grid" && (
                <div className={gallery.grid}>
                  {newTile}
                  {shown.map((w, i) => (
                    <article
                      key={w.id}
                      className={gallery.card}
                      style={{
                        animationDelay: `${Math.min(45 + i * 45, 380)}ms`,
                      }}
                    >
                      <div
                        role="link"
                        tabIndex={0}
                        aria-label={`Open ${w.name}`}
                        className={gallery.cardLink}
                        onClick={() => open(w.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") open(w.id);
                        }}
                      >
                        <div className={gallery.strip} style={{ height: 148 }}>
                          <WorkflowThumb steps={w.steps} groupOf={groupOf} />
                          <span className={gallery.overlay}>
                            <b>
                              <span className={gallery.num}>
                                {w.summary.nodes}
                              </span>{" "}
                              {nodeWord(w.summary.nodes)}
                              {w.summary.sources > 0 && (
                                <>
                                  {" · "}
                                  <span className={gallery.num}>
                                    {w.summary.sources}
                                  </span>{" "}
                                  {sourceWord(w.summary.sources)}
                                </>
                              )}
                            </b>
                          </span>
                        </div>
                        <div className={gallery.cardBody}>
                          <div className={gallery.cardTop}>
                            <span className={gallery.cardName}>{w.name}</span>
                            <span className={gallery.cardWhen}>
                              <LastChanged value={w} />
                            </span>
                          </div>
                          <div className={gallery.cardChips}>
                            <WorkflowStatusChip summary={w.summary} />
                            <ProjectTag
                              projectId={w.projectId}
                              projects={world?.projects ?? []}
                            />
                          </div>
                        </div>
                      </div>
                      {othersOwner(w) && (
                        <OwnerPill owner={othersOwner(w)!} placement="corner" />
                      )}
                      {quickActions(w, gallery.acts, true)}
                    </article>
                  ))}
                </div>
              )}

              {shown && view === "list" && shown.length > 0 && (
                <div className={gallery.listCard}>
                  <div className={gallery.listHead} aria-hidden>
                    <span className={gallery.colThumb} />
                    <span className={gallery.colName}>Workflow</span>
                    <span className={gallery.colMeta}>Nodes</span>
                    <span className={gallery.colState}>Status</span>
                    <span className={gallery.colWhen}>Last edited</span>
                    <span className={gallery.colActs} />
                  </div>
                  {shown.map((w) => (
                    <div key={w.id} className={styles.listRowWrap}>
                      <button
                        className={gallery.listRow}
                        onClick={() => open(w.id)}
                        aria-label={`Open ${w.name}`}
                      >
                        <span
                          className={`${gallery.colThumb} ${gallery.rowThumb}`}
                        >
                          <WorkflowThumb
                            steps={w.steps}
                            groupOf={groupOf}
                            compact
                          />
                        </span>
                        <span className={gallery.colName}>
                          <span className={gallery.rowName}>{w.name}</span>
                          {othersOwner(w) && (
                            <OwnerPill owner={othersOwner(w)!} placement="inline" />
                          )}
                        </span>
                        <span className={gallery.colMeta}>
                          <span className={gallery.num}>{w.summary.nodes}</span>{" "}
                          {nodeWord(w.summary.nodes)}
                        </span>
                        <span className={gallery.colState}>
                          <WorkflowStatusChip summary={w.summary} />
                        </span>
                        <span className={`${gallery.colWhen} ${gallery.num}`}>
                          <LastChanged value={w} />
                        </span>
                        <span className={gallery.colActs} />
                      </button>
                      <span className={styles.listRowActs}>
                        {quickActions(w, gallery.rowActs, false)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {shown && shown.length === 0 && (workflows?.length ?? 0) > 0 && (
                <p className={gallery.empty}>
                  No workflows match. Clear the search or filters.
                </p>
              )}

              {workflows && workflows.length === 0 && view === "list" && (
                // Resolved-empty in list view is the same actionable state as
                // the grid's tile — the first action, not a prose shrug.
                <div className={gallery.emptyAction}>{newTile}</div>
              )}
            </>
          )}
        </AsyncState>
      </div>

      {naming && (
        <NewWorkflowDialog
          projectId={scope.kind === "project" ? scope.id : null}
          onClose={() => setNaming(false)}
        />
      )}
    </div>
  );
}
