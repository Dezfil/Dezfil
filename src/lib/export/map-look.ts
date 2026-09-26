import { createHash, randomUUID } from "node:crypto";
import { ApiError, EvaluationCancelled } from "@/lib/api/errors";
import { limits } from "@/lib/limits";
import { MAP_MIN_ZOOM } from "@/lib/map-runtime-limits";
import { mapWithLayers } from "@/lib/map-service";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { APPEARANCES, definitionRenderProblems, type Appearance, type ExportImageDefinition } from "./image-definition";
import { thumbnailOf, type Thumbnail } from "./look-thumbnail";
import { decodePng, encodePng, PngShapeError, scaleImage } from "./png-codec";
import { renderMapImage, type RenderDriver } from "./render-image";

/**
 * The model-facing check of a map: one bounded render through the export
 * road, derived downwards to the first size inside the byte bound,
 * answered with the render's facts. The definition is built from the
 * map's stored state and an explicit appearance (D3), the render has its
 * own budget (D5), the smaller sizes are derived from the one settled
 * render rather than rendered again (D4), the thumbnail the pane's note
 * keeps is derived here too, inside the same budget, and
 * the state identity names what the renderer actually consumed, declared
 * by the render page itself, never a later read of the map (row 1e).
 * Retention is the caller's: this module returns bytes and facts and
 * keeps nothing.
 */

export const LOOK_SOURCE = { width: 1024, height: 640 } as const;
/** The sizes the image may be answered at, largest first. */
export const LOOK_SIZES = [
  { width: 1024, height: 640 },
  { width: 768, height: 480 },
  { width: 512, height: 320 },
] as const;
export const LOOK_IMAGE_MAX_BYTES = 384 * 1024;

export interface LookCamera { lng: number; lat: number; zoom: number; pitch: number; bearing: number }
/** The bounded state identity: the configuration the renderer drew. */
export interface LookState {
  map: string;
  camera: LookCamera;
  /** The visible layers the renderer drew, each with a digest of the stored filters it applied. */
  layers: { id: string; filters: string }[];
  legend: { visible: boolean; corner: string; order: string[] };
  widgets: string[];
  appearance: Appearance;
  /** A digest of everything above, so two identities compare in one string. */
  digest: string;
}
export interface LookImage { width: number; height: number; bytes: number; png: Uint8Array }
/** The facts alone: what events, receipts and the model's text carry; never the bytes. */
export interface LookFacts {
  id: string;
  mapId: string;
  mapName: string;
  appearance: Appearance;
  state: LookState;
  image: { width: number; height: number; bytes: number };
  source: { width: number; height: number };
  attribution: string;
  composition: { failures: string[]; abandoned: string[] };
  elapsedMs: number;
}
export function lookFacts(result: LookResult): LookFacts {
  return {
    id: result.id, mapId: result.mapId, mapName: result.mapName, appearance: result.appearance, state: result.state,
    image: { width: result.image.width, height: result.image.height, bytes: result.image.bytes },
    source: result.source, attribution: result.attribution, composition: result.composition, elapsedMs: result.elapsedMs,
  };
}
export interface LookResult {
  /** The render's identity, minted per check. */
  id: string;
  mapId: string;
  mapName: string;
  appearance: Appearance;
  state: LookState;
  image: LookImage;
  /** The note's thumbnail of the image, prepared inside the check's budget for retention to keep. */
  thumbnail: Thumbnail;
  source: { width: number; height: number };
  attribution: string;
  composition: { failures: string[]; abandoned: string[] };
  elapsedMs: number;
}

export interface LookInput {
  mapId: string;
  appearance?: Appearance;
  baseUrl: string;
  signal?: AbortSignal;
  /** The check's request-to-response budget; the instance setting otherwise. */
  budgetMs?: number;
  /** Injected by tests and measurement; the real driver otherwise. */
  driver?: RenderDriver;
}

/** What the render page declares it consumed, on its root, once ready. */
interface ConsumedState {
  map: string;
  layers: { id: string; filters: unknown }[];
  legend: { visible: boolean; corner: string; order: string[] };
  widgets: string[];
  attribution?: string;
  failures?: string[];
}

/** Test seam (route suites and the scripted measurement arms): the driver
 * every check uses when its caller injects none; never set in production. */
let testDriver: RenderDriver | null = null;
export function setLookDriverForTests(driver: RenderDriver | null): void { testDriver = driver; }

