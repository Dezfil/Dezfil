import { expect, it } from "vitest";
import { openaiProvider } from "./providers/openai";
import { runAssistant } from "./loop";
import { runStream } from "./run-stream";
import { AssistantRunStore } from "./runs";
import { sse, outputText, outputCall } from "./testing/wire";

const textDelta = (text: string) => ({ type: "response.output_text.delta", delta: text, item_id: "message", output_index: 0, content_index: 0, sequence_number: 0 });
const completed = (output: unknown[]) => ({ type: "response.completed", response: { id: "response", status: "completed", model: "gpt-6-astra", output } });
const options = { system: "System", tools: [], history: [] };

it("OpenAI Responses: text reaches NDJSON before held completion, with one legacy and delta-aware message", async () => {
  let close!: () => void;
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(textDelta("Early "))}\n\n`));
    close = () => { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(textDelta("text"))}\n\ndata: ${JSON.stringify(completed([outputText("Early text")]))}\n\n`)); controller.close(); };
  } });
  const provider = openaiProvider("fixture", "override-model", async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
  const response = runStream(runAssistant(provider, { message: "Hello", history: [] }, { baseUrl: "http://localhost:3201" }));
  const reader = response.body!.getReader();
  const first = JSON.parse(new TextDecoder().decode((await reader.read()).value).trim());
  expect(first).toMatchObject({ type: "text_delta", text: "Early " });
  close();
  const events = [first];
  for (;;) { const { done, value } = await reader.read(); if (done) break; events.push(...new TextDecoder().decode(value).trim().split("\n").map((l) => JSON.parse(l))); }
  const legacy = events.filter((e) => e.type === "message").map((e) => e.text).join("");
  const delta = new Map<string, string>();
  for (const event of events) if (event.type === "text_delta") delta.set(event.messageId, (delta.get(event.messageId) ?? "") + event.text); else if (event.type === "message") delta.set(event.messageId, event.text);
  expect(legacy).toBe("Early text"); expect([...delta.values()].join("")).toBe(legacy);
  const store = new AssistantRunStore(); const id = store.reserve().id; store.bind(id, {});
  for (const event of events) store.record(id, event);
  expect(store.read(id).text).toBe("Early text");
});

it("OpenAI Responses: split arguments and multiple calls are assembled only after completion", async () => {
  const exchange = openaiProvider("fixture", "gpt-6-astra", async () => sse([
    { type: "response.function_call_arguments.delta", item_id: "item-first", delta: '{"na' },
    { type: "response.function_call_arguments.delta", item_id: "item-second", delta: '{"sql":' },
    { type: "response.function_call_arguments.delta", item_id: "item-second", delta: '"SELECT 1"}' },
    { type: "response.function_call_arguments.delta", item_id: "item-first", delta: 'me":"A"}' },
    completed([outputCall("first", "create_map", '{"name":"A"}'), outputCall("second", "run_sql", '{"sql":"SELECT 1"}')]),
  ])).exchange(options);
  expect((await exchange.send("Work")).toolCalls).toEqual([{ id: "first", name: "create_map", args: { name: "A" } }, { id: "second", name: "run_sql", args: { sql: "SELECT 1" } }]);
});

for (const variant of ["truncated", "invalid", "missing-finish", "refusal", "provider-error", "cancelled"] as const) it(`OpenAI Responses: ${variant} executes no partial call`, async () => {
  const abort = new AbortController(); let executed = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    if (variant === "provider-error") return Response.json({ error: { message: "Fixture failure" } }, { status: 500 });
    if (variant === "cancelled") { abort.abort(); expect(init?.signal).toBeDefined(); throw new DOMException("Aborted", "AbortError"); }
    const call = outputCall("call", "create_map", variant === "invalid" ? "{" : '{"name":"Must not exist"}');
    if (variant === "truncated") return sse([{ type: "response.incomplete", response: { status: "incomplete", output: [call] } }]);
    if (variant === "missing-finish") return sse([{ type: "response.output_item.done", item: call }]);
    if (variant === "refusal") return sse([completed([{ ...outputText(""), content: [{ type: "refusal", refusal: "Declined" }] }, call])]);
    return sse([completed([call])]);
  };
  const events = [];
  for await (const event of runAssistant(openaiProvider("fixture", "override", fetchImpl), { message: "Work", history: [] }, { baseUrl: "http://localhost:3201", signal: abort.signal, fetchImpl: async () => { executed++; return Response.json({}); } })) events.push(event);
  expect(executed).toBe(0); expect(events.some((e) => e.type === "tool_call")).toBe(false);
  expect(events.some((e) => variant === "refusal" ? e.type === "message" && e.text === "Declined" : variant === "cancelled" ? e.type === "done" && e.reason === "interrupted" : e.type === "error")).toBe(true);
});

/** An error the Responses stream delivers inside a 200 reaches the SDK with
 * no HTTP status: the pane read "(network)" for what the account had refused.
 * The fixtures below are the wire the SDK reads, not our own words. */
const streamed = async (body: Record<string, unknown>) => {
  const exchange = openaiProvider("fixture", "gpt-6-astra", async () => sse([{ error: body }])).exchange(options);
  return await exchange.send("Work").then(() => "no error", (error: unknown) => (error as Error).message);
};

it("OpenAI Responses: an in-stream refusal is worded from its own code, never the network", async () => {
  expect(await streamed({ message: "You have no credits remaining. Add credits to continue using the API.", type: "insufficient_quota", code: "insufficient_quota" }))
    .toBe("The OpenAI API request failed (insufficient_quota): You have no credits remaining. Add credits to continue using the API.");
});

it("OpenAI Responses: an in-stream error with only a type is worded from the type", async () => {
  expect(await streamed({ message: "The server had an error while processing your request.", type: "server_error" }))
    .toBe("The OpenAI API request failed (server_error): The server had an error while processing your request.");
});

it("OpenAI Responses: an in-stream error naming neither drops the parenthesis", async () => {
  expect(await streamed({ message: "The model produced no response." }))
    .toBe("The OpenAI API request failed: The model produced no response.");
});

it("OpenAI Responses: an HTTP error still carries its status", async () => {
  const exchange = openaiProvider("fixture", "gpt-6-astra", async () => Response.json({ error: { message: "Fixture failure", type: "server_error" } }, { status: 503 })).exchange(options);
  await expect(exchange.send("Work")).rejects.toThrow("The OpenAI API request failed (503): 503 Fixture failure");
});

it("OpenAI Responses: a real connection failure still says so, in the SDK's own words", async () => {
  const exchange = openaiProvider("fixture", "gpt-6-astra", async () => { throw new Error("socket hang up"); }).exchange(options);
  await expect(exchange.send("Work")).rejects.toThrow("The OpenAI API request failed: Connection error.");
});
