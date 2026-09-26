import { describe, expect, it } from "vitest";
import { OBSERVATION_MAX, splitObservation } from "./observation";

/**
 * The observation's sentence rule, one pure function the server's capture
 * and the pane's live projection both read: the first subsequent
 * sentence, at most 240 characters cut at a word boundary, withheld
 * exactly once from the text that follows a check, the tail of an
 * overlong sentence and every later segment kept in order, markdown
 * characters left as typed.
 */
describe("the first subsequent sentence, cut at a word boundary", () => {
  it("a short sentence is displayed whole and nothing else is withheld", () => {
    const split = splitObservation("Five greens read light to dark. The legend matches the ramp.");
    expect(split.displayed).toBe("Five greens read light to dark.");
    expect(split.rest).toBe(" The legend matches the ramp.");
    expect(split.complete).toBe(true);
  });
  it("a 400-character sentence is cut at a word boundary under 240 characters, its tail kept in the answer", () => {
    const words: string[] = [];
    for (let i = 0; words.join(" ").length < 400; i += 1) words.push(`word${i}`);
    const sentence = words.join(" ") + ".";
    const split = splitObservation(sentence + " Then more.");
    expect(split.displayed.length).toBeLessThanOrEqual(OBSERVATION_MAX);
    expect(split.displayed.length).toBeGreaterThan(OBSERVATION_MAX - 12);
    expect(split.displayed.endsWith(" ")).toBe(false);
    expect(sentence.startsWith(split.displayed)).toBe(true);
    // The cut falls between words: the next character of the sentence is the space.
    expect(sentence[split.displayed.length]).toBe(" ");
    expect(split.displayed + split.rest).toBe(sentence + " Then more.");
    expect(split.rest.trimStart().startsWith("word")).toBe(true);
  });
  it("split across arbitrary stream deltas, the accumulated text gives the same split, provisional until the sentence closes", () => {
    const whole = "The three parks sit east of the station. A fourth would help.";
    const close = whole.indexOf(".") + 1;
    for (const cut of [1, 5, 17, 18, close - 2, close - 1]) {
      const split = splitObservation(whole.slice(0, cut));
      expect(split.complete, `cut ${cut}`).toBe(false);
      expect(split.displayed, `cut ${cut}`).toBe(whole.slice(0, cut).trimEnd());
    }
    for (const cut of [close, close + 1, close + 5, whole.length]) {
      const split = splitObservation(whole.slice(0, cut));
      expect(split.complete, `cut ${cut}`).toBe(true);
      expect(split.displayed, `cut ${cut}`).toBe("The three parks sit east of the station.");
      expect(split.displayed + split.rest).toBe(whole.slice(0, cut));
    }
    expect(splitObservation(whole).rest).toBe(" A fourth would help.");
  });
  it("two identical consecutive sentences: exactly one is withheld", () => {
    const split = splitObservation("Looks fine. Looks fine.");
    expect(split.displayed).toBe("Looks fine.");
    expect(split.rest).toBe(" Looks fine.");
  });
  it("leading whitespace and a paragraph break are not part of the sentence; a sentence without a terminator ends at the paragraph", () => {
    expect(splitObservation("\n\nSeen it.\n\nMore.")).toEqual({ displayed: "Seen it.", rest: "\n\nMore.", complete: true });
    expect(splitObservation("No terminator here\n\nNext paragraph.")).toEqual({ displayed: "No terminator here", rest: "\n\nNext paragraph.", complete: true });
    expect(splitObservation("")).toEqual({ displayed: "", rest: "", complete: false });
    expect(splitObservation("   ")).toEqual({ displayed: "", rest: "   ", complete: false });
  });
  it("a decimal, an ellipsis and a question mark", () => {
    expect(splitObservation("About 3.5 hectares are shaded. Yes.").displayed).toBe("About 3.5 hectares are shaded.");
    expect(splitObservation("Is the ramp inverted? It seems so.").displayed).toBe("Is the ramp inverted?");
    expect(splitObservation("Hard to say... but likely.").displayed).toBe("Hard to say... but likely.");
  });
});

describe("markdown characters stay as typed", () => {
  it("delimiters are part of the displayed text, never interpreted here", () => {
    const split = splitObservation("**Five** greens read `light` to _dark_. More.");
    expect(split.displayed).toBe("**Five** greens read `light` to _dark_.");
    expect(split.rest).toBe(" More.");
  });
});
