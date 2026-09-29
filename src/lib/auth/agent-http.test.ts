import { GET as cascadeRead } from "@/app/api/recipes/[id]/runs/[runId]/route";
import { POST as cascadeCancel } from "@/app/api/recipes/[id]/runs/[runId]/cancel/route";
import { createCascade } from "@/lib/metadata/cascades";
import { insertJob } from "@/lib/metadata/jobs";
import { GET as jobRead } from "@/app/api/operations/runs/[id]/route";
import { POST as jobCancel } from "@/app/api/operations/runs/[id]/cancel/route";
import { createProject } from "@/lib/metadata/projects";
import { GET as projectRead, PATCH as projectUpdate } from "@/app/api/projects/[id]/route";
import { GET as projectMembersRead } from "@/app/api/projects/[id]/members/route";
import { createRecipe, addStep } from "@/lib/metadata/recipes";
import { GET as workflowRead } from "@/app/api/recipes/[id]/route";
import { GET as workflowStepRead } from "@/app/api/recipes/[id]/steps/[stepId]/route";
import { insertConnection } from "@/lib/metadata/connections";
import { GET as connectionSnapshots } from "@/app/api/connections/postgis/[id]/snapshots/route";
import { GET as connectionsRead } from "@/app/api/connections/postgis/route";
import { insertTable } from "@/lib/metadata/tables";
import { GET as datasetFeatures } from "@/app/api/tables/[name]/features/route";
import { GET as datasetsRead } from "@/app/api/tables/route";
import { GET as historyRead } from "@/app/api/maps/[id]/history/route";
import { POST as historyUndo } from "@/app/api/maps/[id]/undo/route";
import { POST as historyRedo } from "@/app/api/maps/[id]/redo/route";
import { GET as layerRead, PATCH as layerUpdate } from "@/app/api/layers/[id]/route";
import { defaultStyle } from "@/lib/style/defaults";
import { accountScope } from "./scope";
import { GET as accountRead } from "@/app/api/account/route";
import { GET as usersRead } from "@/app/api/users/route";
import { PATCH as userAccess } from "@/app/api/users/[id]/route";
import { GET as mapRead, PATCH as mapUpdate } from "@/app/api/maps/[id]/route";
import { GET as mapDependencies } from "@/app/api/maps/[id]/dependencies/route";
import { createMap } from "@/lib/map-service";
import type { AssistantEvent } from "@/lib/assistant/loop";
import { authFailure, requireRequestAuth } from "./http";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { assistantRuns } from "@/lib/assistant/runs";
import { pendingActions } from "@/lib/assistant/pending";
import { stubProvider } from "@/lib/assistant/providers/stub";
import type { ModelProvider } from "@/lib/assistant/provider";
import { POST as mcp } from "@/app/api/mcp/route";
import { POST as reserve } from "@/app/api/assistant/runs/route";
import { GET as read, DELETE as release } from "@/app/api/assistant/runs/[id]/route";
import { POST as cancel } from "@/app/api/assistant/runs/[id]/cancel/route";
import { POST as message } from "@/app/api/assistant/messages/route";
import { GET as pending } from "@/app/api/assistant/pending/route";
import { GET as status } from "@/app/api/assistant/route";
import { GET as policy } from "@/app/api/assistant/policy/route";
import { createFirstAccount } from "./accounts";
import { authenticateSession, createApiToken, revokeApiToken, signOut } from "./credentials";
import { authenticateDelegation, DELEGATION_LIFETIME_MS } from "./delegation";
import { changeAccountAccess, inviteAccount } from "./admin";
import { redeemSignInLink } from "./links";

const factory = vi.hoisted(() => ({ provider: null as ModelProvider | null, calls: 0 }));
vi.mock("@/lib/assistant/factory", () => ({ createProvider: () => { factory.calls++; return factory.provider; } }));
const origin = "http://127.0.0.1:3216", password = "field notebooks at dawn";
let db: Database, admin: Awaited<ReturnType<typeof createFirstAccount>>, member: typeof admin;
let token: ReturnType<typeof createApiToken>, runId: string;
const cookie = (secret = admin.secret) => ({ cookie: `dezfil_session=${secret}` });
function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = cookie()) {
  return socketRequest(new Request(origin + path, { method,
    headers: { origin, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}
const params = () => ({ params: Promise.resolve({ id: runId }) });
const operations = ["status", "policy", "reserve", "read", "release", "cancel", "pending", "message", "mcp"] as const;
function invoke(operation: typeof operations[number], headers: Record<string, string>) {
  if (operation === "status") return (status as (request: Request) => Promise<Response>)(request("/api/assistant", "GET", undefined, headers));
  if (operation === "policy") return policy(request("/api/assistant/policy?page=builder", "GET", undefined, headers));
  if (operation === "reserve") return (reserve as (request: Request) => Promise<Response>)(request("/api/assistant/runs", "POST", undefined, headers));
  if (operation === "read") return read(request(`/api/assistant/runs/${runId}`, "GET", undefined, headers), params());
  if (operation === "release") return release(request(`/api/assistant/runs/${runId}`, "DELETE", undefined, headers), params());
  if (operation === "cancel") return cancel(request(`/api/assistant/runs/${runId}/cancel`, "POST", undefined, headers), params());
  if (operation === "pending") return (pending as (request: Request) => Promise<Response>)(request("/api/assistant/pending", "GET", undefined, headers));
  if (operation === "message") return message(request("/api/assistant/messages", "POST", { runId, message: "Read my account" }, headers));
  return mcp(request("/api/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "auth-proof", version: "1" },
  } }, headers));
}
beforeEach(async () => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  vi.stubEnv("PORT", "3216"); vi.stubEnv("ANTHROPIC_API_KEY", "fixture-never-sent");
  assistantRuns.resetForTests(); pendingActions.resetForTests(); factory.calls = 0;
  factory.provider = stubProvider([{ text: "Read", toolCalls: [] }]);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ tables: [], total: 0, nextAfter: null })));
  admin = await createFirstAccount({ name: "Admin", email: "admin@example.test", password }, db);
  const link = inviteAccount(authenticateSession(admin.secret, db)!, { name: "Member", email: "member@example.test" }, db);
  member = await redeemSignInLink(link.secret, password, db);
  token = createApiToken(authenticateSession(member.secret, db)!, "Member CLI", db);
  const response = await invoke("reserve", cookie()); expect(response.status).toBe(201); runId = (await response.json()).id;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); db.close(); });
