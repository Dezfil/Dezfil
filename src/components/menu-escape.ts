import type { KeyboardEvent } from "react";

/**
 * Whether an Escape was pressed inside an open menu or on its open
 * trigger: the menu's own listener on the document closes it after the
 * React tree has seen the key, so a surface that closes on Escape (a
 * workflow folder's pane, an unfolded row) must not act on it.
 */
export function escapeBelongsToMenu(e: KeyboardEvent): boolean {
  return e.defaultPrevented || (e.target as HTMLElement).closest('[role="menu"], [data-open]') !== null;
}
