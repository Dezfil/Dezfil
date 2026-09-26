import shipped from "./model-catalogue.json";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROVIDER_DEFAULT_EFFORT, describeModel } from "./model-knowledge";

/**
 * What Dezfil knows about a model it may be asked to send to ('s ` `/` `):
 * a display name, the effort levels **that model** offers in its
 * provider's own words, and the explicit provider-default entry.
 *
 * The expectations are written out here rather than read from the table
 * under test, so the two can disagree. The provider vocabularies they are
 * drawn from are the installed SDKs' own: OpenAI's `ReasoningEffort`
 * (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`) and Anthropic's
 * `OutputConfig.effort` (`low`, `medium`, `high`, `xhigh`, `max`).
 */

const OPENAI_WORDS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const ANTHROPIC_WORDS = ["low", "medium", "high", "xhigh", "max"];

describe("what Dezfil knows about a model", () => {
  it("keeps the shipped JSON out of the client-safe presentation module", () => {
    const source = readFileSync(new URL("./model-knowledge.ts", import.meta.url), "utf8");
    expect(source).not.toContain("model-catalogue.json");
  });

  it("a known model reports its display name and its own levels, the provider-default entry first", () => {
    expect(describeModel("openai", "gpt-6-astra", shipped)).toEqual({
      id: "gpt-6-astra",
      name: "Astra",
      efforts: [
        { value: "default", label: "Default" },
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "XHigh" },
      ],
    });
    expect(describeModel("anthropic", "claude-opus-5", shipped)).toEqual({
      id: "claude-opus-5",
      name: "Opus 5",
      efforts: [
        { value: "default", label: "Default" },
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "XHigh" },
        { value: "max", label: "Max" },
      ],
    });
  });

  it("the levels belong to the model, not to the provider or the instance", () => {
    const words = (provider: string, id: string) => describeModel(provider, id, shipped).efforts.map((e) => e.value);
    // Two OpenAI models that do not offer the same set.
    expect(words("openai", "gpt-5.6-terra")).toEqual(["default", "minimal", "low", "medium", "high"]);
    expect(words("openai", "gpt-6-astra")).not.toContain("minimal");
    expect(words("openai", "gpt-5.6-terra")).not.toContain("xhigh");
    // And two Anthropic ones.
    expect(words("anthropic", "claude-sonnet-5")).toEqual(["default", "low", "medium", "high"]);
    expect(words("anthropic", "claude-sonnet-5")).not.toContain("max");
    expect(words("anthropic", "claude-opus-5")).toContain("max");
  });

  it("an identity with no display name reads as itself, and offers the provider default alone", () => {
    // Listing an identity grants permission to request it; it does not make
    // Dezfil know anything about it. What it does know of every model is
    // that sending no setting is honourable, so the explicit entry is there
    // and the model's own words are not.
    const entry = { value: "default", label: "Default" };
    expect(describeModel("openai", "gpt-7-unreleased", shipped)).toEqual({
      id: "gpt-7-unreleased",
      name: "gpt-7-unreleased",
      efforts: [entry],
    });
    expect(describeModel("anthropic", "claude-unknown", shipped).efforts).toEqual([entry]);
    // An unresolvable provider behaves the same way rather than throwing.
    expect(describeModel("llama", "claude-opus-5", shipped)).toEqual({
      id: "claude-opus-5",
      name: "claude-opus-5",
      efforts: [entry],
    });
    // No model anywhere offers nothing: an empty list would say a request
    // naming the default is unanswerable, which is never true.
    for (const provider of ["openai", "anthropic", "llama"]) {
      for (const id of ["gpt-6-astra", "claude-opus-5", "unheard-of"]) {
        expect(describeModel(provider, id, shipped).efforts[0], `${provider}/${id}`).toEqual(entry);
      }
    }
  });

  it("every offered word is its provider's own, and the default entry is present exactly once", () => {
    for (const [provider, id, vocabulary] of [
      ["openai", "gpt-6-astra", OPENAI_WORDS],
      ["openai", "gpt-5.6-terra", OPENAI_WORDS],
      ["openai", "gpt-5.6-sol", OPENAI_WORDS],
      ["anthropic", "claude-opus-5", ANTHROPIC_WORDS],
      ["anthropic", "claude-fable-5", ANTHROPIC_WORDS],
      ["anthropic", "claude-sonnet-5", ANTHROPIC_WORDS],
    ] as [string, string, string[]][]) {
      const values = describeModel(provider, id, shipped).efforts.map((e) => e.value);
      expect(values.filter((v) => v === PROVIDER_DEFAULT_EFFORT)).toEqual([PROVIDER_DEFAULT_EFFORT]);
      expect(values[0]).toBe(PROVIDER_DEFAULT_EFFORT);
      for (const value of values.slice(1)) expect(vocabulary).toContain(value);
      // No level word is invented for the default entry, and no word repeats.
      expect(new Set(values).size).toBe(values.length);
      // Every level carries a label a person can read, and no label is a dash.
      for (const effort of describeModel(provider, id, shipped).efforts) {
        expect(effort.label.trim()).not.toBe("");
        expect(effort.label).not.toMatch(/[—–]/);
      }
    }
  });

  it("the default entry is not a provider word, so it can never collide with one", () => {
    expect(OPENAI_WORDS).not.toContain(PROVIDER_DEFAULT_EFFORT);
    expect(ANTHROPIC_WORDS).not.toContain(PROVIDER_DEFAULT_EFFORT);
  });
});
