"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readApiError } from "../api";
import { GeometryIcon, geometryKind } from "../gallery-icons";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { ErrorNote } from "../ui/ErrorNote";
import { Spinner } from "../Spinner";
import { Tabs, type TabSpec } from "../ui/Tabs";
import { KindIcon } from "./ProjectPicture";
import type { DependencyWire } from "./add-model";
import { readJson, type CatalogueState } from "./home-read";
import {
  composeChange,
  emptySelection,
  pickerItems,
  pickerLabel,
  pickerStatus,
  searchItems,
  type DepsRead,
  type Members,
  type PickItem,
  type PickKind,
  type Selection,
} from "./picker-model";
import { whereLine } from "./recent-model";
import styles from "./AddItemsDialog.module.css";

/**
 * The project-first picker (the ruled window at one size): three tabs
 * over what is not yet in this project, a search per tab, selections
 * kept across tabs, the footer counting what will join — the picked
 * objects and what they bring, each once — and one atomic membership
 * change. A picked map's or workflow's bring-along set is read when it
 * is picked and cached; while any read is pending or failed,
 * confirmation waits, never files with an empty set.
 */

type Tab = "maps" | "workflows" | "datasets";
const TABS: readonly TabSpec<Tab>[] = [
  { value: "maps", label: "Maps" },
  { value: "workflows", label: "Workflows" },
  { value: "datasets", label: "Data" },
];
function readKey(kind: PickKind, id: string) {
  return `${kind}:${id}`;
}

