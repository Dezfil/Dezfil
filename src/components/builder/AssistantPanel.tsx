"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { AssistantContext } from "@/lib/assistant/context";
import { ErrorNote } from "../ui/ErrorNote";
import type { LayerDataDownloadPort } from "./use-layer-data-downloads";
import { AssistantComposer } from "./assistant/AssistantComposer";
import { AssistantTurn } from "./assistant/AssistantTurn";
import { TurnAnnouncements } from "./assistant/TurnAnnouncements";
import { failureWords, payerWords } from "./assistant/assistant-words";
import { PaneFailureNote } from "./assistant/PaneFailureNote";
import { EntryChips } from "./assistant/EntryChips";
import { composerWorking } from "./assistant/turn-phase";
import { turnViews } from "./assistant/turn-views";
import { entryChips } from "./assistant/entry-chips";
import type { InsertOutcome } from "./assistant/ProposalBlock";
import { TalkingAbout } from "./assistant/TalkingAbout";
import { talkingAbout, type PageFacts } from "./assistant/talking-about";
import { useAssistantTurn } from "./assistant/use-assistant-turn";
import { KeyForm, type KeyProvider } from "./assistant/KeyForm";
import { ModelPicker } from "./assistant/ModelPicker";
import { pickerShown } from "./assistant/model-choice";
import styles from "./AssistantPanel.module.css";

export function AssistantPanel({ onMutate, layerDataDownloads, context, facts, onInsert, showTitle = true }: {
  onMutate: () => void;
  layerDataDownloads: LayerDataDownloadPort;
  context?: AssistantContext;
  /** The host owns an editor (/sql): Insert a proposal whose request
   * carried the /sql context, given the draft that request carried. The
   * host answers how it landed. */
  onInsert?: (sql: string, originDraft: string) => InsertOutcome;
  /** The page's display facts for the "talking about" row:
   * the same identities the context carries, in the page's
   * own words; absent on a host with nothing to talk about. */
  facts?: PageFacts;
  showTitle?: boolean;
}) {
  const { status, statusFailed, setStatusFailed, setStatusAttempt, turns, input, setInput,
    busy, phase, streaming, announcements, live, error, setError, submit, resolve, recoveryId,
    recover, stop, availablePending, markInserted, submitText } = useAssistantTurn(context, onMutate);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [replacingKey, setReplacingKey] = useState(false);
  const confirmPromptId = useId();
  const words = (failure: { code: string; message: string }) => failureWords(failure, { pendingActions: availablePending.length });
  // One view per turn, keyed by its run: settlement moves the live
  // view's data into the settled list under the same key.
  const views = turnViews(turns, live);
  const empty = views.length === 0 && !busy;
  const working = composerWorking(phase);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, live]);

  if (status === null) {
    if (statusFailed) {
      return (
        <section className={styles.panel}>
          {showTitle && <h2 className={styles.title}>Assistant</h2>}
          <ErrorNote
            message="The assistant couldn't be reached."
            onRetry={() => {
              setStatusFailed(false);
              setStatusAttempt((n) => n + 1);
            }}
          />
        </section>
      );
    }
    return <div className={styles.panel} aria-hidden />;
  }

  if (!status.enabled) {
    return (
      <section className={styles.panel}>
        {showTitle && <h2 className={styles.title}>Assistant</h2>}
        <p className={styles.absent}>{status.reason}</p>
        <KeyForm onSaved={() => setStatusAttempt((n) => n + 1)} />
      </section>
    );
  }

  // Item 5: where the instance offers a choice, the picker names the model
  // and the pane's model line goes, in both of the pane's forms. Where it
  // does not, both forms are exactly what ships today.
  const models = status.models ?? [];
  const payer = payerWords(status);
  const ownKey = status.payer?.kind === "own" ? status.payer : null;
  const modelLine = payer ? `${status.model} · ${payer}` : status.model;
  const picker = pickerShown(models)
    ? <ModelPicker models={models} instanceModel={status.model} disabled={working || busy} bound={live.choice} payer={payer} />
    : null;
  return (
    <section className={styles.panel} data-phase={phase}>
      {showTitle ? (
        <h2 className={styles.title}>
          Assistant
          {!picker && <span className={styles.model}>{modelLine}</span>}
        </h2>
      ) : (
        !picker && <p className={styles.modelLine}>{modelLine}</p>
      )}
      {facts && <TalkingAbout chips={talkingAbout(facts)} />}
      <TurnAnnouncements announcements={announcements} />

      <div className={styles.transcript} ref={scrollRef} data-transcript>
        {empty && (
          <p className={styles.hint}>
            Ask in plain English, e.g. “show me all parks within 500m of a
            station”.
          </p>
        )}
        {views.map((view) => {
          const insertable = !view.live && context?.page === "sql" && view.origin?.page === "sql" && onInsert !== undefined;
          return (
            <AssistantTurn
              key={view.key}
              view={view}
              phase={phase}
              streaming={streaming}
              layerDataDownloads={layerDataDownloads}
              failureWords={words}
              insertable={insertable}
              onInsert={insertable && view.runId ? (index, sql) => markInserted(view.runId!, index, onInsert!(sql, (view.origin as { draft: string }).draft)) : undefined}
              confirmation={view.live ? { promptId: confirmPromptId, busy, resolve } : undefined}
            />
          );
        })}

        {error && (
          <PaneFailureNote failure={error} pendingActions={availablePending.length} onDismiss={() => setError(null)}
            onReplaceKey={ownKey && !replacingKey ? () => setReplacingKey(true) : undefined} />
        )}
        {recoveryId && !busy && (
          <button className={styles.send} onClick={() => void recover()}>Check request outcome</button>
        )}
        {!live.pending && !recoveryId && availablePending.map((item) => (
          <button key={item.id} className={styles.send} onClick={() => void recover(item.runId)}>
            Recover pending action: {item.confirmation?.target ?? "Confirmation required"}
          </button>
        ))}
      </div>

      {replacingKey && ownKey ? (
        <KeyForm initialProvider={ownKey.provider as KeyProvider} onCancel={() => setReplacingKey(false)}
          onSaved={() => { setReplacingKey(false); setError(null); setStatusAttempt((n) => n + 1); }} />
      ) : (<>
        <EntryChips
          chips={entryChips(facts, empty)}
          disabled={working || busy || Boolean(recoveryId)}
          onPick={(words) => void submitText(words)}
        />
        <AssistantComposer phase={phase} input={input} setInput={setInput} onSubmit={submit} onStop={() => void stop()} blocked={busy || Boolean(recoveryId)} picker={picker} />
      </>)}
    </section>
  );
}
