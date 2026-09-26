"use client";
import { useState } from "react";
import { Dialog } from "../../ui/Dialog";
import { ChevronIcon, XIcon } from "../../ui/icons";
import { Spinner } from "../../Spinner";
import { CHECKED_THE_MAP, IMAGE_DIALOG_LABEL, IMAGE_NOT_KEPT, STATE_DETAIL_NOT_KEPT, THUMBNAIL_LABEL, checkFailureWords, observationWords } from "./check-note";
import type { RecordEntry } from "./record-projection";
import styles from "../AssistantPanel.module.css";

/**
 * The check's line in the record (inside turn): the 44 px thumbnail read
 * from the retained image, then "Checked the map." and the observation's
 * displayed sentence, one line among the action lines. The thumbnail's
 * activation opens exactly the retained image in the kit's dialog, which
 * hands focus back to the thumbnail (the approved interaction); the line
 * itself is the record's expander into the inspection. A check that
 * produced no image shows its failure words and neither thumbnail nor
 * observation; an image the instance no longer keeps says so while the
 * facts stay.
 */
export const lookImageUrl = (renderId: string, variant?: "thumbnail") => `/api/maps/look/${encodeURIComponent(renderId)}${variant ? "?variant=thumbnail" : ""}`;

export function CheckNote({ entry, expanded, onToggle, liveText }: {
  entry: RecordEntry;
  expanded: boolean;
  onToggle: () => void;
  /** The live turn's text, for the provisional sentence while awaited. */
  liveText?: string;
}) {
  const [image, setImage] = useState<"kept" | "unavailable">("kept");
  const [open, setOpen] = useState(false);
  const running = entry.status === "running";
  const failed = entry.status !== "succeeded" && !running;
  const check = entry.check;
  const words = observationWords(entry, liveText);
  return (
    <div className={styles.checkLine} data-check>
      {check && image === "kept" && !failed && (
        <button type="button" className={styles.checkThumb} data-check-thumb aria-label={THUMBNAIL_LABEL} onClick={() => setOpen(true)}>
          {/* eslint-disable-next-line @next/next/no-img-element -- the retained PNG from the instance's own API, never optimised or re-rendered */}
          <img src={lookImageUrl(check.renderId, "thumbnail")} alt="" onError={() => setImage("unavailable")} />
        </button>
      )}
      {check && image === "unavailable" && !failed && (
        <span className={styles.checkThumb} data-check-thumb data-image="unavailable" aria-hidden="true" />
      )}
      <button type="button" className={`${styles.line} ${styles.checkWordsLine}`} aria-expanded={expanded} disabled={running} onClick={onToggle}>
        {running ? <span className={styles.lineStatus} aria-label="in progress"><span data-running-mark><Spinner size={10} /></span></span> : null}
        {failed ? <span className={styles.lineStatus} aria-label="not done"><XIcon /></span> : null}
        <span className={styles.checkWords} data-check-words>
          <b>{CHECKED_THE_MAP}</b>
          {failed && entry.failure && <span className={styles.lineNote} data-failure-code={entry.failure.code}>{checkFailureWords(entry.failure.code)}</span>}
          {!failed && !running && image === "unavailable" && <span className={styles.checkAside}>{IMAGE_NOT_KEPT}</span>}
          {!failed && !running && entry.observation && (
            <span data-observation data-observation-state={entry.observation.state} data-provisional={words.provisional || undefined}>{words.text}</span>
          )}
        </span>
        {entry.elapsed && <span className={styles.elapsed}>{entry.elapsed}</span>}
        <span className={styles.chevron}><ChevronIcon /></span>
      </button>
      {open && check && (
        <Dialog label={IMAGE_DIALOG_LABEL} onClose={() => setOpen(false)} className={styles.checkImageDialog} data-check-image-dialog>
          <div className={styles.checkImageHead}>
            <span>{IMAGE_DIALOG_LABEL}</span>
            <button type="button" className={styles.checkImageClose} aria-label="Close" onClick={() => setOpen(false)}><XIcon /></button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element -- exactly the retained image the model was given, byte for byte */}
          <img className={styles.checkImage} src={lookImageUrl(check.renderId)} alt={IMAGE_DIALOG_LABEL} onError={() => { setImage("unavailable"); setOpen(false); }} />
        </Dialog>
      )}
    </div>
  );
}

/** The inspection under an open check line: the render identity, the
 * state identity, the appearance and the sizes; no undo, no change group. */
export function CheckInspection({ entry }: { entry: RecordEntry }) {
  const check = entry.check;
  if (!check) return null;
  return (
    <dl className={styles.inspectionInputs} data-check-inspection>
      <div className={styles.inspectionInput}><dt>render</dt><dd data-render-id>{check.renderId}</dd></div>
      <div className={styles.inspectionInput}><dt>state</dt><dd data-render-state>{check.stateDigest}{check.layers !== undefined && check.widgets !== undefined ? `, ${check.layers} visible layer${check.layers === 1 ? "" : "s"}, ${check.widgets} widget${check.widgets === 1 ? "" : "s"}` : `, ${STATE_DETAIL_NOT_KEPT}`}</dd></div>
      <div className={styles.inspectionInput}><dt>appearance</dt><dd>{check.appearance}</dd></div>
      <div className={styles.inspectionInput}><dt>image</dt><dd>{check.image ? `${check.image.width} by ${check.image.height}, ${Math.round(check.image.bytes / 1024)} KiB` : "none"}</dd></div>
      <div className={styles.inspectionInput}><dt>rendered at</dt><dd>{`${check.source.width} by ${check.source.height}`}</dd></div>
      {check.attribution && <div className={styles.inspectionInput}><dt>credit</dt><dd>{check.attribution}</dd></div>}
      {check.failures.length > 0 && <div className={styles.inspectionInput}><dt>in the picture</dt><dd data-check-failures>{check.failures.join("; ")}</dd></div>}
      {check.abandoned.length > 0 && <div className={styles.inspectionInput}><dt>not answered</dt><dd data-check-abandoned>{`${check.abandoned.length} request${check.abandoned.length === 1 ? "" : "s"} to ${[...new Set(check.abandoned)].join(", ")}`}</dd></div>}
    </dl>
  );
}
