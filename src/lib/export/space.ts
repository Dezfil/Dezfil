/**
 * The export composition's coordinate space.
 *
 * Every earlier export laid the composition out at whatever size the
 * card's preview frame happened to be, and recorded the ratio between
 * that space and the output. Nobody chose that ratio, yet it decided two
 * things at once: how large the map reads inside the frame, and how large
 * the overlays read. This module makes the SPACE the authored quantity
 * and derives everything else from it.
 *
 * Two rules carry the whole feature:
 *
 * - **The map's drawn size is the space.** A larger space at the same
 *   camera draws the map's own labels, roads and symbols across more of
 *   its own coordinate system, so they occupy a smaller share of the
 *   image — the "screenshot of a very large screen" look. Output pixels
 *   are then only density (`densityFor`), which keeps the promise that
 *   a bigger export is the same picture more sharply.
 * - **An overlay's size is a share of the image's short side** (spec
 *   revising an earlier width share: anchored to the width, the same
 *   step read up to three times heavier in a banner than in a portrait,
 *   and the steps degenerated into ratio correction). An overlay's
 *   drawn scale is proportional to the space's shorter dimension
 *   (`elementScale`), so its size in the output is
 *   `base × step × outputShortSide / REFERENCE_SPACE_SHORT` —
 *   independent of the space, the browser window, and the preview, and
 *   the same visual weight in every shape. The identity is exact under
 *   snapping, because the space keeps the output's aspect.
 *
 * Server-safe and dependency-light: both roads and the card import it.
 */

import type { SizeStep } from "./image-definition";
import { MAP_MAX_ZOOM } from "../map-runtime-limits";

/* The contract's numeric bounds live here, with the arithmetic that
 * reasons about them, and `image-definition.ts` re-exports them as part
 * of the contract. One direction only: this module's sole import from
 * there is a type, which is erased — so nudging a legacy scale can use
 * the same search the card does without a cycle. */

/** Output pixel ceiling per axis: bounded and honest — an
 * unbounded pixel area was never a valid contract, and software-GL
 * renders scale poorly past this. */
export const EXPORT_MAX_DIMENSION = 4096;

/** The smallest image that can carry a legible credit at its floor
 * Per axis, because the credit is a horizontal line: width holds the
 * whole attribution — the LONGEST built-in one, the satellite
 * basemap's, not the shortest — while height needs only the type and
 * its inset. `space.test.ts` derives the requirement from the basemap
 * catalogue and fails if a longer provider is ever added. */
export const EXPORT_MIN_WIDTH = 480;
export const EXPORT_MIN_HEIGHT = 64;

/** Bounds for the map scale: output pixels per composition pixel. */
export const MAP_SCALE_MIN = 0.25;
export const MAP_SCALE_MAX = 16;

/** The composition's own size is bounded per axis (gate decision 3): a
 * very fine map on a very large image draws many more tiles at a deeper
 * zoom, which is where the server's render budget goes. */
export const WORKING_CANVAS_MAX = 4096;

/** The composition's CSS SHORT SIDE per map-size step (this revised
 * fixed widths: a width-fixed space collapsed to a 405px-tall
 * composition at L in 16:9, which is why coarse landscape exports lost
 * their labels to collision culling). XS is the finest — the largest
 * space, so the map's own type takes the smallest share of the image.
 * Calibrated so a 4:3 composition is exactly what the old width table
 * produced: at 4:3, L derives to 720 wide — the preview-sized space
 * every export used before 0082. */
export const MAP_SPACE_SHORT: Record<SizeStep, number> = {
  xs: 1440,
  s: 1080,
  m: 810,
  l: 540,
};

/** A step's nominal space WIDTH for an output shape: the fixed short
 * side, carried to the width by the output's aspect. Landscape outputs
 * fix the space's height, portrait ones its width — either way the
 * short side is the step's, which is what keeps a step's label size
 * reading the same in every shape. The snap machinery consumes this
 * exactly as it consumed the old fixed widths. */
