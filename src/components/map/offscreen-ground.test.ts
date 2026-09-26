import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type maplibregl from "maplibre-gl";
import {
  OFFSCREEN_GROUND_ATTRIBUTE,
  OffscreenGroundError,
  renderOffscreenGround,
  type OffscreenGroundDeps,
  type OffscreenGroundRequest,
} from "./offscreen-ground";

/**
 * The offscreen ground's lifecycle against a fake renderer and a fake
 * document: the hidden host at the live CSS size, the complete painted
 * camera (padding before the constraint re-applies centre and zoom, pitch
 * and bearing carried), the group toggles applied over the style's own
 * authored visibilities, the canvas read inside a render event, and
 * disposal on every exit path.
 */

type Handler = (event?: unknown) => void;

function fakeDocument() {
  const calls: string[] = [];
  const body = {
    children: [] as unknown[],
    appendChild(el: unknown) {
      body.children.push(el);
    },
  };
  const element = (tag: string) => {
    const attrs: Record<string, string> = {};
    const el = {
      tag,
      style: {} as Record<string, string>,
      dataset: {} as Record<string, string>,
      width: 0,
      height: 0,
      attrs,
      setAttribute(name: string, value: string) {
        attrs[name] = value;
      },
      getAttribute(name: string) {
        return attrs[name] ?? null;
      },
      appendChild() {},
      remove() {
        body.children = body.children.filter((c) => c !== el);
        calls.push(`remove:${tag}`);
      },
      ctx: {
        fillStyle: "",
        fills: [] as [number, number, number, number][],
        drawn: [] as unknown[],
        fillRect(x: number, y: number, w: number, h: number) {
          el.ctx.fills.push([x, y, w, h]);
        },
        drawImage(source: unknown) {
          el.ctx.drawn.push(source);
        },
      },
      getContext() {
        return el.ctx;
      },
      // A clientHeight for the camera's zoom floor.
      clientHeight: 0,
    };
    return el;
  };
  const doc = {
    body,
    createElement: (tag: string) => element(tag),
  };
  return { doc: doc as unknown as OffscreenGroundDeps["document"], body, calls };
}

function fakeMap(styleLayers: { id: string; type: string; "source-layer"?: string; layout?: { visibility?: string } }[]) {
  const handlers = new Map<string, Handler[]>();
  const onces = new Map<string, Handler[]>();
  const order: string[] = [];
  let created: maplibregl.MapOptions | null = null;
  const layout = new Map<string, string>();
  for (const l of styleLayers) if (l.layout?.visibility) layout.set(l.id, l.layout.visibility);
  const canvas = { width: 1200, height: 800 };
  const state = { loaded: false, tilesLoaded: false, moving: false, removed: false };
  const map = {
    transform: {
      height: 400,
      padding: { top: 0, bottom: 0, left: 0, right: 0 },
      minZoom: -2,
      maxZoom: 24,
      setConstrainOverride: vi.fn(() => order.push("constrain")),
    },
    setMinZoom: vi.fn(),
    setPadding: vi.fn((p: unknown) => {
      order.push("setPadding");
      map.transform.padding = p as typeof map.transform.padding;
    }),
    jumpTo: vi.fn(() => order.push("jumpTo")),
    on: vi.fn((name: string, cb: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), cb]);
    }),
    once: vi.fn((name: string, cb: Handler) => {
      onces.set(name, [...(onces.get(name) ?? []), cb]);
    }),
    off: vi.fn((name: string, cb: Handler) => {
      handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== cb));
    }),
    triggerRepaint: vi.fn(),
    getCenter: () => ({ lng: 1, lat: 2 }),
    getZoom: () => 3,
    getPitch: () => 4,
    getBearing: () => 5,
    getStyle: () => ({ layers: styleLayers }),
    getLayoutProperty: (id: string) => layout.get(id),
    setLayoutProperty: vi.fn((id: string, _name: string, value: string) => {
      layout.set(id, value);
    }),
    loaded: () => state.loaded,
    areTilesLoaded: () => state.tilesLoaded,
    isMoving: () => state.moving,
    getCanvas: () => canvas,
    remove: vi.fn(() => {
      state.removed = true;
      order.push("remove");
    }),
  };
  const emit = (name: string, event?: unknown) => {
    for (const h of handlers.get(name) ?? []) h(event);
    const one = onces.get(name) ?? [];
    onces.set(name, []);
    for (const h of one) h(event);
  };
  const createMap = (options: maplibregl.MapOptions) => {
    created = options;
    return map as unknown as maplibregl.Map;
  };
  return { map, emit, createMap, order, state, layout, canvas, options: () => created! };
}

