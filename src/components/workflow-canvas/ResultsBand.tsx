"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { OperationDef } from "@/lib/operations/catalog";
import type { TableListing } from "../api";
import { formatCount } from "../api";
import { IconTable } from "../gallery-icons";
import { RunInitiator } from "../sharing/RunInitiator";
import { useOpeningDefaults } from "../screen-defaults";
import { Button } from "../ui/Button";
import { ExternalIcon } from "../ui/icons";
import { BAND_DEFAULT, BAND_GAP, BAND_MIN, BAR_HEIGHT, COLLAPSE_BELOW, clampHeight, readBandChoice, writeBandChoice } from "./band-store";
import { addToMapFor, availability, effectiveTab, leadFor, notesFor, resolveShown, SELECT_LEAD, STATUS, type BandTab, type Shown } from "./band-selection";
import { composeLog, forNode } from "./messages";
import type { CanvasMember } from "./graph";
import type { WorkflowRun } from "./run-overlay";
import { useDatasetReads } from "./use-dataset-reads";
import { DataTab } from "./DataTab";
import { MapTab } from "./MapTab";
import { ProvenanceTab } from "./ProvenanceTab";
import styles from "./ResultsBand.module.css";

/** A listed dataset by the name its reader types: one's own plain, someone
 * else's qualified, so a same-named dataset of the reader's is never read. */
const typedName = (table: TableListing) => table.qualifiedName ?? table.name;

const TABS: { id: BandTab; label: string }[] = [
  { id: "messages", label: "Messages" },
  { id: "data", label: "Data" },
  { id: "map", label: "Map" },
  { id: "provenance", label: "Provenance" },
];

/**
 * The results band: under the canvas, never over it, resized by its top
 * edge (pointer or keyboard), which dragged all the way down collapses it
 * to its bar and dragged up opens it again; there is no separate collapse
 * control (on, -08-29). Open or collapsed is kept per viewer once they
 * choose it, by opening, closing or resizing the band; the height is not:
 * every workflow opens at the default height. Until they choose it opens
 * as the instance's default says, collapsed unless an admin chose open.
 * It opens when a tab is chosen on it and on a press anywhere on its bar,
 * both kept, and once when the page session first meets a run, which is
 * not the viewer's choice and is not kept. Four tabs: Messages (the run
 * records' log) and, for the selection, Data, Map and Provenance over the
 * documented table reads, with the lead, the facts, the notes and the
 * actions.
 */