export function spaceWidthForStep(
  step: SizeStep,
  output: { width: number; height: number },
): number {
  const aspect = output.width / output.height;
  const short = MAP_SPACE_SHORT[step];
  return aspect >= 1 ? short * aspect : short;
}

/** The steps from finest to coarsest — the order the control offers
 * them, so XS reads as "smallest labels" beside every other XS in the
 * card rather than as "smallest space". */
export const SIZE_STEPS_BY_SPACE = ["xs", "s", "m", "l"] as const satisfies
  readonly SizeStep[];

/** A fresh card opens at S, revising an earlier finest-first default:
 * XS labels read unreadably small in the field. XS stays offered; only the opening value moved. */
export const DEFAULT_MAP_SIZE_STEP: SizeStep = "s";

/** The product's own shape for a fresh card — 4:3 leads, unless the
 * instance's starting shape says otherwise. Owned here so the
 * opening-step legality and the contract's default aspect cannot
 * disagree; `image-definition.ts` derives its constant from this. */
export const DEFAULT_OPENING_SHAPE = { width: 4, height: 3 } as const;

/** The space width the DATA MARKS are calibrated against. Chosen as
 * the card's typical preview frame, so the middle step reproduces the
 * proportion authors are used to. This is the marks' reference alone —
 * marks deliberately keep their width share (changing them changes the
 * map imagery itself, a trade nothing has ruled on) — while
 * the overlays anchor to `REFERENCE_SPACE_SHORT` below. */
export const REFERENCE_SPACE_WIDTH = 720;

/** The space SHORT SIDE the overlay steps are calibrated against
 * the old reference width at the default 4:3 shape — 720 × 3/4 — so
 * every 4:3 export renders exactly as it did under the width rule, and
 * only other shapes move. */
export const REFERENCE_SPACE_SHORT = 540;

/** Each overlay step's multiplier. S, M and L keep the ratios they have
 * always had; XS extends the ramp downward. */
export const ELEMENT_STEP_SCALE: Record<SizeStep, number> = {
  xs: 0.65,
  s: 0.8,
  m: 1,
  l: 1.3,
};

/** The title's ramp is its own: before this feature it stepped 12 / 15 /
 * 22 pixels, so its L is 22/15 rather than the legend's 1.3. Folding it
 * into one table quietly shrank every existing L title.
 * Criterion 3 asks for the ratios each element always had — plural. */
export const TITLE_STEP_SCALE: Record<SizeStep, number> = {
  xs: 12 / 15 / 1.25,
  s: 12 / 15,
  m: 1,
  l: 22 / 15,
};

/** The attribution's type size in composition pixels before its step. */
export const CREDIT_BASE_PX = 11;

/** The attribution never renders below this many output pixels of type. Where the floor and the share rule disagree — only
 * on images small enough for the share to fall under it — the floor
 * wins and the credit stops shrinking. */
export const CREDIT_FLOOR_PX = 9;

/** Output pixels per composition pixel, for an output width laid out in
 * a space of `spaceWidth`. This is the number the definition records. */
export function densityFor(outputWidth: number, spaceWidth: number): number {
  return outputWidth / spaceWidth;
}

/** The inverse: the space a recorded density implies. Old definitions
 * need no migration — their density and output width imply exactly the
 * space their preview frame had. */
export function spaceWidthFor(outputWidth: number, density: number): number {
  return outputWidth / density;
}

export interface SnappedSpace {
  /** The composition's width, near the step's nominal one. */
  space: number;
  /** The output height, unchanged where it could be. */
  height: number;
}

/**
 * A composition can only be laid out in whole pixels, and the browser
 * screenshots whole device pixels — so an image is exactly the size it
 * asks for only when the output divides by the scale into integers on
 * BOTH axes. (Found by a 913×667 image at scale 1.37 that came out
 * 913×666: the fractional layout rounded.)
 *
 * Two things may move to satisfy that, and they are unequal. The **step**
 * is a judgment about how large the map should read, so nudging its
 * space by a percent costs nothing. The **size** is what the author
 * asked for, so it moves only as a last resort, and only by a pixel or
 * two. This searches the spaces near the nominal one and returns the
 * first that keeps the size exactly — falling back to the smallest
 * height change that works.
 *
 * Two earlier attempts are worth remembering. Snapping the height alone
 * turned a 16:9 export at 2560 into 1.74:1 while the card still called
 * it 16:9. Snapping the space alone worked for round numbers and then
 * demanded a 33% change of step for a coprime custom shape.
 */