function state() {
  return { run: assistantRuns.read(runId), pending: assistantRuns.pending(), rows: ["SELECT * FROM accounts ORDER BY id",
    "SELECT id, account_id, secret_hash, revoked_at FROM auth_sessions ORDER BY id",
    "SELECT id, account_id, name, secret_hash, revoked_at FROM auth_tokens ORDER BY id"].map(sql => db.prepare(sql).all()) };
}
it.each(operations.flatMap(operation => ["anonymous", "invalid", "revoked-session", "revoked-token"].map(mode => ({ operation, mode }))))(
  "refuses $mode at the $operation transport before reads or work", async ({ operation, mode }) => {
    const headers: Record<string, string> = mode === "anonymous" ? {} : cookie();
    if (mode === "invalid") { headers.authorization = "Bearer invalid"; headers["x-dezfil-account-id"] = admin.account.id; headers["x-dezfil-admin"] = "true"; }
    if (mode === "revoked-session") signOut(authenticateSession(admin.secret, db)!, db);
    if (mode === "revoked-token") { revokeApiToken(authenticateSession(member.secret, db)!, token.id, db); headers.authorization = `Bearer ${token.secret}`; }
    const before = state();
    const response = await invoke(operation, headers);
    expect.soft(response.status).toBe(401); expect.soft(response.headers.get("cache-control")).toBe("private, no-store");
    expect.soft(await response.json().catch(() => null)).toMatchObject({ error: { code: "authentication_required" } });
    expect.soft(factory.calls).toBe(0); expect(state()).toEqual(before);
  },
);
it.each(["reserve", "release", "cancel", "message", "mcp"] as const)("refuses a cross-site cookie %s before work", async operation => {
  const before = state(); const response = await invoke(operation, { ...cookie(), origin: "https://unrelated.test" });
  expect.soft(response.status).toBe(403); expect.soft(await response.json().catch(() => null)).toMatchObject({ error: { code: "forbidden" } });
  expect.soft(factory.calls).toBe(0); expect(state()).toEqual(before);
});
it.each(["read", "release", "cancel", "message"] as const)("refuses another account's reservation through %s", async operation => {
  const before = state(); const response = await invoke(operation, { authorization: `Bearer ${token.secret}` });
  expect.soft(response.status).toBe(404); expect.soft(await response.json()).toMatchObject({ error: { code: "assistant_run_unavailable" } });
  expect.soft(factory.calls).toBe(0); expect(state()).toEqual(before);
});

