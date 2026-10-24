import { FIT_PADDING, type FitPadding } from "@/lib/fit-camera";

/**
 * A map picture's shape: one frame, framed like Fit, kept in several
 * widths so a host's browser takes the one its screen needs. Shared by the
 * server, which renders it, and the card strip, which offers its sizes.
 *
 * The frame takes the narrowest proportion among the boxes that must show
 * the picture's whole width: inside their edge, Home's Continue card beside
 * Start, 590 to 910 by 300, and a Maps card in the gallery grid, 344 by
 * 148. None of them then crops its sides. Its ends keep a margin that covers what the widest
 * of them crops, plus room for the marks; its sides keep Fit's share. A
 * box wider than that range, a Maps card in the single column of a narrow
 * window or the Continue card stacked over Start, crops the ends further,
 * as a card host may.
 */

/** The names a read accepts. Both answer the one shape kept now; a
 * picture made when the wide host had a shape of its own still answers
 * its own sizes under each name until it is re-made. */
export type PictureShape = "card" | "wide";

export const PICTURE_SHAPE_NAMES: readonly PictureShape[] = ["card", "wide"];

/** The name the kept sizes are stored and listed under. */
export const KEPT_SHAPE: PictureShape = "card";

/** The shapes rendered for each appearance of a picture: the kept one. */
export const RENDERED_SHAPES: readonly PictureShape[] = [KEPT_SHAPE];

/** The recipe a published picture is made by. It changes when the framing
 * or the kept shape does, so a picture made by an earlier recipe is
 * re-made once. A picture with kept sizes and no recipe was made by the
 * first; one without kept sizes predates both. */
export const PICTURE_RECIPE = 2;

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

/** The builder's map window on the reference screen, 1440 by 900, is 824
 * CSS pixels tall; Fit's margin is that share of a picture's height. */
const FIT_SHARE = FIT_PADDING / 824;

/** Fit measures coordinates, not the radius and stroke drawn around them:
 * where a host crops, the margin keeps this much more, so a default mark
 * at the data's edge is not cut. */
export const MARK_CLEARANCE = 20;

/** Home's lead picture height, and the Continue card's narrowest and
 * widest width beside Start. */
const LEAD_HEIGHT = 300;
const CONTINUE_NARROWEST = 592;
const CONTINUE_WIDEST = 912;
/** A card's hairline edge, each side: the picture fills the box inside. */
const CARD_EDGE = 1;
/** The widest box the picture fills: the Continue card stacked over Start
 * just under the width at which they stand side by side. */
const WIDEST_BOX = 968;
/** The densest screen a host serves sharp: three screen pixels per point. */
const DENSEST = 3;
/** The width of the default picture, the one cards have always been
 * served when a read names no size. */
export const DEFAULT_WIDTH = 692;

const WIDTHS = [360, 720, 1080, 1440, 1980, WIDEST_BOX * DENSEST];
/** The narrowest and widest proportion of the picture's box in the hosts
 * that show its whole width. */
const NARROWEST = (CONTINUE_NARROWEST - 2 * CARD_EDGE) / LEAD_HEIGHT;
const WIDEST = (CONTINUE_WIDEST - 2 * CARD_EDGE) / LEAD_HEIGHT;

/** The frame's height: the least at which neither the frame nor any size
 * kept from it, rounded to whole pixels, is wider than the narrowest box,
 * so that box never crops a side. */
const FRAME_HEIGHT = (() => {
  const fits = (height: number) => (width: number) => width / Math.round((width * height) / WIDEST_BOX) <= NARROWEST;
  let height = Math.ceil(WIDEST_BOX / NARROWEST);
  while (![WIDEST_BOX, ...WIDTHS, DEFAULT_WIDTH].every(fits(height))) height += 1;
  return height;
})();

const FRAME = { width: WIDEST_BOX, height: FRAME_HEIGHT };

const aspect = (frame: { width: number; height: number }) => frame.width / frame.height;
/** What a box of a proportion crops from each end (top and bottom) of a
 * frame it covers. */
const endsCut = (frame: { width: number; height: number }, box: number) =>
  box > aspect(frame) ? (frame.height * (1 - aspect(frame) / box)) / 2 : 0;
const margin = (frame: { width: number; height: number }, cut: number) =>
  Math.ceil(Math.max(frame.height * FIT_SHARE, cut > 0 ? cut + MARK_CLEARANCE : 0));

export const PICTURE_SHAPE: PictureShapeSpec = {
  frame: FRAME,
  scale: DENSEST,
  widths: WIDTHS,
  padding: (() => {
    const ends = margin(FRAME, endsCut(FRAME, WIDEST));
    const sides = margin(FRAME, 0);
    return { top: ends, right: sides, bottom: ends, left: sides };
  })(),
};

export function isPictureShape(value: unknown): value is PictureShape {
  return value === "card" || value === "wide";
}

/** A kept size's height: the frame's proportion at that width. */
export function pictureHeight(width: number): number {
  const { frame } = PICTURE_SHAPE;
  return Math.round((width * frame.height) / frame.width);
}

/** The CSS width the picture covers in a box it fills with cover cropping:
 * the box's width, or more when the box is taller than the picture's
 * proportion. */
export function coveredWidth(box: { width: number; height: number }): number {
  const { frame } = PICTURE_SHAPE;
  return Math.max(box.width, (box.height * frame.width) / frame.height);
}

/** The kept width a read asks for: the narrowest at least as wide, else
 * the widest. */
export function keptWidth(widths: readonly number[], wanted: number): number {
  return widths.find((width) => width >= wanted) ?? widths[widths.length - 1];
}