const request = (over: Partial<OffscreenGroundRequest> = {}): OffscreenGroundRequest => ({
  styleUrl: "https://tiles.test/styles/dark",
  camera: {
    lng: 13.4,
    lat: 52.5,
    zoom: 9.5,
    pitch: 30,
    bearing: -17,
    padding: { top: 62, right: 14, bottom: 14, left: 372 },
  },
  host: { cssWidth: 1200, cssHeight: 800, pixelRatio: 2 },
  basemapLayers: { labels: false },
  basemapKind: "vector",
  fallbackColor: "#0b0e14",
  timeoutMs: 5_000,
  ...over,
});

const STYLE = [
  { id: "background", type: "background" },
  { id: "water", type: "fill", "source-layer": "water" },
  { id: "place_city", type: "symbol", "source-layer": "place" },
  { id: "poi_hidden", type: "symbol", "source-layer": "poi", layout: { visibility: "none" } },
  { id: "road", type: "line", "source-layer": "transportation" },
];

describe("the offscreen ground", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("mounts a hidden host at the live CSS size off-viewport, and builds the map at the complete painted camera", async () => {
    const { doc, body } = fakeDocument();
    const fake = fakeMap(STYLE);
    const pending = renderOffscreenGround(request(), { createMap: fake.createMap, document: doc });
    const host = body.children[0] as { style: Record<string, string>; attrs: Record<string, string> };
    expect(host.attrs[OFFSCREEN_GROUND_ATTRIBUTE]).toBe("");
    expect(host.attrs["aria-hidden"]).toBe("true");
    expect(host.style).toMatchObject({
      position: "fixed",
      width: "1200px",
      height: "800px",
      visibility: "hidden",
      left: "-1264px",
    });
    const options = fake.options();
    expect(options).toMatchObject({
      style: "https://tiles.test/styles/dark",
      center: [13.4, 52.5],
      zoom: 9.5,
      pitch: 30,
      bearing: -17,
      interactive: false,
      attributionControl: false,
      pixelRatio: 2,
      minZoom: -2,
      maxZoom: 24,
      maxPitch: 60,
    });
    // Padding lands before the constraint re-applies centre and zoom under
    // it: the order the live canvas uses, so the same latitude clamp holds.
    expect(fake.map.setPadding).toHaveBeenCalledWith({ top: 62, right: 14, bottom: 14, left: 372 });
    expect(fake.order.slice(0, 3)).toEqual(["setPadding", "constrain", "jumpTo"]);
    expect(fake.map.jumpTo).toHaveBeenCalledWith({ center: [13.4, 52.5], zoom: 9.5 });
    // Settle and read.
    fake.emit("style.load");
    fake.state.loaded = true;
    fake.state.tilesLoaded = true;
    fake.emit("idle");
    expect(fake.map.triggerRepaint).toHaveBeenCalled();
    fake.emit("render");
    const ground = (await pending) as unknown as { width: number; height: number; ctx: { drawn: unknown[]; fillStyle: string } };
    expect(ground.width).toBe(1200);
    expect(ground.height).toBe(800);
    expect(ground.ctx.drawn).toEqual([fake.canvas]);
    expect(ground.ctx.fillStyle).toBe("#0b0e14");
    // Disposed: the instance removed, the host gone.
    expect(fake.map.remove).toHaveBeenCalledTimes(1);
    expect(body.children).toEqual([]);
  });

  it("applies the map's group toggles over the style's own authored visibilities, touching only what differs", async () => {
    const { doc } = fakeDocument();
    const fake = fakeMap(STYLE);
    const pending = renderOffscreenGround(request({ basemapLayers: { labels: false } }), {
      createMap: fake.createMap,
      document: doc,
    });
    fake.emit("style.load");
    // The visible label hides; the authored-hidden label is already
    // hidden and is left alone; water, roads and the background are untouched.
    expect(fake.map.setLayoutProperty.mock.calls).toEqual([["place_city", "visibility", "none"]]);
    fake.state.loaded = true;
    fake.state.tilesLoaded = true;
    fake.emit("idle");
    fake.emit("render");
    await pending;
  });

  it("decides nothing on imagery", async () => {
    const { doc } = fakeDocument();
    const fake = fakeMap(STYLE);
    const pending = renderOffscreenGround(
      request({ basemapKind: "imagery", basemapLayers: { land: false } }),
      { createMap: fake.createMap, document: doc },
    );
    fake.emit("style.load");
    expect(fake.map.setLayoutProperty).not.toHaveBeenCalled();
    fake.state.loaded = true;
    fake.state.tilesLoaded = true;
    fake.emit("idle");
    fake.emit("render");
    await pending;
  });

  it("does not read before the style is loaded, the tiles are in and the map is still", () => {
    const { doc } = fakeDocument();
    const fake = fakeMap(STYLE);
    void renderOffscreenGround(request(), { createMap: fake.createMap, document: doc }).catch(() => {});
    fake.emit("idle");
    expect(fake.map.once).not.toHaveBeenCalledWith("render", expect.anything());
    fake.emit("style.load");
    fake.state.loaded = true;
    fake.state.tilesLoaded = false;
    fake.emit("idle");
    expect(fake.map.once).not.toHaveBeenCalledWith("render", expect.anything());
    fake.state.tilesLoaded = true;
    fake.state.moving = true;
    vi.advanceTimersByTime(250);
    expect(fake.map.once).not.toHaveBeenCalledWith("render", expect.anything());
    fake.state.moving = false;
    vi.advanceTimersByTime(250);
    expect(fake.map.once).toHaveBeenCalledWith("render", expect.anything());
  });

  it("times out, rejecting and disposing the instance and the host", async () => {
    const { doc, body } = fakeDocument();
    const fake = fakeMap(STYLE);
    const pending = renderOffscreenGround(request({ timeoutMs: 1_000 }), {
      createMap: fake.createMap,
      document: doc,
    });
    const failed = pending.catch((e: unknown) => e);
    vi.advanceTimersByTime(1_001);
    const error = (await failed) as OffscreenGroundError;
    expect(error).toBeInstanceOf(OffscreenGroundError);
    expect(error.reason).toBe("timeout");
    expect(fake.map.remove).toHaveBeenCalledTimes(1);
    expect(body.children).toEqual([]);
  });

  it("is abandoned by its signal, rejecting and disposing", async () => {
    const { doc, body } = fakeDocument();
    const fake = fakeMap(STYLE);
    const controller = new AbortController();
    const pending = renderOffscreenGround(request({ signal: controller.signal }), {
      createMap: fake.createMap,
      document: doc,
    });
    const failed = pending.catch((e: unknown) => e);
    controller.abort();
    const error = (await failed) as OffscreenGroundError;
    expect(error.reason).toBe("abandoned");
    expect(fake.map.remove).toHaveBeenCalledTimes(1);
    expect(body.children).toEqual([]);
    // A late settle changes nothing.
    fake.emit("style.load");
    fake.state.loaded = true;
    fake.state.tilesLoaded = true;
    fake.emit("idle");
    expect(fake.map.once).not.toHaveBeenCalledWith("render", expect.anything());
  });

  it("a root style that cannot load yields the plain fallback ground, never a failed cycle", async () => {
    const { doc, body } = fakeDocument();
    const fake = fakeMap(STYLE);
    const pending = renderOffscreenGround(request({ fallbackColor: "#e9ecef" }), {
      createMap: fake.createMap,
      document: doc,
    });
    // A tile error first: not the root's, ignored.
    fake.emit("error", { error: { message: "Failed to fetch tile" }, sourceId: "openmaptiles" });
    fake.emit("error", { error: { message: "Failed to fetch", url: "https://tiles.test/styles/dark" } });
    const ground = (await pending) as unknown as { width: number; height: number; ctx: { fillStyle: string; fills: unknown[]; drawn: unknown[] } };
    expect([ground.width, ground.height]).toEqual([2400, 1600]);
    expect(ground.ctx.fillStyle).toBe("#e9ecef");
    expect(ground.ctx.fills).toEqual([[0, 0, 2400, 1600]]);
    expect(ground.ctx.drawn).toEqual([]);
    expect(fake.map.remove).toHaveBeenCalledTimes(1);
    expect(body.children).toEqual([]);
  });

  it("a factory that throws rejects and still leaves no host behind", async () => {
    const { doc, body } = fakeDocument();
    const pending = renderOffscreenGround(request(), {
      createMap: () => {
        throw new Error("no webgl");
      },
      document: doc,
    });
    await expect(pending).rejects.toThrow("no webgl");
    expect(body.children).toEqual([]);
  });
});
