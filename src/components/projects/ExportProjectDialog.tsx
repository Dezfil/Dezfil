"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readApiError, type MapOverview, type TableListing } from "../api";
import { serverUnreachable } from "../failure-copy";
import {
  GeometryIcon,
  geometryKind,
  IconDownload,
  IconMap,
  IconTable,
  IconWorkflow,
} from "../gallery-icons";
import { CheckIcon } from "../ui/icons";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { ErrorNote } from "../ui/ErrorNote";
import { Spinner } from "../Spinner";
import { type WorkflowListing } from "../workflow-model";
import { archiveBaseName } from "@/lib/export/project-archive";
import {
  datasetSub,
  footerStatus,
  groupSmall,
  mapRowMeta,
  omittedLine,
  sizeText,
  sizeTotal,
  treeRows,
  workflowRowMeta,
  type ExportDatasetRow,
  type ExportMapRow,
  type ExportWorkflowRow,
} from "./export-model";
import styles from "./ExportProjectDialog.module.css";
import {
  DATASET_FORMATS,
  DATASET_FORMAT_HELP,
  DATASET_FORMAT_LABEL,
  DEFAULT_DATASET_FORMAT,
  isDatasetFormat,
  sizeKnowable,
  type DatasetFormat,
} from "@/lib/export/dataset-format";

interface Reads {
  maps: ExportMapRow[];
  workflows: ExportWorkflowRow[];
  datasets: ExportDatasetRow[];
  names: Map<string, string>;
  error: string | null;
}

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

/**
 * The 16-C export dialog: two steps — Contents, then a Review that
 * names what goes in — over the documented member reads, downloading
 * through the prepare-then-redeem road (the archive is finalized before
 * the native anchor navigation streams it). The host owns the outcome
 * notice; this dialog closes on success.
 */
