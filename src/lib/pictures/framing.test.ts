import { describe, expect, it } from "vitest";
import { WebMercatorViewport } from "@deck.gl/core";
import type { Bounds } from "@/lib/geo-bounds";
import { FIT_MAX_ZOOM } from "@/lib/fit-camera";
import { pageFrame, pictureCamera, readPictureFrame, renderCamera, widerThanOneWorld, worldCamera } from "./framing";
import type { ExtentLayer } from "@/lib/map-extent";
import { PICTURE_SHAPES } from "./shapes";

// deck.gl's own Web Mercator viewport, an implementation independent of
// the one under test, with MapLibre's camera (1.5 heights away).
function screen(camera: ReturnType<typeof pictureCamera>, size: { width: number; height: number }, [lng, lat]: [number, number]) {
  const [x, y] = new WebMercatorViewport({
    ...size, longitude: camera.lng, latitude: camera.lat, zoom: camera.zoom, pitch: camera.pitch, bearing: camera.bearing,
  }).project([lng, lat]);
  return { x, y };
}
const corners = ([[w, s], [e, n]]: Bounds): [number, number][] => [[w, n], [e, n], [e, s], [w, s]];

describe("pictureCamera", () => {
  const card = PICTURE_SHAPES.card;
  const size = card.frame;
  const frame = { padding: card.padding };
  const bounds: Bounds = [[-3.8, 40.3], [-3.6, 40.5]];

  it("frames flat data inside the margin, touching it on one axis and centred", () => {
    const camera = pictureCamera(bounds, size, frame, {});
    const points = corners(bounds).map((c) => screen(camera, size, c));
    const left = Math.min(...points.map((p) => p.x));
    const right = Math.max(...points.map((p) => p.x));
    const top = Math.min(...points.map((p) => p.y));
    const bottom = Math.max(...points.map((p) => p.y));
    expect(top).toBeCloseTo(card.padding.top, 3);
    expect(bottom).toBeCloseTo(size.height - card.padding.bottom, 3);
    expect(left).toBeGreaterThan(card.padding.left);
    expect(left).toBeCloseTo(size.width - right, 3);
  });

  const insideMargin = (box: Bounds, c: ReturnType<typeof pictureCamera>) => corners(box).map((corner) => screen(c, size, corner)).every((p) =>
    p.x >= card.padding.left - 0.05 && p.x <= size.width - card.padding.right + 0.05 &&
    p.y >= card.padding.top - 0.05 && p.y <= size.height - card.padding.bottom + 0.05);

  it.each([30, 45, 60])("keeps a tilt of %s degrees with every corner inside the margin, never closer than Fit", (pitch) => {
    for (const box of [bounds, [[-10, 40], [30, 50]] as Bounds]) {
      for (const bearing of [0, 37]) {
        const fit = pictureCamera(box, size, frame, { bearing });
        const camera = pictureCamera(box, size, frame, { pitch, bearing });
        expect(camera.pitch).toBe(pitch);
        expect(camera.bearing).toBe(bearing);
        expect(insideMargin(box, camera)).toBe(true);
        expect(camera.zoom).toBeLessThanOrEqual(fit.zoom);
        // Where the tilt made it zoom out, it zoomed out no further than needed.
        if (camera.zoom < fit.zoom - 1e-9) expect(insideMargin(box, { ...camera, zoom: camera.zoom + 0.02 })).toBe(false);
      }
    }
  });

  it("zooms out where Fit's flat camera would let the tilted near corners leave the frame", () => {
    const wide: Bounds = [[-10, 40], [30, 50]];
    const fit = pictureCamera(wide, size, frame, {});
    expect(insideMargin(wide, { ...fit, pitch: 60 })).toBe(false);
    const camera = pictureCamera(wide, size, frame, { pitch: 60 });
    expect(camera.zoom).toBeLessThan(fit.zoom);
    expect(insideMargin(wide, camera)).toBe(true);
  });

  it("frames a single point at Fit's closest zoom, centred", () => {
    const camera = pictureCamera([[13.4, 52.52], [13.4, 52.52]], size, frame, { pitch: 40, bearing: 20 });
    expect(camera.zoom).toBe(FIT_MAX_ZOOM);
    const at = screen(camera, size, [13.4, 52.52]);
    expect(at.x).toBeCloseTo(size.width / 2, 3);
    expect(at.y).toBeCloseTo(size.height / 2, 3);
  });

  it("shows the world, flat and north up, when nothing is drawn, in each shape", () => {
    for (const shape of ["card", "wide"] as const) {
      const { frame: f, padding } = PICTURE_SHAPES[shape];
      const camera = pictureCamera(null, f, { padding }, { pitch: 50, bearing: 90 });
      expect(camera).toEqual({ lng: 0, lat: 20, zoom: Math.log2(f.width / 512), pitch: 0, bearing: 0 });
      // The antimeridian on both edges: the world exactly across the frame.
      expect(screen(camera, f, [-180, 20]).x).toBeCloseTo(0, 6);
      expect(screen(camera, f, [180, 20]).x).toBeCloseTo(f.width, 6);
    }
    expect(worldCamera({ width: 512 }).zoom).toBe(0);
  });
});

