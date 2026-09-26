"use client";

import { useCallback, useState } from "react";
import type { DataTable } from "./api";
import { readApiError } from "./api";
import type { SkippedMember } from "./skipped-members";
import { ErrorNote } from "./ui/ErrorNote";
import styles from "./UrlImportPane.module.css";
import { serverUnreachable } from "./failure-copy";

interface Props {
  /** Fires once per table the import created (container formats can land
   * several); the first one typically closes the hosting dialog. */
  onTableCreated: (table: DataTable) => void;
  /** Container members the import skipped — fires
   * before the first created table. */
  onSkipped?: (skipped: SkippedMember[]) => void;
  /** The import's project context: a filed map's catalog
   * passes its project so the created table files in the same act;
   * absent callers keep today's unfiled imports. */
  projectId?: string | null;
}

/** Derive a table-name suggestion from the URL's file name (display only —
 * the server applies the real naming rules). */
function suggestName(url: string): string {
  try {
    const file = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    const stem = decodeURIComponent(file).replace(/\.[^.]+$/, "");
    const cleaned = stem
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^(\d)/, "t$1");
    return cleaned;
  } catch {
    return "";
  }
}

/**
 * The From-URL import form, extracted from AddDataDialog so the
 * add-layer catalog can host the same flow. Behavior is the dialog's,
 * verbatim: URL + optional name, one import action, container skips
 * surfaced before the first created table.
 */
export function UrlImportPane({
  onTableCreated,
  onSkipped,
  projectId = null,
}: Props) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const created = useCallback(
    (table: DataTable) => {
      setUrl("");
      setName("");
      setNameEdited(false);
      onTableCreated(table);
    },
    [onTableCreated],
  );

  const importUrl = useCallback(async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/imports/url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(projectId !== null ? { projectId } : {}),
        }),
      });
      if (!response.ok) {
        setError(await readApiError(response));
        return;
      }
      // Container formats answer with every table they created; skips
      // surface first — the first table closes the host.
      const answer = (await response.json()) as DataTable & {
        tables?: DataTable[];
        skipped?: SkippedMember[];
      };
      onSkipped?.(answer.skipped ?? []);
      for (const table of answer.tables ?? [answer]) created(table);
    } catch {
      setError(serverUnreachable("start the import"));
    } finally {
      setBusy(false);
    }
  }, [url, name, busy, created, onSkipped, projectId]);

  return (
    <div className={styles.pane}>
      <label className={styles.field}>
        <span>File URL</span>
        <input
          className={styles.mono}
          placeholder="https://… · s3://… · gs://… · az://…"
          value={url}
          spellCheck={false}
          disabled={busy}
          onChange={(e) => {
            setUrl(e.target.value);
            if (!nameEdited) setName(suggestName(e.target.value));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void importUrl();
          }}
        />
      </label>
      <label className={styles.field}>
        <span>Table name</span>
        <input
          className={styles.mono}
          placeholder="derived from the URL"
          value={name}
          spellCheck={false}
          disabled={busy}
          onChange={(e) => {
            setName(e.target.value);
            setNameEdited(true);
          }}
        />
      </label>
      <div className={styles.urlRow}>
        <button
          className={styles.importBtn}
          onClick={() => void importUrl()}
          disabled={busy || !url.trim()}
        >
          {busy ? "Importing…" : "Import as table"}
        </button>
        {busy && <span className={styles.spinner} aria-hidden />}
      </div>
      {error && (
        <ErrorNote message={error} onDismiss={() => setError(null)} />
      )}
      <p className={styles.hint}>
        Reads Parquet, CSV, GeoJSON, Shapefile zips, GeoPackage, and KML/KMZ
        straight off the URL and materializes a snapshot. Private buckets use
        credentials configured on the server.
      </p>
    </div>
  );
}
