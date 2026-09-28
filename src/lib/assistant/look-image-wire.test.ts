import { requireRequestAuth } from "@/lib/auth/http";
import { instanceFetch } from "@/lib/auth/instance-fetch";
import { authenticatedRequest } from "@/lib/assistant/testing/account";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { createMap } from "@/lib/map-service";
import { setLookDriverForTests } from "@/lib/export/map-look";
import { encodePng } from "@/lib/export/png-codec";
import type { RenderDriver } from "@/lib/export/render-image";
import { runAssistant, type AssistantEvent } from "./loop";
import { PendingActionStore } from "./pending";
import type { ProviderImage, ToolOutcome } from "./provider";
import { anthropicProvider } from "./providers/anthropic";
import { openaiProvider } from "./providers/openai";
import { stubProvider } from "./providers/stub";
import { assistantRuns } from "./runs";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";
import { anthropicWire, outputCall, outputText, responseWire, sse } from "./testing/wire";

/**
 * The image on the wire: on each adapter the check's bytes reach the
 * provider's native image field, decoded byte for byte, in the first
 * request carrying them, in a later request of the same exchange and in
 * a continuation that answers another outcome, while no text field of
 * any request holds their base64; the model-requested path rides the
 * real tool-call identity and the automatic path is a user turn with
 * text and image that answers no tool call, both inside each vendor's
 * own shape rules; provider usage is retained where the wire reports it
 * and absent, never zero, where it does not; and through the loop, no
 * event and no receipt carries the bytes while the stub records them
 * decoded.
 */
const FIXTURE = encodePng({ width: 64, height: 40, rgba: new Uint8Array(64 * 40 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 13) & 0xff)) });
const B64 = Buffer.from(FIXTURE).toString("base64");
const image: ProviderImage = { mediaType: "image/png", data: FIXTURE };
const facts = JSON.stringify({ render: { id: "render-1", image: { width: 64, height: 40, bytes: FIXTURE.byteLength } } });
const tool = { name: "look_at_map", description: "Look", inputSchema: { type: "object" as const, properties: {} }, method: "post", path: "/api/maps/look", confirm: false, effects: { readOnly: true, writes: [] }, display: { verb: "Checked the map" }, relevance: ["builder" as const], upload: false, bodyKeys: ["mapId"], pathParams: [], queryParams: [] };

