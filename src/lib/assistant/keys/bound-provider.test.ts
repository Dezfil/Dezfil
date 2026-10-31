import { describe, expect, it, vi } from "vitest";
import type { ModelProvider, ProviderCallOptions, ProviderReply } from "../provider";
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
  it("loses the key from everything it carries, not only its words", async () => {
    const { reply } = await streamed([], {
      messageId: `message-${KEY}`, model: `model-${KEY}`, text: `words ${KEY}`,
      toolCalls: [{ id: `call-${KEY}`, name: "create_map", args: { name: KEY, nested: { list: [`one ${KEY}`, 7, null, true] } } }],
      usage: { inputTokens: 3, outputTokens: 4 },
    });
    expect(JSON.stringify(reply)).not.toContain(KEY);
    expect(reply).toEqual({
      messageId: `message-${MASK}`, model: `model-${MASK}`, text: `words ${MASK}`,
      toolCalls: [{ id: `call-${MASK}`, name: "create_map", args: { name: MASK, nested: { list: [`one ${MASK}`, 7, null, true] } } }],
      usage: { inputTokens: 3, outputTokens: 4 },
    });
  });
});
