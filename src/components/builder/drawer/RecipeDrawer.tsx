"use client";

import { useEffect } from "react";
import { assistantOwnsEscape } from "../assistant/escape-owner";
import styles from "./RecipeDrawer.module.css";
import { DRAWER_GUTTER, type RecipeDrawerState } from "./use-recipe-drawer";

/**
 * The tools drawer.
 *
 * **The drawer runs the action; the map reads the result.** Its guardrail
 * properties live here rather than in a journey's assertions:
 *
 *  - **It is easy to dismiss.** One documented gesture from every state, and
 *    dismissing never raises a blocking confirmation — including with unsaved
 *    form edits, and including while a run is in flight, which it does not
 *    cancel.
 *  - **It is one width.** 342 px, fixed by the one-step pivot; opening moves
 *    the stage's left edge by width plus gutter through the published offset,
 *    and nothing else moves at all.
 *  - **Below the breakpoint it overlays**, publishing no offset, so the map
 *    keeps its full width beneath it.
 */
export function RecipeDrawer({
  state,
  name,
  onDismiss,
  overlay,
  hidden = false,
  children,
}: {
  state: RecipeDrawerState;
  /** The surface's title. */
  name: string;
  onDismiss: () => void;
  /** The helper slot's band says it overlays the stage rather than
   * displacing it: one fact for both helpers, moved by the open rail. */
  overlay: boolean;
  /** Hidden by the width, not closed: still
   * mounted, so a half-filled form survives; out of sight, out of the
   * tab order, and Escape is not its to take. */
  hidden?: boolean;
  children?: React.ReactNode;
}) {
  // **Escape closes the drawer from any depth, and only the drawer**.
  // Menus, dialogs, popovers and — later — the picker's own surfaces
  // consume the presses that acted on them; but they register their
  // document listeners after this one, so the verdict is not in yet when
  // this handler runs. A microtask runs after every handler in the
  // dispatch and sees the final `defaultPrevented`, whatever the
  // registration order.
  useEffect(() => {
    if (!state.open || hidden) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // With focus inside the assistant pane the press is the pane's:
      // both may be open above the three-pane limit.
      if (assistantOwnsEscape(event.target)) return;
      queueMicrotask(() => {
        if (!event.defaultPrevented) onDismiss();
      });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [state.open, hidden, onDismiss]);

  if (!state.open) return null;

  return (
    <aside
      className={styles.drawer}
      data-recipe-drawer
      data-overlay={overlay ? "true" : "false"}
      data-hidden={hidden ? "true" : undefined}
      aria-hidden={hidden || undefined}
      style={{ ["--drawer-width" as string]: `${state.width}px` }}
      aria-label={name}
    >
      {children}
    </aside>
  );
}

export { DRAWER_GUTTER };
