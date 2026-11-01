import { afterEach, beforeEach, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { open } from "@/lib/metadata/db";
import { insertAccount } from "@/lib/metadata/accounts";
import { insertSession } from "@/lib/metadata/auth-credentials";
import { authenticateSession, secretHash } from "./credentials";
import { credentialMaintenance } from "./credential-maintenance";

const now = Date.now();
let db: Database;
beforeEach(() => {
  db = open(":memory:");
  insertAccount({ id: "reader", name: "Reader", email: "reader@example.test", passwordHash: null,
    status: "active", isAdmin: false, now: new Date(now).toISOString() }, db);
  for (const [id, expires] of [["expired", now - 172800000], ["live", now + 60000]] as const) {
    insertSession({ id, account_id: "reader", secret_hash: secretHash(id), created_at: now - 200000000,
      expires_at: expires, last_used_at: now - 200000000, revoked_at: null }, db);
  }
  // Real SQLite exhaustion: both optional writes need a new page, beyond
  // this database's page bound. Reads and the stored expiry still exist.
  db.exec(`CREATE TABLE full_write (bytes BLOB);
    CREATE TRIGGER full_sweep BEFORE DELETE ON auth_sessions BEGIN INSERT INTO full_write VALUES(zeroblob(1048576)); END;
    CREATE TRIGGER full_renewal BEFORE UPDATE ON auth_sessions BEGIN INSERT INTO full_write VALUES(zeroblob(1048576)); END;`);
  db.pragma(`max_page_count = ${db.pragma("page_count", { simple: true })}`);
});
afterEach(() => db.close());

it("authenticates without renewal with expired rows present and the sweep due", () => {
  const before = db.prepare("SELECT * FROM auth_sessions ORDER BY id").all();
  expect(() => db.prepare("UPDATE auth_sessions SET last_used_at = ? WHERE id = 'live'").run(now)).toThrow(/full/);
  expect(authenticateSession("live", db, now)?.account.id).toBe("reader");
  expect(db.prepare("SELECT * FROM auth_sessions ORDER BY id").all()).toEqual(before);
  expect(authenticateSession("expired", db, now)).toBeNull();
  expect(authenticateSession("live", db, now + 60000)).toBeNull();
});

it("leaves the sweep cursor ready to retry the same expired page", () => {
  const sweep = credentialMaintenance();
  expect(sweep(db, () => now)).toBeNull();
  expect(db.prepare("SELECT id FROM auth_sessions WHERE id = 'expired'").get()).toBeDefined();
  db.exec("DROP TRIGGER full_sweep; DROP TRIGGER full_renewal");
  expect(sweep(db, () => now)?.removed.sessions).toBe(1);
  expect(db.prepare("SELECT id FROM auth_sessions WHERE id = 'expired'").get()).toBeUndefined();
  expect(authenticateSession("live", db, now)?.account.id).toBe("reader");
});
