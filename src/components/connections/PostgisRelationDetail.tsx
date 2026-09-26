"use client";

import { useState } from "react";
import type { PgConnection } from "@/lib/metadata/connections";
import type { DataTable } from "@/components/api";
import { readApiError } from "@/components/api";
import { serverUnreachable } from "@/components/failure-copy";
import { Spinner } from "@/components/Spinner";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { CaretIcon } from "@/components/ui/icons";
import {
  estimateLabel,
  relationKindLabel,
  spatialLabel,
} from "./postgis-catalogue-model";
import { PostgisPreviewTable } from "./PostgisPreviewTable";
import { relationKey, type PostgisRemoteRelation } from "./postgis-pane-types";
import { usePostgisPreview } from "./use-postgis-preview";
import styles from "./PostgisPane.module.css";

export function PostgisRelationDetail({
  connection,
  relation,
  onConnectionUsed,
  onTableCreated,
  projectId = null,
}: {
  connection: PgConnection;
  relation: PostgisRemoteRelation;
  /** Reported after an import, the one operation here that writes the
   * connection's stored health; the preview reports nothing. */
  onConnectionUsed: (connectionId: string) => void;
  onTableCreated: (
    table: DataTable,
    relation: PostgisRemoteRelation,
    filter: string,
  ) => void | Promise<void>;
  /** The import's project context: a filed map's catalog
   * passes its project so the created table files in the same act. */
  projectId?: string | null;
}) {
  const [name, setName] = useState(relation.table);
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState("");
  const [busy, setBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [extrasOpen, setExtrasOpen] = useState(false);
  // A filter you can't see is a filter you don't think of (07 variant E):
  // the row stays open whenever either field holds a value.
  const showExtras = extrasOpen || filter.trim() !== "" || limit.trim() !== "";
  const preview = usePostgisPreview(connection.id, relation, filter);

  const importNow = async () => {
    if (busy) return;
    setBusy(true);
    setImportError(null);
    try {
      const response = await fetch("/api/imports/postgis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId: connection.id,
          schema: relation.schema,
          table: relation.table,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(filter.trim() ? { filter: filter.trim() } : {}),
          ...(limit.trim() ? { limit: Number(limit) } : {}),
          ...(projectId !== null ? { projectId } : {}),
        }),
      });
      onConnectionUsed(connection.id);
      if (!response.ok) {
        setImportError(await readApiError(response));
        return;
      }
      await onTableCreated(
        (await response.json()) as DataTable,
        relation,
        filter.trim(),
      );
    } catch {
      setImportError(serverUnreachable("start the import"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.relationDetail}>
      <div className={styles.selectedHead}>
        <h3 className={styles.qualified}>{relationKey(relation)}</h3>
        <span className={styles.kindMark}>{relationKindLabel(relation)}</span>
        {relation.system ? <span className={styles.systemMark}>system</span> : null}
        <span className={styles.spatialFact} data-geography={relation.spatialKind === "geography" || undefined}>
          {spatialLabel(relation)}
        </span>
        <span className={styles.estimateFact} data-unknown={estimateLabel(relation) === "not analyzed" || undefined}>
          {estimateLabel(relation)}
        </span>
        <button
          className={styles.columnsToggle}
          type="button"
          aria-expanded={columnsOpen}
          onClick={() => setColumnsOpen((open) => !open)}
        >
          <span className={styles.caret} aria-hidden><CaretIcon /></span>
          {preview.data ? `${preview.data.columns.length} columns` : "Columns"}
        </button>
      </div>

      {columnsOpen ? (
        <div className={styles.columnCard}>
          {preview.data ? (
            <div className={styles.columnList}>
              {preview.data.columns.map((column) => (
                <span className={styles.column} key={column.name} data-spatial={column.spatialKind || undefined}>
                  <span>{column.name}</span>
                  <span>{column.type}</span>
                </span>
              ))}
            </div>
          ) : (
            <span className={styles.columnPending}>Reading column types…</span>
          )}
        </div>
      ) : null}

      <div className={styles.previewFrame} aria-live="polite">
        <div className={styles.previewHead}>
          <strong>Preview</strong>
          <span>up to 5 rows from the source · filter applied</span>
          {preview.loading ? (
            <span className={styles.previewLoading}>
              <Spinner size={10} /> Refreshing…
            </span>
          ) : null}
        </div>
        {preview.error ? <div className={styles.previewError}><ErrorNote message={preview.error} /></div> : null}
        {preview.data ? <PostgisPreviewTable data={preview.data} /> : null}
      </div>

      <div className={styles.importBox}>
        <span className={styles.importTitle}>Import <code>{relationKey(relation)}</code> as a snapshot</span>
        <label className={styles.field}>
          <span>Table name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <button
          className={styles.reveal}
          type="button"
          aria-expanded={showExtras}
          onClick={() => setExtrasOpen((open) => !open)}
        >
          <span className={styles.caret} aria-hidden><CaretIcon /></span>
          Filter or row limit
        </button>
        {showExtras ? (
          <div className={styles.pair}>
            <label className={styles.field}>
              <span>Filter <em>WHERE, runs on the source</em></span>
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                spellCheck={false}
                placeholder="updated_at &gt; now() - interval '30 days'"
              />
            </label>
            <label className={`${styles.field} ${styles.narrow}`}>
              <span>Row limit <em>optional</em></span>
              <input value={limit} onChange={(event) => setLimit(event.target.value)} inputMode="numeric" placeholder="all rows" />
            </label>
          </div>
        ) : null}
        {importError ? <ErrorNote message={importError} onDismiss={() => setImportError(null)} /> : null}
        <div className={styles.importActions}>
          <button className={styles.primary} type="button" onClick={() => void importNow()} disabled={busy}>
            Import
          </button>
          {busy ? (
            <span className={styles.importBusy} role="status">
              <Spinner size={11} /> Snapshotting…
            </span>
          ) : (
            <span>A snapshot can be refreshed later from Connections or the table page.</span>
          )}
        </div>
      </div>
    </div>
  );
}
