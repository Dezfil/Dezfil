import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, open } from "./db";
import { createFirstAccount } from "@/lib/auth/accounts";

const owned = ["maps", "data_tables", "recipes", "pg_connections", "projects", "operation_jobs"];
const now = "2026-01-01T00:00:00.000Z";
let directory: string, file: string, db: Database.Database;
let priorColumns: Record<string, string[]>;

beforeEach(() => {
  directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "ownership-"));
  file = path.join(directory, "metadata.sqlite");
  db = new Database(file);
  db.pragma("foreign_keys = ON");
  for (const migration of MIGRATIONS.slice(0, 41)) db.exec(migration);
  db.pragma("user_version = 41");
  priorColumns = Object.fromEntries(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map(({ name }) => [name, (db.pragma(`table_info("${name}")`) as { name: string }[]).map(c => c.name)]),
  );
  db.exec(`INSERT INTO projects VALUES ('project', 'Survey', 'Keep this', '${now}', '${now}');
    INSERT INTO maps (id, name, publish_token, published_at, created_at, updated_at, project_id)
      VALUES ('map', 'Legacy map', 'legacy-publication', '${now}', '${now}', '${now}', 'project');
    INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at)
      VALUES ('layer', 'map', 'Roads', 'SELECT * FROM roads', '{}', 0, '${now}', '${now}');
    INSERT INTO map_history (id, map_id, seq, scope, target_id, op, before, after, created_at)
      VALUES ('history', 'map', 1, 'layer', 'layer', 'update', '{"sql":"SELECT 1"}', '{"sql":"SELECT * FROM roads"}', '${now}');
    INSERT INTO layer_tiles (layer_id, state, fingerprint, updated_at) VALUES ('layer', 'ready', 'artifact-fingerprint', '${now}');
    INSERT INTO data_tables (id, name, format, file, row_count, created_at, source, source_params, geometry_recognition)
      VALUES ('table', 'roads', 'geoparquet', 'tables/legacy.parquet', 4, '${now}', 'postgis', '{"connectionId":"connection"}', '{"geometryState":"spatial"}');
    INSERT INTO project_datasets VALUES ('project', 'table', '${now}');
    INSERT INTO recipes (id, name, origin, created_at, updated_at, project_id)
      VALUES ('recipe', 'Legacy workflow', 'workflow', '${now}', '${now}', 'project');
    INSERT INTO recipe_steps (id, recipe_id, ordinal, operation, parameters, output_table_id, output_table_name, created_at, updated_at)
      VALUES ('step', 'recipe', 0, 'sql', '{"sql":"SELECT * FROM roads"}', 'table', 'roads', '${now}', '${now}');
    INSERT INTO recipe_layouts VALUES ('recipe', '{"steps":{},"sources":{},"notes":[]}', '${now}');
    INSERT INTO lineage_edges VALUES ('edge', 'step', 'table', 'deleted-input', 'source', 'tables/source.parquet', '${now}');
    INSERT INTO operation_jobs (id, subject_kind, subject_id, operation, state, accepted_at, output_id)
      VALUES ('job', 'standalone', 'job', 'sql', 'failed', '${now}', 'deleted-output');
    INSERT INTO cascade_runs (id, recipe_id, kind, started_at) VALUES ('cascade', 'recipe', 'all', '${now}');
    INSERT INTO cascade_members (cascade_id, step_id, ordinal, state, job_id) VALUES ('cascade', 'step', 0, 'failed', 'job');
    INSERT INTO pg_connections (id, name, host, port, database, username, password_encrypted, created_at, last_check_outcome)
      VALUES ('connection', 'Survey DB', 'db.example.test', 5432, 'survey', 'reader', 'opaque-encrypted-envelope', '${now}', 'working');`);
});
afterEach(() => {
  if (db?.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});

function account(id: string, status = "active", admin = false) {
  db.prepare(`INSERT INTO accounts (id, name, email, is_admin, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, id, `${id}@example.test`, Number(admin), status, now, now);
}
function reopen() { db.close(); db = open(file); }
// Hold every table and column the ownership entry received. Selecting the
// recorded columns also refuses a missing legacy table or column after upgrade.
function snapshot() {
  return Object.fromEntries(Object.entries(priorColumns).map(([table, columns]) =>
    [table, db.prepare(`SELECT ${columns.map(name => `"${name}"`).join(", ")} FROM "${table}"`).all()]));
}
function expectOwners(id: string | null) {
  for (const table of owned) expect(db.prepare(`SELECT DISTINCT owner_id FROM ${table}`).all(), table).toEqual([{ owner_id: id }]);
}

describe("durable ownership adoption", () => {
  it.each(["active", "deactivated"])("adopts the recorded first account even when it is %s and another account is admin", status => {
    account("first", status);
    account("admin", "active", true);
    account("later");
    db.exec("INSERT INTO original_account VALUES (1, 'first')");
    const before = snapshot();
    reopen();
    expectOwners("first");
    expect(snapshot()).toEqual(before);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare("SELECT * FROM project_datasets").all()).toEqual([{ project_id: "project", table_id: "table", added_at: now }]);
    reopen();
    expectOwners("first");
    expect(snapshot()).toEqual(before);
  });

  it("keeps legacy work pending until setup, then adopts in the account transaction", async () => {
    const before = snapshot();
    reopen();
    expectOwners(null);
    expect(snapshot()).toEqual(before);
    const first = await createFirstAccount({ name: "Ada", email: "ada@example.test", password: "field notebooks at dawn" }, db);
    expectOwners(first.account.id);
    const adopted = snapshot();
    reopen();
    expectOwners(first.account.id);
    expect(snapshot()).toEqual(adopted);
  });

  it("rolls back the rebuild and exact memberships under enforced foreign keys and retries", () => {
    account("first");
    db.exec(`INSERT INTO original_account VALUES (1, 'first');
      CREATE TRIGGER reject_membership_restore BEFORE INSERT ON project_datasets
      BEGIN SELECT RAISE(ABORT, 'membership restore failed'); END;`);
    const before = snapshot();
    db.close();
    expect(() => open(file)).toThrow("membership restore failed");
    db = new Database(file);
    db.pragma("foreign_keys = ON");
    expect(db.pragma("user_version", { simple: true })).toBe(41);
    expect(snapshot()).toEqual(before);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.exec("DROP TRIGGER reject_membership_restore");
    reopen();
    expectOwners("first");
    expect(snapshot()).toEqual(before);
  });

  it("rolls back setup and all owner stamps on a late adoption failure, then retries", async () => {
    reopen();
    db.exec(`CREATE TRIGGER reject_session BEFORE INSERT ON auth_sessions
      BEGIN SELECT RAISE(ABORT, 'session failed'); END;`);
    const before = snapshot();
    const input = { name: "Ada", email: "ada@example.test", password: "field notebooks at dawn" };
    await expect(createFirstAccount(input, db)).rejects.toThrow("session failed");
    expectOwners(null);
    expect(snapshot()).toEqual(before);
    reopen();
    expectOwners(null);
    db.exec("DROP TRIGGER reject_session");
    const first = await createFirstAccount(input, db);
    expectOwners(first.account.id);
  });

  it("refuses an account-bearing store with no original marker without guessing an owner", () => {
    account("admin", "active", true);
    const before = snapshot();
    db.close();
    expect(() => open(file)).toThrow(/original account/i);
    db = new Database(file);
    expect(db.pragma("user_version", { simple: true })).toBe(41);
    expect(snapshot()).toEqual(before);
  });

  it("rejects ownerless inserts, foreign owners and reassignment after adoption", () => {
    account("first"); account("second");
    db.exec("INSERT INTO original_account VALUES (1, 'first')");
    reopen();
    for (const table of owned) {
      expect(() => db.prepare(`UPDATE ${table} SET owner_id = 'second'`).run(), table).toThrow();
      expect(() => db.prepare(`UPDATE ${table} SET owner_id = NULL`).run(), table).toThrow();
      const columns = (db.pragma(`table_info(${table})`) as { name: string }[]).map(column => column.name);
      const values = columns.map(column => column === "id" ? "'new'" : column === "name" ? "'New resource'"
        : column === "owner_id" ? "?" : column === "publish_token" ? "NULL" : `"${column}"`);
      const clone = db.prepare(`INSERT INTO ${table} SELECT ${values.join(", ")} FROM ${table}`);
      expect(() => clone.run(null), table).toThrow("An owner is required");
      expect(() => clone.run("missing"), table).toThrow(/FOREIGN KEY/);
    }
    expectOwners("first");
  });
});
