"use client";
import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronIcon, XIcon } from "../../ui/icons";
import { Spinner } from "../../Spinner";
import type { LayerDataDownloadPort } from "../use-layer-data-downloads";
import { DownloadDoor } from "./assistant-downloads";
import { CheckInspection, CheckNote } from "./CheckNote";
import { isCheckEntry } from "./check-note";
import type { RecordEntry } from "./record-projection";
import styles from "../AssistantPanel.module.css";

/**
 * One entry of the action record: the collapsed line, its inspection and
 * its download door. The line stays one line, cut at its end, and
 * carries the whole sentence where a pointer and assistive technology
 * can read it without opening anything; where the line had to cut, the
 * inspection opens with the whole sentence above the detail it already
 * held. Whether it had to cut is the line's own overflow at whatever
 * width the pane currently has, never a count of characters.
 */

export const OMITTED_NOTE = "The detail of this action was not kept. What it did is recorded; what it ran is not.";

/** The outcome's word, on the line's status dot and in the status region. */
export const STATUS_WORD: Record<RecordEntry["status"], string> = {
  running: "in progress", succeeded: "done", accepted: "accepted", refused: "not done", uncertain: "uncertain",
};

/** The inspection's line for a settled decision:
 * approval and decline by the person, and a gate the API records as
 * superseded by what ended it, this pane's Stop or, read back without
 * that knowledge, the request's end. */
export function decisionWords(entry: Pick<RecordEntry, "decision" | "failure">): string | null {
  if (entry.decision === "approved") return "Confirmed by you.";
  if (entry.decision === "declined") return "Cancelled by you.";
  if (entry.decision === "superseded") return entry.failure?.code === "stopped" ? "Stopped by you." : "Ended before it was confirmed.";
  return null;
}

/** Whether the words are painted clipped inside the box that shows them.
 * `scrollWidth` and `clientWidth` are whole pixels, so words over their
 * slot by a fraction, or by one pixel, read as fitting while the browser
 * paints the ellipsis. A range over the
 * words reports their laid-out width unrounded, and the box reports its
 * own; anything above a float's noise is a clip. The rounded pair stays
 * as the fallback where no range can measure. */
function wordsClipped(el: HTMLSpanElement): boolean {
  const range = typeof document !== "undefined" && typeof document.createRange === "function" ? document.createRange() : null;
  if (range) {
    range.selectNodeContents(el);
    if (range.getBoundingClientRect().width - el.getBoundingClientRect().width > 0.05) return true;
  }
  return el.scrollWidth > el.clientWidth;
}

/** True while the words are painted clipped. Measured from the rendered
 * element, so a wider pane or shorter words end it, and measured again
 * when the fonts settle: the width of text is font-shaped, and a face
 * arriving under `font-display: swap` changes the words without changing
 * the box a resize observation watches (the legend's width rule does the
 * same). */
function useCutWords(deps: unknown[]): [React.RefObject<HTMLSpanElement | null>, boolean] {
  const words = useRef<HTMLSpanElement | null>(null);
  const [cut, setCut] = useState(false);
  useEffect(() => {
    const el = words.current;
    if (!el) return;
    let stale = false;
    const measure = () => { if (!stale && words.current) setCut(wordsClipped(words.current)); };
    measure();
    void document.fonts?.ready?.then(measure);
    if (typeof ResizeObserver === "undefined") return () => { stale = true; };
    const sizes = new ResizeObserver(measure);
    sizes.observe(el);
    return () => { stale = true; sizes.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return [words, cut];
}

export function RecordEntryRow({ entry, expanded, onToggle, liveText, layerDataDownloads, doors, failureWords }: {
  entry: RecordEntry;
  expanded: boolean;
  onToggle: () => void;
  /** The live turn's text, for a check's provisional observation. */
  liveText?: string;
  layerDataDownloads: LayerDataDownloadPort;
  doors: boolean;
  failureWords: (failure: NonNullable<RecordEntry["failure"]>) => string;
}) {
  const bad = entry.status === "refused" || entry.status === "uncertain";
  const running = entry.status === "running";
  const check = isCheckEntry(entry);
  const [words, cut] = useCutWords([entry.label, entry.status, entry.elapsed, check]);
  return (
    <div className={styles.recordEntry} data-record-entry={entry.id} data-status={entry.status} data-tool={entry.tool} data-automatic={entry.automatic || undefined}>
      {check ? <CheckNote entry={entry} expanded={expanded} onToggle={onToggle} liveText={liveText} /> : (
      <button type="button" className={styles.line} aria-expanded={expanded} disabled={running} onClick={onToggle} title={entry.label}>
        <span className={styles.lineStatus} aria-label={STATUS_WORD[entry.status]}>
          {running ? <span data-running-mark><Spinner size={10} /></span> : bad ? <XIcon /> : <CheckIcon />}
        </span>
        <span className={styles.lineWords}>
          <span className={styles.verb} ref={words}>{entry.label}</span>
          {entry.failure && <span className={styles.lineNote} data-failure-code={entry.failure.code}>{failureWords(entry.failure)}</span>}
          {entry.status === "accepted" && <span className={styles.lineNote}>Accepted as a job{entry.jobId ? `: ${entry.jobId}` : ""}.</span>}
        </span>
        {entry.elapsed && <span className={styles.elapsed}>{entry.elapsed}</span>}
        <span className={styles.chevron}><ChevronIcon /></span>
      </button>
      )}
      {expanded && (
        <div className={styles.inspection} data-inspection>
          {cut && <p className={styles.sentence} data-sentence>{entry.label}</p>}
          {check && entry.check ? (
            <CheckInspection entry={entry} />
          ) : entry.omitted ? (
            <p className={styles.omitted} data-omitted>{OMITTED_NOTE}</p>
          ) : entry.sql !== undefined ? (
            <pre className={styles.sql} data-sql>{entry.sql}</pre>
          ) : entry.inputs.length > 0 ? (
            <dl className={styles.inspectionInputs} data-inputs>
              {entry.inputs.map(([key, value]) => (
                <div key={key} className={styles.inspectionInput}><dt>{key}</dt><dd>{value}</dd></div>
              ))}
            </dl>
          ) : null}
          {entry.history && (
            <p className={styles.historyLine} data-history>
              Map {entry.history.mapId}, change group {entry.history.group}
            </p>
          )}
          {entry.decision && <p className={styles.historyLine} data-decision={entry.decision}>{decisionWords(entry)}</p>}
          <p className={styles.toolId} data-tool-id>{entry.tool}</p>
        </div>
      )}
      {doors && entry.download && entry.status === "succeeded" && (
        <div className={styles.lineDoor}><DownloadDoor door={entry.download} layerDataDownloads={layerDataDownloads} /></div>
      )}
    </div>
  );
}
