import { CORNERS, type Corner } from "@/lib/corners";
import { BASEMAP_LAYER_GROUPS, type BasemapLayers } from "@/lib/basemap-layers";
import { CAMERA_BOUNDS, IMAGE_MIN_ZOOM, MAP_MIN_ZOOM } from "@/lib/map-runtime-limits";
import {
  DEFAULT_OPENING_SHAPE,
  EXPORT_MAX_DIMENSION,
  EXPORT_MIN_HEIGHT,
  EXPORT_MIN_WIDTH,
  MAP_SCALE_MAX,
  MAP_SCALE_MIN,
  WORKING_CANVAS_MAX,
  nearestExactScale,
} from "./space";

export {
  EXPORT_MAX_DIMENSION,
  EXPORT_MIN_HEIGHT,
  EXPORT_MIN_WIDTH,
  MAP_SCALE_MAX,
  MAP_SCALE_MIN,
  WORKING_CANVAS_MAX,
};

/**
 * The export image definition: the card's choices as one small public
 * contract — documented in the OpenAPI components, edited by the card,
 * and consumed unchanged by the server renderer. Server-safe and
 * dependency-light on purpose: both sides import this.
 *
 * The definition serializes **concrete pixel dimensions**, so the aspect
 * is entailed by the size and the contract never carries a value a
 * renderer cannot resolve. Added the map's drawn size, a step for every
 * element, the attribution's placement, and a shot-level basemap
 * override. The arithmetic those imply lives in `space.ts`, which reads
 * this module's bounds rather than restating them: the contract is the
 * shape and its limits, `space.ts` is the maths.
 */

export interface ExportImageViewport {
  lng: number;
  lat: number;
  zoom: number;
  /** Degrees; 0 = flat. */
  pitch: number;
  /** Degrees; 0 = north-up. */
  bearing: number;
}

/** One step scale for every element the image carries: a screen-sized
 * element is wrong in a 2560-pixel image, and free resize is composer
 * territory (D5). XS joined the ramp, which also gave the widget rail
 * and the attribution steps of their own; S, M and L keep the meanings
 * they have always had. The scales themselves live in `space.ts`,
 * because an element's drawn size now depends on the composition's space
 * as well as its step. */
export const SIZE_STEPS = ["xs", "s", "m", "l"] as const;
export type SizeStep = (typeof SIZE_STEPS)[number];

/** Output width presets (D4): explicit pixels, no density multipliers —
 * multipliers behave differently across screen densities. */
export const EXPORT_WIDTH_PRESETS = [1280, 1920, 2560] as const;

/** The definition's appearance: the author's active theme at export —
 * captured state, because the card's client-side capture always
 * exported it implicitly and the server must render the same. */
export const APPEARANCES = ["light", "dark"] as const;
export type Appearance = (typeof APPEARANCES)[number];




export interface ExportImageDefinition {
  viewport: ExportImageViewport;
  /** Exact output pixels; height already reflects the chosen aspect. */
  size: { width: number; height: number };
  legend: { visible: boolean; corner: Corner; size: SizeStep };
  /** Ids of the widgets the image includes, in rail order. */
  widgets: string[];
  /** How large the widget rail is drawn; absent means M. */
  widgetSize?: SizeStep;
  title: { text: string; size: SizeStep } | null;
  /** Where the attribution sits and how large; absent means
   * bottom-right at M. It has no visibility — the licence requires it. */
  credit?: { corner: Corner; size: SizeStep };
  /** The basemap layer groups THIS image draws — resolved,
   * not a difference from the map's stored choice, so the definition
   * renders the same tomorrow as today. Absent means the map's own. */
  basemapLayers?: BasemapLayers | null;
  /** The author's active theme at export. */
  appearance: Appearance;
  /** Output pixels per composition pixel: how large the map is drawn
   * The card derives it from the author's map-size step and the output
   * width, so a wider image is the same picture more sharply. Named
   * `overlayScale`, when it was inherited from the preview frame rather
   * than chosen; that name is still accepted. */
  mapScale?: number;
  /** @deprecated The earlier name for `mapScale`. Accepted so nothing
   * an agent wrote before the rename breaks. */
  overlayScale?: number;
}

