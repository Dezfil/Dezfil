"use client";

import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { LayerExportFormat } from "@/lib/export/layer-export";
import type { ApiErrorBody, DataTable, TableListing } from "../api";
import { AddDataDialog } from "../AddDataDialog";
import { AddToMapDialog } from "../AddToMapDialog";
import { skippedNotice } from "../skipped-members";
import { Spinner } from "../Spinner";
import type { SqlEditorHandle } from "../sql-editor-handle";
import type { SqlPosition } from "../sql-editor-extensions";
import { useUploadQueue } from "../use-upload-queue";
import { ErrorNote } from "../ui/ErrorNote";
import { Tabs } from "../ui/Tabs";
import { DatabaseIcon, HistoryIcon, PlusIcon } from "../ui/icons";
import { ConsoleTableBrowser } from "./ConsoleTableBrowser";
import { HistoryList } from "./HistoryList";
import { ResultsPane, type QueryRun, type ResultsTab, type Shown } from "./ResultsPane";
import { SnippetsMenu } from "./SnippetsMenu";
import { locateNamed } from "./error-locate";
import { downloadResult } from "./sql-download";
import {
  applyAutomatic,
  isEdited,
  quoteIdentifier,
  starterSql,
} from "./sql-draft";
import {
  addRun,
  removeRun,
  validateHistory,
  type HistoryEntry,
} from "./sql-history";
import { referencedTables } from "../sql-editor-extensions";
import { SQL_KEYS, readStored, writeStored } from "./sql-storage";
import { useSchemaInventory } from "./use-schema-inventory";
import { useTableListing } from "./use-table-listing";
import { useConsoleSplits } from "./use-console-splits";
import { SqlAssistantHost, useSqlAssistant } from "./SqlAssistantHost";
import { executedSnapshot, failedSnapshot, sqlAssistantContext, sqlFacts, type SqlExecutionSnapshot } from "./assistant-context";
import { insertProposal } from "./insert-rule";
import styles from "./SqlConsole.module.css";
import { useHeaderReach } from "../shell/use-header-reach";
import { doorTable } from "../dataset-doors";

/* The shared editor, lazily loaded as every host loads it. */
const SqlEditor = dynamic(() => import("../SqlEditor"), {
  ssr: false,
  loading: () => <div className={styles.editorHost} />,
});

type PaneTab = "tables" | "history";
type View =
  | { kind: "empty" }
  | { kind: "preview" }
  | { kind: "result" }
  | { kind: "error"; code: string; message: string };

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Client-only: false on the server and during hydration's first pass,
 * true once mounted — the gate before anything remembered is read. */
const noop = () => () => {};
function useMounted(): boolean {
  return useSyncExternalStore(noop, () => true, () => false);
}

/**
 * The SQL console — one state owner for the draft and its automatic seed,
 * the selected table and its preview, the displayed execution, the
 * in-flight request, History and the remembered sizes. Hydration settles
 * before the Data Explorer door or any automatic action runs; every
 * execution carries an identity so a cancelled or superseded run can
 * neither replace the displayed result nor enter History.
 */
