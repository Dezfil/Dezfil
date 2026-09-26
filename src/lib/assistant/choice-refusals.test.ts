import shipped from "./model-catalogue.json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { ApiError } from "@/lib/api/errors";
import { describeModel } from "./model-knowledge";
import { chooseForRequest } from "./choice";
import { openaiProvider } from "./providers/openai";
import { ProviderError } from "./provider";
import { assistantRuns } from "./runs";
import { stubProvider } from "./providers/stub";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";

/**
 * The four refusals: a malformed choice, an unlisted model, an effort the
 * selected model does not offer, and an effort for a model that offers
 * none. Each carries its own documented code, and each is raised before
 * the provider is built, before any product operation and before a step is
 * spent.
 *
 * Distinguishable is checked as four distinct codes, not four failures —
 * an assertion that they all fail would pass for one code used four times.
 * And a provider's own rejection of a listed identity is exercised
 * separately: it stays a provider failure, not a refusal of ours.
 */

const instance = { provider: "openai", model: "gpt-5.6-terra", models: ["gpt-5.6-terra", "gpt-6-astra", "gpt-7-unreleased"], knowledge: shipped };
const codeOf = (fn: () => unknown): { code: string; message: string; status: number } => {
  try { fn(); } catch (error) {
    if (error instanceof ApiError) return { code: error.code, message: error.message, status: error.status };
    throw error;
  }
  throw new Error("expected a refusal, got none");
};

describe("the four refusals, each its own", () => {
  it("a malformed choice is refused rather than quietly dropped", () => {
    for (const raw of ["gpt-6-astra", 7, true, ["gpt-6-astra"], { model: 5 }, { effort: false }, { model: "gpt-6-astra", reasoning: "high" }]) {
      expect(codeOf(() => chooseForRequest(raw, instance)).code).toBe("assistant_choice_invalid");
    }
  });

  it("a model this instance does not offer is refused, and the refusal says what is offered", () => {
    const refusal = codeOf(() => chooseForRequest({ model: "gpt-6-nonesuch" }, instance));
    expect(refusal.code).toBe("assistant_model_not_offered");
    expect(refusal.message).toContain("gpt-6-nonesuch");
    expect(refusal.message).toContain("gpt-5.6-terra, gpt-6-astra, gpt-7-unreleased");
    expect(refusal.message).toContain("GET /api/assistant");
  });

  it("an effort the selected model does not offer is refused, though another model offers it", () => {
    // Astra offers xhigh; Terra does not. The levels are the model's.
    expect(chooseForRequest({ model: "gpt-6-astra", effort: "xhigh" }, instance)).toMatchObject({ model: "gpt-6-astra", effort: "xhigh" });
    const refusal = codeOf(() => chooseForRequest({ model: "gpt-5.6-terra", effort: "xhigh" }, instance));
    expect(refusal.code).toBe("assistant_effort_not_offered");
    expect(refusal.message).toContain("xhigh");
    expect(refusal.message).toContain("minimal, low, medium, high");
  });

  it("a named effort for a model that offers no levels is refused as that, and says what it does take", () => {
    const refusal = codeOf(() => chooseForRequest({ model: "gpt-7-unreleased", effort: "low" }, instance));
    expect(refusal.code).toBe("assistant_effort_not_supported");
    expect(refusal.message).toContain("gpt-7-unreleased");
    // The message names the one thing that model does accept, so an agent
    // reading the refusal does not have to guess (the phase rule).
    expect(refusal.message).toContain("\"default\"");
  });

  it("the provider-default entry is accepted on a model that offers no levels, and resolves as the model alone does", () => {
    // Every allowed model offers the explicit entry, because a request
    // naming it is exactly the no-choice request; a *named level* is what a
    // level-less model refuses. The two differ only in who chose, which is
    // what `defaulted` records.
    const chosen = chooseForRequest({ model: "gpt-7-unreleased", effort: "default" }, instance);
    const alone = chooseForRequest({ model: "gpt-7-unreleased" }, instance);
    expect(chosen.model).toBe(alone.model);
    expect(chosen.effort).toBe(alone.effort);
    expect(chosen).toEqual({ model: "gpt-7-unreleased", effort: "default", defaulted: { model: false, effort: false } });
    expect(alone).toEqual({ model: "gpt-7-unreleased", effort: "default", defaulted: { model: false, effort: true } });
  });

  it("the reported list is exactly the accepted set, model by model", () => {
    // The two halves meet here: whatever the status read offers for a model
    // is accepted for that model, and nothing it does not offer is.
    for (const id of instance.models) {
      const offered = describeModel(instance.provider, id, shipped).efforts.map((level) => level.value);
      expect(offered, `${id} offers nothing at all`).not.toHaveLength(0);
      for (const effort of offered) {
        expect(chooseForRequest({ model: id, effort }, instance).effort, `${id} at ${effort}`).toBe(effort);
      }
      expect(() => chooseForRequest({ model: id, effort: "nonesuch" }, instance)).toThrow();
    }
  });

  it("the four are four, and each is a 400", () => {
    const codes = [
      codeOf(() => chooseForRequest("nonsense", instance)),
      codeOf(() => chooseForRequest({ model: "gpt-6-nonesuch" }, instance)),
      codeOf(() => chooseForRequest({ model: "gpt-5.6-terra", effort: "xhigh" }, instance)),
      codeOf(() => chooseForRequest({ model: "gpt-7-unreleased", effort: "low" }, instance)),
    ];
    expect(new Set(codes.map((c) => c.code)).size).toBe(4);
    for (const refusal of codes) expect(refusal.status).toBe(400);
  });
});

