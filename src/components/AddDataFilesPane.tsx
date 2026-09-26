"use client";

import type { ReactNode } from "react";
import type { DataTable } from "./api";
import type { SkippedMember } from "./skipped-members";
import { UploadZone } from "./UploadZone";
import { UrlImportPane } from "./UrlImportPane";
import type { UploadQueue } from "./use-upload-queue";
import { TabPanel, Tabs, type TabSpec } from "./ui/Tabs";
import styles from "./AddDataDialog.module.css";

/** The two ways a file becomes a table. */
const FILE_TABS: readonly TabSpec<"upload" | "url">[] = [
  { value: "upload", label: "Upload file" },
  { value: "url", label: "From URL" },
];

export type FileTab = "upload" | "url";

/**
 * The Add data dialog's Files surface (URL road, batch zone,
 * destination lines), extracted from the dialog at touch so the dialog
 * stays a composer of panes. The header's tab strip and the close
 * control it carries are rendered here, so the markup is the dialog's
 * own, verbatim; the chosen tab is the dialog's state, so leaving the
 * Files source and coming back keeps it.
 */
export function AddDataFilesPane({
  tab,
  onTab,
  close,
  uploadQueue,
  onTableCreated,
  onSkipped,
  projectId,
  importLine,
  uploadLine,
}: {
  tab: FileTab;
  onTab: (next: FileTab) => void;
  /** The dialog's close control, placed in the header as before. */
  close: ReactNode;
  uploadQueue: UploadQueue;
  onTableCreated: (table: DataTable) => void;
  onSkipped?: (skipped: SkippedMember[]) => void;
  projectId: string | null;
  /** The destination sentence under the URL road. */
  importLine: string | null;
  /** The Upload surface's own line: the running batch's destination
   * when the host's scope moved since admission, else the import line. */
  uploadLine: string | null;
}) {
  return (
    <>
      <header className={styles.head}>
        <Tabs
          group="add-data-files"
          label="File sources"
          className={styles.tabs}
          value={tab}
          onChange={onTab}
          tabs={FILE_TABS}
        />
        {close}
      </header>
      {tab === "upload" ? (
        <TabPanel
          group="add-data-files"
          value="upload"
          className={styles.pane}
        >
          <UploadZone queue={uploadQueue} />
          <p className={styles.hint}>
            A file with several layers lands as one table each.
          </p>
          {uploadLine !== null && (
            <p className={styles.scopeNote}>{uploadLine}</p>
          )}
        </TabPanel>
      ) : (
        <TabPanel group="add-data-files" value="url" className={styles.pane}>
          <UrlImportPane
            onTableCreated={onTableCreated}
            onSkipped={onSkipped}
            projectId={projectId}
          />
          {importLine !== null && (
            <p className={styles.scopeNote}>{importLine}</p>
          )}
        </TabPanel>
      )}
    </>
  );
}
