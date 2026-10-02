"use client";

import { useCallback, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { readApiError } from "../../api";
import type { CatalogListing } from "./use-catalog-tables";
import type { QueryResult } from "../../query-types";
import { ResultGrid } from "../../ResultGrid";
import { Spinner } from "../../Spinner";
import type { SqlEditorHandle } from "../../sql-editor-handle";
import {
  IDLE_PREVIEW,
  beginPreview,
  impliedQuery,
  previewCurrency,
  previewRequest,
  settlePreview,
  type PreviewState,
} from "./catalog-state";
import { CatalogTableBrowser } from "./CatalogTableBrowser";
import { ErrorNote } from "../../ui/ErrorNote";
import styles from "./AddLayerCatalog.module.css";

/* CodeMirror loads lazily — shared with the dock and the workspace. */
const SqlEditor = dynamic(() => import("../../SqlEditor"), {
  ssr: false,
  loading: () => <div className={styles.cmLoading} />,
});

interface Props {
  /** The shared browser's bundle — every table, spatial or not:
   * non-spatial ones are legitimate SQL references (spec decision 4),
   * and the scope narrows only what the browser offers, never what the
   * draft may name. */
  listing: CatalogListing;
  /** The map the layer belongs to: the preview runs in its SQL home, the
   * context the saved layer is read in, so what is saved is what ran. */
  mapId?: string;
  draft: string;
  onDraft: (sql: string) => void;
  mode: "add" | "edit";
  /** Edit mode: the saved SQL, for the dirty marker and commit arming. */
  savedSql?: string;
  busy: boolean;
  /** Inline create/update outcome — rejection or uncertainty, beside
   * the draft (spec decision 8). */
  error: string | null;
  /** Add mode: dismissing clears the create outcome. */
  onDismissError?: () => void;
  /** Edit mode: the failure is the save lane's, mirrored inline. The
   * mirror DOES announce — the rail's banner sits in the dialog's inert
   * background while the catalog is open, so this note is the only one
   * the accessibility tree can hear. It still
   * carries no dismiss: dismissal belongs to the lane. */
  errorMirrored?: boolean;
  onCommit: () => void;
}

/**
 * The workbench (refit): the shared table browser above the editor,
 * a result grid beside them. A table click writes the whole `SELECT *
 * FROM …` statement — replacing the draft, ruled intended — and never
 * runs anything; ⌘/Ctrl+Enter runs a read-only preview — never the
 * commit, which stays on the explicit Add/Update action (spec decision
 * 6). Preview responses are fenced by run order and judged current only
 * against the exact text that ran.
 */
export function CatalogWorkbench({
  listing,
  mapId,
  draft,
  onDraft,
  mode,
  savedSql,
  busy,
  error,
  onDismissError,
  errorMirrored = false,
  onCommit,
}: Props) {
  const editorHandle = useRef<SqlEditorHandle | null>(null);
  // A click that lands before the lazy editor chunk arrives writes the
  // draft only; the debt (focus, caret at end) settles on editor mount
  // (the click contract must survive the gap).
  const pendingStatementRef = useRef<string | null>(null);
  const settlePendingStatement = useCallback(() => {
    const pending = pendingStatementRef.current;
    pendingStatementRef.current = null;
    if (pending !== null) editorHandle.current?.replaceAll(pending);
  }, []);
  const [preview, setPreview] = useState<PreviewState>(IDLE_PREVIEW);
  const previewRef = useRef(preview);
  previewRef.current = preview;

  const runPreview = useCallback(
    (sqlText: string) => {
      const sql = sqlText.trim();
      if (sql === "") return;
      const [begun, seq] = beginPreview(previewRef.current);
      setPreview(begun);
      void (async () => {
        try {
          const response = await fetch("/api/query", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(previewRequest(sqlText, mapId)),
          });
          const outcome = response.ok
            ? {
                result: (await response.json()) as QueryResult,
                error: null as string | null,
              }
            : { result: null, error: await readApiError(response) };
          setPreview((s) =>
            settlePreview(s, {
              seq,
              sql: sqlText,
              result: outcome.result,
              error: outcome.error,
              ms: outcome.result?.runtimeMs ?? null,
            }),
          );
        } catch (e) {
          setPreview((s) =>
            settlePreview(s, {
              seq,
              sql: sqlText,
              result: null,
              error:
                e instanceof Error ? e.message : "The preview request failed.",
              ms: null,
            }),
          );
        }
      })();
    },
    [mapId],
  );

  const dirty =
    mode === "edit" && savedSql !== undefined
      ? draft.trim() !== savedSql.trim()
      : draft.trim() !== "";
  const currency = previewCurrency(preview, draft);
  const settled = preview.settled;
  // A preview refusal that Add or Update met too is said once, beside the
  // draft, where the action's outcome stands.
  const previewError = settled?.error != null && settled.error !== error ? settled.error : null;

  return (
    <div className={styles.workbench}>
      <div className={styles.wbEditorCol}>
        <div className={styles.wbBrowser}>
          <CatalogTableBrowser
            listing={listing}
            selected={null}
            onPick={(t) => {
              // A click means "start from this table" (gate
              // ruling): the whole statement, replacing the draft. The
              // handle round-trips onChange; before the lazy editor
              // mounts, the draft carries the text and the focus debt
              // settles on mount.
              // As the map's SQL types it: the workbench previews there.
              const statement = impliedQuery(listing.typed ? listing.typed(t) : t.qualifiedName);
              if (editorHandle.current !== null) {
                editorHandle.current.replaceAll(statement);
              } else {
                pendingStatementRef.current = statement;
                onDraft(statement);
              }
            }}
          />
        </div>
        <div className={styles.cmHost}>
          <SqlEditor
            value={draft}
            editable={!busy}
            hint="SELECT … a result with a geometry column becomes a layer; any result can be saved as a dataset"
            ariaLabel={mode === "edit" ? "Layer SQL query" : "New layer SQL"}
            onChange={onDraft}
            onRun={runPreview}
            handleRef={editorHandle}
            onReady={settlePendingStatement}
            wrap
          />
        </div>
        <div className={styles.runRow}>
          <button
            className={styles.ghostBtn}
            disabled={preview.running || draft.trim() === ""}
            onClick={() => runPreview(draft)}
          >
            {preview.running ? "Running…" : "Run preview"} <kbd>⌘⏎</kbd>
          </button>
          <button
            className={styles.primaryBtn}
            disabled={busy || !dirty}
            onClick={onCommit}
          >
            {busy
              ? mode === "edit"
                ? "Updating…"
                : "Adding…"
              : mode === "edit"
                ? "Update layer"
                : "Add layer"}
          </button>
          {mode === "edit" && dirty && !busy && (
            <span className={styles.dirtyMark}>edited</span>
          )}
        </div>
        {error !== null && (
          <ErrorNote
            message={error}
            onDismiss={errorMirrored ? undefined : onDismissError}
          />
        )}
      </div>
      <div className={styles.wbResultsCol}>
        {preview.running ? (
          <p className={styles.stateHint} role="status">
            <Spinner /> Running preview…
          </p>
        ) : settled === null ? null : settled.error !== null ? (
          previewError === null ? null : (
            <ErrorNote
              message={previewError}
              onDismiss={() =>
                setPreview((s) => ({ ...s, settled: null }))
              }
            />
          )
        ) : (
          <>
            {currency === "stale" && (
              <p className={styles.staleNote} role="status">
                Edited since this ran. The result below is no longer
                current.
              </p>
            )}
            {settled.result !== null && (
              <ResultGrid result={settled.result} fill maxRows={100} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
