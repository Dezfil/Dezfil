import { describe, expect, it } from "vitest";
import { defaultStyle } from "./defaults";
import { normalizeStyle, styleProblem } from "./style";

/**
 * A label's two choices, text and halo, each "automatic" (follows the map)
 * or "own" (the label's colours). What a write may send, checked value by
 * value before the choices are resolved, and how a label stored before the
 * choices existed reads: it follows the map only when it still carries the
 * whole old starting paint, and keeps its own paint in every other case.
 */

const WHITE = { r: 255, g: 255, b: 255, a: 1 };
// The halo colour every earlier label started with, written out here rather
// than read from the code under test.
const OLD_HALO = { r: 12, g: 16, b: 24, a: 0.8 };
const INK = { r: 20, g: 30, b: 40, a: 1 };

const INCOMPLETE =
  "label.haloWidth and label.haloColor go together: send both for a halo of the label's own, or neither for one that follows the map.";

const style = (label: Record<string, unknown>) => ({
  ...defaultStyle("POINT"),
  label: { attribute: "name", size: 12, ...label },
});
const problem = (label: Record<string, unknown>) => styleProblem(style(label));

describe("what a label write may send", () => {
  it("takes a label with no paint, or either part on its own", () => {
    expect(problem({})).toBeNull();
    expect(problem({ color: INK })).toBeNull();
    expect(problem({ haloWidth: 1, haloColor: INK })).toBeNull();
    expect(problem({ textPaint: "automatic", haloPaint: "automatic" })).toBeNull();
    expect(problem({ textPaint: "own", color: INK, haloPaint: "own", haloWidth: 0, haloColor: INK })).toBeNull();
  });

  it("refuses a choice it does not know, naming the two it takes", () => {
    expect(problem({ textPaint: "auto" })).toBe('label.textPaint accepts "automatic" or "own".');
    expect(problem({ textPaint: null })).toBe('label.textPaint accepts "automatic" or "own".');
    expect(problem({ haloPaint: "custom", haloWidth: 1, haloColor: INK })).toBe('label.haloPaint accepts "automatic" or "own".');
  });

  it("refuses one halo value sent without a choice, and an own halo missing one", () => {
    expect(problem({ haloWidth: 1 })).toBe(INCOMPLETE);
    expect(problem({ haloColor: INK })).toBe(INCOMPLETE);
    expect(problem({ haloPaint: "own" })).toBe(INCOMPLETE);
    expect(problem({ haloPaint: "own", haloWidth: 1 })).toBe(INCOMPLETE);
    expect(problem({ haloPaint: "own", haloColor: INK })).toBe(INCOMPLETE);
  });

  it("takes an explicit automatic halo with one valid value beside it", () => {
    expect(problem({ haloPaint: "automatic", haloWidth: 2 })).toBeNull();
    expect(problem({ haloPaint: "automatic", haloColor: INK })).toBeNull();
  });

  it("refuses an own text without its colour, in the colour's own wording", () => {
    expect(problem({ textPaint: "own" })).toBe("label needs a valid color.");
  });

  it("checks every value sent, even one an explicit automatic overrides", () => {
    expect(problem({ textPaint: "automatic", color: { r: 999, g: 0, b: 0, a: 1 } })).toBe("label needs a valid color.");
    expect(problem({ haloPaint: "automatic", haloWidth: 9 })).toBe(
      "label.haloWidth must be a number, 0 to 3 (0 = no halo).",
    );
    expect(problem({ haloPaint: "automatic", haloColor: "red" })).toBe("label.haloColor must be a valid color.");
  });

  it("checks the values before it asks whether the halo is complete", () => {
    expect(problem({ haloWidth: 9 })).toBe("label.haloWidth must be a number, 0 to 3 (0 = no halo).");
    expect(problem({ haloColor: "red" })).toBe("label.haloColor must be a valid color.");
    expect(problem({ haloWidth: 1, weight: "heavy" })).toBe('label.weight accepts "normal" or "bold".');
  });

  it("keeps the label's other required setting", () => {
    expect(problem({ size: undefined })).toBe("label.size must be a number of pixels, 1 to 72.");
  });
});

describe("a label stored before the choices existed", () => {
  const read = (label: Record<string, unknown>) => normalizeStyle(style(label)).label;

  it("follows the map when it carries the whole old starting paint", () => {
    const label = { color: WHITE, haloWidth: 0, haloColor: OLD_HALO, weight: "bold", density: 0.25 };
    expect(read(label)).toEqual({
      attribute: "name", size: 12, ...label, textPaint: "automatic", haloPaint: "automatic",
    });
  });

  it("keeps its own paint, text and halo alike, in every other case", () => {
    const cases: Record<string, Record<string, unknown>> = {
      "white with a visible halo": { color: WHITE, haloWidth: 1, haloColor: OLD_HALO },
      "text in another colour": { color: INK, haloWidth: 0, haloColor: OLD_HALO },
      "white that is not opaque": { color: { ...WHITE, a: 0.9 }, haloWidth: 0, haloColor: OLD_HALO },
      "a width-0 halo in another colour": { color: WHITE, haloWidth: 0, haloColor: { ...OLD_HALO, a: 1 } },
    };
    for (const [name, label] of Object.entries(cases)) {
      expect(read(label), name).toEqual({
        attribute: "name", size: 12, ...label, textPaint: "own", haloPaint: "own",
      });
    }
  });

  it("reads the old boolean halo first, then compares", () => {
    expect(read({ color: WHITE, halo: false })).toEqual({
      attribute: "name", size: 12, color: WHITE, haloWidth: 0, haloColor: OLD_HALO,
      textPaint: "automatic", haloPaint: "automatic",
    });
    expect(read({ color: WHITE, halo: true })).toEqual({
      attribute: "name", size: 12, color: WHITE, haloWidth: 1, haloColor: OLD_HALO,
      textPaint: "own", haloPaint: "own",
    });
    expect(read({ color: INK, halo: false })).toMatchObject({ textPaint: "own", haloPaint: "own" });
  });

  it("reads the same however often it is read", () => {
    const once = normalizeStyle(style({ color: WHITE, haloWidth: 0, haloColor: OLD_HALO }));
    expect(normalizeStyle(once)).toEqual(once);
    const own = normalizeStyle(style({ color: INK, haloWidth: 1, haloColor: OLD_HALO }));
    expect(normalizeStyle(own)).toEqual(own);
  });

  it("never infers anything for a label that carries its choices", () => {
    const explicit = { color: WHITE, haloWidth: 0, haloColor: OLD_HALO, textPaint: "own", haloPaint: "own" };
    expect(read(explicit)).toEqual({ attribute: "name", size: 12, ...explicit });
    const mixed = { color: INK, haloWidth: 0, haloColor: OLD_HALO, textPaint: "own", haloPaint: "automatic" };
    expect(read(mixed)).toEqual({ attribute: "name", size: 12, ...mixed });
  });
});
