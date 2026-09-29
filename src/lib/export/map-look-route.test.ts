import { testAccountScope } from "@/lib/test-support/accounts";
import { authenticatedRoute } from "@/lib/assistant/testing/account";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { createMap } from "@/lib/map-service";
import { POST as rawlook } from "@/app/api/maps/look/route";
const look = authenticatedRoute(rawlook);
import { lookRetention } from "./look-retention";
import { setLookDriverForTests } from "./map-look";
import type { RenderDriver } from "./render-image";
import { decodePng, encodePng } from "./png-codec";

/**
 * The check's route ('s validation outcomes): the documented body, each
 * validation outcome with its own code and no render dispatched, the
 * image beside facts that carry no bytes, the appearance honored with
 * light as the default, and the renderer's own outcomes surfacing with
 * their codes.
 */
const PNG = encodePng({ width: 64, height: 40, rgba: new Uint8Array(64 * 40 * 4).fill(200) });
function driverOf(render: () => Promise<{ png: Uint8Array; consumed?: string }>) {
  const counts = { launches: 0, renders: 0 };
  const driver: RenderDriver = { launch: async () => { counts.launches += 1; return { render: async () => { counts.renders += 1; return render(); }, close: async () => {}, kill: () => {} }; } };
  return { driver, counts };
}
const consumed = (mapId: string) => JSON.stringify({ map: mapId, layers: [], legend: { visible: false, corner: "bottom-left", order: [] }, widgets: [], attribution: "© OpenMapTiles © OpenStreetMap contributors", failures: [] });
const request = (body: unknown) => new Request("http://127.0.0.1:3300/api/maps/look", { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

let dir: string; let mapId: string;
beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-look-route-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir); vi.stubEnv("PORT", "3300");
  closeMetadataDb();
  mapId = createMap(testAccountScope(), "Route look").id;
});
afterEach(async () => { setLookDriverForTests(null); closeMetadataDb(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

describe("1c and item 5: the validation outcomes dispatch no render", () => {
  it("no map named: look_target_missing", async () => {
    const { driver, counts } = driverOf(async () => ({ png: PNG, consumed: consumed(mapId) }));
    setLookDriverForTests(driver);
    for (const body of [undefined, {}, { appearance: "dark" }]) {
      const response = await look(request(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "look_target_missing" } });
    }
    expect(counts.launches).toBe(0);
  });
  it("an unknown map: not_found, the map API's own code", async () => {
    const { driver, counts } = driverOf(async () => ({ png: PNG, consumed: consumed(mapId) }));
    setLookDriverForTests(driver);
    const response = await look(request({ mapId: "no-such-map" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    expect(counts.launches).toBe(0);
  });
  it("an invalid map or appearance: invalid_request", async () => {
    const { driver, counts } = driverOf(async () => ({ png: PNG, consumed: consumed(mapId) }));
    setLookDriverForTests(driver);
    for (const body of [{ mapId: 42 }, { mapId: "" }, { mapId: { id: mapId } }, { mapId, appearance: "sepia" }]) {
      const response = await look(request(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
    expect(counts.launches).toBe(0);
  });
});

describe("1a and 1d: the answer", () => {
  it("carries the image beside facts that hold no bytes, light by default, dark when asked", async () => {
    const { driver, counts } = driverOf(async () => ({ png: PNG, consumed: consumed(mapId) }));
    setLookDriverForTests(driver);
    const response = await look(request({ mapId }));
    expect(response.status).toBe(200);
    const body = await response.json() as { render: Record<string, unknown>; image: { content_type: string; width: number; height: number; bytes: number; content_base64: string } };
    expect(Buffer.from(body.image.content_base64, "base64").equals(Buffer.from(PNG))).toBe(true);
    expect(body.image).toMatchObject({ content_type: "image/png", width: 1024, height: 640, bytes: PNG.byteLength });
    expect(body.render).toMatchObject({ mapId, mapName: "Route look", appearance: "light", source: { width: 1024, height: 640 }, image: { width: 1024, height: 640, bytes: PNG.byteLength }, attribution: "© OpenMapTiles © OpenStreetMap contributors", composition: { failures: [], abandoned: [] } });
    expect(body.render.state).toMatchObject({ map: mapId, appearance: "light", layers: [], widgets: [] });
    expect(JSON.stringify(body.render)).not.toContain(body.image.content_base64.slice(0, 32));
    expect(typeof body.render.id).toBe("string");
    const dark = await (await look(request({ mapId, appearance: "dark" }))).json() as { render: { appearance: string; state: { appearance: string } } };
    expect(dark.render.appearance).toBe("dark"); expect(dark.render.state.appearance).toBe("dark");
    expect(counts.renders).toBe(2);
    expect(decodePng(PNG).width).toBe(64);
  });
  it("the renderer's own outcomes keep their codes: no browser, and the check's budget", async () => {
    setLookDriverForTests({ launch: async () => { throw new Error("ENOENT"); } });
    const missing = await look(request({ mapId }));
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ error: { code: "render_unavailable" } });
    vi.stubEnv("DEZFIL_ASSISTANT_LOOK_TIMEOUT_S", "0.15");
    const { driver } = driverOf(() => new Promise(() => {}));
    setLookDriverForTests(driver);
    const slow = await look(request({ mapId }));
    expect(slow.status).toBe(408);
    expect(await slow.json()).toMatchObject({ error: { code: "render_timeout", message: expect.stringContaining("check budget") } });
  });
});

describe("the request-to-response budget covers the thumbnail's preparation", () => {
  it("a render answered just inside the deadline whose thumbnail runs past it is the timeout, and nothing is retained", async () => {
    vi.stubEnv("DEZFIL_ASSISTANT_LOOK_TIMEOUT_S", "0.1");
    lookRetention.resetForTests();
    // An image inside the byte bound at the source size: no size step
    // runs, so only the thumbnail's decode, resize and encode follow the
    // render. The driver settles two milliseconds before the deadline.
    const source = encodePng({ width: 1024, height: 640, rgba: new Uint8Array(1024 * 640 * 4).fill(200) });
    let launched = 0;
    const driver: RenderDriver = { launch: async () => { launched = Date.now(); return { render: async () => { while (Date.now() < launched + 98) { /* spin to the edge of the budget */ } return { png: source, consumed: consumed(mapId) }; }, close: async () => {}, kill: () => {} }; } };
    setLookDriverForTests(driver);
    const response = await look(request({ mapId }));
    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({ error: { code: "render_timeout" } });
    expect(lookRetention.size().count).toBe(0);
  });
});
