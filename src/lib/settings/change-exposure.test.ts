import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PATCH } from "@/app/api/instance/settings/route";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { buildTools } from "@/lib/tools/tools";
import { executeTool } from "@/lib/tools/execute";
import { testClient } from "@/lib/mcp/test-client";
import { runAssistant, resumeAssistant, type AssistantEvent } from "@/lib/assistant/loop";
import { PendingActionStore } from "@/lib/assistant/pending";
import { stubProvider } from "@/lib/assistant/providers/stub";
import { testAccountScope } from "@/lib/test-support/accounts";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import type { AssistantContext } from "@/lib/assistant/context";
import { readStoredSettings } from "./store";
import { DISCLOSURE_SEEDS, FORBIDDEN_DISCLOSURE, instanceSettingsFixture } from "../../../test-support/instance-settings";

let f: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { f = instanceSettingsFixture(); });
afterEach(() => f.close());
function dispatch(input: RequestInfo | URL, init?: RequestInit) {
  const incoming = input instanceof Request ? input : new Request(String(input), init);
  const headers = new Headers(incoming.headers);
  headers.set("authorization", `Bearer ${f.token.secret}`);
  return PATCH(socketRequest(new Request(incoming, { headers })));
}
const collect = async (events: AsyncGenerator<AssistantEvent>) => { const result: AssistantEvent[] = []; for await (const event of events) result.push(event); return result; };
const reply = { text: "", toolCalls: [{ id: "change", name: "update_instance_settings", args: { previewRows: 200 } }] };

it("exposes a closed update input and refuses unknown arguments before HTTP dispatch", async () => {
  const tool = buildTools().find(t => t.name === "update_instance_settings")!;
  expect(tool).toMatchObject({ method: "patch", path: "/api/instance/settings", confirm: true,
    inputSchema: { additionalProperties: false }, effects: { readOnly: false, writes: [{ resource: "settings", collection: true }] } });
  expect(tool.inputSchema.properties).toMatchObject({ queryTimeoutS: { type: ["integer", "null"], minimum: 5, maximum: 600 },
    instanceName: { type: ["string", "null"], pattern: "^\\s*[\\s\\S]{0,80}\\s*$" }, landingPage: { enum: ["home", "projects", "maps", "workflows", "data", "sql", null] },
    "newMap.zoom": { type: ["number", "null"], minimum: 0, maximum: 22 }, "newLayer.pointOpacity": { type: ["integer", "null"], minimum: 10, maximum: 100 },
    "sqlConsole.lineWrap": { type: ["boolean", "null"] }, "imageExport.shape": { enum: ["16:9", "4:3", "1:1", null] } });
  // The fourteen limits, the four General rows, the eighteen defaults for new
  // things, and the twelve sign-in, token, publishing, connection and import rows.
  expect(Object.keys(tool.inputSchema.properties)).toHaveLength(48);
  for (const key of ["secretKey", "geocoderUrl", "renderCapFeatures", "sourceGrouping"]) expect(tool.inputSchema.properties).not.toHaveProperty(key);
  const fetch = vi.fn();
  const result = await executeTool(tool, { previewRows: 200, unknown: "seed-tool-secret" }, "http://instance.test", fetch);
  expect(result.status).toBe(400); expect(fetch).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("seed-tool-secret");
});

