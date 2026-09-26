import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS, assistantAvailability } from "./config";

/**
 * What an instance allows a person to choose: a list per provider, only
 * the resolved provider's applying, the existing default present
 * exactly once whether or not the owner names it, and an unset list
 * offering the effective catalogue.
 *
 * The expectations here are written out rather than derived from the
 * parsing under test: every case states the whole list it expects.
 */

const KEYS = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" } as const;
const LISTS = { openai: "DEZFIL_AI_MODELS_OPENAI", anthropic: "DEZFIL_AI_MODELS_ANTHROPIC" } as const;

function enabled(env: Record<string, string | undefined>) {
  const availability = assistantAvailability(env);
  if (!availability.enabled) throw new Error(`expected enabled, got: ${availability.reason}`);
  return availability;
}

describe("the instance's allowed models", () => {
  it("nothing configured: the whole catalogue, on each provider", () => {
    expect(enabled({ [KEYS.openai]: "k" }).models).toEqual(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-nova"]);
    expect(enabled({ [KEYS.anthropic]: "k" }).models).toEqual(["claude-opus-5", "claude-fable-5", "claude-sonnet-5", "claude-haiku-4"]);
    // And the default itself is unchanged, so nothing in the product moves.
    expect(enabled({ [KEYS.openai]: "k" }).model).toBe(DEFAULT_MODELS.openai);
  });

  it("a configured list is the owner's order, with the default prepended when unnamed", () => {
    const a = enabled({ [KEYS.openai]: "k", [LISTS.openai]: "gpt-6-astra, gpt-5.6-nova" });
    expect(a.models).toEqual(["gpt-5.6-terra", "gpt-6-astra", "gpt-5.6-nova"]);
  });

  it("a list naming the default keeps it where the owner put it, exactly once", () => {
    const a = enabled({ [KEYS.openai]: "k", [LISTS.openai]: "gpt-6-astra,gpt-5.6-terra" });
    expect(a.models).toEqual(["gpt-6-astra", "gpt-5.6-terra"]);
  });

  it("a list repeating an identity carries it once, in its first position", () => {
    const a = enabled({ [KEYS.openai]: "k", [LISTS.openai]: "gpt-6-astra, gpt-5.6-terra, gpt-6-astra, gpt-5.6-terra" });
    expect(a.models).toEqual(["gpt-6-astra", "gpt-5.6-terra"]);
  });

  it("blanks and stray separators are not identities", () => {
    const a = enabled({ [KEYS.openai]: "k", [LISTS.openai]: " , gpt-6-astra ,, " });
    expect(a.models).toEqual(["gpt-5.6-terra", "gpt-6-astra"]);
    expect(enabled({ [KEYS.openai]: "k", [LISTS.openai]: "   " }).models).toEqual(["gpt-5.6-terra"]);
  });

  it("the overridden default is the one that must be present once", () => {
    const a = enabled({ [KEYS.openai]: "k", DEZFIL_AI_MODEL: "gpt-6-astra", [LISTS.openai]: "gpt-5.6-terra" });
    expect(a.model).toBe("gpt-6-astra");
    expect(a.models).toEqual(["gpt-6-astra", "gpt-5.6-terra"]);
  });

  it("a list under the unresolved provider is inert, with each provider resolved in turn", () => {
    // OpenAI resolved, a list sitting under Anthropic.
    const openai = enabled({ [KEYS.openai]: "k", [LISTS.anthropic]: "claude-opus-5, claude-sonnet-5" });
    expect(openai.provider).toBe("openai");
    expect(openai.models).toEqual(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-nova"]);
    // Anthropic resolved, a list sitting under OpenAI.
    const anthropic = enabled({ [KEYS.anthropic]: "k", [LISTS.openai]: "gpt-6-astra, gpt-5.6-nova" });
    expect(anthropic.provider).toBe("anthropic");
    expect(anthropic.models).toEqual(["claude-opus-5", "claude-fable-5", "claude-sonnet-5", "claude-haiku-4"]);
    // Both keys present with the provider forced: only the forced one's list.
    const forced = enabled({ [KEYS.openai]: "k", [KEYS.anthropic]: "k", DEZFIL_AI_PROVIDER: "anthropic", [LISTS.openai]: "gpt-6-astra", [LISTS.anthropic]: "claude-sonnet-5" });
    expect(forced.models).toEqual(["claude-opus-5", "claude-sonnet-5"]);
  });

  it("the disabled shape and its explanations are unchanged, and no list enables anything", () => {
    const none = assistantAvailability({ [LISTS.openai]: "gpt-6-astra" });
    expect(none.enabled).toBe(false);
    if (!none.enabled) {
      expect(Object.keys(none).sort()).toEqual(["enabled", "reason"]);
      expect(none.reason).toBe(
        "No model credential is configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY " +
        "(optionally DEZFIL_AI_PROVIDER and DEZFIL_AI_MODEL) and restart to enable the assistant.",
      );
    }
    const missing = assistantAvailability({ DEZFIL_AI_PROVIDER: "anthropic", [KEYS.openai]: "k" });
    expect(missing.enabled).toBe(false);
    if (!missing.enabled) expect(missing.reason).toContain("DEZFIL_AI_PROVIDER is \"anthropic\" but ANTHROPIC_API_KEY is not set.");
    const unknown = assistantAvailability({ DEZFIL_AI_PROVIDER: "llama", [LISTS.openai]: "gpt-6-astra" });
    expect(unknown.enabled).toBe(false);
    if (!unknown.enabled) expect(unknown.reason).toContain("Supported providers are anthropic and openai.");
  });

  it("the read touches no network and constructs nothing: process.env is its only input", () => {
    // Called with an explicit environment and no fetch available at all.
    const saved = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = () => { throw new Error("the availability read reached the network"); };
    try {
      expect(enabled({ [KEYS.openai]: "k", [LISTS.openai]: "gpt-6-astra" }).models).toEqual(["gpt-5.6-terra", "gpt-6-astra"]);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = saved;
    }
  });
});

for (const [provider, defaultModel, known, order] of [
  ["openai", "gpt-5.6-terra", "gpt-6-astra", ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-nova"]],
  ["anthropic", "claude-opus-5", "claude-sonnet-5", ["claude-opus-5", "claude-fable-5", "claude-sonnet-5", "claude-haiku-4"]],
] as const) {
  it(`${provider}: known and unknown defaults occur once without a list`, () => {
    expect(enabled({ [KEYS[provider]]: "fixture-never-sent", DEZFIL_AI_MODEL: known }).models).toEqual(order);
    expect(enabled({ [KEYS[provider]]: "fixture-never-sent", DEZFIL_AI_MODEL: "unknown" }).models).toEqual(["unknown", ...order]);
  });
  it(`${provider}: explicit list ordering, duplicates, unknowns, blanks and default-only remain unchanged`, () => {
    for (const [list, expected] of [
      [` ${known}, ${defaultModel},${known},new, `, [...new Set([known, defaultModel, "new"])]],
      ["new", [defaultModel, "new"]], ["", [defaultModel]], [" , , ", [defaultModel]], [defaultModel, [defaultModel]],
    ] as [string, string[]][]) {
      expect(enabled({ [KEYS[provider]]: "fixture-never-sent", [LISTS[provider]]: list }).models).toEqual(expected);
    }
  });
}
