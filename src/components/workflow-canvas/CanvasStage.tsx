"use client";

import { useReactFlow } from "@xyflow/react";
import { StageButton } from "../map/StageStack";
import { ArrangeIcon, CompressIcon, ExpandIcon, FitIcon, LockIcon, MinimapIcon, MinusIcon, NoteIcon, PlusIcon, UnlockIcon } from "../ui/icons";
import { fitOptions } from "./view";
import styles from "./WorkflowCanvas.module.css";

/**
 * The stage stack (reference 13): zoom in, zoom out, fit to
 * view and the view toggle in one column at the canvas's top left, the
 * builder's own buttons, with Arrange by dependency under the toggle
 * (from the header), the note tool under that, Undo and Redo after it
 * and the lock last. The zoom readout that stood between Redo and the
 * lock was removed on a field-round ruling:
 * nothing depended on the number, the fit button is the anchor, and it
 * floated on the dot grid under the tiles at high zoom. Fit, zoom and
 * the toggle never write anything; the note tool only enters note mode;
 * Arrange writes the layout as says; Undo and Redo write what the step
 * they take back wrote.
 */
export function CanvasStage({
  view,
  onView,
  panel = false,
  noteMode = false,
  noteToolReason = null,
  onNoteTool,
  reserve = 0,
  helperRight = 0,
  onArrange,
  canArrange = false,
  arrangeReason = null,
  minimapShown = true,
  onMinimap,
  locked = false,
  onLock,
}: {
  view: "full" | "framed";
  /** A panel is open: the fit keeps out from under it. */
  panel?: boolean;
  /** What the assistant pane and a shifted panel take on the right. */
  helperRight?: number;
  /** What the band keeps at the screen's foot in full view. */
  reserve?: number;
  onView: (next: "full" | "framed") => void;
  /** Note mode is on: the tool shows itself pressed. */
  noteMode?: boolean;
  /** Why the tool is unavailable (the hundred-note limit), or null. */
  noteToolReason?: string | null;
  onNoteTool?: () => void;
  /** Arrange by dependency; inert while there is nothing to arrange. */
  onArrange?: () => void;
  canArrange?: boolean;
  /** Why Arrange is inert beyond an empty canvas (the lock), or null. */
  arrangeReason?: string | null;
  /** The canvas lock: the last button, pressed while locked. */
  /** The minimap's toggle (shown by default, remembered per viewer). */
  minimapShown?: boolean;
  onMinimap?: () => void;
  locked?: boolean;
  onLock?: () => void;
  /** The record's two sides: a button with
   * nothing on its side is dimmed. */
  /** Why the pair is inert beyond an empty side (the lock), or null. */
}) {
  const flow = useReactFlow();
  return (
    <div className={styles.stage} role="group" aria-label="Canvas controls" data-canvas-stage>
      {/* The steps are instant: a step that animates is interrupted by the
          next click and lands short of a full step. */}
      <StageButton action="Zoom in" icon={<PlusIcon />} onClick={() => void flow.zoomIn()} />
      <StageButton action="Zoom out" icon={<MinusIcon />} onClick={() => void flow.zoomOut()} />
      <StageButton action="Fit to view" icon={<FitIcon />} onClick={() => void flow.fitView({ ...fitOptions(view, panel, reserve, helperRight), duration: 240 })} />
      <StageButton
        action={view === "full" ? "Framed view" : "Fill the screen"}
        icon={view === "full" ? <CompressIcon /> : <ExpandIcon />}
        aria-pressed={view === "framed"}
        onClick={() => onView(view === "full" ? "framed" : "full")}
      />
      {onArrange ? (
        <StageButton
          action={arrangeReason ? `Arrange by dependency: ${arrangeReason}` : "Arrange by dependency"}
          icon={<ArrangeIcon />}
          disabled={!canArrange || arrangeReason !== null}
          onClick={onArrange}
          data-arrange
        />
      ) : null}
      {onNoteTool ? (
        <StageButton
          action={noteToolReason ? `Add a note: ${noteToolReason}` : "Add a note"}
          shortcut="N"
          icon={<NoteIcon />}
          aria-pressed={noteMode}
          data-active={noteMode || undefined}
          disabled={noteToolReason !== null}
          onClick={onNoteTool}
          data-note-tool
        />
      ) : null}
      {onMinimap ? (
        <StageButton
          action={minimapShown ? "Hide minimap" : "Show minimap"}
          icon={<MinimapIcon />}
          aria-pressed={minimapShown}
          data-active={minimapShown || undefined}
          onClick={onMinimap}
          data-minimap-toggle
        />
      ) : null}
      {onLock ? (
        <StageButton
          action={locked ? "Unlock canvas" : "Lock canvas"}
          icon={locked ? <LockIcon /> : <UnlockIcon />}
          aria-pressed={locked}
          data-active={locked || undefined}
          onClick={onLock}
          data-lock
          className={styles.lockBtn}
        />
      ) : null}
    </div>
  );
}