it.each([
  ["newMap.basemap", "terrain", "streets"], ["imageExport.shape", "2:1", "16:9"], ["sqlConsole.textSize", 12, "14"],
  ["newMap.zoom", 23, 22], ["newMap.latitude", -90, -85], ["newLayer.lineWidth", 0.25, 0.5],
  ["newLayer.pointOpacity", 72.5, 73], ["sqlConsole.lineWrap", "on", true],
] as const)("refuses the default %s = %j off its list, bounds or kind in generated and MCP calls before any HTTP call, and keeps %j", async (key, refused, kept) => {
  const tool = buildTools().find(t => t.name === "update_instance_settings")!;
  const fetch = vi.fn(dispatch), api = vi.fn((request: Request) => dispatch(request)), client = await testClient(api);
  try {
    expect((await executeTool(tool, { [key]: refused }, "http://instance.test", fetch)).status).toBe(400);
    expect((await client.callTool({ name: tool.name, arguments: { [key]: refused } })).isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled(); expect(api).not.toHaveBeenCalled();
    expect(readStoredSettings(f.db)).toEqual({});
    // The same key with a value inside its list, bounds and kind goes through.
    expect((await executeTool(tool, { [key]: kept }, "http://instance.test", fetch)).status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce(); expect(readStoredSettings(f.db)).toEqual({ [key]: kept });
  } finally { await client.close(); }
});

it.each([["instanceName", 80], ["signInMessage", 280], ["lostPasswordContact", 120]] as const)(
  "bounds %s after trimming in direct, generated and MCP calls", async (key, max) => {
    const value = "x".repeat(max), args = { [key]: `${value}  ` };
    const tool = buildTools().find(t => t.name === "update_instance_settings")!;
    const direct = await dispatch("http://instance.test/api/instance/settings", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(args),
    });
    expect(direct.status).toBe(200);
    const fetch = vi.fn(dispatch);
    const generated = await executeTool(tool, args, "http://instance.test", fetch);
    expect(generated.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    const api = vi.fn((request: Request) => dispatch(request)), client = await testClient(api);
    try {
      const accepted = await client.callTool({ name: tool.name, arguments: args });
      expect(accepted.isError).not.toBe(true);
      expect(api).toHaveBeenCalledOnce();
      expect(readStoredSettings(f.db)[key]).toBe(value);
      api.mockClear(); fetch.mockClear();
      const tooLong = { [key]: `  ${value}x  ` };
      expect((await executeTool(tool, tooLong, "http://instance.test", fetch)).status).toBe(400);
      expect((await client.callTool({ name: tool.name, arguments: tooLong })).isError).toBe(true);
      expect(api).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
      expect(readStoredSettings(f.db)[key]).toBe(value);
    } finally { await client.close(); }
  },
);

it.each(["approve", "decline", "demote"])("parks the actual assistant update until confirmation, then handles %s", async decision => {
  const scope = testAccountScope(f.db, "admin"), pending = new PendingActionStore(), fetch = vi.fn(dispatch);
  const provider = stubProvider([reply, { text: "Done", toolCalls: [] }]);
  const deps = { scope, baseUrl: "http://instance.test", pending, fetchImpl: fetch };
  const events = await collect(runAssistant(provider, { message: "Change the preview", history: [] }, deps));
  const question = events.find(e => e.type === "confirm_required");
  expect(question).toMatchObject({ tool: "update_instance_settings", args: { previewRows: 200 }, confirmation: { target: "Change instance settings?", consequence: expect.stringContaining("new work") } });
  expect(fetch).not.toHaveBeenCalled(); expect(readStoredSettings(f.db)).toEqual({});
  if (!question || question.type !== "confirm_required") throw new Error("Missing question");
  if (decision === "demote") f.db.prepare("UPDATE accounts SET is_admin = 0 WHERE id = 'admin'").run();
  const approved = decision !== "decline", parked = pending.claim(scope, question.id, approved ? "approved" : "declined")!;
  const resumed = await collect(resumeAssistant(parked, approved, deps));
  expect(resumed).toContainEqual(expect.objectContaining({ type: "tool_result", tool: "update_instance_settings", ok: decision === "approve" }));
  expect(readStoredSettings(f.db)).toEqual(decision === "approve" ? { previewRows: 200 } : {});
  if (decision === "demote") expect(resumed).toContainEqual(expect.objectContaining({ body: { error: { code: "forbidden", message: expect.any(String) } } }));
});

it.each(["sql", "workflow"])("refuses the update under the %s assistant policy before a call or confirmation", async page => {
  const context: AssistantContext = page === "sql" ? { page: "sql", draft: "", selection: null, lastExecution: null }
    : { page: "workflow", recipeId: "workflow", selectedStepId: null, lastRunId: null };
  const fetch = vi.fn(dispatch), provider = stubProvider([reply, { text: "Done", toolCalls: [] }]);
  const events = await collect(runAssistant(provider, { message: "Change the preview", history: [], context },
    { scope: testAccountScope(f.db, "admin"), baseUrl: "http://instance.test", pending: new PendingActionStore(), fetchImpl: fetch }));
  expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", ok: false, body: { error: expect.objectContaining({ code: "assistant_action_not_admitted" }) } }));
  expect(events.some(e => e.type === "confirm_required")).toBe(false); expect(fetch).not.toHaveBeenCalled();
  expect(readStoredSettings(f.db)).toEqual({});
});

it("omits seeded credentials on write, error, schema and MCP surfaces and lets MCP call directly", async () => {
  for (const [key, value] of Object.entries(DISCLOSURE_SEEDS)) vi.stubEnv(key, value);
  const api = vi.fn((request: Request) => dispatch(request));
  const client = await testClient(api);
  try {
    const listing = await client.listTools();
    const tool = listing.tools.find(t => t.name === "update_instance_settings")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    expect(tool._meta?.["dezfil/confirmation"]).toMatchObject({ policy: "required", target: "Change instance settings?" });
    expect(tool.description).toContain("confirmation");
    const unknown = await client.callTool({ name: tool.name, arguments: { previewRows: 200, unknown: "seed-submitted-secret" } });
    expect(unknown.isError).toBe(true); expect(api).not.toHaveBeenCalled();
    const success = await client.callTool({ name: tool.name, arguments: { previewRows: 200 } });
    expect(success.isError).not.toBe(true); expect(readStoredSettings(f.db)).toEqual({ previewRows: 200 });
    const direct = await dispatch("http://instance.test/api/instance/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: '{"previewRows":200}' });
    expect(direct.status).toBe(200);
    const surfaces: unknown[] = [unknown, success, await direct.json(), listing, buildOpenApiDocument(), buildTools()];
    for (const args of [{ secretKey: "seed-submitted-secret", previewRows: 300 }, { queryTimeoutS: "seed-submitted-secret" }, { [DISCLOSURE_SEEDS.OPENAI_API_KEY]: "seed-submitted-secret" }]) {
      const response = await dispatch("http://instance.test/api/instance/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
      expect(response.status).toBeOneOf([400, 409]); surfaces.push(await response.json());
    }
    const error = await client.callTool({ name: tool.name, arguments: { queryTimeoutS: 600 } });
    expect(error.isError).toBe(true); surfaces.push(error);
    expect(readStoredSettings(f.db)).toEqual({ previewRows: 200 });
    const serialized = JSON.stringify(surfaces);
    for (const secret of [...FORBIDDEN_DISCLOSURE, "seed-submitted-secret"]) expect(serialized.includes(secret), "Seeded credential must be absent").toBe(false);
  } finally { await client.close(); }
});
