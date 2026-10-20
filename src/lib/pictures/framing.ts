import type { Bounds } from "@/lib/geo-bounds";
import { effectiveExtent, type ExtentLayer } from "@/lib/map-extent";
import { fitCamera, project, rotate, type FitCamera, type FitPadding } from "@/lib/fit-camera";

/**
 * How the render page frames a map picture: Fit's rule in the picture's
 * own frame. The picture service hands it to the page beside the image
 * definition; an export never carries one, so an export keeps its own
 * camera.
 */
export interface PictureFrame {
  /** Fit's margin around the drawn data, CSS pixels, per side. */
  padding: FitPadding;
}

/** The empty map: the world, flat and north up, its width across the
 * frame, centred on the latitudes where the inhabited continents sit. */
export function worldCamera(size: { width: number }): FitCamera {
  return { lng: 0, lat: 20, zoom: Math.log2(size.width / 512), pitch: 0, bearing: 0 };
}

/** MapLibre's default vertical field of view: the camera stands 1.5
 * frame heights from the centre it looks at. */
const FIELD_OF_VIEW = 0.6435011087932844;

/** Where the box's corners land on the screen under a camera, drawn in
 * MapLibre's perspective: the ground offset from the centre turned by the
 * bearing, then seen from a camera tilted by the pitch. Null for a corner
 * at or past the horizon. */
export function cornersOnScreen(bounds: Bounds, camera: FitCamera, size: { width: number; height: number }): ([number, number] | null)[] {
  const [[w, s], [e, n]] = bounds;
  const distance = (0.5 / Math.tan(FIELD_OF_VIEW / 2)) * size.height;
  const [cx, cy] = project(camera.lng, camera.lat);
  const k = 2 ** camera.zoom;
  const pitch = (camera.pitch * Math.PI) / 180;
  return [[w, n], [e, n], [e, s], [w, s]].map(([lng, lat]) => {
    const [px, py] = project(lng, lat);
    const [x, y] = rotate([(px - cx) * k, (py - cy) * k], (-camera.bearing * Math.PI) / 180);
    const depth = distance - y * Math.sin(pitch);
    if (depth <= 1e-6) return null;
    return [size.width / 2 + (distance * x) / depth, size.height / 2 + (distance * y * Math.cos(pitch)) / depth];
  });
}

function contained(bounds: Bounds, camera: FitCamera, size: { width: number; height: number }, padding: FitPadding): boolean {
  const tolerance = 0.01;
  return cornersOnScreen(bounds, camera, size).every((corner) => corner !== null &&
    corner[0] >= padding.left - tolerance && corner[0] <= size.width - padding.right + tolerance &&
    corner[1] >= padding.top - tolerance && corner[1] <= size.height - padding.bottom + tolerance);
}

/**
 * Fit with the saved tilt kept, the data inside the margin. MapLibre's fit
 * ignores the pitch, so a tilted box's near corners spill past the frame;
 * the picture then zooms out, keeping the centre, until every corner is
 * inside. A flat fit already is.
 */
function containTilted(camera: FitCamera, bounds: Bounds, size: { width: number; height: number }, padding: FitPadding): FitCamera {
  if (camera.pitch === 0 || contained(bounds, camera, size, padding)) return camera;
  let inside = camera.zoom - 16;
  let outside = camera.zoom;
  for (let step = 0; step < 40; step += 1) {
    const middle = (inside + outside) / 2;
    if (contained(bounds, { ...camera, zoom: middle }, size, padding)) inside = middle;
    else outside = middle;
  }
  return { ...camera, zoom: inside };
}

/** The camera a picture is drawn at: the drawn data framed as Fit frames
 * it, keeping the saved tilt and rotation and the data inside the margin,
 * or the world when nothing is drawn. */
export function pictureCamera(
  bounds: Bounds | null,
  size: { width: number; height: number },
  frame: PictureFrame,
  saved: { pitch?: number; bearing?: number },
): FitCamera {
  if (!bounds) return worldCamera(size);
  const fitted = fitCamera(bounds, size, frame.padding, { bearing: saved.bearing ?? 0, pitch: saved.pitch ?? 0 });
  return fitted ? containTilted(fitted, bounds, size, frame.padding) : worldCamera(size);
}

/** The frame a render page draws by: only picture work is framed, so a
 * frame the page finds outside picture work is ignored. */
export function pageFrame(picture: boolean, raw: unknown): PictureFrame | null {
  return picture ? readPictureFrame(raw) : null;
}

/** The camera the render page draws: framed like Fit over what it stages
 * when it has a frame, else the definition's own. */
export function renderCamera<T extends { pitch?: number; bearing?: number }>(
  frame: PictureFrame | null,
  extent: ExtentLayer[],
  size: { width: number; height: number },
  saved: T,
): T | FitCamera {
  return frame ? pictureCamera(effectiveExtent(extent).bounds, size, frame, saved) : saved;
}

/** The frame the page was handed, or null when it was handed none or a
 * malformed one. */
export function readPictureFrame(raw: unknown): PictureFrame | null {
  const padding = (raw as { padding?: unknown } | null)?.padding as Record<string, unknown> | undefined;
  if (!padding || typeof padding !== "object") return null;
  const sides = ["top", "right", "bottom", "left"] as const;
  if (!sides.every((side) => typeof padding[side] === "number" && Number.isFinite(padding[side]) && (padding[side] as number) >= 0)) return null;
  return { padding: { top: padding.top as number, right: padding.right as number, bottom: padding.bottom as number, left: padding.left as number } };
}
