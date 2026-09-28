import type { Database } from "better-sqlite3";
import { NextRequest } from "next/server";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { createFirstAccount } from "./accounts";
import { authenticateSession, createApiToken, revokeApiToken, signOut } from "./credentials";
import { delegateSession } from "./delegation";
import { gateRequest } from "./gate";
import { SESSION_COOKIE } from "./http";
let db: Database;
beforeEach(() => { db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });
const input = (pathname: string, headers: Record<string,string> = {}) => new NextRequest(socketRequest(new Request("http://instance.test" + pathname, { headers })));
const first = () => createFirstAccount({ name: "Ada", email: "ada@example.test", password: "field notebooks at dawn" }, db);
it.each([{}, { authorization: "Bearer invalid" }, { "x-account-id": "first", "x-account-admin": "true" }] as Record<string, string>[])("refuses protected entry transport before dispatch: %j", headers => {
  const response = gateRequest(input("/api/auth/session", headers));
  expect(response.status).toBe(401); expect(response.headers.get("x-middleware-next")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it("refuses revoked cookies and tokens before dispatch", async () => {
  const signed = await first(), context = authenticateSession(signed.secret, db)!;
  const token = createApiToken(context, "CLI", db); revokeApiToken(context, token.id, db); signOut(context, db);
  expect(gateRequest(input("/api/auth/session", { cookie: `${SESSION_COOKIE}=${signed.secret}` })).status).toBe(401);
  expect(gateRequest(input("/api/auth/session", { authorization: `Bearer ${token.secret}` })).status).toBe(401);
});
it("redirects setup after creation while leaving cross-account redemption reachable", async () => {
  const signed = await first(), headers = { cookie: `${SESSION_COOKIE}=${signed.secret}` };
  expect(gateRequest(input("/setup")).headers.get("location")).toBe("http://instance.test/sign-in");
  expect(gateRequest(input("/sign-in", headers)).headers.get("location")).toBe("http://instance.test/");
  const accept = gateRequest(input("/accept", headers));
  expect(accept.headers.get("x-middleware-next")).toBe("1");
  expect(accept.headers.get("cache-control")).toBe("private, no-store");
});
it("protects existing and future routes by default", () => {
  expect(gateRequest(input("/api/maps")).status).toBe(401);
  expect(gateRequest(input("/api/future")).status).toBe(401);
});

it("does not set a browser cookie for a bearer delegation", async () => {
  const signed = await first(), context = authenticateSession(signed.secret, db)!;
  const delegation = delegateSession(context, db);
  for (const cookie of [undefined, `${SESSION_COOKIE}=unrelated-cookie`]) {
    const response = gateRequest(input("/api/account", { authorization: `Bearer ${delegation}`, ...(cookie ? { cookie } : {}) }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("set-cookie")).toBeNull();
  }
});
