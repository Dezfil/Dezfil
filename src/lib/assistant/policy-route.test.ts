import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { createRecipe, addStep } from "@/lib/metadata/recipes";
import { buildTools } from "@/lib/tools/tools";
import type { AssistantContext } from "./context";
import { DISCOVERY_TOOL } from "./discovery";
import { defaultOffer } from "./offer";
import type { AssistantEvent } from "./loop";
import type { ModelProvider } from "./provider";
import { stubProvider, type ScriptEntry } from "./providers/stub";
import { pendingActions } from "./pending";
import { assistantRuns } from "./runs";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";

/**
 * The page action policy, server-side: a run submitted with a /sql or a
 * workflow context is offered only the unconditional read-only
 * operations and refuses a call outside that set before any product
 * operation, recording the refusal in its receipt; the builder and a
 * contextless run keep today's whole set.
 *
 * Red first: on the tree before enforcement the ungated
 * map update renaming a seeded map, sent under a /sql context and under
 * a workflow context, changes the name read through the map's own API.
 * Every product read and write here goes through the shipped routes.
 */

const factory = vi.hoisted(() => ({ provider: null as ModelProvider | null }));
vi.mock("@/lib/assistant/factory", () => ({ createProvider: () => factory.provider }));

const origin = "http://localhost:3201";
/** The loop reaches its own API over loopback (self-url); the test reaches it as localhost. */
const origins = new Set([origin, "http://127.0.0.1:3201"]);
const REFUSAL = "assistant_action_not_admitted";
let dir: string;
/** Every product request the loop dispatched: the operation dispatch log. */
let dispatched: { method: string; path: string }[];

