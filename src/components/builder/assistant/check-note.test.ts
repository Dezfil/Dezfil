import { describe, expect, it } from "vitest";
import { checkFailureWords, observationWords, withholdObservations } from "./check-note";
import type { RecordEntry } from "./record-projection";

/**
 * The note's pure owner ('s pane half, 4c's words, 5a's note words and
 * 5f): the words per lifecycle state and per failure code, the
 * provisional sentence while awaited, and the answer with each
 * displayed sentence withheld once from where the observation began,
 * the tail and every later segment kept.
 */
const entry = (observation: RecordEntry["observation"]): RecordEntry => ({ id: "c", tool: "look_at_map", label: "Checked the map", status: "succeeded", inputs: [], omitted: false, observation });

describe("the words for each state and each failure", () => {
  it("captured shows the sentence; awaited shows the live text's first sentence provisionally, or its own words", () => {
    expect(observationWords(entry({ state: "captured", text: "Five greens.", at: 0 }))).toEqual({ text: "Five greens.", provisional: false });
    expect(observationWords(entry({ state: "awaited", at: 9 }), "Renamed.\n\nThe map shows")).toEqual({ text: "The map shows", provisional: true });
    expect(observationWords(entry({ state: "awaited", at: 9 }), "Renamed.\n\n")).toEqual({ text: "Looking at it.", provisional: false });
    expect(observationWords(entry({ state: "awaited" }))).toEqual({ text: "Looking at it.", provisional: false });
  });
  it("silent, interrupted by each reason, and unavailable each read distinctly, never as an empty line", () => {
    expect(observationWords(entry({ state: "silent" })).text).toBe("The model said nothing about it.");
    expect(observationWords(entry({ state: "interrupted", reason: "cancelled" })).text).toBe("The request stopped before the model described it.");
    expect(observationWords(entry({ state: "interrupted", reason: "exhausted" })).text).toBe("The request's budget ran out before the model described it.");
    expect(observationWords(entry({ state: "interrupted", reason: "failed" })).text).toBe("The request failed before the model described it.");
    expect(observationWords(entry({ state: "unavailable" })).text).toBe("The model's words were not kept.");
    for (const state of ["silent", "interrupted", "unavailable", "awaited"] as const) expect(observationWords(entry({ state })).text.length).toBeGreaterThan(0);
  });
  it("the failure words are for a person: no transport guidance, no method, path or status, no em dash", () => {
    const codes = ["render_timeout", "render_unavailable", "render_failed", "look_image_too_large", "look_target_missing", "not_found", "invalid_request", "assistant_action_interrupted", "assistant_action_not_admitted", "something_else"];
    for (const code of codes) {
      const words = checkFailureWords(code);
      expect(words.length, code).toBeGreaterThan(0);
      expect(words, code).not.toMatch(/\b(GET|POST|PATCH|DELETE|HTTP)\b|\/api\/|\b[45]\d\d\b|DEZFIL_|retry|—/i);
      expect(words, code).toMatch(/\.$/);
    }
    expect(checkFailureWords("render_timeout")).toBe("The picture could not be taken in time.");
  });
});

describe("withholding the displayed sentence from the answer", () => {
  it("withholds the captured sentence once from where the observation began, keeping the tail and later segments", () => {
    const text = "Renamed.\n\nFive greens read light to dark. The legend matches the ramp.";
    const entries = [entry({ state: "captured", text: "Five greens read light to dark.", at: 8 })];
    expect(withholdObservations(text, entries)).toBe("Renamed.\n\n The legend matches the ramp.");
  });
  it("two identical consecutive sentences: exactly one goes", () => {
    const text = "Done.\n\nLooks fine. Looks fine.";
    expect(withholdObservations(text, [entry({ state: "captured", text: "Looks fine.", at: 5 })])).toBe("Done.\n\n Looks fine.");
  });
  it("an overlong sentence's tail stays; the same sentence earlier in the answer is untouched", () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ") + ".";
    const displayed = long.slice(0, long.lastIndexOf(" ", 240));
    const text = `${displayed}\n\n${long} Then more.`;
    const out = withholdObservations(text, [entry({ state: "captured", text: displayed, at: displayed.length })]);
    expect(out.startsWith(displayed)).toBe(true);
    expect(out).toContain(long.slice(displayed.length));
    expect(out).toContain("Then more.");
  });
  it("awaited: the provisional first sentence is withheld live; nothing without an offset; nothing when the text moved on", () => {
    expect(withholdObservations("Renamed.\n\nThe map shows one", [entry({ state: "awaited", at: 8 })])).toBe("Renamed.\n\n");
    expect(withholdObservations("Renamed.\n\nThe map shows one.", [entry({ state: "awaited" })])).toBe("Renamed.\n\nThe map shows one.");
    expect(withholdObservations("Renamed.\n\nOther words.", [entry({ state: "captured", text: "Not there.", at: 8 })])).toBe("Renamed.\n\nOther words.");
    expect(withholdObservations("Renamed.", [entry({ state: "silent", at: 8 })])).toBe("Renamed.");
  });
});

describe("overlapping cuts are applied once", () => {
  it("two checks awaiting at the same offset withhold the sentence once and keep the rest", () => {
    const text = "Done.\n\nFirst sentence. Second sentence stays.";
    const entries = [entry({ state: "awaited", at: 5 }), { ...entry({ state: "awaited", at: 5 }), id: "d" }];
    expect(withholdObservations(text, entries)).toBe("Done.\n\n Second sentence stays.");
    const captured = [entry({ state: "captured", text: "First sentence.", at: 5 }), { ...entry({ state: "captured", text: "First sentence.", at: 5 }), id: "d" }];
    expect(withholdObservations(text, captured)).toBe("Done.\n\n Second sentence stays.");
  });
});