/** The effective map scale of a definition, whichever name it used, and
 * whatever it takes to lay out in whole pixels. One resolver, so no host
 * can read one field and miss the other — or nudge a legacy scale
 * differently from its sibling. */
export function resolveMapScale(def: {
  size?: { width: number; height: number };
  mapScale?: number;
  overlayScale?: number;
}): number {
  if (def.mapScale !== undefined) return def.mapScale;
  const legacy = def.overlayScale;
  if (legacy === undefined) return 1;
  // An earlier scale came from a preview frame and may divide nothing.
  // Callers without a size get it raw.
  return def.size ? nearestExactScale(def.size, legacy) : legacy;
}

/** What the card reads from the builder to seed a fresh definition. */
export interface ExportImageSeed {
  /** The builder's active theme. */
  appearance: Appearance;
  camera: {
    lng: number;
    lat: number;
    zoom: number;
    pitch?: number;
    bearing?: number;
  };
  /** The builder canvas's CSS width, so the card can open showing the
   * ground the author is looking at rather than the same zoom number in
   * a differently sized space. */
  canvasWidth: number;
  /** Whether any layer contributes to the legend right now. */
  legendPresent: boolean;
  legendCorner: Corner | null;
  /** Ids of the widgets currently visible, in rail order. */
  visibleWidgetIds: string[];
  /** The map's stored basemap layer groups — the card's override starts
   * from them and never writes back. */
  basemapLayers: BasemapLayers | null;
}

export const DEFAULT_EXPORT_WIDTH = 1920;
/** Shapes only, — "current view" was an unnamed custom shape
 * taken from the browser window, and the frame drag does that job
 * properly. 4:3 leads; the shape itself is owned by `space.ts`, so the
 * opening-step legality judges the same shape. */
export const DEFAULT_EXPORT_ASPECT =
  DEFAULT_OPENING_SHAPE.width / DEFAULT_OPENING_SHAPE.height;

/** A fresh card's definition: 4:3 at the default width, the S map size
 * the map's present legend, widget and basemap state, no title — and
 * every element's step at S (field round; M crowded the
 * image). The camera is the builder's, moved so the card opens on the
 * same ground: a wider space at the same zoom would show more. The
 * caller supplies the space the card will lay out in. The card's seed
 * only — a definition that OMITS a step still means M, per the
 * published contract. */
export function initialDefinition(
  seed: ExportImageSeed,
  space: { width: number; scale: number; height?: number },
): ExportImageDefinition {
  const width = DEFAULT_EXPORT_WIDTH;
  const canvas =
    Number.isFinite(seed.canvasWidth) && seed.canvasWidth > 0
      ? seed.canvasWidth
      : space.width;
  return {
    viewport: {
      lng: seed.camera.lng,
      lat: seed.camera.lat,
      zoom: seed.camera.zoom + Math.log2(space.width / canvas),
      pitch: seed.camera.pitch ?? 0,
      bearing: seed.camera.bearing ?? 0,
    },
    size: {
      width,
      height: space.height ?? Math.max(1, Math.round(width / DEFAULT_EXPORT_ASPECT)),
    },
    legend: {
      visible: seed.legendPresent,
      corner: seed.legendCorner ?? "bottom-left",
      size: "s",
    },
    widgets: [...seed.visibleWidgetIds],
    widgetSize: "s",
    title: null,
    // The credit gives way to the legend rather than opening on top of
    // it: a map whose saved legend corner is bottom-right would
    // otherwise stack both there.
    credit: {
      corner:
        (seed.legendPresent ? seed.legendCorner : null) === "bottom-right"
          ? "bottom-left"
          : "bottom-right",
      size: "s",
    },
    basemapLayers: seed.basemapLayers ?? null,
    appearance: seed.appearance,
    mapScale: space.scale,
  };
}