export function ExportProjectDialog({
  projectId,
  projectName,
  onClose,
  onDone,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [attempt, setAttempt] = useState(1);
  const [answered, setAnswered] = useState<{
    attempt: number;
    reads: Reads | null;
  }>({ attempt: 0, reads: null });
  const [step, setStep] = useState<1 | 2>(1);
  const [file, setFile] = useState(() => archiveBaseName(projectName));
  const [sel, setSel] = useState<{
    maps: Set<string>;
    workflows: Set<string>;
    datasets: Set<string>;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // A dismissed dialog must not download late: a grant that
  // settles after unmount is dropped whole — no anchor, no outcome.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const mark = attempt;
    void (async () => {
      try {
        const [maps, workflows, tables, projects] = await Promise.all([
          readJson<MapOverview[]>(
            `/api/maps?project=${encodeURIComponent(projectId)}`,
            "load the maps",
          ),
          readJson<{ recipes: WorkflowListing[] }>(
            `/api/recipes?origin=workflow&project=${encodeURIComponent(projectId)}`,
            "load the workflows",
          ).then((b) => b.recipes),
          readJson<TableListing[]>(
            `/api/tables?project=${encodeURIComponent(projectId)}`,
            "load the datasets",
          ),
          readJson<{ id: string; name: string }[]>(
            "/api/projects",
            "load the projects",
          ),
        ]);
        if (cancelled) return;
        const reads: Reads = {
          maps: maps.map((m) => ({
            id: m.id,
            name: m.name,
            layerCount: m.layerCount,
            published: m.publishedAt !== null,
          })),
          workflows: workflows.map((w) => ({
            id: w.id,
            name: w.name,
            nodeCount: w.steps.length,
          })),
          datasets: tables.map((t) => ({
            id: t.id,
            name: t.name,
            sizeBytes: t.sizeBytes,
            source: t.source,
            projectIds: t.projectIds,
            geometryColumn: t.geometryColumn,
            geometryType: t.geometryType,
          })),
          names: new Map(projects.map((p) => [p.id, p.name])),
          error: null,
        };
        setAnswered({ attempt: mark, reads });
        // Everything selected on open; a retry re-arms
        // the same fully selected initial state.
        setSel({
          maps: new Set(reads.maps.map((m) => m.id)),
          workflows: new Set(reads.workflows.map((w) => w.id)),
          datasets: new Set(reads.datasets.map((d) => d.id)),
        });
      } catch (e) {
        if (!cancelled) {
          setAnswered({
            attempt: mark,
            reads: {
              maps: [],
              workflows: [],
              datasets: [],
              names: new Map(),
              error:
                e instanceof Error
                  ? e.message
                  : serverUnreachable("load the project"),
            },
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, attempt]);

  const ready =
    answered.attempt === attempt && answered.reads?.error === null
      ? answered.reads
      : null;
  const failed =
    answered.attempt === attempt ? (answered.reads?.error ?? null) : null;

  const picked = useMemo(() => {
    if (!ready || !sel) return null;
    return {
      maps: ready.maps.filter((m) => sel.maps.has(m.id)),
      workflows: ready.workflows.filter((w) => sel.workflows.has(w.id)),
      datasets: ready.datasets.filter((d) => sel.datasets.has(d.id)),
    };
  }, [ready, sel]);
  const total = picked
    ? picked.maps.length + picked.workflows.length + picked.datasets.length
    : 0;
  // One format for every dataset; the stored size
  // is claimed only while the stored format is chosen.
  const [datasetFormat, setDatasetFormat] = useState<DatasetFormat>(
    DEFAULT_DATASET_FORMAT,
  );
  const storedSize = sizeText(sizeTotal(picked?.datasets ?? []));
  const claimedSize = sizeKnowable(datasetFormat) ? storedSize : null;
  const status = picked
    ? footerStatus(
        {
          maps: picked.maps.length,
          workflows: picked.workflows.length,
          datasets: picked.datasets.length,
        },
        claimedSize,
      )
    : "";
  const left =
    ready && picked
      ? omittedLine({
          maps: ready.maps.length - picked.maps.length,
          workflows: ready.workflows.length - picked.workflows.length,
          datasets: ready.datasets.length - picked.datasets.length,
        })
      : "";

  const toggle = useCallback(
    (kind: "maps" | "workflows" | "datasets", id: string, on: boolean) => {
      setSel((s) => {
        if (!s) return s;
        const next = new Set(s[kind]);
        if (on) next.add(id);
        else next.delete(id);
        return { ...s, [kind]: next };
      });
    },
    [],
  );
  const setAll = useCallback(
    (kind: "maps" | "workflows" | "datasets", ids: string[]) => {
      setSel((s) => (s ? { ...s, [kind]: new Set(ids) } : s));
    },
    [],
  );

  const download = useCallback(async () => {
    if (!picked || total === 0 || submitting) return;
    setSubmitting(true);
    setRefusal(null);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/export`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            maps: picked.maps.map((m) => m.id),
            workflows: picked.workflows.map((w) => w.id),
            datasets: picked.datasets.map((d) => d.id),
            file,
            datasetFormat,
            prepare: true,
          }),
        },
      );
      if (!response.ok) {
        const message = await readApiError(response);
        if (mountedRef.current) setRefusal(message);
        return;
      }
      const grant = (await response.json()) as {
        ticket: string;
        key: string;
        filename: string;
        size: number;
      };
      if (!mountedRef.current) return;
      // The prepared road: a native navigation streams the finalized
      // archive; no bytes pass through a whole-response blob.
      const a = document.createElement("a");
      a.href = `/api/projects/${encodeURIComponent(projectId)}/export?ticket=${encodeURIComponent(grant.ticket)}&key=${encodeURIComponent(grant.key)}`;
      a.download = "";
      a.rel = "noopener";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 0);
      // The archive's own size, from the grant: a conversion's is
      // unknown until written, and the review claimed none.
      onDone(
        `${grant.filename} · ${sizeText({ bytes: grant.size, partial: false })}`,
      );
    } catch {
      setRefusal(serverUnreachable("export the project"));
    } finally {
      setSubmitting(false);
    }
  }, [picked, total, submitting, projectId, file, datasetFormat, onDone]);

  const group = (
    kind: "maps" | "workflows" | "datasets",
    label: string,
    rows: {
      id: string;
      name: string;
      meta: string;
      sub?: string;
      mono?: boolean;
      /** A row's own tile (a dataset's geometry kind); the group's
       * tile otherwise. */
      tile?: React.ReactNode;
      kind?: string;
    }[],
    small: string,
    tile: React.ReactNode,
  ) => (
    <div className={styles.group} key={kind}>
      <div className={styles.selHead}>
        {label} <small>{small}</small>
        <span className={styles.selAll}>
          <button
            type="button"
            onClick={() =>
              setAll(
                kind,
                rows.map((r) => r.id),
              )
            }
          >
            All
          </button>
          <i>·</i>
          <button type="button" onClick={() => setAll(kind, [])}>
            None
          </button>
        </span>
      </div>
      <div className={styles.checkRows}>
        {rows.map((r) => (
          <label className={styles.checkRow} key={r.id}>
            <input
              type="checkbox"
              checked={sel?.[kind].has(r.id) ?? false}
              onChange={(e) => toggle(kind, r.id, e.target.checked)}
            />
            <span className={styles.typeTile} data-kind={r.kind}>
              {r.tile ?? tile}
            </span>
            <span className={r.mono ? styles.nameMono : styles.name}>
              {r.name}
            </span>
            <span className={styles.meta}>{r.meta}</span>
            {r.sub ? <span className={styles.sub}>{r.sub}</span> : null}
          </label>
        ))}
        {rows.length === 0 && <p className={styles.emptyGroup}>None</p>}
      </div>
    </div>
  );

  const contents = ready && (
    <div className={styles.groups}>
      {group(
        "maps",
        "Maps",
        ready.maps.map((m) => ({
          id: m.id,
          name: m.name,
          meta: mapRowMeta(m),
        })),
        groupSmall(picked?.maps.length ?? 0, ready.maps.length),
        <IconMap />,
      )}
      {group(
        "workflows",
        "Workflows",
        ready.workflows.map((w) => ({
          id: w.id,
          name: w.name,
          meta: workflowRowMeta(w),
        })),
        groupSmall(picked?.workflows.length ?? 0, ready.workflows.length),
        <IconWorkflow />,
      )}
      {group(
        "datasets",
        "Datasets",
        ready.datasets.map((d) => ({
          id: d.id,
          name: d.name,
          mono: true,
          meta:
            d.sizeBytes === null
              ? "size unknown"
              : sizeText({ bytes: d.sizeBytes, partial: false }),
          sub: datasetSub(d, projectId, ready.names),
          // The app's geometry tile per kind.
          kind: geometryKind(d.geometryType, d.geometryColumn),
          tile: (
            <GeometryIcon
              kind={geometryKind(d.geometryType, d.geometryColumn)}
            />
          ),
        })),
        groupSmall(
          picked?.datasets.length ?? 0,
          ready.datasets.length,
          claimedSize ?? undefined,
        ),
        <IconTable />,
      )}
    </div>
  );

  const review = picked && (
    <div className={styles.review}>
      <div className={styles.treeScroll} data-tree>
        <div className={styles.tree}>
          {treeRows({
            file,
            maps: picked.maps,
            workflows: picked.workflows,
            datasets: picked.datasets,
            datasetSize: claimedSize,
            datasetFormat,
          }).map((row, i) => (
            <div
              className={styles.treeRow}
              data-depth={row.depth}
              key={`${row.label}-${i}`}
            >
              <span
                className={
                  row.kind === "dir" ? styles.treeDir : styles.treeFile
                }
              >
                {row.label}
              </span>
              {row.note ? (
                <span className={styles.treeNote}>{row.note}</span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      <div className={styles.reviewForm}>
        <label className={styles.field}>
          <span>File name</span>
          <span className={styles.fileIn}>
            <input
              value={file}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setFile(e.target.value)}
              onBlur={() => setFile(archiveBaseName(file))}
            />
            <span className={styles.ext}>.zip</span>
          </span>
        </label>
        <label className={styles.field}>
          <span>Dataset format</span>
          <select
            className={styles.formatSelect}
            value={datasetFormat}
            onChange={(e) => {
              if (isDatasetFormat(e.target.value))
                setDatasetFormat(e.target.value);
            }}
          >
            {DATASET_FORMATS.map((f) => (
              <option key={f} value={f}>
                {DATASET_FORMAT_LABEL[f]}
              </option>
            ))}
          </select>
          <small className={styles.formatHelp}>
            {DATASET_FORMAT_HELP[datasetFormat]}
          </small>
        </label>
      </div>
      <div className={styles.notes}>
        <div className={styles.callout}>
          <b>Not included:</b> published links. Publishing belongs to this
          server.
        </div>
        {left !== "" && (
          <div className={styles.callout}>
            <b>Left out:</b> {left}
          </div>
        )}
        {refusal !== null && (
          <ErrorNote message={refusal} onDismiss={() => setRefusal(null)} />
        )}
      </div>
    </div>
  );

  return (
    <Dialog
      label={`Export ${projectName}`}
      onClose={onClose}
      className={styles.dialog}
    >
      <header className={styles.head}>
        <div className={styles.title}>
          <h2>Export {projectName}</h2>
          <p>
            Opens on any Dezfil. Datasets as{" "}
            {DATASET_FORMAT_LABEL[datasetFormat]}, maps and workflows as JSON.
          </p>
        </div>
        <div className={styles.steps}>
          <button
            type="button"
            className={styles.stepPill}
            data-on={step === 1 || undefined}
            data-done={step === 2 || undefined}
            onClick={() => setStep(1)}
          >
            <b>{step === 1 ? "1" : <CheckIcon />}</b>Contents
          </button>
          <button
            type="button"
            className={styles.stepPill}
            data-on={step === 2 || undefined}
            onClick={() => {
              if (total > 0) setStep(2);
            }}
          >
            <b>2</b>Review
          </button>
        </div>
      </header>
      <div className={styles.body}>
        {failed !== null ? (
          <div className={styles.stateBody}>
            <ErrorNote
              message={failed}
              onRetry={() => setAttempt((n) => n + 1)}
            />
          </div>
        ) : !ready ? (
          <div className={styles.stateBody}>
            <p className={styles.stateHint}>
              <Spinner /> Loading the project…
            </p>
          </div>
        ) : step === 1 ? (
          contents
        ) : (
          review
        )}
      </div>
      <div className={styles.foot}>
        <span className={styles.status} role="status">
          {ready ? status : ""}
        </span>
        {step === 1 ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!ready || total === 0}
              onClick={() => setStep(2)}
            >
              Next
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => setStep(1)}>Back</Button>
            <Button
              variant="primary"
              busy={submitting}
              disabled={total === 0 || submitting}
              onClick={() => void download()}
            >
              <IconDownload />{" "}
              {claimedSize === null ? "Download" : `Download ${claimedSize}`}
            </Button>
          </>
        )}
      </div>
    </Dialog>
  );
}