export function snapSpaceToOutput(
  outputWidth: number,
  outputHeight: number,
  nominalSpace: number,
  /** How far the output height may move. Zero where the size is the
   * author's and must not drift — changing the map-size step is not a
   * resize (a 1920×810 export became 1920×812 on a step change, and drifting further on each one). A
   * space that divides always exists, so zero is never a dead end. */
  heightSlack = 3,
): SnappedSpace {
  const w = Math.round(outputWidth);
  const nominal = Math.round(nominalSpace);
  const exact = (space: number, height: number) =>
    (height * space) % w === 0;
  // Space first, nearest outward, and within each space the untouched
  // height first. Ordering it the other way — every space tried before
  // moving the height a pixel — happily traded a third of the step to
  // save one pixel of height, which is the wrong trade in both
  // directions.
  for (let spaceOffset = 0; spaceOffset <= nominal; spaceOffset += 1) {
    for (const spaceSign of spaceOffset === 0 ? [1] : [1, -1]) {
      const space = nominal + spaceSign * spaceOffset;
      if (space < 64) continue;
      for (let heightOffset = 0; heightOffset <= heightSlack; heightOffset += 1) {
        for (const heightSign of heightOffset === 0 ? [1] : [1, -1]) {
          const height = Math.round(outputHeight) + heightSign * heightOffset;
          if (height < 1) continue;
          if (exact(space, height)) return { space, height };
        }
      }
    }
  }
  // Unreachable in practice — a space equal to the output width always
  // divides — but a total is better than a throw on a public road.
  return { space: w, height: Math.round(outputHeight) };
}

export interface ResolvedSpace {
  /** The composition's width in composition pixels. */
  width: number;
  /** Its height — exactly what both export roads derive from the
   * definition, so the preview can never draw an overlay a different
   * size from the one the file gets. */
  height: number;
  /** Output pixels per composition pixel: the number the definition
   * records, and what both roads divide the output by. */
  scale: number;
}

/**
 * The ONE resolution of "which composition does this output at this
 * step lay out in".
 *
 * Every host that needs the answer must get the same numbers: the
 * card's preview, the card's camera arithmetic, and both export roads
 * through the recorded scale. The card previously resolved the same
 * state through three separate searches with different height slack,
 * and they disagreed on custom shapes — which was invisible while an
 * overlay's size came from the width alone (the two searches always
 * agreed there), and became visible the moment made the composition's
 * HEIGHT decide overlay size too.
 *
 * The author's size never moves here: the search is given no height
 * slack, so only the space travels, and `size.height / scale` is a
 * whole number by construction. Choosing the size is a separate job,
 * done where a size is set.
 */
export function resolveSpace(
  size: { width: number; height: number },
  step: SizeStep,
): ResolvedSpace {
  const fit = snapSpaceToOutput(
    size.width,
    size.height,
    spaceWidthForStep(step, size),
    0,
  );
  const scale = size.width / fit.space;
  return { width: fit.space, height: size.height / scale, scale };
}

/** How far a resolved space may sit from its step's nominal and still
 * be recognisably that step. The bound, kept: past it the control says
 * L while the map is drawn as finely as XS. */
const STEP_DRIFT_TOLERANCE = 0.15;

/**
 * The output size to commit for a requested one. The author's shape is
 * what they asked for; the height may move by a pixel or two where
 * nothing else divides, which is ratified allowance.
 *
 * It moves for a reason: `resolveSpace` never moves the height, so a
 * height that only a far-away space divides would leave the step
 * meaning nothing — a 2560×4063 export at L resolved to a 2560-wide
 * composition, seven times its nominal, drawing an XS-fine map under a
 * control that said L. One pixel of height buys back the step. So the
 * candidates are walked nearest-first and the first whose resolved
 * space is recognisably its own step wins.
 *
 * Choosing the size and resolving the space stay separate jobs, and
 * this one is done only where a size is SET — never on a step change,
 * which must not resize.
 */
