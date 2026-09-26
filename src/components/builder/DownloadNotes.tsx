"use client";

import { ErrorNote } from "../ui/ErrorNote";
import { StatusLine } from "../ui/Status";
import type { LayerDataDownloadFailureView } from "./use-layer-data-downloads";
import styles from "./BuilderFailureNotes.module.css";

/**
 * The layer-download coordinator's notes (lifted out of
 * `BuilderFailureNotes`): a line per preparation in flight and a note
 * with Retry per failed download, so a timeout, a deleted layer or a
 * failed transfer is explained wherever a door was pressed. The builder
 * renders them in its inspector; the /sql and canvas hosts render them
 * in the pane, under its header.
 */
export interface ActiveDownloadNote {
  key: string;
  layerId: string;
  layerName: string;
  format: string;
  formatLabel: string;
}

export function DownloadNotes({ activeDownloads, downloadFailures }: {
  activeDownloads: ActiveDownloadNote[];
  downloadFailures: LayerDataDownloadFailureView[];
}) {
  return (
    <>
      {activeDownloads.map((download) => (
        <div
          key={download.key}
          data-layer-download-active={`${download.layerId}:${download.format}`}
        >
          <StatusLine className={styles.busy}>
            Preparing {download.formatLabel} for &ldquo;{download.layerName}&rdquo;…
          </StatusLine>
        </div>
      ))}
      {downloadFailures.map((failure) => (
        <ErrorNote
          key={failure.key}
          message={failure.message}
          retryLabel="Retry"
          onRetry={failure.retry}
          onDismiss={failure.dismiss}
          data-layer-download-failed={`${failure.layerId}:${failure.format}`}
        />
      ))}
    </>
  );
}
