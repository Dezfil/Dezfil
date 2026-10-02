"use client";

import { IconButton } from "../ui/IconButton";
import { RedoIcon, UndoIcon } from "../ui/icons";
import type { HistoryChrome } from "./use-canvas-editing";
import { useViewOnly } from "./view-only";
import { WorkflowAssistantDoor, type WorkflowAssistant } from "./WorkflowAssistantHost";
import styles from "../WorkflowScreen.module.css";

/**
 * The workflow page's header group beside the theme toggle: Undo and Redo,
 * as the builder's are, then the assistant's door. The canvas tells the
 * screen what the two buttons read and takes the press. A Viewer's page
 * keeps the door alone: there is nothing of theirs to take back.
 */
export function HeaderHistory({
  history,
  assistant,
}: {
  history: HistoryChrome;
  assistant: WorkflowAssistant;
}) {
  const viewOnly = useViewOnly();
  if (viewOnly) {
    return (
      <span className={styles.history} data-history-chrome>
        <WorkflowAssistantDoor assistant={assistant} />
      </span>
    );
  }
  return (
    <span className={styles.history} data-history-chrome>
      <IconButton
        className={styles.histBtn}
        tone="chrome"
        hint
        action={history.reason ? `Undo: ${history.reason}` : "Undo"}
        shortcut="⌘Z / Ctrl+Z"
        icon={<UndoIcon />}
        onPointerDown={() => history.seal()}
        onClick={() => history.press("undo")}
        disabled={!history.canUndo || history.reason !== null}
        data-undo
      />
      <IconButton
        className={styles.histBtn}
        tone="chrome"
        hint
        action={history.reason ? `Redo: ${history.reason}` : "Redo"}
        shortcut="⇧⌘Z / Ctrl+Y"
        icon={<RedoIcon />}
        onPointerDown={() => history.seal()}
        onClick={() => history.press("redo")}
        disabled={!history.canRedo || history.reason !== null}
        data-redo
      />
      <WorkflowAssistantDoor assistant={assistant} />
    </span>
  );
}
