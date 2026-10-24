import { describe, expect, it } from "vitest";
import { MARK_CLEARANCE, PICTURE_SHAPE, coveredWidth, keptWidth, pictureHeight } from "./shapes";

// The boxes the picture fills, read off the shipped layouts, each inside
// its card's one-pixel edge: Home's lead picture is 300 tall; beside Start
// the Continue card runs from 592 (a 1,160 px Home less Start's 552 and
// the gap, and again at 968 with Start at 360) to 912 (the 1,480 px column
// less Start's 552 and the gap); stacked, it reaches 967 just under 968. A
// Maps card in the grid is 346 by 148.
const LEAD = 300;
const EDGE = 2;
const BESIDE_START = { narrowest: 592 - EDGE, widest: 912 - EDGE };
const STACKED_WIDEST = 967 - EDGE;
const MAPS_CARD = { width: 346 - EDGE, height: 148 };
const DENSITY = 3;

function covered(box: { width: number; height: number }) {
  const { frame } = PICTURE_SHAPE;
  const scale = Math.max(box.width / frame.width, box.height / frame.height);
  return { width: frame.width * scale, height: frame.height * scale, scale };
}

const whole: { width: number; height: number }[] = [MAPS_CARD];
for (let width = BESIDE_START.narrowest; width <= BESIDE_START.widest; width += 1) whole.push({ width, height: LEAD });

describe("the picture's shape", () => {
  it("never crops the sides in Continue beside Start or a Maps card in the grid, at any kept size", () => {
    const { frame, widths } = PICTURE_SHAPE;
    for (const box of whole) {
      expect(covered(box).width, `${box.width} by ${box.height}`).toBeCloseTo(box.width, 9);
      // A kept size is the frame rounded to whole pixels: it must not come out wider than the box either.
      for (const width of [...widths, 692]) expect(width / pictureHeight(width), `${width} in ${box.width}`).toBeLessThanOrEqual(box.width / box.height);
    }
    expect(frame.width / frame.height).toBeLessThanOrEqual(BESIDE_START.narrowest / LEAD);
  });

  it("gives ends that absorb what those boxes crop, with room for a mark at the data's edge", () => {
    const { frame, padding } = PICTURE_SHAPE;
    for (const box of whole) {
      const shown = covered(box);
      const hiddenEnd = (shown.height - box.height) / 2 / shown.scale;
      const end = hiddenEnd > 0 ? hiddenEnd + MARK_CLEARANCE : 0;
      expect(padding.top).toBeGreaterThanOrEqual(end - 1e-9);
      expect(padding.bottom).toBeGreaterThanOrEqual(end - 1e-9);
    }
    expect(frame.height - padding.top - padding.bottom).toBeGreaterThan(frame.height / 2);
    expect(padding).toEqual({ top: 108, right: 39, bottom: 108, left: 39 });
  });

  it("keeps at least Fit's share of the frame as margin on every side", () => {
    const { frame, padding } = PICTURE_SHAPE;
    const share = (frame.height * 64) / 824;
    for (const side of [padding.top, padding.right, padding.bottom, padding.left]) expect(side).toBeGreaterThanOrEqual(share);
  });

  it("has a master that covers the widest box it fills at three density", () => {
    const { frame, scale } = PICTURE_SHAPE;
    for (const box of [...whole, { width: STACKED_WIDEST, height: LEAD }]) {
      expect(covered(box).width * DENSITY).toBeLessThanOrEqual(frame.width * scale);
      expect(covered(box).height * DENSITY).toBeLessThanOrEqual(frame.height * scale);
    }
    expect([frame.width, frame.height, scale]).toEqual([968, 494, 3]);
  });

  it("keeps the master as the widest kept size, narrowest first", () => {
    const { frame, scale, widths } = PICTURE_SHAPE;
    expect(widths).toEqual([360, 720, 1080, 1440, 1980, 2904]);
    expect(widths[widths.length - 1]).toBe(frame.width * scale);
    expect([...widths].sort((a, b) => a - b)).toEqual(widths);
  });

  it("answers the width the picture covers under cover cropping", () => {
    expect(coveredWidth(MAPS_CARD)).toBe(344);
    expect(coveredWidth({ width: 96, height: 60 })).toBeCloseTo((60 * 968) / 494, 6);
    expect(coveredWidth({ width: BESIDE_START.widest, height: LEAD })).toBe(BESIDE_START.widest);
  });

  it("picks the narrowest kept width at least as wide, else the widest", () => {
    const widths = PICTURE_SHAPE.widths;
    expect(keptWidth(widths, 1)).toBe(360);
    expect(keptWidth(widths, 800)).toBe(1080);
    expect(keptWidth(widths, 1080)).toBe(1080);
    expect(keptWidth(widths, 99999)).toBe(2904);
  });

  it("sizes each kept width in the frame's proportion", () => {
    expect(pictureHeight(2904)).toBe(1482);
    expect(pictureHeight(692)).toBe(353);
    expect(pictureHeight(360)).toBe(184);
  });
});