function actualApi() {
  const seen: { path: string; accountId: string; authorization: string; cookie: string | null }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = socketRequest(new Request(input, init));
    try {
      const actor = requireRequestAuth(req), path = new URL(req.url).pathname;
      seen.push({ path, accountId: actor.account.id, authorization: req.headers.get("authorization") ?? "", cookie: req.headers.get("cookie") });
      if (/^\/api\/operations\/runs\/[^/]+(?:\/cancel)?$/.test(path)) {
        const params = { params: Promise.resolve({ id: path.split("/")[4] }) };
        return req.method === "POST" ? jobCancel(req, params) : jobRead(req, params);
      }
      if (/^\/api\/recipes\/[^/]+\/runs\/[^/]+(?:\/cancel)?$/.test(path)) {
        const params = { params: Promise.resolve({ id: path.split("/")[3], runId: path.split("/")[5] }) };
        return req.method === "POST" ? cascadeCancel(req, params) : cascadeRead(req, params);
      }
      if (path === "/api/connections/postgis") return connectionsRead(req);
      if (/^\/api\/connections\/postgis\/[^/]+\/snapshots$/.test(path)) return connectionSnapshots(req, { params: Promise.resolve({ id: path.split("/")[4] }) });
      if (/^\/api\/recipes\/[^/]+$/.test(path)) return workflowRead(req, { params: Promise.resolve({ id: path.split("/")[3] }) });
      if (/^\/api\/recipes\/[^/]+\/steps\/[^/]+$/.test(path)) return workflowStepRead(req, { params: Promise.resolve({ id: path.split("/")[3], stepId: path.split("/")[5] }) });
      if (/^\/api\/projects\/[^/]+$/.test(path)) {
        const params = { params: Promise.resolve({ id: path.split("/")[3] }) };
        return req.method === "PATCH" ? projectUpdate(req, params) : projectRead(req, params);
      }
      if (/^\/api\/projects\/[^/]+\/members$/.test(path)) return projectMembersRead(req, { params: Promise.resolve({ id: path.split("/")[3] }) });
      if (path === "/api/tables") return datasetsRead(req);
      if (/^\/api\/tables\/[^/]+\/features$/.test(path)) return datasetFeatures(req, { params: Promise.resolve({ name: path.split("/")[3] }) });
      if (path === "/api/account") return accountRead(req);
      if (path === "/api/users") return usersRead(req);
      if (path.startsWith("/api/users/")) return userAccess(req, { params: Promise.resolve({ id: path.split("/")[3] }) });
      if (path === "/api/catalogue/tables") return Response.json({ tables: [], total: 0, nextAfter: null });
      if (path === "/api/maps/look") return Response.json({ error: { code: "render_unavailable", message: "No renderer fixture." } }, { status: 503 });
      if (path.startsWith("/api/layers/")) {
        const params = { params: Promise.resolve({ id: path.split("/")[3] }) };
        return req.method === "PATCH" ? layerUpdate(req, params) : layerRead(req, params);
      }
      if (path.startsWith("/api/maps/")) {
        const params = { params: Promise.resolve({ id: path.split("/")[3] }) };
        if (path.endsWith("/dependencies")) return mapDependencies(req, params);
        if (path.endsWith("/history")) return historyRead(req, params);
        if (path.endsWith("/undo")) return historyUndo(req, params);
        if (path.endsWith("/redo")) return historyRedo(req, params);
        return req.method === "PATCH" ? mapUpdate(req, params) : mapRead(req, params);
      }
      throw new Error(`Unexpected fixture route: ${path}`);
    } catch (error) { return authFailure(error); }
  });
  return seen;
}
async function rpc(tool: string, args: Record<string, unknown>, headers: Record<string, string>) {
  const response = await mcp(request("/api/mcp", "POST", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } },
    { ...headers, "mcp-protocol-version": "2025-03-26" }));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  const text = await response.text();
  const json = text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").find(line => line.startsWith("data: "))!.slice(6));
  expect(json.error).toBeUndefined(); return json.result;
}
async function ownReservation(headers: Record<string, string>) {
  const response = await invoke("reserve", headers); expect(response.status).toBe(201); return (await response.json()).id as string;
}
async function send(body: unknown, headers: Record<string, string>): Promise<AssistantEvent[]> {
  const response = await message(request("/api/assistant/messages", "POST", body, headers));
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return (await response.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}
it.each(["cookie", "token"])("MCP %s reads the caller and preserves admin refusals downstream", async mode => {
  const seen = actualApi(), headers = mode === "cookie" ? cookie(member.secret) : { authorization: `Bearer ${token.secret}` };
  const read = await rpc("get_account", {}, headers);
  expect(read).toMatchObject({ isError: false, structuredContent: { result: { account: { id: member.account.id } } } });
  const before = state();
  expect(await rpc("list_users", {}, headers)).toMatchObject({ isError: true, structuredContent: { result: { error: { code: "forbidden" } } } });
  expect(await rpc("update_user_access", { id: member.account.id, isAdmin: true }, headers)).toMatchObject({ isError: true, structuredContent: { result: { error: { code: "forbidden" } } } });
  expect(state()).toEqual(before);
  expect(seen.map(item => item.accountId)).toEqual([member.account.id, member.account.id, member.account.id]);
  expect(seen.every(item => item.cookie === null)).toBe(true);
  expect(seen.every(item => item.authorization.startsWith("Bearer dz_delegation_") && !item.authorization.includes(token.secret))).toBe(true);
  expect((await rpc("list_users", {}, cookie())).isError).toBe(false);
});
it.each(["cookie", "token", "demoted-token"])("assistant %s cannot confirm itself into admin access", async mode => {
  if (mode === "demoted-token") changeAccountAccess(authenticateSession(admin.secret, db)!, member.account.id, { isAdmin: true }, db);
  const seen = actualApi(), headers = mode === "cookie" ? cookie(member.secret) : { authorization: `Bearer ${token.secret}` };
  const provider = stubProvider([
    { text: "", toolCalls: [{ id: "admin-change", name: "update_user_access", args: { id: member.account.id, isAdmin: true } }] },
    { text: "Finished", toolCalls: [] },
  ]); factory.provider = provider;
  const own = await ownReservation(headers);
  const events = await send({ runId: own, message: "Change admin access" }, headers);
  const confirmation = events.find((event): event is Extract<AssistantEvent, { type: "confirm_required" }> => event.type === "confirm_required")!;
  expect(confirmation).toBeDefined();
  const parked = pendingActions.peek(confirmation.id)!;
  expect(parked.accountId).toBe(member.account.id);
  expect(JSON.stringify(parked)).not.toMatch(/dz_(?:token|session|delegation)_/);
  if (mode === "demoted-token") changeAccountAccess(authenticateSession(admin.secret, db)!, member.account.id, { isAdmin: false }, db);
  const before = state().rows;
  const resumed = await send({ resolution: { pending: confirmation.id, approved: true } }, headers);
  expect(resumed).toContainEqual(expect.objectContaining({ type: "tool_result", tool: "update_user_access", ok: false, body: { error: { code: "forbidden", message: "An admin account is required." } } }));
  expect(state().rows).toEqual(before);
  expect(seen.filter(item => item.path === "/api/catalogue/tables")).toHaveLength(2);
  expect(seen.some(item => item.path === "/api/users")).toBe(true);
  expect(seen.some(item => item.path === `/api/users/${member.account.id}`)).toBe(true);
  expect(seen.every(item => item.accountId === member.account.id && item.cookie === null)).toBe(true);
  const retained = JSON.stringify({ recording: provider.recording, receipt: assistantRuns.read(own) });
  expect(retained).not.toContain(token.secret); expect(retained).not.toContain(member.secret); expect(retained).not.toContain("dz_delegation_");
});
it("foreign pending actions cannot be read, resolved or superseded", async () => {
  actualApi(); factory.provider = stubProvider([{ text: "", toolCalls: [{ id: "grant", name: "update_user_access", args: { id: member.account.id, isAdmin: true } }] }]);
  const events = await send({ runId, message: "Grant admin" }, cookie());
  const confirmation = events.find((event): event is Extract<AssistantEvent, { type: "confirm_required" }> => event.type === "confirm_required")!;
  const foreign = { authorization: `Bearer ${token.secret}` }, owned = await ownReservation(foreign);
  expect(await (await invoke("pending", foreign)).json()).toEqual({ pending: [] });
  const before = state(), reserved = assistantRuns.read(owned);
  for (const body of [{ resolution: { pending: confirmation.id, approved: true } }, { runId: owned, message: "Another turn", supersedes: confirmation.id }]) {
    const response = await message(request("/api/assistant/messages", "POST", body, foreign));
    expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ error: { code: "pending_unknown" } });
    expect(state()).toEqual(before); expect(assistantRuns.read(owned)).toEqual(reserved); expect(pendingActions.peek(confirmation.id)).toBeDefined();
  }
  factory.provider = stubProvider([{ text: "Unused", toolCalls: [] }]);
});
it("revocation while parked refuses continuation and preserves the pending action", async () => {
  actualApi(); factory.provider = stubProvider([{ text: "", toolCalls: [{ id: "grant", name: "update_user_access", args: { id: member.account.id, isAdmin: true } }] }]);
  const events = await send({ runId, message: "Grant admin" }, cookie());
  const confirmation = events.find((event): event is Extract<AssistantEvent, { type: "confirm_required" }> => event.type === "confirm_required")!;
  signOut(authenticateSession(admin.secret, db)!, db);
  const before = state();
  const response = await message(request("/api/assistant/messages", "POST", { resolution: { pending: confirmation.id, approved: true } }));
  expect(response.status).toBe(401); expect(state()).toEqual(before); expect(pendingActions.peek(confirmation.id)).toBeDefined();
});
it("grounding, a mutation and its automatic map check retain the cookie caller", async () => {
  vi.stubEnv("DEZFIL_ASSISTANT_AUTO_CHECK", "1");
  const seen = actualApi(), map = createMap(accountScope(authenticateSession(member.secret, db)!, db), "Before"), headers = cookie(member.secret);
  const own = await ownReservation(headers);
  factory.provider = stubProvider([
    { text: "", toolCalls: [{ id: "rename", name: "update_map", args: { id: map.id, name: "After" } }] },
    { text: "Renamed", toolCalls: [] },
  ]);
  const events = await send({ runId: own, message: "Rename", context: { page: "builder", mapId: map.id, selectedLayerId: null } }, headers);
  expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", tool: "update_map", ok: true }));
  expect(events).toContainEqual(expect.objectContaining({ type: "tool_call", tool: "look_at_map", automatic: true }));
  expect(seen.some(item => item.path === "/api/maps/look")).toBe(true);
  expect(seen.every(item => item.accountId === member.account.id && item.authorization.startsWith("Bearer dz_delegation_") && item.cookie === null)).toBe(true);
});

