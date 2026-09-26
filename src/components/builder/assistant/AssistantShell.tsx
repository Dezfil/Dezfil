"use client";

import type { AssistantContext } from "@/lib/assistant/context";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { popoverTriggerProps } from "../../ui/Popover";
import { AssistantPanel } from "../AssistantPanel";
import { assistantOwnsEscape } from "./escape-owner";
import type { PageFacts } from "./talking-about";
import type { InsertOutcome } from "./ProposalBlock";
import type { LayerDataDownloadPort } from "../use-layer-data-downloads";
import { DRAWER_WIDTH } from "../drawer/use-recipe-drawer";
import { FaceHeader } from "../drawer/FaceHeader";
import { ClearConversation } from "./ClearConversation";
import { clearControl, focusComposer } from "./clear-control";
import { conversation } from "./conversation-store";
import styles from "./AssistantPane.module.css";

/** The assistant shell, out of `MapBuilder.tsx`/`BuilderChrome.tsx`
 * the trigger wiring, the dismissal contract, and the surface as a pane
 * of the Tools drawer's size, mounted while closed. The pane is a
 * working surface, not a popover (answer): clicking elsewhere never
 * closes it; it closes through its own close control, the header door,
 * or Escape pressed while focus is inside it, which returns focus to
 * the door. */

export const ASSISTANT_PANEL_ID = "builder-assistant";

/** The pane's Escape: heard only with focus inside
 * the pane, decided a microtask later so a nested control that consumed
 * the press (the kit's menu, a dialog) keeps its own priority, and
 * handing focus back to the door. The drawer and the canvas defer to
 * the same ownership rule, so one press never both dismisses the pane
 * and acts elsewhere. */
export function usePaneEscape(open: boolean, onClose: () => void, toggleRef: React.RefObject<HTMLButtonElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !assistantOwnsEscape(event.target)) return;
      queueMicrotask(() => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        onClose();
        toggleRef.current?.focus();
      });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, toggleRef]);
}

/** The host creates and owns the door's ref (Escape hands focus back
 * to it); the slot owns the open state (this hand state under the width
 * rule), and the hook wires the dismissal contract. Returned pieces are
 * plain values, never refs. */
export function useAssistantShell(
  toggleRef: React.RefObject<HTMLButtonElement | null>,
  slot: { assistantVisible: boolean; openAssistant: () => void; closeAssistant: () => void },
): {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Spread onto the toggle: aria-expanded/aria-controls. */
  triggerProps: ReturnType<typeof popoverTriggerProps>;
} {
  const open = slot.assistantVisible;
  const { openAssistant, closeAssistant } = slot;
  const setOpen = useCallback((next: boolean) => (next ? openAssistant() : closeAssistant()), [openAssistant, closeAssistant]);
  usePaneEscape(open, closeAssistant, toggleRef);

  return {
    open,
    setOpen,
    triggerProps: popoverTriggerProps(ASSISTANT_PANEL_ID, open),
  };
}

/** The assistant pane: the Tools slot's second occupant.
 * It opens closed on every page open and is opened by its door; it is
 * mounted while closed, so transcript,
 * pending confirmations and download doors survive a dismissal. */
export function AssistantPane({
  popRef,
  open,
  overlay,
  onClose,
  onMutate,
  layerDataDownloads,
  context,
  facts,
  onInsert,
  notes,
}: {
  popRef: React.RefObject<HTMLDivElement | null>;
  open: boolean;
  /** True below the shell breakpoint, where the slot overlays the stage. */
  overlay: boolean;
  onClose: () => void;
  onMutate: () => void;
  layerDataDownloads: LayerDataDownloadPort;
  context?: AssistantContext;
  facts?: PageFacts;
  /** The /sql host's Insert. */
  onInsert?: (sql: string, originDraft: string) => InsertOutcome;
  /** A host's notes under the header: the download coordinator's active
   * lines and failures where the host has no inspector to hold them. */
  notes?: React.ReactNode;
}) {
  /** The clear control belongs in the header, which the pane owns, while
   * the conversation it ends is the panel's. Both read the one store, so
   * the control's states are the same facts the recovery door reads
   * rather than a second opinion about them. */
  const state = useSyncExternalStore(conversation.subscribe, conversation.get, conversation.get);
  const clear = clearControl({ turns: state.turns.length, live: state.live, busy: state.busy, recoveryId: state.recoveryId });
  return (
    <aside
      ref={popRef}
      id={ASSISTANT_PANEL_ID}
      className={styles.pane}
      data-assistant-pane
      data-open={open}
      data-overlay={overlay ? "true" : "false"}
      style={{ ["--drawer-width" as string]: `${DRAWER_WIDTH}px` }}
      aria-label="Assistant"
      aria-hidden={!open}
    >
      <FaceHeader
        title="Assistant"
        onDismiss={onClose}
        dismissLabel="Close assistant"
        drawerDismiss={false}
        segments={false}
        actions={clear === "absent" ? undefined : (
          <ClearConversation
            disabled={clear === "disabled"}
            onClear={() => {
              conversation.clear();
              // The control itself goes with the conversation, so focus
              // would drop to the body; it lands where the person writes
              // next instead.
              focusComposer(popRef.current);
            }}
          />
        )}
      />
      {notes && <div className={styles.notes} data-pane-notes>{notes}</div>}
      <div className={styles.body}>
        <AssistantPanel
          context={context}
          facts={facts}
          onInsert={onInsert}
          onMutate={onMutate}
          layerDataDownloads={layerDataDownloads}
          showTitle={false}
        />
      </div>
    </aside>
  );
}
