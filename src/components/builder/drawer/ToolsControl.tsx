"use client";

import { createPortal } from "react-dom";
import { useSyncExternalStore } from "react";
import chrome from "../MapBuilder.module.css";
import styles from "./ToolsControl.module.css";
import { ToolsIcon } from "../../ui/operation-icons";
import type { RecipeDrawerState } from "./use-recipe-drawer";

const subscribeNever = () => () => {};

/**
 * The Tools door in the builder's topbar — the control that replaced
 * *Recipes* and its count at the one-step cutover. It opens the drawer on
 * the catalog with no input context; pressed again it closes it, and the
 * drawer's own focus return lands back here.
 *
 * It portals into the header's own slot, exactly as the index it replaced
 * did: the control belongs to the tools neighbourhood, and the module that
 * composes that neighbourhood mounts it.
 */
export function ToolsControlPortal({
  state,
  selectedLayerId,
  hidden = false,
}: {
  state: RecipeDrawerState;
  /** The builder's selection — the door's context. */
  selectedLayerId: string | null;
  /** The width hid the drawer: the door reads the
   * drawer's visible state, and a press reveals it in one step. */
  hidden?: boolean;
}) {
  const mounted = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
  if (!mounted) return null;
  const slot = document.getElementById("header-actions-left");
  if (!slot) return null;
  return createPortal(
    <ToolsControl state={state} selectedLayerId={selectedLayerId} hidden={hidden} />,
    slot,
  );
}

function ToolsControl({
  state,
  selectedLayerId,
  hidden,
}: {
  state: RecipeDrawerState;
  selectedLayerId: string | null;
  hidden: boolean;
}) {
  // The door reads what shows, not the drawer's hand state: a drawer the width hid is not open to
  // the person, and a press on its door brings it back in one step, through the open that keeps its
  // session and its half-filled form, replacing the pane as any hand open does below the limit.
  const visible = state.open && !hidden;
  return (
    <button
      type="button"
      // The header's own treatment, not a look of its own: this control
      // stands beside Fit to data and Preview and reads as their neighbour.
      className={`${chrome.chromeBtn} ${styles.trigger}`}
      data-tools-control
      aria-label="Tools"
      data-hint="Tools"
      aria-pressed={visible}
      // With a layer selected, the door opens with that layer's context —
      // the pre-fill the card's Analyze… used to carry. With nothing
      // selected, a plain catalog.
      onClick={() =>
        visible
          ? state.close()
          : state.open
            ? state.openDrawer()
            : selectedLayerId
              ? state.analyze(selectedLayerId)
              : state.newRecipe()
      }
    >
<ToolsIcon />
      <span className={styles.word}>Tools</span>
    </button>
  );
}