it.each(["cookie", "token"])("revoking the %s between assistant actions stops the next dispatch", async mode => {
  const seen = actualApi(), context = authenticateSession(member.secret, db)!;
  const headers = mode === "cookie" ? cookie(member.secret) : { authorization: `Bearer ${token.secret}` };
  const own = await ownReservation(headers);
  factory.provider = stubProvider([
    { text: "", toolCalls: [{ id: "first-read", name: "get_account", args: {} }] },
    () => {
      if (mode === "cookie") signOut(context, db); else revokeApiToken(context, token.id, db);
      return { text: "", toolCalls: [{ id: "second-read", name: "get_account", args: {} }] };
    },
    { text: "Stopped", toolCalls: [] },
  ]);
  const events = await send({ runId: own, message: "Read twice" }, headers);
  expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", id: "first-read", ok: true }));
  expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", id: "second-read", ok: false, body: { error: { code: "authentication_required", message: "Sign in to continue." } } }));
  expect(seen.filter(item => item.path === "/api/account")).toHaveLength(1);
});

it.each([
  { mode: "cookie", parent: "valid" }, { mode: "token", parent: "valid" },
  { mode: "cookie", parent: "revoked" }, { mode: "token", parent: "revoked" },
  { mode: "cookie", parent: "expired" },
])("a long assistant run with a $parent $mode parent rechecks authority at the next dispatch", async ({ mode, parent }) => {
  const seen = actualApi(), context = authenticateSession(member.secret, db)!;
  const headers = mode === "cookie" ? cookie(member.secret) : { authorization: `Bearer ${token.secret}` };
  const own = await ownReservation(headers), startedAt = Date.now();
  let now = startedAt;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  factory.provider = stubProvider([
    { text: "", toolCalls: [{ id: "early-read", name: "get_account", args: {} }] },
    () => {
      now += DELEGATION_LIFETIME_MS + 1;
      if (parent === "revoked") {
        if (mode === "cookie") signOut(context, db); else revokeApiToken(context, token.id, db);
      }
      if (parent === "expired") db.prepare("UPDATE auth_sessions SET expires_at = ? WHERE id = ?").run(now, context.credential.id);
      return { text: "", toolCalls: [{ id: "late-read", name: "get_account", args: {} }] };
    },
    { text: "Finished", toolCalls: [] },
  ]);
  const events = await send({ runId: own, message: "Read twice across a long pause" }, headers);
  expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", id: "early-read", ok: true }));
  const reads = seen.filter(item => item.path === "/api/account");
  if (parent === "valid") {
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", id: "late-read", ok: true }));
    expect(reads).toHaveLength(2);
    const early = reads[0].authorization.slice(7), late = reads[1].authorization.slice(7);
    expect(authenticateDelegation(early, db, startedAt)?.delegationExpiresAt).toBe(startedAt + DELEGATION_LIFETIME_MS);
    expect(authenticateDelegation(early, db, now)).toBeNull();
    expect(authenticateDelegation(late, db, now)).toMatchObject({ account: { id: member.account.id },
      credential: { kind: mode === "cookie" ? "session" : "token" }, delegationExpiresAt: now + DELEGATION_LIFETIME_MS });
    expect(reads.every(item => item.cookie === null && !item.authorization.includes(token.secret))).toBe(true);
  } else {
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", id: "late-read", ok: false,
      body: { error: { code: "authentication_required", message: "Sign in to continue." } } }));
    expect(reads).toHaveLength(1);
  }
});

