import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { AssistantRunStore, assistantRuns } from "./runs";
import { RECOVERY_LIMITS } from "./recovery-data";
import { pendingActions } from "./pending";
import { stubProvider } from "./providers/stub";
import type { ModelProvider } from "./provider";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";

/**
 * Where the judgement sits in the run's lifecycle (` `): a first
 * submission's choice is judged **before** the run binds and **before**
 * the supersession a message may carry, so a refused submission leaves
 * the reservation exactly as it found it and the person can correct
 * their message and send it again.
 *
 * Every claim of absence here is paired with the case that shows the
 * mechanism works — the conflict a bound run really does raise, the
 * supersession an accepted message really does perform — because an
 * absence measured with a broken instrument is not an absence.
 */

const origin = "http://127.0.0.1:3214";
const factory = vi.hoisted(() => ({ provider: null as ModelProvider | null, calls: 0 }));
vi.mock("@/lib/assistant/factory", () => ({ createProvider: () => { factory.calls += 1; return factory.provider; } }));

let dir: string;
beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-bind-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  vi.stubEnv("PORT", "3214");
  vi.stubEnv("OPENAI_API_KEY", "fixture-never-sent");
  vi.stubEnv("DEZFIL_AI_PROVIDER", "openai");
  vi.stubEnv("DEZFIL_AI_MODELS_OPENAI", "gpt-6-astra");
  closeMetadataDb(); resetQueryInstance(); assistantRuns.resetForTests(); pendingActions.resetForTests();
  factory.provider = stubProvider([{ text: "Done.", toolCalls: [] }]); factory.calls = 0;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => dispatchAssistantTestRoute(input instanceof Request ? input : new Request(String(input), init)));
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

const reserve = async () => (await (await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/runs`, { method: "POST" }))).json() as { id: string }).id;
const send = (body: Record<string, unknown>) => dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/messages`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));
const readRun = async (id: string) => await (await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/runs/${id}`))).json() as { state: string; actions: unknown[] };
const errorOf = async (response: Response) => (await response.json() as { error: { code: string } }).error.code;

describe("a refused first submission leaves the reservation as it was", () => {
  it("the reservation is unbound: a different message afterwards is accepted, where a bound one conflicts", async () => {
    const refused = await reserve();
    expect(await errorOf(await send({ runId: refused, message: "First wording.", history: [], choice: { model: "gpt-5.6-sol" } }))).toBe("assistant_model_not_offered");
    // Different input under the same identity. If the refused submission had
    // bound, this is the conflict the run store raises.
    const second = await send({ runId: refused, message: "Second wording.", history: [], choice: { model: "gpt-6-astra" } });
    expect(second.status).toBe(200);
    await second.text();

    // The instrument: an accepted submission really does bind, and a
    // different one under that identity really does conflict.
    factory.provider = stubProvider([{ text: "Done.", toolCalls: [] }]);
    const bound = await reserve();
    await (await send({ runId: bound, message: "First wording.", history: [] })).text();
    expect(await errorOf(await send({ runId: bound, message: "Second wording.", history: [] }))).toBe("assistant_run_conflict");
  });

  it("no provider is built, the run store is never written, and release still works afterwards", async () => {
    const id = await reserve();
    const writes = (["bind", "admit", "record", "release", "resume", "cancel", "finish", "fail"] as const)
      .map((name) => [name, vi.spyOn(assistantRuns, name)] as const);
    expect(await errorOf(await send({ runId: id, message: "Work.", history: [], choice: { effort: "nonsense" } }))).toBe("assistant_effort_not_offered");
    for (const [name, spy] of writes) expect([name, spy.mock.calls.length]).toEqual([name, 0]);
    expect(factory.calls).toBe(0);
    const still = await readRun(id);
    expect(still.state).toBe("reserved");
    expect(still.actions).toEqual([]);

    // Its release is unchanged: the reservation is still the person's to give back.
    for (const [, spy] of writes) spy.mockRestore();
    expect((await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/runs/${id}`, { method: "DELETE" }))).status).toBe(200);
    expect((await readRun(id)).state).toBe("unavailable");
  });

  it("its expiry is unchanged, because nothing rewrote when it was reserved", () => {
    // The reservation's clock is set once, at the reservation, and the
    // refusal path above never writes to the store at all. The boundary
    // itself, at the documented bound:
    let clock = 1_000_000;
    const store = new AssistantRunStore(() => clock);
    const id = store.reserve().id;
    clock += RECOVERY_LIMITS.reservationMs - 1;
    expect(store.read(id).state).toBe("reserved");
    clock += 1;
    expect(store.read(id).state).toBe("unavailable");
  });
});

describe("the judgement precedes the supersession a message carries", () => {
  async function parkAConfirmation(): Promise<{ runId: string; pendingId: string }> {
    const mapId = (await (await dispatchAssistantTestRoute(new Request(`${origin}/api/maps`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Parked" }),
    }))).json() as { id: string }).id;
    factory.provider = stubProvider([{ text: "", toolCalls: [{ id: "call-publish", name: "publish_map", args: { id: mapId } }] }, { text: "Done.", toolCalls: [] }]);
    const runId = await reserve();
    await (await send({ runId, message: "Publish it.", history: [], context: { page: "builder", mapId, selectedLayerId: null } })).text();
    const listed = await (await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/pending`))).json() as { pending: { id: string; runId: string }[] };
    const parked = listed.pending.find((p) => p.runId === runId);
    expect(parked).toBeDefined();
    return { runId, pendingId: parked!.id };
  }
  const isPending = async (pendingId: string) => ((await (await dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/pending`))).json() as { pending: { id: string }[] }).pending.some((p) => p.id === pendingId));

  it("a refused message does not abandon the confirmation it names, and an accepted one does", async () => {
    const { runId: parkedRun, pendingId } = await parkAConfirmation();
    expect(await isPending(pendingId)).toBe(true);

    const refused = await reserve();
    expect(await errorOf(await send({ runId: refused, message: "Never mind.", history: [], supersedes: pendingId, choice: { model: "gpt-5.6-sol" } }))).toBe("assistant_model_not_offered");
    expect(await isPending(pendingId)).toBe(true);
    expect((await readRun(parkedRun)).state).toBe("awaiting_confirmation");

    // The instrument: an accepted message with the same supersedes does abandon it.
    factory.provider = stubProvider([{ text: "Moved on.", toolCalls: [] }]);
    const accepted = await reserve();
    await (await send({ runId: accepted, message: "Never mind.", history: [], supersedes: pendingId, choice: { model: "gpt-6-astra" } })).text();
    expect(await isPending(pendingId)).toBe(false);
  });
});
