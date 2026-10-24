import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pictureBasemap, PICTURE_LAND, type GroundRequest } from "../../../test-support/picture-basemap";
import { assertPictureMarks, colourIn, decodePicture, PICTURE_CAMERA, pictureMarkSql } from "../../../test-support/picture-pixels";
import { pictureProofClient } from "../../../test-support/pictures-http";

const base = process.env.DEZFIL_PICTURE_TEST_URL;
/** The control: a build whose picture renders bound a stalled request by
 * the assistant check's rule, a third of their budget, and nothing else
 * changed. */
const CONTROL = process.env.DEZFIL_PICTURE_REQUEST_RULE_CONTROL === "1";
/** The product's figures: a map is pictured once it has been quiet for
 * five seconds; each render has the assistant check's 30 s budget; a
 * stalled outside request is given up after the export's 20 s request
 * time, or, under the control, a third of the budget. */
const QUIET = 5000, BUDGET = 30000, BOUND = CONTROL ? BUDGET / 3 : 20000;
/** How long the slow tile is held: past a third of the budget, inside the
 * export's request time. */
const HOLD = 15000;

/**
 * A map picture's render waits on a slow basemap tile as long as an image
 * export does. One loopback tile is held while every other request the
 * render makes of the ground has settled: held 15 s, the render completes
 * and the tile is in the stored picture; held for good, the request is cut
 * at the export's request time, logged as abandoned, and the attempt fails
 * as incomplete before its budget could run out. The control is a build
 * that bounds the request by a third of the budget, as before; it fails
 * the 15 s case by abandonment, inside the same budget.
 *
 * Provisioning as for pictures.real-render.test.ts: an isolated production
 * instance named by DEZFIL_PICTURE_TEST_URL with DEZFIL_PICTURE_TEST_TOKEN,
 * 127.0.0.1 in its DEZFIL_EGRESS_ALLOWLIST, its stderr in the file named by
 * DEZFIL_PICTURE_RENDER_LOG:
 * npm test -- src/lib/pictures/request-rule.real-render.test.ts --maxWorkers=1
 * For the control, run the same file against the control build's instance
 * with DEZFIL_PICTURE_REQUEST_RULE_CONTROL=1.
 */