describe("a provider's own rejection of a listed identity", () => {
  it("surfaces as a provider failure, in the provider's words, not as one of ours", async () => {
    // Listing an identity grants permission to request it; it does not
    // prove the provider has it.
    expect(() => chooseForRequest({ model: "gpt-7-unreleased" }, instance)).not.toThrow();
    const refusing = async () => Response.json({ error: { message: "The model `gpt-7-unreleased` does not exist.", type: "invalid_request_error" } }, { status: 404 });
    const exchange = openaiProvider("fixture-never-sent", "gpt-7-unreleased", refusing).exchange({ system: "sys", tools: [], history: [] });
    const failure = await exchange.send("Work").then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).kind).toBe("provider");
    expect((failure as ProviderError).message).toContain("does not exist");
    // And it is not any of the four: those are ours, and carry API codes.
    expect(failure).not.toBeInstanceOf(ApiError);
  });
});

const origin = "http://127.0.0.1:3213";
const factory = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/assistant/factory", async (importOriginal) => {
  const real = await importOriginal<typeof import("./factory")>();
  return { ...real, createProvider: () => { factory.calls += 1; return stubProvider([{ text: "Done.", toolCalls: [] }]); } };
});

describe("a refusal costs nothing", () => {
  let dir: string;
  let loopback = 0;
  beforeEach(async () => {
    await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
    dir = await mkdtemp(path.join(process.cwd(), ".tmp-refuse-"));
    vi.stubEnv("DEZFIL_DATA_DIR", dir);
    vi.stubEnv("PORT", "3213");
    vi.stubEnv("OPENAI_API_KEY", "fixture-never-sent");
    vi.stubEnv("DEZFIL_AI_PROVIDER", "openai");
    vi.stubEnv("DEZFIL_AI_MODELS_OPENAI", "gpt-6-astra, gpt-7-unreleased");
    closeMetadataDb(); assistantRuns.resetForTests();
    factory.calls = 0; loopback = 0;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      loopback += 1;
      return dispatchAssistantTestRoute(input instanceof Request ? input : new Request(String(input), init));
    });
  });
  afterEach(async () => { closeMetadataDb(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

  const reserve = async () => (await (await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/runs`, { method: "POST" }))).json() as { id: string }).id;
  const send = (runId: string, choice: unknown) => dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/messages`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId, message: "Colour the parks.", history: [], choice }),
  }));
  const readRun = async (runId: string) => await (await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/runs/${runId}`))).json() as { state: string };

  for (const [name, choice, code] of [
    ["malformed", "gpt-6-astra", "assistant_choice_invalid"],
    ["an unlisted model", { model: "gpt-5.6-sol" }, "assistant_model_not_offered"],
    ["an effort the model does not offer", { model: "gpt-6-astra", effort: "minimal" }, "assistant_effort_not_offered"],
    ["an effort for a model with none", { model: "gpt-7-unreleased", effort: "low" }, "assistant_effort_not_supported"],
  ] as [string, unknown, string][]) {
    it(`${name} is refused through the documented route before anything is spent`, async () => {
      const runId = await reserve();
      const before = loopback;
      const response = await send(runId, choice);
      expect(response.status).toBe(400);
      expect((await response.json() as { error: { code: string } }).error.code).toBe(code);
      // No provider was built, so none was called.
      expect(factory.calls).toBe(0);
      // No product operation and no grounding read happened either.
      expect(loopback).toBe(before);
      // And the reservation is untouched: nothing ran, nothing was spent.
      expect((await readRun(runId)).state).toBe("reserved");
    });
  }

  it("the same reservation still accepts an allowed choice, which does reach the provider", async () => {
    const runId = await reserve();
    expect((await send(runId, { model: "gpt-6-astra", effort: "high" })).status).toBe(200);
    expect(factory.calls).toBe(1);
  });
});
