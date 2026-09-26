import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  errorMarkExtensions,
  errorMarkField,
  referencedTables,
  setErrorMark,
  tokenRangeAt,
} from "./sql-editor-extensions";

describe("referencedTables", () => {
  const known = ["berlin_cafes", "districts", "routes"];
  it("finds tables after FROM and JOIN, once each, known only", () => {
    expect(
      referencedTables(
        'SELECT * FROM berlin_cafes c JOIN "districts" d ON 1 JOIN nope n ON 1 JOIN berlin_cafes x ON 1',
        known,
      ),
    ).toEqual(["berlin_cafes", "districts"]);
  });
  it("ignores a subquery keyword and an alias-only reference", () => {
    expect(referencedTables("SELECT * FROM (SELECT 1) AS q", known)).toEqual([]);
  });
});

describe("tokenRangeAt", () => {
  const doc = EditorState.create({ doc: "SELECT *\nFROM nope_table) AS q\n" }).doc;
  it("marks the identifier run containing the column", () => {
    const r = tokenRangeAt(doc, { line: 2, column: 6 });
    expect(doc.sliceString(r.from, r.to)).toBe("nope_table");
    expect(r.lineFrom).toBe(doc.line(2).from);
  });
  it("marks one glyph when the caret sits on punctuation", () => {
    const r = tokenRangeAt(doc, { line: 2, column: 16 });
    expect(doc.sliceString(r.from, r.to)).toBe(")");
  });
  it("clamps an out-of-range position to the document", () => {
    const r = tokenRangeAt(doc, { line: 99, column: 99 });
    expect(r.lineFrom).toBe(doc.line(doc.lines).from);
  });
});

describe("the error mark field", () => {
  it("sets on the effect and clears on the next edit", () => {
    let state = EditorState.create({
      doc: "SELECT *\nFROM nope",
      extensions: [errorMarkExtensions()],
    });
    state = state.update({ effects: setErrorMark.of({ line: 2, column: 6 }) }).state;
    let n = 0;
    state.field(errorMarkField).between(0, state.doc.length, () => { n++; });
    expect(n).toBe(2); // the line wash and the token underline
    state = state.update({ changes: { from: 0, insert: " " } }).state;
    let after = 0;
    state.field(errorMarkField).between(0, state.doc.length, () => { after++; });
    expect(after).toBe(0);
    state = state.update({ effects: setErrorMark.of({ line: 1, column: 1 }) }).state;
    state = state.update({ effects: setErrorMark.of(null) }).state;
    let cleared = 0;
    state.field(errorMarkField).between(0, state.doc.length, () => { cleared++; });
    expect(cleared).toBe(0);
  });
});
