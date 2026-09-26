import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { allMaps, createMap } from "@/lib/map-service";
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import type { ProviderChoice } from "./factory";
import { assistantRuns } from "./runs";
import { pendingActions } from "./pending";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";
import { outputCall, outputText, responseWire } from "./testing/wire";

/**
 * page action policy under a chosen model. A choice is a model setting
 * and nothing else: it widens no page's permission, and a run that parked
 * on the builder keeps the policy it bound with however the person
 * reaches its confirmation.
 *
 * Exercised at the documented route, the two read-only pages separately,
 * with the product's own dispatches counted: a refusal that never reached
 * an operation is the claim, and the counter is shown able to see one by
 * the approved case, which does reach it.
 */

const origin = "http://127.0.0.1:3217";
const CHOICE = { model: "gpt-6-astra", effort: "xhigh" } as const;
const BOUND = { model: "gpt-6-astra", effort: "xhigh" };

type Sent = Record<string, unknown>;
const wire = vi.hoisted(() => ({ sent: [] as Sent[], script: [] as (() => Response)[], dispatched: [] as string[] }));

vi.mock("@/lib/assistant/factory", async () => {
  const { openaiProvider: adapter } = await import("./providers/openai");
  return {
    createProvider: (choice: ProviderChoice = {}) => {
      const fetchImpl: typeof fetch = async (_input, init) => {
        wire.sent.push(JSON.parse(String(init?.body)) as Sent);
        const next = wire.script.shift();
        return next ? next() : responseWire([outputText("Done.")], "gpt-6-astra");
      };
      return adapter("fixture-never-sent", choice.model ?? "gpt-5.6-terra", fetchImpl, choice.effort);
    },
  };
});

let dir: string;
let mapId: string;
let recipeId: string;
let stepId: string;
beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-policy-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  vi.stubEnv("PORT", "3217");
  vi.stubEnv("OPENAI_API_KEY", "fixture-never-sent");
  vi.stubEnv("DEZFIL_AI_PROVIDER", "openai");
  vi.stubEnv("DEZFIL_AI_MODELS_OPENAI", "gpt-6-astra");
  // This file is about the policy, not the map check: a scheduled check
  // would add an action and a request that say nothing about either.
  vi.stubEnv("DEZFIL_ASSISTANT_AUTO_CHECK", "0");
  closeMetadataDb(); resetQueryInstance(); assistantRuns.resetForTests(); pendingActions.resetForTests();
  wire.sent.length = 0; wire.script.length = 0; wire.dispatched.length = 0;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    wire.dispatched.push(`${request.method} ${new URL(request.url).pathname}`);
    return dispatchAssistantTestRoute(request);
  });
  mapId = createMap("Policy").id;
  const recipe = createRecipe("Workflow");
  recipeId = recipe.id;
  stepId = addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT 1 AS value", name: "output" } }).id;
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

type Event = { type: string; tool?: string; ok?: boolean; outcome?: string; decision?: string; body?: { error?: { code?: string } }; id?: string };
type Receipt = { actions: { tool: string; status: string; decision?: string }[]; provenance?: { requested?: { model: string; effort: string } } };

