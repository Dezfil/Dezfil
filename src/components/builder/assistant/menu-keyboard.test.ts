import { describe, expect, it } from "vitest";
import { menuKey, type MenuState } from "./model-menu-keys";
import { focusLanding, focusPlace, type FocusPlace } from "./composer-focus";

/**
 * The picker's keyboard and the hand-off a control disabled under the
 * person's focus makes (table, extended with the picker).
 *
 * Both are decided as pure functions so the rules can be walked
 * exhaustively; the wiring that moves real focus is the browser pass's.
 */

const closed = (over: Partial<MenuState> = {}): MenuState => ({ open: false, index: 0, count: 5, disabled: false, ...over });
const open = (over: Partial<MenuState> = {}): MenuState => ({ open: true, index: 0, count: 5, disabled: false, ...over });

describe("opening, moving and dismissing the menu", () => {
  it("opens downward on Down, Enter and Space, and onto the last item on Up", () => {
    for (const key of ["ArrowDown", "Enter", " "]) expect(menuKey(key, closed()), key).toEqual({ kind: "open", index: 0 });
    expect(menuKey("ArrowUp", closed())).toEqual({ kind: "open", index: 4 });
  });

  it("leaves every other key to whatever else wants it while closed", () => {
    for (const key of ["Escape", "Tab", "Home", "End", "a", "ArrowLeft"]) {
      expect(menuKey(key, closed()), key).toEqual({ kind: "ignore" });
    }
  });

  it("walks the items and wraps at both ends", () => {
    expect(menuKey("ArrowDown", open({ index: 0 }))).toEqual({ kind: "move", index: 1 });
    expect(menuKey("ArrowDown", open({ index: 4 }))).toEqual({ kind: "move", index: 0 });
    expect(menuKey("ArrowUp", open({ index: 0 }))).toEqual({ kind: "move", index: 4 });
    expect(menuKey("ArrowUp", open({ index: 2 }))).toEqual({ kind: "move", index: 1 });
    expect(menuKey("Home", open({ index: 3 }))).toEqual({ kind: "move", index: 0 });
    expect(menuKey("End", open({ index: 1 }))).toEqual({ kind: "move", index: 4 });
  });

  it("Escape and Tab close it, and Escape while closed is not consumed, so the pane hears its own", () => {
    // The pane's Escape defers to a nested control that consumed the press.
    // One press must never both close the menu and dismiss the pane, and
    // with no menu open the pane must still get it.
    expect(menuKey("Escape", open())).toEqual({ kind: "close" });
    expect(menuKey("Tab", open())).toEqual({ kind: "close" });
    expect(menuKey("Escape", closed())).toEqual({ kind: "ignore" });
  });

  it("leaves activation to the focused item, so one press never picks twice", () => {
    // An item is a button: Enter and Space activate it natively. Consuming
    // them here as well would apply the pick twice.
    for (const key of ["Enter", " "]) expect(menuKey(key, open()), key).toEqual({ kind: "ignore" });
  });

  it("a disabled picker answers no key at all, and an empty menu opens onto nothing", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Enter", " ", "Escape"]) {
      expect(menuKey(key, closed({ disabled: true })), key).toEqual({ kind: "ignore" });
      expect(menuKey(key, open({ disabled: true })), key).toEqual({ kind: "ignore" });
    }
    expect(menuKey("ArrowDown", closed({ count: 0 }))).toEqual({ kind: "ignore" });
  });
});

describe("where focus lands when a control is disabled under it", () => {
  const places: FocusPlace[] = ["input", "slot", "card", "picker", "pane", "elsewhere"];

  it("submission hands the input's focus and the picker's focus to Stop", () => {
    expect(focusLanding("idle", "executing", "input")).toBe("slot");
    expect(focusLanding("idle", "executing", "picker")).toBe("slot");
    expect(focusLanding("idle", "parked", "picker")).toBe("slot");
  });

  it("a resolution hands the card's focus to Stop, and settlement hands back to the input", () => {
    expect(focusLanding("parked", "executing", "card")).toBe("slot");
    for (const place of ["slot", "pane", "card"] as const) expect(focusLanding("executing", "idle", place), place).toBe("input");
  });

  it("the picker re-enabled at settlement keeps its own focus rather than being moved", () => {
    // It was disabled at submission and focus already went to Stop, so at
    // settlement there is nothing of the picker's to hand anywhere.
    expect(focusLanding("executing", "idle", "picker")).toBe(null);
  });

  it("focus anywhere else is never taken, and an unchanged phase moves nothing", () => {
    expect(focusLanding("idle", "executing", "elsewhere")).toBe(null);
    expect(focusLanding("executing", "idle", "elsewhere")).toBe(null);
    for (const place of places) expect(focusLanding("idle", "idle", place), place).toBe(null);
    for (const place of places) expect(focusLanding("executing", "executing", place), place).toBe(null);
  });

  it("reads the place from the element the focus landed on, picker before pane", () => {
    // The chip is inside the pane, so the order of the tests decides: a
    // picker classified as "pane" would get no hand-off at submission.
    const el = (attributes: string[]): Element => ({
      closest: (selector: string) => (attributes.includes(selector) ? ({} as Element) : null),
    } as Element);
    expect(focusPlace(el(["[data-model-choice]", "[data-assistant-pane]"]), false, false)).toBe("picker");
    expect(focusPlace(el(["[data-confirmation]", "[data-assistant-pane]"]), false, false)).toBe("card");
    expect(focusPlace(el(["[data-assistant-pane]"]), false, false)).toBe("pane");
    expect(focusPlace(el([]), false, false)).toBe("elsewhere");
    expect(focusPlace(el(["[data-assistant-pane]"]), true, false)).toBe("input");
    expect(focusPlace(el(["[data-assistant-pane]"]), false, true)).toBe("slot");
    expect(focusPlace(null, false, false)).toBe("elsewhere");
  });
});
