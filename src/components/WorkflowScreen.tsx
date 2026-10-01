"use client";

import dynamic from "next/dynamic";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useEffect,
} from "react";
import { createPortal } from "react-dom";
import { readApiError, readOperations, readTables } from "./api";
import { serverUnreachable } from "./failure-copy";
import { AddDataDialog } from "./AddDataDialog";
import { AsyncState, useAsync } from "./ui/AsyncState";
import type { HistoryChrome } from "./workflow-canvas/WorkflowCanvas";
import { useUploadQueue } from "./use-upload-queue";
import { canvasGraph } from "./workflow-canvas/graph";
import type { LayoutRead } from "./workflow-canvas/placement";
import { savedWhisper, type Whisper } from "./workflow-canvas/save-whisper";
import type { SaveState } from "./workflow-canvas/use-layout-saves";
import { useRecipeEdits } from "./workflow-canvas/use-recipe-edits";
import { overlayFor } from "./workflow-canvas/run-overlay";
import {
  useWorkflowRun,
} from "./workflow-canvas/use-workflow-run";
import { RunDock } from "./workflow-canvas/RunDock";
import { RunConfirmDialog, rowsFromGraph } from "./workflow-canvas/RunConfirmDialog";
import { useRunConfirm } from "./workflow-canvas/use-run-confirm";
import { useWorkflowAssistant } from "./workflow-canvas/WorkflowAssistantHost";
import { HeaderHistory } from "./workflow-canvas/HeaderHistory";
import { ViewOnly } from "./workflow-canvas/view-only";
import type { WorkflowListing } from "./workflow-model";
import { usePathname } from "next/navigation";
import { contributePath, releasePath } from "@/components/shell/path-model";
import styles from "./WorkflowScreen.module.css";
import { PathOwnerMark } from "./sharing/PeopleMarks";
import type { PersonLabel } from "./sharing/people";

/**
 * A workflow's page: the shell crumb carries its name, renamed inline as a
 * map is in the builder; the body is the canvas over the recipe and its
 * layout document. The four reads the canvas draws from — the recipe, the
 * layout, the tables list and the catalog — are one read with one Retry,
 * so pending, failed and content stay exclusive and nothing is written on
 * the way. The canvas library loads here and nowhere else.
 */

const WorkflowCanvas = dynamic(
  () =>
    import("./workflow-canvas/WorkflowCanvas").then((m) => m.WorkflowCanvas),
  { ssr: false, loading: () => null },
);

const subscribeNever = () => () => {};
const NAME_MAX = 120;

