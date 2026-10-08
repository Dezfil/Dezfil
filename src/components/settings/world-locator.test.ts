import { describe, expect, it } from "vitest";
import { WORLD_LAND, WORLD_SEAS } from "./world-rings";
import { locatorPaths, pointAt, viewMark } from "./world-locator";

/**
 * The world locator beside a new map's starting view: a coarse world in a
 * box 176 by 110, the world as wide as the box and its top edge at 78
 * degrees north. Expected places come from the textbook form of Web
 * Mercator, kept apart from the module's own.
 */

const W = 176, H = 110;
/** A latitude's place down the world's height, from its top, as a share of it. */
const mercator = (latitude: number) => (1 - Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360)) / Math.PI) / 2;
const latitudeAt = (share: number) => (Math.atan(Math.exp(Math.PI * (1 - 2 * share))) * 360) / Math.PI - 90;
const TOP = mercator(78);
/** Where a latitude sits down the box, as a share of the box's height. */
const down = (latitude: number) => ((mercator(latitude) - TOP) * W) / H;
const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;
const BOTTOM = latitudeAt(TOP + H / W);

describe("a click on the locator", () => {
  it("puts its longitude across the world's width and its latitude on Mercator's scale, the top edge at 78 degrees north", () => {
    expect(pointAt(0.5, down(0), 1.3)).toEqual({ latitude: 0, longitude: 0 });
    expect(pointAt(0.75, down(51.5), 1.3)).toEqual({ latitude: 51.5, longitude: 90 });
    expect(pointAt(0, 0, 1.3)).toEqual({ latitude: 78, longitude: -180 });
    expect(pointAt(1, 1, 1.3)).toEqual({ latitude: round(BOTTOM, 2), longitude: 180 });
    expect(BOTTOM).toBeGreaterThan(-70);
    expect(BOTTOM).toBeLessThan(-68);
  });

  it("rounds to two places at a world's view and to four from zoom 5, and keeps a click past the box at its edge", () => {
    expect(pointAt(0.12345, down(48.85661), 1.3)).toEqual({ latitude: 48.86, longitude: -135.56 });
    expect(pointAt(0.12345, down(48.85661), 5)).toEqual({ latitude: 48.8566, longitude: -135.558 });
    expect(pointAt(-0.2, 1.4, 1.3)).toEqual({ latitude: round(BOTTOM, 2), longitude: -180 });
    expect(pointAt(1.3, -0.5, 1.3)).toEqual({ latitude: 78, longitude: 180 });
  });
});

describe("the starting view on the locator", () => {
  it("marks the area a new map shows, centred on its view, in the box's units", () => {
    const mark = viewMark(40, 0, 1.3);
    // What the builder's stage at 1280 by 800 shows of the world: 828 by 724 px of it.
    const world = 512 * 2 ** 1.3;
    expect(mark.kind).toBe("area");
    if (mark.kind !== "area") return;
    expect(mark.width).toBeCloseTo((828 / world) * W, 6);
    expect(mark.height).toBeCloseTo((724 / world) * W, 6);
    expect(mark.x + mark.width / 2).toBeCloseTo(W / 2, 6);
    expect(mark.y + mark.height / 2).toBeCloseTo((mercator(40) - TOP) * W, 6);
  });

  it("marks a point once that area is too small to see, at the view's place", () => {
    expect(viewMark(0, 0, 5.3).kind).toBe("area");
    const mark = viewMark(53.55, 9.99, 5.4);
    expect(mark.kind).toBe("point");
    expect(mark.x).toBeCloseTo(((9.99 + 180) / 360) * W, 6);
    expect(mark.y).toBeCloseTo((mercator(53.55) - TOP) * W, 6);
    expect(viewMark(-33.87, 151.21, 12)).toMatchObject({ kind: "point" });
  });
});

describe("the world it draws", () => {
  it("draws every ring of land and the two inland seas, each closed, within the box's width", () => {
    const { land, seas } = locatorPaths();
    expect(land.startsWith("M")).toBe(true);
    expect(land.split("Z").length - 1).toBe(WORLD_LAND.length);
    expect(seas.split("Z").length - 1).toBe(WORLD_SEAS.length);
    expect(WORLD_SEAS).toHaveLength(2);
    const xs = [...`${land}${seas}`.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map(match => Number(match[1]));
    expect(xs.length).toBeGreaterThan(500);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(W);
    // Made once: the same drawing every time.
    expect(locatorPaths()).toBe(locatorPaths());
  });
});
