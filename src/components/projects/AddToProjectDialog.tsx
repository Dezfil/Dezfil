"use client";

import { filingIntent, membershipBody, subjectBasis } from "./filing-intent";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readApiError, readRecipes } from "../api";
import { serverUnreachable } from "../failure-copy";
import { GeometryIcon, geometryKind } from "../gallery-icons";
import { unreachedProjects } from "../scope/model";
import { invalidateProjects } from "../shell/use-project-name";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { ErrorNote } from "../ui/ErrorNote";
import { Spinner } from "../Spinner";
import {
  addable,
  dialogTitle,
  dialogTitleParts,
  footer,
  initialSelection,
  producersOf,
  resolveEnter,
  searchRows,
  subjectCopy,
  type DependencyWire,
  type Destination,
  type FilingSelection,
  type FilingSubject,
} from "./add-model";
import { KindIcon } from "./ProjectPicture";
import { EMPTY_WORD, contentsWords, workflowCounts } from "./model";
import styles from "./AddToProjectDialog.module.css";

/* The 14-A dialog: the picker
   over the checklist over the live footer. No destination is picked on
   open — it asks, it does not guess — and only the projects one may file
   into are offered. The checklist offers one's own datasets and, apart
   from them, the workflows of one's own that make them, each a box of its
   own; another person's dependency is listed as not one's to add.
   Submission is single-flight over the two shipped membership roads.
   One's own subject still filed in a project one no longer reaches (one
   was removed from it) says so, and takes it out of there in one press:
   a withdrawal is always its owner's. */

const NAME_MAX = 120;

/** The shipped badge copy per source (table-chips' vocabulary). */
const SOURCE_WORDS: Record<string, string> = {
  upload: "File upload",
  url: "URL import",
  overture: "Overture Maps",
  osm: "OpenStreetMap",
  postgis: "PostGIS",
  operation: "Operation result",
  sketch: "Drawn on a map",
};

interface ProjectRowWire {
  id: string;
  name: string;
  mapCount: number;
  tableCount: number;
  /** The reader's role: an owner or an Editor may file there. */
  role?: "owner" | "editor" | "viewer";
}

/** A project one may file one's own work into: one's own, or one where one
 * is an Editor. */
const mayFile = (p: ProjectRowWire) => p.role === undefined || p.role === "owner" || p.role === "editor";

const NOTHING: FilingSelection = { datasets: new Set(), workflows: new Set() };

async function readJson<T>(path: string, doing: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store" });
  } catch {
    throw new Error(serverUnreachable(doing));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as T;
}

type Reads =
  | { status: "pending" }
  | { status: "failed"; error: string }
  | {
      status: "ready";
      deps: DependencyWire[];
      projects: ProjectRowWire[];
      /** Every project the reader reaches, filing rights or not. */
      reached: Set<string>;
      /** Each project's workflows, from the workflow-origin listing. */
      workflows: Map<string, number>;
    };

