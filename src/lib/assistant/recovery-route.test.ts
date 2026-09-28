import { authenticatedRequest } from "./testing/account";
import { authenticatedRoute } from "@/lib/assistant/testing/account";
import { pendingActions } from "./pending";
import { assistantRuns } from "./runs";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { GET as listMaps, POST as createMap } from "@/app/api/maps/route";
import { GET as catalogue } from "@/app/api/catalogue/tables/route";
import { POST as messageHandler } from "@/app/api/assistant/messages/route";
import type { ModelProvider } from "./provider";

const message = authenticatedRoute(messageHandler);

const factory = vi.hoisted(() => ({ provider: null as ModelProvider | null, exchanges: 0, calls: 0 }));
vi.mock("@/lib/assistant/factory", () => ({ createProvider: () => { factory.calls++; return factory.provider; } }));
const routes = import.meta.glob("/src/app/api/assistant/**/route.ts", { eager: true }) as Record<string, Record<string, (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>>>;
let dir: string;
let mutationId: string | undefined;
const origin = "http://localhost:3201";
async function api(url: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const request = authenticatedRequest(new Request(origin + url, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
  if (url === "/api/assistant/messages") return message(request);
  const exact = routes[`/src/app${url}/route.ts`];
  const id = url.split("/").at(-1)!;
  const route = exact ?? routes[`/src/app${url.slice(0, url.lastIndexOf("/"))}/[id]/route.ts`];
  return route?.[method]?.(request, { params: Promise.resolve({ id }) }) ?? new Response(null, { status: 404 });
}
async function reserve() {
  const response = await api("/api/assistant/runs", {}, "POST");
  expect(response.status).toBe(201);
  return (await response.json()).id as string;
}
async function maps() { return (await (await listMaps(new Request(origin + "/api/maps"))).json()) as { id: string; name: string }[]; }
function provider(gate = false): ModelProvider {
  return { id: "scripted", model: "recovery-real-routes", exchange() {
    factory.exchanges++;
    return {
      async send() { return { text: "", toolCalls: [{ id: randomUUID(), name: "create_map", args: { name: "One requested map" } }] }; },
      async continueWith(outcomes) {
        if (gate && !mutationId) {
          mutationId = JSON.parse(outcomes[0].body).id;
          return { text: "", toolCalls: [{ id: randomUUID(), name: "delete_map", args: { id: mutationId } }] };
        }
        return { text: "Created", toolCalls: [] };
      },
    };
  } };
}
beforeEach(async () => {
  assistantRuns.resetForTests(); pendingActions.resetForTests();
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-recovery-test-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir); vi.stubEnv("ANTHROPIC_API_KEY", "fixture-never-sent");
  closeMetadataDb(); factory.calls = 0; factory.exchanges = 0; mutationId = undefined;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    if (url.pathname === "/api/maps" && req.method === "POST") return createMap(req);
    if (url.pathname === "/api/catalogue/tables") return catalogue(req);
    throw new Error(`Unexpected test route: ${req.method} ${url.pathname}`);
  });
});
afterEach(async () => { closeMetadataDb(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); });

it("a lost mutation response retried with its identity creates one real map", async () => {
  factory.provider = provider();
  const id = await reserve();
  const submission = { runId: id, message: "Create one map", history: [] };
  // Discard every response event. The independent map route establishes that
  // a mutation happened, without learning its identity from that response.
  await (await api("/api/assistant/messages", submission)).text();
  expect(await maps()).toHaveLength(1);
  await (await api("/api/assistant/messages", submission)).text();
  expect(await maps()).toHaveLength(1);
  expect(factory.exchanges).toBe(1);
  const recovered = await api(`/api/assistant/runs/${id}`);
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({ id, state: "completed" });
});

it("a pending action is readable without having received its stream event", async () => {
  factory.provider = provider(true);
  const id = await reserve();
  await (await api("/api/assistant/messages", { runId: id, message: "Create then delete" })).text();
  const resources = await maps(); expect(resources).toHaveLength(1);
  const response = await api("/api/assistant/pending");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.pending).toContainEqual(expect.objectContaining({ runId: id, tool: "delete_map", args: { id: resources[0].id } }));
  expect(factory.exchanges).toBe(1);
});

it("reservation performs no work and refuses old-style, unknown and conflicting submissions", async () => {
  factory.provider = provider();
  const id = await reserve();
  expect(factory.calls).toBe(0); expect(await maps()).toHaveLength(0);
  for (const [body, status, code] of [
    [{ message: "Create" }, 400, "assistant_reservation_required"],
    [{ runId: "unknown", message: "Create" }, 404, "assistant_run_unavailable"],
  ] as const) {
    const response = await api("/api/assistant/messages", body);
    expect(response.status).toBe(status); expect((await response.json()).error.code).toBe(code);
  }
  expect(factory.calls).toBe(0);
  await (await api("/api/assistant/messages", { runId: id, message: "Create", history: [] })).text();
  const conflicting = await api("/api/assistant/messages", { runId: id, message: "Another", history: [] });
  expect(conflicting.status).toBe(409); expect((await conflicting.json()).error.code).toBe("assistant_run_conflict");
  expect(factory.exchanges).toBe(1); expect(await maps()).toHaveLength(1);
});

