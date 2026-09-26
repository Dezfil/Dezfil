import { expect, it } from "vitest";
import { anthropicProvider } from "./providers/anthropic";
import { runAssistant } from "./loop";
import { runStream } from "./run-stream";
import { AssistantRunStore } from "./runs";
import { sse, anthropicEvents } from "./testing/wire";
const start = anthropicEvents([])[0];
const end = (reason = "end_turn") => anthropicEvents([], reason).slice(-2);
const textDelta = (text: string) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const block = (index: number, content_block: object) => ({ type: "content_block_start", index, content_block });
const stop = (index: number) => ({ type: "content_block_stop", index });
const encode = (event: unknown) => new TextEncoder().encode(`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`);

it("Anthropic text reaches NDJSON before held completion and all consumers keep it once", async () => {
  let close!: () => void;
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (const event of [start, block(0, { type: "text", text: "" }), textDelta("Early ")]) controller.enqueue(encode(event));
    close = () => { for (const event of [textDelta("text"), stop(0), ...end()]) controller.enqueue(encode(event)); controller.close(); };
  } });
  const provider = anthropicProvider("fixture", "claude-opus-5", async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
  const response = runStream(runAssistant(provider, { message: "Hello", history: [] }, { baseUrl: "http://localhost:3201" }));
  const reader = response.body!.getReader();
  const first = JSON.parse(new TextDecoder().decode((await reader.read()).value).trim());
  expect(first).toMatchObject({ type: "text_delta", text: "Early " }); close();
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

it("Anthropic split arguments, multiple calls and private thinking retain native continuation", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length > 1) return sse(anthropicEvents([{ type: "text", text: "Done" }]), true);
    return sse([
      start, block(0, { type: "thinking", thinking: "", signature: "" }),
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "PRIVATE_THOUGHT" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIGNATURE" } }, stop(0),
      block(1, { type: "tool_use", id: "first", name: "create_map", input: {} }),
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"na' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'me":"A"}' } }, stop(1),
      block(2, { type: "tool_use", id: "second", name: "run_sql", input: {} }),
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"sql":"SELECT 1"}' } }, stop(2), ...end("tool_use"),
    ], true);
  };
  const exchange = anthropicProvider("fixture", "explicit-override", fetchImpl).exchange({ system: "System", tools: [], history: [], grounding: "FIRST" });
  const text: string[] = [];
  const first = await exchange.send("Work", { onTextDelta: (delta) => text.push(delta) });
  expect(first.toolCalls).toEqual([{ id: "first", name: "create_map", args: { name: "A" } }, { id: "second", name: "run_sql", args: { sql: "SELECT 1" } }]);
  expect(text).toEqual([]); expect(first.text).toBe("");
  exchange.setGrounding!("SECOND");
  await exchange.continueWith(first.toolCalls.map((call) => ({ toolCallId: call.id, body: "{}", isError: false })));
  const native = (bodies[1].messages as { role: string; content: unknown }[]).find((m) => m.role === "assistant")!.content;
  expect(native).toEqual([{ type: "thinking", thinking: "PRIVATE_THOUGHT", signature: "SIGNATURE" }, { type: "tool_use", id: "first", name: "create_map", input: { name: "A" } }, { type: "tool_use", id: "second", name: "run_sql", input: { sql: "SELECT 1" } }]);
  expect(bodies[0]).toMatchObject({ model: "explicit-override", stream: true, thinking: { type: "adaptive" }, max_tokens: 8192 });
  expect(JSON.stringify(bodies[1])).not.toContain("FIRST"); expect(JSON.stringify(bodies[1])).toContain("SECOND");
});

for (const variant of ["truncated", "invalid", "missing-stop", "refusal", "provider-error", "cancelled"] as const) it(`Anthropic ${variant} executes no partial call`, async () => {
  const abort = new AbortController(); let executed = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    if (variant === "provider-error") return sse([{ type: "error", error: { type: "overloaded_error", message: "Fixture error" } }], true);
    if (variant === "cancelled") { abort.abort(); expect(init?.signal).toBeDefined(); throw new DOMException("Aborted", "AbortError"); }
    return sse([start, block(0, { type: "tool_use", id: "call", name: "create_map", input: {} }),
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: variant === "invalid" ? '{"name":' : '{"name":"Must not exist"}' } }, stop(0),
      ...(variant === "missing-stop" ? [] : end(variant === "truncated" ? "max_tokens" : variant === "refusal" ? "refusal" : "tool_use")),
    ], true);
  };
  const events = [];
  for await (const event of runAssistant(anthropicProvider("fixture", "claude-opus-5", fetchImpl), { message: "Work", history: [] }, { baseUrl: "http://localhost:3201", signal: abort.signal, fetchImpl: async () => { executed++; return Response.json({}); } })) events.push(event);
  expect(executed).toBe(0); expect(events.some((e) => e.type === "tool_call")).toBe(false);
  expect(events.some((e) => variant === "refusal" ? e.type === "message" && e.text.includes("declined") : variant === "cancelled" ? e.type === "done" && e.reason === "interrupted" : e.type === "error")).toBe(true);
});

/** An error Anthropic delivers inside the stream reaches the SDK with no HTTP
 * status: `core/streaming.ts` builds it as `new APIError(undefined, body,
 * undefined, headers, body.error.type)`. Reading the absent status as the
 * network told the person their connection had failed when the provider had
 * refused (the class ` ` repaired for OpenAI). The fixtures below are the
 * wire the SDK reads, not our own words. */
