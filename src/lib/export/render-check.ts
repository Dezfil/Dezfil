import type { ExportImageDefinition } from "./image-definition";

/**
 * The image renderer's check picture: a fixed mark of a known color at a
 * known place on a plain ground, drawn by a page of the render route that
 * reads no map and no data. The renderer's Test photographs it and reads
 * the color back at the mark and on the ground. No server import here:
 * the page reads this module too.
 */

export const RENDER_CHECK_PATH = "/render/check";

/** The picture's size in pixels, drawn at scale one. */
export const RENDER_CHECK_SIZE = { width: 160, height: 100 } as const;

/** The mark: a square centred in the picture. */
export const RENDER_CHECK_MARK = { x: 55, y: 25, width: 50, height: 50 } as const;

/** Kelp for the mark, a light gray for the ground, as red, green, blue. */
export const RENDER_CHECK_MARK_COLOR = [26, 93, 74] as const;
export const RENDER_CHECK_GROUND_COLOR = [240, 240, 240] as const;

export const rgb = (color: readonly [number, number, number]) => `rgb(${color[0]}, ${color[1]}, ${color[2]})`;

/** The definition the drive sizes the page by: the picture's size at
 * scale one. The page itself reads nothing from it. */
export const RENDER_CHECK_DEFINITION: ExportImageDefinition = {
  viewport: { lng: 0, lat: 0, zoom: 0, pitch: 0, bearing: 0 },
  size: { ...RENDER_CHECK_SIZE },
  legend: { visible: false, corner: "bottom-left", size: "s" },
  widgets: [],
  title: null,
  appearance: "light",
  mapScale: 1,
};
