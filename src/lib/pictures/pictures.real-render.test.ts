import { buildTools } from "@/lib/tools/tools";
import { executeTool } from "@/lib/tools/execute";
import { readFile } from "node:fs/promises";
import { closedPictureAddress, pictureBasemap, PICTURE_GROUND, PICTURE_LAND } from "../../../test-support/picture-basemap";
import { assertPicturePatch, pictureMarkPosition, assertPictureMarks } from "../../../test-support/picture-pixels";
import { afterAll, describe, expect, it } from "vitest";
import { pictureProofClient } from "../../../test-support/pictures-http";
import { colourCentre, PICTURE_CAMERA, PICTURE_MARKS, pictureMarkSql } from "../../../test-support/picture-pixels";
const base = process.env.DEZFIL_PICTURE_TEST_URL;
/** An isolated running production instance, real renderer, real tile builder
 * and network access to its configured Auto styles. No browser upload or
 * opened builder is involved. The token belongs to a disposable account.
 * Run with a fresh DEZFIL_DATA_DIR, DEZFIL_PICTURE_TEST_URL and
 * DEZFIL_PICTURE_TEST_TOKEN:
 * npm test -- src/lib/pictures/pictures.real-render.test.ts --maxWorkers=2
 * For the pre-server-picture control add DEZFIL_PICTURE_EXPECT_NONE=1 and
 * -t "never opened". The URL may name any separately provisioned instance.
 * The drawing/failure fixtures run beside the renderer; allow 127.0.0.1 in
 * that instance's DEZFIL_EGRESS_ALLOWLIST. Redirect its stderr to a file
 * and set DEZFIL_PICTURE_RENDER_LOG to that file for the abandoned-request
 * case, which requires the real background attempt's abandonment record. */
