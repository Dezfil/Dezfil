import { authenticatedRoute } from "@/lib/assistant/testing/account";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { createMap } from "@/lib/map-service";
import { setLookDriverForTests } from "@/lib/export/map-look";
import { encodePng } from "@/lib/export/png-codec";
import type { RenderDriver } from "@/lib/export/render-image";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { limits } from "@/lib/limits";
import { GET as statusHandler } from "@/app/api/assistant/route";
import type { AssistantEvent } from "./loop";
import type { ModelProvider } from "./provider";
import { stubProvider } from "./providers/stub";
import { assistantRuns } from "./runs";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";

const status = authenticatedRoute(statusHandler);

/**
 * The switch: the instance owner's environment setting, reported by the
 * documented status read, matched against the message route's behavior
 * in both positions, each read independently of the other; on by
 * default and documented.
 */
const factory = vi.hoisted(() => ({ provider: null as ModelProvider | null }));
vi.mock("@/lib/assistant/factory", () => ({ createProvider: () => factory.provider }));
const origin = "http://127.0.0.1:3314";
const FIXTURE = encodePng({ width: 1024, height: 640, rgba: new Uint8Array(1024 * 640 * 4).fill(200) });
let dir: string; let mapId: string; let renders = 0;
beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-setting-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir); vi.stubEnv("PORT", "3314"); vi.stubEnv("OPENAI_API_KEY", "fixture-never-sent"); vi.stubEnv("DEZFIL_AI_PROVIDER", "openai");
  closeMetadataDb(); assistantRuns.resetForTests(); renders = 0;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => dispatchAssistantTestRoute(input instanceof Request ? input : new Request(String(input), init)));
  mapId = createMap("Setting").id;
  const driver: RenderDriver = { launch: async () => ({ render: async () => { renders += 1; return { png: FIXTURE, consumed: JSON.stringify({ map: mapId, layers: [], legend: { visible: false, corner: "bottom-left", order: [] }, widgets: [], attribution: "", failures: [] }) }; }, close: async () => {}, kill: () => {} }) };
  setLookDriverForTests(driver);
});
afterEach(async () => { setLookDriverForTests(null); factory.provider = null; closeMetadataDb(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

async function qualifyingTurn(): Promise<AssistantEvent[]> {
  factory.provider = stubProvider([{ text: "", toolCalls: [{ id: `s${Date.now()}`, name: "update_map", args: { id: mapId, name: "Changed" } }] }, { text: "Changed.", toolCalls: [] }, { text: "Seen.", toolCalls: [] }]);
  const reserved = await (await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/runs`, { method: "POST" }))).json() as { id: string };
  const response = await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: reserved.id, message: "go", history: [], context: { page: "builder", mapId, selectedLayerId: null } }) }));
  const text = await response.text();
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as AssistantEvent);
}
const checks = (events: AssistantEvent[]) => events.filter((e) => e.type === "tool_result" && e.tool === "look_at_map");

describe("the status read matches the route's behavior in both positions", () => {
  for (const [raw, expected] of [["0", false], ["false", false], ["off", false], ["1", true], ["", true], ["yes", true]] as const) {
    it(`DEZFIL_ASSISTANT_AUTO_CHECK=${JSON.stringify(raw)}: status reports ${expected} and a qualifying turn ${expected ? "checks once" : "checks nothing"}`, async () => {
      vi.stubEnv("DEZFIL_ASSISTANT_AUTO_CHECK", raw);
      const reported = await (await status()).json() as { enabled: boolean; autoCheck?: boolean };
      expect(reported.enabled).toBe(true);
      expect(reported.autoCheck).toBe(expected);
      const events = await qualifyingTurn();
      expect(checks(events)).toHaveLength(expected ? 1 : 0);
      expect(renders).toBe(expected ? 1 : 0);
    });
  }
});

describe("the default is on and documented", () => {
  it("with the variable unset the limit and the status both read on", async () => {
    vi.stubEnv("DEZFIL_ASSISTANT_AUTO_CHECK", "");
    delete process.env.DEZFIL_ASSISTANT_AUTO_CHECK;
    expect(limits.assistantAutoCheck).toBe(true);
    expect(((await (await status()).json()) as { autoCheck?: boolean }).autoCheck).toBe(true);
  });
  it("the status schema documents the field, its default and how it is turned off", () => {
    const doc = buildOpenApiDocument() as unknown as { components: { schemas: Record<string, { properties: Record<string, { description?: string }> }> } };
    const field = doc.components.schemas.AssistantStatus.properties.autoCheck;
    expect(field).toBeDefined();
    expect(field.description).toContain("on by default");
    expect(field.description).toContain("DEZFIL_ASSISTANT_AUTO_CHECK");
    expect(field.description).toContain("explicit check is available");
  });
});
