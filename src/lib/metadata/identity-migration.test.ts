import Database from "better-sqlite3";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MIGRATIONS, open } from "./db";
import { allocateSqlNames, type SqlNameIdentity } from "./sql-names";
import { accountLabels, getAccount, getAccountByEmail, insertAccount, listAccounts, setupComplete } from "./accounts";
import { createFirstAccount, requireAvailableEmail } from "@/lib/auth/accounts";
import { openRecoveryStore, selectRecoveryAdmin } from "@/lib/auth/recovery-store.mjs";
import { testAccountScope } from "@/lib/test-support/accounts";
import { presencesOf } from "@/lib/reach-presence";

const ENTRY = 46, now = "2026-01-02T03:04:05.000Z";
let directory: string, file: string, db: Database.Database;
/** Later migrations add the token expiry column, the picture's version and
 * the basemap library's table; these checks compare the store as the
 * identity migration left it, every other byte included. */
const LATER_TOKEN_COLUMN = ", expires_at INTEGER)";
const LATER_COLUMNS: Record<string, string> = { auth_tokens: "expires_at", accounts: "picture_version" };
const LATER_TABLES = new Set(["basemap_styles", "map_pictures"]);
function schema() {
  return (db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE NOT (type = 'table' AND name = 'accounts') ORDER BY type, name").all() as
    { type: string; name: string; tbl_name: string; sql: string | null }[])
    .filter(entry => !LATER_TABLES.has(entry.tbl_name) && entry.name !== "revoke_picture_work_on_inactive_owner")
    .map(entry => entry.type === "table" && entry.name === "auth_tokens" && entry.sql?.endsWith(LATER_TOKEN_COLUMN)
      ? { ...entry, sql: entry.sql.slice(0, -LATER_TOKEN_COLUMN.length) + ")" } : entry);
}
function rows() {
  return Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .filter(({ name }) => !LATER_TABLES.has(name))
    .map(({ name }) => [name, (db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() as Record<string, unknown>[])
      .map(row => name in LATER_COLUMNS ? Object.fromEntries(Object.entries(row).filter(([column]) => column !== LATER_COLUMNS[name])) : row)]));
}
function reopen() { db.close(); db = open(file); }
function eraseProfile() {
  db.exec(`UPDATE accounts SET status = 'deleted', name = NULL, email = NULL, password_hash = NULL,
    is_admin = NULL, created_at = NULL, updated_at = NULL, last_sign_in_at = NULL WHERE id = 'ada'`);
}
beforeEach(() => {
  directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "identity-")); file = path.join(directory, "metadata.sqlite");
  db = new Database(file); db.pragma("foreign_keys = ON");
  db.function("allocate_sql_names", (input: unknown) => JSON.stringify(allocateSqlNames(JSON.parse(String(input)) as SqlNameIdentity[])));
  for (const sql of MIGRATIONS.slice(0, ENTRY)) db.exec(sql);
  db.pragma(`user_version = ${ENTRY}`);
  // Written as that version's store held them: today's account reads name
  // columns a store this old does not have yet.
  for (const [id, status] of [["ada", "active"], ["bea", "active"], ["off", "deactivated"], ["invite", "invited"]] as const) {
    db.prepare(`INSERT INTO accounts (id, name, email, password_hash, is_admin, status, created_at, updated_at, sql_name)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(id, id, `${id}@example.test`, `${id}-hash`, status, now, now, id);
  }
  db.exec(`INSERT INTO original_account VALUES (1, 'ada');
    INSERT INTO account_preferences VALUES ('ada', '{"maps":{"sort":"name"}}', '${now}');
    INSERT INTO auth_sessions VALUES ('session', 'session-hash', 'ada', 1, 9, 1, NULL);
    INSERT INTO auth_tokens VALUES ('token', 'ada', 'Token', 'token-hash', 1, NULL, NULL);
    INSERT INTO auth_links VALUES ('link', 'ada', 'reset', 'link-hash', 1, 9, NULL, NULL);
    INSERT INTO projects (id, name, owner_id, created_at, updated_at) VALUES ('project', 'Survey', 'bea', '${now}', '${now}');
    INSERT INTO project_people VALUES ('project', 'ada', 'editor', '${now}');
    INSERT INTO maps (id, name, owner_id, home_account_id, project_id, last_changed_by, created_at, updated_at)
      VALUES ('map', 'Survey', 'bea', 'ada', 'project', 'ada', '${now}', '${now}');
    INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at)
      VALUES ('layer', 'map', 'Roads', 'SELECT * FROM ada.roads', '{}', 0, '${now}', '${now}');
    INSERT INTO map_history (id, map_id, seq, scope, target_id, op, before, after, created_at, author_id)
      VALUES ('history', 'map', 1, 'map', 'map', 'update', '{}', '{}', '${now}', 'ada');
    INSERT INTO recipes (id, name, origin, owner_id, home_account_id, last_changed_by, created_at, updated_at)
      VALUES ('workflow', 'Workflow', 'workflow', 'bea', 'ada', 'ada', '${now}', '${now}');
    INSERT INTO cascade_runs (id, recipe_id, kind, started_at, initiator_id) VALUES ('run', 'workflow', 'all', '${now}', 'ada');`);
  writeFileSync(path.join(directory, "secret.key"), "synthetic-key");
  mkdirSync(path.join(directory, "tables")); writeFileSync(path.join(directory, "tables/fixture.parquet"), "synthetic-artifact");
});
afterEach(() => { vi.restoreAllMocks(); if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });

it("preserves every row and every other schema entry byte for byte, with enforced foreign keys on repeat opening", () => {
  const beforeRows = rows(), beforeSchema = schema();
  reopen();
  expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
  expect(rows()).toEqual(beforeRows); expect(schema()).toEqual(beforeSchema);
  expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(db.pragma("foreign_key_check")).toEqual([]);
  expect(() => db.exec("UPDATE accounts SET sql_name = 'changed' WHERE id = 'ada'")).toThrow("SQL name cannot change");
  expect(() => db.exec("UPDATE maps SET owner_id = 'ada' WHERE id = 'map'")).toThrow("Ownership cannot change");
  expect(() => db.exec("UPDATE maps SET home_account_id = 'bea' WHERE id = 'map'")).toThrow("SQL home cannot change");
  expect(() => db.exec("UPDATE auth_tokens SET account_id = 'missing'")).toThrow(/FOREIGN KEY/);
  reopen(); expect(rows()).toEqual(beforeRows); expect(schema()).toEqual(beforeSchema);
});

it("detects a seeded lost trigger independently of row preservation", () => {
  const before = schema(); reopen(); db.exec("DROP TRIGGER accounts_sql_name_fixed");
  expect(() => expect(schema()).toEqual(before)).toThrow();
});

it.each(["copy", "integrity", "trigger"])("rolls back a %s failure and restores enforcement before retry", async failure => {
  const { migrate } = await import("./db");
  expect(typeof migrate).toBe("function");
  const beforeRows = rows(), beforeSchema = schema();
  const real = db.exec.bind(db), check = db.pragma.bind(db);
  const fault = vi.spyOn(db, "exec").mockImplementation(sql => {
    if (failure === "copy" && sql.includes("DROP TABLE accounts")) throw new Error("seeded copy failure");
    const result = real(sql);
    if (failure === "trigger" && sql.includes("CREATE TRIGGER accounts_sql_name_fixed")) real("DROP TRIGGER accounts_sql_name_fixed");
    return result;
  });
  const pragma = vi.spyOn(db, "pragma").mockImplementation((sql: string, options?: Database.PragmaOptions) => {
    if (failure === "integrity" && sql === "foreign_key_check") return [{ table: "auth_tokens", rowid: 1, parent: "accounts", fkid: 0 }];
    return check(sql, options);
  });
  expect(() => migrate(db)).toThrow(); fault.mockRestore(); pragma.mockRestore();
  expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(db.pragma("legacy_alter_table", { simple: true })).toBe(0);
  expect(db.pragma("user_version", { simple: true })).toBe(ENTRY);
  expect(rows()).toEqual(beforeRows); expect(schema()).toEqual(beforeSchema);
  reopen(); expect(rows()).toEqual(beforeRows); expect(schema()).toEqual(beforeSchema);
});

it("keeps only the retained identity, hides profiles, reserves SQL names and preserves other people's homes", async () => {
  reopen(); const before = rows(); eraseProfile();
  expect(db.prepare("SELECT * FROM accounts WHERE id = 'ada'").get()).toEqual({ id: "ada", status: "deleted", sql_name: "ada",
    name: null, email: null, password_hash: null, is_admin: null, created_at: null, updated_at: null, last_sign_in_at: null, picture_version: null });
  for (const column of ["name", "email", "password_hash", "is_admin", "created_at", "updated_at", "last_sign_in_at"]) {
    expect(() => db.prepare(`UPDATE accounts SET ${column} = ? WHERE id = 'ada'`).run(column === "is_admin" ? 0 : "personal")).toThrow(/CHECK/);
  }
  expect(getAccount("ada", db)).toBeNull(); expect(getAccountByEmail("ada@example.test", db)).toBeNull();
  expect(listAccounts(db).map(a => a.id)).not.toContain("ada"); expect(accountLabels(["ada"], db).size).toBe(0);
  const bea = testAccountScope(db, "bea");
  expect(presencesOf(bea, [{ ownerId: "bea", homeId: "ada", projectId: "project" }], db)[0].home).toBe("ada");
  const reuse = insertAccount({ id: "reuse", name: "ada", email: "ada@example.test", passwordHash: null, isAdmin: false, status: "invited", now }, db);
  expect(reuse.sqlName).not.toBe("ada");
  for (const table of ["maps", "recipes", "map_history", "cascade_runs", "original_account"]) expect(rows()[table]).toEqual(before[table]);
  await expect(createFirstAccount({ name: "New", email: "new@example.test", password: "paper cranes at dawn" }, db)).rejects.toMatchObject({ code: "setup_complete" });
  const recovery = openRecoveryStore(directory);
  try { expect(selectRecoveryAdmin(recovery, "bea@example.test").id).toBe("bea"); expect(() => selectRecoveryAdmin(recovery, "ada@example.test")).toThrow(/active admin/); }
  finally { recovery.close(); }
});

it("keeps a deleting email reserved without a reactivation offer or an authenticatable profile", () => {
  reopen(); db.exec("UPDATE accounts SET status = 'deleting' WHERE id = 'ada'");
  expect(getAccount("ada", db)).toBeNull();
  try { requireAvailableEmail("ada@example.test", null, db, true); throw new Error("missing refusal"); }
  catch (error) { expect(error).toMatchObject({ code: "email_taken" }); expect(error).not.toHaveProperty("canReactivate", true); }
});

it("restores the entire stopped scratch backup without an in-place downgrade", () => {
  const beforeRows = rows(), beforeSchema = schema(); db.close();
  const backup = path.join(directory, "backup"), restored = path.join(directory, "restored");
  mkdirSync(backup);
  for (const name of ["metadata.sqlite", "secret.key", "tables"]) cpSync(path.join(directory, name), path.join(backup, name), { recursive: true });
  db = open(file); db.exec("UPDATE maps SET name = 'New value'"); db.close();
  cpSync(backup, restored, { recursive: true });
  expect(readFileSync(path.join(restored, "metadata.sqlite"))).toEqual(readFileSync(path.join(backup, "metadata.sqlite")));
  for (const name of ["secret.key", "tables/fixture.parquet"]) expect(readFileSync(path.join(restored, name))).toEqual(readFileSync(path.join(directory, name)));
  db = new Database(path.join(restored, "metadata.sqlite"));
  expect(db.pragma("user_version", { simple: true })).toBe(ENTRY); expect(rows()).toEqual(beforeRows); expect(schema()).toEqual(beforeSchema);
  db.close(); db = open(path.join(restored, "metadata.sqlite")); expect(rows()).toEqual(beforeRows);
});


it("keeps setup closed with only the retained original identity and permits remaining-admin recovery issuance", async () => {
  reopen(); eraseProfile();
  const { recoverAdmin } = await import("@/lib/auth/recovery.mjs");
  expect(recoverAdmin({ dataDir: directory, origin: "https://maps.example.test", email: "bea@example.test" }).account.id).toBe("bea");
  expect(() => recoverAdmin({ dataDir: directory, origin: "https://maps.example.test", email: "ada@example.test" })).toThrow(/active admin/);
  const isolated = open(":memory:");
  try {
    isolated.exec(`INSERT INTO accounts (id, status, sql_name, is_admin) VALUES ('gone', 'deleted', 'gone', NULL);
      INSERT INTO original_account VALUES (1, 'gone')`);
    expect(listAccounts(isolated)).toEqual([]); expect(setupComplete(isolated)).toBe(true);
    await expect(createFirstAccount({ name: "New", email: "new@example.test", password: "paper cranes at dawn" }, isolated)).rejects.toMatchObject({ code: "setup_complete" });
  } finally { isolated.close(); }
});
