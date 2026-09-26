import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { assistantRuns } from "./runs";
import { pendingActions } from "./pending";
import { stubProvider, type ScriptEntry } from "./providers/stub";
import type { ModelProvider } from "./provider";
import type { AssistantEvent } from "./loop";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";
import { POST as reserve } from "@/app/api/assistant/runs/route";
import { POST as message } from "@/app/api/assistant/messages/route";
import { GET as recovery } from "@/app/api/assistant/runs/[id]/route";

/**
 * ``: an outcome that cannot be established ends the turn however it arose.
 * A thrown dispatch failure was already terminal; a mutation whose response
 * carries a 5xx status is exactly as unknown, and until this suite it left
 * the batch and the model exchange running, so a write whose first outcome
 * was unknown could be repeated inside the same turn and the run reported
 * as done (` `, the phase's exit).
 *
 * Everything below runs through the real operation registry, the real
 * confirmation gate, the real tool executor, the real loop and the real
 * receipt store; only the model and the one failing product response are
 * fixtures. The two controls are the thrown-failure case, which must not
 * move, and a read-only operation's 5xx, which (` `) made a refusal that
 * the turn survives.
 */

const factory = vi.hoisted(() => ({ provider: null as ModelProvider | null }));
vi.mock("@/lib/assistant/factory", () => ({ createProvider: () => factory.provider }));

const origin = "http://127.0.0.1:3391";
const FAILURE = { error: { code: "internal", message: "The instance ran out of disk while writing the map." } };
let dir: string;
/** What the fixture does to the named product route, and how often it was asked. */
let injected: { path: string; method: string; how: "5xx" | "throw" } | null = null;
const dispatches: { path: string; method: string }[] = [];

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (url: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  new Request(origin + url, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });

beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-uncertain-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  vi.stubEnv("PORT", "3391");
  vi.stubEnv("OPENAI_API_KEY", "fixture-never-sent");
  vi.stubEnv("DEZFIL_AI_PROVIDER", "openai");
  closeMetadataDb(); resetQueryInstance();
  assistantRuns.resetForTests(); pendingActions.resetForTests();
  injected = null; dispatches.length = 0;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const pathname = new URL(request.url).pathname;
    if (!pathname.startsWith("/api/assistant")) dispatches.push({ path: pathname, method: request.method });
    if (injected && injected.path === pathname && injected.method === request.method) {
      if (injected.how === "throw") throw new TypeError("fetch failed");
      return Response.json(FAILURE, { status: 500 });
    }
    return dispatchAssistantTestRoute(request);
  });
});
afterEach(async () => {
  factory.provider = null; closeMetadataDb(); resetQueryInstance();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const call = (name: string, args: Record<string, unknown>) => ({ id: randomUUID(), name, args });
const reply = (text: string, ...toolCalls: ReturnType<typeof call>[]) => ({ text, toolCalls });

async function run(script: ScriptEntry[]) {
  const provider = stubProvider(script);
  factory.provider = provider;
  const id = (await (await reserve()).json()).id as string;
  const response = await message(req("/api/assistant/messages", { runId: id, message: "Work" }));
  expect(response.status).toBe(200);
  const events = (await response.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as AssistantEvent);
  const receipt = await (await recovery(req(`/api/assistant/runs/${id}`), params(id))).json();
  return { events, receipt, provider };
}
const of = <T extends AssistantEvent["type"]>(events: AssistantEvent[], type: T) =>
  events.filter((e): e is Extract<AssistantEvent, { type: T }> => e.type === type);
const creations = () => dispatches.filter((d) => d.path === "/api/maps" && d.method === "POST").length;
/** The turn's shape in one object: how often the write was dispatched, how
 * often the model was asked to continue, how the stream ended and how the
 * run was recorded. */
const shape = (events: AssistantEvent[], receipt: { state: string; error?: { code: string } }, provider: { recording: { exchanges: { outcomes: unknown[] }[] } }) => ({
  creations: creations(),
  continuations: provider.recording.exchanges[0].outcomes.length,
  done: of(events, "done").map((e) => e.reason),
  state: receipt.state,
  error: receipt.error?.code,
});

describe("an uncertain outcome is terminal however it arose", () => {
  it("a mutation answered 5xx dispatches once, ends the run failed with the uncertain code, and asks the model for nothing more", async () => {
    injected = { path: "/api/maps", method: "POST", how: "5xx" };
    const { events, receipt, provider } = await run([
      reply("", call("create_map", { name: "First" })),
      reply("", call("create_map", { name: "Second" })),
      reply("Done."),
    ]);

    // Asserted as one shape so the failure names every fact at once.
    expect(shape(events, receipt, provider)).toEqual({
      creations: 1, continuations: 0, done: [], state: "failed", error: "assistant_action_uncertain",
    });
    expect(of(events, "error")).toEqual([{ type: "error", code: "assistant_action_uncertain", message: ERROR_CATALOGUE.assistant_action_uncertain }]);
    expect(receipt.actions).toEqual([expect.objectContaining({ tool: "create_map", status: "uncertain" })]);

    // The instance's own diagnosis stays in the action's event: it is what a
    // person reading the record has to go on.
    const result = of(events, "tool_result")[0];
    expect(result).toMatchObject({ tool: "create_map", ok: false, outcome: "uncertain", body: FAILURE });
  });

  it("control: a thrown dispatch failure is unchanged, and reaches the pane with the same words", async () => {
    injected = { path: "/api/maps", method: "POST", how: "throw" };
    const { events, receipt, provider } = await run([
      reply("", call("create_map", { name: "First" })),
      reply("", call("create_map", { name: "Second" })),
      reply("Done."),
    ]);

    expect(shape(events, receipt, provider)).toEqual({
      creations: 1, continuations: 0, done: [], state: "failed", error: "assistant_action_uncertain",
    });
    expect(of(events, "error")).toEqual([{ type: "error", code: "assistant_action_uncertain", message: ERROR_CATALOGUE.assistant_action_uncertain }]);
    expect(receipt.actions).toEqual([expect.objectContaining({ tool: "create_map", status: "uncertain" })]);
  });

  it("control: a read-only operation's 5xx is a refusal and the turn runs on to completion", async () => {
    injected = { path: "/api/query", method: "POST", how: "5xx" };
    const { events, receipt, provider } = await run([
      reply("", call("run_sql", { sql: "SELECT 1 AS value" })),
      reply("The query failed."),
    ]);

    expect(dispatches.filter((d) => d.path === "/api/query")).toHaveLength(1);
    expect(provider.recording.exchanges[0].outcomes).toHaveLength(1);
    expect(of(events, "error")).toHaveLength(0);
    expect(of(events, "done")[0]).toEqual({ type: "done", reason: "end" });
    expect(of(events, "tool_result")[0]).toMatchObject({ tool: "run_sql", ok: false, outcome: "refused", body: FAILURE });
    expect(receipt.state).toBe("completed");
    expect(receipt.actions).toEqual([expect.objectContaining({ tool: "run_sql", status: "refused" })]);
  });
});
