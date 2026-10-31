import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { createMap } from "@/lib/map-service";
import { setLookDriverForTests } from "@/lib/export/map-look";
import { encodePng } from "@/lib/export/png-codec";
import type { RenderDriver } from "@/lib/export/render-image";
import { authenticateSession, createApiToken, issueSession } from "@/lib/auth/credentials";
import { getAccount } from "@/lib/metadata/accounts";
import { testAccountScope } from "@/lib/test-support/accounts";
import { anthropicProvider } from "../providers/anthropic";
import { openaiProvider } from "../providers/openai";
import { assistantRuns } from "../runs";
import { pendingActions } from "../pending";
import { dispatchAssistantTestRoute } from "../testing/route-dispatch";
import { anthropicEvents, outputCall, outputText, responseWire, sse } from "../testing/wire";
import { saveAssistantKey } from "./store";

/**
 * The rule on every provider request: the real route, the real store and the
 * real SDK clients, with only the network replaced. The stand-in records each
 * request's address and headers as the client serialized them, for a turn with
 * a tool continuation and an automatic map check, on an instance that has its
 * own key and a conflicting destination, organization, project, alternate
 * authentication and extra headers.
 */

const origin = "http://127.0.0.1:3215";
const FIXTURE = encodePng({ width: 64, height: 40, rgba: new Uint8Array(64 * 40 * 4).fill(180) });
const ANTHROPIC_OWN = "sk-ant-own-key-of-ada-0000000000", OPENAI_OWN = "sk-openai-own-key-of-bea-00000000";
const INSTANCE = "sk-instance-key-from-the-server-0000";
const CONFLICTING = {
  ANTHROPIC_API_KEY: INSTANCE,
  ANTHROPIC_AUTH_TOKEN: "env-alternate-auth",
  ANTHROPIC_BASE_URL: "https://anthropic-proxy.instance.test",
  ANTHROPIC_CUSTOM_HEADERS: "X-Tenant: instance-tenant\nX-Extra: from-the-environment",
  OPENAI_BASE_URL: "https://openai-proxy.instance.test/v1",
  OPENAI_ORG_ID: "org-from-the-environment",
  OPENAI_PROJECT_ID: "project-from-the-environment",
  OPENAI_CUSTOM_HEADERS: "X-Tenant: instance-tenant\nX-Extra: from-the-environment",
};

interface Seen { url: string; headers: Record<string, string> }
const seen: Seen[] = [];
let dir: string;

function anthropicCall(id: string, name: string, args: unknown) {
  return sse([
    { type: "message_start", message: { id: "message", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(args) } },
    { type: "content_block_stop", index: 0 },
    ...anthropicEvents([], "tool_use").slice(-2),
  ], true);
}
const anthropicText = (text: string) => sse(anthropicEvents([{ type: "text", text }]), true);

/** The turn each provider answers: a rename, its continuation, the check's observation. */
function answer(url: URL, mapId: () => string, count: number): Response {
  const rename = { id: mapId(), name: `Renamed ${count}` };
  if (url.pathname.endsWith("/messages")) {
    if (count === 1) return anthropicCall("call-1", "update_map", rename);
    return anthropicText(count === 2 ? "Renamed it." : "It looks right.");
  }
  return count === 1 ? responseWire([outputCall("call-1", "update_map", JSON.stringify(rename))]) : responseWire([outputText(count === 2 ? "Renamed it." : "It looks right.")]);
}

