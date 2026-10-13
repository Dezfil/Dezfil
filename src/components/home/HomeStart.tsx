"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { readApiError } from "../api";
import { AddDataDialog } from "../AddDataDialog";
import { IconData, IconSql, IconWorkflow } from "../gallery-icons";
import gallery from "../gallery.module.css";
import { NewWorkflowDialog } from "../NewWorkflowDialog";
import { skippedNotice } from "../skipped-members";
import { PlusIcon } from "../ui/icons";
import { uploadSettleNotice } from "../upload-settle-notice";
import { useUploadQueue, type UploadQueue } from "../use-upload-queue";
import styles from "./Home.module.css";

/**
 * Start: the product's own four ways to begin, beside the lead two by two
 * and as tall as it, or in one row when nothing leads. New map makes one
 * new, unfiled map with the instance's defaults and opens the builder on
 * it; Add data opens the Add data dialog here, filing nowhere, Home
 * staying; New workflow asks a name first, then opens the canvas on the
 * new, unfiled workflow; Open SQL opens the SQL page. What they make is
 * the maker's own.
 */

export type StartForm = "pair" | "row";

const TILE = `${gallery.ghost} ${gallery.ghostData} ${styles.startTile}`;

export function HomeStart({
  heading,
  form,
  onDatasetsChanged,
  onNotice,
  onError,
}: {
  heading: "Start" | "Or start your own";
  form: StartForm;
  /** A dataset may have landed: Home re-reads the datasets. */
  onDatasetsChanged: () => void;
  /** An import's outcome, as the other hosts of Add data say it. */
  onNotice: (text: string | null) => void;
  onError: (message: string) => void;
}) {
  const router = useRouter();
  // A second press while the first map is being made makes nothing more:
  // the ref holds it before the button can redraw as busy.
  const creating = useRef(false);
  const [creatingMap, setCreatingMap] = useState(false);
  const [naming, setNaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const addingRef = useRef(adding);
  useEffect(() => {
    // Queue events are asynchronous; the mirror is current by then.
    addingRef.current = adding;
  });

  const newMap = useCallback(async () => {
    if (creating.current) return;
    creating.current = true;
    setCreatingMap(true);
    try {
      // No project: the map is the maker's, unfiled; the server gives it
      // the instance's defaults.
      const response = await fetch("/api/maps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Untitled map" }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const map = (await response.json()) as { id: string };
      router.push(`/maps/${map.id}`);
    } catch (e) {
      onError(e instanceof Error ? e.message : "The map couldn't be created.");
      creating.current = false;
      setCreatingMap(false);
    }
  }, [router, onError]);

  // The file batch lives here, not in the dialog: the dialog unmounts on
  // close while a request in flight keeps running. Its batches file into
  // no project.
  const queueRef = useRef<UploadQueue | null>(null);
  const uploadQueue = useUploadQueue({
    projectId: null,
    onListingStale: onDatasetsChanged,
    onSettled: (report) => {
      onDatasetsChanged();
      const { text, clean } = uploadSettleNotice(report);
      if (addingRef.current) {
        // A batch that landed whole closes the dialog with its outcome;
        // anything else keeps it open, its notes readable there.
        if (clean) {
          setAdding(false);
          onNotice(text);
        }
      } else {
        // Closed during the upload: the outcome is said on Home, the only
        // account of it now, and the settled batch is dropped so the next
        // open starts fresh.
        onNotice(text);
        queueRef.current?.reset();
      }
    },
  });
  useEffect(() => {
    queueRef.current = uploadQueue;
  });
  // Every path that closes the dialog settles the queue as the Data page's
  // close does: the files not started are stopped and said, and a settled
  // batch is dropped, so the next open never shows its old notes.
  const settleQueueForClose = useCallback(() => {
    const queue = queueRef.current;
    if (!queue) return;
    const stopped = queue.dismiss();
    if (stopped > 0) {
      onNotice(
        stopped === 1 ? "Stopped. 1 queued file was not started." : `Stopped. ${stopped} queued files were not started.`,
      );
    }
    if (queue.current().settled) queue.reset();
  }, [onNotice]);

  return (
    <section className={styles.section} data-start data-start-form={form}>
      <div className={styles.secRow}>
        <h2>{heading}</h2>
      </div>
      <div className={form === "pair" ? styles.startPair : styles.startRow}>
        <button
          type="button"
          className={TILE}
          data-start-action="new-map"
          disabled={creatingMap}
          aria-busy={creatingMap || undefined}
          onClick={() => void newMap()}
        >
          <span className={gallery.plus}>
            <PlusIcon />
          </span>
          <b>New map</b>
        </button>
        <button type="button" className={TILE} data-start-action="add-data" onClick={() => setAdding(true)}>
          <span className={gallery.plus}>
            <IconData />
          </span>
          <b>Add data</b>
        </button>
        <button type="button" className={TILE} data-start-action="new-workflow" onClick={() => setNaming(true)}>
          <span className={gallery.plus}>
            <IconWorkflow />
          </span>
          <b>New workflow</b>
        </button>
        <Link href="/sql" className={TILE} data-start-action="sql">
          <span className={gallery.plus}>
            <IconSql />
          </span>
          <b>Open SQL</b>
        </Link>
      </div>

      {naming && <NewWorkflowDialog projectId={null} onClose={() => setNaming(false)} />}
      <AddDataDialog
        open={adding}
        projectId={null}
        projectName={null}
        onClose={() => {
          settleQueueForClose();
          setAdding(false);
        }}
        onTableCreated={() => {
          settleQueueForClose();
          setAdding(false);
          onDatasetsChanged();
        }}
        onPostgisTableCreated={onDatasetsChanged}
        onSkipped={(skipped) => {
          if (skipped.length) onNotice(skippedNotice(skipped));
        }}
        uploadQueue={uploadQueue}
      />
    </section>
  );
}