export function chooseSize(
  requested: { width: number; height: number },
  /** Five, measured rather than chosen: at ±3 a tail
   * of custom shapes had no candidate inside the tolerance and the
   * search committed an over-tolerance one anyway — 2560×1684 drew L
   * 22% from its nominal. Five clears every reachable state, and
   * nothing beyond five improves on it. The cost is a height moving
   * five pixels instead of three on a pathological custom shape: two
   * tenths of a percent, against a step that visibly means the wrong
   * thing. */
  slack = 5,
): { width: number; height: number } {
  const width = Math.round(requested.width);
  const wanted = Math.round(requested.height);
  // Judged across EVERY step, not just the selected one: a step change
  // must not resize, so a height that suits only the step that happened
  // to be selected when the shape was set strands all the others. One
  // pixel usually buys a height that divides well for the whole ramp.
  const worstDrift = (height: number) => {
    let worst = 0;
    for (const step of SIZE_STEPS_BY_SPACE) {
      const nominal = spaceWidthForStep(step, { width, height });
      const drift =
        Math.abs(resolveSpace({ width, height }, step).width - nominal) /
        nominal;
      if (drift > worst) worst = drift;
    }
    return worst;
  };
  let best: { height: number; drift: number } | null = null;
  for (let offset = 0; offset <= slack; offset += 1) {
    for (const sign of offset === 0 ? [1] : [1, -1]) {
      const height = wanted + sign * offset;
      if (height < 1) continue;
      const drift = worstDrift(height);
      if (drift <= STEP_DRIFT_TOLERANCE) return { width, height };
      if (!best || drift < best.drift) best = { height, drift };
    }
  }
  // Every reachable state has a candidate inside the tolerance at this
  // slack, proven by sweep in `space.test.ts`; this total exists so a
  // hand-called size outside that range still returns its best.
  return { width, height: best?.height ?? wanted };
}

/** The camera a basemap-step change lands on. Compensated between the
 * spaces the render ACTUALLY uses, never their nominals: on a custom
 * shape the nominal pair and the resolved pair differ, and
 * compensating against a space the render then does not use is exactly
 * what moves the ground a step change promises to hold. */
export function stepChangeZoom(
  size: { width: number; height: number },
  from: SizeStep,
  to: SizeStep,
  zoom: number,
): number {
  return (
    zoom + zoomDelta(resolveSpace(size, from).width, resolveSpace(size, to).width)
  );
}

/** The camera an output-width change lands on, at a fixed shape. The
 * step's nominal space depends on the shape and not on the absolute
 * size, so this only ever compensates the snap's own residue — which
 * is what keeps a wider export the same picture, more sharply. */
export function widthChangeZoom(
  before: { width: number; height: number },
  after: { width: number; height: number },
  step: SizeStep,
  zoom: number,
): number {
  return (
    zoom +
    zoomDelta(resolveSpace(before, step).width, resolveSpace(after, step).width)
  );
}

/**
 * The step to sit on once the shape has moved: the current one while it
 * is still offerable, else the first coarser one that is.
 *
 * A shape change can push a fine step's space past the working-canvas
 * bound — XS crosses it at about 2.84:1, just inside the sash's own 3:1
 * clamp — and `stepUnavailable` only ever disabled a step the author
 * had not chosen yet. Leaving the SELECTION on a step that has become
 * illegal mints a definition the render route and the export API both
 * refuse while the browser download still writes a file: the two-road
 * divergence exists to prevent. Coarser steps lay out in smaller
 * spaces, so the scan only ever walks that way.
 */
