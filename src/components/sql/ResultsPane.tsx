"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { TableFeaturesResult } from "@/lib/table-service";
import type { LayerExportFormat } from "@/lib/export/layer-export";
import type { TableListing } from "../api";
import { formatBytes, formatCount, readApiError } from "../api";
import { FeaturePreviewMap } from "../map/FeaturePreviewMap";
import type { QueryResult } from "../query-types";
import {
  DIVERGED_COPY,
  NOT_MAPPABLE_COPY,
  resultIsMappable,
} from "../query-promote";
import { SaveResultAsDataset } from "../SaveResultAsDataset";
import { Button } from "../ui/Button";
import { ErrorNote } from "../ui/ErrorNote";
import { LayersIcon } from "../ui/icons";
import { IconDownload, IconMap, IconTable } from "../gallery-icons";
import { serverUnreachable } from "../failure-copy";
import { featureCountReadout } from "../feature-readout";
import { ResultMap } from "./ResultMap";
import { ResultTable } from "./ResultTable";
import { useAnchored } from "./use-anchored";
import type { SchemaEntry } from "./use-schema-inventory";
import styles from "./SqlConsole.module.css";

/**
 * The results area, with the bar re-set by a field round: whatever the console is looking at — a table's
 * preview, a query's result, a failure, or nothing yet — under a Table |
 * Map toggle, with the meta line, the truncation footer, and the keeping
 * actions that belong to what is shown. The bar is one row with the
 * actions pinned to its end; everything said *about* the result lands on
 * its own line under the bar, never beside the actions.
 */
export type ResultsTab = "table" | "map";

export interface QueryRun extends QueryResult {
  /** The exact SQL that produced this result. */
  sql: string;
  /** The execution's identity: a re-run of identical SQL is a new result
   * with its own save state and download note. */
  runId: number;
}

export type Shown =
  | { kind: "empty" }
  | {
      kind: "preview";
      table: TableListing;
      schema: SchemaEntry | undefined;
      hasResult: boolean;
    }
  | { kind: "result"; run: QueryRun }
  | { kind: "error"; code: string; message: string };

interface Props {
  shown: Shown;
  busy: boolean;
  tab: ResultsTab;
  onTab: (tab: ResultsTab) => void;
  draft: string;
  onOpenAsSql: (table: TableListing) => void;
  /** A table whose columns failed to read can be retried from its preview
   * (the retry moved here with the unfold's retirement). */
  onRetrySchema: (name: string) => void;
  onBackToResult: () => void;
  onDismissError: () => void;
  onAddToMap: (subject: { sql: string; name: string; label: string }) => void;
  onSaved: (name: string) => void;
  onDownload: (format: LayerExportFormat) => Promise<void>;
}

