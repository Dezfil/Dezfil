/**
 * The observation: a separate fact attached to a check when the model's
 * subsequent text arrives, with a lifecycle the receipt keeps
 * distinguishable, and one sentence rule the server's capture and the
 * pane's live projection both read. Isomorphic and pure: no I/O, no DOM,
 * no markdown; delimiters stay as typed and the pane renders the
 * displayed text literally.
 */

export type ObservationState = "awaited" | "captured" | "silent" | "interrupted" | "unavailable";
export type ObservationReason = "cancelled" | "exhausted" | "failed";

export interface Observation {
  state: ObservationState;
  /** The displayed sentence, on a captured observation. */
  text?: string;
  /** Where in the run's text the observation begins: the text's length
   * when the check settled. The displayed sentence is withheld from the
   * answer exactly once, from there. */
  at?: number;
  /** Why no observation came, on an interrupted one. */
  reason?: ObservationReason;
}

/** The most the note displays, in characters. */
export const OBSERVATION_MAX = 240;

/** The end of the first sentence in `text`, exclusive, or -1 while none
 * has closed: a terminator followed by whitespace or the end, or a
 * paragraph break. A dot inside a number or an ellipsis is not an end. */
function sentenceEnd(text: string): number {
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "\n" && text[i + 1] === "\n") return i;
    if (c !== "." && c !== "!" && c !== "?") continue;
    const next = text[i + 1];
    if (next === undefined) return c === "." && text[i - 1] === "." ? -1 : i + 1;
    if (c === "." && next === ".") continue;
    if (c === "." && text[i - 1] === "." ) continue;
    if (/\s/.test(next)) {
      if (c === "." && /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 2] ?? "")) continue;
      return i + 1;
    }
  }
  return -1;
}

/** Cut to at most `max` characters at a word boundary, trailing space removed. */
function cutAtWord(sentence: string, max = OBSERVATION_MAX): string {
  if (sentence.length <= max) return sentence;
  const head = sentence.slice(0, max);
  const space = head.lastIndexOf(" ");
  return (space > 0 ? head.slice(0, space) : head).trimEnd();
}

/** Split the text that follows a check into the sentence the note
 * displays and the rest the answer keeps, in order. `complete` is false
 * while the first sentence has not closed, so a live projection shows a
 * provisional line and settles once it does. */
export function splitObservation(after: string): { displayed: string; rest: string; complete: boolean } {
  const lead = after.length - after.trimStart().length;
  const body = after.slice(lead);
  if (body.length === 0) return { displayed: "", rest: after, complete: false };
  const end = sentenceEnd(body);
  const sentence = end >= 0 ? body.slice(0, end) : body;
  const displayed = cutAtWord(sentence.trimEnd());
  const rest = after.slice(lead + displayed.length);
  return { displayed, rest, complete: end >= 0 };
}
