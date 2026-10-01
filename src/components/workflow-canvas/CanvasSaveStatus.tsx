"use client";

import { SaveStatusChip, SaveStatusCorner } from "../ui/SaveStatusChip";
import type { Whisper } from "./save-whisper";
import { useViewOnly } from "./view-only";
import styles from "./CanvasSaveStatus.module.css";

/**
 * The workflow's save status on its own stage: one chip at the canvas's
 * top-left overlay corner, carrying whatever the screen's owner-keyed
 * whisper currently holds — a rename, a layout or recipe save, a
 * stopped import — with its tone and its Retry.
 *
 * The whisper's owners, timers and replacement rules stay with the
 * screen that has always kept them; this is where their result is read.
 * The canvas's own bottom notices and its lock pill are a different
 * concern (the operation's status, not the document's) and are not
 * touched.
 */
export function CanvasSaveStatus({ whisper }: { whisper: Whisper | null }) {
  // A Viewer's page saves nothing; the chip says so where saving would show.
  const viewOnly = useViewOnly();
  return (
    <SaveStatusCorner className={styles.canvasCorner} data-save-status-corner>
      <SaveStatusChip
        channels={viewOnly ? [{ key: "view-only", message: { text: "View only" } }] : [
          {
            key: "whisper",
            announce: true,
            message:
              whisper === null
                ? null
                : {
                    text: whisper.text,
                    tone: whisper.tone,
                    action: whisper.action,
                  },
          },
        ]}
      />
    </SaveStatusCorner>
  );
}