async function fetchWorkflow(id: string): Promise<WorkflowListing> {
  let response: Response;
  try {
    response = await fetch(`/api/recipes/${id}`, { cache: "no-store" });
  } catch {
    throw new Error(serverUnreachable("load the workflow"));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  return ((await response.json()) as { recipe: WorkflowListing }).recipe;
}

async function fetchLayout(id: string): Promise<LayoutRead> {
  let response: Response;
  try {
    response = await fetch(`/api/recipes/${id}/layout`, { cache: "no-store" });
  } catch {
    throw new Error(serverUnreachable("load the workflow's layout"));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  return ((await response.json()) as { layout: LayoutRead }).layout;
}

interface PageRead {
  recipe: WorkflowListing;
  layout: LayoutRead;
  tables: Awaited<ReturnType<typeof readTables>>;
  operations: Awaited<ReturnType<typeof readOperations>>;
}

/** The crumb tail carries the path and nothing else: the
 * whisper, owned by whoever last spoke — a rename, a layout or recipe
 * save, a stopped import — is drawn on the canvas's own stage, and the
 * card no longer keeps its margin. */

export function CrumbName({
  name,
  owner,
  onRename,
  readOnly = false,
}: {
  name: string;
  /** The workflow's owner: named beside it when it is someone else's. */
  owner?: PersonLabel | null;
  onRename: (next: string) => void;
  /** A Viewer's page: the name, no rename. */
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  // Escape abandons a rename in progress; the blur that follows must not
  // commit the draft (the builder's rule, found during verification).
  const cancelled = useRef(false);
  if (readOnly) {
    return (
      <span className={styles.crumbTail}>
        <span className={styles.crumbSep}>/</span>
        <span className={styles.plainName}>{name}</span>
        <PathOwnerMark owner={owner} />
      </span>
    );
  }
  return (
    <span className={styles.crumbTail}>
      <span className={styles.crumbSep}>/</span>
      {editing ? (
        <input
          className={styles.nameInput}
          value={value}
          autoFocus
          maxLength={NAME_MAX}
          aria-label="Workflow name"
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            setEditing(false);
            const next = value.trim();
            if (!cancelled.current && next && next !== name) onRename(next);
            cancelled.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              cancelled.current = true;
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <button
          className={styles.name}
          title={`Rename ${name}`}
          onClick={() => {
            setValue(name);
            setEditing(true);
          }}
        >
          {name}
        </button>
      )}
      <PathOwnerMark owner={owner} />
    </span>
  );
}

export function WorkflowScreen({
  id,
  viewOnly = false,
}: {
  id: string;
  /** A Viewer's page, decided by the page from their standing: the
   * canvas is view-only and nothing on the page edits or runs. */
  viewOnly?: boolean;
}) {
  const load = useCallback(async (): Promise<PageRead> => {
    const [recipe, layout, tables, operations] = await Promise.all([
      fetchWorkflow(id),
      fetchLayout(id),
      readTables(),
      readOperations(),
    ]);
    return { recipe, layout, tables, operations };
  }, [id]);
  const { state, retry } = useAsync<PageRead>(load, `workflow:${id}`);
  // The live state: the first read seeds it; every accepted change
  // re-reads the recipe, an import re-reads the tables, a layout write
  // replaces the layout. The recipe's state is always the API's.
  const [live, setLive] = useState<PageRead | null>(null);
  // Seeded from the read as it lands, adjusted during render. Keyed on
  // the read's value, not the state object: the hook rebuilds that object
  // each render, and keying on it re-seeded for ever (the its error
  // screen on the first field run).
  const seedKey: unknown =
    state.status === "ready" ? state.value : state.status;
  const [seeded, setSeeded] = useState<unknown>(undefined);
  if (seeded !== seedKey) {
    setSeeded(seedKey);
    if (state.status === "ready") setLive(state.value);
    else if (state.status === "failed") setLive(null);
  }
  // Every accepted change re-reads the recipe; only the newest read lands,
  // so two edits' refreshes cannot put an older snapshot on screen last.
  const refreshSeq = useRef(0);
  const latestRecipeRead = useRef<Promise<boolean> | null>(null);
  const refreshRecipe = useCallback(async (): Promise<boolean> => {
    const mine = ++refreshSeq.current;
    const read = (async () => {
      try {
        const recipe = await fetchWorkflow(id);
        if (mine !== refreshSeq.current) return false;
        setLive((l) => (l ? { ...l, recipe } : l));
        return true;
      } catch {
        // The next accepted change re-reads again; the canvas keeps what it has.
        return false;
      }
    })();
    latestRecipeRead.current = read;
    const landed = await read;
    // Superseded by a newer read: its landing is the answer.
    if (!landed && mine !== refreshSeq.current && latestRecipeRead.current) return latestRecipeRead.current;
    return landed;
  }, [id]);
  const onLayoutWritten = useCallback((layout: LayoutRead) => {
    setLive((l) => (l ? { ...l, layout } : l));
  }, []);
  // Add data: the workspace's dialog, its upload queue owned here so a
  // closed dialog never orphans a file on the way; a table it brings in
  // joins the pane and lands on the canvas as a loose source, the recipe
  // untouched.
  const [addDataOpen, setAddDataOpen] = useState(false);
  const [addSourceRequest, setAddSourceRequest] = useState<{
    names: string[];
    seq: number;
  } | null>(null);
  const importSeq = useRef(0);
  // Only the newest tables read lands, as the recipe's does.
  const tablesSeq = useRef(0);
  const latestTablesRead = useRef<Promise<boolean> | null>(null);
  const refreshTables = useCallback(async (): Promise<boolean> => {
    const mine = ++tablesSeq.current;
    const read = (async () => {
      try {
        const tables = await readTables();
        if (mine !== tablesSeq.current) return false;
        setLive((l) => (l ? { ...l, tables } : l));
        return true;
      } catch {
        // The next import re-reads again.
        return false;
      }
    })();
    latestTablesRead.current = read;
    const landed = await read;
    if (!landed && mine !== tablesSeq.current && latestTablesRead.current) return latestTablesRead.current;
    return landed;
  }, []);
  // One request per import, carrying every table it brought (a container
  // can hold several): the canvas places each as a loose source.
  const onTablesCreated = useCallback(
    (tables: { name: string }[]) => {
      void refreshTables();
      importSeq.current += 1;
      setAddSourceRequest({
        names: tables.map((t) => t.name),
        seq: importSeq.current,
      });
    },
    [refreshTables],
  );
  const uploadQueue = useUploadQueue({
    onFileImported: (tables) => onTablesCreated(tables),
    onListingStale: () => void refreshTables(),
  });
  const [renamed, setRenamed] = useState<string | null>(null);
  const [whisper, setWhisper] = useState<Whisper | null>(null);
  // The record's two buttons, in the header beside the theme toggle as the
  // builder's are (word after, -08-29); the canvas reports what they read
  // and hands the press.
  const [history, setHistory] = useState<HistoryChrome | null>(null);
  const onHistory = useCallback((state: HistoryChrome) => setHistory(state), []);
  const mounted = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
  const crumbSlot = mounted
    ? document.getElementById("header-crumb-slot")
    : null;
  // The run chrome stands at the header's right corner, past the theme
  // toggle.
  const actionSlot = mounted
    ? document.getElementById("header-actions-right")
    : null;
  // The header's left slot, before the theme toggle: Undo and Redo.
  const historySlot = mounted
    ? document.getElementById("header-actions-left")
    : null;

  // A timer clears only the message its owner set: a rename's "Saved"
  // fading out must not take a layout failure and its Retry with it. One
  // timer per owner: a "Saved" that follows another within the fade would
  // otherwise be cleared by the earlier one's timer.
  const clearTimers = useRef<Partial<Record<Whisper["owner"], number>>>({});
  /** An owner's pending fade, dropped: the message it was to clear has
   * been replaced by a newer one of that owner's that must stand. Without
   * this, a "Saved" fading out takes the *next* write's "Couldn't save"
   * and its Retry with it, and the reader is left with a failed save and
   * no way to send it again (seen deterministically once the record's
   * writes began interleaving with the delayed saves). */
  const stopClear = useCallback((owner: Whisper["owner"]) => {
    const pending = clearTimers.current[owner];
    if (pending === undefined) return;
    window.clearTimeout(pending);
    delete clearTimers.current[owner];
  }, []);
  const clearLater = useCallback(
    (owner: Whisper["owner"], after: number) => {
      stopClear(owner);
      clearTimers.current[owner] = window.setTimeout(() => {
        delete clearTimers.current[owner];
        setWhisper((w) => (w?.owner === owner ? null : w));
      }, after);
    },
    [stopClear],
  );

  // Closing Add data settles the host-owned queue as the Data screen
  // does: what has not started stops and is named, a settled batch's
  // display is dropped, nothing keeps importing invisibly.
  const closeAddData = useCallback(() => {
    setAddDataOpen(false);
    const stopped = uploadQueue.dismiss();
    if (stopped > 0) {
      setWhisper({
        owner: "import",
        text:
          stopped === 1
            ? "Stopped. 1 queued file was not started."
            : `Stopped. ${stopped} queued files were not started.`,
      });
      clearLater("import", 4000);
    }
    if (uploadQueue.current().settled) uploadQueue.reset();
  }, [uploadQueue, clearLater]);

  const rename = useCallback(
    async (next: string) => {
      setWhisper({ owner: "rename", text: "Saving…" });
      try {
        const response = await fetch(`/api/recipes/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: next }),
        });
        if (!response.ok) throw new Error(await readApiError(response));
        setRenamed(next);
        setWhisper({ owner: "rename", text: "Saved" });
        clearLater("rename", 1400);
      } catch (e) {
        setWhisper({
          owner: "rename",
          text: e instanceof Error ? e.message : "Couldn’t save",
          tone: "bad",
        });
        clearLater("rename", 4000);
      }
    },
    [clearLater, id],
  );

  const recipeFailure = useRef<() => SaveState | null>(() => null);
  const whisperFor = useCallback(
    (owner: "layout" | "recipe") => (next: SaveState) => {
      if (next.kind === "saving") {
        stopClear(owner);
        setWhisper({ owner, text: "Saving…" });
      } else if (next.kind === "saved") {
        // A success never clears another owner's standing failure.
        setWhisper((w) =>
          savedWhisper(w, owner, recipeFailure.current()),
        );
        if (recipeFailure.current()?.kind === "failed") stopClear(owner);
        else clearLater(owner, 1400);
      } else {
        stopClear(owner);
        setWhisper({
          owner,
          text: "Couldn’t save",
          tone: "bad",
          action: { label: "Retry", run: next.retry },
        });
      }
    },
    [clearLater, stopClear],
  );
  const onSaveState = useMemo(() => whisperFor("layout"), [whisperFor]);
  const onEditState = useMemo(() => whisperFor("recipe"), [whisperFor]);
  const edits = useRecipeEdits({
    id,
    onState: onEditState,
    onAccepted: refreshRecipe,
  });
  useEffect(() => { recipeFailure.current = edits.drafts?.failure ?? (() => null); }, [edits]);
  // The workflow's runs: one owner for the list, the run in flight and
  // its polling; the tiles wear its words through the graph.
  const runPorts = useMemo(
    () => ({
      settle: edits.settled,
      onRecipeChanged: refreshRecipe,
      onTablesChanged: refreshTables,
      onRunSeen: () => undefined,
    }),
    [edits, refreshRecipe, refreshTables],
  );
  const runner = useWorkflowRun(id, runPorts);
  // The assistant's door and open state: the door follows Undo and Redo in the header's left
  // group; the pane is the canvas's to mount, closed on every page open. A run resolved from
  // the pane that declared writes re-reads the recipe, the tables and the runs: a builder
  // action parked under its full policy may have touched this workflow.
  const onAssistantMutate = useCallback(() => {
    void refreshRecipe();
    void refreshTables();
    void runner.observe();
  }, [refreshRecipe, refreshTables, runner]);
  const assistant = useWorkflowAssistant(onAssistantMutate);
  const runOverlay = runner.state.overlaid
    ? overlayFor(runner.state.active)
    : null;
  // The start flow (behaviours 1, 4, 9) lives in the shared owner; the
  // guard and the pre-re-plan read stay this screen's.
  const {
    confirm,
    refusal,
    confirming,
    askRun,
    confirmRun,
    closeConfirm,
    dismissRefusal,
  } = useRunConfirm({
      runner,
      guard: () =>
        !live || live.recipe.steps.length === 0
          ? "Nothing to run yet. Add a node first."
          : null,
      onPlanChanged: refreshRecipe,
    });
  const page = live;
  const name = renamed ?? page?.recipe.name ?? "";
  // The shell's path model: the canvas contributes its name and
  // membership; nothing renders while the page is unloaded.
  const canvasPath = usePathname();
  useEffect(() => {
    if (!page) return;
    contributePath(canvasPath, {
      name,
      projectId: page.recipe.projectId,
    });
    return () => releasePath(canvasPath);
  }, [canvasPath, page, name]);
  const graph = useMemo(
    () =>
      page
        ? canvasGraph({
            steps: page.recipe.steps,
            layout: page.layout,
            tables: page.tables,
            operations: page.operations,
            run: runOverlay,
          })
        : null,
    [page, runOverlay],
  );

  return (
    <ViewOnly value={viewOnly}>
    <div className={styles.screen} data-workflow-frame data-view-only={viewOnly || undefined}>
      {crumbSlot &&
        page &&
        createPortal(
          <CrumbName name={name} owner={page.recipe.owner} onRename={(n) => void rename(n)} readOnly={viewOnly} />,
          crumbSlot,
        )}
      {historySlot &&
        page &&
        graph &&
        history &&
        createPortal(
          <HeaderHistory history={history} assistant={assistant} />,
          historySlot,
        )}
      {actionSlot &&
        page &&
        graph &&
        createPortal(
          <RunDock
            runner={runner}
            refusal={refusal}
            onRunAll={() => void askRun(null)}
            onDismissRefusal={dismissRefusal}
          />,
          actionSlot,
        )}
      {confirm && graph ? (
        <RunConfirmDialog
          plan={confirm.plan}
          from={confirm.from?.label ?? null}
          rows={rowsFromGraph(confirm.plan.members, graph)}
          notice={confirm.notice}
          busy={confirming}
          onConfirm={() => void confirmRun()}
          onClose={() => {
            if (!confirming) closeConfirm();
          }}
        />
      ) : null}
      <AsyncState
        state={state}
        onRetry={retry}
        pendingLabel="Reading the workflow…"
      >
        {() =>
          page && graph ? (
            <WorkflowCanvas
              key={id}
              id={id}
              graph={graph}
              layout={page.layout}
              tables={page.tables}
              operations={page.operations}
              onSaveState={onSaveState}
              onEditState={onEditState}
              onHistory={onHistory}
              onLayoutWritten={onLayoutWritten}
              edits={edits}
              onAddData={() => setAddDataOpen(true)}
              addSourceRequest={addSourceRequest}
              runner={runner}
              onRunFrom={(from) => void askRun(from)}
              onListingStale={() => void refreshTables()}
              whisper={whisper}
              assistant={assistant}
              recipeName={name}
            />
          ) : null
        }
      </AsyncState>
      <AddDataDialog
        open={addDataOpen}
        onClose={closeAddData}
        onTableCreated={(table) => {
          onTablesCreated([table]);
          closeAddData();
        }}
        onPostgisTableCreated={(table) => onTablesCreated([table])}
        uploadQueue={uploadQueue}
      />
    </div>
    </ViewOnly>
  );
}
