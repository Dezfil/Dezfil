import Database from "better-sqlite3";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { EXTERNAL_SIGN_IN_MIGRATION } from "./migrations-external-sign-in";
import { IDENTITIES_MIGRATION, rebuildIdentities } from "./migrations-identities";
import { MIGRATIONS, open } from "./db";
import { allocateSqlNames, type SqlNameIdentity } from "./sql-names";

it.each(Array.from({ length: MIGRATIONS.length }, (_, version) => version))(
  "upgrades the store at version %i through external sign-in without replaying an applied entry", version => {
    const dir = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "every-version-"));
    const file = path.join(dir, "metadata.sqlite");
    let db = new Database(file);
    try {
      db.pragma("foreign_keys = ON");
      db.function("allocate_sql_names", (input: unknown) => JSON.stringify(allocateSqlNames(JSON.parse(String(input)) as SqlNameIdentity[])));
      for (const [index, sql] of MIGRATIONS.slice(0, version).entries()) {
        if (sql === IDENTITIES_MIGRATION) rebuildIdentities(db, sql, index + 1); else db.exec(sql);
        db.pragma(`user_version = ${index + 1}`);
      }
      if (version >= 40) {
        const hasSqlName = (db.pragma("table_info(accounts)") as { name: string }[]).some(c => c.name === "sql_name");
        db.exec(`INSERT INTO accounts(id,name,email,is_admin,status,created_at,updated_at${hasSqlName ? ",sql_name" : ""})
          VALUES('ada','Ada','ada@example.test',1,'active','time','time'${hasSqlName ? ",'ada'" : ""});
          INSERT INTO original_account VALUES(1,'ada');
          INSERT INTO auth_sessions(id,secret_hash,account_id,created_at,expires_at,last_used_at) VALUES('s','s-hash','ada',1,99,1);
          INSERT INTO auth_tokens(id,account_id,name,secret_hash,created_at) VALUES('t','ada','Token','t-hash',1);`);
      }
      db.close(); db = open(file);
      expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.prepare("SELECT * FROM auth_generations").all()).toEqual([{ singleton: 1, sign_out_generation: 0, door_generation: 0 }]);
      expect(db.prepare("SELECT * FROM auth_ticket_ids").all()).toEqual([]);
      if (version >= 40) {
        expect(db.prepare("SELECT id,email,external_identity FROM accounts").all()).toEqual([{ id: "ada", email: "ada@example.test", external_identity: null }]);
        for (const table of ["auth_sessions", "auth_tokens"]) {
          expect(db.prepare(`SELECT account_id,sign_out_generation,door_generation FROM ${table}`).all())
            .toEqual([{ account_id: "ada", sign_out_generation: 0, door_generation: 0 }]);
        }
      }
      db.close(); db = open(file);
      expect(db.prepare("SELECT * FROM auth_generations").all()).toHaveLength(1);
    } finally { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); }
  },
);

it("upgrades existing accounts and credentials at zero, then keeps identities, ids and generations across restart and restore", () => {
  const dir = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "external-migration-"));
  const file = path.join(dir, "metadata.sqlite");
  let db = new Database(file);
  try {
    db.function("allocate_sql_names", (input: unknown) => JSON.stringify(allocateSqlNames(JSON.parse(String(input)) as SqlNameIdentity[])));
    const position = MIGRATIONS.indexOf(EXTERNAL_SIGN_IN_MIGRATION);
    for (const [index, sql] of MIGRATIONS.slice(0, position).entries()) {
      if (sql === IDENTITIES_MIGRATION) rebuildIdentities(db, sql, index + 1); else db.exec(sql);
    }
    db.pragma(`user_version = ${position}`);
    db.exec(`INSERT INTO accounts(id,name,email,is_admin,status,created_at,updated_at,sql_name)
      VALUES('ada','Ada','ada@example.test',1,'active','time','time','ada');
      INSERT INTO auth_sessions VALUES('s','s-hash','ada',1,99,1,NULL);
      INSERT INTO auth_tokens VALUES('t','ada','Token','t-hash',1,NULL,NULL,NULL);`);
    db.close(); db = open(file);
    for (const table of ["auth_sessions", "auth_tokens"]) {
      expect(db.prepare(`SELECT sign_out_generation,door_generation FROM ${table}`).get()).toEqual({ sign_out_generation: 0, door_generation: 0 });
    }
    expect(db.prepare("SELECT external_identity FROM accounts").get()).toEqual({ external_identity: null });
    db.exec(`UPDATE accounts SET external_identity='stable-ada';
      UPDATE auth_generations SET sign_out_generation=3,door_generation=7;
      INSERT INTO auth_ticket_ids VALUES('accepted',99999);`);
    expect(() => db.exec(`INSERT INTO accounts(id,name,email,is_admin,status,created_at,updated_at,sql_name,external_identity)
      VALUES('other','Other','other@example.test',0,'active','time','time','other','stable-ada')`)).toThrow(/UNIQUE/);
    expect(() => db.exec(`INSERT INTO accounts(id,status,sql_name,is_admin,external_identity)
      VALUES('gone','deleted','gone',NULL,'private')`)).toThrow(/CHECK/);
    const snapshot = () => ["accounts", "auth_sessions", "auth_tokens", "auth_generations", "auth_ticket_ids"].map(t => db.prepare(`SELECT * FROM ${t}`).all());
    const before = snapshot(); db.close(); db = open(file); expect(snapshot()).toEqual(before);
    db.close(); cpSync(file, path.join(dir, "restored.sqlite")); db = open(path.join(dir, "restored.sqlite"));
    expect(snapshot()).toEqual(before); expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); }
});
