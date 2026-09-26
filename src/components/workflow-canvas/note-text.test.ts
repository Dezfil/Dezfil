import { describe, it, expect } from "vitest";
import { clampNoteText, NEW_NOTE_TEXT, NOTE_TEXT_MAX, noteLength, noteName, noteOpeningText, notePlaceholder, readNoteText } from "./note-text";

describe("a note's text", () => {
  it("reads the label from a leading fenced block as the API documents it", () => {
    expect(readNoteText("---\nlabel: intake\n---\n## Intake\nrows")).toEqual({ label: "intake", body: "## Intake\nrows" });
    // A second line in the block does not unmake it; the first label: line wins.
    expect(readNoteText("---\ncolour: red\nlabel:  two words \nlabel: other\n---\nbody")).toEqual({ label: "two words", body: "body" });
    // A blank value, or no label line, is no label; the block is still not body.
    expect(readNoteText("---\nlabel:\n---\nbody")).toEqual({ label: null, body: "body" });
    expect(readNoteText("---\nnote: x\n---\nbody")).toEqual({ label: null, body: "body" });
    // No block at all; a leading fence with no closing fence is body text.
    expect(readNoteText("plain\ntext")).toEqual({ label: null, body: "plain\ntext" });
    expect(readNoteText("---\nlabel: lost\nbody")).toEqual({ label: null, body: "---\nlabel: lost\nbody" });
    // Windows line ends read the same.
    expect(readNoteText("---\r\nlabel: crlf\r\n---\r\nbody")).toEqual({ label: "crlf", body: "body" });
    expect(readNoteText(NEW_NOTE_TEXT)).toEqual({ label: "note", body: "" });
  });

  it("counts and clamps in the API's measure, where a character outside the basic plane is two", () => {
    expect(noteLength("abc")).toBe(3);
    expect(noteLength("a😀")).toBe(3);
    const long = "x".repeat(NOTE_TEXT_MAX - 2) + "😀";
    expect(noteLength(long)).toBe(NOTE_TEXT_MAX);
    expect(clampNoteText(long)).toBe(long);
    expect(clampNoteText(long + "y").length).toBe(NOTE_TEXT_MAX);
  });

  it("names a note by its label, or Note", () => {
    expect(noteName("---\nlabel: intake\n---\n")).toBe("Note, intake");
    expect(noteName("no label here")).toBe("Note");
  });
});

describe("the editor's placeholder", () => {
  it("shows on a new note, on the line after the label block", () => {
    expect(notePlaceholder(NEW_NOTE_TEXT)).toEqual({ lead: "\n\n\n" });
    expect(notePlaceholder("")).toEqual({ lead: "" });
  });
  it("starts on its own line when a label block ends the text without one; the editor opens on that line", () => {
    expect(notePlaceholder("---\nlabel: note\n---")).toEqual({ lead: "\n\n\n" });
    expect(noteOpeningText("---\nlabel: note\n---")).toBe(NEW_NOTE_TEXT);
    expect(noteOpeningText(NEW_NOTE_TEXT)).toBe(NEW_NOTE_TEXT);
    expect(noteOpeningText("")).toBe("");
    expect(noteOpeningText("body")).toBe("body");
    expect(noteOpeningText("---\nlabel: note\n---\nbody")).toBe("---\nlabel: note\n---\nbody");
  });
  it("goes at the first character, a space or a line break included", () => {
    expect(notePlaceholder(`${NEW_NOTE_TEXT}#`)).toBeNull();
    expect(notePlaceholder(`${NEW_NOTE_TEXT} `)).toBeNull();
    expect(notePlaceholder(`${NEW_NOTE_TEXT}\n`)).toBeNull();
    expect(notePlaceholder("x")).toBeNull();
  });
});
