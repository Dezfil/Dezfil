/**
 * A note's text: the label read from a leading fenced block as the API
 * documents it, the body that remains, and the length in the API's own
 * measure. Pure; the rendering is the app's note markdown with the
 * canvas's additions, called by the note.
 */

/** The API's limit, in the measure it uses (a string's length). */
export const NOTE_TEXT_MAX = 4_000;

/** A new note's text: the label line alone. */
export const NEW_NOTE_TEXT = "---\nlabel: note\n---\n";

export interface NoteText {
  /** The label, trimmed; null when the text carries none. */
  label: string | null;
  /** The text without the leading block. */
  body: string;
}

/**
 * The leading block is fenced by `---` lines; its first `label:` line's
 * trimmed value is the label; a blank value or no such line is no label;
 * a leading `---` with no closing fence is body text.
 */
export function readNoteText(text: string): NoteText {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return { label: null, body: text.replace(/\r\n/g, "\n") };
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (close === -1) return { label: null, body: lines.join("\n") };
  const block = lines.slice(1, close);
  const labelLine = block.find((l) => /^\s*label\s*:/i.test(l));
  const value = labelLine ? labelLine.replace(/^\s*label\s*:/i, "").trim() : "";
  return { label: value || null, body: lines.slice(close + 1).join("\n") };
}

/** The text's length as the API counts it. */
export function noteLength(text: string): number {
  return text.length;
}

/** The text cut to the API's limit, in its measure. */
export function clampNoteText(text: string): string {
  return text.length > NOTE_TEXT_MAX ? text.slice(0, NOTE_TEXT_MAX) : text;
}

/**
 * The placeholder an empty note's editor shows: only while the raw body
 * is empty, so any first character, a space or a line break included,
 * replaces it; its lead is one blank line per line break the text
 * already holds, so it starts on the caret's line after the label block.
 * Null when the editor shows none.
 */
export function notePlaceholder(text: string): { lead: string } | null {
  if (readNoteText(text).body !== "") return null;
  const breaks = (text.match(/\n/g) ?? []).length;
  // A text that ends without a line break (an API-written label block)
  // has its caret's line still to come.
  return { lead: "\n".repeat(text === "" || text.endsWith("\n") ? breaks : breaks + 1) };
}

/**
 * The text an editor opens on: a label block that ends the text with no
 * line break after it gets one, so the caret starts the body's line and
 * the first character cannot join the closing fence (found at review).
 * Any other text opens verbatim.
 */
export function noteOpeningText(text: string): string {
  return text !== "" && !text.endsWith("\n") && readNoteText(text).body === "" ? `${text}\n` : text;
}

/** The accessible name of a note: its label, or *Note*. */
export function noteName(text: string): string {
  const { label } = readNoteText(text);
  return label ? `Note, ${label}` : "Note";
}