/** Cross-field validity the schema grammar cannot express: the renderer's world-coverage clamp raises the
 * minimum zoom with the CSS viewport height (`log2(height / 512)`, the
 * canvas rule) — a definition below it would silently render a
 * different camera than it states, so it is refused with the number
 * instead. The card cannot produce such a definition (its preview
 * clamps on the same geometry); this guards the agent road. */
export function definitionRenderProblems(
  def: ExportImageDefinition,
): string[] {
  const problems: string[] = [];
  if (def.mapScale === undefined && def.overlayScale === undefined) {
    problems.push(
      "mapScale is missing. Give the map's drawn size as output pixels " +
        "per composition pixel (its deprecated name, overlayScale, is also " +
        "accepted)",
    );
    return problems;
  }
  const scale = resolveMapScale(def);
  const cssWidth = def.size.width / scale;
  const cssHeight = def.size.height / scale;
  // The working canvas is where a fine map costs time — more tiles at a
  // deeper zoom — so it is bounded per axis. A step's space grows with
  // the shape, so a wide enough custom shape CAN carry a fine step over
  // the bound; the card keeps its selection off such a step
  // (`legalStepFor`) rather than relying on this refusal, which stays
  // the guard for the agent road.
  if (cssWidth > WORKING_CANVAS_MAX || cssHeight > WORKING_CANVAS_MAX) {
    problems.push(
      `mapScale ${scale} draws this ${def.size.width}×${def.size.height} ` +
        `image across ${Math.round(cssWidth)}×${Math.round(cssHeight)} ` +
        `composition pixels, past the ${WORKING_CANVAS_MAX} bound. Raise ` +
        `mapScale, or reduce the size`,
    );
  }
  // Exact output pixels are a promise, and a composition can only be
  // laid out in whole pixels: a size that does not divide by its scale
  // would be screenshotted a pixel short, which is a wrong number
  // presented as a fact. Refused with the nearest scale that works — but
  // only for `mapScale`, which an author chose. A definition written
  // carries a scale taken from a preview frame that may divide nothing,
  // and refusing those would break the compatibility this feature
  // promised; the renderer nudges them instead, by well
  // under a percent.
  const near = (v: number) => Math.abs(v - Math.round(v)) < 1e-6;
  if (def.mapScale !== undefined && (!near(cssWidth) || !near(cssHeight))) {
    problems.push(
      `mapScale ${scale} does not divide ${def.size.width}×${def.size.height} ` +
        `into whole composition pixels (${cssWidth.toFixed(2)}×` +
        `${cssHeight.toFixed(2)}), so the image could not be exactly the ` +
        `size asked for. Use a scale that divides both, such as 1`,
    );
  }
  const minZoom = Math.max(MAP_MIN_ZOOM, Math.log2(cssHeight / 512));
  if (def.viewport.zoom < minZoom - 1e-9) {
    problems.push(
      `viewport.zoom ${def.viewport.zoom} is below ${minZoom.toFixed(2)}, ` +
        `the minimum for a ${def.size.height}px-tall output at ` +
        `mapScale ${scale}. Zoom in, reduce the height, or raise mapScale`,
    );
  }
  return problems;
}

/** The documented JSON schema for the definition — the single source both
 * the OpenAPI components and the drift test consume, so the card's state
 * shape and the public contract cannot separate silently. */
