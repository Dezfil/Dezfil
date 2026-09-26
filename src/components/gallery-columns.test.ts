import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The gallery's column arithmetic, checked rather than eyeballed (the
 * a later sitting, item 1). The defect this ratchets against:
 * the workspace container's content box SHRANK 48px the moment the
 * viewport out-grew the 1720px breakpoint — beyond it the side paddings
 * count inside the border-box cap; below it they are zeroed — and the
 * card tracks were tuned to exactly the pre-shrink width, so a *wider*
 * window showed *fewer* cards. Every value here is parsed from the live
 * stylesheets; only the column intents (Maps shows four abreast at the
 * cap, Data five) and the classic-scrollbar loss are stated as product
 * facts.
 */

const LAYOUT = readFileSync("src/app/(workspace)/layout.module.css", "utf8");
const GALLERY = readFileSync("src/components/gallery.module.css", "utf8");
const GLOBALS = readFileSync("src/app/globals.css", "utf8");

/** The narrow branch and everything after it. */
const NARROW_AT = LAYOUT.indexOf("@media (max-width: 1720px)");
const WIDE_CSS = LAYOUT.slice(0, NARROW_AT);
const NARROW_CSS = LAYOUT.slice(NARROW_AT);

function px(source: string, pattern: RegExp, what: string): number {
  const m = source.match(pattern);
  expect(m, `${what} not found where this check expects it`).not.toBeNull();
  return Number(m![1]);
}

/* The wide branch: cap and the side paddings that live inside it
 * (globals.css sets universal border-box, asserted below so the
 * subtraction stays honest). The cap may be written as a plain pixel
 * value or as calc(<content>px + 2 * <pad>px) — the self-documenting
 * form the fix chose. */
const sidePad = px(
  WIDE_CSS,
  /\.main\s*{[^}]*padding:\s*calc\([^)]*\)\s+(\d+)px/,
  "wide .main side padding",
);
const capMatch = WIDE_CSS.match(
  /\.main\s*{[^}]*max-width:\s*(?:calc\(\s*(\d+)px\s*\+\s*2\s*\*\s*(\d+)px\s*\)|(\d+)px)/,
);
expect(capMatch, "wide .main cap not found where this check expects it").not.toBeNull();
if (capMatch![2]) {
  // The calc's pad term must be the pad it claims to compensate.
  expect(Number(capMatch![2])).toBe(sidePad);
}
const wideCap = capMatch![3]
  ? Number(capMatch![3])
  : Number(capMatch![1]) + 2 * Number(capMatch![2]);
const wideContent = wideCap - 2 * sidePad;

/* The narrow branch zeroes the paddings, so its cap IS its content box —
 * its own max-width when it declares one, the inherited base cap when
 * it does not (the pre-fix state). */
const narrowOwnCap = NARROW_CSS.match(/\.main\s*{[^}]*max-width:\s*(\d+)px/);
const narrowCap = narrowOwnCap ? Number(narrowOwnCap[1]) : wideCap;

/* What a full row needs: n tracks, n-1 gaps, plus the classic scrollbar
 * globals.css pins (styling ::-webkit-scrollbar forces space-consuming
 * scrollbars in Chromium, and a populated gallery always scrolls). */
const scrollbar = px(GLOBALS, /::-webkit-scrollbar\s*{[^}]*width:\s*(\d+)px/, "scrollbar width");
const mapsTrack = px(GALLERY, /\.grid\s*{[^}]*repeat\(auto-fill,\s*(\d+)px\)/, "maps track");
const mapsGap = px(GALLERY, /\.grid\s*{[^}]*gap:\s*(\d+)px/, "maps gap");
const dataTrack = px(GALLERY, /\.dataGrid\s*{[^}]*repeat\(auto-fill,\s*(\d+)px\)/, "data track");
const dataGap = px(GALLERY, /\.dataGrid\s*{[^}]*gap:\s*(\d+)px/, "data gap");

const rowNeed = (track: number, gap: number, n: number) => n * track + (n - 1) * gap;

describe("the workspace container never loses gallery columns as it grows", () => {
  it("subtracts paddings from a border-box world (the arithmetic's premise)", () => {
    expect(GLOBALS).toMatch(/\*[^{]*{[^}]*box-sizing:\s*border-box/);
    expect(NARROW_CSS).toMatch(/\.main\s*{[^}]*padding-left:\s*0/);
    expect(NARROW_CSS).toMatch(/\.main\s*{[^}]*padding-right:\s*0/);
  });

  it("keeps the content box monotonic across the 1720px breakpoint", () => {
    // Growing the viewport past the breakpoint must never hand the
    // grids less width than the widest narrow-branch layout had.
    expect(wideContent).toBeGreaterThanOrEqual(narrowCap);
  });

  it("fits four map cards abreast at the cap, scrollbar included", () => {
    expect(wideContent).toBeGreaterThanOrEqual(rowNeed(mapsTrack, mapsGap, 4) + scrollbar);
  });

  it("fits five data cards abreast at the cap, scrollbar included", () => {
    expect(wideContent).toBeGreaterThanOrEqual(rowNeed(dataTrack, dataGap, 5) + scrollbar);
  });

  it("would fail on the pre-fix geometry (red-proven on the seeded defect)", () => {
    // The shipped defect: cap 1480 with 24px paddings inside it. The
    // bounds above must actually exclude it, or they hold nothing.
    const defective = 1480 - 2 * 24;
    expect(defective).toBeLessThan(rowNeed(mapsTrack, mapsGap, 4) + scrollbar);
  });
});