it.each(["cookie", "token"])("MCP and assistant %s calls preserve map ownership and hidden-versus-missing errors", async mode => {
  actualApi();
  const invitation = inviteAccount(authenticateSession(admin.secret, db)!, { name: "Other", email: "other@example.test" }, db);
  const other = await redeemSignInLink(invitation.secret, password, db);
  const actors = [admin, member, other];
  const maps = actors.map(actor => createMap(accountScope(authenticateSession(actor.secret, db)!, db), `Private ${actor.account.name}`));
  const before = db.prepare("SELECT * FROM maps ORDER BY id").all();
  for (let i = 0; i < actors.length; i++) {
    const actor = actors[i], hiddenId = maps[(i + 1) % actors.length].id;
    const credential = createApiToken(authenticateSession(actor.secret, db)!, "Private maps", db);
    const headers = mode === "cookie" ? cookie(actor.secret) : { authorization: `Bearer ${credential.secret}` };
    expect(await rpc("get_map", { id: maps[i].id }, headers)).toMatchObject({ isError: false, structuredContent: { result: { id: maps[i].id } } });
    const hidden = await rpc("get_map", { id: hiddenId }, headers);
    expect(hidden).toMatchObject({ isError: true, structuredContent: { result: { error: { code: "not_found" } } } });
    expect(hidden).toEqual(await rpc("get_map", { id: "missing" }, headers));
    expect(JSON.stringify(hidden)).not.toMatch(/Private|SELECT|example|owner/);
    factory.provider = stubProvider([
      { text: "", toolCalls: [
        { id: "hidden", name: "update_map", args: { id: hiddenId, name: "Changed" } },
        { id: "missing", name: "update_map", args: { id: "missing", name: "Changed" } },
      ] },
      { text: "Unavailable", toolCalls: [] },
    ]);
    const events = await send({ runId: await ownReservation(headers), message: "Rename these maps" }, headers);
    const results = events.filter((event): event is Extract<AssistantEvent, { type: "tool_result" }> => event.type === "tool_result");
    expect(results).toHaveLength(2);
    expect(results.map(result => result.ok)).toEqual([false, false]);
    expect(results[0].body).toMatchObject({ error: { code: "not_found" } });
    expect(results[0].body).toEqual(results[1].body);
    expect(JSON.stringify(results)).not.toContain("Private");
  }
  expect(db.prepare("SELECT * FROM maps ORDER BY id").all()).toEqual(before);
});

it.each(["cookie", "token"])("MCP and assistant %s calls preserve layer ownership and hidden-versus-missing errors", async mode => {
  actualApi();
  const invitation = inviteAccount(authenticateSession(admin.secret, db)!, { name: "Other", email: "other@example.test" }, db);
  const other = await redeemSignInLink(invitation.secret, password, db);
  const actors = [admin, member, other];
  const maps = actors.map(actor => createMap(accountScope(authenticateSession(actor.secret, db)!, db), `Private ${actor.account.name}`));
  const layers = maps.map((map, i) => {
    const id = `private-layer-${i}`;
    db.prepare(`INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at)
      VALUES (?, ?, 'Private layer', 'SELECT 1 AS secret', ?, 0, 'time', 'time')`).run(id, map.id, JSON.stringify(defaultStyle(null)));
    return { id };
  });
  const before = db.prepare("SELECT * FROM layers ORDER BY id").all();
  for (let i = 0; i < actors.length; i++) {
    const actor = actors[i], hiddenId = layers[(i + 1) % actors.length].id;
    const credential = createApiToken(authenticateSession(actor.secret, db)!, "Private maps", db);
    const headers = mode === "cookie" ? cookie(actor.secret) : { authorization: `Bearer ${credential.secret}` };
    expect(await rpc("get_layer", { id: layers[i].id }, headers)).toMatchObject({ isError: false, structuredContent: { result: { id: layers[i].id } } });
    const hidden = await rpc("get_layer", { id: hiddenId }, headers);
    expect(hidden).toMatchObject({ isError: true, structuredContent: { result: { error: { code: "not_found" } } } });
    expect(hidden).toEqual(await rpc("get_layer", { id: "missing" }, headers));
    expect(JSON.stringify(hidden)).not.toMatch(/Private|SELECT|example|owner/);
    factory.provider = stubProvider([
      { text: "", toolCalls: [
        { id: "hidden", name: "update_layer", args: { id: hiddenId, name: "Changed" } },
        { id: "missing", name: "update_layer", args: { id: "missing", name: "Changed" } },
      ] },
      { text: "Unavailable", toolCalls: [] },
    ]);
    const events = await send({ runId: await ownReservation(headers), message: "Rename these maps" }, headers);
    const results = events.filter((event): event is Extract<AssistantEvent, { type: "tool_result" }> => event.type === "tool_result");
    expect(results).toHaveLength(2);
    expect(results.map(result => result.ok)).toEqual([false, false]);
    expect(results[0].body).toMatchObject({ error: { code: "not_found" } });
    expect(results[0].body).toEqual(results[1].body);
    expect(JSON.stringify(results)).not.toContain("Private");
  }
  expect(db.prepare("SELECT * FROM layers ORDER BY id").all()).toEqual(before);
});