export const EXPORT_IMAGE_DEFINITION_SCHEMA = {
  type: "object",
  description:
    "An image export, fully resolved: exact output " +
    "pixels (the aspect is entailed), the camera, how large the map is " +
    "drawn, bounded placement and a size step for every element, the " +
    "included widgets, an optional title, and an optional basemap " +
    "override for this image alone. The builder's export card edits " +
    "exactly this and the server renderer consumes exactly this, so the " +
    "two roads cannot drift.",
  additionalProperties: false,
  required: ["viewport", "size", "legend", "widgets", "title", "appearance"],
  properties: {
    mapScale: {
      type: "number",
      minimum: MAP_SCALE_MIN,
      maximum: MAP_SCALE_MAX,
      description:
        "Output pixels per composition pixel: how large the map itself " +
        "is drawn. A smaller value lays the map out across more " +
        "composition pixels, so its labels, roads and symbols take a " +
        "smaller share of the image: the look of a screenshot of a very " +
        "large screen. Output width is then only density: a wider image " +
        "is the same picture more sharply. Required, unless the " +
        "deprecated name overlayScale is given instead.",
    },
    overlayScale: {
      type: "number",
      minimum: MAP_SCALE_MIN,
      maximum: MAP_SCALE_MAX,
      description:
        "Deprecated name for mapScale, accepted so definitions written " +
        "before the rename keep rendering. Give one or the other.",
    },
    widgetSize: {
      type: "string",
      enum: [...SIZE_STEPS],
      description: "How large the widget rail is drawn. Absent means m.",
    },
    credit: {
      type: "object",
      additionalProperties: false,
      required: ["corner", "size"],
      description:
        "Where the basemap attribution sits and how large. It has no " +
        "visibility: the basemap licence requires it in every image, and " +
        "it never renders below a legible floor whatever the step. " +
        "Absent means bottom-right at m.",
      properties: {
        corner: { type: "string", enum: [...CORNERS] },
        size: { type: "string", enum: [...SIZE_STEPS] },
      },
    },
    basemapLayers: {
      type: ["object", "null"],
      additionalProperties: false,
      description:
        "The basemap layer groups THIS image draws: resolved, not a " +
        "difference from the map's stored choice, so the definition " +
        "renders the same tomorrow as today. A missing key means " +
        "visible. Null means every group is visible; absence means the " +
        "map's own stored choice. Vector styles only: imagery has no " +
        "groups to hide.",
      properties: Object.fromEntries(
        BASEMAP_LAYER_GROUPS.map((g) => [g, { type: "boolean" }]),
      ),
    },
    appearance: {
      type: "string",
      enum: [...APPEARANCES],
      description:
        "The author's active theme at export: captured state, so the " +
        "server renders exactly what the card's client capture always " +
        "exported implicitly.",
    },
    viewport: {
      type: "object",
      additionalProperties: false,
      required: ["lng", "lat", "zoom", "pitch", "bearing"],
      // Bounds are what the renderer can actually initialize: a schema-accepted definition must
      // render, so values the map engine throws on are schema-invalid, not runtime surprises.
      properties: {
        lng: { type: "number", minimum: -540, maximum: 540 },
        lat: { type: "number", ...CAMERA_BOUNDS.lat },
        zoom: { type: "number", ...CAMERA_BOUNDS.zoom, minimum: IMAGE_MIN_ZOOM },
        pitch: {
          type: "number",
          ...CAMERA_BOUNDS.pitch,
          description: "Degrees; 0 = flat.",
        },
        bearing: {
          type: "number",
          minimum: -360,
          maximum: 360,
          description: "Degrees; 0 = north-up.",
        },
      },
    },
    size: {
      type: "object",
      additionalProperties: false,
      required: ["width", "height"],
      properties: {
        width: {
          type: "integer",
          minimum: EXPORT_MIN_WIDTH,
          maximum: EXPORT_MAX_DIMENSION,
          description:
            "At least the width a legible basemap credit needs: an " +
            "image too narrow to carry its attribution is refused, not " +
            "exported without it.",
        },
        height: {
          type: "integer",
          minimum: EXPORT_MIN_HEIGHT,
          maximum: EXPORT_MAX_DIMENSION,
        },
      },
    },
    legend: {
      type: "object",
      additionalProperties: false,
      required: ["visible", "corner", "size"],
      properties: {
        visible: { type: "boolean" },
        corner: { type: "string", enum: [...CORNERS] },
        size: { type: "string", enum: [...SIZE_STEPS] },
      },
    },
    widgets: {
      type: "array",
      items: { type: "string" },
      description: "Ids of the included widgets, in rail order.",
    },
    title: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["text", "size"],
      properties: {
        text: { type: "string", maxLength: 200 },
        size: { type: "string", enum: [...SIZE_STEPS] },
      },
    },
  },
} as const;