function useTableFeatures(name: string | null) {
  const cache = useRef(new Map<string, TableFeaturesResult>());
  const [state, setState] = useState<
    { status: "pending" } | { status: "ready"; value: TableFeaturesResult } | { status: "failed"; error: string }
  >({ status: "pending" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!name) return;
    const hit = cache.current.get(name);
    if (hit) {
      setState({ status: "ready", value: hit });
      return;
    }
    let cancelled = false;
    setState({ status: "pending" });
    (async () => {
      try {
        let response: Response;
        try {
          response = await fetch(
            `/api/tables/${encodeURIComponent(name)}/features?sample=1`,
          );
        } catch {
          throw new Error(serverUnreachable("read the features"));
        }
        if (!response.ok) throw new Error(await readApiError(response));
        const body = (await response.json()) as TableFeaturesResult;
        cache.current.set(name, body);
        if (!cancelled) setState({ status: "ready", value: body });
      } catch (e) {
        if (!cancelled)
          setState({
            status: "failed",
            error: e instanceof Error ? e.message : serverUnreachable("read the features"),
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [name, attempt]);
  return { state, retry: () => setAttempt((n) => n + 1) };
}

function firstGeometryColumn(columns: readonly { name: string; type: string }[]): string | null {
  return columns.find((c) => c.type.startsWith("GEOMETRY"))?.name ?? null;
}

export function ResultsPane(p: Props) {
  const { shown, busy, tab, onTab } = p;
  const previewName = shown.kind === "preview" ? shown.table.name : null;
  const features = useTableFeatures(previewName);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloadNote, setDownloadNote] = useState<string | null>(null);
  // The saved dataset's name, for this execution: the confirmation is a
  // note under the bar, keyed like the download note.
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<LayerExportFormat | null>(null);
  const dlRef = useRef<HTMLDivElement>(null);
  const dlBtnRef = useRef<HTMLButtonElement>(null);
  const dlMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!downloadOpen) return;
    const away = (e: MouseEvent) => {
      const node = e.target as Node;
      if (!dlRef.current?.contains(node) && !dlMenuRef.current?.contains(node)) setDownloadOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [downloadOpen]);
  // The menu is placed in viewport coordinates: a short results card
  // clips its overflow, and the menu must not be cut with it.
  const dlPos = useAnchored(downloadOpen, dlBtnRef, dlMenuRef);
  // A new thing shown clears the download note — adjusted during render
  // against the shown key, so there is no second pass to cascade.
  const shownKey = shown.kind === "result" ? `run:${shown.run.runId}` : shown.kind;
  const [noteFor, setNoteFor] = useState(shownKey);
  if (noteFor !== shownKey) {
    setNoteFor(shownKey);
    setDownloadNote(null);
    setDownloadOpen(false);
    setSavedAs(null);
  }

  // What Map can show, and why not.
  let mapDisabledReason: string | null = null;
  if (shown.kind === "preview") {
    // Availability follows the geometry *column*: an empty or all-null
    // spatial table has one while its type is still unknown, and it earns
    // the honest empty map, not a "no geometry" refusal.
    if (shown.table.geometryColumn === null)
      mapDisabledReason = "This table has no geometry, so there is nothing to map.";
  } else if (shown.kind === "result") {
    if (!resultIsMappable(shown.run)) mapDisabledReason = "No geometry column in this result.";
  } else {
    mapDisabledReason = "Nothing to map yet.";
  }
  const effectiveTab: ResultsTab = mapDisabledReason ? "table" : tab;

  // The notes: one line under the bar, for whatever
  // is said about the result; nothing of it sits beside the actions.
  const notes: { text: React.ReactNode; role: "status" | "alert" }[] = [];
  if (shown.kind === "result") {
    if (!resultIsMappable(shown.run)) notes.push({ text: NOT_MAPPABLE_COPY, role: "status" });
    else if (shown.run.sql !== p.draft.trim()) notes.push({ text: DIVERGED_COPY, role: "status" });
    if (savedAs)
      notes.push({
        text: (
          <>
            Saved as <code>{savedAs}</code>.{" "}
            <Link href={`/tables/${encodeURIComponent(savedAs)}`}>open it</Link>
          </>
        ),
        role: "status",
      });
    if (downloadNote) notes.push({ text: downloadNote, role: "alert" });
  }
  if (shown.kind === "preview" && shown.table.geometryColumn === null)
    notes.push({ text: "This table has no geometry column, so there is no map.", role: "status" });

  return (
    <section
      className={styles.resultsCard}
      aria-label="Results"
      data-busy={busy || undefined}
      data-mode={shown.kind === "preview" ? "preview" : undefined}
    >
      <div className={styles.resBar} data-mode={shown.kind === "preview" ? "preview" : undefined}>
        {shown.kind === "preview" && (
          <span className={styles.lead}>
            {/* The mark: filled, with the table glyph,
                on a tinted bar — a preview reads as one at a glance. */}
            <span className={styles.leadChip}>
              <IconTable /> Preview
            </span>
            <b>{shown.table.name}</b>
            <button type="button" className={styles.linkBtn} onClick={() => p.onOpenAsSql(shown.table)}>
              Open as SQL
            </button>
            {shown.hasResult && (
              <button type="button" className={styles.linkBtn} onClick={p.onBackToResult}>
                Back to result
              </button>
            )}
          </span>
        )}
        <div className={styles.tabs} role="tablist" aria-label="Result view">
          <button
            type="button"
            role="tab"
            aria-selected={effectiveTab === "table"}
            data-on={effectiveTab === "table" || undefined}
            onClick={() => onTab("table")}
          >
            <IconTable /> Table
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={effectiveTab === "map"}
            data-on={effectiveTab === "map" || undefined}
            disabled={mapDisabledReason !== null}
            title={mapDisabledReason ?? undefined}
            onClick={() => onTab("map")}
          >
            <IconMap /> Map
          </button>
        </div>
        {shown.kind === "result" && (
          <div className={styles.resMeta}>
            <span>
              <b>{formatCount(shown.run.rowCount)}</b> rows
            </span>
            <span>{shown.run.columns.length} columns</span>
            <span>{shown.run.runtimeMs} ms</span>
          </div>
        )}
        {shown.kind === "preview" && (
          <div className={styles.resMeta}>
            <span>
              <b>{formatCount(shown.table.rowCount)}</b> rows
            </span>
            {shown.schema?.status === "ready" && <span>{shown.schema.schema.columns.length} columns</span>}
            <span>{formatBytes(shown.table.sizeBytes)}</span>
          </div>
        )}
        <span className={styles.spacer} />
        {shown.kind === "result" && (
          <div className={styles.resActs}>
            <Button
              variant="secondary"
              disabled={!resultIsMappable(shown.run)}
              onClick={() =>
                p.onAddToMap({ sql: shown.run.sql, name: "Query result", label: "This result" })
              }
            >
              <LayersIcon /> Add as map layer
            </Button>
            <div ref={dlRef} className={styles.menuHost}>
              <Button
                ref={dlBtnRef}
                variant="secondary"
                aria-haspopup="menu"
                aria-expanded={downloadOpen}
                busy={downloading !== null}
                title="Every row of this result, as a file"
                onClick={() => setDownloadOpen((o) => !o)}
              >
                <IconDownload /> {downloading ? "Preparing…" : "Download"}
              </Button>
              {downloadOpen && (
                <div
                  ref={dlMenuRef}
                  className={`${styles.menu} ${styles.menuAnchored}`}
                  role="menu"
                  aria-label="Download format"
                  style={dlPos ? { top: dlPos.top, left: dlPos.left } : { top: 0, left: 0, visibility: "hidden" }}
                >
                  {(
                    [
                      ["csv", "CSV", "every column; geometry as WKT"],
                      ["geoparquet", "GeoParquet", "the durable format Dezfil stores"],
                      ["geojson", "GeoJSON", resultIsMappable(shown.run) ? "features with the first geometry column" : "needs a geometry column"],
                    ] as const
                  ).map(([format, label, note]) => (
                    <button
                      key={format}
                      type="button"
                      role="menuitem"
                      className={styles.menuItem}
                      disabled={format === "geojson" && !resultIsMappable(shown.run)}
                      onClick={() => {
                        setDownloadOpen(false);
                        setDownloading(format);
                        setDownloadNote(null);
                        void p.onDownload(format).then(
                          () => setDownloading(null),
                          (e: unknown) => {
                            setDownloading(null);
                            setDownloadNote(e instanceof Error ? e.message : "The download could not be prepared.");
                          },
                        );
                      }}
                    >
                      <b>{label}</b>
                      <span>{note}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <SaveResultAsDataset
              key={shown.run.runId}
              sql={shown.run.sql}
              suggestedName="query_result"
              onSaved={(name) => {
                setSavedAs(name);
                p.onSaved(name);
              }}
            />
          </div>
        )}
      </div>
      {notes.length > 0 && (
        <div className={styles.resNotes}>
          {notes.map((n, i) => (
            <span key={i} className={styles.why} role={n.role}>
              {n.text}
            </span>
          ))}
        </div>
      )}
      <div className={styles.resBody}>
        {shown.kind === "empty" && (
          <div className={styles.resEmpty}>
            <div>
              <div className={styles.resEmptyBig}>Nothing to show yet</div>
              <div>Click a table on the left to preview it, or write a query and press ⌘/Ctrl + Enter.</div>
            </div>
          </div>
        )}
        {shown.kind === "error" && (
          <div className={styles.errorWrap}>
            <ErrorNote
              message={
                <>
                  <span className={styles.errorCode}>{shown.code}</span>
                  {shown.message}
                </>
              }
              onDismiss={p.onDismissError}
            />
          </div>
        )}
        {shown.kind === "result" && effectiveTab === "table" && (
          <ResultTable
            columns={shown.run.columns}
            rows={shown.run.preview}
            geometryColumn={firstGeometryColumn(shown.run.columns)}
            footer={
              shown.run.previewTruncated
                ? `Showing the first ${formatCount(shown.run.preview.length)} of ${formatCount(shown.run.rowCount)} rows. Save as dataset or Download to keep them all.`
                : null
            }
          />
        )}
        {shown.kind === "result" && effectiveTab === "map" && (
          <ResultMap
            columns={shown.run.columns}
            rows={shown.run.preview}
            geometryColumn={firstGeometryColumn(shown.run.columns)!}
            rowCount={shown.run.rowCount}
          />
        )}
        {shown.kind === "preview" && effectiveTab === "table" && (
          <>
            {shown.schema?.status === "ready" && (
              <ResultTable
                columns={shown.schema.schema.columns}
                rows={shown.schema.schema.preview}
                geometryColumn={shown.schema.schema.geometryColumn}
                footer={
                  shown.table.rowCount > shown.schema.schema.preview.length
                    ? `Showing the first ${formatCount(shown.schema.schema.preview.length)} of ${formatCount(shown.table.rowCount)} rows.`
                    : null
                }
              />
            )}
            {(!shown.schema || shown.schema.status === "pending") && (
              <div className={styles.resEmpty}>
                <div>Reading the table…</div>
              </div>
            )}
            {shown.schema?.status === "failed" && (
              <div className={styles.errorWrap}>
                <ErrorNote
                  message={shown.schema.error}
                  onRetry={() => p.onRetrySchema(shown.table.name)}
                />
              </div>
            )}
          </>
        )}
        {shown.kind === "preview" && effectiveTab === "map" && (
          <div className={styles.mapHost}>
            <FeaturePreviewMap
              geojson={
                features.state.status === "ready" && features.state.value.ok
                  ? (features.state.value.geojson as GeoJSON.GeoJSON)
                  : null
              }
            >
              {features.state.status === "pending" && (
                <div className={styles.mapNotice}>Reading features…</div>
              )}
              {features.state.status === "failed" && (
                <div className={styles.mapNotice}>
                  <ErrorNote message={features.state.error} onRetry={features.retry} />
                </div>
              )}
              {features.state.status === "ready" && !features.state.value.ok && (
                <div className={styles.mapNotice}>{features.state.value.reason}</div>
              )}
              {features.state.status === "ready" && features.state.value.ok && (
                <div className={styles.mapReadout}>
                  <span>{featureCountReadout(features.state.value)}</span>
                  {features.state.value.geometryType && <span>{features.state.value.geometryType}</span>}
                </div>
              )}
            </FeaturePreviewMap>
          </div>
        )}
      </div>
    </section>
  );
}
