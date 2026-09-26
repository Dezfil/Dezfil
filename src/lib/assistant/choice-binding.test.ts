import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { createMap } from "@/lib/map-service";
import { setLookDriverForTests } from "@/lib/export/map-look";
import { encodePng } from "@/lib/export/png-codec";
import type { RenderDriver } from "@/lib/export/render-image";
import type { ProviderChoice } from "./factory";
import { stubProvider, type StubRecording } from "./providers/stub";
import { assistantRuns } from "./runs";
import { pendingActions } from "./pending";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";
import { outputCall, outputText, responseWire } from "./testing/wire";

/**
 * Binding: the first accepted submission fixes the choice for the whole
 * run, and every continuation rides it — a tool continuation, a
 * confirmation continuation and the map check's observation, each
 * exercised separately, each read from the real request the adapter
 * serialized rather than from the object it was built with.
 *
 * identity contract does the work and is checked here rather than assumed:
 * the choice travels inside the submission, so two identical submissions
 * observe one exchange and a changed choice under the same identity
 * conflicts. A choice on a resolution is ignored.
 */

const origin = "http://127.0.0.1:3215";
const CHOICE = { model: "gpt-6-astra", effort: "xhigh" } as const;
const FIXTURE = encodePng({ width: 64, height: 40, rgba: new Uint8Array(64 * 40 * 4).fill(180) });

type Sent = Record<string, unknown>;
const wire = vi.hoisted(() => ({ sent: [] as Sent[], script: [] as (() => Response)[], built: [] as (ProviderChoice | undefined)[] }));
const factory = vi.hoisted(() => ({ stub: null as ReturnType<typeof stubProvider> | null }));

vi.mock("@/lib/assistant/factory", async () => {
  const { openaiProvider: adapter } = await import("./providers/openai");
  return {
    createProvider: (choice: ProviderChoice = {}) => {
      wire.built.push(choice);
      if (factory.stub) return factory.stub;
      // The real adapter, so what is asserted is the request it serialized.
      const fetchImpl: typeof fetch = async (_input, init) => {
        wire.sent.push(JSON.parse(String(init?.body)) as Sent);
        const next = wire.script.shift();
        return next ? next() : responseWire([outputText("Done.")]);
      };
      return adapter("fixture-never-sent", choice.model ?? "gpt-5.6-terra", fetchImpl, choice.effort);
    },
  };
});

