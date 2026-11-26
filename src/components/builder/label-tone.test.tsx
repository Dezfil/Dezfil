import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { builderLabelTone, LabelToneContext, useLabelTone } from "./label-tone";

/**
 * The builder keeps the tone its canvas reports it painted labels for and
 * hands it down, so the Label section resolves an automatic label's colours
 * from the tone the map shows rather than from the stored fallbacks.
 */

function Shown() {
  return <>{useLabelTone()}</>;
}

describe("the tone the builder hands down", () => {
  it("is the style's own until the canvas reports, then what the canvas reported, an offline fallback included", () => {
    expect(builderLabelTone(null, "dark")).toBe("dark");
    expect(builderLabelTone("light", "dark")).toBe("light");
    expect(builderLabelTone("dark", "dark")).toBe("dark");
  });

  it("reaches what reads it below the builder, and is light where no builder is above", () => {
    expect(renderToStaticMarkup(<LabelToneContext.Provider value="dark"><Shown /></LabelToneContext.Provider>)).toBe("dark");
    expect(renderToStaticMarkup(<Shown />)).toBe("light");
  });

  it("is fed by the builder's own canvas: its report channel goes to the canvas and its record is provided", () => {
    const builder = readFileSync("src/components/builder/MapBuilder.tsx", "utf8");
    const [, reported, channel] = /const \[(\w+), (\w+)\] = useReportedLabelTone\(\);/.exec(builder) ?? [];
    expect(reported, "the builder keeps the canvas's report").toBeDefined();
    expect(builder).toMatch(new RegExp(`canvas=\\{\\{[^}]*\\b${channel},`));
    expect(builder).toMatch(new RegExp(`<LabelToneContext\\.Provider value=\\{builderLabelTone\\(${reported}, effBasemap\\.labelTone\\)\\}>`));
  });
});
