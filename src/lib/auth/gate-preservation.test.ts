import type { Database } from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { createMap, readMap } from "@/lib/map-service";
import { requireRequestAuth } from "./http";
import { createApiToken } from "./credentials";
import { apiMethodTable } from "./api-methods";
import { gateRequest } from "./gate";

let db: Database, authorization: string;
const base = "http://127.0.0.1:3231";
beforeEach(() => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); vi.stubEnv("PORT", "3231");
  const context = requireRequestAuth(testAccountRequest(new Request(base + "/api/account"), db));
  authorization = `Bearer ${createApiToken(context, "Controls", db).secret}`;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = socketRequest(new Request(input, init));
    const gate = gateRequest(new NextRequest(request.clone()));
    return gate.headers.get("x-middleware-next") === "1" ? dispatchAssistantTestRoute(request) : gate;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.close(); });

it.each(["extra", "missing"])("detects a seeded %s Allow method in the derived table against the unchanged description", mode => {
  const contract = buildOpenApiDocument();
  const expected = Object.keys(contract.paths["/api/maps"]).map(method => method.toUpperCase()).sort();
  const entry = apiMethodTable.find(row => row.template === "/api/maps")!;
  const original = entry.methods;
  const check = (method: string) => {
    const response = gateRequest(new NextRequest(socketRequest(new Request(base + "/api/maps", { method, headers: { authorization } }))));
    expect(response.headers.get("allow")?.split(", ").sort()).toEqual(expected);
  };
  try {
    entry.methods = mode === "extra" ? [...original, "TRACE"] : original.filter(method => method !== "POST");
    for (const method of ["PUT", "OPTIONS"]) expect(() => check(method)).toThrow();
    expect(buildOpenApiDocument()).toEqual(contract);
  } finally { entry.methods = original; }
  for (const method of ["PUT", "OPTIONS"]) check(method);
});

it.each(["rest", "mcp"])("retains anonymous publish/delete refusals and valid-token controls through %s", async transport => {
  const scope = testAccountScope(db), map = createMap(scope, "Private controls");
  const call = async (action: "publish" | "delete", auth: string, revision: string) => {
    const headers = { ...(auth ? { authorization: auth } : {}), "content-type": "application/json", "X-Edit-Revision": revision };
    if (transport === "rest") return fetch(base + `/api/maps/${map.id}` + (action === "publish" ? "/publish" : ""), { method: action === "publish" ? "POST" : "DELETE", headers });
    return fetch(base + "/api/mcp", { method: "POST", headers: { ...headers, accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: action === "publish" ? "publish_map" : "delete_map", arguments: { id: map.id, expected_revision: revision } } }) });
  };
  const before = readMap(scope, map.id);
  for (const action of ["publish", "delete"] as const) {
    const response = await call(action, "", map.editRevision);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "authentication_required" } });
    expect(readMap(scope, map.id)).toEqual(before);
  }
  for (const action of ["publish", "delete"] as const) {
    const response = await call(action, authorization, readMap(scope, map.id).editRevision);
    expect(response.ok).toBe(true);
    if (transport === "mcp") {
      const text = await response.text();
      const payload = JSON.parse(text.startsWith("{") ? text : text.split("\n").find(line => line.startsWith("data: "))!.slice(6));
      expect(payload.error).toBeUndefined(); expect(payload.result.isError).not.toBe(true);
    }
  }
  expect(() => readMap(scope, map.id)).toThrow();
});
