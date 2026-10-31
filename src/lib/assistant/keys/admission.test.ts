import { describe, expect, it, vi } from "vitest";
import { buildTools, type ToolDef } from "@/lib/tools/tools";
import { testAccountScope } from "@/lib/test-support/accounts";
import { runAssistant } from "../loop";
import { admits, admittedTools } from "../policy";
import { DISCOVERY_TOOL } from "../discovery";
import { defaultOffer } from "../offer";
import { PendingActionStore } from "../pending";
import { stubProvider } from "../providers/stub";
import type { AssistantContext } from "../context";

/**
 * The key operations and the in-app assistant: not offered, not discoverable and
 * not admitted on any page, whatever the model asks. Each case runs the real loop,
 * and the control below strips the declaration to show the same observation goes
 * red without it.
 */

const KEY_TOOLS = ["get_assistant_key", "set_assistant_key", "remove_assistant_key"];
const SECRET = "sk-admission-canary-0123456789";
const PAGES: [string, AssistantContext | undefined][] = [
  ["no page", undefined],
  ["builder", { page: "builder", mapId: "m", selectedLayerId: null }],
  ["sql", { page: "sql", draft: "", selection: null, lastExecution: null }],
  ["workflow", { page: "workflow", recipeId: "r", selectedStepId: null, lastRunId: null }],
];
const FORCED = [
  { name: "set_assistant_key", args: { provider: "anthropic", key: SECRET } },
  { name: "get_assistant_key", args: {} },
  { name: "remove_assistant_key", args: {} },
];
const withoutDeclaration = (tools: ToolDef[]) => tools.map((tool) => {
  if (!tool.effects.keptFromAssistant) return tool;
  const effects = { ...tool.effects }; delete effects.keptFromAssistant;
  return { ...tool, effects };
});

async function forced(context: AssistantContext | undefined, tools: ToolDef[], call: { name: string; args: Record<string, unknown> }) {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return Response.json({ key: null, unreadable: false, removed: false });
  });
  const provider = stubProvider([{ text: "", toolCalls: [{ id: "forced", ...call }] }, { text: "Done.", toolCalls: [] }]);
  const events = [];
  try {
    for await (const event of runAssistant(provider, { message: "Hello.", history: [], context }, { scope: testAccountScope(), baseUrl: "http://127.0.0.1:3391", pending: new PendingActionStore(), tools })) events.push(event);
  } finally { vi.unstubAllGlobals(); }
  return { requests, events, offered: provider.recording.exchanges[0].options.tools.map((tool: { name: string }) => tool.name) };
}

describe.each(PAGES)("on %s", (_name, context) => {
  it("offers no key tool in the turn's first request", async () => {
    const { offered } = await forced(context, buildTools(), FORCED[1]);
    expect(offered.length).toBeGreaterThan(0);
    for (const name of KEY_TOOLS) expect(offered).not.toContain(name);
  });

  it.each(FORCED)("refuses a forced $name before anything happens, and records nothing it held", async (call) => {
    const { requests, events } = await forced(context, buildTools(), call);
    expect(requests).toEqual([]);
    const result = events.find((event) => event.type === "tool_result" && event.tool === call.name);
    expect(result).toMatchObject({ ok: false, outcome: "refused", body: { error: { code: "assistant_action_not_admitted" } }, args: {} });
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it("control: without the declaration the same forced call reaches the operation", async () => {
    // Removal asks first, and a read-only page refuses a write for another
    // reason, so the read is the call each page would have let through.
    const { requests, offered, events } = await forced(context, withoutDeclaration(buildTools()), FORCED[1]);
    expect(requests).toEqual(["GET /api/account/assistant-key"]);
    expect(events.find((event) => event.type === "tool_result" && event.tool === "get_assistant_key")).toMatchObject({ ok: true });
    expect(offered.includes(DISCOVERY_TOOL) || offered.includes("get_assistant_key")).toBe(true);
  });
});

it("finds no key tool through discovery", async () => {
  const tools = buildTools();
  const provider = stubProvider([
    { text: "", toolCalls: [{ id: "search", name: DISCOVERY_TOOL, args: { query: "assistant key provider save secret" } }] },
    { text: "Done.", toolCalls: [] },
  ]);
  const events = [];
  for await (const event of runAssistant(provider, { message: "Save my key.", history: [], context: { page: "builder", mapId: "m", selectedLayerId: null } }, { scope: testAccountScope(), baseUrl: "http://127.0.0.1:3391", pending: new PendingActionStore(), tools })) events.push(event);
  expect(events.some((event) => event.type === "tool_result" && event.tool === DISCOVERY_TOOL)).toBe(true);
  for (const exchange of provider.recording.exchanges) for (const name of KEY_TOOLS) expect(exchange.options.tools.map((tool: { name: string }) => tool.name)).not.toContain(name);
  for (const name of KEY_TOOLS) expect(JSON.stringify(events)).not.toContain(name);
});

it("keeps them outside every policy's set and every page's offer, and only them", () => {
  const tools = buildTools();
  for (const name of KEY_TOOLS) expect(tools.map((tool) => tool.name)).toContain(name);
  expect(tools.filter((tool) => tool.effects.keptFromAssistant).map((tool) => tool.name).sort()).toEqual([...KEY_TOOLS].sort());
  for (const policy of ["full", "read_only"] as const) {
    for (const tool of tools.filter((tool) => KEY_TOOLS.includes(tool.name))) expect(admits(policy, tool), `${tool.name} ${policy}`).toBe(false);
    for (const name of KEY_TOOLS) expect(admittedTools(policy, tools).map((tool) => tool.name)).not.toContain(name);
  }
  expect(admittedTools("full", tools)).toHaveLength(tools.length - KEY_TOOLS.length);
  for (const page of ["builder", "sql", "workflow"] as const) for (const mode of ["subset", "full"] as const) for (const policy of ["full", "read_only"] as const) {
    for (const name of KEY_TOOLS) expect(defaultOffer(page, policy, tools, mode).map((tool) => tool.name)).not.toContain(name);
  }
});
