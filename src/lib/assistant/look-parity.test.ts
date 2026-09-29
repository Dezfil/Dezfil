import { testAccountScope } from "@/lib/test-support/accounts";
import { requireRequestAuth } from "@/lib/auth/http";
import { instanceFetch } from "@/lib/auth/instance-fetch";
import { authenticatedRequest } from "./testing/account";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { setLookDriverForTests } from "@/lib/export/map-look";
import { encodePng } from "@/lib/export/png-codec";
import type { RenderDriver } from "@/lib/export/render-image";
import { runAssistant, type AssistantEvent } from "./loop";
import { PendingActionStore } from "./pending";
import { stubProvider } from "./providers/stub";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";

/**
 * Headless-against-model parity on one controlled render: the same map
 * and the same appearance reached through the route by a headless client
 * and through the loop by a scripted model give facts that match
 * expectations stated independently of either answer, and decoded image
 * bytes equal to the fixture on both paths. Each render identity is
 * asserted valid and associated with its own answer; two independently
 * minted identities are never required to be equal.
 */
const origin = "http://127.0.0.1:3310";
const FIXTURE = encodePng({ width: 1024, height: 640, rgba: new Uint8Array(1024 * 640 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i >> 2) % 251)) });
let dir: string; let mapId: string; let layerId: string;
beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-parity-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir); vi.stubEnv("PORT", "3310");
  closeMetadataDb(); resetQueryInstance();
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (new URL(request.url).origin !== origin) throw new Error(`Unexpected fixture network request: ${request.url}`);
    return dispatchAssistantTestRoute(request);
  });
  const file = path.join(dir, "pts.geojson");
  await writeFile(file, JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { n: 1 }, geometry: { type: "Point", coordinates: [13.4, 52.5] } }] }));
  const table = await ingestFile(testAccountScope(), file, "pts.geojson");
  mapId = createMap(testAccountScope(), "Parity").id;
  layerId = (await createLayer(testAccountScope(), mapId, { name: "Points", sql: `SELECT * FROM ${table.name}` })).id;
  const driver: RenderDriver = { launch: async () => ({ render: async () => ({ png: FIXTURE, consumed: JSON.stringify({ map: mapId, layers: [{ id: layerId, filters: [] }], legend: { visible: true, corner: "bottom-left", order: [layerId] }, widgets: [], attribution: "© Fixture", failures: [] }) }), close: async () => {}, kill: () => {} }) };
  setLookDriverForTests(driver);
});
afterEach(async () => { setLookDriverForTests(null); closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

/** The facts both paths must answer, stated from the seed alone. */
const expectedFacts = () => ({
  mapId, mapName: "Parity", appearance: "light", source: { width: 1024, height: 640 },
  image: { width: 1024, height: 640, bytes: FIXTURE.byteLength },
  attribution: "© Fixture", composition: { failures: [], abandoned: [] },
  state: expect.objectContaining({ map: mapId, appearance: "light", layers: [{ id: layerId, filters: expect.stringMatching(/^[0-9a-f]{16}$/) }], legend: { visible: true, corner: "bottom-left", order: [layerId] }, widgets: [] }),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("one controlled render, both invocation paths", () => {
  it("the headless client and the model both receive the fixture's bytes and the independently expected facts", async () => {
    // Headless: the documented route.
    const response = await dispatchAssistantTestRoute(authenticatedRequest(new Request(`${origin}/api/maps/look`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mapId }) })));
    expect(response.status).toBe(200);
    const headless = await response.json() as { render: Record<string, unknown> & { id: string }; image: { content_base64: string } };
    expect(headless.render).toMatchObject(expectedFacts());
    expect(headless.render.id).toMatch(UUID);
    expect(Buffer.from(headless.image.content_base64, "base64").equals(Buffer.from(FIXTURE))).toBe(true);

    // Through the model: the scripted provider asks for the check and reads the image natively.
    const provider = stubProvider([
      { text: "", toolCalls: [{ id: "look-1", name: "look_at_map", args: { mapId } }] },
      { text: "One point near the centre.", toolCalls: [] },
    ]);
    const events: AssistantEvent[] = [];
    for await (const event of runAssistant(provider, { message: "Look at the map", history: [], context: { page: "builder", mapId, selectedLayerId: null } }, { scope: testAccountScope(), baseUrl: origin, fetchImpl: instanceFetch(origin, requireRequestAuth(authenticatedRequest())), pending: new PendingActionStore() })) events.push(event);
    const result = events.find((e): e is Extract<AssistantEvent, { type: "tool_result" }> => e.type === "tool_result" && e.tool === "look_at_map");
    expect(result).toBeDefined();
    expect(result!.ok).toBe(true);
    const viaModel = result!.render as unknown as Record<string, unknown> & { id: string };
    expect(viaModel).toMatchObject(expectedFacts());
    expect(viaModel.id).toMatch(UUID);
    // Associated with its own answer: the event's facts and the outcome the model read name the
    // same render.
    const outcome = provider.recording.exchanges[0].outcomes[0][0];
    expect(outcome.toolCallId).toBe("look-1");
    expect(outcome.body).toContain(viaModel.id);
    expect(outcome.body).not.toContain(headless.image.content_base64.slice(0, 48));
    // The bytes the model was handed, decoded from the native image field.
    expect(outcome.image).toBeDefined();
    expect(outcome.image!.mediaType).toBe("image/png");
    expect(Buffer.from(outcome.image!.data).equals(Buffer.from(FIXTURE))).toBe(true);
    // Two independently minted identities: both valid, never asserted equal.
    expect(viaModel.id).not.toBe("");
    expect(headless.render.id).not.toBe("");
  }, 60_000);
});
