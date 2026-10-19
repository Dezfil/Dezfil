import { afterAll, describe, expect, it } from "vitest";
import { pictureProofClient } from "../../../test-support/pictures-http";
import { colourCentre, PICTURE_CAMERA, PICTURE_MARKS, pictureMarkSql } from "../../../test-support/picture-pixels";
const base = process.env.DEZFIL_PICTURE_TEST_URL;
/** An isolated running production instance, real renderer, real tile builder
 * and network access to its configured Auto styles. No browser upload or
 * opened builder is involved. The token belongs to a disposable account. */
describe.skipIf(!base)("server picture road", () => {
  const api = base ? pictureProofClient(base, process.env.DEZFIL_PICTURE_TEST_TOKEN ?? "") : undefined!;
  const maps: string[] = [];
  afterAll(async () => { for (const id of maps) await api.request("DELETE", `/api/maps/${id}`, undefined, id); });
  it("pictures an unopened saved map at the documented size in both appearances, and keeps it through failed and unsupported attempts", async () => {
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