it.each(["cookie", "token"])("MCP and assistant %s calls preserve history ownership and hidden-versus-missing errors", async mode => {
  actualApi();
  const invitation = inviteAccount(authenticateSession(admin.secret, db)!, { name: "Other", email: "other@example.test" }, db);
  const other = await redeemSignInLink(invitation.secret, password, db);
  const actors = [admin, member, other];
  const maps = actors.map(actor => createMap(accountScope(authenticateSession(actor.secret, db)!, db), `Private ${actor.account.name}`));
  const before = db.prepare("SELECT * FROM maps ORDER BY id").all();
  for (let i = 0; i < actors.length; i++) {
    const actor = actors[i], hiddenId = maps[(i + 1) % actors.length].id;
    const credential = createApiToken(authenticateSession(actor.secret, db)!, "Private maps", db);
    const headers = mode === "cookie" ? cookie(actor.secret) : { authorization: `Bearer ${credential.secret}` };
    expect(await rpc("get_history", { id: maps[i].id }, headers)).toMatchObject({ isError: false, structuredContent: { result: { canUndo: false, canRedo: false } } });
    const hidden = await rpc("get_history", { id: hiddenId }, headers);
    expect(hidden).toMatchObject({ isError: true, structuredContent: { result: { error: { code: "not_found" } } } });
    expect(hidden).toEqual(await rpc("get_history", { id: "missing" }, headers));
    expect(JSON.stringify(hidden)).not.toMatch(/Private|SELECT|example|owner/);
    factory.provider = stubProvider([
      { text: "", toolCalls: [
        { id: "hidden", name: "undo_change", args: { id: hiddenId } },
        { id: "missing", name: "undo_change", args: { id: "missing" } },
      ] },
      { text: "Unavailable", toolCalls: [] },
    ]);
    const events = await send({ runId: await ownReservation(headers), message: "Rename these maps" }, headers);
    const results = events.filter((event): event is Extract<AssistantEvent, { type: "tool_result" }> => event.type === "tool_result");
    expect(results).toHaveLength(2);
    expect(results.map(result => result.ok)).toEqual([false, false]);
    expect(results[0].body).toMatchObject({ error: { code: "not_found" } });
    expect(results[0].body).toEqual(results[1].body);
    expect(JSON.stringify(results)).not.toContain("Private");
  }
  expect(db.prepare("SELECT * FROM maps ORDER BY id").all()).toEqual(before);
});

it.each(["cookie", "token"])("MCP and assistant %s calls preserve dataset ownership and absent-name errors", async mode => {
  actualApi();
  const invitation = inviteAccount(authenticateSession(admin.secret, db)!, { name: "Other", email: "other@example.test" }, db);
  const other = await redeemSignInLink(invitation.secret, password, db);
  const actors = [admin, member, other];
  for (const actor of actors) insertTable(accountScope(authenticateSession(actor.secret, db)!, db), {
    id: actor.account.id, name: actor.account.id, file: "tables/private.parquet", format: "csv", sourceFilename: "private.csv",
    rowCount: 1, geometryColumn: null, geometryType: null, crsAssumed: false, headerSuspect: false,
    source: "upload", sourceParams: null, importedAt: null, createdAt: "time",
  }, db);
  const before = db.prepare("SELECT * FROM data_tables ORDER BY id").all();
  for (let i = 0; i < actors.length; i++) {
    const actor = actors[i], hiddenName = actors[(i + 1) % actors.length].account.id;
    const credential = createApiToken(authenticateSession(actor.secret, db)!, "Private datasets", db);
    const headers = mode === "cookie" ? cookie(actor.secret) : { authorization: `Bearer ${credential.secret}` };
    expect(await rpc("get_table_features", { name: actor.account.id }, headers)).toMatchObject({ isError: false });
    const hidden = await rpc("get_table_features", { name: hiddenName }, headers);
    expect(hidden).toMatchObject({ isError: true, structuredContent: { result: { error: { code: "not_found" } } } });
    expect(hidden).toEqual(await rpc("get_table_features", { name: "missing" }, headers));
    factory.provider = stubProvider([
      { text: "", toolCalls: [
        { id: "hidden", name: "get_table_features", args: { name: hiddenName } },
        { id: "missing", name: "get_table_features", args: { name: "missing" } },
      ] },
      { text: "Unavailable", toolCalls: [] },
    ]);
    const events = await send({ runId: await ownReservation(headers), message: "Read these datasets" }, headers);
    const results = events.filter((event): event is Extract<AssistantEvent, { type: "tool_result" }> => event.type === "tool_result");
    expect(results).toHaveLength(2); expect(results.map(result => result.ok)).toEqual([false, false]);
    expect(results[0].body).toMatchObject({ error: { code: "not_found" } }); expect(results[0].body).toEqual(results[1].body);
  }
  expect(db.prepare("SELECT * FROM data_tables ORDER BY id").all()).toEqual(before);
});

