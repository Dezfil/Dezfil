import { buildTools } from "@/lib/tools/tools";
import { executeTool } from "@/lib/tools/execute";
import { assertPictureMarks } from "../../../test-support/picture-pixels";
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
 * -t "never opened". The URL may name any separately provisioned instance. */
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
