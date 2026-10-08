import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, open } from "./db";
import { accountPasswordHash, getAccount, getAccountByEmail, insertAccount, listAccounts, markOriginalAccount } from "./accounts";
import { accountViewPrefs, mergeAccountViewPrefs } from "./account-preferences";
import { insertToken, listAccountTokens, revokeAccountToken, tokenByHash } from "./auth-credentials";

let directory: string;
let file: string;
let db: Database.Database;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "dezfil-accounts-"));
  file = path.join(directory, "metadata.sqlite");
});

describe("account repositories", () => {
  it("normalizes reserved identities and never projects password hashes", () => {
    db = open(file);
    const first = insertAccount({ id: "first", name: "Ada", email: " Ada@Example.TEST ",
      passwordHash: "private-password-hash", isAdmin: true, status: "active", now }, db);
    expect(first.email).toBe("ada@example.test");
    markOriginalAccount(first.id, db);
    for (const status of ["invited", "active", "deactivated"] as const) {
      db.prepare("UPDATE accounts SET status = ? WHERE id = ?").run(status, first.id);
      expect(() => insertAccount({ id: "duplicate", name: "Another", email: "ADA@example.test",
        passwordHash: null, isAdmin: false, status: "invited", now }, db)).toThrow(/UNIQUE/);
    }
    expect(getAccountByEmail(" ADA@EXAMPLE.TEST ", db)?.id).toBe(first.id);
    expect(getAccount(first.id, db)?.isOriginal).toBe(true);
    expect(listAccounts(db)).toHaveLength(1);
    expect(JSON.stringify([first, getAccount(first.id, db), listAccounts(db)])).not.toMatch(/password|hash/i);
    expect(accountPasswordHash(first.id, db)).toBe("private-password-hash");
  });

  it("isolates preference merges and leaves legacy settings available", () => {
    db = open(file);
    account();
    account("second", "second@example.test");
    db.prepare("INSERT INTO workspace_settings VALUES ('view_prefs', ?, ?)")
      .run('{"maps":{"view":"grid"}}', now);
    expect(accountViewPrefs("first", db)).toEqual({});
    mergeAccountViewPrefs("first", { maps: { view: "list" } }, db);
    mergeAccountViewPrefs("first", { maps: { sort: "name" }, data: { view: "grid" } }, db);
    mergeAccountViewPrefs("second", { maps: { sort: "updated" } }, db);
    expect(accountViewPrefs("first", db)).toEqual({ maps: { view: "list", sort: "name" }, data: { view: "grid" } });
    expect(accountViewPrefs("second", db)).toEqual({ maps: { sort: "updated" } });
    expect(db.prepare("SELECT value FROM workspace_settings WHERE key = 'view_prefs'").get())
      .toEqual({ value: '{"maps":{"view":"grid"}}' });
    db.close();
    db = open(file);
    expect(accountViewPrefs("first", db).maps).toEqual({ view: "list", sort: "name" });
  });

  it("projects only a caller's token metadata and scopes revocation to that caller", () => {
    db = open(file);
    account();
    account("second", "second@example.test");
    insertToken({ id: "token", account_id: "first", name: "Terminal", secret_hash: "private-digest",
      created_at: 100, last_used_at: null, revoked_at: null }, db);
    expect(listAccountTokens("second", db)).toEqual([]);
    expect(JSON.stringify(listAccountTokens("first", db))).not.toMatch(/secret|hash|digest/);
    expect(revokeAccountToken("second", "token", 200, db)).toBe(false);
    expect(tokenByHash("private-digest", db)?.revoked_at).toBeNull();
    expect(revokeAccountToken("first", "token", 300, db)).toBe(true);
    db.close();
    db = open(file);
    expect(tokenByHash("private-digest", db)?.revoked_at).toBe(300);
  });
});
afterEach(() => {
  if (db?.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});

const now = "2026-01-01T00:00:00.000Z";
function account(id = "first", email = "first@example.test") {
  db.prepare(`INSERT INTO accounts
    (id, name, email, password_hash, is_admin, status, created_at, updated_at, sql_name)
    VALUES (?, 'Ada', ?, 'salted-password-hash', 1, 'active', ?, ?, ?)`)
    .run(id, email, now, now, id);
}

describe("account storage upgrade", () => {
  it("adds empty account storage and preserves every legacy field until adoption", () => {
    db = new Database(file);
    for (const migration of MIGRATIONS.slice(0, 39)) db.exec(migration);
    db.pragma("user_version = 39");
    db.exec(`INSERT INTO workspace_settings VALUES
      ('display_name', 'Ada Lovelace', '${now}'),
      ('view_prefs', '{"maps":{"view":"list"}}', '${now}'),
      ('instance_name', 'Field atlas', '${now}');
      INSERT INTO projects VALUES ('project', 'Survey', 'Keep this', '${now}', '${now}');
      INSERT INTO maps (id, name, publish_token, published_at, created_at, updated_at, project_id)
        VALUES ('map', 'Legacy map', 'legacy-publication', '${now}', '${now}', '${now}', 'project');
      INSERT INTO data_tables (id, name, format, file, row_count, created_at)
        VALUES ('table', 'survey', 'geoparquet', 'tables/survey.parquet', 4, '${now}');
      INSERT INTO project_datasets VALUES ('project', 'table', '${now}');
      INSERT INTO recipes (id, name, origin, created_at, updated_at, project_id)
        VALUES ('recipe', 'Legacy workflow', 'workflow', '${now}', '${now}', 'project');
      INSERT INTO pg_connections
        (id, name, host, port, database, username, password_encrypted, created_at)
        VALUES ('connection', 'Survey DB', 'db.example.test', 5432, 'survey', 'reader', 'opaque-encrypted-envelope', '${now}');`);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]).map(({ name }) => name);
    // Compare the fields the old store actually held, independently of
    // columns added by later migrations.
    const priorColumns = Object.fromEntries(tables.map(name => [name,
      (db.pragma(`table_info("${name}")`) as { name: string }[]).map(c => c.name)]));
    const snapshot = () => Object.fromEntries(tables.map(name =>
      [name, db.prepare(`SELECT * FROM "${name}"`).all().map(row =>
        Object.fromEntries(Object.entries(row as object).filter(([key]) => priorColumns[name].includes(key))))]));
    const before = snapshot();
    db.close();
    db = open(file);
    expect(snapshot()).toEqual(before);
    expect(db.prepare("SELECT * FROM accounts").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM original_account").all()).toEqual([]);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    db.close();
    db = open(file);
    expect(snapshot()).toEqual(before);
  });

  it("keeps account, original identity, credentials, revocations and preferences across reopen", () => {
    db = open(file);
    account();
    db.exec(`INSERT INTO original_account VALUES (1, 'first');
      INSERT INTO account_preferences VALUES ('first', '{"maps":{"sort":"name"}}', '${now}');
      INSERT INTO auth_sessions VALUES ('session', 'session-digest', 'first', 100, 200, 100, NULL);
      INSERT INTO auth_tokens VALUES ('token', 'first', 'CLI', 'token-digest', 100, NULL, 150, 300);
      INSERT INTO auth_links VALUES ('link', 'first', 'reset', 'link-digest', 100, 200, NULL, 150);`);
    const names = ["accounts", "original_account", "account_preferences", "auth_sessions", "auth_tokens", "auth_links"];
    const snapshot = () => names.map(name => db.prepare(`SELECT * FROM ${name}`).all());
    const before = snapshot();
    db.close();
    db = open(file);
    expect(snapshot()).toEqual(before);
    expect(db.prepare("SELECT revoked_at FROM auth_tokens").get()).toEqual({ revoked_at: 150 });
  });

  it("makes the original account marker immutable and unique, independently of role changes", () => {
    db = open(file);
    account();
    account("second", "second@example.test");
    db.exec("INSERT INTO original_account VALUES (1, 'first')");
    expect(() => db.exec("INSERT INTO original_account VALUES (2, 'second')")).toThrow();
    expect(() => db.exec("UPDATE original_account SET account_id = 'second'")).toThrow();
    expect(() => db.exec("DELETE FROM original_account")).toThrow();
    expect(() => db.exec("DELETE FROM accounts WHERE id = 'first'")).toThrow();
    db.exec("UPDATE accounts SET is_admin = 0 WHERE id = 'first'");
    expect(db.prepare("SELECT account_id FROM original_account").get()).toEqual({ account_id: "first" });
  });

  it("enforces credential uniqueness, account references and stored state domains", () => {
    db = open(file);
    account();
    expect(() => account("duplicate")).toThrow(/UNIQUE/);
    expect(() => db.exec("UPDATE accounts SET status = 'deleted'")).toThrow();
    expect(() => db.exec("UPDATE accounts SET is_admin = 2")).toThrow();
    expect(() => db.exec(`INSERT INTO auth_sessions VALUES ('session', 'digest', 'absent', 1, 2, 1, NULL)`)).toThrow();
    db.exec(`INSERT INTO auth_sessions VALUES ('session', 'digest', 'first', 1, 2, 1, NULL)`);
    expect(() => db.exec(`INSERT INTO auth_sessions VALUES ('other', 'digest', 'first', 1, 2, 1, NULL)`)).toThrow();
    expect(db.prepare("SELECT count(*) AS count FROM auth_sessions").get()).toEqual({ count: 1 });
  });
});