it.each(["cookie", "token"])("MCP and assistant %s calls preserve connection ownership and absent-id errors", async mode => {
  actualApi();
  const invitation = inviteAccount(authenticateSession(admin.secret, db)!, { name: "Other", email: "other@example.test" }, db);
  const other = await redeemSignInLink(invitation.secret, password, db);
  const actors = [admin, member, other];
  for (const actor of actors) insertConnection(accountScope(authenticateSession(actor.secret, db)!, db), {
    id: actor.account.id, name: "Same connection name", host: "private.example.test", port: 5432,
    database: "private", username: "private", password: "never returned", ssl: true,
  }, db);
  const before = db.prepare("SELECT * FROM pg_connections ORDER BY id").all();
  for (let i = 0; i < actors.length; i++) {
    const actor = actors[i], hiddenId = actors[(i + 1) % actors.length].account.id;
    const credential = createApiToken(authenticateSession(actor.secret, db)!, "Private connections", db);
    const headers = mode === "cookie" ? cookie(actor.secret) : { authorization: `Bearer ${credential.secret}` };
    expect(await rpc("list_postgis_snapshots", { id: actor.account.id }, headers)).toMatchObject({ isError: false });
    const hidden = await rpc("list_postgis_snapshots", { id: hiddenId }, headers);
    expect(hidden).toMatchObject({ isError: true, structuredContent: { result: { error: { code: "not_found" } } } });
    expect(hidden).toEqual(await rpc("list_postgis_snapshots", { id: "missing" }, headers));
    factory.provider = stubProvider([
      { text: "", toolCalls: [
        { id: "hidden", name: "list_postgis_snapshots", args: { id: hiddenId } },
        { id: "missing", name: "list_postgis_snapshots", args: { id: "missing" } },
      ] },
      { text: "Unavailable", toolCalls: [] },
    ]);
    const events = await send({ runId: await ownReservation(headers), message: "Read these connection snapshots" }, headers);
    const results = events.filter((event): event is Extract<AssistantEvent, { type: "tool_result" }> => event.type === "tool_result");
    expect(results).toHaveLength(2); expect(results.map(result => result.ok)).toEqual([false, false]);
    expect(results[0].body).toMatchObject({ error: { code: "not_found" } }); expect(results[0].body).toEqual(results[1].body);
  }
  expect(db.prepare("SELECT * FROM pg_connections ORDER BY id").all()).toEqual(before);
});
it.each(["cookie", "token"])("MCP and assistant %s calls preserve workflow parent and step ownership", async mode => {
  actualApi();
  const invitation = inviteAccount(authenticateSession(admin.secret, db)!, { name: "Other", email: "other@example.test" }, db);
  const other = await redeemSignInLink(invitation.secret, password, db), actors = [admin, member, other];
  const recipes = actors.map(actor => createRecipe(accountScope(authenticateSession(actor.secret, db)!, db), "Private workflow", db));
  const steps = recipes.map(recipe => addStep(recipe.id, { operation: "sql_step", parameters: { name: "roads", sql: "SELECT 1" } }, db));
  const before = db.prepare("SELECT * FROM recipe_steps ORDER BY id").all();
  for (let i = 0; i < actors.length; i++) {
    const actor = actors[i], next = (i + 1) % actors.length;
    const credential = createApiToken(authenticateSession(actor.secret, db)!, "Private workflows", db);
    const headers = mode === "cookie" ? cookie(actor.secret) : { authorization: `Bearer ${credential.secret}` };
    expect(await rpc("get_recipe_step", { id: recipes[i].id, stepId: steps[i].id }, headers)).toMatchObject({ isError: false });
    const hidden = await rpc("get_recipe_step", { id: recipes[i].id, stepId: steps[next].id }, headers);
    expect(hidden).toMatchObject({ isError: true, structuredContent: { result: { error: { code: "not_found" } } } });
    expect(hidden).toEqual(await rpc("get_recipe_step", { id: recipes[i].id, stepId: "missing" }, headers));
    factory.provider = stubProvider([
      { text: "", toolCalls: [
        { id: "hidden", name: "get_recipe", args: { id: recipes[next].id } },
        { id: "missing", name: "get_recipe", args: { id: "missing" } },
      ] },
      { text: "Unavailable", toolCalls: [] },
    ]);
    const events = await send({ runId: await ownReservation(headers), message: "Read these workflows" }, headers);
    const results = events.filter((event): event is Extract<AssistantEvent, { type: "tool_result" }> => event.type === "tool_result");
    expect(results).toHaveLength(2); expect(results.map(result => result.ok)).toEqual([false, false]);
    expect(results[0].body).toMatchObject({ error: { code: "not_found" } }); expect(results[0].body).toEqual(results[1].body);
  }
  expect(db.prepare("SELECT * FROM recipe_steps ORDER BY id").all()).toEqual(before);
});
it.each(["cookie", "token"])("MCP and assistant %s calls preserve project ownership", async mode => {
  actualApi();
  const invitation = inviteAccount(authenticateSession(admin.secret, db)!, { name: "Other", email: "other@example.test" }, db);
  const other = await redeemSignInLink(invitation.secret, password, db), actors = [admin, member, other];
  const projects = actors.map(actor => createProject(accountScope(authenticateSession(actor.secret, db)!, db), { name: "Private project" }, db));
  const before = db.prepare("SELECT * FROM projects ORDER BY id").all();
  for (let i = 0; i < actors.length; i++) {
    const actor = actors[i], hiddenId = projects[(i + 1) % actors.length].id;
    const credential = createApiToken(authenticateSession(actor.secret, db)!, "Private projects", db);
    const headers = mode === "cookie" ? cookie(actor.secret) : { authorization: `Bearer ${credential.secret}` };
    expect(await rpc("get_project", { id: projects[i].id }, headers)).toMatchObject({ isError: false });
    const hidden = await rpc("update_project", { id: hiddenId, name: "Changed" }, headers);
    expect(hidden).toMatchObject({ isError: true, structuredContent: { result: { error: { code: "not_found" } } } });
    expect(hidden).toEqual(await rpc("update_project", { id: "missing", name: "Changed" }, headers));
    factory.provider = stubProvider([
      { text: "", toolCalls: [
        { id: "hidden", name: "get_project_members", args: { id: hiddenId } },
        { id: "missing", name: "get_project_members", args: { id: "missing" } },
      ] },
      { text: "Unavailable", toolCalls: [] },
    ]);
    const events = await send({ runId: await ownReservation(headers), message: "Read these projects" }, headers);
    const results = events.filter((event): event is Extract<AssistantEvent, { type: "tool_result" }> => event.type === "tool_result");
    expect(results).toHaveLength(2); expect(results.map(result => result.ok)).toEqual([false, false]);
    expect(results[0].body).toMatchObject({ error: { code: "not_found" } }); expect(results[0].body).toEqual(results[1].body);
  }
  expect(db.prepare("SELECT * FROM projects ORDER BY id").all()).toEqual(before);
});

