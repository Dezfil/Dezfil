"use client";

import { useCallback, useRef, useState } from "react";
import type { AssistantContext } from "@/lib/assistant/context";
import { AssistantDoor } from "../builder/assistant/AssistantDoor";
import { AssistantPane, useAssistantShell } from "../builder/assistant/AssistantShell";
import type { PageFacts } from "../builder/assistant/talking-about";
import { useViewportBand } from "../builder/use-viewport-band";
import { useLayerDataDownloads } from "../builder/use-layer-data-downloads";
import { DownloadNotes } from "../builder/DownloadNotes";
import chrome from "../builder/MapBuilder.module.css";

/**
 * The assistant on the workflow canvas: the same door after Undo and
 * Redo, and the same pane right of the canvas. The pane is closed every
 * time the page opens and is opened by a click on the door. The canvas
 * decides what the open pane does to
 * its host, its panels and its band from the view and the width band
 * (`assistant-layout.ts`); the screen owns the door, the pane and the
 * band's subscription. The band is the builder's, measured with the rail
 * inside the chrome, so a rail standing open moves its limits with it.
 */

export type WorkflowAssistant = ReturnType<typeof useWorkflowAssistant>;

export function useWorkflowAssistant(onMutate: () => void) {
  const [open, setOpen] = useState(false);
  const band = useViewportBand();
  const popRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const openAssistant = useCallback(() => setOpen(true), []);
  const closeAssistant = useCallback(() => setOpen(false), []);
  const shell = useAssistantShell(toggleRef, { assistantVisible: open, openAssistant, closeAssistant });
  return {
    ...shell,
    band,
    popRef,
    toggleRef,
    toggle: useCallback(() => (open ? closeAssistant() : openAssistant()), [open, closeAssistant, openAssistant]),
    /** A resolved run declared writes: a
     * builder-originated action resolved here may have changed this
     * workflow or a table under its retained full policy, so the screen
     * re-reads what the page shows. */
    onMutate,
  };
}

/** The door, rendered by the screen inside its header group after Redo. */
export function WorkflowAssistantDoor({ assistant }: { assistant: WorkflowAssistant }) {
  return <AssistantDoor open={assistant.open} triggerRef={assistant.toggleRef} triggerProps={assistant.triggerProps} onToggle={assistant.toggle} className={chrome.chromeBtn} />;
}

export function WorkflowAssistantPane({ assistant, overlay, context, facts }: {
  assistant: WorkflowAssistant;
  /** The canvas's word: full view, or the overlay band. */
  overlay: boolean;
  context: AssistantContext;
  facts: PageFacts;
}) {
  const downloads = useLayerDataDownloads("", []);
  return (
    <AssistantPane
      popRef={assistant.popRef}
      open={assistant.open}
      overlay={overlay}
      onClose={() => assistant.setOpen(false)}
      onMutate={assistant.onMutate}
      layerDataDownloads={downloads.port}
      context={context}
      facts={facts}
      notes={<DownloadNotes activeDownloads={downloads.activeDownloads} downloadFailures={downloads.failures} />}
    />
  );
}
