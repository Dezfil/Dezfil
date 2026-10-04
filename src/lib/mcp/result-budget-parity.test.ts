import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { setupGeometryTest, cleanupGeometryTest } from "@/lib/test-support/geometry";
import { testAccountScope } from "@/lib/test-support/accounts";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { runAssistant, type AssistantEvent } from "@/lib/assistant/loop";
import { stubProvider } from "@/lib/assistant/providers/stub";
import { testClient } from "./test-client";

const sentence = "The result is too large to return: more than 32 MB in total, or one non-geometry value over 2 MB. Select fewer rows or columns, or shorten the value.";
const refusal = { error: { code: "query_result_too_large", message: sentence } };
const sql = "SELECT repeat('x', 1000000) AS payload FROM range(40)";
let dir: string, client: Client;
beforeEach(async () => { dir = await setupGeometryTest(); client = await testClient(dispatchAssistantTestRoute); });
afterEach(async () => { await client?.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await cleanupGeometryTest(dir); });
it("relays the real REST refusal through stock MCP text and structured outcomes", async () => {
  const rest = await dispatchAssistantTestRoute(new Request("http://localhost:3307/api/query", { method: "POST", body: JSON.stringify({ sql }) }));
  expect(rest.status).toBe(422); expect(await rest.json()).toEqual(refusal);
  const mcp = await client.callTool({ name: "run_sql", arguments: { sql } });
  expect(mcp.isError).toBe(true);
  expect(mcp.structuredContent).toEqual({ result: refusal, history: null });
  expect(mcp.content).toEqual([{ type: "text", text: JSON.stringify(refusal) }]);
});
it("relays the actual route refusal to a deterministic assistant turn and its provider", async () => {
  const provider = stubProvider([
    { text: "", toolCalls: [{ name: "run_sql", args: { sql }, id: "large" }] },
    { text: "Select fewer rows.", toolCalls: [] },
  ]);
  const events: AssistantEvent[] = [];
  for await (const event of runAssistant(provider, { message: "Run this SQL", history: [] }, {
    scope: testAccountScope(), baseUrl: "http://localhost:3307", autoCheck: false,
    fetchImpl: async (input, init) => dispatchAssistantTestRoute(input instanceof Request ? input : new Request(String(input), init)),
  })) events.push(event);
  expect(events.find(e => e.type === "tool_result")).toMatchObject({ type: "tool_result", tool: "run_sql", ok: false, body: refusal, outcome: "refused" });
  const outcome = provider.recording.exchanges[0].outcomes.flat().find(o => o.toolCallId === "large")!;
  expect(outcome.isError).toBe(true); expect(JSON.parse(outcome.body)).toEqual(refusal);
});
it("does not recount MCP text and structured copies of one fitting REST result", async () => {
  const result = await client.callTool({ name: "run_sql", arguments: { sql: "SELECT repeat('x', 1000000) AS payload FROM range(17)" } });
  expect(result.isError).not.toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(33554432);
  const body = (result.structuredContent as { result: { preview: unknown[]; rowCount: number } }).result;
  expect(body.rowCount).toBe(17); expect(body.preview).toHaveLength(17);
  expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(33554432);
});
