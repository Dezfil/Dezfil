import { describe, expect, it } from "vitest";
import { canvasTakesSelectAll, clearStraySelection, isSelectAll } from "./page-selection";

/**
 * The page's text selection and the canvas. Seen red once against no
 * module: the chord and the press did nothing, and the page selected
 * itself.
 */

const chord = (over: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({
  key: "a",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe("the select-all chord", () => {
  it("is ⌘A on macOS and Ctrl+A elsewhere, either case", () => {
    expect(isSelectAll(chord({ metaKey: true }))).toBe(true);
    expect(isSelectAll(chord({ ctrlKey: true }))).toBe(true);
    expect(isSelectAll(chord({ metaKey: true, key: "A" }))).toBe(true);
  });

  it("is not a bare A, nor a chord with another modifier or another key", () => {
    expect(isSelectAll(chord({}))).toBe(false);
    expect(isSelectAll(chord({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isSelectAll(chord({ metaKey: true, altKey: true }))).toBe(false);
    expect(isSelectAll(chord({ metaKey: true, key: "z" }))).toBe(false);
  });

  it("is the canvas's only when no control of its own owns the key", () => {
    const field = {} as EventTarget;
    const ground = {} as EventTarget;
    const owns = (t: EventTarget | null) => t === field;
    expect(canvasTakesSelectAll({ ...chord({ metaKey: true }), target: ground }, owns)).toBe(true);
    expect(canvasTakesSelectAll({ ...chord({ metaKey: true }), target: null }, owns)).toBe(true);
    expect(canvasTakesSelectAll({ ...chord({ metaKey: true }), target: field }, owns)).toBe(false);
    // Not the chord: the canvas takes nothing, wherever it landed.
    expect(canvasTakesSelectAll({ ...chord({}), target: ground }, owns)).toBe(false);
  });
});

describe("a press on the canvas and a stray selection", () => {
  const fakeSelection = (rangeCount: number, collapsed: boolean) => {
    let cleared = 0;
    const sel = { rangeCount, isCollapsed: collapsed, removeAllRanges: () => (cleared += 1) } as unknown as Selection;
    return { sel, cleared: () => cleared };
  };

  it("clears a selection swept elsewhere on the page", () => {
    const s = fakeSelection(1, false);
    expect(clearStraySelection({} as EventTarget, () => false, () => s.sel)).toBe(true);
    expect(s.cleared()).toBe(1);
  });

  it("leaves nothing to clear alone: no range, a collapsed caret, no selection object", () => {
    const none = fakeSelection(0, true);
    expect(clearStraySelection({} as EventTarget, () => false, () => none.sel)).toBe(false);
    expect(none.cleared()).toBe(0);
    const caret = fakeSelection(1, true);
    expect(clearStraySelection({} as EventTarget, () => false, () => caret.sel)).toBe(false);
    expect(caret.cleared()).toBe(0);
    expect(clearStraySelection({} as EventTarget, () => false, () => null)).toBe(false);
  });

  it("never touches a selection inside an editable control: the note's field keeps its own", () => {
    const s = fakeSelection(1, false);
    const field = {} as EventTarget;
    expect(clearStraySelection(field, (t) => t === field, () => s.sel)).toBe(false);
    expect(s.cleared()).toBe(0);
  });
});
