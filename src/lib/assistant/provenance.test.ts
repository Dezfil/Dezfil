import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { allMaps, createMap } from "@/lib/map-service";
import { setLookDriverForTests } from "@/lib/export/map-look";
import { encodePng } from "@/lib/export/png-codec";
import type { RenderDriver } from "@/lib/export/render-image";
import type { ProviderChoice } from "./factory";
import { assistantRuns } from "./runs";
import { pendingActions } from "./pending";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";
import { outputCall, outputText, responseWire, sse } from "./testing/wire";

/**
 * What the record says about the model choice (` `): two facts that are
 * never collapsed — the pair the submission asked for with the halves the
 * instance supplied, and the identities completed provider responses
 * actually reported.
 *
 * The second is written at the provider-completion seam, not where a
 * transcript message is emitted, so a reply that only called a tool and an
 * observation that completed silently are as visible as a reply with text.
 * Everything here is read through the documented recovery read, after the
 * stream is gone.
 */

const origin = "http://127.0.0.1:3216";
const FIXTURE = encodePng({ width: 64, height: 40, rgba: new Uint8Array(64 * 40 * 4).fill(140) });

type Sent = Record<string, unknown>;
const wire = vi.hoisted(() => ({ sent: [] as Sent[], script: [] as (() => Response)[], dispatched: [] as string[] }));