export function AddToProjectDialog({
  subject,
  onClose,
  onDone,
  onWithdrawn,
}: {
  /** A map or, a workflow or a dataset. */
  subject: FilingSubject;
  onClose: () => void;
  /** The subject was taken out of projects the reader no longer reaches:
   * their identities, for the caller's own truth-keeping, and the refusal
   * that stopped the rest, if one did after some were taken out. */
  onWithdrawn: (outcome: { projectIds: string[]; refusal?: string }) => void;
  /** The confirmed outcome: the destination's id and name, and what
   * moved, for the caller's own truth-keeping and statement. */
  onDone: (outcome: {
    projectId: string;
    projectName: string;
    datasetIds: string[];
    workflowIds: string[];
  }) => void;
}) {
  // Pending is DERIVED from the answer's attempt key, never written
  // synchronously in the effect (the house async structure).
  const [answered, setAnswered] = useState<{ attempt: number; reads: Reads }>({
    attempt: 0,
    reads: { status: "pending" },
  });
  const [attempt, setAttempt] = useState(1);
  const reads: Reads =
    answered.attempt === attempt ? answered.reads : { status: "pending" };
  const [checked, setChecked] = useState<FilingSelection>(NOTHING);
  const [destination, setDestination] = useState<Destination>(null);
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const mine = attempt;
    void (async () => {
      try {
        // A dataset has no checklist: it needs no dependencies read.
        const depsRead: Promise<DependencyWire[]> =
          subject.kind === "map"
            ? readJson<{ datasets: DependencyWire[] }>(
                `/api/maps/${subject.id}/dependencies`,
                "list the map's datasets",
              ).then((b) => b.datasets)
            : subject.kind === "workflow"
              ? readJson<{ datasets: DependencyWire[] }>(
                  `/api/recipes/${subject.id}/dependencies`,
                  "list the workflow's datasets",
                ).then((b) => b.datasets)
              : Promise.resolve([]);
        const [deps, listed, workflows] = await Promise.all([
          depsRead,
          readJson<ProjectRowWire[]>("/api/projects", "load the projects"),
          readRecipes("workflow"),
        ]);
        if (cancelled) return;
        setAnswered({
          attempt: mine,
          reads: {
            status: "ready",
            deps,
            projects: listed.filter(mayFile),
            reached: new Set(listed.map((p) => p.id)),
            workflows: workflowCounts(workflows),
          },
        });
        // One's own datasets start selected, and for a map the workflows of
        // one's own that make them.
        setChecked(initialSelection(subject, deps));
      } catch (e) {
        if (!cancelled)
          setAnswered({
            attempt: mine,
            reads: {
              status: "failed",
              error:
                e instanceof Error
                  ? e.message
                  : serverUnreachable("open the dialog"),
            },
          });
      }
    })();
    return () => {
      cancelled = true;
    };
    // The subject's identity and kind decide the reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject.id, subject.kind, attempt]);

  const copy = subjectCopy(subject.kind);
  const title = dialogTitleParts(subject);
  // The project a moving subject is in — unavailable as a destination;
  // for a dataset, every project it is already in.
  const currentIds = useMemo(
    () =>
      new Set(
        subject.kind === "dataset"
          ? subject.projectIds
          : subject.projectId
            ? [subject.projectId]
            : [],
      ),
    [subject],
  );

  const ready = reads.status === "ready" ? reads : null;
  const producers = useMemo(
    () => (ready ? producersOf(subject, ready.deps) : []),
    [ready, subject],
  );
  const names = useMemo(
    () => new Map((ready?.projects ?? []).map((p) => [p.id, p.name])),
    [ready],
  );
  const selectable = useCallback(
    (id: string) => !currentIds.has(id),
    [currentIds],
  );
  const { shown, hits } = searchRows(
    ready?.projects ?? [],
    query,
    destination?.kind === "existing" ? destination.id : null,
  );
  const foot = footer(
    ready?.deps ?? [],
    checked,
    destination,
    (id) => names.get(id) ?? null,
    subject.kind,
  );
  const canConfirm = ready !== null && foot.enabled && !submitting;
  // Filed where the reader no longer reaches: the directory does not list it.
  const unreached = useMemo(
    () => (ready ? [...currentIds].filter((id) => !ready.reached.has(id)) : []),
    [ready, currentIds],
  );

  const withdraw = useCallback(async () => {
    if (inFlight.current || unreached.length === 0) return;
    inFlight.current = true;
    setSubmitting(true);
    setRefusal(null);
    const change =
      subject.kind === "map"
        ? { removeMaps: [subject.id] }
        : subject.kind === "workflow"
          ? { removeRecipes: [subject.id] }
          : { removeTables: [subject.id] };
    const done: string[] = [];
    try {
      for (const projectId of unreached) {
        const response = await fetch(`/api/projects/${projectId}/members`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(membershipBody({ members: change, bases: subjectBasis(subject) })),
        });
        if (!response.ok) throw new Error(await readApiError(response));
        done.push(projectId);
      }
      onWithdrawn({ projectIds: done });
    } catch (e) {
      const refusal =
        e instanceof Error ? e.message : "The change couldn't be applied.";
      // What was taken out stays out: the caller keeps that truth and says
      // the refusal. Nothing taken out keeps the dialog, as a filing does.
      if (done.length > 0) {
        onWithdrawn({ projectIds: done, refusal });
        return;
      }
      setRefusal(refusal);
      inFlight.current = false;
      setSubmitting(false);
    }
  }, [unreached, subject, onWithdrawn]);

  const confirm = useCallback(async () => {
    if (!ready || !destination || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setRefusal(null);
    const intent = filingIntent(subject, ready.deps, checked);
    const members = membershipBody(intent);
    const datasetIds = members.addTables ?? [];
    const workflowIds =
      subject.kind === "map" ? (members.addRecipes ?? []) : [];
    try {
      let projectId: string;
      let projectName: string;
      if (destination.kind === "existing") {
        const response = await fetch(
          `/api/projects/${destination.id}/members`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(members),
          },
        );
        if (!response.ok) throw new Error(await readApiError(response));
        projectId = destination.id;
        projectName = names.get(destination.id) ?? "";
      } else {
        const response = await fetch("/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: destination.name.trim(), members }),
        });
        if (!response.ok) throw new Error(await readApiError(response));
        const created = (await response.json()) as {
          id: string;
          name: string;
        };
        projectId = created.id;
        projectName = created.name;
        // The shell's name directory must know the new destination
        // before the next object path renders it.
        invalidateProjects();
      }
      onDone({ projectId, projectName, datasetIds, workflowIds });
    } catch (e) {
      // A refusal keeps the dialog and every selection; the substrate's
      // contract means nothing changed.
      setRefusal(
        e instanceof Error ? e.message : "The change couldn't be applied.",
      );
      inFlight.current = false;
      setSubmitting(false);
    }
  }, [ready, destination, checked, subject, names, onDone]);

  const pickNew = (proposed: string, overwrite = false) => {
    // The no-match Enter path carries ITS query even over an older
    // draft; a plain radio pick keeps what was typed before.
    const name = overwrite && proposed ? proposed : newName || proposed;
    setDestination({ kind: "new", name });
    if (name !== newName) setNewName(name);
  };

  return (
    <Dialog
      label={dialogTitle(subject)}
      onClose={() => {
        if (!submitting) onClose();
      }}
      className={styles.dialog}
    >
      <div className={styles.head}>
        <span className={styles.title}>
          {title.before}
          <strong>{title.name}</strong>
          {title.after}
        </span>
        {copy.subtitle !== null && <small>{copy.subtitle}</small>}
      </div>

      {reads.status === "pending" && (
        <div className={styles.stateBlock}>
          <Spinner />
          <span>{copy.reading}</span>
        </div>
      )}
      {reads.status === "failed" && (
        <div className={styles.stateBlock}>
          <ErrorNote
            message={reads.error}
            onRetry={() => setAttempt((a) => a + 1)}
          />
        </div>
      )}

      {ready && (
        <div className={styles.body}>
          {unreached.length > 0 && (
            <div className={styles.unreached} data-unreached-project>
              <span>
                <b>In {unreachedProjects(unreached.length)}.</b> Its people
                still see it.
              </span>
              <Button
                variant="quiet"
                onClick={() => void withdraw()}
                disabled={submitting}
              >
                Take it out
              </Button>
            </div>
          )}
          <div className={styles.selHead}>Project</div>
          <input
            className={styles.findInput}
            type="text"
            placeholder="Find a project…"
            aria-label="Find a project"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              const resolved = resolveEnter(hits, query, selectable);
              if (!resolved) return;
              if (resolved.kind === "pick")
                setDestination({ kind: "existing", id: resolved.id });
              else pickNew(resolved.name, true);
            }}
          />
          <div className={styles.pickList}>
            <div className={styles.pickRows}>
              {shown.map((p) => {
                const current = currentIds.has(p.id);
                const on =
                  destination?.kind === "existing" && destination.id === p.id;
                return (
                  <label
                    key={p.id}
                    className={styles.pRow}
                    data-on={on || undefined}
                    data-current={current || undefined}
                  >
                    <input
                      type="radio"
                      name="add-destination"
                      checked={on}
                      disabled={current}
                      onChange={() =>
                        setDestination({ kind: "existing", id: p.id })
                      }
                    />
                    <span className={styles.pName}>{p.name}</span>
                    <span className={styles.pMeta}>
                      {current
                        ? "current project"
                        : contentsWords(p, ready?.workflows.get(p.id) ?? 0).join(" · ") || EMPTY_WORD}
                    </span>
                  </label>
                );
              })}
              {hits.length === 0 && (
                <div className={styles.pickEmpty}>
                  No project named <b>{query.trim()}</b>.
                </div>
              )}
            </div>
            <div className={styles.pickFoot}>
              <div className={styles.rule} />
              <label
                className={styles.pRow}
                data-on={destination?.kind === "new" || undefined}
              >
                <input
                  type="radio"
                  name="add-destination"
                  checked={destination?.kind === "new"}
                  onChange={() => pickNew(query.trim())}
                />
                {destination?.kind === "new" ? (
                  <input
                    className={styles.newNameInput}
                    type="text"
                    placeholder="Name the project"
                    aria-label="New project name"
                    autoFocus
                    maxLength={NAME_MAX + 1}
                    value={newName}
                    onChange={(e) => {
                      setNewName(e.target.value);
                      setDestination({ kind: "new", name: e.target.value });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && canConfirm) {
                        e.preventDefault();
                        void confirm();
                      }
                    }}
                  />
                ) : (
                  <span className={styles.pNameMuted}>New project</span>
                )}
              </label>
            </div>
          </div>

          {copy.checklist !== null && (
            <div className={styles.selHead}>
              {copy.checklist} <small>{ready.deps.length}</small>
              <span className={styles.selAll}>
                <button
                  type="button"
                  onClick={() =>
                    setChecked({
                      ...checked,
                      datasets: new Set(ready.deps.filter(addable).map((d) => d.id)),
                    })
                  }
                >
                  All
                </button>
                <i>·</i>
                <button type="button" onClick={() => setChecked({ ...checked, datasets: new Set() })}>
                  None
                </button>
              </span>
            </div>
          )}
          {copy.checklist !== null && (
            <div className={styles.checkRows}>
              {ready.deps.map((d) => {
                const others = d.projectIds
                  .filter((id) => !currentIds.has(id))
                  .map((id) => names.get(id))
                  .filter((x): x is string => typeof x === "string")
                  .sort((a, b) => a.localeCompare(b));
                const mine = addable(d);
                return (
                  <label
                    key={d.id}
                    className={styles.checkRow}
                    data-not-addable={mine ? undefined : ""}
                  >
                    <input
                      type="checkbox"
                      checked={mine && checked.datasets.has(d.id)}
                      disabled={!mine}
                      onChange={(e) => {
                        const next = new Set(checked.datasets);
                        if (e.target.checked) next.add(d.id);
                        else next.delete(d.id);
                        setChecked({ ...checked, datasets: next });
                      }}
                    />
                    <span
                      className={styles.typeTile}
                      data-kind={geometryKind(d.geometryType, d.geometryColumn)}
                    >
                      <GeometryIcon
                        kind={geometryKind(d.geometryType, d.geometryColumn)}
                      />
                    </span>
                    <span className={styles.dsName}>{d.qualifiedName ?? d.name}</span>
                    <span className={styles.dsMeta}>
                      {SOURCE_WORDS[d.source] ?? d.source} ·{" "}
                      {d.rowCount.toLocaleString("en-US")} row
                      {d.rowCount === 1 ? "" : "s"}
                    </span>
                    {!mine && (
                      <span className={styles.dsSub}>
                        {d.owner ? <><b>{d.owner.name}</b>’s · </> : null}not yours to add
                      </span>
                    )}
                    {d.producer && (
                      <span className={styles.dsSub}>
                        {d.producer.id === subject.id ? (
                          <>its own result</>
                        ) : (
                          <>
                            made by <b>{d.producer.name}</b>
                          </>
                        )}
                      </span>
                    )}
                    {mine && others.length > 0 && (
                      <span className={styles.dsSub}>
                        also in <b>{others.join(", ")}</b>, stays shared
                      </span>
                    )}
                  </label>
                );
              })}
              {ready.deps.length === 0 && (
                <div className={styles.pickEmpty}>{copy.empty}</div>
              )}
            </div>
          )}
          {/* The workflows that make those datasets, each a box of its own:
              a dataset can be filed without the workflow that makes it, and
              the workflow without its dataset. */}
          {copy.checklist !== null && producers.length > 0 && (
            <>
              <div className={styles.selHead}>
                Workflows that make them <small>{producers.length}</small>
              </div>
              <div className={styles.checkRows} data-producers>
                {producers.map((p) => (
                  <label
                    key={p.id}
                    className={styles.checkRow}
                    data-not-addable={p.owned ? undefined : ""}
                  >
                    <input
                      type="checkbox"
                      checked={p.owned && checked.workflows.has(p.id)}
                      disabled={!p.owned}
                      onChange={(e) => {
                        const next = new Set(checked.workflows);
                        if (e.target.checked) next.add(p.id);
                        else next.delete(p.id);
                        setChecked({ ...checked, workflows: next });
                      }}
                    />
                    <span className={styles.typeTile} data-kind="workflow">
                      <KindIcon kind="workflow" />
                    </span>
                    <span className={styles.dsName} data-producer-name>
                      {p.name}
                    </span>
                    <span className={styles.dsMeta}>Workflow</span>
                    {!p.owned && <span className={styles.dsSub}>not yours to add</span>}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {refusal && (
        <div className={styles.refusal}>
          <ErrorNote message={refusal} onDismiss={() => setRefusal(null)} />
        </div>
      )}

      <div className={styles.foot}>
        <span className={styles.status}>{ready ? foot.status : ""}</span>
        <Button variant="quiet" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => void confirm()}
          disabled={!canConfirm}
          busy={submitting}
        >
          <span className={styles.goLabel} title={foot.label}>
            {foot.label}
          </span>
        </Button>
      </div>
    </Dialog>
  );
}
