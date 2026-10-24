import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DecodedImage } from "@/lib/export/png-codec";
import { pictureBasemap, PICTURE_LAND } from "../../../test-support/picture-basemap";
import { colourIn, decodePicture, framedPosition, mercator, pointStyle } from "../../../test-support/picture-pixels";
import { pictureProofClient } from "../../../test-support/pictures-http";
import { DEFAULT_WIDTH, PICTURE_SHAPE, pictureHeight } from "./shapes";

const base = process.env.DEZFIL_PICTURE_TEST_URL;
const ORANGE = [233, 90, 45], KELP = [26, 93, 74], BLUE = [40, 80, 220], MUSTARD = [200, 160, 20];
type Point = { lng: number; lat: number; colour: readonly number[]; fields?: string };
type View = { lng: number; lat: number; zoom: number; pitch: number; bearing: number };

/**
 * A map picture frames what the map draws, as the builder's Fit does:
 * every expectation here is worked out from the fixture's coordinates and
 * the picture's frame and margin (the arithmetic
 * itself is checked against deck.gl's fit in real-proof-controls), never
 * read from the renderer's camera, and each property is shown failing
 * against its own control: the saved view, a flat or north-up picture, the
 * filters and window ignored, the saved view for a map that draws nothing.
 *
 * Provisioning as for pictures.real-render.test.ts: an isolated production
 * instance named by DEZFIL_PICTURE_TEST_URL with DEZFIL_PICTURE_TEST_TOKEN,
 * its renderer allowed 127.0.0.1 in DEZFIL_EGRESS_ALLOWLIST for the
 * loopback ground this test serves:
 * npm test -- src/lib/pictures/framing.real-render.test.ts --maxWorkers=1
 */