let dir: string;
let mapId: string;
beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-bound-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  vi.stubEnv("PORT", "3215");
  vi.stubEnv("OPENAI_API_KEY", "fixture-never-sent");
  vi.stubEnv("DEZFIL_AI_PROVIDER", "openai");
  vi.stubEnv("DEZFIL_AI_MODELS_OPENAI", "gpt-6-astra");
  closeMetadataDb(); resetQueryInstance(); assistantRuns.resetForTests(); pendingActions.resetForTests();
  wire.sent.length = 0; wire.script.length = 0; wire.built.length = 0; factory.stub = null;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => dispatchAssistantTestRoute(input instanceof Request ? input : new Request(String(input), init)));
  mapId = createMap("Bound").id;
  const driver: RenderDriver = { launch: async () => ({ render: async () => ({ png: FIXTURE, consumed: JSON.stringify({ map: mapId, layers: [], legend: { visible: false, corner: "bottom-left", order: [] }, widgets: [], attribution: "", failures: [] }) }), close: async () => {}, kill: () => {} }) };
  setLookDriverForTests(driver);
});
afterEach(async () => { setLookDriverForTests(null); closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

const reserve = async () => (await (await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/runs`, { method: "POST" }))).json() as { id: string }).id;
const post = (body: Record<string, unknown>) => dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/messages`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));
const builder = () => ({ page: "builder", mapId, selectedLayerId: null });
/** Every provider request's identity and effort, as serialized. */
const pairs = () => wire.sent.map((body) => ({ model: body.model, effort: (body.reasoning as { effort?: string } | undefined)?.effort }));
const BOUND = { model: "gpt-6-astra", effort: "xhigh" };
// the next admission loses both this identity and its named levels, while
// the already bound exchange must keep its original pair.
function retireChoice() {
  writeFileSync(path.join(dir, "assistant-models.json"), JSON.stringify({ openai: [{ id: "gpt-6-astra", name: "Changed", efforts: [] }] }));
  vi.stubEnv("DEZFIL_AI_MODELS_OPENAI", "gpt-5.6-terra");
}


describe("the first accepted submission binds the choice", () => {
  it("two identical concurrent submissions start one exchange", async () => {
    const recording: StubRecording = { exchanges: [] };
    factory.stub = stubProvider([{ text: "Done.", toolCalls: [] }, { text: "Twice.", toolCalls: [] }], recording);
    const runId = await reserve();
    const body = { runId, message: "Colour the parks.", history: [], choice: CHOICE };
    const [a, b] = await Promise.all([post({ ...body }), post({ ...body })]);
    await Promise.all([a.text(), b.text()]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(recording.exchanges).toHaveLength(1);
  });

  it("a changed choice under the same identity conflicts, in either half", async () => {
    factory.stub = stubProvider([{ text: "Done.", toolCalls: [] }]);
    const runId = await reserve();
    await (await post({ runId, message: "Colour the parks.", history: [], choice: CHOICE })).text();
    // Both halves changed in turn, each to something this instance would
    // otherwise accept, so what answers is the identity contract and not a
    // refusal.
    for (const changed of [{ model: "gpt-5.6-terra", effort: "high" }, { model: "gpt-6-astra", effort: "high" }]) {
      const response = await post({ runId, message: "Colour the parks.", history: [], choice: changed });
      expect(response.status).toBe(409);
      expect((await response.json() as { error: { code: string } }).error.code).toBe("assistant_run_conflict");
    }
  });

  it("a tool continuation carries the bound choice, read from the request it serialized", async () => {
    wire.script.push(() => { retireChoice(); return responseWire([outputCall("call-1", "list_maps", "{}")]); }, () => responseWire([outputText("Two maps.")]));
    const runId = await reserve();
    await (await post({ runId, message: "What maps are there?", history: [], choice: CHOICE, context: builder() })).text();
    expect(wire.sent).toHaveLength(2);
    expect(pairs()).toEqual([BOUND, BOUND]);
  });

  it("a confirmation continuation carries the bound choice, and a choice on the resolution is ignored", async () => {
    wire.script.push(() => responseWire([outputCall("call-publish", "publish_map", JSON.stringify({ id: mapId }))]), () => responseWire([outputText("Published.")]));
    const runId = await reserve();
    await (await post({ runId, message: "Publish it.", history: [], choice: CHOICE, context: builder() })).text();
    const parked = (await (await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/pending`))).json() as { pending: { id: string; runId: string }[] }).pending.find((p) => p.runId === runId);
    expect(parked).toBeDefined();
    // The resolution names a different model and effort. It is ignored
    // input, not an error: the bound run continues as it was.
    retireChoice();
    const resolved = await post({ resolution: { pending: parked!.id, approved: true }, choice: { model: "gpt-5.6-terra", effort: "low" } });
    expect(resolved.status).toBe(200);
    await resolved.text();
    expect(wire.sent).toHaveLength(2);
    expect(pairs()).toEqual([BOUND, BOUND]);
    // Only one provider was ever built for this run: the resolution built none.
    expect(wire.built).toEqual([CHOICE]);
  });

  it("the map check's observation carries the bound choice too", async () => {
    wire.script.push(
      () => { retireChoice(); return responseWire([outputCall("call-rename", "update_map", JSON.stringify({ id: mapId, name: "Renamed" }))]); },
      () => responseWire([outputText("Renamed it.")]),
      () => responseWire([outputText("It looks right.")]),
    );
    const runId = await reserve();
    await (await post({ runId, message: "Rename it.", history: [], choice: CHOICE, context: builder() })).text();
    // Three requests: the turn, its continuation, and the automatic check's
    // observation — the last one image-bearing.
    expect(wire.sent).toHaveLength(3);
    expect(pairs()).toEqual([BOUND, BOUND, BOUND]);
    const last = JSON.stringify(wire.sent[2]);
    expect(last).toContain("input_image");
  });
});