export function legalStepFor(
  step: SizeStep,
  size: { width: number; height: number },
  zoom: number,
  currentSpaceWidth: number,
): SizeStep {
  const from = Math.max(0, SIZE_STEPS_BY_SPACE.indexOf(step));
  const legal = (s: SizeStep) => !stepUnavailable(s, size, zoom, currentSpaceWidth);
  for (const next of SIZE_STEPS_BY_SPACE.slice(from)) {
    if (legal(next)) return next;
  }
  // Coarsening is the preferred direction, but the resolved space is
  // not monotonic in the step — an awkward height can walk one step's
  // search further than its neighbours'. Rather than strand the
  // selection on an illegal step, take any legal one.
  return SIZE_STEPS_BY_SPACE.find(legal) ?? SIZE_STEPS_BY_SPACE[0];
}

/** Whether an output and a scale lay out in whole composition pixels. */
export function laysOutExactly(
  size: { width: number; height: number },
  scale: number,
): boolean {
  const near = (v: number) => Math.abs(v - Math.round(v)) < 1e-6;
  return near(size.width / scale) && near(size.height / scale);
}

/** Which step a definition is sitting at, or null when its space matches
 * none — an agent may write any density, and the card says so rather than
 * lighting a step that is not what will render. Shape-aware: the same
 * space width is a different step in a different shape. */
export function stepForSpace(
  spaceWidth: number,
  output: { width: number; height: number },
): SizeStep | null {
  for (const step of Object.keys(MAP_SPACE_SHORT) as SizeStep[]) {
    if (Math.abs(spaceWidthForStep(step, output) - spaceWidth) < 0.5)
      return step;
  }
  return null;
}

/** How much the camera must move to hold the ground when the space
 * changes. Web Mercator covers a fixed world width in composition
 * pixels at a given zoom, so doubling the space needs one zoom step in
 * to frame the same geography. */
export function zoomDelta(fromSpace: number, toSpace: number): number {
  return Math.log2(toSpace / fromSpace);
}

/** An overlay's drawn scale inside the composition: its step, times the
 * space's SHORT side over the calibration short side. The output size
 * that falls out is `base × step × outputShortSide /
 * REFERENCE_SPACE_SHORT` — the same visual weight whatever the space,
 * the window, the preview or the shape. The space keeps the output's
 * aspect, so the identity is exact even under snapping. */
export function elementScale(
  spaceWidth: number,
  spaceHeight: number,
  step: SizeStep,
): number {
  return (
    ELEMENT_STEP_SCALE[step] *
    (Math.min(spaceWidth, spaceHeight) / REFERENCE_SPACE_SHORT)
  );
}

/** The attribution's scale, with its floor applied. Below the size at
 * which the share rule would draw the credit under the floor, this
 * returns the larger scale the floor demands — the one deliberate
 * exception to the share rule. */
export function creditScale(
  spaceWidth: number,
  spaceHeight: number,
  step: SizeStep,
  outputWidth: number,
): number {
  const share = elementScale(spaceWidth, spaceHeight, step);
  const density = densityFor(outputWidth, spaceWidth);
  const outputPx = CREDIT_BASE_PX * share * density;
  if (outputPx >= CREDIT_FLOOR_PX) return share;
  return CREDIT_FLOOR_PX / (CREDIT_BASE_PX * density);
}

/** The zoom below which the Mercator world stops covering the canvas —
 * the map surface's own clamp, restated here so a step can be refused
 * before it is offered. It moves with the space by exactly the factor
 * the camera compensation moves the zoom, which is why holding the
 * ground survives a space change at all. */
export function coverageMinZoom(spaceHeight: number): number {
  return Math.max(-2, Math.log2(spaceHeight / 512));
}

export interface SpaceGeometry {
  width: number;
  height: number;
  density: number;
}

/** The composition's own size for an output and a density. */
export function spaceGeometry(
  outputWidth: number,
  outputHeight: number,
  density: number,
): SpaceGeometry {
  return {
    width: outputWidth / density,
    height: outputHeight / density,
    density,
  };
}

/** Why a step cannot be offered, or null when it can. The card shows
 * this as the control's reason rather than failing at download — the
 * treatment an over-tall size preset already gets. */
