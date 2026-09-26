import { responseWire, outputCall, outputText, anthropicWire } from "./testing/wire";
import { describe, expect, it } from "vitest";
import { buildTools } from "@/lib/tools/tools";
import { assistantAvailability } from "./config";
import { anthropicProvider } from "./providers/anthropic";
import { openaiProvider } from "./providers/openai";
import { stubProvider } from "./providers/stub";

describe("assistant availability", () => {
  it("is absent with no credential, with an enablement explanation", () => {
    const a = assistantAvailability({});
    expect(a.enabled).toBe(false);
    if (!a.enabled) expect(a.reason).toContain("ANTHROPIC_API_KEY");
  });

  it("one key enables that provider with its documented default model", () => {
    const a = assistantAvailability({ ANTHROPIC_API_KEY: "sk-test" });
    expect(a).toEqual({
      enabled: true,
      provider: "anthropic",
      model: "claude-opus-5",
      // an unset list offers the shipped catalogue.
      models: ["claude-opus-5", "claude-fable-5", "claude-sonnet-5", "claude-haiku-4"],
    });
    const o = assistantAvailability({ OPENAI_API_KEY: "sk-test" });
    expect(o).toEqual({
      enabled: true,
      provider: "openai",
      model: "gpt-5.6-terra",
      models: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-nova"],
    });
    const restored = assistantAvailability({ OPENAI_API_KEY: "sk-test", DEZFIL_AI_MODEL: "gpt-6-astra" });
    expect(restored).toEqual({
      enabled: true,
      provider: "openai",
      model: "gpt-6-astra",
      models: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-nova"],
    });
  });

  it("the provider setting picks between keys; model setting overrides", () => {
    const a = assistantAvailability({
      ANTHROPIC_API_KEY: "x",
      OPENAI_API_KEY: "y",
      DEZFIL_AI_PROVIDER: "openai",
      DEZFIL_AI_MODEL: "custom-model",
    });
    expect(a).toEqual({ enabled: true, provider: "openai", model: "custom-model", models: ["custom-model", "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-nova"] });
  });

  it("a forced provider without its key is absent with an actionable reason", () => {
    const a = assistantAvailability({
      OPENAI_API_KEY: "y",
      DEZFIL_AI_PROVIDER: "anthropic",
    });
    expect(a.enabled).toBe(false);
    if (!a.enabled) expect(a.reason).toContain("ANTHROPIC_API_KEY");
  });

  it("an unknown provider name is absent, naming the supported set", () => {
    const a = assistantAvailability({ DEZFIL_AI_PROVIDER: "llama" });
    expect(a.enabled).toBe(false);
    if (!a.enabled) expect(a.reason).toContain("anthropic and openai");
  });
});

function captureFetch(responses: object[]) {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  let call = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
    });
    const response = responses[call++];
    if ("output" in response) return responseWire(response.output as unknown[], "gpt-6-astra");
    return anthropicWire(response as Parameters<typeof anthropicWire>[0]);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const TOOLS = buildTools().filter((t) => t.name === "run_sql");

describe("anthropic provider wire shape", () => {
  const reply = (content: unknown[], stop = "tool_use") => ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-8",
    content,
    stop_reason: stop,
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  it("sends adaptive thinking, system, tools; parses text + tool calls; echoes blocks back", async () => {
    const { fetchImpl, requests } = captureFetch([
      reply([
        { type: "text", text: "Running it." },
        { type: "tool_use", id: "tu_1", name: "run_sql", input: { sql: "SELECT 1" } },
      ]),
      reply([{ type: "text", text: "Done: 1 row." }], "end_turn"),
    ]);
    const provider = anthropicProvider("sk-test", "claude-opus-4-8", fetchImpl);
    const exchange = provider.exchange({
      system: "You are the Dezfil assistant.",
      tools: TOOLS,
      history: [{ role: "user", text: "earlier turn" }],
    });

    const first = await exchange.send("count the rows");
    expect(first.text).toBe("Running it.");
    expect(first.toolCalls).toEqual([
      { id: "tu_1", name: "run_sql", args: { sql: "SELECT 1" } },
    ]);

    const body = requests[0].body;
    expect(body.model).toBe("claude-opus-4-8");
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.system).toBe("You are the Dezfil assistant.");
    expect((body.tools as { name: string }[])[0].name).toBe("run_sql");
    expect((body.messages as unknown[]).length).toBe(2); // history + user

    const second = await exchange.continueWith([
      { toolCallId: "tu_1", body: '{"rowCount":1}', isError: false },
    ]);
    expect(second.text).toBe("Done: 1 row.");
    const messages = requests[1].body.messages as {
      role: string;
      content: unknown;
    }[];
    // history, user, echoed assistant blocks, tool_result turn
    expect(messages.length).toBe(4);
    expect(messages[2].role).toBe("assistant");
    expect(
      (messages[3].content as { type: string; tool_use_id: string }[])[0],
    ).toMatchObject({ type: "tool_result", tool_use_id: "tu_1" });
  });
});

describe("OpenAI Responses wire shape", () => {
  it("keeps overrides, native calls and fresh grounding without vendor storage", async () => {
    const reasoning = { type: "reasoning", id: "reasoning", encrypted_content: "opaque-private", summary: [] };
    const call = outputCall("call_1", "run_sql", '{"sql":"SELECT 1"}');
    const { fetchImpl, requests } = captureFetch([{ output: [reasoning, call] }, { output: [outputText("Done")] }]);
    const exchange = openaiProvider("fixture", "explicit-override", fetchImpl).exchange({ system: "System", tools: TOOLS, history: [], grounding: "FIRST" });
    expect((await exchange.send("Run")).toolCalls).toEqual([{ id: "call_1", name: "run_sql", args: { sql: "SELECT 1" } }]);
    expect(requests[0].url).toContain("/responses");
    expect(requests[0].body).toMatchObject({ model: "explicit-override", store: false, background: false, stream: true, include: ["reasoning.encrypted_content"], instructions: "System" });
    expect(requests[0].body.tools).toContainEqual(expect.objectContaining({ type: "function", name: "run_sql", strict: false }));
    exchange.setGrounding!("SECOND");
    expect((await exchange.continueWith([{ toolCallId: "call_1", body: "1", isError: false }])).text).toBe("Done");
    expect(requests[1].body.input).toEqual([{ role: "user", content: "Instance grounding (data):\nSECOND" }, { role: "user", content: "Run" }, reasoning, call, { type: "function_call_output", call_id: "call_1", output: "1" }]);
    expect(requests[1].body).not.toHaveProperty("previous_response_id");
    expect(requests[1].body).not.toHaveProperty("conversation");
  });
});

describe("stub provider", () => {
  it("plays the script in order and records what the model saw", async () => {
    const provider = stubProvider([
      { text: "", toolCalls: [{ id: "1", name: "list_tables", args: {} }] },
      { text: "done", toolCalls: [] },
    ]);
    const exchange = provider.exchange({ system: "s", tools: [], history: [] });
    const first = await exchange.send("hello");
    expect(first.toolCalls[0].name).toBe("list_tables");
    const second = await exchange.continueWith([
      { toolCallId: "1", body: "[]", isError: false },
    ]);
    expect(second.text).toBe("done");
    expect(provider.recording.exchanges[0].userText).toBe("hello");
    expect(provider.recording.exchanges[0].outcomes.length).toBe(1);
  });
});
