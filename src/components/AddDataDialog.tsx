"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { DataTable } from "./api";
import type { SkippedMember } from "./skipped-members";
import { OverturePane } from "./OverturePane";
import { OsmPane } from "./OsmPane";
import { PostgisPane } from "./connections/PostgisPane";
import { useProjectName } from "./shell/use-project-name";
import type { MiniViewport } from "./MiniMap";
import type { UploadQueue } from "./use-upload-queue";
import { IMPORT_SOURCES, SourceNavButton } from "./SourceNav";
import { AddDataFilesPane, type FileTab } from "./AddDataFilesPane";
import { ColumnMatchingStep } from "./column-matching/ColumnMatchingStep";
import type { MatchingStep, MatchingStepState, StepOutcome } from "./column-matching/matching-step";
import { stepTable } from "./column-matching/needs-step";
import { useMatchingStep } from "./column-matching/use-matching-step";
import { useUrlHold } from "./column-matching/use-url-hold";
import { useStorageFullLine } from "./use-instance-rules";
import { Dialog } from "./ui/Dialog";
import { IconButton } from "./ui/IconButton";
import { XIcon } from "./ui/icons";
import styles from "./AddDataDialog.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Fires after any source lands a table; the dialog closes itself. */
  onTableCreated: (table: DataTable) => void;
  /** PostGIS publishes without closing so its terminal state remains in
   * the dialog. The host still refreshes its own table inventory. */
  onPostgisTableCreated: (table: DataTable) => void;
  /** Container members the import skipped — fires
   * before the first created table, because that table closes and unmounts
   * this dialog; the parent owns the notice. */
  onSkipped?: (skipped: SkippedMember[]) => void;
  /** The host-owned file batch: the queue outlives this
   * dialog, so closing never orphans the request in flight — and a
   * drop-anywhere batch is already running when the dialog opens. */
  uploadQueue: UploadQueue;
  /** Where map-based sources start — the builder seeds its viewport. */
  initialViewport?: MiniViewport | null;
  /** A connection-page handoff opens the existing PostGIS pane directly
   * on that saved connection's catalogue. */
  initialPostgisConnectionId?: string | null;
  /** The project every import made here lands in, by the catalog's road:
   * the panes carry it at their request boundaries;
   * the upload road rides the host's queue, created with the same
   * scope. Absent, imports land unfiled (the Data page). */
  projectId?: string | null;
  /** The host-owned name for the destination sentence;
   * the shell's cached directory backstops it. */
  projectName?: string | null;
}

type SourceKey = "files" | "overture" | "osm" | "postgis";

/**
 * A pending column-matching step's pane: the header naming the step and
 * the file, then the frame, in the Files pane's place. The step itself
 * is the dialog body's, which keeps it while the person is on another
 * source (the placeholder: not shown there, not resolved), so
 * the draft survives the round trip.
 */
function StepPane({
  file,
  waiting,
  close,
  state,
  step,
}: {
  file: string;
  waiting: readonly string[];
  close: React.ReactNode;
  state: MatchingStepState;
  step: MatchingStep;
}) {
  return (
    <>
      <header className={styles.head}>
        <div className={styles.headTitle}>
          <strong>Column matching</strong>
          <small>{file}</small>
        </div>
        {close}
      </header>
      <ColumnMatchingStep state={state} step={step} waiting={waiting} />
    </>
  );
}

export function AddDataDialog({ open, ...rest }: Props) {
  // Fully unmounted while closed, so every open starts with fresh state.
  if (!open) return null;
  return <AddDataDialogBody {...rest} />;
}