export function ResultsBand({
  runs,
  activeRunId,
  hostHeight,
  selected,
  tables,
  operations,
  nodeExists,
  onSelectNode,
  onHeight,
  onAddToMap,
  onListingStale,
}: {
  runs: WorkflowRun[];
  /** The run in flight or just ended, for the first-run opening. */
  activeRunId: string | null;
  hostHeight: number;
  /** The selected member, whose dataset the three result tabs are about. */
  selected: CanvasMember | null;
  tables: TableListing[];
  operations: OperationDef[];
  nodeExists: (stepId: string) => boolean;
  onSelectNode: (stepId: string) => void;
  /** The band's height as laid out, for the host to make room. */
  onHeight: (px: number) => void;
  /** Add to a map for the dataset named: the host opens the dialog. */
  onAddToMap: (name: string) => void;
  /** A dataset the listing still held has vanished: the page re-reads it. */
  onListingStale: () => void;
}) {
  const [chosen] = useState(readBandChoice);
  const startsOpen = useOpeningDefaults()["canvas.resultsBand"] === "open";
  const [open, setOpen] = useState<boolean>(chosen ?? startsOpen);
  const [height, setHeight] = useState<number>(BAND_DEFAULT);
  // The person's own opening, closing or resizing: their choice, kept for
  // the next canvas. A run opening the band changes this canvas alone.
  const kept = useRef(chosen);
  const choose = (next: boolean) => {
    setOpen(next);
    if (kept.current === next) return;
    kept.current = next;
    writeBandChoice(next);
  };
  const [scope, setScope] = useState<"all" | "node">("all");
  const [wanted, setWanted] = useState<BandTab>("messages");
  // Once per page session: the first run met opens the band (adjusted
  // during render, as the run arrives with the props), for this canvas
  // alone: nothing is kept.
  const [firstRunSeen, setFirstRunSeen] = useState(false);
  if (activeRunId && !firstRunSeen) {
    setFirstRunSeen(true);
    if (!open) setOpen(true);
  }
  // The reads are renewed at each selection and each choice of a result
  // tab: the counter is part of their key.
  const selectedId = selected?.id ?? null;
  const [seenSelection, setSeenSelection] = useState(selectedId);
  const [renewal, setRenewal] = useState(0);
  if (seenSelection !== selectedId) {
    setSeenSelection(selectedId);
    setRenewal((n) => n + 1);
  }
  // The page's own events land as a new listing (an import, a removal, a
  // member succeeding, the post-run read): each renews the reads too, so
  // an input's resolution or a record moved by them is read again.
  const [seenTables, setSeenTables] = useState(tables);
  if (seenTables !== tables) {
    setSeenTables(tables);
    setRenewal((n) => n + 1);
  }
  const shown = open ? clampHeight(height, hostHeight) : BAR_HEIGHT;
  // The column's whole height, gap included: what the host keeps clear.
  useEffect(() => {
    onHeight(shown + BAND_GAP);
  }, [onHeight, shown]);

  // What the selection resolves to in the listing as last read, then the
  // read's own word: an inspection answered "not found" is the deleted
  // state's signal.
  const listed = resolveShown(selected, tables);
  const wantMap = open && effectiveTab(wanted, availability(listed)) === "map";
  const reads = useDatasetReads(
    listed.kind === "dataset" ? { id: listed.table.id, name: typedName(listed.table), producedAt: listed.table.importedAt, renewal, features: wantMap } : null,
  );
  // Identity is checked on the answer itself: an inspection whose id is
  // not the resolved dataset's is a name reclaimed by another table since
  // the listing was read, the deleted state as much as "not found" is, and
  // never the stranger's rows. The page then renews the listing.
  const vanished =
    listed.kind === "dataset" &&
    (reads.inspection.status === "gone" ||
      reads.features?.status === "gone" ||
      (reads.inspection.status === "read" && reads.inspection.value.id !== listed.table.id));
  const vanishedKey = vanished && listed.kind === "dataset" ? `${listed.table.id} ${renewal}` : null;
  useEffect(() => {
    if (vanishedKey) onListingStale();
  }, [vanishedKey, onListingStale]);
  const state: Shown = vanished ? (selected?.kind === "node" ? { kind: "deleted" } : { kind: "missing" }) : listed;
  const avail = availability(state);
  const tab = effectiveTab(wanted, avail);
  // A fallback is the band's tab from then on: the tab shown
  // survives the next selection, not the one that could not be shown.
  if (tab !== wanted) setWanted(tab);
  const lead = leadFor(selected);
  const notes = notesFor(selected, state);
  const action = addToMapFor(state);
  const facts = state.kind === "dataset" && reads.inspection.status === "read" ? reads.inspection.value : null;
  const labelOf = (id: string) => operations.find((o) => o.id === id)?.label ?? null;
  const chooseTab = (t: BandTab) => {
    setWanted(t);
    setRenewal((n) => n + 1);
    if (!open) choose(true);
  };

  const selectedStepId = selected?.kind === "node" ? selected.id : null;
  const all = useMemo(() => composeLog(runs), [runs]);
  const entries = scope === "node" && selectedStepId ? forNode(all, selectedStepId) : all;
  const fmt = useMemo(() => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }), []);

  // The separator: a drag, or the arrow keys, resize; a drag that ends
  // below the collapse line leaves the band on its bar, and a drag up from
  // the bar opens it; Home collapses, End is the tallest.
  const drag = useRef<{ startY: number; startH: number } | null>(null);
  const settle = (raw: number) => {
    if (raw < COLLAPSE_BELOW) {
      choose(false);
      return;
    }
    choose(true);
    setHeight(clampHeight(raw, hostHeight));
  };
  return (
    <div className={styles.column} data-results-band data-collapsed={!open || undefined} data-band-shown={tab}>
      <div
        className={styles.separator}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the results band"
        aria-valuenow={shown}
        aria-valuemin={BAR_HEIGHT}
        aria-valuemax={Math.max(BAR_HEIGHT, hostHeight - 240)}
        tabIndex={0}
        data-band-separator
        onPointerDown={(e) => {
          drag.current = { startY: e.clientY, startH: shown };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          settle(drag.current.startH + (drag.current.startY - e.clientY));
        }}
        onPointerUp={(e) => {
          drag.current = null;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") {
            e.preventDefault();
            settle((open ? height : BAND_MIN - 24) + 24);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) return;
            // A step below the minimum is the collapse.
            settle(height <= BAND_MIN ? 0 : height - 24);
          } else if (e.key === "Home") {
            e.preventDefault();
            choose(false);
          } else if (e.key === "End") {
            e.preventDefault();
            settle(hostHeight);
          }
        }}
      />
      <section className={styles.band} data-band-card style={{ height: shown }} aria-label="Results">
      {/* Collapsed, the whole bar opens the band: its empty area, its
          placeholder and a tab that is unavailable alike, which a field
          round found unopenable; a disabled
          tab dispatches no click at all, so its press is read at pointerup
          instead. Open, the tabs are the bar's controls and the rest of it
          is inert; collapsing is the separator's alone. */}
      <div
        className={styles.bar}
        onClick={() => {
          if (!open) choose(true);
        }}
        onPointerUp={(e) => {
          if (!open && (e.target as Element).closest("button:disabled")) choose(true);
        }}
        data-band-bar
      >
        <div className={styles.tabs} role="tablist" aria-label="Results">
          {TABS.map((t) => {
            const reason = t.id === "messages" ? null : avail[t.id];
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={styles.tab}
                data-on={tab === t.id || undefined}
                data-band-tab={t.id}
                disabled={reason !== null}
                title={reason ?? undefined}
                onClick={() => chooseTab(t.id)}
              >
                {t.label}
                {t.id === "messages" ? (
                  <span className={styles.count} data-band-count>
                    {all.length}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <span className={styles.lead} data-band-lead>
          {lead === null ? (
            SELECT_LEAD
          ) : lead.kind === "node" ? (
            <>
              {lead.label}
              {lead.dataset ? <b>{lead.dataset}</b> : null}
            </>
          ) : (
            <>
              <IconTable />
              <b>{lead.name}</b>
            </>
          )}
        </span>
        {facts ? (
          <span className={styles.facts} data-band-facts data-rows={facts.rowCount} data-columns={facts.columns.length}>
            <span>
              <b>{formatCount(facts.rowCount)}</b> rows
            </span>
            <span>
              <b>{facts.columns.length}</b> columns
            </span>
          </span>
        ) : null}
        {tab === "messages" ? (
          <div className={styles.scope} role="group" aria-label="Which nodes">
            <button type="button" className={styles.scopeBtn} data-on={scope === "all" || undefined} onClick={() => setScope("all")} data-band-scope="all">
              All nodes
            </button>
            <button
              type="button"
              className={styles.scopeBtn}
              data-on={scope === "node" || undefined}
              disabled={!selectedStepId}
              onClick={() => setScope("node")}
              data-band-scope="node"
            >
              This node
            </button>
          </div>
        ) : state.kind === "dataset" ? (
          <div className={styles.acts} data-band-actions>
            {action.kind !== "absent" ? (
              <Button
                variant="secondary"
                size="compact"
                disabled={action.kind === "unavailable"}
                title={action.kind === "unavailable" ? action.reason : undefined}
                onClick={() => {
                  if (action.kind === "available") onAddToMap(action.name);
                }}
                data-band-add-to-map
              >
                Add to a map
              </Button>
            ) : null}
            <Link href={`/tables/${encodeURIComponent(typedName(state.table))}`} className={styles.act} data-band-open-explorer>
              <ExternalIcon /> Open in Data
            </Link>
          </div>
        ) : null}
      </div>
      {open && tab !== "messages" && notes.length ? (
        <div className={styles.notes} role="status" data-band-notes>
          {notes.join(" ")}
        </div>
      ) : null}
      {open ? (
        <div className={styles.body}>
          {tab === "messages" ? (
            entries.length === 0 ? (
              <div className={styles.empty} data-band-empty>
                <div className={styles.big}>{all.length === 0 ? "Nothing has run yet" : "Nothing for this node yet"}</div>
                <div>{all.length === 0 ? "Run all, or run one node from its panel." : "Its runs will be listed here."}</div>
              </div>
            ) : (
              <ol className={styles.list} data-band-entries>
                {entries.map((e) => (
                  <li key={e.id} className={styles.entry} data-lv={e.level} data-run-id={e.runId} data-step-id={e.stepId ?? undefined}>
                    <span className={styles.ts}>{fmt.format(new Date(e.time))}{e.id.endsWith(":start") && <> · <RunInitiator actor={e.runner} /></>}</span>
                    <span className={styles.lv}>{e.level}</span>
                    <span className={styles.tx}>
                      {e.stepId && e.node && nodeExists(e.stepId) ? (
                        <button type="button" className={styles.nodeLink} onClick={() => onSelectNode(e.stepId!)} data-band-node={e.stepId}>
                          {e.node}
                        </button>
                      ) : null}
                      {e.stepId && e.node && nodeExists(e.stepId) ? e.text.slice(e.node.length) : e.text}
                    </span>
                  </li>
                ))}
              </ol>
            )
          ) : state.kind !== "dataset" ? (
            <div className={styles.empty} data-band-status={state.kind}>
              <div className={styles.big}>{STATUS[state.kind].big}</div>
              {STATUS[state.kind].small ? <div>{STATUS[state.kind].small}</div> : null}
            </div>
          ) : tab === "data" ? (
            <DataTab inspection={reads.inspection} retry={reads.retry} />
          ) : tab === "map" ? (
            <MapTab features={reads.features} crsAssumed={state.table.crsAssumed} retry={reads.retry} />
          ) : (
            <ProvenanceTab inspection={reads.inspection} labelOf={labelOf} retry={reads.retry} />
          )}
        </div>
      ) : null}
      </section>
    </div>
  );
}