beforeEach(async () => {
  assistantRuns.resetForTests(); pendingActions.resetForTests();
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-policy-test-"));
  // The automatic map check has its own suites; this one asserts its turns' exact actions.
  vi.stubEnv("DEZFIL_ASSISTANT_AUTO_CHECK", "0");
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture-never-sent"); vi.stubEnv("PORT", "3201");
  closeMetadataDb(); resetQueryInstance(); dispatched = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (!origins.has(url.origin)) throw new Error(`Unexpected fixture network request: ${request.url}`);
    dispatched.push({ method: request.method, path: url.pathname });
    return dispatchAssistantTestRoute(request);
  });
});
afterEach(async () => {
  closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const api = (url: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  dispatchAssistantTestRoute(new Request(origin + url, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
async function events(response: Response): Promise<AssistantEvent[]> {
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
/** A whole turn through the real route: reservation, message, the stream drained. */
async function turn(script: ScriptEntry[], context?: AssistantContext, message = "Work") {
  const provider = stubProvider(script); factory.provider = provider;
  const runId = (await (await api("/api/assistant/runs", {}, "POST")).json()).id as string;
  const stream = await events(await api("/api/assistant/messages", { runId, message, ...(context ? { context } : {}) }));
  return { runId, provider, stream, receipt: assistantRuns.read(runId) };
}
async function seed() {
  const csv = path.join(dir, "facts.csv"); await writeFile(csv, "city,lon,lat,value\nBerlin,13.4,52.5,4\n");
  await ingestFile(csv, "facts.csv");
  const map = createMap("Original map");
  const recipe = createRecipe("Workflow");
  const step = addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT 1 AS value", name: "output" } });
  const sql: AssistantContext = { page: "sql", draft: "SELECT 1;", selection: null, lastExecution: null };
  const workflow: AssistantContext = { page: "workflow", recipeId: recipe.id, selectedStepId: step.id, lastRunId: null };
  return { map, sql, workflow, builder: { page: "builder", mapId: map.id, selectedLayerId: null } as AssistantContext };
}
const mapName = async (id: string) => ((await (await api(`/api/maps/${id}`)).json()) as { name: string }).name;
const toolNames = (names: { name: string }[]) => names.map((t) => t.name).sort();
/** The set the spec admits under /sql and workflow contexts: operations
 * declared read-only by their effects, conditional ones excluded (D4). */
const readOnlySet = () => toolNames(buildTools().filter((t) => t.effects.readOnly && !t.effects.planningArgument));

describe("the page action policy through the real message route", () => {
  it("no context receives every generated tool; each page receives its derived offer with discovery under the measured default and its admitted set under the configured full mode (revised)", async () => {
    // pinned the whole admitted set as each page's offer. Narrows the
    // offer to the page's default inside admission and reaches the rest
    // through discovery; its measured decision in the live arm
    // made the subset each page's default, with the full
    // admitted set the configured mode. Admission is unchanged in
    // both: the read-only set on /sql and the canvas, every generated tool
    // on the builder.
    const { sql, workflow, builder } = await seed();
    const all = toolNames(buildTools());
    const restricted = readOnlySet();
    expect(restricted).toContain("run_sql");
    expect(restricted).toContain("read_table_catalogue");
    expect(restricted).not.toContain("update_map");
    // Conditional operations declare a write and a planning form; neither form is offered.
    for (const tool of buildTools()) if (tool.effects.planningArgument) expect(restricted).not.toContain(tool.name);
    // The default (nothing configured) is the subset; `full` is the configured mode.
    for (const mode of ["subset", "full"] as const) {
      vi.stubEnv("DEZFIL_ASSISTANT_OFFER", mode === "subset" ? "" : "full");
      const { provider: contextless } = await turn([{ text: "Captured", toolCalls: [] }]);
      expect(toolNames(contextless.recording.exchanges[0].options.tools), `no context, ${mode}`).toEqual(all);
      for (const [context, admitted, policy] of [[builder, all, "full"], [sql, restricted, "read_only"], [workflow, restricted, "read_only"]] as const) {
        const { provider } = await turn([{ text: "Captured", toolCalls: [] }], context);
        const offered = toolNames(provider.recording.exchanges[0].options.tools);
        if (mode === "full") expect(offered, `offer under ${context.page}, the configured full mode`).toEqual(admitted);
        else expect(offered, `offer under ${context.page}, the default`).toEqual([...toolNames(defaultOffer(context.page, policy, buildTools(), "subset")), DISCOVERY_TOOL].sort());
        for (const name of offered) if (name !== DISCOVERY_TOOL) expect(admitted, `${name} under ${context.page} is admitted`).toContain(name);
      }
    }
  });

  for (const page of ["sql", "workflow"] as const) {
    it(`9c (${page}): the ungated map rename is refused before any product operation, recorded refused, the name unchanged`, async () => {
      const seeded = await seed();
      const context = seeded[page];
      const { stream, receipt } = await turn([
        { text: "", toolCalls: [{ id: `rename-${page}`, name: "update_map", args: { id: seeded.map.id, name: "Renamed by the model" } }] },
        { text: "Done", toolCalls: [] },
      ], context, "Rename the map");
      // Before enforcement this name reads "Renamed by the model": the red run of task 1.
      expect(await mapName(seeded.map.id)).toBe("Original map");
      expect(dispatched.filter((d) => d.method === "PATCH")).toEqual([]);
      const result = stream.find((e): e is Extract<AssistantEvent, { type: "tool_result" }> => e.type === "tool_result");
      expect(result?.ok).toBe(false);
      expect(result?.outcome).toBe("refused");
      expect((result?.body as { error?: { code?: string } })?.error?.code).toBe(REFUSAL);
      expect(stream.some((e) => e.type === "tool_call")).toBe(false);
      expect(receipt.actions).toEqual([expect.objectContaining({ tool: "update_map", status: "refused" })]);
      expect(receipt.state).toBe("completed");
    });
  }

  it("9d.i: a live restricted run keeps its set across further provider exchanges", async () => {
    const { map, sql } = await seed();
    const { stream } = await turn([
      { text: "", toolCalls: [{ id: "read-first", name: "read_table_catalogue", args: { columns: 0 } }] },
      { text: "", toolCalls: [{ id: "write-second", name: "update_map", args: { id: map.id, name: "Renamed later" } }] },
      { text: "Done", toolCalls: [] },
    ], sql, "Look, then rename");
    const results = stream.filter((e): e is Extract<AssistantEvent, { type: "tool_result" }> => e.type === "tool_result");
    expect(results.map((r) => [r.tool, r.ok])).toEqual([["read_table_catalogue", true], ["update_map", false]]);
    expect((results[1].body as { error: { code: string } }).error.code).toBe(REFUSAL);
    expect(dispatched.some((d) => d.method === "GET" && d.path === "/api/catalogue/tables")).toBe(true);
    expect(dispatched.filter((d) => d.method === "PATCH")).toEqual([]);
    expect(await mapName(map.id)).toBe("Original map");
  });

  it("9d.ii: after a restricted run's stream disconnects, recovery reports progress and starts no provider or product work", async () => {
    const { map, sql } = await seed();
    // A provider whose first reply is held until the request has departed,
    // then answers with the write the policy refuses anyway; nothing after
    // the departure may reach the model or the product.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let exchanges = 0; let sends = 0;
    factory.provider = { id: "held", model: "held", exchange() {
      exchanges += 1;
      return {
        async send() { sends += 1; await held; return { text: "", toolCalls: [{ id: "late-write", name: "update_map", args: { id: map.id, name: "Renamed after departure" } }] }; },
        async continueWith() { throw new Error("no continuation after departure"); },
      };
    } };
    const runId = (await (await api("/api/assistant/runs", {}, "POST")).json()).id as string;
    const controller = new AbortController();
    const request = new Request(origin + "/api/assistant/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, message: "Work", context: sql }), signal: controller.signal });
    const response = await dispatchAssistantTestRoute(request);
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(sends).toBe(1));
    controller.abort(new DOMException("departed", "AbortError"));
    release();
    await response.text();
    const before = dispatched.length;
    for (let i = 0; i < 2; i++) {
      const receipt = await (await api(`/api/assistant/runs/${runId}`)).json() as { state: string; actions: unknown[] };
      expect(receipt.state).toBe("interrupted");
      expect(receipt.actions).toEqual([]);
    }
    expect(exchanges).toBe(1);
    expect(sends).toBe(1);
    expect(dispatched.slice(before)).toEqual([]);
    expect(dispatched.filter((d) => d.method === "PATCH")).toEqual([]);
    expect(await mapName(map.id)).toBe("Original map");
  });

  it("9d.iii: a builder run parked at a gate executes once on approval under its original policy, one dispatch, the map published once", async () => {
    const { map, builder } = await seed();
    // After the approval the model continues with a write: under the run's
    // original (builder) policy it lands; a continuation rebound to the
    // resolving request's policy would refuse it, which is what the seeded
    // omission of task 2 showed.
    const { stream, runId } = await turn([
      { text: "", toolCalls: [{ id: "publish-gated", name: "publish_map", args: { id: map.id } }] },
      { text: "", toolCalls: [{ id: "rename-after", name: "update_map", args: { id: map.id, name: "Renamed after approval" } }] },
      { text: "Published", toolCalls: [] },
    ], builder, "Publish the map");
    const pending = stream.find((e): e is Extract<AssistantEvent, { type: "confirm_required" }> => e.type === "confirm_required");
    expect(pending?.tool).toBe("publish_map");
    expect(dispatched.filter((d) => d.path.endsWith("/publish"))).toEqual([]);
    expect(((await (await api(`/api/maps/${map.id}`)).json()) as { publishToken: string | null }).publishToken).toBeNull();
    const resolved = await events(await api("/api/assistant/messages", { resolution: { pending: pending!.id, approved: true } }));
    const result = resolved.find((e): e is Extract<AssistantEvent, { type: "tool_result" }> => e.type === "tool_result");
    expect(result?.ok).toBe(true);
    // Counted beside the resource's state, never inferred from it.
    expect(dispatched.filter((d) => d.method === "POST" && d.path === `/api/maps/${map.id}/publish`)).toHaveLength(1);
    expect(((await (await api(`/api/maps/${map.id}`)).json()) as { publishToken: string | null }).publishToken).toEqual(expect.any(String));
    expect(dispatched.filter((d) => d.method === "PATCH" && d.path === `/api/maps/${map.id}`)).toHaveLength(1);
    expect(await mapName(map.id)).toBe("Renamed after approval");
    expect(assistantRuns.read(runId).actions).toEqual([
      expect.objectContaining({ tool: "publish_map", status: "succeeded" }),
      expect.objectContaining({ tool: "update_map", status: "succeeded" }),
    ]);
  });
});