export function AddItemsDialog({
  projectId,
  projectName,
  catalogue,
  names,
  members,
  onRetryCatalogue,
  onClose,
  onDone,
}: {
  projectId: string;
  projectName: string;
  catalogue: CatalogueState;
  names: Map<string, string>;
  /** What the project already holds: never counted as brought, never
   * sent again. */
  members: Members;
  onRetryCatalogue: () => void;
  onClose: () => void;
  /** The change landed: the home re-reads and states the outcome. */
  onDone: (outcome: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("maps");
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [reads, setReads] = useState<Map<string, DepsRead>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const inFlight = useRef(false);

  const lists = useMemo(
    () =>
      catalogue.status === "ready"
        ? pickerItems({ ...catalogue.value, projectId, names })
        : { maps: [], workflows: [], datasets: [] },
    [catalogue, projectId, names],
  );
  const shown = useMemo(() => searchItems(lists[tab], query), [lists, tab, query]);

  /** A picked map's or workflow's dependencies, read once and kept. */
  const ensureRead = useCallback((kind: PickKind, id: string) => {
    if (kind === "dataset") return;
    const key = readKey(kind, id);
    setReads((current) => {
      if (current.has(key)) return current;
      const next = new Map(current);
      next.set(key, { status: "pending" });
      return next;
    });
    void readJson<{ datasets: DependencyWire[] }>(
      kind === "map"
        ? `/api/maps/${id}/dependencies`
        : `/api/recipes/${id}/dependencies`,
      "list the datasets",
    )
      .then((body) => {
        setReads((current) => {
          const next = new Map(current);
          next.set(key, { status: "ready", deps: body.datasets });
          return next;
        });
      })
      .catch((e: unknown) => {
        setReads((current) => {
          const next = new Map(current);
          next.set(key, {
            status: "failed",
            error: e instanceof Error ? e.message : "The datasets couldn't be read.",
          });
          return next;
        });
      });
  }, []);

  const toggle = (item: PickItem) => {
    setRefusal(null);
    setSelection((current) => {
      const next: Selection = {
        maps: new Set(current.maps),
        workflows: new Set(current.workflows),
        datasets: new Set(current.datasets),
      };
      const set =
        item.kind === "map"
          ? next.maps
          : item.kind === "workflow"
            ? next.workflows
            : next.datasets;
      if (set.has(item.id)) set.delete(item.id);
      else set.add(item.id);
      return next;
    });
    ensureRead(item.kind, item.id);
  };

  // The composition keys reads by object; the model keys them by id, so
  // hand it the reads under the ids of the selected kinds.
  const readsById = useMemo(() => {
    const byId = new Map<string, DepsRead>();
    for (const id of selection.maps) {
      const r = reads.get(readKey("map", id));
      if (r) byId.set(id, r);
    }
    for (const id of selection.workflows) {
      const r = reads.get(readKey("workflow", id));
      if (r) byId.set(id, r);
    }
    return byId;
  }, [reads, selection]);
  const composed = useMemo(
    () => composeChange(selection, readsById, members),
    [selection, readsById, members],
  );
  const picked =
    selection.maps.size + selection.workflows.size + selection.datasets.size;
  const pendingReads = composed.blocked.filter(
    (id) => readsById.get(id)?.status !== "failed",
  ).length;
  const failedReads = composed.blocked.length - pendingReads;
  const canConfirm =
    picked > 0 && composed.blocked.length === 0 && !submitting;

  const confirm = useCallback(async () => {
    if (!canConfirm || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setRefusal(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/members`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(composed.members),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const total =
        composed.summary.maps +
        composed.summary.workflows +
        composed.summary.datasets +
        composed.summary.brought;
      onDone(`Added ${total} item${total === 1 ? "" : "s"} to ${projectName}.`);
    } catch (e) {
      setRefusal(
        e instanceof Error ? e.message : "The change couldn't be applied.",
      );
      inFlight.current = false;
      setSubmitting(false);
    }
  }, [canConfirm, composed, projectId, projectName, onDone]);

  // Escape closes unless a change is in flight.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  const isPicked = (item: PickItem) =>
    item.kind === "map"
      ? selection.maps.has(item.id)
      : item.kind === "workflow"
        ? selection.workflows.has(item.id)
        : selection.datasets.has(item.id);

  const subline = (item: PickItem): string | null => {
    if (!isPicked(item)) return null;
    const bits: string[] = [];
    if (item.kind !== "dataset" && item.where.length > 0) {
      bits.push(`moves out of ${item.where[0]}`);
    }
    if (item.kind !== "dataset") {
      const r = reads.get(readKey(item.kind, item.id));
      if (!r || r.status === "pending") bits.push("reading its datasets…");
      else if (r.status === "failed") bits.push(`its datasets couldn't be read: ${r.error}`);
      else if (r.deps.length) bits.push(`brings ${r.deps.map((d) => d.name).join(", ")}`);
    }
    if (item.kind === "dataset" && item.where.length > 0) {
      bits.push(`stays in ${item.where.join(", ")} too`);
    }
    return bits.length ? bits.join(" · ") : null;
  };

  return (
    <Dialog
      label={`Add to ${projectName}`}
      onClose={() => {
        if (!submitting) onClose();
      }}
      className={styles.dialog}
    >
      <div className={styles.head}>
        <strong>Add to {projectName}</strong>
        <small>
          A map or workflow lives in one project and moves in. A dataset can be
          in several.
        </small>
      </div>
      <Tabs
        group="add-items"
        label="What to add"
        className={styles.tabs}
        value={tab}
        onChange={(next) => {
          setTab(next);
          setQuery("");
        }}
        tabs={TABS.map((t) => ({
          ...t,
          label: (
            <>
              {t.label}
              {catalogue.status === "ready" && (
                <span className={styles.tabCount} data-tab-count={t.value}>
                  {lists[t.value].length}
                </span>
              )}
            </>
          ),
          name: t.label as string,
        }))}
      />
      <div className={styles.body}>
        <input
          className={styles.search}
          type="search"
          placeholder="Search…"
          aria-label={`Search ${TABS.find((t) => t.value === tab)!.label as string}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className={styles.rows} data-picker-rows>
          {catalogue.status === "pending" && (
            <div className={styles.stateRow}>
              <Spinner />
              <span>Reading the workspace…</span>
            </div>
          )}
          {catalogue.status === "failed" && (
            <div className={styles.stateRow}>
              <ErrorNote message={catalogue.error} onRetry={onRetryCatalogue} />
            </div>
          )}
          {catalogue.status === "ready" && lists[tab].length === 0 && (
            <div className={styles.stateRow} data-picker-empty>
              Everything of this kind is already in {projectName}.
            </div>
          )}
          {catalogue.status === "ready" && lists[tab].length > 0 && shown.length === 0 && (
            <div className={styles.stateRow} data-picker-empty>
              Nothing matches.
            </div>
          )}
          {shown.map((item) => {
            const sub = subline(item);
            return (
              <label
                key={item.id}
                className={styles.row}
                data-picker-row={item.kind}
                data-picked={isPicked(item) || undefined}
              >
                <input
                  type="checkbox"
                  checked={isPicked(item)}
                  disabled={submitting}
                  onChange={() => toggle(item)}
                  aria-label={`Pick ${item.name}`}
                />
                {/* The tile (page 23): the kind for a map or workflow, the
                    geometry for a dataset. */}
                <span
                  className={styles.tile}
                  data-kind={
                    item.kind === "dataset"
                      ? geometryKind(item.table.geometryType, item.table.geometryColumn)
                      : item.kind
                  }
                  aria-hidden
                >
                  {item.kind === "dataset" ? (
                    <GeometryIcon
                      kind={geometryKind(item.table.geometryType, item.table.geometryColumn)}
                    />
                  ) : (
                    <KindIcon kind={item.kind} />
                  )}
                </span>
                <span className={styles.text}>
                  <b className={item.kind === "dataset" ? styles.mono : undefined}>
                    {item.name}
                  </b>
                  <small>
                    <span data-picker-where>{whereLine(item.where)}</span>
                    <i>·</i>
                    {item.fact}
                  </small>
                  {sub && (
                    <small className={styles.sub} data-picker-sub>
                      {sub}
                    </small>
                  )}
                </span>
              </label>
            );
          })}
        </div>
        {refusal && (
          <div className={styles.refusal}>
            <ErrorNote message={refusal} onDismiss={() => setRefusal(null)} />
          </div>
        )}
      </div>
      <div className={styles.foot}>
        <span className={styles.status} data-picker-status>
          {pickerStatus(composed.summary)}
          {pendingReads > 0 && " · reading…"}
          {failedReads > 0 && " · a read failed"}
        </span>
        <Button variant="quiet" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => void confirm()}
          disabled={!canConfirm}
          busy={submitting}
        >
          {pickerLabel(composed.summary)}
        </Button>
      </div>
    </Dialog>
  );
}
