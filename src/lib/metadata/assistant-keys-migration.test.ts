import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { ASSISTANT_KEYS_MIGRATION } from "./migrations-assistant-keys";
import { IDENTITIES_MIGRATION, rebuildIdentities } from "./migrations-identities";
import { MIGRATIONS, open } from "./db";
import { allocateSqlNames, type SqlNameIdentity } from "./sql-names";

it("upgrades a store from the version before the key table, with no key for anyone, and erases with the account", () => {
  const dir = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "keys-migration-"));
  const file = path.join(dir, "metadata.sqlite");
  const at = MIGRATIONS.indexOf(ASSISTANT_KEYS_MIGRATION);
  expect(at).toBeGreaterThan(0);
  let db = new Database(file);
  try {
    db.pragma("foreign_keys = ON");
    db.function("allocate_sql_names", (input: unknown) => JSON.stringify(allocateSqlNames(JSON.parse(String(input)) as SqlNameIdentity[])));
    for (const [index, sql] of MIGRATIONS.slice(0, at).entries()) {
      if (sql === IDENTITIES_MIGRATION) rebuildIdentities(db, sql, index + 1); else db.exec(sql);
    }
    db.pragma(`user_version = ${at}`);
    db.exec(`INSERT INTO accounts(id,name,email,is_admin,status,created_at,updated_at,sql_name) VALUES('ada','Ada','ada@example.test',1,'active','time','time','ada');
      INSERT INTO original_account VALUES(1,'ada');`);
    expect(() => db.prepare("SELECT * FROM assistant_keys").all()).toThrow(/no such table/);
    db.close(); db = open(file);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(db.prepare("SELECT * FROM assistant_keys").all()).toEqual([]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.prepare("INSERT INTO assistant_keys VALUES ('ada', 'openai', 'envelope', 'f00d', 1)").run();
    expect(() => db.prepare("INSERT INTO assistant_keys VALUES ('ada', 'openai', 'second', 'f00d', 1)").run()).toThrow(/UNIQUE/);
    expect(() => db.prepare("UPDATE assistant_keys SET provider = 'other'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO assistant_keys VALUES ('nobody', 'openai', 'envelope', 'f00d', 1)").run()).toThrow(/FOREIGN KEY/);
    db.close(); db = open(file);
    expect(db.prepare("SELECT account_id, provider, last_four FROM assistant_keys").all()).toEqual([{ account_id: "ada", provider: "openai", last_four: "f00d" }]);
  } finally { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); }
});
