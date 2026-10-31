import { describe, expect, it, vi } from "vitest";
import { ProviderError, type ModelProvider, type ProviderCallOptions, type ProviderReply } from "../provider";
import { boundToSave } from "./bound-provider";

vi.mock("./store", () => ({ isCurrentSave: () => true }));

/** What a provider sends back, delta by delta, then its reply or its failure. */
const KEY = "sk-canary-0123456789abcdef";
const MASK = "[key removed]";
const quiet: ProviderReply = { text: "", toolCalls: [] };

function bound(pieces: string[], ending: ProviderReply | Error = quiet) {
  const respond = async (options?: ProviderCallOptions) => {
    for (const piece of pieces) options?.onTextDelta?.(piece);
    if (ending instanceof Error) throw ending;
    return ending;
  };
  const provider: ModelProvider = {
    id: "stand-in", model: "stand-in-model",
    exchange: () => ({
      retainedForTests: () => ({ history: [], grounding: undefined, tools: [] }),
      send: (_text, options) => respond(options),
      continueWith: (_outcomes, options) => respond(options),
      continueWithImage: (_image, options) => respond(options),
    }),
  };
  return boundToSave(provider, "ada", { key: KEY, save: "first" }).exchange({} as never);
}
async function streamed(pieces: string[], ending?: ProviderReply | Error) {
  const seen: string[] = [];
  const reply = await bound(pieces, ending).send("hello", { onTextDelta: (text) => seen.push(text) }).catch((error: Error) => error);
  return { seen, reply };
}

describe("a provider's stream on a person's key", () => {
  it("loses the key wherever the deltas split it", async () => {
    for (let at = 1; at < KEY.length; at += 1) {
      const { seen } = await streamed([`before ${KEY.slice(0, at)}`, `${KEY.slice(at)} after`]);
      expect(seen.join(""), `split at ${at}`).toBe(`before ${MASK} after`);
    }
    const { seen } = await streamed([...KEY].map((letter) => letter));
    expect(seen.join("")).toBe(MASK);
  });

  it("loses the key's URL-encoded form across a split too", async () => {
    const provider: ModelProvider = {
      id: "stand-in", model: "stand-in-model",
      exchange: () => ({
        retainedForTests: () => ({ history: [], grounding: undefined, tools: [] }),
        send: async (_text, options) => { options?.onTextDelta?.("sk%2Fca"); options?.onTextDelta?.("nary-value!"); return quiet; },
        continueWith: async () => quiet,
      }),
    };
    const seen: string[] = [];
    await boundToSave(provider, "ada", { key: "sk/canary-value!", save: "first" }).exchange({} as never).send("hello", { onTextDelta: (text) => seen.push(text) });
    expect(seen.join("")).not.toContain("canary");
  });

  it("delivers ordinary words whole and in order, and what merely starts like the key by the end", async () => {
    const { seen } = await streamed(["The ", "s", "k", "y is clear, s"]);
    expect(seen.join("")).toBe("The sky is clear, s");
  });

  it("holds back a start of the key when the provider fails on it", async () => {
    const { seen, reply } = await streamed(["before ", KEY.slice(0, 12)], new Error("connection lost"));
    expect(reply).toBeInstanceOf(Error);
    expect(seen.join("")).toBe("before ");
  });

  it("holds the same over a continuation", async () => {
    const seen: string[] = [];
    await bound([KEY.slice(0, 5), KEY.slice(5)]).continueWith([], { onTextDelta: (text) => seen.push(text) });
    expect(seen.join("")).toBe(MASK);
  });
});

describe("a provider's reply on a person's key", () => {
  it("loses the key from its words, keeping everything else as it came", async () => {
    const toolCalls = [{ id: "call-1", name: "create_map", args: { name: "Parks" } }];
    const { reply } = await streamed([], { messageId: "message-1", model: "stand-in-model", text: `words ${KEY}`, toolCalls, usage: { inputTokens: 3, outputTokens: 4 } });
    expect(reply).toEqual({ messageId: "message-1", model: "stand-in-model", text: `words ${MASK}`, toolCalls, usage: { inputTokens: 3, outputTokens: 4 } });
  });

  // Masking would change what a call does, and break the match between a call
  // and its outcome in the next request, so the turn stops instead.
  it.each([
    ["a tool's arguments", { text: "", toolCalls: [{ id: "call-1", name: "update_layer", args: { sql: `SELECT '${KEY}'` } }] }],
    ["nested arguments", { text: "", toolCalls: [{ id: "call-1", name: "create_map", args: { nested: { list: [7, encodeURIComponent(KEY)] } } }] }],
    ["an argument's name", { text: "", toolCalls: [{ id: "call-1", name: "create_map", args: { [KEY]: 1 } }] }],
    ["a call's identity", { text: "", toolCalls: [{ id: `call-${KEY}`, name: "create_map", args: {} }] }],
    ["the reported model", { text: "", toolCalls: [], model: `model-${KEY}` }],
    ["the message identity", { text: "", toolCalls: [], messageId: `message-${KEY}` }],
  ])("stops the turn when %s carries the key", async (_where, reply) => {
    const { reply: refused } = await streamed([], reply);
    expect(refused).toBeInstanceOf(ProviderError);
    expect((refused as ProviderError).kind).toBe("provider");
    expect(String((refused as ProviderError).message) + String((refused as ProviderError).detail)).not.toContain(KEY);
  });
});
