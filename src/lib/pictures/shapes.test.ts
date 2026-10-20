import { describe, expect, it } from "vitest";
import { MARK_CLEARANCE, PICTURE_SHAPES, SHAPE_SWITCH, coveredWidth, keptWidth, pictureHeight, shapeForBox, type PictureShape } from "./shapes";

// The boxes each shape serves, read off the shipped layouts: Home's
// Continue card is 226 tall, from a phone's width to 1104 inside the
// workspace column; the card hosts are no wider than the Maps card's 346
// by 148 and no taller than Continue.
const CONTINUE_HEIGHT = 226;
const CONTINUE_WIDEST = 1104;
const DENSITY = 3;

function covered(shape: PictureShape, box: { width: number; height: number }) {
  const { frame } = PICTURE_SHAPES[shape];
  const scale = Math.max(box.width / frame.width, box.height / frame.height);
  return { width: frame.width * scale, height: frame.height * scale, scale };
}

describe("picture shapes", () => {
  it("chooses the card up to the switch and the wide past it", () => {
    expect(shapeForBox({ width: 346, height: 148 })).toBe("card");
    expect(shapeForBox({ width: 343, height: 226 })).toBe("card");
    expect(shapeForBox({ width: Math.floor(SHAPE_SWITCH * 226), height: 226 })).toBe("card");
    expect(shapeForBox({ width: Math.ceil(SHAPE_SWITCH * 226) + 1, height: 226 })).toBe("wide");
    expect(shapeForBox({ width: CONTINUE_WIDEST, height: CONTINUE_HEIGHT })).toBe("wide");
  });

  it("gives each shape a master that covers the largest box it serves at three density", () => {
    const card = PICTURE_SHAPES.card;
    const cardMaster = { width: card.frame.width * card.scale, height: card.frame.height * card.scale };
    // The card's widest box is Continue at the switch; its tallest, Continue on a phone.
    const atSwitch = covered("card", { width: SHAPE_SWITCH * CONTINUE_HEIGHT, height: CONTINUE_HEIGHT });
    const phone = covered("card", { width: 343, height: CONTINUE_HEIGHT });
    expect(atSwitch.width * DENSITY).toBeLessThanOrEqual(cardMaster.width);
    expect(phone.height * DENSITY).toBeLessThanOrEqual(cardMaster.height);
    expect(covered("card", { width: 346, height: 148 }).width * DENSITY).toBeLessThanOrEqual(cardMaster.width);

    const wide = PICTURE_SHAPES.wide;
    const wideMaster = { width: wide.frame.width * wide.scale, height: wide.frame.height * wide.scale };
    for (const width of [SHAPE_SWITCH * CONTINUE_HEIGHT, 900, CONTINUE_WIDEST]) {
      const shown = covered("wide", { width, height: CONTINUE_HEIGHT });
      expect(shown.width * DENSITY).toBeLessThanOrEqual(wideMaster.width + 1e-9);
      expect(shown.height * DENSITY).toBeLessThanOrEqual(wideMaster.height + 1e-9);
    }
  });

  it("keeps the master as the widest kept size", () => {
    for (const shape of ["card", "wide"] as const) {
      const { frame, scale, widths } = PICTURE_SHAPES[shape];
      expect(widths[widths.length - 1]).toBe(frame.width * scale);
      expect([...widths].sort((a, b) => a - b)).toEqual(widths);
      expect(Number.isInteger(frame.height * scale)).toBe(true);
    }
  });

  it("gives margins that absorb what the served boxes crop, so Continue never cuts through the data", () => {
    // Over Continue's boxes from the card's own proportion to its widest,
    // the frame region a box shows must contain the data region the
    // margins leave.
    const card = PICTURE_SHAPES.card.frame;
    for (let width = Math.ceil((CONTINUE_HEIGHT * card.width) / card.height); width <= CONTINUE_WIDEST; width += 1) {
      const box = { width, height: CONTINUE_HEIGHT };
      const shape = shapeForBox(box);
      const { frame, padding } = PICTURE_SHAPES[shape];
      const shown = covered(shape, box);
      const hiddenSide = (shown.width - box.width) / 2 / shown.scale;
      const hiddenEnd = (shown.height - box.height) / 2 / shown.scale;
      // Room past the crop for a mark drawn at the data's edge.
      const side = hiddenSide > 0 ? hiddenSide + MARK_CLEARANCE : 0;
      const end = hiddenEnd > 0 ? hiddenEnd + MARK_CLEARANCE : 0;
      expect(padding.left).toBeGreaterThanOrEqual(side - 1e-9);
      expect(padding.right).toBeGreaterThanOrEqual(side - 1e-9);
      expect(padding.top).toBeGreaterThanOrEqual(end - 1e-9);
      expect(padding.bottom).toBeGreaterThanOrEqual(end - 1e-9);
      expect(frame.width - padding.left - padding.right).toBeGreaterThan(0);
    }
  });

  it("keeps at least Fit's share of the frame as margin", () => {
    for (const shape of ["card", "wide"] as const) {
      const { frame, padding } = PICTURE_SHAPES[shape];
      const share = (frame.height * 64) / 824;
      for (const side of [padding.top, padding.right, padding.bottom, padding.left]) expect(side).toBeGreaterThanOrEqual(share);
    }
  });

  it("answers the width a picture covers under cover cropping", () => {
    expect(coveredWidth("card", { width: 346, height: 148 })).toBeCloseTo(346, 0);
    expect(coveredWidth("card", { width: 96, height: 60 })).toBeCloseTo((60 * 990) / 424, 6);
    expect(coveredWidth("wide", { width: CONTINUE_WIDEST, height: CONTINUE_HEIGHT })).toBe(CONTINUE_WIDEST);
  });

  it("picks the narrowest kept width at least as wide, else the widest", () => {
    const widths = PICTURE_SHAPES.card.widths;
    expect(keptWidth(widths, 1)).toBe(360);
    expect(keptWidth(widths, 800)).toBe(1080);
    expect(keptWidth(widths, 1080)).toBe(1080);
    expect(keptWidth(widths, 99999)).toBe(1980);
  });

  it("sizes each kept width in the frame's proportion", () => {
    expect(pictureHeight("card", 1980)).toBe(848);
    expect(pictureHeight("wide", 3312)).toBe(PICTURE_SHAPES.wide.frame.height * 3);
  });
});
