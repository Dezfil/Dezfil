import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { open } from "@/lib/metadata/db";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { createApiToken } from "./credentials";
import { requireRequestAuth } from "./http";
import { requireRequestScope } from "./scope-http";
import { requirePageScope } from "./scope-page";
import { requireAccountScope } from "./scope";

const page = vi.hoisted(() => ({ headers: vi.fn(), redirect: vi.fn((path: string): never => { throw new Error(`redirect:${path}`); }) }));
vi.mock("next/headers", () => ({ headers: page.headers }));
vi.mock("next/navigation", () => ({ redirect: page.redirect }));
let db: Database;
beforeEach(() => { db = open(":memory:"); vi.clearAllMocks(); });
afterEach(() => db.close());
const request = () => new Request("http://instance.test/maps");

it.each(["session", "token"])("derives HTTP and page scopes from %s identity for two accounts and an admin", async kind => {
  for (const id of ["alice", "bob", "admin"]) {
    const input = testAccountRequest(request(), db, id);
    if (id === "admin") db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = ?").run(id);
    if (kind === "token") {
      const token = createApiToken(requireRequestAuth(input, db), "Access", db);
      input.headers.delete("cookie");
      input.headers.set("authorization", `Bearer ${token.secret}`);
    }
    // Arbitrary headers are never identity authority.
    input.headers.set("x-account-id", "someone-else");
    page.headers.mockResolvedValue(input.headers);
    for (const scope of [requireRequestScope(input, db), await requirePageScope(db)]) {
      expect(requireAccountScope(scope, db)).toBe(id);
      expect(Object.isFrozen(scope)).toBe(true);
    }
  }
});

it("redirects missing page credentials through the existing setup and sign-in entries", async () => {
  const input = socketRequest(request());
  page.headers.mockResolvedValue(input.headers);
  expect(() => requireRequestScope(input, db)).toThrow(expect.objectContaining({ code: "authentication_required" }));
  await expect(requirePageScope(db)).rejects.toThrow("redirect:/setup");
  testAccountScope(db, "alice");
  await expect(requirePageScope(db)).rejects.toThrow("redirect:/sign-in");
});

it.each(["revoked", "deactivated"])("reauthenticates a %s credential at each entry", async state => {
  const input = testAccountRequest(request(), db, "alice");
  expect(requireRequestScope(input, db).accountId).toBe("alice");
  if (state === "deactivated") db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
  else db.exec("DELETE FROM auth_sessions");
  page.headers.mockResolvedValue(input.headers);
  expect(() => requireRequestScope(input, db)).toThrow(expect.objectContaining({ code: "authentication_required" }));
  await expect(requirePageScope(db)).rejects.toThrow("redirect:/sign-in");
});

it("refuses unsealed request provenance before either entry can mint a scope", async () => {
  const input = testAccountRequest(request(), db, "alice");
  input.headers.delete("x-dezfil-ingress");
  page.headers.mockResolvedValue(input.headers);
  expect(() => requireRequestScope(input, db)).toThrow(expect.objectContaining({ code: "ingress_unavailable" }));
  await expect(requirePageScope(db)).rejects.toMatchObject({ code: "ingress_unavailable" });
  expect(page.redirect).not.toHaveBeenCalled();
});
