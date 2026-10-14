import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { open } from "@/lib/metadata/db";
import { insertAccount } from "@/lib/metadata/accounts";
import { insertSession, insertToken } from "@/lib/metadata/auth-credentials";
import { authenticateSession, authenticateToken, secretHash } from "./credentials";
import { maintainCredentials } from "./credential-maintenance";

let directory: string, db: Database.Database, writer: Database.Database;
const start = Date.parse("2026-01-01T00:00:00Z");
beforeEach(() => {
  directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "credential-contention-"));
  const file = path.join(directory, "metadata.sqlite");
  db = open(file); writer = new Database(file);
  for (const status of ["active", "deactivated"] as const) insertAccount({ id: status, name: status,
    email: `${status}@example.test`, passwordHash: null, isAdmin: false, status, now: new Date(start).toISOString() }, db);
  for (const id of ["live", "expired", "revoked", "inactive"]) {
    const common = { id, account_id: id === "inactive" ? "deactivated" : "active", secret_hash: secretHash(id),
      created_at: start, last_used_at: start, revoked_at: id === "revoked" ? start : null,
      expires_at: id === "expired" ? start + 50 : start + 100 };
    insertSession(common, db); insertToken({ ...common, name: id }, db);
  }
});
afterEach(() => {
  if (writer.inTransaction) writer.exec("ROLLBACK");
  writer.close(); db.close(); rmSync(directory, { recursive: true, force: true });
});

it.each(["session", "token"] as const)("authenticates a %s without waiting for a held write lock and keeps exact refusals", kind => {
  maintainCredentials(db, start);
  const authenticate = kind === "session" ? authenticateSession : authenticateToken;
  const table = kind === "session" ? "auth_sessions" : "auth_tokens";
  const before = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  writer.exec("BEGIN IMMEDIATE");
  const began = performance.now();
  expect(authenticate("live", db, start + 50)?.account.id).toBe("active");
  expect(performance.now() - began).toBeLessThan(500);
  expect(authenticate("unknown", db, start + 50)).toBeNull();
  expect(authenticate("revoked", db, start + 50)).toBeNull();
  expect(authenticate("inactive", db, start + 50)).toBeNull();
  if (kind === "session") expect(authenticate("expired", db, start + 50)).toBeNull();
  else expect(() => authenticate("expired", db, start + 50)).toThrow(expect.objectContaining({ code: "token_expired" }));
  expect(db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).toEqual(before);
  expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
  writer.exec("ROLLBACK");
  expect(authenticate("live", db, start + 51)?.account.id).toBe("active");
  expect(db.prepare(`SELECT last_used_at FROM ${table} WHERE id = 'live'`).get()).toEqual({ last_used_at: start + 51 });
});

it("does not swallow a storage error unrelated to contention", () => {
  maintainCredentials(db, start);
  db.exec("CREATE TRIGGER reject_renewal BEFORE UPDATE ON auth_sessions BEGIN SELECT RAISE(ABORT, 'renewal failed'); END");
  expect(() => authenticateSession("live", db, start + 1)).toThrow("renewal failed");
  expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
});
