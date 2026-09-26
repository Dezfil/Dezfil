import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resolveChoice } from "./choice";
import type { ProviderChoice } from "./factory";
import { PROVIDER_DEFAULT_EFFORT } from "./model-knowledge";
import { assistantRuns } from "./runs";
import { stubProvider } from "./providers/stub";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";

/**
 * The optional choice on a message request and its resolution rules ('s
 * resolution half): an omitted model is the instance default, an omitted
 * effort is the model's provider-default entry, an empty choice is an
 * omission, and the resolved pair is what the adapter is built for.
 *
 * Three links are checked separately, because a green on one proves
 * nothing about the others: the resolution itself, the route handing the
 * resolved pair on, and the factory building an adapter for it. What the
 * pair then does on the wire is `effort-wire.test.ts`.
 */

const DEFAULT = "gpt-5.6-terra";
const defaulted = (model: boolean, effort: boolean) => ({ model, effort });

describe("resolving a request's choice", () => {
  it("no choice at all resolves to the instance default and the provider-default entry", () => {
    for (const raw of [undefined, null, {}]) {
      expect(resolveChoice(raw, DEFAULT)).toEqual({ model: DEFAULT, effort: PROVIDER_DEFAULT_EFFORT, defaulted: defaulted(true, true) });
    }
  });

  it("an empty choice is an omission, field by field", () => {
    expect(resolveChoice({ model: "", effort: "" }, DEFAULT)).toEqual({ model: DEFAULT, effort: PROVIDER_DEFAULT_EFFORT, defaulted: defaulted(true, true) });
    expect(resolveChoice({ model: "   ", effort: "\t" }, DEFAULT)).toEqual({ model: DEFAULT, effort: PROVIDER_DEFAULT_EFFORT, defaulted: defaulted(true, true) });
    // An empty choice is an omission; a malformed one is a refusal, not a
    // quiet omission — that case is choice-refusals.test.ts.
  });

  it("a model alone, an effort alone and both together each resolve as asked", () => {
    expect(resolveChoice({ model: "gpt-6-astra" }, DEFAULT)).toEqual({ model: "gpt-6-astra", effort: PROVIDER_DEFAULT_EFFORT, defaulted: defaulted(false, true) });
    expect(resolveChoice({ effort: "high" }, DEFAULT)).toEqual({ model: DEFAULT, effort: "high", defaulted: defaulted(true, false) });
    expect(resolveChoice({ model: "gpt-6-astra", effort: "xhigh" }, DEFAULT)).toEqual({ model: "gpt-6-astra", effort: "xhigh", defaulted: defaulted(false, false) });
    // Surrounding space is not part of an identity.
    expect(resolveChoice({ model: " gpt-6-astra ", effort: " xhigh " }, DEFAULT)).toEqual({ model: "gpt-6-astra", effort: "xhigh", defaulted: defaulted(false, false) });
  });

  it("the explicit provider-default entry is a choice a person can make, and reads as chosen", () => {
    expect(resolveChoice({ effort: PROVIDER_DEFAULT_EFFORT }, DEFAULT)).toEqual({ model: DEFAULT, effort: PROVIDER_DEFAULT_EFFORT, defaulted: defaulted(true, false) });
  });
});

describe("the factory builds the adapter for the resolved pair", () => {
  const env = { OPENAI_API_KEY: "fixture-never-sent", DEZFIL_AI_MODELS_OPENAI: "gpt-6-astra" };
  // The real factory, not the recording stand-in the route block installs
  // below: this block is about what the factory itself builds.
  it("the pair reaches the adapter object, and no pair leaves today's behavior", async () => {
    const { createProvider } = await vi.importActual<typeof import("./factory")>("./factory");
    expect(createProvider({ model: "gpt-6-astra", effort: "xhigh" }, env)).toMatchObject({ id: "openai", model: "gpt-6-astra", effort: "xhigh" });
    expect(createProvider({}, env)).toMatchObject({ id: "openai", model: DEFAULT, effort: undefined });
    expect(createProvider(undefined, env)).toMatchObject({ id: "openai", model: DEFAULT, effort: undefined });
    const anthropic = createProvider({ model: "claude-sonnet-5", effort: "high" }, { ANTHROPIC_API_KEY: "fixture-never-sent" });
    expect(anthropic).toMatchObject({ id: "anthropic", model: "claude-sonnet-5", effort: "high" });
    expect(createProvider({ model: "gpt-6-astra" }, {})).toBeNull();
  });
});

const origin = "http://127.0.0.1:3212";
const factory = vi.hoisted(() => ({ choice: undefined as ProviderChoice | undefined, calls: 0 }));
vi.mock("@/lib/assistant/factory", async (importOriginal) => {
  const real = await importOriginal<typeof import("./factory")>();
  return {
    ...real,
    createProvider: (choice?: ProviderChoice) => {
      factory.calls += 1;
      factory.choice = choice;
      return stubProvider([{ text: "Done.", toolCalls: [] }]);
    },
  };
});

describe("the route hands the resolved pair to the factory", () => {
  let dir: string;
  beforeEach(async () => {
    await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
    dir = await mkdtemp(path.join(process.cwd(), ".tmp-choice-"));
    vi.stubEnv("DEZFIL_DATA_DIR", dir);
    vi.stubEnv("PORT", "3212");
    vi.stubEnv("OPENAI_API_KEY", "fixture-never-sent");
    vi.stubEnv("DEZFIL_AI_PROVIDER", "openai");
    vi.stubEnv("DEZFIL_AI_MODELS_OPENAI", "gpt-6-astra");
    closeMetadataDb(); assistantRuns.resetForTests();
    // The instance's own loopback reads (grounding) answer from the shipped
    // routes; nothing in this file reaches a provider or the network.
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => dispatchAssistantTestRoute(input instanceof Request ? input : new Request(String(input), init)));
    factory.choice = undefined; factory.calls = 0;
  });
  afterEach(async () => { closeMetadataDb(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

  async function submit(choice?: unknown): Promise<void> {
    const reserved = await (await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/runs`, { method: "POST" }))).json() as { id: string };
    const response = await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: reserved.id, message: "Colour the parks.", history: [], ...(choice === undefined ? {} : { choice }) }),
    }));
    await response.text();
  }

  it("a chosen pair arrives at the factory as the person asked for it", async () => {
    await submit({ model: "gpt-6-astra", effort: "xhigh" });
    expect(factory.calls).toBe(1);
    expect(factory.choice).toEqual({ model: "gpt-6-astra", effort: "xhigh" });
  });

  it("no choice arrives as the instance default and the provider-default entry", async () => {
    await submit();
    expect(factory.choice).toEqual({ model: DEFAULT, effort: PROVIDER_DEFAULT_EFFORT });
  });

  it("an empty choice arrives exactly as an omitted one does", async () => {
    await submit({});
    const empty = factory.choice;
    await submit({ model: "", effort: "" });
    expect(factory.choice).toEqual(empty);
    expect(factory.choice).toEqual({ model: DEFAULT, effort: PROVIDER_DEFAULT_EFFORT });
  });

  it("an effort alone keeps the instance default model", async () => {
    await submit({ effort: "minimal" });
    expect(factory.choice).toEqual({ model: DEFAULT, effort: "minimal" });
  });
});