describe("data wider than one world", () => {
  const card = PICTURE_SHAPES.card;
  const size = card.frame;
  const frame = { padding: card.padding };
  // Where the world lands, read through deck.gl's viewport, not the
  // camera's own fields: the world once, edge to edge, centred on the
  // prime meridian at 20 degrees north.
  const acrossOnce = (camera: ReturnType<typeof pictureCamera>) => {
    expect(screen(camera, size, [-180, 20]).x).toBeCloseTo(0, 6);
    expect(screen(camera, size, [180, 20]).x).toBeCloseTo(size.width, 6);
    expect(screen(camera, size, [0, 20]).x).toBeCloseTo(size.width / 2, 6);
    expect(screen(camera, size, [0, 20]).y).toBeCloseTo(size.height / 2, 6);
    expect(camera.pitch).toBe(0);
    expect(camera.bearing).toBe(0);
  };

  it("draws data spread over most latitudes across one world, whatever the saved tilt and rotation", () => {
    const tall: Bounds = [[-30, -80], [30, 80]];
    expect(widerThanOneWorld(tall, size, card.padding)).toBe(true);
    acrossOnce(pictureCamera(tall, size, frame, {}));
    acrossOnce(pictureCamera(tall, size, frame, { pitch: 45, bearing: 30 }));
    // The canvas would clamp this fit (data reaching both poles): the rule
    // reads Fit's own zoom, so it takes the world instead.
    acrossOnce(pictureCamera([[-180, -84], [180, 84]], size, frame, {}));
  });

  it("draws data around most longitudes but few latitudes across one world", () => {
    const ring: Bounds = [[-170, -5], [170, 5]];
    expect(widerThanOneWorld(ring, size, card.padding)).toBe(true);
    acrossOnce(pictureCamera(ring, size, frame, { bearing: 90 }));
  });

  it("keeps Fit where the world it draws is at least as wide as the frame", () => {
    // The boundary: Fit's world is exactly the frame's width when the
    // data's span fills the room between the side margins.
    const room = (size.width - card.padding.left - card.padding.right) / size.width;
    const at = (span: number): Bounds => [[-span / 2, -1], [span / 2, 1]];
    expect(widerThanOneWorld(at(360 * room * 0.99), size, card.padding)).toBe(false);
    expect(widerThanOneWorld(at(360 * room * 1.01), size, card.padding)).toBe(true);
    // Near the pole but narrower than one world: Svalbard with northern
    // Greenland keeps Fit, tilt and rotation included.
    const arctic: Bounds = [[-60, 76], [30, 82]];
    expect(widerThanOneWorld(arctic, size, card.padding)).toBe(false);
    const camera = pictureCamera(arctic, size, frame, { pitch: 30, bearing: 20 });
    expect(camera.pitch).toBe(30);
    expect(camera.bearing).toBe(20);
    expect(camera.zoom).toBeGreaterThan(worldCamera(size).zoom);
  });

  it("switches with a filter that brings the data under one world, and back", () => {
    const year = (lng: number, lat: number, y: number) => ({ type: "Feature", properties: { year: y }, geometry: { type: "Point", coordinates: [lng, lat] } });
    const layer = (dims: ExtentLayer["dims"]): ExtentLayer => ({
      id: "q", visible: true, dims, tiles: null,
      geojson: { type: "FeatureCollection", features: [year(13.3, 52.5, 2000), year(13.5, 52.6, 2001), year(-150, -60, 2020), year(170, 70, 2020)] },
    });
    acrossOnce(renderCamera(frame, [layer([])], size, {}) as ReturnType<typeof pictureCamera>);
    const berlin = renderCamera(frame, [layer([{ field: "year", kind: "range", range: [1990, 2010] }])], size, {});
    expect(berlin).toEqual(pictureCamera([[13.3, 52.5], [13.5, 52.6]], size, frame, {}));
    expect((berlin as ReturnType<typeof pictureCamera>).zoom).toBeGreaterThan(5);
  });
});