export function stepUnavailable(
  step: SizeStep,
  output: { width: number; height: number },
  zoom: number,
  currentSpaceWidth: number,
): string | null {
  // Judged on the space the step RESOLVES to, never on its nominal. The
  // two differ wherever the output's height forces the search away from
  // nominal, and deciding availability on one while applying the other
  // is how the card came to offer a step that then laid the map out
  // past this very bound.
  const { width: space, height } = resolveSpace(output, step);
  if (space > WORKING_CANVAS_MAX || height > WORKING_CANVAS_MAX) {
    return `Too fine for a ${output.width}×${output.height} image. The map would be drawn across more than ${WORKING_CANVAS_MAX} pixels.`;
  }
  const next = zoom + zoomDelta(currentSpaceWidth, space);
  if (next > MAP_MAX_ZOOM) {
    return `The map is already as far in as it goes; a finer setting would need zoom ${next.toFixed(1)}.`;
  }
  // There is deliberately no world-coverage check here. Going coarser
  // lowers the zoom AND lowers the coverage floor by exactly the same
  // factor, so the margin between them is invariant under a step change
  // — a step can never strand a camera that was valid before it. The
  // first draft of this function carried that check anyway; it was
  // removed once its test could only be made to fire from a state the
  // card cannot be in. An assertion that cannot fail is worse than no
  // assertion, and the invariance is proven in `space.test.ts` instead.
  return null;
}

/**
 * Which basemap layer groups an image draws. The definition's override
 * is **resolved** — the set this image draws, not a difference from
 * whatever the map holds — so a definition renders the same tomorrow as
 * today. Absent means the map's own stored choice; an explicit null
 * means "everything visible", which is a real answer and not the same as
 * absent.
 */
export function resolveShotBasemapLayers<T>(
  fromDefinition: T | undefined,
  stored: T,
): T {
  return fromDefinition !== undefined ? fromDefinition : stored;
}

/**
 * The map-size step a fresh card opens at: S, degrading to the first
 * supported coarser step. Compensating the camera for a wider space
 * raises the zoom, and a builder already near the shared camera ceiling
 * would be silently clamped — the preview then frames different ground
 * than the definition states. So the opening step is
 * the default or the first coarser one whose compensated camera every
 * host will actually draw, or null when none of the fixed spaces can
 * preserve the current view truthfully. (XS needs a higher zoom than S,
 * so a camera that refuses S refuses XS too — the scan never needs to
 * look finer than the default.)
 *
 * Judged at the shape the card opens at: a wider shape lays each step out
 * in a wider space, so near the ceiling a 16:9 card opens coarser, or not
 * at all, and a square one finer than a 4:3 card from the same view.
 */
export function openingMapStep(
  builderZoom: number,
  builderCanvasWidth: number,
  /** The card's starting shape, or any size of it: only its aspect
   * counts. The product's 4:3 when omitted. */
  shape: { width: number; height: number } = DEFAULT_OPENING_SHAPE,
): SizeStep | null {
  const fromDefault = SIZE_STEPS_BY_SPACE.slice(
    SIZE_STEPS_BY_SPACE.indexOf(DEFAULT_MAP_SIZE_STEP),
  );
  for (const step of fromDefault) {
    // A fresh card opens at its starting shape, so the opening legality
    // is judged in that shape's spaces; at 4:3 they are exactly the
    // earlier fixed widths, by calibration.
    const space = spaceWidthForStep(step, shape);
    const zoom = builderZoom + zoomDelta(builderCanvasWidth || space, space);
    if (zoom <= MAP_MAX_ZOOM) return step;
  }
  return null;
}

/** The nearest scale at or below `scale` that lays the output out in
 * whole composition pixels. Used for definitions written, whose scale
 * came from a preview frame and may divide nothing: refusing them would
 * break the compatibility this feature promised, so they are nudged
 * instead — by well under a percent — and the refusal is reserved for a
 * scale an author chose explicitly. */
export function nearestExactScale(
  size: { width: number; height: number },
  scale: number,
): number {
  const space = size.width / scale;
  const fit = snapSpaceToOutput(size.width, size.height, Math.round(space), 0);
  return size.width / fit.space;
}
