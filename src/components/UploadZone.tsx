"use client";

import { useRef, useState } from "react";
import type { UploadQueue } from "./use-upload-queue";
import { attributedSkippedNotice } from "./skipped-members";
import { ErrorNote } from "./ui/ErrorNote";
import { Progress } from "./ui/Status";
import styles from "./UploadZone.module.css";

interface Props {
  /** The host-owned batch queue: the zone renders it and
   * feeds it files; the queue itself outlives the zone, so a dialog
   * close never orphans the request in flight. */
  queue: UploadQueue;
}

/** The format families the input accepts — the chips and the accept list
 * must tell the same truth (KMZ). */
const FORMAT_FAMILIES = [
  "GeoParquet",
  "GeoJSON",
  "CSV",
  "Shapefile",
  "GeoPackage",
  "KML",
  "KMZ",
] as const;

/**
 * Drag-and-drop upload (multi-file): every dropped or picked file joins
 * the sequential batch, each with real byte progress — the queue's XHR
 * keeps the honest bar multi-GB files deserve. Drops while a batch runs
 * append to it.
 */
export function UploadZone({ queue }: Props) {
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const active = queue.active !== null ? queue.entries[queue.active] : null;
  const running = active !== null || queue.entries.some(
    (e) => e.state === "queued",
  );
  const total = queue.entries.length;
  // Present for every batch, a batch of one included (the rule's position is unconditional).
  const positionSuffix = ` (${queue.position} of ${Math.max(total, 1)})`;
  // Failures and unconfirmed notes accumulate until a new batch or the
  // host's close clears them — never last-only.
  const noted = queue.entries.filter(
    (e) => e.state === "failed" || e.state === "unconfirmed",
  );

  return (
    <div className={styles.wrap}>
      <div
        className={styles.zone}
        data-drag={drag}
        data-busy={running}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length > 0) queue.add(files);
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        aria-label="Upload data files"
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".parquet,.geoparquet,.geojson,.json,.csv,.zip,.gpkg,.kml,.kmz"
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0) queue.add(files);
            e.target.value = "";
          }}
        />
        {running && active ? (
          <div className={styles.progressWrap}>
            <div className={styles.progressLabel}>
              <span className={styles.filename}>{active.name}</span>
              <span className={styles.phase}>
                {active.state === "converting"
                  ? "converting to GeoParquet…"
                  : `${Math.round(active.progress * 100)}%`}
                {positionSuffix}
              </span>
            </div>
            <Progress
              label={
                active.state === "converting"
                  ? `Converting ${active.name} to GeoParquet${positionSuffix}`
                  : `Uploading ${active.name}${positionSuffix}`
              }
              value={
                active.state === "uploading" ? active.progress : undefined
              }
            />
          </div>
        ) : (
          <>
            <div className={styles.prompt}>
              Drop files. Each becomes a queryable table
            </div>
            {/* Presentation inside the zone's single button — the chips
                add no actions and no focus targets. */}
            <div className={styles.chips}>
              {FORMAT_FAMILIES.map((family) => (
                <span key={family} className={styles.chip}>
                  {family}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
      {noted.map((entry) => (
        <ErrorNote
          key={entry.id}
          tone={entry.state === "unconfirmed" ? "warn" : "danger"}
          message={
            entry.state === "unconfirmed"
              ? `${entry.name}: unconfirmed. ${entry.error}`
              : `${entry.name}: ${entry.error}`
          }
        />
      ))}
      {/* Skips stay visible inside a host a mixed batch keeps open (the
          PR round) — a close-time notice alone would lose them. */}
      {queue.skips.length > 0 && (
        <ErrorNote tone="warn" message={attributedSkippedNotice(queue.skips)} />
      )}
    </div>
  );
}