describe.skipIf(!base)("a picture frames what the map draws", () => {
  const api = base ? pictureProofClient(base, process.env.DEZFIL_PICTURE_TEST_TOKEN ?? "") : undefined!;
  const maps: string[] = [];
  let ground: Awaited<ReturnType<typeof pictureBasemap>>;
  beforeAll(async () => { ground = await pictureBasemap(); });
  afterAll(async () => {
    for (const id of maps) await api.request("DELETE", `/api/maps/${id}`, undefined, id);
    await ground?.close();
  });

  /** A map on the loopback ground, saved at `view`, with these layers. A
   * layer is created with its name, SQL and style; a `viz` is set after. */
  async function withLayers(name: string, view: View, bodies: ({ viz?: object } & Record<string, unknown>)[], box?: [number, number, number, number]) {
    const map = await api.json<{ id: string }>("POST", "/api/maps", { name }); maps.push(map.id);
    const url = box ? `${ground.origin}/box.json?w=${box[0]}&s=${box[1]}&e=${box[2]}&n=${box[3]}` : `${ground.origin}/plain.json`;
    await api.json("PATCH", `/api/maps/${map.id}`, { viewport: view, customBasemap: { url, name: "Framing fixture", attribution: [{ label: "Fixture" }] } }, map.id);
    const layers: { id: string }[] = [];
    for (const { viz, ...body } of bodies) {
      const layer = await api.json<{ id: string }>("POST", `/api/maps/${map.id}/layers`, body, map.id);
      if (viz) await api.json("PATCH", `/api/layers/${layer.id}`, { viz }, map.id);
      layers.push(layer);
    }
    return { id: map.id, layers };
  }
  /** A map on the loopback ground, saved at `view`, one layer per point. */
  const drawn = (name: string, view: View, points: Point[], box?: [number, number, number, number]) =>
    withLayers(name, view, points.map((point, i) => ({ name: `Point ${i}`, sql: `SELECT ST_Point(${point.lng}, ${point.lat}) AS geom${point.fields ?? ""}`, style: pointStyle(point.colour, 10) })), box);
  /** The picture after the last edit: its master and the default PNG,
   * decoded; the wide name answers the same master. */
  async function pictures(mapId: string) {
    // Edits reach the picture service just after their answer; a picture
    // current now predates the last edit, so wait for the next one.
    await new Promise(resolve => setTimeout(resolve, 1500));
    const row = (await api.json<{ id: string; pictureState: string; pictureVersion: string | null }[]>("GET", "/api/maps")).find(item => item.id === mapId)!;
    const ready = await api.picture(mapId, "current", row.pictureState === "current" ? row.pictureVersion : undefined);
    const bytes = async (query: string) => new Uint8Array(await (await api.request("GET", `/api/maps/${mapId}/thumbnail?v=${ready.pictureVersion}${query}`)).arrayBuffer());
    const widest = PICTURE_SHAPE.widths.at(-1)!;
    const master = await bytes(`&shape=card&width=${widest}`);
    expect(Buffer.from(await bytes(`&shape=wide&width=${widest}`)).equals(Buffer.from(master)), "the wide name answers the one shape").toBe(true);
    return { version: ready.pictureVersion, master: await decodePicture(master), png: await decodePicture(await bytes("")) };
  }
  const imagesOf = (shown: Awaited<ReturnType<typeof pictures>>) => [shown.master, shown.png];
  const scaleOf = (image: DecodedImage) => image.width / PICTURE_SHAPE.frame.width;
  /** Within a CSS pixel and a half of the frame, plus a pixel. */
  const tolerance = (image: DecodedImage) => 1.5 * scaleOf(image) + 1;
  function found(image: DecodedImage, colour: readonly number[]) {
    const mark = colourIn(image, colour);
    expect(mark.count, `colour ${colour} drawn`).toBeGreaterThanOrEqual(12);
    return mark;
  }
  /** Where the saved view itself would draw a point: the control. */
  const savedAt = (image: DecodedImage, view: View) => (lng: number, lat: number) => {
    const { frame } = PICTURE_SHAPE, k = scaleOf(image), world = 512 * 2 ** view.zoom;
    const [x, y] = mercator(lng, lat), [cx, cy] = mercator(view.lng, view.lat);
    return { x: (frame.width / 2 + (x - cx) * world) * k, y: (frame.height / 2 + (y - cy) * world) * k };
  };
  const apart = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  /** The margin lines in an image's pixels. */
  const marginOf = (image: DecodedImage) => {
    const { padding } = PICTURE_SHAPE, k = scaleOf(image);
    return { left: padding.left * k, right: image.width - padding.right * k, top: padding.top * k, bottom: image.height - padding.bottom * k };
  };
  const edit = (mapId: string, body: object, route = `/api/maps/${mapId}`) => api.json("PATCH", route, body, mapId);

  it("frames flat data against the margin on the side that limits it and centred on the other, not at the saved view", async () => {
    // One fixture wider than the room inside the margin, one taller: both cases are seen.
    const fixtures: Record<string, Point[]> = {
      wide: [{ lng: 13.4, lat: 0, colour: ORANGE }, { lng: 13.43, lat: 0.004, colour: KELP }, { lng: 13.46, lat: -0.002, colour: BLUE }],
      tall: [{ lng: 13.4, lat: 0, colour: ORANGE }, { lng: 13.41, lat: 0.012, colour: KELP }, { lng: 13.42, lat: -0.006, colour: BLUE }],
    };
    const limits: Record<string, string[]> = {};
    for (const [name, points] of Object.entries(fixtures)) {
      const saved: View = { lng: 13.43, lat: 0.003, zoom: 12, pitch: 0, bearing: 0 };
      const map = await drawn(`Framing: flat, ${name}`, saved, points);
      limits[name] = [];
      for (const image of imagesOf(await pictures(map.id))) {
        const fit = framedPosition(points.map(p => [p.lng, p.lat] as const), image.width), control = savedAt(image, saved);
        const tol = tolerance(image), k = scaleOf(image);
        const at = points.map(point => {
          const mark = found(image, point.colour);
          expect(apart(mark, fit.at(point.lng, point.lat)), `${name} ${image.width}: ${point.colour} where Fit puts it`).toBeLessThan(tol);
          expect(apart(mark, control(point.lng, point.lat)), `${name}: not the saved view`).toBeGreaterThan(10 * k);
          return mark;
        });
        const margin = marginOf(image);
        const gaps = { left: Math.min(...at.map(m => m.x)) - margin.left, right: margin.right - Math.max(...at.map(m => m.x)),
          top: Math.min(...at.map(m => m.y)) - margin.top, bottom: margin.bottom - Math.max(...at.map(m => m.y)) };
        const across = Math.abs(gaps.left) < tol && Math.abs(gaps.right) < tol && Math.abs(gaps.top - gaps.bottom) < 2 * tol && gaps.top > tol;
        const down = Math.abs(gaps.top) < tol && Math.abs(gaps.bottom) < tol && Math.abs(gaps.left - gaps.right) < 2 * tol && gaps.left > tol;
        expect(across !== down, `${name}: one side limits, the other is centred (${JSON.stringify(gaps)})`).toBe(true);
        limits[name].push(across ? "width" : "height");
      }
    }
    expect(limits).toEqual({ wide: ["width", "width"], tall: ["height", "height"] });
  }, 300000);

  it("keeps every size, at its own pixel size, under either name, and the default PNG", async () => {
    const map = await drawn("Framing: sizes", { lng: 13.4, lat: 0, zoom: 10, pitch: 0, bearing: 0 }, [{ lng: 13.4, lat: 0, colour: KELP }, { lng: 13.5, lat: 0.03, colour: BLUE }]);
    const ready = await pictures(map.id);
    for (const shape of ["card", "wide"] as const) for (const width of PICTURE_SHAPE.widths) {
      const response = await api.request("GET", `/api/maps/${map.id}/thumbnail?v=${ready.version}&shape=${shape}&width=${width}`);
      expect(response.headers.get("content-type")).toBe("image/webp");
      const image = await decodePicture(new Uint8Array(await response.arrayBuffer()));
      expect([image.width, image.height], `${shape} ${width}`).toEqual([width, pictureHeight(width)]);
      found(image, KELP);
    }
    const png = await api.request("GET", `/api/maps/${map.id}/thumbnail?v=${ready.version}`);
    expect(png.headers.get("content-type")).toBe("image/png");
    const image = await decodePicture(new Uint8Array(await png.arrayBuffer()));
    expect([image.width, image.height]).toEqual([DEFAULT_WIDTH, pictureHeight(DEFAULT_WIDTH)]);
  }, 240000);

  it("keeps the saved tilt with every mark inside the margin, where a flat picture is the control", async () => {
    const points: Point[] = [{ lng: 13.4, lat: 0, colour: ORANGE }, { lng: 13.42, lat: 0, colour: KELP }, { lng: 13.4, lat: 0.02, colour: BLUE }, { lng: 13.42, lat: 0.02, colour: MUSTARD }];
    const view: View = { lng: 13.41, lat: 0.01, zoom: 9, pitch: 45, bearing: 0 };
    const map = await drawn("Framing: tilt", view, points);
    const shape = (shown: Awaited<ReturnType<typeof pictures>>) => imagesOf(shown).filter(image => image.width > DEFAULT_WIDTH).map(image => {
      const [sw, se, nw, ne] = points.map(point => found(image, point.colour));
      const margin = marginOf(image), tol = tolerance(image);
      for (const mark of [sw, se, nw, ne]) {
        expect(mark.x).toBeGreaterThan(margin.left - tol); expect(mark.x).toBeLessThan(margin.right + tol);
        expect(mark.y).toBeGreaterThan(margin.top - tol); expect(mark.y).toBeLessThan(margin.bottom + tol);
      }
      return { far: (ne.x - nw.x) / (se.x - sw.x), depth: ((sw.y + se.y) / 2 - (nw.y + ne.y) / 2) / (se.x - sw.x) };
    });
    for (const seen of shape(await pictures(map.id))) {
      expect(seen.far, "the far edge is drawn narrower").toBeLessThan(0.95);
      expect(seen.depth, "the square is foreshortened").toBeLessThan(0.9);
    }
    await edit(map.id, { viewport: { ...view, pitch: 0 } });
    for (const seen of shape(await pictures(map.id))) {
      expect(seen.far).toBeGreaterThan(0.98);
      expect(seen.depth).toBeGreaterThan(0.95);
    }
  }, 300000);

  it("keeps the saved rotation, where a north-up picture is the control", async () => {
    const points: Point[] = [{ lng: 13.4, lat: 0, colour: ORANGE }, { lng: 13.44, lat: 0, colour: KELP }, { lng: 13.42, lat: 0.01, colour: BLUE }];
    const view: View = { lng: 13.42, lat: 0.005, zoom: 9, pitch: 0, bearing: 30 };
    const map = await drawn("Framing: rotation", view, points);
    const angles = (shown: Awaited<ReturnType<typeof pictures>>) => imagesOf(shown).map(image => {
      const west = found(image, ORANGE), east = found(image, KELP), margin = marginOf(image), tol = tolerance(image);
      for (const mark of points.map(point => found(image, point.colour))) {
        expect(mark.x).toBeGreaterThan(margin.left - tol); expect(mark.x).toBeLessThan(margin.right + tol);
        expect(mark.y).toBeGreaterThan(margin.top - tol); expect(mark.y).toBeLessThan(margin.bottom + tol);
      }
      // East points up and to the right when the top of the picture faces north-east.
      return (Math.atan2(-(east.y - west.y), east.x - west.x) * 180) / Math.PI;
    });
    for (const angle of angles(await pictures(map.id))) expect(Math.abs(angle - 30)).toBeLessThan(2);
    await edit(map.id, { viewport: { ...view, bearing: 0 } });
    for (const angle of angles(await pictures(map.id))) expect(Math.abs(angle)).toBeLessThan(2);
  }, 300000);

  it("puts a single point at the centre at Fit's closest zoom, not the saved one", async () => {
    const point: Point = { lng: 13.43, lat: 0.005, colour: KELP };
    const side = 0.004;
    const saved: View = { lng: 13.43, lat: 0.005, zoom: 12, pitch: 0, bearing: 0 };
    const map = await drawn("Framing: one point", saved, [point], [point.lng - side / 2, point.lat - side / 2, point.lng + side / 2, point.lat + side / 2]);
    for (const image of imagesOf(await pictures(map.id))) {
      const mark = found(image, point.colour), k = scaleOf(image), tol = tolerance(image);
      expect(Math.abs(mark.x - image.width / 2)).toBeLessThan(tol);
      expect(Math.abs(mark.y - image.height / 2)).toBeLessThan(tol);
      const land = found(image, PICTURE_LAND);
      const at = (zoom: number) => (side / 360) * 512 * 2 ** zoom * k;
      expect(Math.abs(land.right - land.left - at(15)), `${image.width}: drawn at zoom 15`).toBeLessThan(2 * tol);
      expect(land.right - land.left).toBeGreaterThan(4 * at(saved.zoom));
    }
  }, 240000);

  it.each(["filter", "timeline window"] as const)("frames only what the %s leaves drawn", async narrowing => {
    const kept: Point[] = [{ lng: 13.4, lat: 0, colour: ORANGE }, { lng: 13.43, lat: 0.012, colour: KELP }, { lng: 13.46, lat: -0.006, colour: BLUE }];
    const left: Point = { lng: 14.2, lat: 0.08, colour: MUSTARD, fields: ", 1 AS value, TIMESTAMP '2020-01-01' AS time" };
    const map = await drawn(`Framing: ${narrowing}`, { lng: 13.6, lat: 0.03, zoom: 9, pitch: 0, bearing: 0 }, [...kept, left]);
    const outside = map.layers[kept.length].id;
    if (narrowing === "filter") await edit(map.id, { filters: [{ kind: "range", field: "value", min: 2, max: null }] }, `/api/layers/${outside}`);
    else {
      await edit(map.id, { filters: [{ kind: "timerange", field: "time", min: "2027-01-01", max: "2028-01-01" }] }, `/api/layers/${outside}`);
      await edit(map.id, { timeline: { layerId: outside, field: "time", speed: 1 } });
    }
    for (const image of imagesOf(await pictures(map.id))) {
      expect(colourIn(image, left.colour).count, "the narrowed point is not drawn").toBeLessThan(12);
      const only = framedPosition(kept.map(p => [p.lng, p.lat] as const), image.width);
      const ignored = framedPosition([...kept, left].map(p => [p.lng, p.lat] as const), image.width);
      const misses = kept.map(point => {
        const mark = found(image, point.colour);
        expect(apart(mark, only.at(point.lng, point.lat))).toBeLessThan(tolerance(image));
        return apart(mark, ignored.at(point.lng, point.lat));
      });
      // The control: framed with the narrowed point too, the marks would
      // sit elsewhere. A mark on the side both boxes share sits at the
      // margin in both, so the picture as a whole is what must disagree.
      expect(Math.max(...misses), `${image.width}: framed as if nothing were narrowed`).toBeGreaterThan(10 * scaleOf(image));
    }
  }, 300000);

  it("shows the world, flat and north up, for a map that draws nothing, not its saved view", async () => {
    const box = [0, 0, 60, 40] as [number, number, number, number];
    const saved: View = { lng: 100, lat: -40, zoom: 3, pitch: 40, bearing: 60 };
    const map = await drawn("Framing: nothing drawn", saved, [], box);
    for (const image of imagesOf(await pictures(map.id))) {
      const { frame } = PICTURE_SHAPE, k = scaleOf(image), tol = 2 * tolerance(image);
      const world = (lng: number, lat: number) => {
        const [x, y] = mercator(lng, lat), [, cy] = mercator(0, 20);
        return { x: (frame.width / 2 + (x - 0.5) * frame.width) * k, y: (frame.height / 2 + (y - cy) * frame.width) * k };
      };
      const land = found(image, PICTURE_LAND), sw = world(box[0], box[1]), ne = world(box[2], box[3]);
      expect(Math.abs(land.left - sw.x), `${image.width}: west edge`).toBeLessThan(tol);
      expect(Math.abs(land.right - ne.x)).toBeLessThan(tol);
      expect(Math.abs(land.top - ne.y)).toBeLessThan(tol);
      expect(Math.abs(land.bottom - sw.y)).toBeLessThan(tol);
      const control = savedAt(image, saved)(box[0], box[1]);
      expect(Math.abs(land.left - control.x)).toBeGreaterThan(50 * k);
    }
  }, 240000);

  // Data wider than one world: the world once across the picture, edge to
  // edge, centred on the prime meridian at 20 degrees north, flat and north
  // up, whatever the saved view. Each expectation is worked out from the
  // fixture's coordinates; the controls are Fit's own framing, where the
  // world would be narrower than the picture and repeat, and the saved
  // view, centred elsewhere.
  const RED = [200, 30, 60], CYAN = [30, 180, 200], PINK = [230, 120, 200], GREEN = [90, 200, 60], BROWN = [140, 90, 40], INK = [30, 30, 30], GREY = [120, 120, 120];
  /** Where the world once across the frame puts a point. */
  const worldAt = (image: DecodedImage) => (lng: number, lat: number) => {
    const { frame } = PICTURE_SHAPE, k = scaleOf(image);
    const [x, y] = mercator(lng, lat), [, cy] = mercator(0, 20);
    return { x: (frame.width / 2 + (x - 0.5) * frame.width) * k, y: (frame.height / 2 + (y - cy) * frame.width) * k };
  };
  /** Every point where the world once puts it, or not drawn when that is
   * past the picture's top or foot; and the marks seen to miss both
   * controls. */
  function expectAcrossOnce(image: DecodedImage, points: Point[], saved: View, what: string) {
    const world = worldAt(image), k = scaleOf(image), tol = tolerance(image), radius = 10 * k;
    const fit = framedPosition(points.map(p => [p.lng, p.lat] as const), image.width), control = savedAt(image, saved);
    let fitMiss = 0, savedMiss = 0, drawnCount = 0;
    for (const point of points) {
      const want = world(point.lng, point.lat);
      if (want.y + radius < 0 || want.y - radius > image.height) {
        expect(colourIn(image, point.colour).count, `${what} ${image.width}: ${point.lng}, ${point.lat} lies past the picture`).toBeLessThan(12);
        continue;
      }
      const mark = found(image, point.colour);
      expect(apart(mark, want), `${what} ${image.width}: ${point.lng}, ${point.lat} where the world once puts it`).toBeLessThan(tol);
      fitMiss = Math.max(fitMiss, apart(mark, fit.at(point.lng, point.lat)));
      savedMiss = Math.max(savedMiss, apart(mark, control(point.lng, point.lat)));
      drawnCount += 1;
    }
    expect(drawnCount, `${what}: marks drawn to check`).toBeGreaterThanOrEqual(3);
    expect(fitMiss, `${what} ${image.width}: not Fit's narrower world`).toBeGreaterThan(10 * k);
    expect(savedMiss, `${what} ${image.width}: not centred at the saved view`).toBeGreaterThan(10 * k);
  }
  /** The ground's one land box where the world once puts it: drawn once,
   * not repeated beside itself. */
  function expectOneLand(image: DecodedImage, box: [number, number, number, number], what: string) {
    const world = worldAt(image), tol = 2 * tolerance(image);
    const land = found(image, PICTURE_LAND), sw = world(box[0], box[1]), ne = world(box[2], box[3]);
    expect(Math.abs(land.left - sw.x), `${what} ${image.width}: the land's west edge`).toBeLessThan(tol);
    expect(Math.abs(land.right - ne.x), `${what} ${image.width}: the land's east edge, one box wide`).toBeLessThan(tol);
    expect(Math.abs(land.top - ne.y)).toBeLessThan(tol);
    expect(Math.abs(land.bottom - sw.y)).toBeLessThan(tol);
  }
  const LAND_BOX = [-20, 0, 20, 30] as [number, number, number, number];
  const CONTINENTS: Point[] = [
    { lng: 0, lat: 20, colour: ORANGE }, { lng: -100, lat: 40, colour: KELP }, { lng: -60, lat: -30, colour: BLUE },
    { lng: 20, lat: 0, colour: MUSTARD }, { lng: 10, lat: 50, colour: RED }, { lng: 100, lat: 30, colour: CYAN },
    { lng: 135, lat: -25, colour: PINK }, { lng: 172, lat: 20, colour: GREEN }, { lng: -172, lat: 20, colour: BROWN },
    { lng: 0, lat: -80, colour: INK }, { lng: 0, lat: 80, colour: GREY },
  ];

  it("draws points on every continent from 80 south to 80 north across one world, saved tilted and rotated", async () => {
    const saved: View = { lng: 60, lat: -10, zoom: 2, pitch: 40, bearing: 30 };
    const map = await drawn("World: every continent", saved, CONTINENTS, LAND_BOX);
    for (const image of imagesOf(await pictures(map.id))) {
      expectAcrossOnce(image, CONTINENTS, saved, "continents");
      expectOneLand(image, LAND_BOX, "continents");
    }
  }, 300000);

  it("draws points along the equator around the globe across one world, wide and not tall", async () => {
    const ring: Point[] = [-175, -90, 0, 90, 175].map((lng, i) => ({ lng, lat: 0, colour: [ORANGE, KELP, BLUE, MUSTARD, RED][i] }));
    const saved: View = { lng: 0, lat: 0, zoom: 1, pitch: 0, bearing: 0 };
    const map = await drawn("World: the equator", saved, ring, LAND_BOX);
    for (const image of imagesOf(await pictures(map.id))) {
      expectAcrossOnce(image, ring, saved, "equator");
      expectOneLand(image, LAND_BOX, "equator");
    }
  }, 300000);

  // Origin-destination pairs drawn flat (the line form of the arc layer):
  // an arc's height lifts its middle off the ground, and under the camera's
  // perspective the middle then spreads past its ends, so only a flat pair's
  // outermost pixels are its ends.
  it("draws origin-destination pairs around the globe across one world, their ends where the world once puts them", async () => {
    const arcs = [
      { from: [-170, 30], to: [170, 30], colour: BLUE },
      { from: [-120, -40], to: [150, 60], colour: ORANGE },
    ] as const;
    const bodies = arcs.map((arc, i) => ({
      name: `Arc ${i}`,
      sql: `SELECT ST_Point(${arc.from[0]}, ${arc.from[1]}) AS o, ST_Point(${arc.to[0]}, ${arc.to[1]}) AS d`,
      style: { fill: { type: "constant", color: { r: arc.colour[0], g: arc.colour[1], b: arc.colour[2], a: 1 } }, stroke: { r: arc.colour[0], g: arc.colour[1], b: arc.colour[2], a: 1 }, strokeOpacity: 1, strokeWidth: 4, pointRadius: 0, opacity: 1 },
      viz: { type: "line", origin: { kind: "geometry", field: "o" }, dest: { kind: "geometry", field: "d" }, height: 0.6,
        targetColor: { r: arc.colour[0], g: arc.colour[1], b: arc.colour[2], a: 1 } },
    }));
    const saved: View = { lng: 0, lat: 0, zoom: 2, pitch: 0, bearing: 0 };
    const map = await withLayers("World: arcs", saved, bodies, LAND_BOX);
    for (const image of imagesOf(await pictures(map.id))) {
      const world = worldAt(image), k = scaleOf(image), tol = 2 * tolerance(image) + 2 * k;
      const fit = framedPosition(arcs.flatMap(arc => [arc.from, arc.to]), image.width);
      for (const arc of arcs) {
        const line = found(image, arc.colour);
        const west = world(arc.from[0], arc.from[1]), east = world(arc.to[0], arc.to[1]);
        expect(Math.abs(line.left - west.x), `${image.width}: the arc's west end`).toBeLessThan(tol);
        expect(Math.abs(line.right - east.x), `${image.width}: the arc's east end`).toBeLessThan(tol);
        expect(Math.abs(line.left - fit.at(arc.from[0], arc.from[1]).x), `${image.width}: not Fit's narrower world`).toBeGreaterThan(10 * k);
      }
      expectOneLand(image, LAND_BOX, "arcs");
    }
  }, 300000);

  it.each([
    ["Berlin", [{ lng: 13.3, lat: 52.45, colour: ORANGE }, { lng: 13.5, lat: 52.55, colour: KELP }, { lng: 13.4, lat: 52.6, colour: BLUE }]],
    ["Svalbard with northern Greenland", [{ lng: -60, lat: 80, colour: ORANGE }, { lng: -30, lat: 82, colour: KELP }, { lng: 15, lat: 78, colour: BLUE }, { lng: 25, lat: 79.5, colour: MUSTARD }]],
  ] as const)("keeps Fit for %s, narrower than one world", async (name, points) => {
    const saved: View = { lng: 0, lat: 20, zoom: 1, pitch: 0, bearing: 0 };
    const map = await drawn(`Regional: ${name}`, saved, [...points]);
    for (const image of imagesOf(await pictures(map.id))) {
      const fit = framedPosition(points.map(p => [p.lng, p.lat] as const), image.width), world = worldAt(image);
      let worldMiss = 0;
      for (const point of points) {
        const mark = found(image, point.colour);
        expect(apart(mark, fit.at(point.lng, point.lat)), `${name} ${image.width}: ${point.colour} where Fit puts it`).toBeLessThan(tolerance(image));
        worldMiss = Math.max(worldMiss, apart(mark, world(point.lng, point.lat)));
      }
      expect(worldMiss, `${name}: not the world across`).toBeGreaterThan(10 * scaleOf(image));
    }
  }, 300000);

  it("switches to Fit when a filter brings a world-wide map under one world, and back when it is cleared", async () => {
    const berlin: Point[] = [{ lng: 13.3, lat: 52.45, colour: ORANGE }, { lng: 13.5, lat: 52.55, colour: KELP }, { lng: 13.4, lat: 52.6, colour: BLUE }];
    const far: Point[] = [{ lng: -150, lat: -50, colour: MUSTARD, fields: ", 2 AS value" }, { lng: 170, lat: 60, colour: RED, fields: ", 2 AS value" }];
    const saved: View = { lng: 13.4, lat: 52.5, zoom: 9, pitch: 0, bearing: 0 };
    const map = await drawn("World: a filter", saved, [...berlin, ...far]);
    const farLayers = map.layers.slice(berlin.length);
    // Across one world Berlin's three points draw as one mark, the last on top.
    const seen = [berlin[berlin.length - 1], ...far];
    for (const image of imagesOf(await pictures(map.id))) expectAcrossOnce(image, seen, saved, "unfiltered");
    for (const layer of farLayers) await edit(map.id, { filters: [{ kind: "range", field: "value", min: null, max: 1 }] }, `/api/layers/${layer.id}`);
    for (const image of imagesOf(await pictures(map.id))) {
      const fit = framedPosition(berlin.map(p => [p.lng, p.lat] as const), image.width);
      for (const point of far) expect(colourIn(image, point.colour).count, "the filtered points are not drawn").toBeLessThan(12);
      for (const point of berlin) expect(apart(found(image, point.colour), fit.at(point.lng, point.lat)), `filtered ${image.width}: framed like Fit`).toBeLessThan(tolerance(image));
    }
    for (const layer of farLayers) await edit(map.id, { filters: [] }, `/api/layers/${layer.id}`);
    for (const image of imagesOf(await pictures(map.id))) expectAcrossOnce(image, seen, saved, "cleared");
  }, 400000);
});