describe("readPictureFrame", () => {
  it("reads a frame's four margins and refuses anything else", () => {
    expect(readPictureFrame({ padding: { top: 1, right: 2, bottom: 3, left: 4 } })).toEqual({ padding: { top: 1, right: 2, bottom: 3, left: 4 } });
    for (const raw of [undefined, null, {}, { padding: 5 }, { padding: { top: 1, right: 2, bottom: 3 } }, { padding: { top: -1, right: 2, bottom: 3, left: 4 } }, { padding: { top: Infinity, right: 2, bottom: 3, left: 4 } }]) {
      expect(readPictureFrame(raw)).toBeNull();
    }
  });
});

describe("the render page's camera", () => {
  const card = PICTURE_SHAPES.card;
  const frame = { padding: card.padding };
  const saved = { lng: 100, lat: -40, zoom: 2, pitch: 0, bearing: 0 };
  const point = (lng: number, lat: number, year: number) => ({ type: "Feature", properties: { year }, geometry: { type: "Point", coordinates: [lng, lat] } });
  const inline = (dims: ExtentLayer["dims"]): ExtentLayer => ({
    id: "a", visible: true, dims, tiles: null,
    geojson: { type: "FeatureCollection", features: [point(2, 48, 2000), point(3, 49, 2010), point(30, 60, 2020)] },
  });

  it("frames only under picture work", () => {
    const raw = { padding: card.padding };
    expect(pageFrame(true, raw)).toEqual(frame);
    expect(pageFrame(false, raw)).toBeNull();
    expect(pageFrame(true, undefined)).toBeNull();
  });

  it("keeps the definition's camera without a frame", () => {
    expect(renderCamera(null, [inline([])], card.frame, saved)).toBe(saved);
  });

  it("frames what the dimensions leave drawn, as Fit measures it", () => {
    const all = renderCamera(frame, [inline([])], card.frame, saved);
    const window = renderCamera(frame, [inline([{ field: "year", kind: "range", range: [1990, 2015] }])], card.frame, saved);
    expect(window).toEqual(pictureCamera([[2, 48], [3, 49]], card.frame, frame, saved));
    expect(all).toEqual(pictureCamera([[2, 48], [30, 60]], card.frame, frame, saved));
  });

  it("takes a tiled layer's archive box and leaves out hidden layers", () => {
    const tiled: ExtentLayer = { id: "t", visible: true, dims: [], geojson: null, tiles: [-120, 30, -100, 45] };
    const hidden: ExtentLayer = { ...inline([]), id: "h", visible: false };
    expect(renderCamera(frame, [tiled, hidden], card.frame, saved)).toEqual(pictureCamera([[-120, 30], [-100, 45]], card.frame, frame, saved));
  });

  it("shows the world when the dimensions leave nothing drawn", () => {
    const none = renderCamera(frame, [inline([{ field: "year", kind: "range", range: [1800, 1900] }])], card.frame, saved);
    expect(none).toEqual(worldCamera(card.frame));
  });
});
