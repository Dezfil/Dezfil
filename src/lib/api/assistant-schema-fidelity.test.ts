import { requireRequestAuth } from "@/lib/auth/http";
import { instanceFetch } from "@/lib/auth/instance-fetch";
import { authenticatedRequest } from "@/lib/assistant/testing/account";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { createMap } from "@/lib/map-service";
import { setLookDriverForTests } from "@/lib/export/map-look";
import { encodePng } from "@/lib/export/png-codec";
import type { RenderDriver } from "@/lib/export/render-image";
import { validateAgainstSchema, type Definitions, type Schema } from "@/lib/export/schema-validate";
import { GET as openApiRead } from "@/app/api/openapi.json/route";
import { buildTools } from "@/lib/tools/tools";
import { buildOpenApiDocument } from "./openapi";
import { builderContext } from "@/components/builder/assistant/builder-context";
import { executedSnapshot, failedSnapshot, sqlAssistantContext } from "@/components/sql/assistant-context";
import { parseAssistantContext } from "@/lib/assistant/context";
import { runAssistant, type AssistantEvent } from "@/lib/assistant/loop";
import { PendingActionStore } from "@/lib/assistant/pending";
import { stubProvider } from "@/lib/assistant/providers/stub";
import { compactReceipt, jsonBytes } from "@/lib/assistant/recovery-data";
import { assistantRuns, type RunReceipt } from "@/lib/assistant/runs";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";

/**
 * ``: the published document validates the payloads the product actually
 * produces. Three shapes the phase added had drifted from their schemas —
 * the builder's context carries an appearance the schema closed out, the
 * loop yields a completion reason the event enum did not list, and
 * terminal compaction drops render detail the referenced state schema
 * requires — so a client generated from the document could refuse a valid
 * request or a valid recovery response.
 *
 * Nothing here is a payload the test wrote: the context comes from the
 * builder's own context source, the event from a real exhausted run
 * through the real loop, and the compacted record from the production
 * compaction function applied to that run's real receipt. The schemas are
 * read out of `buildOpenApiDocument()`, so what is checked is the
 * document the instance serves.
 */

const origin = "http://127.0.0.1:3392";
const FIXTURE = encodePng({ width: 1024, height: 640, rgba: new Uint8Array(1024 * 640 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i >> 4) & 0xff)) });
let dir: string;
let mapId: string;

const document = buildOpenApiDocument() as unknown as { components: { schemas: Definitions } };
const schemas = document.components.schemas;
const check = (value: unknown, name: string) => validateAgainstSchema(value, schemas[name], "$", schemas);

beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-schema-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  vi.stubEnv("PORT", "3392");
  vi.stubEnv("OPENAI_API_KEY", "fixture-never-sent");
  vi.stubEnv("DEZFIL_AI_PROVIDER", "openai");
  closeMetadataDb(); assistantRuns.resetForTests();
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (new URL(request.url).origin !== origin) throw new Error(`Unexpected fixture network request: ${request.url}`);
    return dispatchAssistantTestRoute(request);
  });
  mapId = createMap("Documented").id;
  const driver: RenderDriver = { launch: async () => ({
    render: async () => ({ png: FIXTURE, consumed: JSON.stringify({ map: mapId, layers: [{ id: "layer-1", filters: "0000000000000000" }], legend: { visible: true, corner: "bottom-left", order: ["layer-1"] }, widgets: ["w-1"], attribution: "© Fixture", failures: [] }) }),
    close: async () => {}, kill: () => {},
  }) };
  setLookDriverForTests(driver);
});
afterEach(async () => {
  setLookDriverForTests(null); closeMetadataDb();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

let seq = 0;
const call = (name: string, args: Record<string, unknown>) => ({ id: `s${++seq}`, name, args });

/** One real run, driven as the route drives it, whose last step is a map
 * check: the budget runs out with the check's observation still awaited,
 * so the loop yields the completion reason the enum has to carry. */
async function exhaustedRun(): Promise<{ events: AssistantEvent[]; receipt: RunReceipt }> {
  const provider = stubProvider([
    { text: "", toolCalls: [call("update_map", { id: mapId, name: "Renamed" })] },
    { text: "", toolCalls: [call("look_at_map", { mapId })] },
    { text: "never asked", toolCalls: [] },
  ]);
  const run = assistantRuns.reserve();
  assistantRuns.bind(run.id, { message: "go" });
  const events: AssistantEvent[] = [];
  for await (const event of runAssistant(provider, { message: "go", history: [], context: builderContext(mapId, null, "dark") },
    { baseUrl: origin, fetchImpl: instanceFetch(origin, requireRequestAuth(authenticatedRequest())), pending: new PendingActionStore(), stepBudget: 2, runId: run.id })) {
    events.push(event);
    assistantRuns.record(run.id, event);
  }
  assistantRuns.finish(run.id);
  return { events, receipt: assistantRuns.read(run.id) };
}

/** The terminal compaction's own output: the production function driven
 * down, bound by bound, until it reaches the step that drops the render's
 * detail lists. No list is removed by this test. */
function compactedPastTheLists(receipt: RunReceipt): RunReceipt {
  for (let max = jsonBytes(receipt); max > 0; max -= 16) {
    let out: RunReceipt;
    try { out = compactReceipt(receipt, max, true); } catch { break; }
    if (out.actions.some((a) => a.render !== undefined && a.render.state.layers === undefined)) return out;
  }
  throw new Error("compaction never reached the render's detail lists");
}

describe("the document validates the payloads the product produces", () => {
  it("1.2a: the builder's own context, appearance included, validates as AssistantContext", () => {
    const context = builderContext(mapId, null, "dark");
    // The reader admits it, which is the product behavior the schema must match.
    expect(parseAssistantContext(context)).toEqual(context);
    expect(check(context, "AssistantContext")).toEqual([]);
    // Controls: the other two pages, and a context the reader refuses.
    expect(check({ page: "builder", mapId, selectedLayerId: null }, "AssistantContext")).toEqual([]);
    expect(check({ page: "workflow", recipeId: "r", selectedStepId: null, lastRunId: null }, "AssistantContext")).toEqual([]);
    expect(check({ page: "builder", mapId, selectedLayerId: null, appearance: "sepia" }, "AssistantContext")).not.toEqual([]);
    expect(() => parseAssistantContext({ page: "builder", mapId, selectedLayerId: null, appearance: "sepia" })).toThrow();
  });

  it("1.2b: every event of a real exhausted run validates as AssistantEvent, its completion reason included", async () => {
    const { events } = await exhaustedRun();
    const observations = events.filter((e) => e.type === "observation");
    expect(observations).toEqual([expect.objectContaining({ state: "interrupted", reason: "exhausted" })]);
    expect(check(observations[0], "AssistantEvent")).toEqual([]);
    expect(events.flatMap((event) => check(event, "AssistantEvent").map((p) => `${event.type} ${p}`))).toEqual([]);
    // Control: a reason no part of the product yields is still refused.
    expect(check({ ...observations[0], reason: "bored" }, "AssistantEvent")).not.toEqual([]);
  });

  it("1.2c: a real compacted recovery record validates as AssistantRun", async () => {
    const { receipt } = await exhaustedRun();
    expect(check(receipt, "AssistantRun")).toEqual([]);
    const compacted = compactedPastTheLists(receipt);
    const render = compacted.actions.find((a) => a.render !== undefined)!.render!;
    expect(render.state.layers).toBeUndefined();
    expect(render.state.widgets).toBeUndefined();
    expect(render.state.legend.order).toBeUndefined();
    expect(render.state.digest).toBe(receipt.actions.find((a) => a.render !== undefined)!.render!.state.digest);
    expect(check(compacted, "AssistantRun")).toEqual([]);
  });

  it("1.2d: the map check's own response is not loosened: there the detail lists stay required", async () => {
    const { receipt } = await exhaustedRun();
    const full = receipt.actions.find((a) => a.render !== undefined)!.render!;
    const compacted = compactedPastTheLists(receipt).actions.find((a) => a.render !== undefined)!.render!;
    expect(check(full, "MapLookRender")).toEqual([]);
    expect(check(compacted, "MapLookRender")).toEqual([
      '$.state: missing required "layers"',
      '$.state: missing required "widgets"',
      '$.state.legend: missing required "order"',
    ]);
  });

  it("1.2e: the event's reason covers both the reasons it carries, and its own render stays the strict one", async () => {
    const event = schemas.AssistantEvent.properties as Record<string, Schema>;
    const reasons = event.reason.enum as string[];
    // Derived from the other two schemas, never from a literal here.
    const done = (schemas.AssistantRun.properties as Record<string, Schema>).state.enum as string[];
    const observation = ((schemas.AssistantObservation.properties as Record<string, Schema>).reason.enum) as string[];
    expect(reasons).toEqual(expect.arrayContaining(observation));
    expect(reasons).toEqual(expect.arrayContaining(["end", "budget", "interrupted"]));
    expect(done).not.toContain("exhausted");
    // A streamed event carries the render as it was made, never a compacted
    // one, so its schema is the check's own.
    expect(event.render.$ref).toBe("#/components/schemas/MapLookRender");
    expect((schemas.AssistantAction.properties as Record<string, Schema>).render.$ref).toBe("#/components/schemas/RecordedMapLookRender");
  });

  it("1.2f: the SQL page's own context validates in all three of its execution states, and a bad one is refused", () => {
    // An earlier validator counted the lastExecution union's
    // null arm as a match for any value, so a context carrying a real
    // execution matched two arms and was reported invalid, while a
    // lastExecution of 123 matched the null arm alone and was admitted.
    // Both payloads come from the page's own context source.
    const none = sqlAssistantContext("SELECT 1", "", null);
    const failed = sqlAssistantContext("SELECT oops", "", failedSnapshot("SELECT oops", "invalid_sql", "Unknown column oops."));
    const executed = sqlAssistantContext("SELECT 1", "", executedSnapshot("SELECT 1", { rowCount: 1, preview: [{ n: 1 }], previewTruncated: false, columns: [{ name: "n", type: "INTEGER" }], runtimeMs: 3 } as Parameters<typeof executedSnapshot>[1]));
    // The other direction: a lastExecution that is none of the three arms.
    const wrong = { ...none, lastExecution: 123 };
    // The reader's own verdict on each, which is the behavior the schema must match.
    for (const context of [none, failed, executed]) expect(parseAssistantContext(context)).toEqual(context);
    expect(() => parseAssistantContext(wrong)).toThrow();
    // Read as one object, so a failing run names both directions rather than
    // stopping at the first.
    expect({
      "no execution": check(none, "AssistantContext"),
      "a failed execution": check(failed, "AssistantContext"),
      "a successful execution": check(executed, "AssistantContext"),
      "lastExecution 123 refused": check(wrong, "AssistantContext").length > 0,
    }).toEqual({
      "no execution": [],
      "a failed execution": [],
      "a successful execution": [],
      "lastExecution 123 refused": true,
    });
  });

  it("the check itself can go red: a seeded closed schema refuses the context the reader admits", () => {
    const closed = { ...(schemas.AssistantContext as Schema) };
    closed.oneOf = (closed.oneOf as Schema[]).map((variant) => ({ ...variant, additionalProperties: false, properties: Object.fromEntries(Object.entries(variant.properties as Record<string, Schema>).filter(([key]) => key !== "appearance")) }));
    expect(validateAgainstSchema(builderContext(mapId, null, "dark"), closed, "$", schemas)).not.toEqual([]);
  });
});

/**
 * Item 3: the document carries the model choice's own shapes, checked
 * against the payloads the product produces — the status route's own
 * answer and a receipt written by the run store the route writes to.
 */
describe("the model choice's documented shapes", () => {
  it("the real status read and a real receipt's provenance validate, and wrong shapes are refused", async () => {
    vi.stubEnv("DEZFIL_AI_MODELS_OPENAI", "gpt-6-astra, gpt-5.6-nova");
    const status = await (await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant`))).json() as { models: { id: string; efforts: unknown[] }[] };
    expect(status.models.map((choice) => choice.id)).toEqual(["gpt-5.6-terra", "gpt-6-astra", "gpt-5.6-nova"]);
    const run = assistantRuns.reserve();
    assistantRuns.bind(run.id, { message: "go" });
    assistantRuns.bindChoice(run.id, { model: "gpt-6-astra", effort: "xhigh", defaulted: { model: false, effort: false } });
    assistantRuns.reported(run.id, "gpt-6-astra-2026-09-01");
    // A second response that named nothing: the null entry the schema has to admit.
    assistantRuns.reported(run.id, undefined);
    assistantRuns.finish(run.id);
    const receipt = assistantRuns.read(run.id);
    expect(receipt.provenance?.reported).toEqual(["gpt-6-astra-2026-09-01", null]);
    expect({
      status: check(status, "AssistantStatus"),
      receipt: check(receipt, "AssistantRun"),
      // Controls, both directions: shapes the document must refuse.
      "a reported entry that is neither an identity nor null": check({ ...receipt, provenance: { reported: [7] } }, "AssistantRun").length > 0,
      "a choice missing its levels": check({ ...status, models: [{ id: "x", name: "X" }] }, "AssistantStatus").length > 0,
    }).toEqual({ status: [], receipt: [], "a reported entry that is neither an identity nor null": true, "a choice missing its levels": true });
  });
});


describe("the served catalogue contract", () => {
  it("publishes the catalogue field explicitly, including its states and revised default offer", async () => {
    const served = await (await openApiRead()).json();
    const status = served.components.schemas.AssistantStatus;
    expect(status.properties, "the served status schema must publish catalogue, not merely permit unknown properties").toHaveProperty("catalogue");
    expect(status.properties.catalogue.$ref).toBe("#/components/schemas/AssistantCatalogueState");
    expect(served.components.schemas.AssistantCatalogueState.oneOf).toHaveLength(3);
    expect(status.properties.models.description).toContain("Unset offers the effective catalogue");
    expect(buildTools().filter((tool) => tool.path.startsWith("/api/assistant"))).toEqual([]);
  });

  it("validates real absent, applied, empty-applied and rejected status reads from the served schema", async () => {
    const served = await (await openApiRead()).json();
    const definitions = served.components.schemas;
    for (const [file, state] of [[undefined, "absent"], ['{"openai":[{"id":"local","name":"Local","efforts":["none"]}]}', "applied"], ["{}", "applied"], ['{"openai":[{"id":"bad","name":"Bad","efforts":["default"]}]}', "rejected"]]) {
      if (file !== undefined) await writeFile(path.join(dir, "assistant-models.json"), file);
      const actual = await (await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant`))).json();
      expect(actual.catalogue.instance).toBe(state);
      expect(validateAgainstSchema(actual, definitions.AssistantStatus, "$", definitions)).toEqual([]);
    }
  });

  it("rejects invalid source/state combinations and conditional reason shapes", async () => {
    const served = await (await openApiRead()).json();
    const definitions = served.components.schemas;
    const actual = await (await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant`))).json();
    for (const catalogue of [
      {}, { source: "shipped", instance: "applied" }, { source: "merged", instance: "absent" },
      { source: "merged", instance: "rejected", reason: "Bad" },
      { source: "shipped", instance: "rejected" }, { source: "shipped", instance: "rejected", reason: 7 },
      { source: "shipped", instance: "absent", reason: "Bad" }, { source: "merged", instance: "applied", reason: "Bad" },
      { source: "other", instance: "absent" }, { source: "shipped", instance: "other" },
    ]) {
      expect(validateAgainstSchema({ ...actual, catalogue }, definitions.AssistantStatus, "$", definitions), JSON.stringify(catalogue)).not.toEqual([]);
    }
  });
});
