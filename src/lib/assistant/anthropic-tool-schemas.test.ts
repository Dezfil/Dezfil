import { afterEach, expect, it, vi } from "vitest";
import { buildTools, type ToolDef } from "@/lib/tools/tools";
import { executeTool } from "@/lib/tools/execute";
import { testClient } from "@/lib/mcp/test-client";
import { assistantTools } from "./tool-surface";
import { discoveryDefinition } from "./discovery";
import { anthropicTool } from "./providers/anthropic-tool-schema";
import { anthropicProvider } from "./providers/anthropic";
import { openaiProvider } from "./providers/openai";
import { runAssistant } from "./loop";
import { anthropicEvents, responseWire, sse } from "./testing/wire";

/**
 * The Anthropic API refuses `anyOf`, `oneOf` and `allOf` at the top level of a
 * tool's input schema and answers the whole request 400, so on a working key no
 * assistant turn completed while ten generated tools carried one. What is
 * measured here is the serialized request body itself, not a helper's return
 * value: the wire is what the API reads.
 */

const UNION_KEYWORDS = ["anyOf", "oneOf", "allOf"] as const;
type Schema = Record<string, unknown>;
const unions = (schema: Schema) => UNION_KEYWORDS.filter((keyword) => keyword in schema);

/** Everything this provider can be handed in one run: the whole generated
 * listing (discovery extends the offer with any of it) plus discovery itself. */
const everyTool = () => [...assistantTools(buildTools()), discoveryDefinition()];

async function requestBody(send: (capture: (init: RequestInit | undefined) => void) => Promise<unknown>) {
  let body: Record<string, unknown> | undefined;
  await send((init) => { body = JSON.parse(String(init?.body)); });
  return body!;
}

const anthropicRequest = () => requestBody(async (capture) => {
  const provider = anthropicProvider("fixture", "claude-opus-5", async (_input, init) => { capture(init); return sse(anthropicEvents([]), true); });
  await provider.exchange({ system: "System", tools: everyTool(), history: [] }).send("Work");
});

const openaiRequest = () => requestBody(async (capture) => {
  const provider = openaiProvider("fixture", "gpt-6-astra", async (_input, init) => { capture(init); return responseWire([]); });
  await provider.exchange({ system: "System", tools: everyTool(), history: [] }).send("Work");
});

type WireTool = { name: string; description: string; input_schema: Schema };

afterEach(() => vi.unstubAllGlobals());

it("no tool definition the assistant sends to Anthropic carries a top-level union", async () => {
  const sent = (await anthropicRequest()).tools as WireTool[];
  expect(sent).toHaveLength(everyTool().length);
  const offenders = sent.filter((tool) => unions(tool.input_schema).length)
    .map((tool) => `${tool.name}: ${unions(tool.input_schema).join(", ")}`);
  expect(offenders).toEqual([]);
});

