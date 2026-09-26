import { describe, it, expect } from "vitest";
import { StringStream } from "@codemirror/language";
import { overpassParser } from "./overpass-language";

/** Drive the tokenizer the way the editor would — line by line through
 * a StringStream — and collect (style, text) pairs. */
function tokenize(lines: string[]) {
  const state = overpassParser.startState!(2);
  const out: { style: string | null; text: string }[] = [];
  for (const line of lines) {
    const stream = new StringStream(line, 4, 2);
    while (!stream.eol()) {
      stream.start = stream.pos;
      const style = overpassParser.token(stream, state);
      out.push({ style, text: stream.current() });
    }
  }
  return out;
}

const styleOf = (tokens: ReturnType<typeof tokenize>, text: string) =>
  tokens.find((t) => t.text === text)?.style;

describe("overpassParser", () => {
  it("colors the builder's own generated query shape", () => {
    const tokens = tokenize([
      '[out:json][timeout:60][maxsize:536870912];',
      '(node["amenity"="restaurant"]({{bbox}});',
      'way["amenity"="restaurant"]({{bbox}}););',
      "out geom;",
    ]);
    expect(styleOf(tokens, "out")).toBe("keyword");
    expect(styleOf(tokens, "timeout")).toBe("keyword");
    expect(styleOf(tokens, "node")).toBe("keyword");
    expect(styleOf(tokens, "way")).toBe("keyword");
    expect(styleOf(tokens, "geom")).toBe("keyword");
    expect(styleOf(tokens, '"amenity"')).toBe("string");
    expect(styleOf(tokens, "60")).toBe("number");
    expect(styleOf(tokens, "{{bbox}}")).toBe("atom");
  });

  it("keeps unknown identifiers unstyled", () => {
    const tokens = tokenize(["mystery_word;"]);
    expect(styleOf(tokens, "mystery_word")).toBeNull();
  });

  it("carries a block comment across lines and closes it", () => {
    const tokens = tokenize(["/* first", "second */ out;"]);
    expect(tokens[0]).toEqual({ style: "comment", text: "/* first" });
    expect(styleOf(tokens, "second */")).toBe("comment");
    expect(styleOf(tokens, "out")).toBe("keyword");
  });

  it("treats line comments as comments to end of line", () => {
    const tokens = tokenize(["out; // trailing note"]);
    expect(styleOf(tokens, "// trailing note")).toBe("comment");
  });
});
