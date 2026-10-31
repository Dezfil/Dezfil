import Database from "better-sqlite3";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { IDENTITIES_MIGRATION, rebuildIdentities } from "./migrations-identities";
import { MIGRATIONS, open } from "./db";
import { allocateSqlNames, type SqlNameIdentity } from "./sql-names";

it("upgrades existing accounts and credentials at zero, then keeps identities, ids and generations across restart and restore", () => {
  const dir = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "external-migration-"));
  const file = path.join(dir, "metadata.sqlite");
  let db = new Database(file);
  try {
    db.function("allocate_sql_names", (input: unknown) => JSON.stringify(allocateSqlNames(JSON.parse(String(input)) as SqlNameIdentity[])));
    for (const [index, sql] of MIGRATIONS.slice(0, -1).entries()) {
      if (sql === IDENTITIES_MIGRATION) rebuildIdentities(db, sql, index + 1); else db.exec(sql);
    }
    db.pragma(`user_version = ${MIGRATIONS.length - 1}`);
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