it("a dropped union is still readable as the argument sets it named", async () => {
  const sent = new Map(((await anthropicRequest()).tools as WireTool[]).map((tool) => [tool.name, tool]));
  const generated = everyTool().filter((tool) => Array.isArray((tool.inputSchema as Schema).anyOf));
  expect(generated.length).toBeGreaterThan(0);
  for (const tool of generated) {
    const schema = tool.inputSchema as Schema;
    // The expectation is read off the generated schema here, not taken from
    // the module that writes the sentence.
    const order = Object.keys(schema.properties as Record<string, unknown>);
    const branches = (schema.anyOf as Schema[]).map((branch) => {
      const declared = Object.keys((branch.properties ?? {}) as Record<string, unknown>);
      const names = order.filter((name) => declared.includes(name));
      const closed = branch.additionalProperties === false;
      const required = (branch.required ?? []) as string[];
      const tail = required.length ? ` (${required.map(name => `\`${name}\``).join(", ")} required)` : "";
      if (!names.length) return (closed ? "no arguments" : "any arguments") + tail;
      return `${closed ? "only " : ""}${names.map((name) => `\`${name}\``).join(", ")}${tail}`;
    });
    const description = sent.get(tool.name)!.description;
    expect(description.startsWith(`${tool.description}\n\n`), tool.name).toBe(true);
    expect(description.slice(tool.description.length + 2), tool.name)
      .toBe(`Accepted argument sets: ${branches.join("; or ")}.`);
  }
});

it("the fact reads as a sentence, for the shapes the generator makes", async () => {
  const sent = new Map(((await anthropicRequest()).tools as WireTool[]).map((tool) => [tool.name, tool.description]));
  expect(sent.get("refresh_table")).toContain("Accepted argument sets: only `name`; or `name`, `release`.");
  expect(sent.get("create_map")).toContain("Accepted argument sets: no arguments; or `name`, `projectId`.");
  expect(sent.get("published_layer_extent")).toContain("Accepted argument sets: only `token`, `layerId`; or `token`, `layerId`, `selections`, `timeline`.");
  // A tool whose schema never held a union says nothing extra.
  expect(sent.get("run_sql")).toBe(buildTools().find((tool) => tool.name === "run_sql")!.description);
});

/** The projection drops `oneOf` and `allOf` without a word, because neither is
 * a list of accepted argument sets. Nothing generates one today; the day
 * something does, the model would lose a constraint silently, so this fails
 * first and the derivation is extended rather than the drop going unnoticed. */
it("every top-level union the generator makes is an anyOf, which the sentence can state", () => {
  const undescribed = everyTool()
    .filter((tool) => { const schema = tool.inputSchema as Schema; return "oneOf" in schema || "allOf" in schema; })
    .map((tool) => tool.name);
  expect(undescribed).toEqual([]);
});

it("the OpenAI request and the MCP listing carry the generated schema unchanged", async () => {
  const openai = new Map((((await openaiRequest()).tools) as { name: string; description: string; parameters: Schema }[]).map((tool) => [tool.name, tool]));
  for (const tool of everyTool()) {
    expect(openai.get(tool.name)!.parameters, tool.name).toEqual(tool.inputSchema);
    expect(openai.get(tool.name)!.description, tool.name).toBe(tool.description);
  }
  const byName = new Map(buildTools().map((tool) => [tool.name, tool]));
  const client = await testClient(() => Response.json({}));
  try {
    for (const listed of (await client.listTools()).tools) {
      expect(listed.inputSchema, listed.name).toEqual(byName.get(listed.name)!.inputSchema);
      expect(listed.description, listed.name).toBe(byName.get(listed.name)!.description);
    }
  } finally { await client.close(); }
});

it("an argument set the union forbids is still refused before dispatch", async () => {
  let dispatched = 0;
  const events = [];
  const stream = sse([
    anthropicEvents([])[0],
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call", name: "layer_extent", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"id":"layer-1","dims":"not-an-array"}' } },
    { type: "content_block_stop", index: 0 },
    ...anthropicEvents([], "tool_use").slice(-2),
  ], true);
  const provider = anthropicProvider("fixture", "claude-opus-5", async () => stream);
  for await (const event of runAssistant(provider, { message: "Work", history: [] }, {
    baseUrl: "http://localhost:3201",
    fetchImpl: async () => { dispatched++; return Response.json({}); },
  })) events.push(event);
  const refusal = events.find((event) => event.type === "tool_result");
  expect(refusal).toMatchObject({
    tool: "layer_extent", ok: false,
    body: { error: { code: "invalid_request", message: "The arguments do not match this operation’s input schema." } },
  });
  expect(dispatched).toBe(0);
});

/** An operation whose optional body must carry `mode` when it is present: the
 * union is the only thing in the schema that forbids `{id, other}`, which the
 * rest of the schema admits. The Anthropic definition drops the union, so the
 * model may propose that set; Dezfil's own validation must still refuse it. */
const optionalBodyFixture: ToolDef = {
  name: "fixture_optional_body",
  description: "A fixture operation with an optional body.",
  inputSchema: {
    anyOf: [
      { type: "object", properties: { id: {} }, additionalProperties: false },
      { type: "object", properties: { mode: { type: "string" }, id: {} }, required: ["mode"] },
    ],
    type: "object",
    properties: { id: { type: "string" }, mode: { type: "string" } },
    required: ["id"],
  },
  method: "post", path: "/api/fixture/{id}", confirm: false,
  effects: { readOnly: true, writes: [] },
  display: { verb: "Exercised the fixture" },
  relevance: [], upload: false, bodyKeys: ["mode"], pathParams: ["id"], queryParams: [],
};

it("what only the union forbade is still refused, though Anthropic no longer sees it", async () => {
  const projected = anthropicTool(optionalBodyFixture);
  expect(unions(projected.input_schema)).toEqual([]);
  expect(projected.description).toContain("Accepted argument sets: only `id`; or `id`, `mode` (`mode` required).");

  const forbidden = { id: "fixture", other: "surplus" };
  // The rest of the schema admits it: the union is the whole constraint.
  const withoutUnion: ToolDef = { ...optionalBodyFixture, name: "fixture_without_union", inputSchema: { ...optionalBodyFixture.inputSchema } };
  delete (withoutUnion.inputSchema as Schema).anyOf;
  let dispatched = 0;
  const fetchImpl: typeof fetch = async () => { dispatched++; return Response.json({ ok: true }); };
  expect(await executeTool(withoutUnion, forbidden, "http://localhost:3201", fetchImpl)).toMatchObject({ ok: true });
  expect(dispatched).toBe(1);

  const events = [];
  const stream = sse([
    anthropicEvents([])[0],
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call", name: "fixture_optional_body", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(forbidden) } },
    { type: "content_block_stop", index: 0 },
    ...anthropicEvents([], "tool_use").slice(-2),
  ], true);
  const provider = anthropicProvider("fixture", "claude-opus-5", async () => stream);
  for await (const event of runAssistant(provider, { message: "Work", history: [] }, {
    baseUrl: "http://localhost:3201", tools: [optionalBodyFixture], discovery: false,
    fetchImpl: async () => { dispatched++; return Response.json({}); },
  })) events.push(event);
  expect(events.find((event) => event.type === "tool_result")).toMatchObject({
    tool: "fixture_optional_body", ok: false,
    body: { error: { code: "invalid_request", message: "The arguments do not match this operation’s input schema." } },
  });
  expect(dispatched).toBe(1);
});