describe.skipIf(!base)("server picture road", () => {
  const api = base ? pictureProofClient(base, process.env.DEZFIL_PICTURE_TEST_TOKEN ?? "") : undefined!;
  const maps: string[] = [];
  afterAll(async () => { for (const id of maps) await api.request("DELETE", `/api/maps/${id}`, undefined, id); });
  it.each(["Maps create endpoint", "API", "assistant tool", "empty duplicate"])("never opened: %s produces computed marks in both appearances", async road => {
    let map: { id: string };
    if (road === "assistant tool") {
      const result = await executeTool(buildTools().find(tool => tool.name === "create_map")!, { name: "Assistant picture proof" }, base!, fetch,
        { authorization: `Bearer ${process.env.DEZFIL_PICTURE_TEST_TOKEN}`, origin: new URL(base!).origin });
      expect(result.ok).toBe(true);
      map = result.body as { id: string };
    } else {
      // The Maps page and API both POST this documented creation endpoint.
      map = await api.json<{ id: string }>("POST", "/api/maps", { name: `Picture proof: ${road}` });
      if (road === "empty duplicate") {
        maps.push(map.id);
        await api.request("GET", `/api/maps/${map.id}/thumbnail`, undefined, undefined, 404);
        map = await api.json<{ id: string }>("POST", `/api/maps/${map.id}/duplicate`);
        await api.request("GET", `/api/maps/${map.id}/thumbnail`, undefined, undefined, 404);
      }
    }
    maps.push(map.id);
    await api.json("PATCH", `/api/maps/${map.id}`, { viewport: PICTURE_CAMERA, basemap: null }, map.id);
    for (const layer of pictureMarkSql()) await api.json("POST", `/api/maps/${map.id}/layers`, layer, map.id);
    if (process.env.DEZFIL_PICTURE_EXPECT_NONE === "1") {
      // Run this same fixture against a build predating server pictures.
      // Observe absence for three quiet periods; never call the new refresh API.
      for (let i = 0; i < 60; i++) {
        const listing = await api.json<{ id: string; hasThumbnail: boolean }[]>("GET", "/api/maps");
        expect(listing.find(row => row.id === map.id)?.hasThumbnail).toBe(false);
        for (const theme of ["light", "dark"]) await api.request("GET", `/api/maps/${map.id}/thumbnail?theme=${theme}`, undefined, undefined, 404);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return;
    }
    const ready = await api.picture(map.id);
    const pictures = await Promise.all(["light", "dark"].map(async theme => {
      const bytes = Buffer.from(await (await api.request("GET", `/api/maps/${map.id}/thumbnail?theme=${theme}&v=${ready.pictureVersion}`)).arrayBuffer());
      assertPictureMarks(bytes);
      return bytes;
    }));
    expect(pictures[0].equals(pictures[1])).toBe(false);
  }, 240000);
  it.skipIf(process.env.DEZFIL_PICTURE_EXPECT_NONE === "1").each(["colour", "filter", "visualization", "timeline window", "basemap toggle", "hidden layer"])("drawing change appears in pixels: %s", async change => {
    const ground = await pictureBasemap();
    try {
      const map = await api.json<{ id: string }>("POST", "/api/maps", { name: `Pixels: ${change}` }); maps.push(map.id);
      await api.json("PATCH", `/api/maps/${map.id}`, { viewport: PICTURE_CAMERA, customBasemap: {
        url: `${ground.origin}/${change === "basemap toggle" ? "land" : "plain"}.json`, name: "Pixel fixture", attribution: [{ label: "Fixture" }],
      } }, map.id);
      const definitions = pictureMarkSql();
      const layers: { id: string }[] = [];
      for (const definition of definitions) layers.push(await api.json("POST", `/api/maps/${map.id}/layers`, {
        ...definition, sql: definition.sql + ", 1 AS value, TIMESTAMP '2026-01-01' AS time",
      }, map.id));
      const patchLayer = (index: number, body: object) => api.json("PATCH", `/api/layers/${layers[index].id}`, body, map.id);
      if (change === "timeline window") {
        await patchLayer(1, { filters: [{ kind: "timerange", field: "time", min: "2025-01-01", max: "2028-01-01" }] });
        await api.json("PATCH", `/api/maps/${map.id}`, { timeline: { layerId: layers[1].id, field: "time", speed: 1 } }, map.id);
      }
      const picture = async (version: string | null) => Buffer.from(await (await api.request("GET", `/api/maps/${map.id}/thumbnail?v=${version}`)).arrayBuffer());
      const before = await api.picture(map.id), original = await picture(before.pictureVersion);
      assertPictureMarks(original);
      const index = change === "timeline window" ? 1 : change === "visualization" || change === "hidden layer" ? 2 : 0;
      const mark = PICTURE_MARKS[index], position = pictureMarkPosition(mark);
      const replacement = [180, 25, 160] as const;
      if (change === "colour") await patchLayer(index, { style: { ...definitions[index].style, fill: { type: "constant", color: { r: replacement[0], g: replacement[1], b: replacement[2], a: 1 } } } });
      if (change === "filter") await patchLayer(index, { filters: [{ kind: "range", field: "value", min: 2, max: null }] });
      if (change === "timeline window") await patchLayer(index, { filters: [{ kind: "timerange", field: "time", min: "2027-01-01", max: "2028-01-01" }] });
      if (change === "hidden layer") await patchLayer(index, { visible: false });
      if (change === "visualization") await patchLayer(index, { viz: { type: "grid", cellKm: 5, aggregate: { fn: "count" }, fill: definitions[index].style.fill } });
      if (change === "basemap toggle") {
        assertPicturePatch(original, 30, 30, PICTURE_LAND);
        expect(ground.traffic().tiles).toBeGreaterThan(0);
        await api.json("PATCH", `/api/maps/${map.id}`, { basemapLayers: { land: false } }, map.id);
      }
      const after = await api.picture(map.id, "current", before.pictureVersion), changed = await picture(after.pictureVersion);
      expect(changed.equals(original)).toBe(false);
      if (change === "visualization") {
        // Independently locate the 5 km Mercator square and inspect its
        // four inset corners, outside the original ten-pixel point.
        const world = 512 * 2 ** PICTURE_CAMERA.zoom, metresPerPixel = 2 * Math.PI * 6378137 / world;
        const east = PICTURE_CAMERA.lng * Math.PI / 180 * 6378137 + mark.dx * metresPerPixel;
        const north = -mark.dy * metresPerPixel;
        const left = position.x + (Math.floor(east / 5000) * 5000 - east) / metresPerPixel * 692 / 990;
        const top = position.y - (Math.floor(north / 5000) * 5000 + 5000 - north) / metresPerPixel * 296 / 424;
        const width = 5000 / metresPerPixel * 692 / 990, height = 5000 / metresPerPixel * 296 / 424;
        for (const x of [left + 5, left + width - 5]) for (const y of [top + 5, top + height - 5]) {
          assertPicturePatch(original, x, y, PICTURE_GROUND);
          assertPicturePatch(changed, x, y, mark.colour);
        }
      } else if (change === "basemap toggle") assertPicturePatch(changed, 30, 30, PICTURE_GROUND);
      else assertPicturePatch(changed, position.x, position.y, change === "colour" ? replacement : PICTURE_GROUND);
      // A failed/blank render cannot satisfy the disappearance assertions.
      for (const [i, untouched] of PICTURE_MARKS.entries()) if (i !== index || change === "basemap toggle") {
        const p = pictureMarkPosition(untouched); assertPicturePatch(changed, p.x, p.y, untouched.colour);
      }
    } finally { await ground.close(); }
  }, 300000);
  it.skipIf(process.env.DEZFIL_PICTURE_EXPECT_NONE === "1").each(["unreachable basemap", "abandoned outside request"])("real incompleteness retains served bytes: %s", async failure => {
    const ground = await pictureBasemap();
    try {
      const map = await api.json<{ id: string }>("POST", "/api/maps", { name: `Incomplete: ${failure}` }); maps.push(map.id);
      const basemap = (url: string) => ({ customBasemap: { url, name: "Failure fixture", attribution: [{ label: "Fixture" }] } });
      await api.json("PATCH", `/api/maps/${map.id}`, { viewport: PICTURE_CAMERA, ...basemap(`${ground.origin}/plain.json`) }, map.id);
      for (const layer of pictureMarkSql()) await api.json("POST", `/api/maps/${map.id}/layers`, layer, map.id);
      const ready = await api.picture(map.id);
      const thumbnail = async () => Buffer.from(await (await api.request("GET", `/api/maps/${map.id}/thumbnail?theme=light`)).arrayBuffer());
      const previous = await thumbnail(); assertPictureMarks(previous);
      expect(ground.traffic().styles).toBeGreaterThan(0); // This loopback host passed egress and painted.
      const closed = failure === "unreachable basemap" ? await closedPictureAddress() : undefined;
      const logPath = process.env.DEZFIL_PICTURE_RENDER_LOG;
      if (!closed) expect(logPath, "Redirect the isolated server stderr and supply DEZFIL_PICTURE_RENDER_LOG").toBeTruthy();
      const logOffset = !closed ? (await readFile(logPath!, "utf8")).length : 0;
      await api.json("PATCH", `/api/maps/${map.id}`, basemap(closed?.url ?? `${ground.origin}/stall.json`), map.id);
      const failed = await api.picture(map.id, "failed");
      expect(failed.pictureVersion).toBe(ready.pictureVersion);
      expect(await thumbnail()).toEqual(previous);
      if (closed) await closed.assertClosed();
      else {
        expect(ground.traffic().held).toBeGreaterThan(0);
        expect(ground.traffic().closed).toBeGreaterThan(0);
        const log = (await readFile(logPath!, "utf8")).slice(logOffset);
        // A budget kill or an egress refusal is not an abandonment proof.
        expect(log.split("\n").some(line => line.includes(`[export] map ${map.id}:`) && line.includes("request(s) abandoned past") && line.includes("127.0.0.1"))).toBe(true);
      }
    } finally { await ground.close(); }
  }, 240000);
  it.skipIf(process.env.DEZFIL_PICTURE_EXPECT_NONE === "1")("pictures an unopened saved map at the documented size in both appearances, and keeps it through failed and unsupported attempts", async () => {
    const map = await api.json<{ id: string }>("POST", "/api/maps", { name: "Picture proof" }); maps.push(map.id);
    await api.json("PATCH", `/api/maps/${map.id}`, { viewport: PICTURE_CAMERA, basemap: null }, map.id);
    for (const layer of pictureMarkSql()) await api.json("POST", `/api/maps/${map.id}/layers`, layer, map.id);
    const ready = await api.picture(map.id);
    const bytes: Record<string, Buffer> = {};
    for (const theme of ["light", "dark"]) {
      bytes[theme] = Buffer.from(await (await api.request("GET", `/api/maps/${map.id}/thumbnail?theme=${theme}&v=${ready.pictureVersion}`)).arrayBuffer());
      for (const mark of PICTURE_MARKS) {
        const measured = colourCentre(bytes[theme], mark.colour);
        expect([measured.width, measured.height]).toEqual([692, 296]);
        expect(Math.abs(measured.x - (495 + mark.dx) * 692 / 990)).toBeLessThan(2);
        expect(Math.abs(measured.y - (212 + mark.dy) * 296 / 424)).toBeLessThan(2);
      }
    }
    expect(bytes.light.equals(bytes.dark)).toBe(false);
    const config = await api.json<{ renderCapFeatures: number }>("GET", "/api/config");
    const unsupported = await api.json<{ id: string }>("POST", `/api/maps/${map.id}/layers`, { name: "Tiled live filter", sql: `SELECT i, ST_Point(13.4 + (i % 100) * .00001, 0) AS geom FROM range(${config.renderCapFeatures + 1}) t(i)` }, map.id);
    await api.json("PATCH", `/api/layers/${unsupported.id}`, { filters: [{ kind: "range", field: "i", min: 0, max: null }] }, map.id);
    await api.json("POST", `/api/maps/${map.id}/picture/refresh`);
    expect((await api.picture(map.id, "unsupported")).pictureVersion).toBe(ready.pictureVersion);
    await api.request("DELETE", `/api/layers/${unsupported.id}`, undefined, map.id);
    const failAt = Date.now() + 15000;
    await api.json("POST", `/api/maps/${map.id}/layers`, { name: "Fails after admission", sql: `SELECT ST_Point(13.4, 0) AS geom, CASE WHEN epoch_ms(current_timestamp) > ${failAt} THEN error('The fixture expired.') ELSE 1 END AS value` }, map.id);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, failAt - Date.now() + 100)));
    const beforeFailure = (await api.json<{ id: string; pictureVersion: string }[]>("GET", "/api/maps")).find(row => row.id === map.id)!.pictureVersion;
    await api.json("POST", `/api/maps/${map.id}/picture/refresh`);
    expect((await api.picture(map.id, "failed")).pictureVersion).toBe(beforeFailure);
  }, 300000);
});