const failure = async (respond: () => Response) => {
  const exchange = anthropicProvider("fixture", "claude-opus-5", async () => respond())
    .exchange({ system: "System", tools: [], history: [] });
  return await exchange.send("Work").then(() => "no error", (error: unknown) => (error as Error).message);
};

it("Anthropic: an in-stream error is worded from its own type, never the network", async () => {
  expect(await failure(() => sse([{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }], true)))
    .toBe('The Anthropic API request failed (overloaded_error): {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
});

it("Anthropic: an in-stream error naming no type drops the parenthesis", async () => {
  expect(await failure(() => sse([{ type: "error", error: { message: "The model produced no response." } }], true)))
    .toBe('The Anthropic API request failed: {"type":"error","error":{"message":"The model produced no response."}}');
});

it("Anthropic: an HTTP error still carries its status", async () => {
  expect(await failure(() => Response.json({ type: "error", error: { type: "api_error", message: "Fixture failure" } }, { status: 503 })))
    .toBe('The Anthropic API request failed (503): 503 {"type":"error","error":{"type":"api_error","message":"Fixture failure"}}');
});

it("Anthropic: a real connection failure still says so, in the SDK's own words", async () => {
  const exchange = anthropicProvider("fixture", "claude-opus-5", async () => { throw new Error("socket hang up"); })
    .exchange({ system: "System", tools: [], history: [] });
  await expect(exchange.send("Work")).rejects.toThrow("The Anthropic API request failed: Connection error.");
});

/** A tool call that takes no arguments streams an empty argument text: one
 * delta whose `partial_json` is the empty string, or no delta at all. The
 * SDK's own accumulator guards the empty buffer and leaves the block's `input`
 * as `{}`; this adapter kept the text it was given and fell back to that input
 * only when it had kept nothing, and an empty string is not nothing, so the
 * parse threw and the whole reply — its text and its other calls with it — was
 * thrown away (found live: the missing-data scenario, whose first useful call
 * is a catalogue read). The fixtures are the SSE wire the SDK reads. The reply
 * carries a second call with real arguments, because the row is about the rest
 * of the reply as much as the empty call. */
const emptyArgumentReply = (deltas: unknown[], closeTheCall = true) => [
  start,
  block(0, { type: "text", text: "" }), textDelta("Checking what this instance holds."), stop(0),
  block(1, { type: "tool_use", id: "catalogue", name: "read_table_catalogue", input: {} }),
  ...deltas, ...(closeTheCall ? [stop(1)] : []),
  block(2, { type: "tool_use", id: "query", name: "run_sql", input: {} }),
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"sql":"SELECT 1"}' } }, stop(2),
  ...end("tool_use"),
];

const emptyDelta = { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "" } };

async function replyOf(first: unknown[]) {
  let turn = 0;
  const dispatched: string[] = [];
  const provider = anthropicProvider("fixture", "claude-opus-5", async () =>
    turn++ === 0 ? sse(first, true) : sse(anthropicEvents([{ type: "text", text: "Done" }]), true));
  const events: { type: string; [key: string]: unknown }[] = [];
  for await (const event of runAssistant(provider, { message: "Work", history: [] }, {
    baseUrl: "http://localhost:3201",
    fetchImpl: async (input) => { dispatched.push(new URL(String(input)).pathname); return Response.json({}); },
  })) events.push(event as { type: string });
  const calls = events.flatMap((e) => e.type === "tool_call" ? [[e.tool, e.args]] : []);
  const text = events.flatMap((e) => e.type === "text_delta" ? [String(e.text)] : []).join("");
  return { events, dispatched, calls, text };
}

it("Anthropic: a call whose arguments are empty is dispatched, and the rest of the reply survives", async () => {
  const { calls, dispatched, text, events } = await replyOf(emptyArgumentReply([emptyDelta]));
  // Named first, because this is the sentence the live run met.
  expect(events.flatMap((e) => e.type === "error" ? [e.message] : [])).toEqual([]);
  expect(calls).toEqual([["read_table_catalogue", {}], ["run_sql", { sql: "SELECT 1" }]]);
  expect(dispatched).toEqual(["/api/catalogue/tables", "/api/query"]);
  expect(text).toContain("Checking what this instance holds.");
});

it("Anthropic: a call whose argument delta never arrives is dispatched the same way", async () => {
  const { calls, dispatched, events } = await replyOf(emptyArgumentReply([]));
  expect(calls).toEqual([["read_table_catalogue", {}], ["run_sql", { sql: "SELECT 1" }]]);
  expect(dispatched).toEqual(["/api/catalogue/tables", "/api/query"]);
  expect(events.some((e) => e.type === "error")).toBe(false);
});

/** The control that keeps the repair honest: an empty argument text is a
 * complete call only because its block closed. A block left open is a
 * truncation whatever its text says, and is refused before the arguments are
 * read at all. Two more controls sit above: argument text that is not empty
 * and not valid JSON (the `invalid` variant), and a call with real arguments
 * (the split-arguments test). */
it("Anthropic: an empty argument text in a block that never closed is still refused", async () => {
  const { calls, dispatched, events } = await replyOf(emptyArgumentReply([emptyDelta], false));
  expect(calls).toEqual([]);
  expect(dispatched).toEqual([]);
  expect(events.filter((e) => e.type === "error").map((e) => e.message)).toEqual([
    "The model response ended before a complete reply. No calls from this reply were executed.",
  ]);
});