export function SqlConsole() {
  const mounted = useMounted();
  const listing = useTableListing();
  const tables = listing.state.status === "ready" ? listing.state.value : null;
  const inventory = useSchemaInventory(tables);

  /* The assistant, and the remembered sizes under it ---- */
  const assistant = useSqlAssistant();
  const { paneWidth, editorHeight, hydrate: hydrateSizes, startDrag } = useConsoleSplits(assistant.docked);
  const [hydrated, setHydrated] = useState(false);

  /* ---- the draft and its seed ---- */
  const [draft, setDraft] = useState("");
  const draftRef = useRef("");
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const [lastSeed, setLastSeed] = useState<string | null>(null);
  const seedRef = useRef<string | null>(null);
  useEffect(() => {
    seedRef.current = lastSeed;
  }, [lastSeed]);
  const [restored, setRestored] = useState(false);
  const editorRef = useRef<SqlEditorHandle | null>(null);
  const pendingInserts = useRef<string[]>([]);
  /* A replacement asked for before the editor mounted (the Data Explorer
     door on a cold navigation, with the editor's chunk still loading): it
     waits for the editor rather than overwriting the state the editor
     will initialise from, so the remembered draft is in the editor's
     history and undo can bring it back. */
  const pendingReplace = useRef<{ text: string; seed: string | null } | null>(null);
  const settleInserts = useCallback(() => {
    const handle = editorRef.current;
    if (!handle) return;
    const replace = pendingReplace.current;
    if (replace) {
      pendingReplace.current = null;
      handle.replaceAll(replace.text);
      draftRef.current = replace.text;
      setLastSeed(replace.seed);
      setRestored(false);
    }
    for (const text of pendingInserts.current.splice(0)) handle.insertAtCursor(text);
  }, []);
  const [selection, setSelection] = useState("");

  /* ---- selection, view, results ---- */
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "empty" });
  const [lastRun, setLastRun] = useState<QueryRun | null>(null);
  /** The last execution as the assistant hears it: the SQL that ran with
   * its own answer, taken at the run and never rebuilt. */
  const [lastExecution, setLastExecution] = useState<SqlExecutionSnapshot | null>(null);
  const [resultsTab, setResultsTab] = useState<ResultsTab>("table");
  const [errorAt, setErrorAt] = useState<SqlPosition | null>(null);
  const [status, setStatus] = useState<string>("");
  const [running, setRunning] = useState(false);
  const runId = useRef(0);
  const controller = useRef<AbortController | null>(null);

  /* ---- history ---- */
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [paneTab, setPaneTab] = useState<PaneTab>("tables");

  /* ---- dialogs ---- */
  const [mapSubject, setMapSubject] = useState<{ sql: string; name: string; label: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  // The header card reaches this pane's right edge, following the pane
  // as it is dragged wider or narrower.
  const paneRef = useRef<HTMLElement>(null);
  useHeaderReach(() => paneRef.current);

  /* ---- hydration: the remembered state, once, client-only ---- */
  if (mounted && !hydrated) {
    setHydrated(true);
    const stored = readStored<unknown>(SQL_KEYS.draft, null);
    // The draft is stored with the automatic seed it came from (a string
    // alone is the pre-seed shape): a restored untouched seed stays
    // replaceable, so the Data Explorer door is idempotent on reload.
    const storedDraft =
      typeof stored === "string"
        ? { text: stored, seed: null }
        : stored && typeof stored === "object" && typeof (stored as { text?: unknown }).text === "string"
          ? {
              text: (stored as { text: string }).text,
              seed:
                typeof (stored as { seed?: unknown }).seed === "string"
                  ? (stored as { seed: string }).seed
                  : null,
            }
          : null;
    if (storedDraft && storedDraft.text.trim()) {
      setDraft(storedDraft.text);
      setLastSeed(storedDraft.seed);
      setRestored(true);
    }
    setHistory(validateHistory(readStored<unknown>(SQL_KEYS.history, [])));
    hydrateSizes();
  }

  // The draft is remembered as it changes (debounced), never on the
  // server's pass.
  useEffect(() => {
    if (!hydrated) return;
    const t = setTimeout(
      () =>
        writeStored(
          SQL_KEYS.draft,
          draft.trim() ? { text: draft, seed: lastSeed } : null,
        ),
      250,
    );
    return () => clearTimeout(t);
  }, [draft, lastSeed, hydrated]);
  // Leaving — the route unmounting, or the page hiding — flushes what the
  // debounce may still be holding, so a keystroke followed by navigation
  // within the window is not the keystroke that gets lost.
  const hydratedRef = useRef(false);
  useEffect(() => {
    hydratedRef.current = hydrated;
  }, [hydrated]);
  useEffect(() => {
    const flush = () => {
      if (!hydratedRef.current) return;
      const text = draftRef.current;
      writeStored(SQL_KEYS.draft, text.trim() ? { text, seed: seedRef.current } : null);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);
  useEffect(() => {
    if (hydrated) writeStored(SQL_KEYS.history, history);
  }, [history, hydrated]);

  /* ---- execution ---- */
  const cancel = useCallback(() => {
    const c = controller.current;
    if (!c) return;
    c.abort();
    controller.current = null;
    runId.current += 1;
    setRunning(false);
    setStatus("Cancelled.");
  }, []);

  /** A 1-based line/column inside `fragment` (the text that was sent,
   * already trimmed) translated into the document's coordinates, given the
   * document and the offset at which the untrimmed fragment began. */
  const toDocumentPosition = useCallback(
    (
      doc: string,
      fragmentStart: number,
      leadingTrim: number,
      at: SqlPosition,
    ): SqlPosition => {
      const start = Math.min(doc.length, fragmentStart + leadingTrim);
      const before = doc.slice(0, start);
      const baseLine = before.split("\n").length;
      const baseColumn = start - (before.lastIndexOf("\n") + 1) + 1;
      return at.line === 1
        ? { line: baseLine, column: baseColumn + at.column - 1 }
        : { line: baseLine + at.line - 1, column: at.column };
    },
    [],
  );

  const execute = useCallback(
    async (
      sql: string,
      meta?: { selection?: boolean; doneMsg?: string; from?: number },
    ) => {
      const trimmed = sql.trim();
      if (!trimmed) return;
      // Where the sent text sits in the document, for error positions.
      const fragmentStart = meta?.from ?? 0;
      const leadingTrim = sql.length - sql.trimStart().length;
      if (controller.current) cancel();
      const id = ++runId.current;
      const c = new AbortController();
      controller.current = c;
      setRunning(true);
      setErrorAt(null);
      setStatus("");
      const at = new Date().toISOString();
      try {
        const response = await fetch("/api/query", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sql: trimmed, geometry: "geojson" }),
          signal: c.signal,
        });
        const body = (await response.json()) as QueryRun | ApiErrorBody;
        if (id !== runId.current) return;
        const tables = referencedTables(trimmed, Object.keys(inventory.completion.tables));
        if (!response.ok) {
          const err = (body as ApiErrorBody).error;
          setView({ kind: "error", code: err.code, message: err.message });
          setLastExecution(failedSnapshot(trimmed, err.code, err.message));
          const inFragment = err.position ?? locateNamed(trimmed, err.message);
          setErrorAt(
            inFragment
              ? toDocumentPosition(draftRef.current, fragmentStart, leadingTrim, inFragment)
              : null,
          );
          setHistory((h) =>
            addRun(h, { id: newId(), sql: trimmed, at, ok: false, rows: 0, ms: 0, code: err.code, tables }),
          );
        } else {
          const run = { ...(body as QueryRun), sql: trimmed, runId: id };
          setLastRun(run);
          setLastExecution(executedSnapshot(trimmed, run));
          setView({ kind: "result" });
          setHistory((h) =>
            addRun(h, { id: newId(), sql: trimmed, at, ok: true, rows: run.rowCount, ms: run.runtimeMs, code: null, tables }),
          );
          setStatus(meta?.doneMsg ?? (meta?.selection ? "Ran the selection only." : ""));
        }
      } catch {
        if (c.signal.aborted || id !== runId.current) return;
        const message = "Could not reach the server.";
        setView({ kind: "error", code: "internal", message });
        // The assistant hears this failure too, paired with the SQL that
        // met it: the snapshot never keeps
        // an earlier success under a newer failure.
        setLastExecution(failedSnapshot(trimmed, "internal", message));
      } finally {
        if (id === runId.current) {
          setRunning(false);
          controller.current = null;
        }
      }
    },
    [cancel, inventory.completion.tables, toDocumentPosition],
  );

  /* ---- the snippets' writes, under the ownership rule (Open as SQL
     left the rule behind) ---- */
  const writeAutomatic = useCallback(
    (statement: string) => {
      // A newer state-level write supersedes a replacement still queued
      // for the editor's mount: the user's later action wins.
      pendingReplace.current = null;
      const w = applyAutomatic(draft, lastSeed, statement);
      setDraft(w.text);
      draftRef.current = w.text;
      setLastSeed(w.replaced ? statement : lastSeed);
      setRestored(false);
      return w;
    },
    [draft, lastSeed],
  );

  /* An explicit replacement of the draft — Open as SQL, the door, a
     History card: through the editor's handle, so it is
     one undoable change and Mod-Z brings the old draft back; before the
     editor is mounted it is queued for the editor's ready signal. */
  const replaceDraft = useCallback((text: string, seed: string | null) => {
    if (!editorRef.current) {
      pendingReplace.current = { text, seed };
      return;
    }
    editorRef.current.replaceAll(text);
    draftRef.current = text;
    setLastSeed(seed);
    setRestored(false);
  }, []);

  /* Open as SQL: afterwards the editor holds exactly the statement that
     ran, and nothing else. */
  const openAsSql = useCallback(
    (t: TableListing, opts?: { door?: boolean }) => {
      setSelected(t.name);
      // The SQL names the dataset as its reader types it, so someone else's
      // `roads` opens as theirs.
      const stmt = starterSql(t.qualifiedName);
      replaceDraft(stmt, stmt);
      // The door's sentence rides the run's completion, so the run's own
      // settling cannot overwrite it.
      const doneMsg = opts?.door ? `Opened from Data: ${t.qualifiedName}.` : "";
      void execute(stmt, { doneMsg, from: 0 });
    },
    [replaceDraft, execute],
  );

  const insertAtCursor = useCallback((text: string) => {
    if (editorRef.current) editorRef.current.insertAtCursor(text);
    else pendingInserts.current.push(text);
  }, []);

  /* The assistant's Insert into editor: one
     undoable editor write, replacing an unchanged draft or appending the
     proposal selected under a changed one; it executes nothing. */
  const insertFromAssistant = useCallback((sql: string, originDraft: string) => {
    const write = insertProposal(draftRef.current, originDraft, sql);
    pendingReplace.current = null;
    if (editorRef.current) editorRef.current.replaceAllSelecting(write.text, write.from, write.to);
    else pendingReplace.current = { text: write.text, seed: null };
    draftRef.current = write.text;
    setLastSeed(null);
    setRestored(false);
    return write.outcome;
  }, []);

  /* Activation selects and previews: no unfold, and a
     second activation changes nothing. */
  const activate = useCallback((t: TableListing) => {
    setSelected(t.name);
    setView({ kind: "preview" });
    setErrorAt(null);
  }, []);

  /* ---- the Data Explorer door, once the listing is here ---- */
  const doorDone = useRef(false);
  const openAsSqlRef = useRef(openAsSql);
  useEffect(() => {
    openAsSqlRef.current = openAsSql;
  }, [openAsSql]);
  useEffect(() => {
    if (!hydrated || !tables || doorDone.current) return;
    const t = doorTable(tables, new URLSearchParams(window.location.search).get("table"));
    doorDone.current = true;
    if (!t) return;
    // Deferred a tick: the door is an action, not a render adjustment, and
    // it runs against the callbacks current once the listing has landed.
    const timer = setTimeout(() => openAsSqlRef.current(t, { door: true }), 0);
    return () => clearTimeout(timer);
  }, [hydrated, tables]);

  /* ---- keyboard: ⌘K focuses the table search ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaneTab("tables");
        setTimeout(() => searchRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---- add data (the existing dialog), refresh on completion ---- */
  const uploadQueue = useUploadQueue({
    onFileImported: () => listing.refresh(),
    onListingStale: () => listing.refresh(),
    onSettled: () => listing.refresh(),
  });
  const onTableCreated = useCallback(
    (t: DataTable) => {
      listing.refresh();
      inventory.invalidate(t.name);
      setAddOpen(false);
      setImportNote(`${t.name} is ready.`);
    },
    [listing, inventory],
  );
  useEffect(() => {
    if (!importNote) return;
    const t = setTimeout(() => setImportNote(null), 6000);
    return () => clearTimeout(t);
  }, [importNote]);

  /* ---- what the results area shows ---- */
  const selectedTable = useMemo(
    () => (tables && selected ? tables.find((t) => t.name === selected) ?? null : null),
    [tables, selected],
  );
  const shown: Shown = useMemo(() => {
    if (view.kind === "preview" && selectedTable) {
      return { kind: "preview", table: selectedTable, schema: inventory.get(selectedTable.name), hasResult: lastRun !== null };
    }
    if (view.kind === "result" && lastRun) return { kind: "result", run: lastRun };
    if (view.kind === "error") return { kind: "error", code: view.code, message: view.message };
    return { kind: "empty" };
  }, [view, selectedTable, inventory, lastRun]);

  const edited = isEdited(draft, lastSeed);
  const geometryOf = useCallback(
    (name: string) => {
      const table = tables?.find((candidate) => candidate.name === name);
      return table
        ? {
            geometryType: table.geometryType,
            geometryColumn: table.geometryColumn,
          }
        : undefined;
    },
    [tables],
  );
  const selectedGeometry = selectedTable
    ? (() => {
        const e = inventory.get(selectedTable.name);
        return e?.status === "ready" ? e.schema.geometryColumn : selectedTable.geometryColumn;
      })()
    : null;

  const cssVars = {
    "--sql-pane": `${paneWidth}px`,
    "--sql-editor": `${editorHeight}px`,
    "--sql-assistant": `${assistant.offset}px`,
  } as React.CSSProperties;

  return (
    <div className={styles.console} style={cssVars} data-sql-console="" data-assistant-docked={assistant.docked || undefined}>
      <SqlAssistantHost
        assistant={assistant}
        context={sqlAssistantContext(draft, selection, lastExecution)}
        facts={sqlFacts(draft, edited, lastExecution)}
        onInsert={insertFromAssistant}
        // A resolved run that declared writes re-reads the tables: a builder action parked under
        // its full policy may have added or deleted one.
        onMutate={listing.refresh}
      />
      <aside ref={paneRef} className={styles.pane} aria-label="Sources and history">
        <Tabs
          group="sql-pane"
          label="Sources and history"
          className={styles.paneTabs}
          fill
          value={paneTab}
          onChange={setPaneTab}
          tabs={[
            {
              value: "tables" as const,
              name: "Sources",
              label: (
                <>
                  <DatabaseIcon />
                  Sources
                  {tables && <span className={styles.tabCount}>{tables.length}</span>}
                </>
              ),
            },
            {
              value: "history" as const,
              name: "History",
              label: (
                <>
                  <HistoryIcon />
                  History
                  <span className={styles.tabCount}>{history.length}</span>
                </>
              ),
            },
          ]}
        />
        <div className={styles.paneBody}>
          {paneTab === "tables" && (
            <>
              {listing.state.status === "pending" && (
                <div className={styles.browserState}>
                  <span className={styles.status}>
                    <Spinner /> Reading your tables…
                  </span>
                </div>
              )}
              {listing.state.status === "failed" && (
                <div className={styles.browserState}>
                  <ErrorNote message={listing.state.error} onRetry={listing.retry} />
                </div>
              )}
              {listing.state.status === "ready" && listing.state.value.length === 0 && (
                <p className={styles.browserEmpty}>
                  No tables yet. Add data below to query.
                </p>
              )}
              {tables && tables.length > 0 && (
                <ConsoleTableBrowser
                  tables={tables}
                  columnsOf={inventory.columnsOf}
                  selected={selected}
                  onActivate={activate}
                  onOpenAsSql={openAsSql}
                  onInsertTable={(t) => insertAtCursor(quoteIdentifier(t.name))}
                  progress={inventory.progress}
                  searchRef={searchRef}
                />
              )}
            </>
          )}
          {paneTab === "history" && (
            <HistoryList
              entries={history}
              geometryOf={geometryOf}
              onLoad={(sql) => {
                replaceDraft(sql, null);
                setStatus("");
              }}
              onRun={(sql) => {
                replaceDraft(sql, null);
                void execute(sql);
              }}
              onRemove={(id) => setHistory((h) => removeRun(h, id))}
              onClear={() => setHistory([])}
            />
          )}
        </div>
        <div className={styles.paneFoot}>
          <button
            type="button"
            className={styles.addData}
            onClick={() => setAddOpen(true)}
            title="Upload a file or import from a source"
          >
            <PlusIcon /> Add data
          </button>
          {importNote && (
            <p className={styles.footNote} role="status">
              {importNote}
            </p>
          )}
        </div>
      </aside>

      <div
        className={styles.vsplit}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the tables pane"
        title="Drag to resize"
        onMouseDown={(e) => startDrag("x", e)}
      />

      <div className={styles.work}>
        <section className={styles.editorCard} aria-label="Editor">
          <div className={styles.editorHost}>
            <SqlEditor
              value={draft}
              editable
              hint="SELECT * FROM your_table LIMIT 100;"
              ariaLabel="SQL editor"
              handleRef={editorRef}
              onReady={settleInserts}
              onChange={(text) => {
                setDraft(text);
                setRestored(false);
              }}
              onRun={(text, meta) =>
                void execute(text, { selection: meta?.selection, from: meta?.from ?? 0 })
              }
              completion={inventory.completion}
              runSelection
              errorAt={errorAt}
              onSelectionChange={setSelection}
            />
          </div>
          <div className={styles.editorBar}>
            <SnippetsMenu
              context={{ table: selected, geometryColumn: selectedGeometry }}
              onPick={(sql) => {
                writeAutomatic(sql);
                setLastSeed(sql);
                setStatus("");
              }}
            />
            <span className={styles.kbd}>
              ⌘/Ctrl + Enter runs · a selection runs alone · ⌘K tables · ⌘/ comment · Ctrl + Space completes
            </span>
            <span className={styles.status} role="status">
              {running && <Spinner />}
              {running ? "Running…" : status}
              {!running && restored && (
                <>
                  Restored your last draft.{" "}
                  <button
                    type="button"
                    className={styles.linkBtn}
                    onClick={() => {
                      pendingReplace.current = null;
                      setDraft("");
                      draftRef.current = "";
                      setLastSeed(null);
                      setRestored(false);
                      writeStored(SQL_KEYS.draft, null);
                    }}
                  >
                    Clear
                  </button>
                </>
              )}
            </span>
            <span className={styles.spacer} />
            {edited && <span className={styles.edited}>edited</span>}
            <button
              type="button"
              className={styles.ghostBtn}
              title="Clear the editor"
              onClick={() => {
                pendingReplace.current = null;
                setDraft("");
                setLastSeed(null);
                setRestored(false);
                setErrorAt(null);
                setStatus("");
                writeStored(SQL_KEYS.draft, null);
              }}
            >
              Clear
            </button>
            <button
              type="button"
              className={styles.runBtn}
              data-cancel={running || undefined}
              onClick={() => {
                if (running) {
                  cancel();
                  return;
                }
                const range = editorRef.current?.getSelectionRange() ?? null;
                const sel = range ? draft.slice(range.from, range.to) : "";
                void execute(sel.trim() ? sel : draft, {
                  selection: !!sel.trim(),
                  from: sel.trim() && range ? range.from : 0,
                });
              }}
            >
              {running ? "Cancel" : selection.trim() ? "Run selection" : "Run query"}
            </button>
          </div>
        </section>

        <div
          className={styles.hsplit}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the editor"
          title="Drag to resize"
          onMouseDown={(e) => startDrag("y", e)}
        />

        <ResultsPane
          shown={shown}
          busy={running}
          tab={resultsTab}
          onTab={setResultsTab}
          draft={draft}
          onOpenAsSql={openAsSql}
          onRetrySchema={inventory.invalidate}
          onBackToResult={() => setView({ kind: "result" })}
          onDismissError={() => setView(lastRun ? { kind: "result" } : { kind: "empty" })}
          onAddToMap={setMapSubject}
          onSaved={(name) => {
            listing.refresh();
            inventory.invalidate(name);
          }}
          onDownload={(format: LayerExportFormat) =>
            lastRun ? downloadResult(lastRun.sql, format, "query_result") : Promise.resolve()
          }
        />
      </div>

      <AddToMapDialog
        key={mapSubject ? mapSubject.sql : "closed"}
        subject={mapSubject}
        onClose={() => setMapSubject(null)}
      />
      <AddDataDialog
        open={addOpen}
        onClose={() => {
          uploadQueue.dismiss();
          setAddOpen(false);
        }}
        onTableCreated={onTableCreated}
        onPostgisTableCreated={(table) => {
          listing.refresh();
          inventory.invalidate(table.name);
        }}
        onSkipped={(s) => setImportNote(s.length ? skippedNotice(s) : null)}
        uploadQueue={uploadQueue}
      />
    </div>
  );
}
