import { describe, expect, it } from "vitest";
import { defaultStyle } from "./defaults";
import { fallbackLabelTone, LABEL_RECIPES, labelStyleForWrite, withLabelFallbacks } from "./label-recipe";
import type { LabelStyle, LayerStyle } from "./style";

/**
 * The fixed paint an automatic label is answered with: the light-appearance
 * recipe for the map's basemap as saved, written out here as the hex values
 * the recipe names rather than read back from the code under test.
 */

const LIGHT = {
  color: { r: 0x24, g: 0x32, b: 0x30, a: 1 },
  haloWidth: 1.5,
  haloColor: { r: 255, g: 255, b: 255, a: 1 },
};
const DARK = {
  color: { r: 0xe9, g: 0xec, b: 0xf3, a: 1 },
  haloWidth: 1.5,
  haloColor: { r: 0x0b, g: 0x0e, b: 0x14, a: 1 },
};
const OWN = { r: 200, g: 40, b: 40, a: 0.7 };

const labelled = (label: Partial<LabelStyle>): LayerStyle => ({
  ...defaultStyle("POINT"),
  label: { attribute: "name", size: 12, color: OWN, haloWidth: 2, haloColor: OWN, ...label },
});

describe("the two recipes", () => {
  it("are the light and dark paints, opaque, with a 1.5 halo", () => {
    expect(LABEL_RECIPES).toEqual({ light: LIGHT, dark: DARK });
  });
});

describe("the tone a map's saved basemap gives its fallbacks", () => {
  const tone = (basemap: string | null, custom = false) =>
    fallbackLabelTone({ basemap: basemap as never, customBasemap: custom ? { url: "https://example.test/style.json" } : null });

  it("is light for Light, Streets, Auto and a custom style; dark for Dark and Satellite", () => {
    expect(tone("light")).toBe("light");
    expect(tone("streets")).toBe("light");
    expect(tone(null)).toBe("light");
    expect(tone("dark")).toBe("dark");
    expect(tone("satellite")).toBe("dark");
    // A custom style's tone is not known: the light recipe, whatever key it sits on.
    expect(tone("dark", true)).toBe("light");
    expect(tone("satellite", true)).toBe("light");
  });
});

describe("filling the fallbacks", () => {
  it("fills each automatic part with its tone's recipe and keeps an own part exactly", () => {
    expect(withLabelFallbacks(labelled({ textPaint: "automatic", haloPaint: "automatic" }), "dark").label).toEqual({
      attribute: "name", size: 12, textPaint: "automatic", haloPaint: "automatic", ...DARK,
    });
    expect(withLabelFallbacks(labelled({ textPaint: "automatic", haloPaint: "own" }), "light").label).toEqual({
      attribute: "name", size: 12, textPaint: "automatic", haloPaint: "own", color: LIGHT.color, haloWidth: 2, haloColor: OWN,
    });
    expect(withLabelFallbacks(labelled({ textPaint: "own", haloPaint: "automatic" }), "light").label).toEqual({
      attribute: "name", size: 12, textPaint: "own", haloPaint: "automatic", color: OWN,
      haloWidth: LIGHT.haloWidth, haloColor: LIGHT.haloColor,
    });
  });

  it("leaves a style without a label, and an own label, as they are", () => {
    const plain = defaultStyle("POINT");
    expect(withLabelFallbacks(plain, "dark")).toBe(plain);
    const own = labelled({ textPaint: "own", haloPaint: "own" });
    expect(withLabelFallbacks(own, "dark")).toEqual(own);
  });

  it("never changes the style it is given", () => {
    const style = labelled({ textPaint: "automatic", haloPaint: "automatic" });
    const before = structuredClone(style);
    withLabelFallbacks(style, "dark");
    expect(style).toEqual(before);
  });
});

describe("a label as a write stores it", () => {
  const write = (label: Record<string, unknown>, basemap: string | null = "light") =>
    labelStyleForWrite({ ...defaultStyle("POINT"), label: { attribute: "name", size: 12, ...label } } as LayerStyle,
      { basemap: basemap as never, customBasemap: null }).label;

  it("follows the map for each part that sends nothing, with that tone's recipe", () => {
    expect(write({}, "dark")).toEqual({ attribute: "name", size: 12, textPaint: "automatic", haloPaint: "automatic", ...DARK });
  });

  it("keeps a colour sent without a choice as the label's own", () => {
    expect(write({ color: OWN })).toEqual({
      attribute: "name", size: 12, textPaint: "own", color: OWN,
      haloPaint: "automatic", haloWidth: LIGHT.haloWidth, haloColor: LIGHT.haloColor,
    });
    expect(write({ haloWidth: 0, haloColor: OWN })).toEqual({
      attribute: "name", size: 12, textPaint: "automatic", color: LIGHT.color,
      haloPaint: "own", haloWidth: 0, haloColor: OWN,
    });
  });

  it("lets an explicit automatic override the values sent beside it, the halo width included", () => {
    expect(write({ textPaint: "automatic", color: OWN, haloPaint: "automatic", haloWidth: 3 }, "satellite")).toEqual({
      attribute: "name", size: 12, textPaint: "automatic", haloPaint: "automatic", ...DARK,
    });
  });

  it("keeps the old starting paint as the label's own when no choice is sent", () => {
    const old = { color: { r: 255, g: 255, b: 255, a: 1 }, haloWidth: 0, haloColor: { r: 12, g: 16, b: 24, a: 0.8 } };
    expect(write(old)).toEqual({ attribute: "name", size: 12, ...old, textPaint: "own", haloPaint: "own" });
  });

  it("leaves a style without a label alone", () => {
    const plain = defaultStyle("POINT");
    expect(labelStyleForWrite(plain, { basemap: "dark", customBasemap: null })).toBe(plain);
  });
});
