import { FIT_PADDING, type FitPadding } from "@/lib/fit-camera";

/**
 * A map picture's two shapes. Each is framed on its own, like Fit, and
 * kept in several widths so a host's browser takes the one its screen
 * needs. Shared by the server, which renders them, and the card strip,
 * which chooses one.
 *
 * One rule sets both: a shape's master covers, at three screen pixels per
 * point, the largest area the shape is shown at over the box proportions
 * it serves, and each side's margin is the larger of Fit's share of the
 * frame and what those boxes crop from that side plus room for the marks.
 *
 * - card: the Maps card's proportion, drawn in the builder's map window
 *   width, so a card is a reduced Fit view. It serves every box up to the
 *   switch, Home's Continue card included while that is narrow.
 * - wide: Home's Continue card from the switch to its widest, 1104 by
 *   226 inside the workspace's 1480 pixel column. Its proportion is the
 *   middle of that range on a ratio scale.
 */
export type PictureShape = "card" | "wide";

export const PICTURE_SHAPE_NAMES: readonly PictureShape[] = ["card", "wide"];

export interface PictureShapeSpec {
  /** The frame the map is drawn in, CSS pixels. */
  frame: { width: number; height: number };
  /** Device pixels per CSS pixel of the master render. */
  scale: number;
  /** The kept widths, narrowest first; the last is the master's. */
  widths: readonly number[];
  /** Fit's margin in this frame, CSS pixels. */
  padding: FitPadding;
}

/** Boxes up to this proportion show the card shape, wider ones the wide.
 * Set by the card master: past it, the Continue card (226 tall) would
 * need more than its 1980 pixels at three density. */
export const SHAPE_SWITCH = 2.9;

/** The builder's map window on the reference screen, 1440 by 900, is 824
 * CSS pixels tall; Fit's margin is that share of a picture's height. */
const FIT_SHARE = FIT_PADDING / 824;

/** Fit measures coordinates, not the radius and stroke drawn around them:
 * where a host crops, the margin keeps this much more, so a default mark
 * at the data's edge is not cut. */
export const MARK_CLEARANCE = 20;

const CONTINUE_WIDEST = 1104 / 226;
const CARD_FRAME = { width: 990, height: 424 };
const WIDE_FRAME = { width: 1104, height: Math.round(1104 / Math.sqrt(SHAPE_SWITCH * CONTINUE_WIDEST)) };

const aspect = (frame: { width: number; height: number }) => frame.width / frame.height;
/** What a box of a proportion crops from each end (top and bottom) or
 * each side of a frame it covers. */
const endsCut = (frame: { width: number; height: number }, box: number) =>
  box > aspect(frame) ? (frame.height * (1 - aspect(frame) / box)) / 2 : 0;
const sidesCut = (frame: { width: number; height: number }, box: number) =>
  box < aspect(frame) ? (frame.width * (1 - box / aspect(frame))) / 2 : 0;
const margin = (frame: { width: number; height: number }, cut: number) =>
  Math.ceil(Math.max(frame.height * FIT_SHARE, cut > 0 ? cut + MARK_CLEARANCE : 0));

export const PICTURE_SHAPES: Record<PictureShape, PictureShapeSpec> = {
  card: {
    frame: CARD_FRAME,
    scale: 2,
    widths: [360, 720, 1080, 1440, 1980],
    padding: (() => {
      const ends = margin(CARD_FRAME, endsCut(CARD_FRAME, SHAPE_SWITCH));
      const sides = margin(CARD_FRAME, 0);
      return { top: ends, right: sides, bottom: ends, left: sides };
    })(),
  },
  wide: {
    frame: WIDE_FRAME,
    scale: 3,
    widths: [1104, 1656, 2208, 3312],
    padding: (() => {
      const ends = margin(WIDE_FRAME, endsCut(WIDE_FRAME, CONTINUE_WIDEST));
      const sides = margin(WIDE_FRAME, sidesCut(WIDE_FRAME, SHAPE_SWITCH));
      return { top: ends, right: sides, bottom: ends, left: sides };
    })(),
  },
};

export function isPictureShape(value: unknown): value is PictureShape {
  return value === "card" || value === "wide";
}

/** A kept size's height: the frame's proportion at that width. */
export function pictureHeight(shape: PictureShape, width: number): number {
  const { frame } = PICTURE_SHAPES[shape];
  return Math.round((width * frame.height) / frame.width);
}

/** The shape a box shows: the card up to the switch, the wide past it. */
export function shapeForBox(box: { width: number; height: number }): PictureShape {
  return box.width / box.height > SHAPE_SWITCH ? "wide" : "card";
}

/** The CSS width a picture of this shape covers in a box it fills with
 * cover cropping: the box's width, or more when the box is taller than
 * the picture's proportion. */
export function coveredWidth(shape: PictureShape, box: { width: number; height: number }): number {
  const { frame } = PICTURE_SHAPES[shape];
  return Math.max(box.width, (box.height * frame.width) / frame.height);
}

/** The kept width a read asks for: the narrowest at least as wide, else
 * the widest. */
export function keptWidth(widths: readonly number[], wanted: number): number {
  return widths.find((width) => width >= wanted) ?? widths[widths.length - 1];
}