vi.mock("@/lib/assistant/factory", async () => {
  const { openaiProvider: adapter } = await import("./providers/openai");
  return {
    createProvider: (choice: ProviderChoice = {}) => {
      // The real adapter against a scripted wire: what the record holds
      // comes from a real completed response, never from a stub's field.
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
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-prov-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  vi.stubEnv("PORT", "3216");
  vi.stubEnv("OPENAI_API_KEY", "fixture-never-sent");
  vi.stubEnv("DEZFIL_AI_PROVIDER", "openai");
  vi.stubEnv("DEZFIL_AI_MODELS_OPENAI", "gpt-6-astra");
  closeMetadataDb(); resetQueryInstance(); assistantRuns.resetForTests(); pendingActions.resetForTests();
  wire.sent.length = 0; wire.script.length = 0; wire.dispatched.length = 0;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    // Everything the product itself sends: grounding reads and tool dispatches.
    wire.dispatched.push(`${request.method} ${new URL(request.url).pathname}`);
    return dispatchAssistantTestRoute(request);
  });
  mapId = createMap(testAccountScope(), "Provenance").id;
  const driver: RenderDriver = { launch: async () => ({ render: async () => ({ png: FIXTURE, consumed: JSON.stringify({ map: mapId, layers: [], legend: { visible: false, corner: "bottom-left", order: [] }, widgets: [], attribution: "", failures: [] }) }), close: async () => {}, kill: () => {} }) };
  setLookDriverForTests(driver);
});
afterEach(async () => { setLookDriverForTests(null); closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

type Provenance = {
  requested?: { model: string; effort: string; defaulted: { model: boolean; effort: boolean } };
  reported?: (string | null)[];
};
type Receipt = { id: string; state: string; text: string; actions: { id: string; tool: string; observation?: { state: string } }[]; provenance?: Provenance; error?: { code: string } };

const reserve = async () => (await (await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/runs`, { method: "POST" }))).json() as { id: string }).id;
const post = (body: Record<string, unknown>) => dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/messages`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));
const builder = () => ({ page: "builder", mapId, selectedLayerId: null });
/** The documented recovery read, which is the only way this file looks. */
const read = async (runId: string) => await (await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/runs/${runId}`))).json() as Receipt;
/** The same read, waited to a terminal state: used where the stream is lost. */
async function settled(runId: string): Promise<Receipt> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const receipt = await read(runId);
    if (receipt.state !== "running" && receipt.state !== "reserved") return receipt;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the run never reached a terminal state");
}
/** A completed response that names no model at all. */
const unnamedWire = (output: unknown[]) => sse([{ type: "response.completed", response: { id: "response", status: "completed", output } }]);

describe("the record's two model-choice facts", () => {
  it("the requested pair and which halves the instance supplied, per submission", async () => {
    const chosen = await reserve();
    await (await post({ runId: chosen, message: "Colour the parks.", history: [], choice: { model: "gpt-6-astra" } })).text();
    const defaulted = await reserve();
    await (await post({ runId: defaulted, message: "Colour the parks.", history: [] })).text();
    expect({ chosen: (await read(chosen)).provenance?.requested, defaulted: (await read(defaulted)).provenance?.requested }).toEqual({
      // The model is the person's, the effort is the model's provider-default entry.
      chosen: { model: "gpt-6-astra", effort: "default", defaulted: { model: false, effort: true } },
      // Neither half was asked for: the instance default answered both.
      defaulted: { model: "gpt-5.6-terra", effort: "default", defaulted: { model: true, effort: true } },
    });
  });

  it("a reply that only called a tool is recorded, and a response naming nothing is recorded as naming nothing", async () => {
    // The first response carries a call and no text at all; the second
    // carries the text and no identity.
    wire.script.push(
      () => responseWire([outputCall("call-1", "list_maps", "{}")], "gpt-6-astra-2026-09-17"),
      () => unnamedWire([outputText("Two maps.")]),
    );
    const runId = await reserve();
    await (await post({ runId, message: "What maps are there?", history: [], choice: { model: "gpt-6-astra" }, context: builder() })).text();
    const receipt = await read(runId);
    expect(receipt.provenance?.reported).toEqual(["gpt-6-astra-2026-09-17", null]);
    // Independent of the transcript: the only text of the run came from the
    // response that reported no identity.
    expect(receipt.text).toBe("Two maps.");
  });

  it("an observation that completes silently is recorded at the seam", async () => {
    wire.script.push(
      () => responseWire([outputCall("call-rename", "update_map", JSON.stringify({ id: mapId, name: "Renamed" }))], "gpt-6-astra"),
      () => responseWire([outputText("Renamed it.")], "gpt-6-astra"),
      // The automatic check's observation: a completed response with no
      // output at all, under an identity of its own.
      () => responseWire([], "gpt-6-astra-check"),
    );
    const runId = await reserve();
    await (await post({ runId, message: "Rename it.", history: [], choice: { model: "gpt-6-astra" }, context: builder() })).text();
    const receipt = await read(runId);
    const check = receipt.actions.find((action) => action.tool === "look_at_map");
    expect({ observation: check?.observation?.state, reported: receipt.provenance?.reported }).toEqual({
      observation: "silent",
      reported: ["gpt-6-astra", "gpt-6-astra-check"],
    });
  });

  it("an identity different from the requested one survives a lost stream, read through recovery", async () => {
    wire.script.push(() => responseWire([outputText("Done.")], "gpt-6-astra-2026-09-01"));
    const runId = await reserve();
    // The stream is never read: the record is written by the producer.
    await post({ runId, message: "Colour the parks.", history: [], choice: { model: "gpt-6-astra", effort: "xhigh" }, context: builder() });
    const receipt = await settled(runId);
    expect(receipt.provenance).toEqual({
      requested: { model: "gpt-6-astra", effort: "xhigh", defaulted: { model: false, effort: false } },
      reported: ["gpt-6-astra-2026-09-01"],
    });
  });

  it("a failure before any completed response keeps the request and reports nothing, which is not reporting none", async () => {
    wire.script.push(() => sse([{ type: "response.failed", response: { id: "response", status: "failed", model: "gpt-6-astra", output: [] } }]));
    const failed = await reserve();
    await (await post({ runId: failed, message: "Colour the parks.", history: [], choice: { model: "gpt-6-astra" }, context: builder() })).text();
    const failure = await settled(failed);
    wire.script.push(() => unnamedWire([outputText("Done.")]));
    const completed = await reserve();
    await (await post({ runId: completed, message: "Colour the parks.", history: [], choice: { model: "gpt-6-astra" }, context: builder() })).text();
    const unnamed = await settled(completed);
    expect({
      failedState: failure.state,
      failedRequested: failure.provenance?.requested?.model,
      failedReported: failure.provenance?.reported,
      unnamedState: unnamed.state,
      unnamedReported: unnamed.provenance?.reported,
    }).toEqual({
      failedState: "failed",
      failedRequested: "gpt-6-astra",
      // No completed response at all, which the record leaves absent.
      failedReported: undefined,
      unnamedState: "completed",
      // One completed response that named nothing, which the record states.
      unnamedReported: [null],
    });
  });

  it("reading the record starts no provider call and no product work", async () => {
    wire.script.push(
      () => responseWire([outputCall("call-1", "create_map", JSON.stringify({ name: "Made" }))], "gpt-6-astra"),
      () => responseWire([outputText("Made it.")], "gpt-6-astra"),
    );
    const runId = await reserve();
    await (await post({ runId, message: "Make a map.", history: [], choice: { model: "gpt-6-astra" }, context: builder() })).text();
    const before = { provider: wire.sent.length, dispatched: wire.dispatched.length, maps: allMaps(testAccountScope()).length };
    // The counters are shown able to see work by the run they just counted.
    expect(before.provider).toBe(2);
    expect(wire.dispatched).toContain("POST /api/maps");
    const first = await read(runId);
    expect(first.provenance).toEqual({
      requested: { model: "gpt-6-astra", effort: "default", defaulted: { model: false, effort: true } },
      reported: ["gpt-6-astra"],
    });
    for (let again = 0; again < 3; again += 1) expect(await read(runId)).toEqual(first);
    expect({ provider: wire.sent.length, dispatched: wire.dispatched.length, maps: allMaps(testAccountScope()).length }).toEqual(before);
  });
});
