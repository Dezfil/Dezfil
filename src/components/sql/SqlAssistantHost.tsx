"use client";

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { AssistantContext } from "@/lib/assistant/context";
import { AssistantDoor } from "../builder/assistant/AssistantDoor";
import { AssistantPane, useAssistantShell } from "../builder/assistant/AssistantShell";
import type { InsertOutcome } from "../builder/assistant/ProposalBlock";
import type { PageFacts } from "../builder/assistant/talking-about";
import { HELPER_OFFSET } from "../builder/helper-bands";
import { useViewportBand } from "../builder/use-viewport-band";
import { useLayerDataDownloads } from "../builder/use-layer-data-downloads";
import { DownloadNotes } from "../builder/DownloadNotes";
import chrome from "../builder/MapBuilder.module.css";

/**
 * The assistant on /sql: the same door, first in the header's left
 * group since this page has no Undo and Redo, and the same pane,
 * docked right of the work area above the shell's breakpoint and
 * overlaying it at or below. This page has one helper, so no band rule
 * applies. The pane is closed every time the page opens and is opened
 * by a click on the door: the open state is
 * this mount's and is carried nowhere, and the work area gives up the
 * pane's width plus gutter while it docks. The breakpoint is the
 * builder's overlay band, measured with the rail inside the chrome, so a
 * rail standing open moves it up with it.
 */
const subscribeNever = () => () => {};

export function useSqlAssistant() {
  const [hand, setHand] = useState(false);
  const overlay = useViewportBand() === "overlay";
  const popRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const openAssistant = useCallback(() => setHand(true), []);
  const closeAssistant = useCallback(() => setHand(false), []);
  const shell = useAssistantShell(toggleRef, { assistantVisible: hand, openAssistant, closeAssistant });
  const docked = hand && !overlay;
  return {
    ...shell,
    popRef,
    toggleRef,
    overlay,
    docked,
    /** What the work area gives up on its right while the pane docks. */
    offset: docked ? HELPER_OFFSET : 0,
    toggle: useCallback(() => (hand ? closeAssistant() : openAssistant()), [hand, closeAssistant, openAssistant]),
  };
}

export function SqlAssistantHost({ assistant, context, facts, onInsert, onMutate }: {
  assistant: ReturnType<typeof useSqlAssistant>;
  context: AssistantContext;
  facts: PageFacts;
  onInsert: (sql: string, originDraft: string) => InsertOutcome;
  /** A resolved run declared writes: the console re-reads its tables. */
  onMutate: () => void;
}) {
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);
  // Layer-data doors keep working from this page through the shared
  // coordinator, scoped to no map; its active lines and failures show in
  // the pane, since this page has no inspector.
  const downloads = useLayerDataDownloads("", []);
  const slot = mounted ? document.getElementById("header-actions-left") : null;
  return (
    <>
      {slot && createPortal(
        <AssistantDoor open={assistant.open} triggerRef={assistant.toggleRef} triggerProps={assistant.triggerProps} onToggle={assistant.toggle} className={chrome.chromeBtn} />,
        slot,
      )}
      <AssistantPane
        popRef={assistant.popRef}
        open={assistant.open}
        overlay={assistant.overlay}
        onClose={() => assistant.setOpen(false)}
        onMutate={onMutate}
        layerDataDownloads={downloads.port}
        context={context}
        facts={facts}
        onInsert={onInsert}
        notes={<DownloadNotes activeDownloads={downloads.activeDownloads} downloadFailures={downloads.failures} />}
      />
    </>
  );
}