/** Every string anywhere in a request body, so base64 in any text field is caught wherever it hides. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}
const textFields = (body: unknown, imageHolders: (s: string) => boolean) => strings(body).filter((s) => !imageHolders(s));

describe("1j and 2g on the OpenAI Responses wire", () => {
  it("the image rides the real function_call_output, then replays, then a user image turn answers no call; no base64 in any text; usage retained", async () => {
    const sent: { input: Record<string, unknown>[]; instructions: string }[] = [];
    let n = 0;
    const wire: typeof fetch = async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)));
      n += 1;
      if (n === 1) return responseWire([outputCall("call-1", "look_at_map", "{}")]);
      if (n === 2) return sse([{ type: "response.completed", response: { id: "r2", status: "completed", model: "gpt-6-astra", output: [outputText("I see the map.")], usage: { input_tokens: 1200, output_tokens: 8, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }]);
      return responseWire([outputText("Done.")]);
    };
    const exchange = openaiProvider("fixture", "gpt-6-astra", wire).exchange({ system: "sys", tools: [tool], history: [] });
    const first = await exchange.send("look");
    expect(first.toolCalls).toEqual([{ id: "call-1", name: "look_at_map", args: {} }]);
    expect(first.usage).toBeUndefined();
    const outcome: ToolOutcome = { toolCallId: "call-1", body: facts, isError: false, image };
    const second = await exchange.continueWith([outcome]);
    expect(second.text).toBe("I see the map.");
    expect(second.usage).toEqual({ inputTokens: 1200, outputTokens: 8 });
    // The first request carrying it: on the real call identity, as an input_image item.
    const holder = sent[1].input.find((item) => item.type === "function_call_output") as { call_id: string; output: unknown };
    expect(holder.call_id).toBe("call-1");
    const parts = holder.output as { type: string; text?: string; image_url?: string }[];
    expect(Array.isArray(parts)).toBe(true);
    const img = parts.find((p) => p.type === "input_image")!;
    expect(img.image_url!.startsWith("data:image/png;base64,")).toBe(true);
    expect(Buffer.from(img.image_url!.slice("data:image/png;base64,".length), "base64").equals(Buffer.from(FIXTURE))).toBe(true);
    expect(parts.find((p) => p.type === "input_text")!.text).toBe(facts);
    const isImageUrl = (s: string) => s.startsWith("data:image/png;base64,");
    expect(textFields(sent[1], isImageUrl).some((s) => s.includes(B64.slice(0, 40)))).toBe(false);
    // The automatic case: a user turn with text and image, answering no call.
    const third = await exchange.continueWithImage!({ text: "The map you just changed.", image });
    expect(third.text).toBe("Done.");
    const last = sent[2].input[sent[2].input.length - 1] as { role: string; content: { type: string; image_url?: string; text?: string }[] };
    expect(last.role).toBe("user");
    expect(last.content.map((c) => c.type)).toEqual(["input_text", "input_image"]);
    expect(Buffer.from(last.content[1].image_url!.slice("data:image/png;base64,".length), "base64").equals(Buffer.from(FIXTURE))).toBe(true);
    // A later request of the same exchange still carries the first image, replayed, and answers every call it names.
    const calls = sent[2].input.filter((i) => i.type === "function_call").map((i) => i.call_id);
    const answered = sent[2].input.filter((i) => i.type === "function_call_output").map((i) => i.call_id);
    expect(calls.every((id) => answered.includes(id))).toBe(true);
    expect(sent[2].input.filter((i) => i.type === "function_call_output")).toHaveLength(1);
    expect(textFields(sent[2], isImageUrl).some((s) => s.includes(B64.slice(0, 40)))).toBe(false);
    // The image is never text: the counted images equal the images sent.
    expect(strings(sent[2]).filter(isImageUrl)).toHaveLength(2);
  });
});

describe("1j and 2g on the Anthropic Messages wire", () => {
  it("the image rides the real tool_result, then replays, then a user image turn answers no call; no base64 in any text; usage retained", async () => {
    const sent: { messages: { role: string; content: unknown }[] }[] = [];
    let n = 0;
    const wire: typeof fetch = async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)));
      n += 1;
      if (n === 1) return anthropicWire({ model: "claude-opus-5", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu-1", name: "look_at_map", input: {} }] });
      if (n === 2) return sse([
        { type: "message_start", message: { id: "m2", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "I see the map." } }, { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } },
        { type: "message_stop" },
      ], true);
      return anthropicWire({ model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] });
    };
    const exchange = anthropicProvider("fixture", "claude-opus-5", wire).exchange({ system: "sys", tools: [tool], history: [] });
    const first = await exchange.send("look");
    expect(first.toolCalls).toEqual([{ id: "toolu-1", name: "look_at_map", args: {} }]);
    const second = await exchange.continueWith([{ toolCallId: "toolu-1", body: facts, isError: false, image }]);
    expect(second.text).toBe("I see the map.");
    expect(second.usage).toEqual({ inputTokens: 900, outputTokens: 7 });
    type Block = { type: string; text?: string; tool_use_id?: string; content?: Block[]; source?: { type: string; media_type: string; data: string } };
    const resultMessage = sent[1].messages.find((m) => m.role === "user" && Array.isArray(m.content) && (m.content as Block[]).some((b) => b.type === "tool_result"))!;
    const result = (resultMessage.content as Block[]).find((b) => b.type === "tool_result")!;
    expect(result.tool_use_id).toBe("toolu-1");
    expect(result.content!.map((b) => b.type)).toEqual(["text", "image"]);
    expect(result.content![0].text).toBe(facts);
    expect(result.content![1].source).toMatchObject({ type: "base64", media_type: "image/png" });
    expect(Buffer.from(result.content![1].source!.data, "base64").equals(Buffer.from(FIXTURE))).toBe(true);
    const isImageData = (s: string) => s === B64;
    expect(textFields(sent[1], isImageData).some((s) => s.includes(B64.slice(0, 40)))).toBe(false);
    const third = await exchange.continueWithImage!({ text: "The map you just changed.", image });
    expect(third.text).toBe("Done.");
    const last = sent[2].messages[sent[2].messages.length - 1] as { role: string; content: Block[] };
    expect(last.role).toBe("user");
    expect(last.content.map((c) => c.type)).toEqual(["text", "image"]);
    expect(Buffer.from(last.content[1].source!.data, "base64").equals(Buffer.from(FIXTURE))).toBe(true);
    // The vendor's rule: every tool_use in an assistant turn is answered by a tool_result in the following user turn.
    const messages = sent[2].messages as { role: string; content: Block[] | string }[];
    for (let i = 0; i < messages.length; i += 1) {
      const m = messages[i];
      if (m.role !== "assistant" || typeof m.content === "string") continue;
      const uses = m.content.filter((b) => b.type === "tool_use").map((b) => (b as { id?: string }).id);
      if (uses.length === 0) continue;
      const next = messages[i + 1];
      const results = Array.isArray(next?.content) ? next.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id) : [];
      expect(results.sort()).toEqual(uses.sort());
    }
    expect(strings(sent[2]).filter(isImageData)).toHaveLength(2);
    expect(textFields(sent[2], isImageData).some((s) => s.includes(B64.slice(0, 40)))).toBe(false);
  });
});

describe("the stub carries both protocol cases, decoded", () => {
  it("records the outcome's image and the automatic continuation's image byte for byte", async () => {
    const stub = stubProvider([{ text: "", toolCalls: [{ id: "c1", name: "look_at_map", args: {} }] }, { text: "Seen.", toolCalls: [] }, { text: "Seen again.", toolCalls: [] }]);
    const exchange = stub.exchange({ system: "sys", tools: [tool], history: [] });
    await exchange.send("look");
    await exchange.continueWith([{ toolCallId: "c1", body: facts, isError: false, image }]);
    const record = stub.recording.exchanges[0];
    expect(Buffer.from(record.outcomes[0][0].image!.data).equals(Buffer.from(FIXTURE))).toBe(true);
    const reply = await exchange.continueWithImage!({ text: "The map.", image });
    expect(reply.text).toBe("Seen again.");
    expect(record.images).toHaveLength(1);
    expect(record.images![0].text).toBe("The map.");
    expect(Buffer.from(record.images![0].image.data).equals(Buffer.from(FIXTURE))).toBe(true);
  });
});

describe("1j through the loop: no event and no receipt carries the bytes", () => {
  let dir: string; let mapId: string;
  beforeEach(async () => {
    await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
    dir = await mkdtemp(path.join(process.cwd(), ".tmp-wire-"));
    vi.stubEnv("DEZFIL_DATA_DIR", dir); vi.stubEnv("PORT", "3311");
    closeMetadataDb();
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => dispatchAssistantTestRoute(input instanceof Request ? input : new Request(String(input), init)));
    mapId = createMap("Wire").id;
    const driver: RenderDriver = { launch: async () => ({ render: async () => ({ png: FIXTURE, consumed: JSON.stringify({ map: mapId, layers: [], legend: { visible: false, corner: "bottom-left", order: [] }, widgets: [], attribution: "", failures: [] }) }), close: async () => {}, kill: () => {} }) };
    setLookDriverForTests(driver);
  });
  afterEach(async () => { setLookDriverForTests(null); closeMetadataDb(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
  it("the model reads the decoded bytes while the events and the receipt hold only the facts", async () => {
    const stub = stubProvider([{ text: "", toolCalls: [{ id: "c1", name: "look_at_map", args: { mapId } }] }, { text: "One flat image.", toolCalls: [] }]);
    const runs = assistantRuns; runs.resetForTests();
    const run = runs.reserve(); runs.bind(run.id, { message: "look" });
    const events: AssistantEvent[] = [];
    for await (const event of runAssistant(stub, { message: "look", history: [], context: { page: "builder", mapId, selectedLayerId: null } }, { baseUrl: "http://127.0.0.1:3311", fetchImpl: instanceFetch("http://127.0.0.1:3311", requireRequestAuth(authenticatedRequest())), pending: new PendingActionStore(), runId: run.id })) { events.push(event); runs.record(run.id, event); }
    runs.finish(run.id);
    const outcome = stub.recording.exchanges[0].outcomes[0][0];
    expect(Buffer.from(outcome.image!.data).equals(Buffer.from(FIXTURE))).toBe(true);
    expect(outcome.body).not.toContain(B64.slice(0, 40));
    expect(JSON.stringify(events)).not.toContain(B64.slice(0, 40));
    expect(JSON.stringify(runs.read(run.id))).not.toContain(B64.slice(0, 40));
    const result = events.find((e): e is Extract<AssistantEvent, { type: "tool_result" }> => e.type === "tool_result")!;
    expect(result.render).toMatchObject({ mapId, image: { width: 1024, height: 640, bytes: FIXTURE.byteLength } });
    expect((result.body as { image?: unknown }).image).toBeUndefined();
  });
});
