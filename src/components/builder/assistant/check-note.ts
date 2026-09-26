import { splitObservation, type Observation } from "@/lib/assistant/observation";
import type { RecordEntry } from "./record-projection";

/**
 * The note's words and the answer's withholding: one pure owner of what
 * the check's line displays for each lifecycle state and each failure
 * code, and of the one sentence the answer no longer repeats. The rule
 * that cuts the sentence is the server's own (observation.ts), so the
 * live projection and the recorded observation agree; the pane reads it,
 * it never re-decides it.
 */

/** The words the note leads with, section 6 A's. */
export const CHECKED_THE_MAP = "Checked the map.";
/** The line's words when the retained image is gone (item 6). */
export const IMAGE_NOT_KEPT = "The picture is not kept.";
/** The inspection's words where the receipt's compaction dropped the state identity's detail lists. */
export const STATE_DETAIL_NOT_KEPT = "layer and widget detail not kept";
/** The opened image's accessible name (item 4, the approved interaction). */
export const IMAGE_DIALOG_LABEL = "The image the model was given";
export const THUMBNAIL_LABEL = "Open the image the model was given";

const OBSERVATION_WORDS: Record<Exclude<Observation["state"], "captured">, string> = {
  awaited: "Looking at it.",
  silent: "The model said nothing about it.",
  interrupted: "The request stopped before the model described it.",
  unavailable: "The model's words were not kept.",
};
const INTERRUPTED_WORDS: Record<NonNullable<Observation["reason"]>, string> = {
  cancelled: "The request stopped before the model described it.",
  exhausted: "The request's budget ran out before the model described it.",
  failed: "The request failed before the model described it.",
};

/** The failure words for a check that produced no image (item 5): for a
 * person, no transport guidance, no method, path or status. */
const FAILURE_WORDS: Record<string, string> = {
  render_timeout: "The picture could not be taken in time.",
  render_unavailable: "This instance cannot take a picture of the map.",
  render_failed: "The picture could not be taken.",
  look_image_too_large: "The picture was too large to hand over at any size.",
  look_target_missing: "No map was named to look at.",
  not_found: "The map could not be found.",
  map_not_found: "The map could not be found.",
  invalid_request: "The map could not be found.",
  assistant_action_interrupted: "The look was stopped.",
  assistant_action_not_admitted: "This page does not allow a look at the map.",
};
export function checkFailureWords(code: string): string {
  return FAILURE_WORDS[code] ?? FAILURE_WORDS.render_failed;
}

/** The observation's displayed text for an entry: the recorded sentence
 * once captured, the provisional first sentence of the live text while
 * awaited, or the state's own words. */
export function observationWords(entry: Pick<RecordEntry, "observation">, liveText?: string): { text: string; provisional: boolean } {
  const observation = entry.observation;
  if (!observation) return { text: "", provisional: false };
  if (observation.state === "captured") return { text: observation.text ?? "", provisional: false };
  if (observation.state === "awaited" && liveText !== undefined && observation.at !== undefined) {
    const { displayed } = splitObservation(liveText.slice(observation.at));
    if (displayed) return { text: displayed, provisional: true };
  }
  if (observation.state === "interrupted") return { text: INTERRUPTED_WORDS[observation.reason ?? "cancelled"], provisional: false };
  return { text: OBSERVATION_WORDS[observation.state], provisional: false };
}

/** The answer's text with each check's displayed sentence withheld once,
 * from where the observation began; the tail of an overlong sentence and
 * every later segment keep their order (D2). */
export function withholdObservations(text: string, entries: RecordEntry[]): string {
  const cuts: { from: number; length: number }[] = [];
  for (const entry of entries) {
    const observation = entry.observation;
    if (!observation || observation.at === undefined) continue;
    const displayed = observation.state === "captured" ? observation.text ?? ""
      : observation.state === "awaited" ? splitObservation(text.slice(observation.at)).displayed : "";
    if (!displayed) continue;
    const slice = text.slice(observation.at);
    const lead = slice.length - slice.trimStart().length;
    if (!slice.slice(lead).startsWith(displayed)) continue;
    cuts.push({ from: observation.at + lead, length: displayed.length });
  }
  // Two checks awaiting at one offset name one cut: overlapping ranges are
  // merged, so no answer text goes that neither note displays.
  cuts.sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];
  for (const cut of cuts) {
    const to = cut.from + cut.length;
    const last = merged[merged.length - 1];
    if (last && cut.from <= last.to) last.to = Math.max(last.to, to);
    else merged.push({ from: cut.from, to });
  }
  let out = text;
  for (const range of merged.reverse()) out = out.slice(0, range.from) + out.slice(range.to);
  return out;
}

/** Whether an entry is the map check's. */
export const isCheckEntry = (entry: Pick<RecordEntry, "tool">) => entry.tool === "look_at_map";
