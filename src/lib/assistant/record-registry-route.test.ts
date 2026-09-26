import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import type { AssistantEvent } from "./loop";
import type { ModelProvider } from "./provider";
import { stubProvider } from "./providers/stub";
import { pendingActions } from "./pending";
import { assistantRuns } from "./runs";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";

/**
 * A newly registered operation produces its expected entry through the
 * real message route with no pane change: the registry is the generated
 * tool set plus one operation this test registers over an existing
 * documented route, carrying its own display declaration; the record's
 * line for it comes from that declaration alone.
 */

const factory = vi.hoisted(() => ({ provider: null as ModelProvider | null }));
vi.mock("@/lib/assistant/factory", () => ({ createProvider: () => factory.provider }));
vi.mock("@/lib/tools/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./../tools/tools")>();
  const health = actual.buildTools().find((t) => t.name === "check_health")!;
  const registered = { ...health, name: "ping_instance", display: { verb: "Pinged the instance" } };
  return { ...actual, buildTools: () => [...actual.buildTools(), registered] };
});

const origin = "http://localhost:3204";
let dir: string;
beforeEach(async () => {
  assistantRuns.resetForTests(); pendingActions.resetForTests();
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-registry-test-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir); vi.stubEnv("ANTHROPIC_API_KEY", "fixture-never-sent"); vi.stubEnv("PORT", "3204");
  closeMetadataDb(); resetQueryInstance();
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => dispatchAssistantTestRoute(input instanceof Request ? input : new Request(String(input), init)));
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

const api = (url: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  dispatchAssistantTestRoute(new Request(origin + url, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));

describe("a newly registered operation", () => {
  it("produces its declared entry through the real route", async () => {
    factory.provider = stubProvider([
      { text: "", toolCalls: [{ id: "ping-1", name: "ping_instance", args: {} }] },
      { text: "Alive", toolCalls: [] },
    ]);
    const runId = (await (await api("/api/assistant/runs", {}, "POST")).json()).id as string;
    const text = await (await api("/api/assistant/messages", { runId, message: "Ping" })).text();
    const events = text.trim().split("\n").map((line) => JSON.parse(line) as AssistantEvent);
    const result = events.find((e): e is Extract<AssistantEvent, { type: "tool_result" }> => e.type === "tool_result")!;
    expect(result).toMatchObject({ tool: "ping_instance", ok: true, label: "Pinged the instance" });
    expect(result.subject).toBeUndefined();
    const receipt = await (await api(`/api/assistant/runs/${runId}`)).json() as { actions: { tool: string; label?: string }[] };
    expect(receipt.actions).toEqual([expect.objectContaining({ tool: "ping_instance", status: "succeeded", label: "Pinged the instance" })]);
  });
});