let currentMap = "", requests = 0;
beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-key-destination-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  vi.stubEnv("PORT", "3215");
  closeMetadataDb(); resetQueryInstance(); assistantRuns.resetForTests(); pendingActions.resetForTests();
  seen.length = 0; requests = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.origin === origin) return dispatchAssistantTestRoute(request);
    seen.push({ url: request.url, headers: Object.fromEntries(new Headers(init?.headers ?? request.headers)) });
    return answer(url, () => currentMap, ++requests);
  });
  const driver: RenderDriver = { launch: async () => ({ render: async () => ({ png: FIXTURE, consumed: JSON.stringify({ map: currentMap, layers: [], legend: { visible: false, corner: "bottom-left", order: [] }, widgets: [], attribution: "", failures: [] }) }), close: async () => {}, kill: () => {} }) };
  setLookDriverForTests(driver);
});
afterEach(async () => { setLookDriverForTests(null); closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

function member(id: string) {
  const db = metadataDb();
  const scope = testAccountScope(db, id);
  const context = authenticateSession(issueSession(getAccount(id, db)!, db, Date.now()).secret, db)!;
  return { scope, token: createApiToken(context, "Route fixture", db).secret };
}
const call = (token: string, url: string, init: RequestInit = {}) => dispatchAssistantTestRoute(new Request(`${origin}${url}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }));
async function turn(id: string) {
  const { scope, token } = member(id);
  const map = createMap(scope, `Map of ${id}`);
  currentMap = map.id; requests = 0; seen.length = 0;
  const runId = (await (await call(token, "/api/assistant/runs", { method: "POST" })).json() as { id: string }).id;
  const response = await call(token, "/api/assistant/messages", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId, message: "Rename it.", history: [], context: { page: "builder", mapId: map.id, selectedLayerId: null } }) });
  const events = (await response.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; code?: string });
  expect(events.filter((event) => event.type === "error")).toEqual([]);
  return [...seen];
}

const ENVIRONMENT_NAMES = /proxy|instance-tenant|from-the-environment|env-alternate-auth|sk-instance/;
function expectBare(request: Seen, address: string, own: string) {
  expect(request.url).toBe(address);
  expect(JSON.stringify(request)).not.toMatch(ENVIRONMENT_NAMES);
  for (const header of ["x-tenant", "x-extra", "openai-organization", "openai-project"]) expect(request.headers[header]).toBeUndefined();
  expect(JSON.stringify(request)).toContain(own);
}

describe("on an instance with its own key and a conflicting destination", () => {
  beforeEach(() => { for (const [name, value] of Object.entries(CONFLICTING)) vi.stubEnv(name, value); });

  it("sends a person's Anthropic key alone to Anthropic's own address on every request of the turn", async () => {
    member("ada");
    saveAssistantKey("ada", "anthropic", ANTHROPIC_OWN);
    const requests = await turn("ada");
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expectBare(request, "https://api.anthropic.com/v1/messages", ANTHROPIC_OWN);
      expect(request.headers["x-api-key"]).toBe(ANTHROPIC_OWN);
      expect(request.headers.authorization).toBeUndefined();
      expect(JSON.stringify(request)).not.toContain(OPENAI_OWN);
    }
  });

  it("sends a person's OpenAI key alone to OpenAI's own address on every request of the turn", async () => {
    member("bea");
    saveAssistantKey("bea", "openai", OPENAI_OWN);
    const requests = await turn("bea");
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expectBare(request, "https://api.openai.com/v1/responses", OPENAI_OWN);
      expect(request.headers.authorization).toBe(`Bearer ${OPENAI_OWN}`);
      expect(JSON.stringify(request)).not.toContain(ANTHROPIC_OWN);
    }
  });

  it("sends someone without a key on the instance's key, with the environment's destination and context, never another person's", async () => {
    member("ada"); member("bea");
    saveAssistantKey("ada", "anthropic", ANTHROPIC_OWN);
    saveAssistantKey("bea", "openai", OPENAI_OWN);
    const requests = await turn("cal");
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.url).toBe("https://anthropic-proxy.instance.test/v1/messages");
      expect(request.headers["x-api-key"]).toBe(INSTANCE);
      expect(request.headers["x-tenant"]).toBe("instance-tenant");
      expect(request.headers.authorization).toBe("Bearer env-alternate-auth");
      expect(JSON.stringify(request)).not.toContain(ANTHROPIC_OWN);
      expect(JSON.stringify(request)).not.toContain(OPENAI_OWN);
    }
  });
});

it("refuses a keyless member's turn where the server has no key, contacting no provider", async () => {
  const { token } = member("cal");
  const response = await call(token, "/api/assistant/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: "any", message: "Hello." }) });
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: "assistant_disabled", message: "Add your own API key to use the assistant." } });
  expect(seen).toEqual([]);
});

it("keeps a person's key on it when a variable names its own header, for both clients", async () => {
  vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "X-Api-Key: env-replacement\nAuthorization: Bearer env-replacement");
  vi.stubEnv("OPENAI_CUSTOM_HEADERS", "Authorization: Bearer env-replacement\nX-Tenant: instance-tenant");
  const sent: Seen[] = [];
  const record: typeof fetch = async (input, init) => {
    sent.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers)) });
    return String(input).includes("anthropic") ? anthropicText("Hello.") : responseWire([outputText("Hello.")]);
  };
  await anthropicProvider(ANTHROPIC_OWN, "claude-opus-5", record, undefined, "own").exchange({ system: "", tools: [], history: [] }).send("Hello.");
  await openaiProvider(OPENAI_OWN, "gpt-6-astra", record, undefined, "own").exchange({ system: "", tools: [], history: [] }).send("Hello.");
  expect(sent[0].headers["x-api-key"]).toBe(ANTHROPIC_OWN);
  expect(sent[0].headers.authorization).toBeUndefined();
  expect(sent[1].headers.authorization).toBe(`Bearer ${OPENAI_OWN}`);
  expect(JSON.stringify(sent)).not.toContain("env-replacement");
  expect(JSON.stringify(sent)).not.toContain("instance-tenant");
});
