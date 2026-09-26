import { describe, it, expect } from "vitest";
import {
  EditorState,
  EditorSelection,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { insertAtCursorSpec, replaceAllSpec } from "./sql-editor-handle";

/** The table-click contract: a click writes the
 * whole statement — replacing any draft, idempotently — and the caret
 * lands at the end so typing continues from there. */
describe("replaceAllSpec", () => {
  it("replaces a hand-edited draft entirely", () => {
    const state = EditorState.create({
      doc: "SELECT count(*) FROM old_table WHERE x > 1",
      selection: EditorSelection.cursor(7),
    });
    const next = state.update(replaceAllSpec(state, "SELECT * FROM fresh"));
    expect(next.state.doc.toString()).toBe("SELECT * FROM fresh");
    expect(next.state.selection.main.head).toBe("SELECT * FROM fresh".length);
  });

  it("is idempotent — writing the same statement twice leaves one", () => {
    const first = EditorState.create({ doc: "" });
    const once = first.update(replaceAllSpec(first, "SELECT * FROM t"));
    const twice = once.state.update(
      replaceAllSpec(once.state, "SELECT * FROM t"),
    );
    expect(twice.state.doc.toString()).toBe("SELECT * FROM t");
  });

  it("a second table swaps the statement, never concatenates", () => {
    const first = EditorState.create({ doc: "" });
    const a = first.update(replaceAllSpec(first, "SELECT * FROM a"));
    const b = a.state.update(replaceAllSpec(a.state, "SELECT * FROM b"));
    expect(b.state.doc.toString()).toBe("SELECT * FROM b");
  });

  it("works on an empty document", () => {
    const state = EditorState.create({ doc: "" });
    const next = state.update(replaceAllSpec(state, "SELECT 1"));
    expect(next.state.doc.toString()).toBe("SELECT 1");
    expect(next.state.selection.main.head).toBe(8);
  });
});

/** The workspace-chip contract:
 * a chip click inserts at the caret, mid-text, never an append, and
 * the caret advances so a second insert continues from there. */
describe("insertAtCursorSpec", () => {
  const at = (doc: string, pos: number) =>
    EditorState.create({ doc, selection: EditorSelection.cursor(pos) });

  it("inserts at a mid-text cursor, not at the end", () => {
    const state = at("SELECT  FROM wind_farms", 7);
    const next = state.update(insertAtCursorSpec(state, "name"));
    expect(next.state.doc.toString()).toBe("SELECT name FROM wind_farms");
    expect(next.state.selection.main.head).toBe(11);
  });

  it("replaces an active selection instead of appending beside it", () => {
    const state = EditorState.create({
      doc: "SELECT old FROM t",
      selection: EditorSelection.range(7, 10),
    });
    const next = state.update(insertAtCursorSpec(state, "fresh"));
    expect(next.state.doc.toString()).toBe("SELECT fresh FROM t");
    expect(next.state.selection.main.head).toBe(12);
  });

  it("chains: a second insert lands after the first, not at doc end", () => {
    const first = at("FROM ", 5);
    const afterFirst = first.update(insertAtCursorSpec(first, "a"));
    const second = afterFirst.state.update(
      insertAtCursorSpec(afterFirst.state, "b"),
    );
    expect(second.state.doc.toString()).toBe("FROM ab");
    expect(second.state.selection.main.head).toBe(7);
  });

  it("works on an empty document", () => {
    const state = at("", 0);
    const next = state.update(insertAtCursorSpec(state, "SELECT"));
    expect(next.state.doc.toString()).toBe("SELECT");
    expect(next.state.selection.main.head).toBe(6);
  });
});

/** The replacement is its own undo step: typed text
 * followed at once by a host replacement undoes back to the typed text,
 * not past it. */
describe("replaceAllSpec · undo isolation", () => {
  it("undo after a replacement restores the typed draft, keystrokes included", async () => {
    const { history, undo } = await import("@codemirror/commands");
    let state = EditorState.create({ doc: "SELECT 1", extensions: [history()] });
    const apply = (spec: TransactionSpec | Transaction) => {
      state = spec instanceof Transaction ? spec.state : state.update(spec).state;
    };
    // Two keystrokes in the same moment as the replacement.
    apply({ changes: { from: 8, insert: " -" }, selection: { anchor: 10 }, userEvent: "input.type" });
    apply({ changes: { from: 10, insert: "-" }, selection: { anchor: 11 }, userEvent: "input.type" });
    apply(replaceAllSpec(state, "SELECT * FROM t"));
    expect(state.doc.toString()).toBe("SELECT * FROM t");
    undo({ state, dispatch: (tr) => apply(tr) });
    expect(state.doc.toString()).toBe("SELECT 1 --");
  });
});
