import { afterEach, beforeEach, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { open } from "@/lib/metadata/db";
import { insertAccount, normalizeEmail } from "@/lib/metadata/accounts";
import { eraseAccountCredentials } from "@/lib/metadata/account-erasure";
import { secretHash } from "./credentials";
import { withLoginLimit } from "./login-limits";
import { AuthError } from "./errors";
import { erasureInventory } from "./account-erasure-inventory";
import { proveErasure, type ErasureProbe } from "../../../test-support/account-erasure-proof";

let db: Database;
const key = (email: string) => `account:${secretHash(normalizeEmail(email))}`;
const tables = ["account_preferences", "auth_sessions", "auth_tokens", "auth_links", "auth_login_limits"];
const rows = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all() as Record<string, unknown>[];
const snapshot = () => Object.fromEntries([...tables, "accounts"].map(t => [t, rows(t)]));
beforeEach(() => {
  db = open(":memory:");
  for (const id of ["target", "control", "invited", "inactive"]) {
    insertAccount({ id, name: id, email: `${id}@example.test`, passwordHash: `${id}-password`, isAdmin: false,
      status: id === "invited" ? "invited" : id === "inactive" ? "deactivated" : "active", now: "time" }, db);
    db.prepare("UPDATE accounts SET last_sign_in_at = 'sign-in' WHERE id = ?").run(id);
    db.prepare("INSERT INTO account_preferences VALUES (?, ?, 'time')").run(id, `${id}-preferences`);
    for (const state of ["live", "expired", "revoked", "consumed"]) {
      const tag = `${id}-${state}`;
      db.prepare("INSERT INTO auth_sessions VALUES (?, ?, ?, 1, ?, 1, ?)").run(tag, `${tag}-session`, id, state === "expired" ? 2 : 99999999, state === "revoked" ? 3 : null);
      db.prepare("INSERT INTO auth_tokens VALUES (?, ?, ?, ?, 1, NULL, ?, ?)").run(tag, id, tag, `${tag}-token`, state === "revoked" ? 3 : null, state === "expired" ? 2 : null);
      for (const kind of ["invite", "reset"]) db.prepare("INSERT INTO auth_links VALUES (?, ?, ?, ?, 1, ?, ?, ?)")
        .run(`${tag}-${kind}`, id, kind, `${tag}-${kind}-hash`, state === "expired" ? 2 : 99999999, state === "consumed" ? 3 : null, state === "revoked" ? 3 : null);
    }
    db.prepare("INSERT INTO auth_login_limits VALUES (?, 1000, 2, 0)").run(key(`${id}@example.test`));
  }
  for (const email of ["former@example.test", "orphan@example.test"]) db.prepare("INSERT INTO auth_login_limits VALUES (?, 1000, 1, 0)").run(key(email));
  db.prepare("INSERT INTO auth_login_limits VALUES (?, 1000, 7, 0)").run(`source:${secretHash("192.0.2.1")}`);
});
afterEach(() => db.close());
it.each(["active", "deactivated", "invited", "deleted", "missing"])("refuses %s inside the destructive transaction with zero effects", state => {
  if (state === "deleted") db.exec("UPDATE accounts SET status = 'deleted', name = NULL, email = NULL, password_hash = NULL, is_admin = NULL, created_at = NULL, updated_at = NULL, last_sign_in_at = NULL WHERE id = 'target'");
  else if (state !== "missing") db.prepare("UPDATE accounts SET status = ? WHERE id = 'target'").run(state);
  const before = snapshot();
  expect(() => eraseAccountCredentials(state === "missing" ? "absent" : "target", db)).toThrow("deleting");
  expect(snapshot()).toEqual(before);
});
it("erases populated credential states, preferences and computed current/former/orphan buckets while preserving other accounts and source budgets", async () => {
  db.exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
  const erasedKeys = ["target", "former", "orphan"].map(id => key(`${id}@example.test`));
  const probes: Record<string, ErasureProbe> = Object.fromEntries(tables.map(table => [`table:${table}`, {
    populate() {}, dispose() {}, observe() {
      const target = (r: Record<string, unknown>) => table === "auth_login_limits" ? erasedKeys.includes(String(r.bucket)) : r.account_id === "target";
      return { target: rows(table).filter(target).map(r => JSON.stringify(r)), control: rows(table).filter(r => !target(r)).map(r => JSON.stringify(r)) };
    },
  }]));
  const before = rows("accounts");
  const inventory = { ...erasureInventory, stores: Object.fromEntries(Object.entries(erasureInventory.stores).filter(([id]) => id in probes)) };
  expect(await proveErasure(inventory, probes, () => eraseAccountCredentials("target", db))).toHaveLength(tables.length);
  const expected = before.map(r => r.id === "target" ? { ...r, password_hash: null, last_sign_in_at: null } : r);
  expect(rows("accounts")).toEqual(expected);
  expect(() => db.prepare("UPDATE accounts SET email = 'target@example.test' WHERE id = 'control'").run()).toThrow();
  eraseAccountCredentials("target", db);
  expect(rows("accounts")).toEqual(expected);
});
it.each(["success", "failure", "refund"])("held %s reservations cannot recreate erased email buckets, and preserve source accounting", async outcome => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const attempts = ["target", "former", "orphan"].map(id => withLoginLimit(`${id}@example.test`, "198.51.100.1", async () => {
    await held;
    if (outcome === "failure") throw new AuthError("invalid_credentials", "refused", 401);
    if (outcome === "refund") throw new Error("unavailable");
  }, db, () => 1000));
  db.exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
  eraseAccountCredentials("target", db);
  release(); await Promise.allSettled(attempts);
  for (const id of ["target", "former", "orphan"]) expect(db.prepare("SELECT * FROM auth_login_limits WHERE bucket = ?").get(key(`${id}@example.test`))).toBeUndefined();
  expect(db.prepare("SELECT failures, pending FROM auth_login_limits WHERE bucket = ?").get(`source:${secretHash("198.51.100.1")}`)).toEqual({ failures: outcome === "failure" ? 3 : 0, pending: 0 });
});
it("rolls back every destructive write when a later statement fails", () => {
  db.exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'; CREATE TRIGGER fail_cleanup BEFORE DELETE ON auth_tokens BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  const before = snapshot();
  expect(() => eraseAccountCredentials("target", db)).toThrow("injected failure");
  expect(snapshot()).toEqual(before);
});