it("concurrent identical submissions observe a running reservation before its first event", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  factory.provider = { id: "held", model: "scripted", exchange() {
    factory.exchanges++;
    return {
      async send() { entered(); await hold; return { text: "Held text", toolCalls: [{ id: randomUUID(), name: "create_map", args: { name: "Concurrent map" } }] }; },
      async continueWith() { return { text: "Done", toolCalls: [] }; },
    };
  } };
  const id = await reserve();
  const submission = { runId: id, message: "Create one", history: [{ role: "user", text: "Prior" }] };
  const first = await api("/api/assistant/messages", submission);
  await entry;
  try {
    const observations = await Promise.all(Array.from({ length: 6 }, () => api("/api/assistant/messages", submission)));
    for (const response of observations) {
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toMatchObject({ id, state: "running", text: "", actions: [] });
    }
    expect(factory.exchanges).toBe(1); expect(await maps()).toHaveLength(0);
  } finally { release(); }
  await first.text();
  expect(await maps()).toHaveLength(1);
  const repeated = await api("/api/assistant/messages", { history: [{ text: "Prior", role: "user" }], message: "Create one", runId: id });
  expect(await repeated.json()).toMatchObject({ id, state: "completed" });
  expect(factory.exchanges).toBe(1);
});

it("eight occupied slots refuse admission and release/abandon expose capacity without replay", async () => {
  factory.provider = provider(true);
  const parked = await reserve();
  await (await api("/api/assistant/messages", { runId: parked, message: "Create then delete" })).text();
  const ids = await Promise.all(Array.from({ length: 7 }, reserve));
  const full = await api("/api/assistant/runs", {});
  expect(full.status).toBe(409); expect((await full.json()).error.code).toBe("assistant_capacity");
  for (const id of ids) expect(await (await api(`/api/assistant/runs/${id}`)).json()).toMatchObject({ id, state: "reserved" });
  const open = (await (await api("/api/assistant/pending")).json()).pending;
  expect(open).toHaveLength(1);
  expect(open[0]).toMatchObject({ runId: parked, args: { id: (await maps())[0].id } });
  expect((await api(`/api/assistant/runs/${ids[0]}`, undefined, "DELETE")).status).toBe(200);
  await reserve();
  expect((await api(`/api/assistant/runs/${parked}`, undefined, "DELETE")).status).toBe(200);
  expect((await (await api("/api/assistant/pending")).json()).pending).toEqual([]);
  expect(await (await api(`/api/assistant/runs/${parked}`)).json()).toMatchObject({ state: "interrupted" });
  expect((await api("/api/assistant/messages", { resolution: { pending: open[0].id, approved: true } })).status).toBe(409);
  await reserve(); expect(factory.exchanges).toBe(1); expect(await maps()).toHaveLength(1);
});

it("the 128 KiB submission boundary refuses oversized JSON before provider creation", async () => {
  factory.provider = provider(); const id = await reserve();
  const body = { runId: id, message: "", history: [] };
  body.message = "x".repeat(131_072 - Buffer.byteLength(JSON.stringify(body)));
  const tooLarge = await api("/api/assistant/messages", { ...body, message: body.message + "x" });
  expect(tooLarge.status).toBe(413); expect((await tooLarge.json()).error.code).toBe("assistant_submission_too_large");
  expect(factory.calls).toBe(0);
  const exact = await api("/api/assistant/messages", body); expect(exact.status).toBe(200); await exact.text();
  expect(factory.exchanges).toBe(1);
});

it("oversized proposed actions refuse before the real mutation route", async () => {
  factory.provider = { id: "oversized", model: "scripted", exchange: () => ({
    async send() { return { text: "", toolCalls: [{ id: randomUUID(), name: "create_map", args: { name: "x".repeat(1_048_576) } }] }; },
    async continueWith() { throw new Error("No continuation permitted"); },
  }) };
  const id = await reserve();
  const response = await api("/api/assistant/messages", { runId: id, message: "Huge" });
  expect(await response.text()).toContain("assistant_recovery_limit");
  expect(await maps()).toHaveLength(0);
  expect(await (await api(`/api/assistant/runs/${id}`)).json()).toMatchObject({ state: "failed", actions: [], error: { code: "assistant_recovery_limit" } });
});