function AddDataDialogBody({
  onClose,
  onTableCreated,
  onPostgisTableCreated,
  onSkipped,
  uploadQueue,
  initialViewport,
  initialPostgisConnectionId,
  projectId = null,
  projectName = null,
}: Omit<Props, "open">) {
  const router = useRouter();
  // Read as the dialog opens, and again as a batch settles: what it wrote
  // or was refused moves the free space while the dialog stays open.
  const storageLine = useStorageFullLine(
    `${uploadQueue.batch} ${uploadQueue.settled}`,
  );
  // The destination sentence: one per-pane footer whenever imports land
  // in a project, the host's own name first and the shell's cached
  // directory as the backstop.
  const shellName = useProjectName(projectId);
  const importLine =
    projectId === null
      ? null
      : `Imported datasets join ${projectName ?? shellName ?? "this project"}.`;
  // A batch admitted under an earlier scope keeps filing there, appended
  // files included (the queue's admission rule); when the host's scope
  // has moved since, the Upload surface says where THIS batch files
  // rather than promising the new scope.
  const batchRunning = uploadQueue.entries.length > 0 && !uploadQueue.settled;
  const batchProjectId = batchRunning ? uploadQueue.projectId : null;
  const batchName = useProjectName(batchProjectId);
  const uploadLine =
    batchRunning && uploadQueue.projectId !== projectId
      ? batchProjectId === null
        ? "Files added now join this batch, which files into no project."
        : `Files added now join this batch, which files into ${batchName ?? "its project"}.`
      : importLine;
  const [source, setSource] = useState<SourceKey>(
    initialPostgisConnectionId ? "postgis" : "files",
  );
  const [tab, setTab] = useState<FileTab>("upload");
  // The upload road's pending step is the engine's: the batch waits
  // behind it, and its end goes back to the engine. The gate is
  // registered for as long as this dialog is mounted, so only a landing
  // somebody can answer is held; the release resolves a pending step
  // plain (plan risk 2). The engine's method is stable, so this runs
  // once per open.
  const { registerMatchingGate } = uploadQueue;
  useEffect(() => registerMatchingGate(stepTable), [registerMatchingGate]);
  const matching = uploadQueue.matching;
  // The URL road has no queue: the dialog wraps the pane's hand-off. An
  // answer that needs the step is held and the host's callback, which
  // closes the host, waits for the step's end; then the table is carried
  // once, as it stands, set or plain. A result arriving after this dialog
  // closed goes to the host directly, and one still held at the unmount
  // is handed over on the way out, by the step open on it when there is
  // one (the set in flight decides).
  const { current } = uploadQueue;
  const pendingUploadStep = useCallback(() => current().matching?.id ?? null, [current]);
  const urlStepOpen = useRef<MatchingStep | null>(null);
  const { held: urlHeld, landed: landedFromUrl, resolved: urlResolved } = useUrlHold({
    onTableCreated,
    pendingUploadStep,
    activeStep: () => urlStepOpen.current,
  });
  // At most one step is shown at a time, and an active step is never
  // replaced: a URL result that arrived
  // behind the engine's pending step waits for it; any other was there
  // first, and the upload's step waits behind it, the engine holding
  // the batch meanwhile.
  const uploadStep =
    matching !== null
      ? {
          key: `upload-${matching.id}`,
          table: matching.table,
          file: matching.name,
          waiting: matching.waiting,
          onResolved: (outcome: StepOutcome) =>
            uploadQueue.resolveMatching(matching.id, outcome),
        }
      : null;
  const urlStep =
    urlHeld !== null
      ? {
          key: `url-${urlHeld.table.id}`,
          table: urlHeld.table,
          file: urlHeld.table.sourceFilename ?? urlHeld.table.name,
          waiting: [] as readonly string[],
          onResolved: urlResolved,
        }
      : null;
  const pending =
    urlStep !== null && (uploadStep === null || urlHeld?.behind !== matching?.id)
      ? urlStep
      : uploadStep;
  const stepShown = source === "files" && pending !== null;
  const { state: stepState, step } = useMatchingStep({
    table: pending?.table ?? null,
    onResolved: pending?.onResolved ?? urlResolved,
  });
  // The hold's way out reads which step, if any, is open on its table.
  useEffect(() => {
    urlStepOpen.current = pending !== null && pending === urlStep ? step : null;
  });
  // Every way out of the dialog comes through here: the close control,
  // and the kit's Escape and scrim. While a step's set is in flight all
  // of them are inert, so a plain table is never reported for a file
  // whose set may have committed. A pending URL step closes plain and
  // hands its table to the host, which closes on it; a pending upload
  // step is the host's dismissal's to close plain.
  const leave = () => {
    if (stepState?.busy) return;
    if (pending !== null && step !== null && matching === null) {
      step.cancel();
      return;
    }
    onClose();
  };

  const close = (
    <IconButton
      className={styles.close}
      tone="chrome"
      action="Close"
      icon={<XIcon />}
      onClick={leave}
    />
  );

  return (
    <Dialog
      label="Add data"
      onClose={leave}
      className={styles.dialog}
      data-wide={
        source === "overture" || source === "osm" || source === "postgis" || stepShown
          ? true
          : undefined
      }
    >
      <nav className={styles.nav} aria-label="Data sources">
        <h2 className={styles.navTitle}>Add data</h2>
        {(["files", "overture", "osm", "postgis"] as const).map((key) => (
          <SourceNavButton
            key={key}
            spec={IMPORT_SOURCES[key]}
            active={source === key}
            onSelect={() => setSource(key)}
          />
        ))}
        <span className={styles.navSpace} />
        {storageLine && (
          <p className={styles.storageLine} role="status">
            {storageLine}
          </p>
        )}
      </nav>

      <div className={styles.main}>
        {stepShown && pending !== null && stepState !== null && step !== null && (
          <StepPane
            key={pending.key}
            file={pending.file}
            waiting={pending.waiting}
            close={close}
            state={stepState}
            step={step}
          />
        )}
        {stepShown ? null : source === "files" ? (
          <AddDataFilesPane
            tab={tab}
            onTab={setTab}
            close={close}
            uploadQueue={uploadQueue}
            onTableCreated={landedFromUrl}
            onSkipped={onSkipped}
            projectId={projectId}
            importLine={importLine}
            uploadLine={uploadLine}
          />
        ) : (
          <>
            <header className={styles.head}>
              {source === "overture" ? (
                <div className={styles.headTitle}>
                  <strong>Overture Maps</strong>
                  <small>Curated open data, read straight from S3</small>
                </div>
              ) : source === "osm" ? (
                <div className={styles.headTitle}>
                  <strong>OpenStreetMap</strong>
                  <small>Query the living map: tags in, tables out</small>
                </div>
              ) : (
                <div className={styles.headTitle}>
                  <strong>PostGIS</strong>
                  <small>Connect your database, import snapshots</small>
                </div>
              )}
              {close}
            </header>

            {source === "overture" ? (
              <div className={styles.paneFill}>
                <OverturePane
                  initialViewport={initialViewport}
                  onTableCreated={onTableCreated}
                  projectId={projectId}
                />
                {importLine !== null && (
                  <p className={styles.scopeNote}>{importLine}</p>
                )}
              </div>
            ) : source === "osm" ? (
              <div className={styles.paneFill}>
                <OsmPane
                  initialViewport={initialViewport}
                  onTableCreated={onTableCreated}
                  projectId={projectId}
                />
                {importLine !== null && (
                  <p className={styles.scopeNote}>{importLine}</p>
                )}
              </div>
            ) : (
              <div className={styles.paneFill}>
                <PostgisPane
                  onTableCreated={onPostgisTableCreated}
                  onOpenTable={(table) =>
                    router.push(`/tables/${encodeURIComponent(table.name)}`)
                  }
                  initialConnectionId={initialPostgisConnectionId}
                  projectId={projectId}
                />
                {importLine !== null && (
                  <p className={styles.scopeNote}>{importLine}</p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
