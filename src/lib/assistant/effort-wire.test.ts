import { describe, expect, it } from "vitest";
import { captureAnthropicRequest, captureOpenAiRequest, frozen, sha256 } from "./testing/frozen-baselines";

/**
 * How a chosen level becomes each provider's own request field ('s).
 *
 * The expected field is written out here, per provider, independently of
 * the model-knowledge table — otherwise the table and the mapping would be
 * checked against each other. Each case compares the **whole** serialized
 * body the adapter hands its SDK against the baseline task 1 froze before
 * any product change, with the one expected field added: that is what
 * establishes that every unrelated field survives, Anthropic's adaptive
 * thinking included, rather than only that the new field arrived.
 */

const OPENAI_BASE = frozen<Record<string, unknown>>("openai-request.json");
const ANTHROPIC_BASE = frozen<Record<string, unknown>>("anthropic-request.json");

/** The expected request field for a level, written out per provider. */
const openaiField = (effort: string) => ({ reasoning: { effort } });
const anthropicField = (effort: string) => ({ output_config: { effort } });

describe("the chosen level on the wire", () => {
  it("OpenAI: no choice at all is byte identical to the pre-change capture", async () => {
    const body = await captureOpenAiRequest();
    expect(body).toEqual(OPENAI_BASE);
    expect(body).not.toHaveProperty("reasoning");
    // The comparison can fail: one character on the current side breaks it.
    expect(sha256(JSON.stringify({ ...body, model: `${String(body.model)}x` }))).not.toBe(sha256(JSON.stringify(OPENAI_BASE)));
  });

  it("Anthropic: no choice at all is byte identical to the pre-change capture", async () => {
    const body = await captureAnthropicRequest();
    expect(body).toEqual(ANTHROPIC_BASE);
    expect(body).not.toHaveProperty("output_config");
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(sha256(JSON.stringify({ ...body, model: `${String(body.model)}x` }))).not.toBe(sha256(JSON.stringify(ANTHROPIC_BASE)));
  });

  it("the provider-default entry and an empty effort both send nothing, on both adapters", async () => {
    for (const effort of ["default", ""]) {
      expect(await captureOpenAiRequest({ effort })).toEqual(OPENAI_BASE);
      expect(await captureAnthropicRequest({ effort })).toEqual(ANTHROPIC_BASE);
    }
  });

  it("OpenAI: every level it takes arrives in reasoning.effort, with nothing else moved", async () => {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh"]) {
      expect(await captureOpenAiRequest({ effort })).toEqual({ ...OPENAI_BASE, ...openaiField(effort) });
    }
  });

  it("Anthropic: every level it takes arrives in output_config.effort, adaptive thinking untouched", async () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      const body = await captureAnthropicRequest({ effort });
      expect(body).toEqual({ ...ANTHROPIC_BASE, ...anthropicField(effort) });
      expect(body.thinking).toEqual({ type: "adaptive" });
    }
  });

  it("a model without an effort moves only the model, and a combined choice moves exactly two fields", async () => {
    expect(await captureOpenAiRequest({ model: "gpt-6-astra" })).toEqual({ ...OPENAI_BASE, model: "gpt-6-astra" });
    expect(await captureOpenAiRequest({ model: "gpt-6-astra", effort: "xhigh" })).toEqual({ ...OPENAI_BASE, model: "gpt-6-astra", ...openaiField("xhigh") });
    expect(await captureAnthropicRequest({ model: "claude-sonnet-5" })).toEqual({ ...ANTHROPIC_BASE, model: "claude-sonnet-5" });
    expect(await captureAnthropicRequest({ model: "claude-sonnet-5", effort: "high" })).toEqual({ ...ANTHROPIC_BASE, model: "claude-sonnet-5", ...anthropicField("high") });
  });
});