it.each(["cookie", "token"])("MCP and assistant %s calls preserve private job identity without outputs", async mode => {
  actualApi();
  const invitation = inviteAccount(authenticateSession(admin.secret, db)!, { name: "Other", email: "other@example.test" }, db);
  const other = await redeemSignInLink(invitation.secret, password, db), actors = [admin, member, other];
  for (const actor of actors) insertJob(accountScope(authenticateSession(actor.secret, db)!, db), {
    id: actor.account.id, subjectKind: "client", subjectId: "shared-subject", operation: "sql_step", parameters: { private: actor.account.id }, state: "queued",
    errorCode: null, errorMessage: null, outputId: null, outputName: null, acceptedAt: "time", startedAt: null, finishedAt: null,
  }, db);
  const before = db.prepare("SELECT * FROM operation_jobs ORDER BY id").all();
  for (let i = 0; i < actors.length; i++) {
    const actor = actors[i], hiddenId = actors[(i + 1) % actors.length].account.id;
    const credential = createApiToken(authenticateSession(actor.secret, db)!, "Private jobs", db);
    const headers = mode === "cookie" ? cookie(actor.secret) : { authorization: `Bearer ${credential.secret}` };
    expect(await rpc("get_operation_run", { id: actor.account.id }, headers)).toMatchObject({ isError: false });
    const hidden = await rpc("cancel_operation_run", { id: hiddenId }, headers);
    expect(hidden).toMatchObject({ isError: true, structuredContent: { result: { error: { code: "not_found" } } } });
    expect(hidden).toEqual(await rpc("cancel_operation_run", { id: "missing" }, headers));
    factory.provider = stubProvider([
      { text: "", toolCalls: [
        { id: "hidden", name: "get_operation_run", args: { id: hiddenId } },
        { id: "missing", name: "get_operation_run", args: { id: "missing" } },
      ] },
      { text: "Unavailable", toolCalls: [] },
    ]);
    const events = await send({ runId: await ownReservation(headers), message: "Read these job results" }, headers);
    const results = events.filter((event): event is Extract<AssistantEvent, { type: "tool_result" }> => event.type === "tool_result");
    expect(results).toHaveLength(2); expect(results.map(result => result.ok)).toEqual([false, false]);
    expect(results[0].body).toMatchObject({ error: { code: "not_found" } }); expect(results[0].body).toEqual(results[1].body);
  }
  expect(db.prepare("SELECT * FROM operation_jobs ORDER BY id").all()).toEqual(before);
});

it.each(["cookie", "token"])("MCP and assistant %s calls preserve private workflow run identity without outputs", async mode => {
  actualApi();
  const invitation = inviteAccount(authenticateSession(admin.secret, db)!, { name: "Other", email: "other@example.test" }, db);
  const other = await redeemSignInLink(invitation.secret, password, db), actors = [admin, member, other];
  const recipes = actors.map(actor => createRecipe(accountScope(authenticateSession(actor.secret, db)!, db), "Private workflow", db));
  const steps = recipes.map(recipe => addStep(recipe.id, { operation: "sql_step", parameters: { name: "roads", sql: "SELECT 1" } }, db));
  const runs = recipes.map((recipe, i) => createCascade(recipe.id, "single", [{ stepId: steps[i].id, ordinal: 0 }], db));
  const before = db.prepare("SELECT * FROM cascade_runs ORDER BY id").all();
  for (let i = 0; i < actors.length; i++) {
    const actor = actors[i], hiddenId = runs[(i + 1) % actors.length].id;
    const credential = createApiToken(authenticateSession(actor.secret, db)!, "Private jobs", db);
    const headers = mode === "cookie" ? cookie(actor.secret) : { authorization: `Bearer ${credential.secret}` };
    expect(await rpc("get_recipe_run", { id: recipes[i].id, runId: runs[i].id }, headers)).toMatchObject({ isError: false });
    const hidden = await rpc("cancel_recipe_run", { id: recipes[i].id, runId: hiddenId }, headers);
    expect(hidden).toMatchObject({ isError: true, structuredContent: { result: { error: { code: "not_found" } } } });
    expect(hidden).toEqual(await rpc("cancel_recipe_run", { id: recipes[i].id, runId: "missing" }, headers));
    factory.provider = stubProvider([
      { text: "", toolCalls: [
        { id: "hidden", name: "get_recipe_run", args: { id: recipes[i].id, runId: hiddenId } },
        { id: "missing", name: "get_recipe_run", args: { id: recipes[i].id, runId: "missing" } },
      ] },
      { text: "Unavailable", toolCalls: [] },
    ]);
    const events = await send({ runId: await ownReservation(headers), message: "Read these job results" }, headers);
    const results = events.filter((event): event is Extract<AssistantEvent, { type: "tool_result" }> => event.type === "tool_result");
    expect(results).toHaveLength(2); expect(results.map(result => result.ok)).toEqual([false, false]);
    expect(results[0].body).toMatchObject({ error: { code: "not_found" } }); expect(results[0].body).toEqual(results[1].body);
  }
  expect(db.prepare("SELECT * FROM cascade_runs ORDER BY id").all()).toEqual(before);
});
