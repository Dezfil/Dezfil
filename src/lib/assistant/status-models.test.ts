import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as status } from "@/app/api/assistant/route";
import { limits } from "@/lib/limits";

/**
 * What the documented status read tells a client about the choices this
 * instance offers. It reports the default, the allowed list in the owner's
 * order, and for each model its display name and the effort levels that
 * model offers. A list configured under the provider this instance did not
 * resolve changes nothing it reports.
 *
 * The read holds no credential, constructs no client and reaches no
 * network, and that is checked here rather than assumed: both provider
 * SDKs are replaced by constructors that throw, `fetch` is replaced by a
 * throw, and the traps are shown to fire when touched — otherwise the
 * check would pass for a route that never had a way to fail.
 */

vi.mock("openai", () => ({ default: class { constructor() { throw new Error("the status read constructed an OpenAI client"); } } }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { constructor() { throw new Error("the status read constructed an Anthropic client"); } } }));

type Effort = { value: string; label: string };
type Reported = {
  enabled: boolean;
  reason?: string;
  provider?: string;
  model?: string;
  models?: { id: string; name: string; efforts: Effort[] }[];
  stepBudget?: number;
  autoCheck?: boolean;
};

const read = async (): Promise<Reported> => (await status()).json() as Promise<Reported>;

beforeEach(() => {
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEZFIL_AI_PROVIDER", "DEZFIL_AI_MODEL", "DEZFIL_AI_MODELS_OPENAI", "DEZFIL_AI_MODELS_ANTHROPIC"]) {
    vi.stubEnv(key, "");
    delete process.env[key];
  }
  vi.stubGlobal("fetch", () => { throw new Error("the status read reached the network"); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const DEFAULT_EFFORT = { value: "default", label: "Default" };

describe("the status read and the instance's choices", () => {
  it("reports the default, the list in the owner's order, and each model's own levels", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-never-sent");
    vi.stubEnv("DEZFIL_AI_MODELS_OPENAI", "gpt-6-astra, gpt-5.6-terra");
    const reported = await read();
    expect(reported.provider).toBe("openai");
    expect(reported.model).toBe("gpt-5.6-terra");
    expect(reported.models).toEqual([
      {
        id: "gpt-6-astra",
        name: "Astra",
        efforts: [DEFAULT_EFFORT, { value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }, { value: "xhigh", label: "XHigh" }],
      },
      {
        id: "gpt-5.6-terra",
        name: "Terra",
        efforts: [DEFAULT_EFFORT, { value: "minimal", label: "Minimal" }, { value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }],
      },
    ]);
    // The rest of the read is what it was.
    expect(reported.enabled).toBe(true);
    expect(reported.stepBudget).toBe(limits.assistantStepBudget);
    expect(reported.autoCheck).toBe(limits.assistantAutoCheck);
  });

  it("with no list it reports the existing default and the whole catalogue", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture-never-sent");
    const reported = await read();
    expect(reported.model).toBe("claude-opus-5");
    expect(reported.models?.map((m) => m.id)).toEqual(["claude-opus-5", "claude-fable-5", "claude-sonnet-5", "claude-haiku-4"]);
  });

  it("a list under the unresolved provider changes nothing it reports, either way round", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-never-sent");
    vi.stubEnv("DEZFIL_AI_MODELS_ANTHROPIC", "claude-opus-5, claude-sonnet-5");
    const onOpenAi = await read();
    expect(onOpenAi.models?.map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-nova"]);

    vi.stubEnv("OPENAI_API_KEY", "");
    delete process.env.OPENAI_API_KEY;
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture-never-sent");
    vi.stubEnv("DEZFIL_AI_MODELS_ANTHROPIC", "");
    delete process.env.DEZFIL_AI_MODELS_ANTHROPIC;
    vi.stubEnv("DEZFIL_AI_MODELS_OPENAI", "gpt-6-astra");
    const onAnthropic = await read();
    expect(onAnthropic.provider).toBe("anthropic");
    expect(onAnthropic.models?.map((m) => m.id)).toEqual(["claude-opus-5", "claude-fable-5", "claude-sonnet-5", "claude-haiku-4"]);
  });

  it("an identity Dezfil knows nothing about is reported as itself, offering the provider default alone", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-never-sent");
    vi.stubEnv("DEZFIL_AI_MODELS_OPENAI", "gpt-7-unreleased");
    const reported = await read();
    expect(reported.models).toEqual([
      { id: "gpt-5.6-terra", name: "Terra", efforts: [DEFAULT_EFFORT, { value: "minimal", label: "Minimal" }, { value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }] },
      { id: "gpt-7-unreleased", name: "gpt-7-unreleased", efforts: [DEFAULT_EFFORT] },
    ]);
    // The read is the contract: every model it reports offers at least the
    // one entry a request may always name.
    // The fallback is a failing row, not an empty list: a read that reported
    // no models at all must not satisfy a walk over its models.
    for (const model of reported.models ?? [{ id: "the read reported no models", efforts: [] }]) {
      expect(model.efforts.length, model.id).toBeGreaterThan(0);
    }
  });

  it("the disabled read keeps its exact shape and explanation, and offers nothing", async () => {
    vi.stubEnv("DEZFIL_AI_MODELS_OPENAI", "gpt-6-astra");
    const reported = await read();
    expect(Object.keys(reported).sort()).toEqual(["enabled", "reason"]);
    expect(reported.enabled).toBe(false);
    expect(reported.reason).toBe(
      "No model credential is configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY " +
      "(optionally DEZFIL_AI_PROVIDER and DEZFIL_AI_MODEL) and restart to enable the assistant.",
    );
  });

  it("the traps this file relies on do fire when they are touched", async () => {
    // Without this the four reads above would pass for a route that could
    // not have failed them.
    const openai = (await import("openai")).default;
    const anthropic = (await import("@anthropic-ai/sdk")).default;
    expect(() => new openai()).toThrow("constructed an OpenAI client");
    expect(() => new anthropic()).toThrow("constructed an Anthropic client");
    expect(() => fetch("https://api.openai.com/v1/models")).toThrow("reached the network");
  });
});
