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
import type { ImageContinuation, ModelProvider, ProviderReply } from "./provider";
import { providerObserver } from "./testing/observer";
import { assistantRuns } from "./runs";
import { pendingActions } from "./pending";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";
import { outputCall, outputText, responseWire, sse } from "./testing/wire";

/**
 * two map checks under a chosen model. The explicit check and the
 * automatic one are counted separately — they reach the provider through
 * different seams, a tool outcome and a user turn — and everything
 * asserted is read from the request the real adapter serialized,
 * including the image's bytes.
 *
 * The first row is the harness itself: the test provider wrapper used
 * elsewhere in the suite drops the image-continuation seam, and the
 * automatic branch skips its image silently when that seam is absent, so
 * a measurement taken through the unfixed wrapper would be a green that
 * proves nothing.
 */

const origin = "http://127.0.0.1:3218";
const CHOICE = { model: "gpt-6-astra", effort: "xhigh" } as const;
const BOUND = { model: "gpt-6-astra", effort: "xhigh" };
const FIXTURE = encodePng({ width: 64, height: 40, rgba: new Uint8Array(64 * 40 * 4).fill(160) });
const IMAGE_URL = `data:image/png;base64,${Buffer.from(FIXTURE).toString("base64")}`;

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
beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-check-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  vi.stubEnv("PORT", "3218");
  vi.stubEnv("OPENAI_API_KEY", "fixture-never-sent");
  vi.stubEnv("DEZFIL_AI_PROVIDER", "openai");
  vi.stubEnv("DEZFIL_AI_MODELS_OPENAI", "gpt-6-astra");
  closeMetadataDb(); resetQueryInstance(); assistantRuns.resetForTests(); pendingActions.resetForTests();
  wire.sent.length = 0; wire.script.length = 0; wire.dispatched.length = 0;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    wire.dispatched.push(`${request.method} ${new URL(request.url).pathname}`);
    return dispatchAssistantTestRoute(request);
  });
  mapId = createMap(testAccountScope(), "Checked").id;
  const driver: RenderDriver = { launch: async () => ({
    render: async () => ({ png: FIXTURE, consumed: JSON.stringify({ map: mapId, layers: [{ id: "layer-1", filters: "0000000000000000" }], legend: { visible: true, corner: "bottom-left", order: ["layer-1"] }, widgets: ["w-1"], attribution: "© Fixture", failures: [] }) }),
    close: async () => {}, kill: () => {},
  }) };
  setLookDriverForTests(driver);
});
afterEach(async () => { setLookDriverForTests(null); closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

type Action = { id: string; tool: string; status: string; automatic?: true; render?: { mapName: string; image: { width: number; height: number; bytes: number }; state: { digest: string } }; observation?: { state: string; reason?: string; text?: string } };
/** The size the check asks for, which the facts report, beside the bytes
 * the driver actually produced: the two are different facts and the second
 * is the byte-for-byte one. */
const RENDERED = { width: 1024, height: 640, bytes: FIXTURE.byteLength };
type Receipt = { state: string; actions: Action[]; provenance?: { reported?: (string | null)[] }; error?: { code: string } };

const reserve = async () => (await (await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/runs`, { method: "POST" }))).json() as { id: string }).id;
const post = (body: Record<string, unknown>) => dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/messages`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));
const read = async (runId: string) => await (await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/runs/${runId}`))).json() as Receipt;
const builder = () => ({ page: "builder", mapId, selectedLayerId: null });
const pairs = () => wire.sent.map((body) => ({ model: body.model, effort: (body.reasoning as { effort?: string } | undefined)?.effort }));
const productWork = () => wire.dispatched.filter((call) => !call.includes("/api/assistant"));
/** Where the image rides in one serialized request: the provider's own
 * image field inside a tool outcome, or inside a user turn. */
function imageChannel(body: Sent) {
  const input = (body.input ?? []) as { role?: string; type?: string; content?: unknown; output?: unknown }[];
  const asOutcome = input.filter((item) => item.type === "function_call_output" && JSON.stringify(item.output ?? "").includes("input_image"));
  const asUserTurn = input.filter((item) => item.role === "user" && JSON.stringify(item.content ?? "").includes("input_image"));
  return {
    outcomes: asOutcome.length, userTurns: asUserTurn.length,
    // The bytes as sent, so a re-encoded or downscaled image would show.
    bytes: JSON.stringify(body).includes(IMAGE_URL),
    // The same bytes never also arrive as text.
    asText: JSON.stringify(body).split(IMAGE_URL).length - 1 > 1,
  };
}

describe("the test provider wrapper carries the image seam", () => {
  it("forwards a continuation the inner provider offers, and counts it", async () => {
    const reply: ProviderReply = { text: "Seen.", toolCalls: [] };
    const seen: ImageContinuation[] = [];
    const inner: ModelProvider = {
      id: "openai", model: "gpt-6-astra", effort: "xhigh",
      exchange: () => ({
        send: async () => reply,
        continueWith: async () => reply,
        continueWithImage: async (continuation) => { seen.push(continuation); return reply; },
      }),
    };
    const observed = providerObserver(inner);
    const exchange = observed.exchange({ system: "s", tools: [], history: [] });
    expect(exchange.continueWithImage).toBeDefined();
    await exchange.continueWithImage!({ text: "Look", image: { mediaType: "image/png", data: FIXTURE } });
    expect(seen.map((one) => one.image.data)).toEqual([FIXTURE]);
    expect(observed.calls()).toBe(1);
    // And what the wrapper reports about the provider is the provider's own.
    expect({ id: observed.id, model: observed.model, effort: observed.effort }).toEqual({ id: "openai", model: "gpt-6-astra", effort: "xhigh" });
  });
});

describe("checks under a chosen model", () => {
  it("an explicit check rides the tool outcome's image field under the bound choice", async () => {
    wire.script.push(
      () => responseWire([outputCall("call-look", "look_at_map", JSON.stringify({ mapId }))], "gpt-6-astra"),
      () => responseWire([outputText("The parks read clearly.")], "gpt-6-astra"),
    );
    const runId = await reserve();
    await (await post({ runId, message: "How does it look?", history: [], choice: CHOICE, context: builder() })).text();
    expect(wire.sent).toHaveLength(2);
    expect(pairs()).toEqual([BOUND, BOUND]);
    // The image reached the model as an outcome's own image, byte for byte.
    expect(imageChannel(wire.sent[1])).toEqual({ outcomes: 1, userTurns: 0, bytes: true, asText: false });
    const receipt = await read(runId);
    const check = receipt.actions.find((action) => action.tool === "look_at_map");
    expect({ status: check?.status, automatic: check?.automatic, name: check?.render?.mapName, image: check?.render?.image }).toEqual({
      status: "succeeded", automatic: undefined, name: "Checked", image: RENDERED,
    });
    expect(receipt.provenance?.reported).toEqual(["gpt-6-astra"]);
  });

  it("an automatic check rides the user turn's image field under the bound choice", async () => {
    wire.script.push(
      () => responseWire([outputCall("call-rename", "update_map", JSON.stringify({ id: mapId, name: "Renamed" }))], "gpt-6-astra"),
      () => responseWire([outputText("Renamed it.")], "gpt-6-astra"),
      () => responseWire([outputText("The title now reads Renamed.")], "gpt-6-astra"),
    );
    const runId = await reserve();
    await (await post({ runId, message: "Rename it.", history: [], choice: CHOICE, context: builder() })).text();
    expect(wire.sent).toHaveLength(3);
    expect(pairs()).toEqual([BOUND, BOUND, BOUND]);
    // This one is a user turn, not an outcome: the other seam entirely.
    expect(imageChannel(wire.sent[2])).toEqual({ outcomes: 0, userTurns: 1, bytes: true, asText: false });
    const receipt = await read(runId);
    const check = receipt.actions.find((action) => action.tool === "look_at_map");
    expect({
      status: check?.status, automatic: check?.automatic, name: check?.render?.mapName, image: check?.render?.image,
      observation: check?.observation?.state, said: check?.observation?.text,
    }).toEqual({
      status: "succeeded", automatic: true, name: "Renamed", image: RENDERED,
      observation: "captured", said: "The title now reads Renamed.",
    });
    expect(receipt.provenance?.reported).toEqual(["gpt-6-astra"]);
  });

  it("a provider failure while the image is read keeps the render and records the observation failed", async () => {
    wire.script.push(
      () => responseWire([outputCall("call-rename", "update_map", JSON.stringify({ id: mapId, name: "Renamed" }))], "gpt-6-astra"),
      () => responseWire([outputText("Renamed it.")], "gpt-6-astra"),
      // The image-bearing request is the one that fails.
      () => sse([{ type: "response.failed", response: { id: "response", status: "failed", model: "gpt-6-astra", output: [] } }]),
    );
    const runId = await reserve();
    await (await post({ runId, message: "Rename it.", history: [], choice: CHOICE, context: builder() })).text();
    expect(wire.sent).toHaveLength(3);
    const workAtFailure = productWork().length;
    const maps = allMaps(testAccountScope()).length;
    const receipt = await read(runId);
    const check = receipt.actions.find((action) => action.tool === "look_at_map");
    expect({
      state: receipt.state, error: receipt.error?.code,
      // The render happened and is kept as it happened.
      render: { status: check?.status, name: check?.render?.mapName, image: check?.render?.image },
      // The observation is a separate fact, and it failed.
      observation: { state: check?.observation?.state, reason: check?.observation?.reason, text: check?.observation?.text },
      // No other model answered in its place, and the image was never text.
      reported: receipt.provenance?.reported,
      channel: imageChannel(wire.sent[2]),
      // Nothing was dispatched after the failure.
      workAfter: productWork().length - workAtFailure,
      maps: allMaps(testAccountScope()).length - maps,
    }).toEqual({
      state: "failed", error: "assistant_provider",
      render: { status: "succeeded", name: "Renamed", image: RENDERED },
      observation: { state: "interrupted", reason: "failed", text: undefined },
      reported: ["gpt-6-astra"],
      channel: { outcomes: 0, userTurns: 1, bytes: true, asText: false },
      workAfter: 0, maps: 0,
    });
    expect(pairs()).toEqual([BOUND, BOUND, BOUND]);
  });
});
