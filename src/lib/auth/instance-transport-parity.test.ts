import type { Database } from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { POST as mcp } from "@/app/api/mcp/route";
import { buildTools } from "@/lib/tools/tools";
import { executeTool } from "@/lib/tools/execute";
import { createMap } from "@/lib/map-service";
import { requireRequestAuth } from "./http";
import { createApiToken } from "./credentials";
import { instanceFetch } from "./instance-fetch";
import { gateRequest } from "./gate";

const origin = "http://127.0.0.1:3231", actors = ["alice", "bob", "admin"];
const stops = [{ color: "#123456", position: 0 }, { color: "#abcdef", position: 1 }];
let db: Database, maps: Record<string, string>;
let headers: Record<string, { session: Record<string, string>; token: Record<string, string> }>;
let seen: { account: string; cookie: string | null; authorization: string | null }[];
beforeEach(() => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  vi.stubEnv("PORT", "3231"); maps = {}; headers = {}; seen = [];
  for (const actor of actors) {
    maps[actor] = createMap(testAccountScope(db, actor), actor + " private map").id;
    const input = testAccountRequest(new Request(origin + "/api/account"), db, actor);
    headers[actor] = { session: { cookie: input.headers.get("cookie")! }, token: { authorization: `Bearer ${createApiToken(requireRequestAuth(input, db), "Parity", db).secret}` } };
  }
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = socketRequest(new Request(input instanceof Request ? input : String(input), init));
    const gate = gateRequest(new NextRequest(request.clone()));
    if (gate.headers.get("x-middleware-next") !== "1") return gate;
    const context = requireRequestAuth(request);
    seen.push({ account: context.account.id, cookie: request.headers.get("cookie"), authorization: request.headers.get("authorization") });
    return dispatchAssistantTestRoute(request);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.close(); });
function request(actor: string, kind: "session" | "token", body?: unknown, extra: Record<string, string> = {}) {
  return socketRequest(new Request(origin + "/api/mcp", { method: "POST", headers: { origin, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers[actor][kind], ...extra }, body: JSON.stringify(body ?? {}) }));
}
async function call(actor: string, kind: "session" | "token", surface: "mcp" | "assistant", name: string, args: Record<string, unknown> = {}) {
  if (surface === "assistant") {
    const context = requireRequestAuth(request(actor, kind));
    const result = await executeTool(buildTools().find(tool => tool.name === name)!, args, origin, instanceFetch(origin, context));
    return { ok: result.ok, body: result.body };
  }
  const response = await mcp(request(actor, kind, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { "mcp-protocol-version": "2025-03-26" }));
  expect(response.status).toBe(200);
  const text = await response.text(), payload = JSON.parse(text.startsWith("{") ? text : text.split("\n").find(line => line.startsWith("data: "))!.slice(6));
  expect(payload.error).toBeUndefined();
  return { ok: !payload.result.isError, body: payload.result.structuredContent.result };
}

it.each(["session", "token"] as const)("keeps shared catalogues, palette writes and private settings/map refusals in MCP and assistant %s parity", async kind => {
  for (const name of ["get_config", "list_palettes", "list_operations", "get_api_description", "list_geometry_projections"]) {
    const expected = await call("alice", kind, "mcp", name); expect(expected.ok).toBe(true);
    for (const actor of actors) for (const surface of ["mcp", "assistant"] as const) expect(await call(actor, kind, surface, name)).toEqual(expected);
  }
  const created = await call("alice", kind, "mcp", "create_palette", { label: "Shared", stops });
  expect(created.ok).toBe(true); const palette = created.body as { name: string };
  expect((await call("bob", kind, "assistant", "list_palettes")).body).toMatchObject({ custom: [created.body] });
  expect(await call("bob", kind, "assistant", "delete_palette", { name: palette.name })).toMatchObject({ ok: true, body: { deleted: true } });
  expect((await call("alice", kind, "mcp", "list_palettes")).body).toMatchObject({ custom: [] });

  for (const surface of ["mcp", "assistant"] as const) {
    for (const actor of actors) {
      expect((await call(actor, kind, surface, "update_settings", { displayName: actor + " personal", viewPrefs: { maps: { view: actor === "bob" ? "list" : "grid" } } })).ok).toBe(true);
      expect((await call(actor, kind, surface, "get_settings")).body).toMatchObject({ displayName: actor + " personal", viewPrefs: { maps: { view: actor === "bob" ? "list" : "grid" } } });
      const own = await call(actor, kind, surface, "get_map", { id: maps[actor] }); expect(own.ok).toBe(true);
    }
    const before = db.prepare("SELECT * FROM account_preferences ORDER BY account_id").all();
    for (const actor of ["alice", "bob"]) expect(await call(actor, kind, surface, "update_settings", { instanceName: "Forbidden", viewPrefs: { maps: { view: "grid", sort: "name" } } })).toMatchObject({ ok: false, body: { error: { code: "forbidden" } } });
    expect(db.prepare("SELECT * FROM account_preferences ORDER BY account_id").all()).toEqual(before);
    expect((await call("admin", kind, surface, "update_settings", { instanceName: "Shared instance" })).ok).toBe(true);
    const hidden = await call("admin", kind, surface, "get_map", { id: maps.alice });
    expect(hidden).toEqual(await call("admin", kind, surface, "get_map", { id: "missing" }));
    expect(hidden).toMatchObject({ ok: false, body: { error: { code: "not_found" } } });
    expect(JSON.stringify(hidden)).not.toContain("alice private map");
  }
  expect(seen.length).toBeGreaterThan(30);
  expect(new Set(seen.map(value => value.account))).toEqual(new Set(actors));
  expect(seen.every(value => value.cookie === null && value.authorization?.startsWith("Bearer dz_delegation_"))).toBe(true);
});
it.each(["session", "token"] as const)("holds the account precondition before MCP or assistant %s palette dispatch", async kind => {
  const response = await mcp(request("bob", kind, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_palette", arguments: { label: "Late", stops } } }, { "x-dezfil-account": "alice" }));
  expect(response.status).toBe(401); expect(await response.json()).toMatchObject({ error: { code: "authentication_required" } });
  const context = requireRequestAuth(request("bob", kind));
  const result = await executeTool(buildTools().find(tool => tool.name === "create_palette")!, { label: "Late", stops }, origin, instanceFetch(origin, context), { "x-dezfil-account": "alice" });
  expect(result).toMatchObject({ ok: false, status: 401, body: { error: { code: "authentication_required" } } });
  expect(db.prepare("SELECT count(*) AS n FROM custom_palettes").get()).toEqual({ n: 0 });
  expect(seen).toEqual([]);
});
