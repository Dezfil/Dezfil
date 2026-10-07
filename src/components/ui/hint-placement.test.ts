import { describe, expect, it } from "vitest";
import { placeHint, settleHint } from "./hint-placement";

/**
 * Where the one tooltip stands. By default below its control and centred,
 * flipped above near the bottom; inside the rail, beside the icon on its
 * centre line, so a name never covers the icon under it.
 */
const VIEWPORT = { width: 1440, height: 900 };
const box = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height });

describe("the hint's placement", () => {
  it("stands below a control, centred on it", () => {
    const shown = placeHint(box(600, 100, 38, 38), "Fit", VIEWPORT, "below");
    expect(shown).toMatchObject({ y: 144, above: false, beside: false });
    // Centred on the control by the estimated width.
    expect(shown.x + (Math.min(340, 3 * 6.6 + 20)) / 2).toBeCloseTo(619);
  });

  it("flips above near the bottom edge", () => {
    expect(placeHint(box(600, 860, 38, 30), "Fit", VIEWPORT, "below")).toMatchObject({ y: 854, above: true });
  });

  it("stands beside a rail icon, a gap from its right edge, on its centre line", () => {
    const shown = placeHint(box(22, 300, 38, 38), "Connections", VIEWPORT, "beside");
    expect(shown).toMatchObject({ x: 66, y: 319, above: false, beside: true });
  });

  it("keeps a beside hint inside the viewport by sliding it, never flipping it over the next icon", () => {
    const anchor = box(22, 878, 38, 20);
    const shown = placeHint(anchor, "Frida Merian", VIEWPORT, "beside");
    // The rendered bubble, centred on y, runs past the bottom's padded edge.
    const settled = settleHint(shown, box(66, 874, 90, 24), VIEWPORT);
    expect(settled).toMatchObject({ x: 66, above: false, beside: true });
    expect(settled.y).toBe(shown.y - (898 - 892));
  });

  it("still pulls a below hint inside the right edge and flips it when its real height crosses the bottom", () => {
    const shown = placeHint(box(1400, 820, 30, 30), "Switch theme", VIEWPORT, "below");
    expect(shown).toMatchObject({ y: 856, above: false });
    // The real bubble is wider and taller than the estimate.
    const settled = settleHint(shown, box(shown.x, shown.y, 110, 40), VIEWPORT);
    expect(settled.x).toBeCloseTo(1322);
    expect(settled).toMatchObject({ above: true, y: 814 });
  });
});
