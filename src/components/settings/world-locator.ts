import { WORLD_LAND, WORLD_SEAS } from "./world-rings";

/**
 * The world locator's geometry, framework-free: a coarse world on Web
 * Mercator in a box 176 by 110, the world as wide as the box and its top
 * edge at 78 degrees north, so the box holds the inhabited world from the
 * Arctic coasts down past Cape Horn. What a new map shows from its
 * starting view is marked on it, and a click on it gives the place under
 * the pointer.
 */

export const LOCATOR_WIDTH = 176;
export const LOCATOR_HEIGHT = 110;
const TOP_LATITUDE = 78;
/** The basemap's tile size: the world is this many pixels wide at zoom 0. */
const TILE = 512;
/** What the builder's stage at 1280 by 800 shows of the world, in pixels. */
const STAGE = { width: 828, height: 724 } as const;
/** A view area narrower than this, in the box's units, is drawn as a point. */
const AREA_MIN = 7;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
/** Mercator stops short of the poles. */
const LATITUDE_LIMIT = 85.05;

/** A longitude's place across the world's width, as a share of it. */
const across = (longitude: number) => (longitude + 180) / 360;
/** A latitude's place down the world's height, from its top, as a share of it. */
function down(latitude: number): number {
  const sine = Math.sin((clamp(latitude, -LATITUDE_LIMIT, LATITUDE_LIMIT) * Math.PI) / 180);
  return 0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI);
}
/** The latitude at a share of the world's height. */
const latitudeAt = (share: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * share))) * 180) / Math.PI;
const TOP = down(TOP_LATITUDE);

/** A place in the box's units. */
const boxX = (longitude: number) => across(longitude) * LOCATOR_WIDTH;
const boxY = (latitude: number) => (down(latitude) - TOP) * LOCATOR_WIDTH;
const tenth = (value: number) => Math.round(value * 10) / 10;

function rings(list: readonly string[]): string {
  return list.map(ring => "M" + ring.split(",").map(pair => {
    const [longitude, latitude] = pair.trim().split(/\s+/).map(Number);
    return `${tenth(boxX(longitude))} ${tenth(boxY(latitude))}`;
  }).join("L") + "Z").join("");
}

let drawn: { readonly land: string; readonly seas: string } | null = null;

/** The land and the two inland seas as path data in the box's units, made once. */
export function locatorPaths(): { readonly land: string; readonly seas: string } {
  drawn ??= { land: rings(WORLD_LAND), seas: rings(WORLD_SEAS) };
  return drawn;
}

export type ViewMark =
  | { readonly kind: "area"; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  | { readonly kind: "point"; readonly x: number; readonly y: number };

/** What a new map shows from a starting view, in the box's units: the area
 * the builder's stage covers, or its centre once that area is too small
 * to see. */
export function viewMark(latitude: number, longitude: number, zoom: number): ViewMark {
  const x = boxX(clamp(longitude, -180, 180)), y = boxY(latitude);
  const world = TILE * 2 ** zoom;
  const width = (STAGE.width / world) * LOCATOR_WIDTH, height = (STAGE.height / world) * LOCATOR_WIDTH;
  return width >= AREA_MIN ? { kind: "area", x: x - width / 2, y: y - height / 2, width, height } : { kind: "point", x, y };
}

/** The place under a click, from where it fell as shares of the box's width
 * and height: to two places at a world's view, to four from zoom 5. A click
 * past an edge counts at the edge. */
export function pointAt(shareAcross: number, shareDown: number, zoom: number): { latitude: number; longitude: number } {
  const places = 10 ** (zoom < 5 ? 2 : 4);
  const round = (value: number) => Math.round(value * places) / places + 0;
  const longitude = clamp(shareAcross, 0, 1) * 360 - 180;
  const latitude = clamp(latitudeAt(TOP + (clamp(shareDown, 0, 1) * LOCATOR_HEIGHT) / LOCATOR_WIDTH), -85, 85);
  return { latitude: round(latitude), longitude: round(longitude) };
}