export function isAppearance(value: unknown): value is Appearance {
  return typeof value === "string" && (APPEARANCES as readonly string[]).includes(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex").slice(0, 16);

/** The check's definition from the stored map (D3): the documented source
 * size at scale one, the stored camera raised to the smallest zoom that
 * size can draw, the legend where the map keeps it, every visible widget,
 * no title, the credit clear of the legend, the explicit appearance. */
export function lookDefinition(map: MapWithLayers, appearance: Appearance): ExportImageDefinition {
  const minZoom = Math.max(MAP_MIN_ZOOM, Math.log2(LOOK_SOURCE.height / 512));
  const legendCorner = map.legendCorner ?? "bottom-left";
  const legendVisible = map.layers.some((layer) => layer.visible);
  return {
    viewport: { lng: map.viewport.lng, lat: map.viewport.lat, zoom: Math.max(map.viewport.zoom, minZoom), pitch: map.viewport.pitch ?? 0, bearing: map.viewport.bearing ?? 0 },
    size: { ...LOOK_SOURCE },
    legend: { visible: legendVisible, corner: legendCorner, size: "s" },
    widgets: map.widgets.filter((w) => w.visible).map((w) => w.id),
    widgetSize: "s",
    title: null,
    credit: { corner: legendVisible && legendCorner === "bottom-right" ? "bottom-left" : "bottom-right", size: "s" },
    appearance,
    mapScale: 1,
  };
}

function parseConsumed(raw: string | undefined): ConsumedState {
  const failed = () => new ApiError("render_failed", "The renderer did not report what it drew, so the image cannot be attributed to a state.", 502);
  if (!raw) throw failed();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw failed(); }
  const record = value as Partial<ConsumedState> | null;
  if (!record || typeof record.map !== "string" || !Array.isArray(record.layers) || !record.legend || !Array.isArray(record.widgets)) throw failed();
  return record as ConsumedState;
}

/** The first size inside the byte bound, from the one settled render. */
function deriveImage(png: Uint8Array, signal?: AbortSignal): LookImage {
  const source = { width: LOOK_SOURCE.width, height: LOOK_SOURCE.height };
  if (png.byteLength <= LOOK_IMAGE_MAX_BYTES) return { ...source, bytes: png.byteLength, png };
  let decoded;
  try { decoded = decodePng(png); } catch (error) {
    if (error instanceof PngShapeError) throw new ApiError("render_failed", "The rendered image could not be read for resizing.", 502);
    throw error;
  }
  for (const size of LOOK_SIZES.slice(1)) {
    if (signal?.aborted) throw new EvaluationCancelled();
    const scaled = encodePng(scaleImage(decoded, size.width, size.height));
    if (scaled.byteLength <= LOOK_IMAGE_MAX_BYTES) return { width: size.width, height: size.height, bytes: scaled.byteLength, png: scaled };
  }
  throw new ApiError("look_image_too_large", `No image of the map fits inside ${Math.round(LOOK_IMAGE_MAX_BYTES / 1024)} KiB at any documented size, so none was returned.`, 413);
}

/** One bounded check: render, derive, attribute. Throws the documented
 * outcomes (map_not_found, render_timeout, render_unavailable,
 * render_failed, look_image_too_large) or the cancellation. */
export async function lookAtMap(input: LookInput): Promise<LookResult> {
  const started = performance.now();
  if (input.signal?.aborted) throw new EvaluationCancelled();
  const appearance = input.appearance ?? "light";
  const map = mapWithLayers(input.mapId);
  const definition = lookDefinition(map, appearance);
  const problems = definitionRenderProblems(definition);
  if (problems.length > 0) throw new ApiError("render_failed", `The map's stored view cannot be rendered at the check's size: ${problems[0]}.`, 502);
  // One deadline from the request through the render and the image's
  // preparation, the thumbnail included: a render answered inside the
  // budget whose derivation runs past it is the documented timeout,
  // never a late success.
  const budgetMs = input.budgetMs ?? limits.assistantLookTimeoutMs;
  const deadline = Date.now() + budgetMs;
  const rendered = await renderMapImage({
    mapId: map.id, definition, baseUrl: input.baseUrl, signal: input.signal, driver: input.driver ?? testDriver ?? undefined,
    budgetMs,
  });
  const consumed = parseConsumed(rendered.consumed);
  const image = deriveImage(rendered.png, input.signal);
  if (input.signal?.aborted) throw new EvaluationCancelled();
  const thumbnail = thumbnailOf(image);
  if (Date.now() > deadline) throw new ApiError("render_timeout", `The image render exceeded the ${Number.isInteger(budgetMs / 1000) ? budgetMs / 1000 : (budgetMs / 1000).toFixed(2)} s check budget (queue wait and image preparation included).`, 408);
  const layers = consumed.layers.map((layer) => ({ id: String(layer.id), filters: digest(layer.filters ?? null) }));
  const identity = {
    map: consumed.map,
    camera: { ...definition.viewport },
    layers,
    legend: { visible: Boolean(consumed.legend.visible), corner: String(consumed.legend.corner), order: consumed.legend.order.map(String) },
    widgets: consumed.widgets.map(String),
    appearance,
  };
  return {
    id: randomUUID(),
    mapId: map.id,
    mapName: map.name,
    appearance,
    state: { ...identity, digest: digest(identity) },
    image,
    thumbnail,
    source: { ...LOOK_SOURCE },
    attribution: consumed.attribution ?? "",
    composition: { failures: consumed.failures?.map(String) ?? [], abandoned: rendered.abandoned },
    elapsedMs: Math.round(performance.now() - started),
  };
}
