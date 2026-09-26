/**
 * The picker's keyboard: which key does what, as a pure rule, so the
 * component only has to move focus.
 *
 * Two rules the pane depends on. Escape is consumed **only** while the menu
 * is open, so one press never both closes the menu and dismisses the pane
 * (the pane's Escape defers to a nested control that consumed the press)
 * and so a closed picker never swallows the pane's own. And Enter and Space
 * on an open menu are left alone: a focused item is a button and activates
 * natively, so consuming them here would pick twice.
 */

export interface MenuState {
  open: boolean;
  /** Which item the walk is on, counting models then effort levels. */
  index: number;
  count: number;
  disabled: boolean;
}

export type MenuKeyAction =
  | { kind: "open"; index: number }
  | { kind: "move"; index: number }
  | { kind: "close" }
  | { kind: "ignore" };

const ignore = { kind: "ignore" } as const;

export function menuKey(key: string, state: MenuState): MenuKeyAction {
  if (state.disabled || state.count === 0) return ignore;
  if (!state.open) {
    if (key === "ArrowUp") return { kind: "open", index: state.count - 1 };
    if (key === "ArrowDown" || key === "Enter" || key === " ") return { kind: "open", index: 0 };
    return ignore;
  }
  switch (key) {
    case "ArrowDown": return { kind: "move", index: (state.index + 1) % state.count };
    case "ArrowUp": return { kind: "move", index: (state.index - 1 + state.count) % state.count };
    case "Home": return { kind: "move", index: 0 };
    case "End": return { kind: "move", index: state.count - 1 };
    case "Escape":
    case "Tab": return { kind: "close" };
    default: return ignore;
  }
}