const reserve = async () => (await (await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/runs`, { method: "POST" }))).json() as { id: string }).id;
const post = (body: Record<string, unknown>) => dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/messages`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));
const read = async (runId: string) => await (await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/runs/${runId}`))).json() as Receipt;
const events = (text: string): Event[] => text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Event);
/** Every provider request's identity and effort, as serialized. */
const pairs = () => wire.sent.map((body) => ({ model: body.model, effort: (body.reasoning as { effort?: string } | undefined)?.effort }));
/** What the product itself was asked to do, the assistant's own routes apart. */
const productWork = () => wire.dispatched.filter((call) => !call.includes("/api/assistant"));

const sqlPage = () => ({ page: "sql", draft: "SELECT 1;", selection: null, lastExecution: null });
const workflowPage = () => ({ page: "workflow", recipeId, selectedStepId: stepId, lastRunId: null });
const builderPage = () => ({ page: "builder", mapId, selectedLayerId: null });

/** One turn under a read-only page whose model tries to create a map. */
async function refusedOn(context: Record<string, unknown>) {
  wire.script.push(
    () => responseWire([outputCall("call-1", "create_map", JSON.stringify({ name: "Not allowed" }))], "gpt-6-astra"),
    () => responseWire([outputText("I cannot do that here.")], "gpt-6-astra"),
  );
  const runId = await reserve();
  const before = allMaps().length;
  const stream = events(await (await post({ runId, message: "Make a map.", history: [], choice: CHOICE, context })).text());
  const result = stream.find((event) => event.type === "tool_result");
  return { runId, result, maps: { before, after: allMaps().length }, receipt: await read(runId) };
}

describe("a chosen model widens no page's policy", () => {
  it("the sql page stays read-only under a nondefault choice", async () => {
    const { result, maps, receipt } = await refusedOn(sqlPage());
    expect({
      refusal: result?.body?.error?.code,
      outcome: result?.outcome,
      recorded: receipt.actions.map((action) => `${action.tool}:${action.status}`),
      productWork: productWork(),
      maps,
    }).toEqual({
      refusal: "assistant_action_not_admitted",
      outcome: "refused",
      recorded: ["create_map:refused"],
      // The refusal never reached an operation: the only reads are the
      // grounding the turn loads, and no map was made.
      productWork: ["GET /api/catalogue/tables"],
      maps: { before: 1, after: 1 },
    });
    // And the run was sent to the chosen model both times all the same.
    expect(pairs()).toEqual([BOUND, BOUND]);
  });

  it("the workflow page stays read-only under a nondefault choice", async () => {
    const { result, maps, receipt } = await refusedOn(workflowPage());
    expect({
      refusal: result?.body?.error?.code,
      outcome: result?.outcome,
      recorded: receipt.actions.map((action) => `${action.tool}:${action.status}`),
      productWork: productWork(),
      maps,
    }).toEqual({
      refusal: "assistant_action_not_admitted",
      outcome: "refused",
      recorded: ["create_map:refused"],
      // The turn's own grounding reads, and nothing else: no write reached
      // an operation.
      productWork: [`GET /api/recipes/${recipeId}`, "GET /api/catalogue/tables"],
      maps: { before: 1, after: 1 },
    });
    expect(pairs()).toEqual([BOUND, BOUND]);
  });
});

/** A builder run parked at a publishing confirmation, then resolved by a
 * client that says it is somewhere else and wants something else. The
 * continuation calls a second write, which is where a policy taken from
 * the resolving page instead of the parked run would show: the approved
 * call itself was admitted when it parked and no longer asks. */
async function resolvedFrom(context: Record<string, unknown>) {
  wire.script.push(
    () => responseWire([outputCall("call-publish", "publish_map", JSON.stringify({ id: mapId }))], "gpt-6-astra"),
    () => responseWire([outputCall("call-rename", "update_map", JSON.stringify({ id: mapId, name: "Renamed after the gate" }))], "gpt-6-astra"),
    () => responseWire([outputText("Published and renamed.")], "gpt-6-astra"),
  );
  const runId = await reserve();
  await (await post({ runId, message: "Publish it.", history: [], choice: CHOICE, context: builderPage() })).text();
  const open = (await (await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/pending`))).json() as { pending: { id: string; runId: string }[] }).pending.find((entry) => entry.runId === runId);
  expect(open).toBeDefined();
  const dispatchedBefore = productWork().length;
  // The resolving client names the read-only page it is on and a different
  // model. Both are ignored input: neither can reach the parked run.
  const stream = events(await (await post({ resolution: { pending: open!.id, approved: true }, context, choice: { model: "gpt-5.6-terra", effort: "low" } })).text());
  const result = stream.find((event) => event.type === "tool_result" && event.tool === "publish_map");
  const after = stream.find((event) => event.type === "tool_result" && event.tool === "update_map");
  return { runId, result, after, dispatchedBefore, receipt: await read(runId) };
}

describe("a builder confirmation resolved from a read-only page", () => {
  it("keeps its own policy and its bound choice when the client is on sql", async () => {
    const { result, after, dispatchedBefore, receipt } = await resolvedFrom(sqlPage());
    expect({
      refused: result?.body?.error?.code,
      decision: result?.decision,
      // The write the continuation made: admitted by the run's own policy,
      // refused outright by the resolving page's.
      continued: `${after?.tool}:${after?.outcome}:${after?.body?.error?.code}`,
      recorded: receipt.actions.map((action) => `${action.tool}:${action.status}`),
      // The publish actually reached the product, which a read-only policy
      // would have refused before any dispatch.
      published: productWork().slice(dispatchedBefore).some((call) => call.startsWith("POST /api/maps/")),
      requested: receipt.provenance?.requested,
    }).toEqual({
      refused: undefined,
      decision: "approved",
      continued: "update_map:succeeded:undefined",
      recorded: ["publish_map:succeeded", "update_map:succeeded"],
      published: true,
      requested: { model: "gpt-6-astra", effort: "xhigh", defaulted: { model: false, effort: false } },
    });
    expect(pairs()).toEqual([BOUND, BOUND, BOUND]);
  });

  it("keeps its own policy and its bound choice when the client is on a workflow", async () => {
    const { result, after, dispatchedBefore, receipt } = await resolvedFrom(workflowPage());
    expect({
      refused: result?.body?.error?.code,
      decision: result?.decision,
      // The write the continuation made: admitted by the run's own policy,
      // refused outright by the resolving page's.
      continued: `${after?.tool}:${after?.outcome}:${after?.body?.error?.code}`,
      recorded: receipt.actions.map((action) => `${action.tool}:${action.status}`),
      published: productWork().slice(dispatchedBefore).some((call) => call.startsWith("POST /api/maps/")),
      requested: receipt.provenance?.requested,
    }).toEqual({
      refused: undefined,
      decision: "approved",
      continued: "update_map:succeeded:undefined",
      recorded: ["publish_map:succeeded", "update_map:succeeded"],
      published: true,
      requested: { model: "gpt-6-astra", effort: "xhigh", defaulted: { model: false, effort: false } },
    });
    expect(pairs()).toEqual([BOUND, BOUND, BOUND]);
  });
});
