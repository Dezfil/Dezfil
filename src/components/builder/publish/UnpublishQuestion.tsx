"use client";

import { useRef, useState } from "react";
import { readApiError } from "@/components/api";
import { useEditorRequest } from "@/components/document-editor-context";
import { serverUnreachable } from "@/components/failure-copy";
import home from "@/components/projects/ProjectHome.module.css";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { ErrorNote } from "@/components/ui/ErrorNote";
import styles from "./UnpublishQuestion.module.css";

/**
 * Unpublish asks first: publishing again gives the map a new link, so the
 * one already handed out, and every embed of it, stops working for good.
 *
 * Opening the question, Cancel and Escape send nothing. Unpublish map sends
 * the same request the button sent before, through the editor's ordered
 * writes, one at a time; a refusal or a lost connection stays here, and
 * the map is shown unpublished only once the server has said so.
 */
export function UnpublishQuestion({
  mapId,
  mapName,
  onClose,
  onUnpublished,
}: {
  mapId: string;
  mapName: string;
  onClose: () => void;
  onUnpublished: () => void;
}) {
  const request = useEditorRequest();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const unpublish = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await request(`/api/maps/${mapId}/publish`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readApiError(response));
    } catch (cause) {
      inFlight.current = false;
      setBusy(false);
      setError(cause instanceof TypeError ? serverUnreachable("unpublish the map") : cause instanceof Error ? cause.message : "The map couldn't be unpublished.");
      return;
    }
    onUnpublished();
  };

  return (
    <Dialog
      label={`Unpublish ${mapName}`}
      className={home.dialog}
      data-unpublish-question=""
      onClose={() => {
        if (!inFlight.current) onClose();
      }}
    >
      <div className={home.dialogHead}>
        <strong>Unpublish {mapName}?</strong>
        <small>The link and every embed stop working. If you publish again, the map gets a new link.</small>
      </div>
      {error && <ErrorNote className={styles.note} message={error} />}
      <div className={home.dialogFoot}>
        <Button variant="quiet" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" busy={busy} onClick={() => void unpublish()}>
          Unpublish map
        </Button>
      </div>
    </Dialog>
  );
}
