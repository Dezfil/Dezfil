"use client";
import { useState } from "react";
import type { LayerDataDownloadPort } from "../use-layer-data-downloads";
import type { RecordEntry } from "./record-projection";
import { RecordEntryRow } from "./RecordEntryRow";
import styles from "../AssistantPanel.module.css";

/**
 * The action record: one collapsed line per action, in the turn's order,
 * opening on an expander to the inspection. The line carries the
 * recorded words, the outcome and the elapsed time; a refusal's reason,
 * an uncertain outcome and an accepted job's identity read under the
 * line. The inspection holds exactly the submitted SQL where the action
 * carried one, the other retained inputs where it did not (the extension
 * beyond the reference), the map and change group of a qualifying
 * change, and the operation identifier, which is never on the line.
 * Detail the bound omitted is marked, never shown as empty. While an
 * action runs its line wears the kit's spinner in the check's place and
 * opens nothing; the check or the cross lands there with the outcome.
 * This module holds the list and which lines are open; one line, its
 * inspection and its door are `RecordEntryRow`.
 */

export { OMITTED_NOTE, STATUS_WORD, decisionWords } from "./RecordEntryRow";

export function AssistantRecord({ entries, layerDataDownloads, doors = true, failureWords = (failure) => failure.message, open: initiallyOpen, liveText }: {
  entries: RecordEntry[];
  /** The live turn's text, for a check's provisional observation. */
  liveText?: string;
  layerDataDownloads: LayerDataDownloadPort;
  /** Show a successful file-producing entry's download door under its line. */
  doors?: boolean;
  /** The rendering boundary's words for a failure. */
  failureWords?: (failure: NonNullable<RecordEntry["failure"]>) => string;
  /** Entries whose inspection starts open (a static render's). */
  open?: string[];
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(initiallyOpen));
  if (entries.length === 0) return null;
  const toggle = (id: string) => setOpen((prior) => { const next = new Set(prior); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return (
    <div className={styles.record} data-record>
      {entries.map((entry) => (
        <RecordEntryRow
          key={entry.id}
          entry={entry}
          expanded={open.has(entry.id)}
          onToggle={() => toggle(entry.id)}
          liveText={liveText}
          layerDataDownloads={layerDataDownloads}
          doors={doors}
          failureWords={failureWords}
        />
      ))}
    </div>
  );
}
