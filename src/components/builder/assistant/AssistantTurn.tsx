"use client";

import type { LayerDataDownloadPort } from "../use-layer-data-downloads";
import { AssistantConfirmation } from "./AssistantConfirmation";
import { AssistantRecord } from "./AssistantRecord";
import { AssistantReply } from "./AssistantReply";
import { DownloadDoor } from "./assistant-downloads";
import { withholdObservations } from "./check-note";
import type { RecordEntry } from "./record-projection";
import { ThinkingDots } from "./ThinkingDots";
import { showsCaret, showsIndicator, type TurnPhase } from "./turn-phase";
import type { TurnView } from "./turn-views";
import styles from "../AssistantPanel.module.css";

/**
 * One turn as the pane shows it, live and settled through one structure:
 * the message where it was sent, the record's lines above the answer,
 * the confirmation card inline where it arrives, the answer, and a
 * settled turn's download doors. Settlement changes the view's data,
 * never this structure, so an inspection opened on a line stays open and
 * the record never moves. The live turn shows the thinking indicator
 * where its answer will be, and the caret on the text still arriving
 * (turn-phase.ts holds the rules).
 */
export function AssistantTurn({ view, phase = "idle", streaming = false, layerDataDownloads, failureWords, insertable, onInsert, confirmation }: {
  view: TurnView;
  /** The pane's phase, for the live view's indicators. */
  phase?: TurnPhase;
  /** A text delta stream is open on the live turn. */
  streaming?: boolean;
  layerDataDownloads: LayerDataDownloadPort;
  failureWords: (failure: NonNullable<RecordEntry["failure"]>) => string;
  /** The host can insert this turn's proposals. */
  insertable: boolean;
  onInsert?: (index: number, sql: string) => void;
  /** The live turn's card controls. */
  confirmation?: { promptId: string; busy: boolean; resolve: (approved: boolean) => void };
}) {
  const indicators = { phase, text: view.text, entries: view.entries, pending: view.pending, streaming };
  // The observation's displayed sentence lives on the note, not in the
  // answer.
  const answer = withholdObservations(view.text, view.entries);
  return (
    <div className={styles.turn} data-turn={view.key} data-live={view.live || undefined}>
      {view.message !== undefined && <div className={styles.user} data-turn-message>{view.message}</div>}
      {view.entries.length > 0 && (
        <AssistantRecord entries={view.entries} layerDataDownloads={layerDataDownloads} doors={view.live} failureWords={failureWords} liveText={view.live ? view.text : undefined} />
      )}
      {view.live && confirmation && (
        <AssistantConfirmation pending={view.pending} promptId={confirmation.promptId} busy={confirmation.busy} resolve={confirmation.resolve} />
      )}
      {answer.trim() !== "" && (
        <div className={styles.assistant}>
          <AssistantReply text={answer} insertable={insertable} inserted={view.inserted} onInsert={onInsert} streaming={view.live && showsCaret(indicators)} />
        </div>
      )}
      {view.live && showsIndicator(indicators) && <ThinkingDots />}
      {!view.live && view.downloads?.map((d) => (
        <DownloadDoor key={d.kind === "layer" ? `${d.layerId}:${d.format}` : d.href} door={d} layerDataDownloads={layerDataDownloads} />
      ))}
    </div>
  );
}