describe.skipIf(!base)("a picture render waits on a slow tile by the export's rule", () => {
  const api = base ? pictureProofClient(base, process.env.DEZFIL_PICTURE_TEST_TOKEN ?? "") : undefined!;
  const maps: string[] = [];
  let ground: Awaited<ReturnType<typeof pictureBasemap>>;
  beforeAll(async () => { ground = await pictureBasemap(); });
  afterAll(async () => {
    for (const id of maps) await api.request("DELETE", `/api/maps/${id}`, undefined, id);
    await ground?.close();
  });

  const logPath = () => {
    const path = process.env.DEZFIL_PICTURE_RENDER_LOG;
    expect(path, "Redirect the isolated server's stderr and name the file in DEZFIL_PICTURE_RENDER_LOG").toBeTruthy();
    return path!;
  };
  /** Ground for the marks: plain, or with land tiles held `ms` around the camera's centre. */
  const groundAt = (ms?: number | "never") => ({ customBasemap: {
    url: ms === undefined ? `${ground.origin}/plain.json` : `${ground.origin}/hold.json?ms=${ms}&w=${PICTURE_CAMERA.lng - 0.001}&s=${PICTURE_CAMERA.lat - 0.001}&e=${PICTURE_CAMERA.lng + 0.001}&n=${PICTURE_CAMERA.lat + 0.001}`,
    name: "Held tile fixture", attribution: [{ label: "Fixture" }],
  } });
  /** The marks' map on `ms`'s ground; the time its last edit was answered. */
  async function marked(name: string, ms?: number | "never") {
    const map = await api.json<{ id: string }>("POST", "/api/maps", { name }); maps.push(map.id);
    for (const layer of pictureMarkSql()) await api.json("POST", `/api/maps/${map.id}/layers`, layer, map.id);
    await api.json("PATCH", `/api/maps/${map.id}`, { viewport: PICTURE_CAMERA, ...groundAt(ms) }, map.id);
    return { id: map.id, editedAt: Date.now() };
  }
  const isHeld = (r: GroundRequest) => r.path.startsWith("/hold/");
  const since = (at: number) => ground.requests().filter(r => r.started >= at);
  /** The first tile held after `at`, once the test has seen every other
   * request the render made of the ground settle beside it. */
  async function heldTile(at: number) {
    await expect.poll(() => since(at).filter(isHeld).length, { timeout: 60000 }).toBeGreaterThan(0);
    const held = since(at).find(isHeld)!;
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect(since(at).filter(r => isHeld(r) && r.started <= held.started + 1000), "one tile is held").toHaveLength(1);
    expect(since(at).filter(r => !isHeld(r) && r.answered === undefined && r.closed === undefined).map(r => r.path), "every other request has settled").toEqual([]);
    const style = since(at).find(r => r.path.startsWith("/hold.json"))!;
    expect(style.started, "the render read its style first").toBeLessThanOrEqual(held.started);
    return { held, style };
  }
  /** The held tile's own record now. */
  const now = (tile: GroundRequest) => ground.requests().find(r => r.path === tile.path && r.started === tile.started)!;
  /** The log the server wrote from `offset` on. */
  const logSince = async (offset: number) => (await readFile(logPath(), "utf8")).slice(offset);
  const abandonedLine = (log: string, mapId: string) => log.split("\n").find(line =>
    line.includes(`[export] map ${mapId}:`) && line.includes(`request(s) abandoned past ${BOUND / 1000}s`) && line.includes("127.0.0.1"));

  /** A cut tile, given up at the request bound, logged, and an attempt
   * that failed before its budget could run out: it could not start
   * before the quiet period after the edit, so a budget kill could not
   * settle before then plus the budget. */
  async function expectGivenUp(tile: GroundRequest, mapId: string, editedAt: number, offset: number, failedAt: number) {
    const cut = now(tile);
    expect(cut.answered, "the held tile was never answered").toBeUndefined();
    expect(cut.closed, "the held tile was given up").toBeDefined();
    expect(cut.closed! - cut.started, `given up at the ${BOUND / 1000} s request bound`).toBeGreaterThanOrEqual(BOUND - 100);
    expect(cut.closed! - cut.started).toBeLessThan(BOUND + 3000);
    expect(cut.closed!, "before the render's budget could run out").toBeLessThan(editedAt + QUIET + BUDGET);
    expect(abandonedLine(await logSince(offset), mapId), "logged as abandoned").toBeTruthy();
    expect(failedAt, "failed as incomplete, not by the budget").toBeLessThan(editedAt + QUIET + BUDGET);
  }

  it(CONTROL
    ? "under the control, gives up a tile held 15 s at a third of the budget, and the attempt fails inside the budget"
    : "completes a render whose one tile is held 15 s, past a third of the budget, and stores the picture with that tile", async () => {
    const offset = CONTROL ? (await readFile(logPath(), "utf8")).length : 0;
    const map = await marked("Held 15 s", HOLD);
    const { held, style } = await heldTile(map.editedAt);
    // Held from the render's first request to the ground, the tile still
    // lands with the render's budget to spare.
    expect(held.started + HOLD - style.started, "the hold ends inside the budget").toBeLessThan(BUDGET - 5000);
    if (CONTROL) {
      await api.picture(map.id, "failed");
      await expectGivenUp(held, map.id, map.editedAt, offset, Date.now());
      return;
    }
    const ready = await api.picture(map.id, "current");
    const tile = now(held);
    expect(tile.closed, "the held tile was not given up").toBeUndefined();
    expect(tile.answered! - tile.started, "answered after its hold").toBeGreaterThanOrEqual(HOLD - 50);
    const png = new Uint8Array(await (await api.request("GET", `/api/maps/${map.id}/thumbnail?v=${ready.pictureVersion}`)).arrayBuffer());
    assertPictureMarks(Buffer.from(png));
    expect(colourIn(await decodePicture(png), PICTURE_LAND).count, "the held tile is in the picture").toBeGreaterThan(1000);
  }, 300000);

  it.skipIf(CONTROL)("gives up a tile held past the export's request time, logs it, and fails the attempt as incomplete, keeping the picture", async () => {
    const map = await marked("Held for good");
    const ready = await api.picture(map.id, "current");
    const offset = (await readFile(logPath(), "utf8")).length;
    await api.json("PATCH", `/api/maps/${map.id}`, groundAt("never"), map.id);
    const editedAt = Date.now();
    const { held } = await heldTile(editedAt);
    const failed = await api.picture(map.id, "failed");
    const failedAt = Date.now();
    expect(failed.pictureVersion, "the previous picture is still served").toBe(ready.pictureVersion);
    await expectGivenUp(held, map.id, editedAt, offset, failedAt);
  }, 300000);
});
