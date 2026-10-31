import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { createMap } from "@/lib/map-service";
import { authenticateSession, createApiToken, issueSession } from "@/lib/auth/credentials";
import { issueSignInLink } from "@/lib/auth/admin";
import { getAccount } from "@/lib/metadata/accounts";
import { testAccountScope } from "@/lib/test-support/accounts";
import { assistantAccountEndForTests, drainAssistantWork } from "../retained-work";
import { assistantRuns } from "../runs";
import { pendingActions } from "../pending";
import { dispatchAssistantTestRoute } from "../testing/route-dispatch";
import { outputCall, outputText, responseWire } from "../testing/wire";
import { removeOwnKey, setOwnKey } from "./change";

/**
 * A key change against real turns: the route, the run and parked stores and the
 * SDK client are real, the network is a stand-in that can hold a request open.
 */

const origin = "http://127.0.0.1:3217";
const FIRST = "sk-first-key-of-ada-000000000000", SECOND = "sk-second-key-of-ada-00000000000", OTHER = "sk-key-of-bea-00000000000000000";
interface Seen { key: string; run: number }
let dir: string, seen: Seen[] = [], holding: (() => void)[] = [], reply: (key: string) => Response | Promise<Response>;

beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-key-change-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  vi.stubEnv("PORT", "3217");
  closeMetadataDb(); resetQueryInstance(); assistantRuns.resetForTests(); pendingActions.resetForTests();
  seen = []; holding = []; reply = () => responseWire([outputText("Done.")]);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (new URL(request.url).origin === origin) return dispatchAssistantTestRoute(request);
    const key = new Headers(init?.headers ?? request.headers).get("authorization")!.replace("Bearer ", "");
    seen.push({ key, run: seen.length });
    return reply(key);
  });
});
afterEach(async () => { for (const go of holding.splice(0)) go(); closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

/** A request held open until released or until the client gives up on it. */
function held(signalled: { signal?: AbortSignal | null }, then: () => Response): Promise<Response> {
  return new Promise((resolve, reject) => {
    holding.push(() => resolve(then()));
    signalled.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
}
function person(id: string) {
  const db = metadataDb();
  const scope = testAccountScope(db, id);
  const context = authenticateSession(issueSession(getAccount(id, db)!, db, Date.now()).secret, db)!;
  const token = createApiToken(context, "Route fixture", db).secret;
  const call = (url: string, init: RequestInit = {}) => dispatchAssistantTestRoute(new Request(`${origin}${url}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }));
  const json = { "content-type": "application/json" };
  return {
    scope, context,
    async turn(message = "Work.", context_?: unknown) {
      const runId = (await (await call("/api/assistant/runs", { method: "POST" })).json() as { id: string }).id;
      const response = await call("/api/assistant/messages", { method: "POST", headers: json, body: JSON.stringify({ runId, message, history: [], ...(context_ ? { context: context_ } : {}) }) });
      return { runId, response };
    },
    resolve: (pending: string) => call("/api/assistant/messages", { method: "POST", headers: json, body: JSON.stringify({ resolution: { pending, approved: true } }) }),
    receipt: async (runId: string) => await (await call(`/api/assistant/runs/${runId}`)).json() as { state: string; error?: { code: string; message: string }; pending?: { id: string } },
    pending: async () => (await (await call("/api/assistant/pending")).json() as { pending: { id: string; runId: string }[] }).pending,
  };
}
const lines = async (response: Response) => (await response.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; reason?: string; code?: string });
const until = (done: () => boolean) => vi.waitFor(() => { if (!done()) throw new Error("not yet"); });
const CHANGED = { code: "assistant_key_changed", message: "Your API key changed since this turn began. Send a new message." };

describe("replacing a key", () => {
  it("uses the new key on the next turn", async () => {
    const ada = person("ada");
    setOwnKey("ada", "openai", FIRST);
    await lines((await ada.turn()).response);
    setOwnKey("ada", "openai", SECOND);
    await lines((await ada.turn()).response);
    expect(seen.map((request) => request.key)).toEqual([FIRST, SECOND]);
  });

  it("ends an old turn held open while a new turn runs on the new key and survives", async () => {
    const ada = person("ada");
    setOwnKey("ada", "openai", FIRST);
    reply = () => { throw new Error("replaced below"); };
    let aborted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      if (new URL(request.url).origin === origin) return dispatchAssistantTestRoute(request);
      const key = new Headers(init?.headers ?? request.headers).get("authorization")!.replace("Bearer ", "");
      seen.push({ key, run: seen.length });
      init?.signal?.addEventListener("abort", () => { if (key === FIRST) aborted = true; }, { once: true });
      return held({ signal: init?.signal }, () => responseWire([outputText(`Answered on ${key === SECOND ? "the second" : "the first"} key.`)]));
    });
    const old = await ada.turn();
    await until(() => seen.length === 1);

    setOwnKey("ada", "openai", SECOND);
    await until(() => aborted);
    const fresh = await ada.turn();
    await until(() => seen.length === 2);
    expect(seen.map((request) => request.key)).toEqual([FIRST, SECOND]);

    expect((await lines(old.response)).at(-1)).toMatchObject({ type: "done", reason: "interrupted" });
    expect(await ada.receipt(old.runId)).toMatchObject({ state: "interrupted", error: CHANGED });
    expect((await ada.receipt(fresh.runId)).state).toBe("running");

    for (const go of holding.splice(0)) go();
    expect((await lines(fresh.response)).filter((event) => event.type === "error")).toEqual([]);
    expect(await ada.receipt(fresh.runId)).toMatchObject({ state: "completed" });
  });

  it("leaves another account's turn alone", async () => {
    const bea = person("bea");
    person("ada");
    setOwnKey("ada", "openai", FIRST);
    setOwnKey("bea", "openai", OTHER);
    reply = () => new Promise<Response>((resolve) => { holding.push(() => resolve(responseWire([outputText("Done.")]))); });
  const turn = await bea.turn();
    await until(() => holding.length === 1);
    expect(removeOwnKey("ada")).toBe(true);
    expect((await bea.receipt(turn.runId)).state).toBe("running");
    for (const go of holding.splice(0)) go();
    await lines(turn.response);
    expect(await bea.receipt(turn.runId)).toMatchObject({ state: "completed" });
  });

  it("does not end what is running on the instance's key when a first key is added", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-instance-key-from-the-server");
    vi.stubEnv("OPENAI_BASE_URL", "https://proxy.instance.test/v1");
    const ada = person("ada");
    reply = () => new Promise<Response>((resolve) => { holding.push(() => resolve(responseWire([outputText("Done.")]))); });
    const turn = await ada.turn();
    await until(() => holding.length === 1);
    setOwnKey("ada", "openai", FIRST);
    expect((await ada.receipt(turn.runId)).state).toBe("running");
    for (const go of holding.splice(0)) go();
    await lines(turn.response);
    expect(await ada.receipt(turn.runId)).toMatchObject({ state: "completed" });
    expect(seen[0].key).toBe("sk-instance-key-from-the-server");
  });
});

describe("removing a key", () => {
  it("interrupts a running turn before its next provider request", async () => {
    const ada = person("ada");
    const map = createMap(ada.scope, "Mine");
    setOwnKey("ada", "openai", FIRST);
    // The first reply calls a tool; the key goes while that request is open.
    reply = () => new Promise<Response>((resolve) => {
      holding.push(() => resolve(responseWire([outputCall("call-1", "list_maps", "{}")])));
    });
    const turn = await ada.turn("Work.", { page: "builder", mapId: map.id, selectedLayerId: null });
    await until(() => holding.length === 1);
    expect(removeOwnKey("ada")).toBe(true);
    for (const go of holding.splice(0)) go();
    expect((await lines(turn.response)).at(-1)).toMatchObject({ type: "done", reason: "interrupted" });
    expect(seen).toHaveLength(1);
    expect(await ada.receipt(turn.runId)).toMatchObject({ state: "interrupted", error: CHANGED });
  });

  it("ends a parked run, whose resolution answers that the key changed, and starts nothing", async () => {
    const ada = person("ada");
    const map = createMap(ada.scope, "Mine");
    setOwnKey("ada", "openai", FIRST);
    reply = () => responseWire([outputCall("call-publish", "publish_map", JSON.stringify({ id: map.id }))]);
    const turn = await ada.turn("Publish it.", { page: "builder", mapId: map.id, selectedLayerId: null });
    await lines(turn.response);
    const [parked] = await ada.pending();
    expect(parked.runId).toBe(turn.runId);
    expect(removeOwnKey("ada")).toBe(true);
    expect(await ada.pending()).toEqual([]);
    const requests = seen.length;

    const resolved = await ada.resolve(parked.id);
    expect(resolved.status).toBe(409);
    expect(await resolved.json()).toMatchObject({ error: CHANGED });
    expect(seen).toHaveLength(requests);
    expect(await ada.receipt(turn.runId)).toMatchObject({ state: "interrupted", error: CHANGED });
  });

  it("is harmless twice, and a second removal ends nothing begun since", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-instance-key-from-the-server");
    const ada = person("ada");
    setOwnKey("ada", "openai", FIRST);
    expect(removeOwnKey("ada")).toBe(true);
    reply = () => new Promise<Response>((resolve) => { holding.push(() => resolve(responseWire([outputText("Done.")]))); });
    const turn = await ada.turn();
    await until(() => holding.length === 1);
    expect(removeOwnKey("ada")).toBe(false);
    expect((await ada.receipt(turn.runId)).state).toBe("running");
    for (const go of holding.splice(0)) go();
    await lines(turn.response);
  });
});

it("makes no further request once another process has removed the key", async () => {
  const ada = person("ada");
  const map = createMap(ada.scope, "Mine");
  setOwnKey("ada", "openai", FIRST);
  // As the recovery script does: the row goes on another connection, and this
  // server is told nothing.
  reply = () => {
    metadataDb().prepare("DELETE FROM assistant_keys WHERE account_id = 'ada'").run();
    return responseWire([outputCall("call-1", "list_maps", "{}")]);
  };
  const turn = await ada.turn("Work.", { page: "builder", mapId: map.id, selectedLayerId: null });
  const events = await lines(turn.response);
  expect(events.filter((event) => event.type === "error")).toEqual([expect.objectContaining({ code: "assistant_key_changed" })]);
  expect(seen).toHaveLength(1);
  expect(await ada.receipt(turn.runId)).toMatchObject({ state: "failed", error: CHANGED });
});

it("stops what the key is paying for when an admin issues a sign-in link", async () => {
  const admin = person("admin"), ada = person("ada");
  metadataDb().prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  setOwnKey("ada", "openai", FIRST);
  reply = () => new Promise<Response>((resolve) => { holding.push(() => resolve(responseWire([outputText("Done.")]))); });
  const turn = await ada.turn();
  await until(() => holding.length === 1);
  issueSignInLink(admin.context, "ada");
  for (const go of holding.splice(0)) go();
  await turn.response.text();
  const state = assistantRuns.entriesForTests("ada");
  expect(state).toContain(turn.runId);
  expect(assistantRuns.read(testAccountScope(metadataDb(), "ada"), turn.runId)).toMatchObject({ state: "interrupted", error: CHANGED });
});

it("keeps nothing about a changed key once the account's work is drained", async () => {
  person("ada");
  setOwnKey("ada", "openai", FIRST);
  expect(removeOwnKey("ada")).toBe(true);
  expect(assistantAccountEndForTests("ada")).toBeGreaterThan(0);
  await drainAssistantWork("ada");
  expect(assistantAccountEndForTests("ada")).toBeUndefined();
});
