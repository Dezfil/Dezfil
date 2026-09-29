import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import { NextRequest } from "next/server";
import * as metadata from "@/lib/metadata/db";
import { testAccountRequest } from "@/lib/test-support/accounts";
import { POST, GET } from "@/app/api/maps/route";
import { requireRequestAuth } from "./http";
import { createApiToken } from "./credentials";
import { gateRequest } from "./gate";
let db: Database;
beforeEach(() => { db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });
it.each(["session", "token"])("refuses stale %s work before dispatch or mutation and admits the current account", async kind => {
  const input = (expected: string) => {
    const request = testAccountRequest(new Request("http://instance.test/api/maps", { method: "POST", body: JSON.stringify({ name: "late private title" }), headers: { "content-type": "application/json" } }), db, "bob");
    if (kind === "token") {
      const token = createApiToken(requireRequestAuth(request, db), "Client", db);
      request.headers.delete("cookie"); request.headers.set("authorization", `Bearer ${token.secret}`);
    }
    request.headers.set("x-dezfil-account", expected); return request;
  };
  const old = input("alice");
  const gate = gateRequest(new NextRequest(old.clone()));
  expect(gate.status).toBe(401); expect(gate.headers.get("x-middleware-next")).toBeNull();
  const refused = await POST(old);
  expect(refused.status).toBe(401); expect(await refused.json()).toEqual({ error: { code: "authentication_required", message: "Sign in to continue." } });
  expect(db.prepare("SELECT count(*) AS n FROM maps").get()).toEqual({ n: 0 });
  expect((await POST(input("bob"))).status).toBe(201);
  const own = await GET(testAccountRequest(new Request("http://instance.test/api/maps"), db, "bob"));
  const empty = await GET(testAccountRequest(new Request("http://instance.test/api/maps"), db, "alice"));
  expect(await own.json()).toMatchObject([{ name: "late private title" }]); expect(await empty.json()).toEqual([]);
});
