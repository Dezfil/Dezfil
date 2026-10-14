import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, open } from "./db";
import { createFirstAccount } from "@/lib/auth/accounts";

/** The entry under test: the first migration that knows project people. */
const ENTRY = MIGRATIONS.findIndex(sql => sql.includes("CREATE TABLE project_people"));
const FINAL_STATEMENT = "CREATE INDEX idx_lineage_edges_runner ON lineage_edges(step_id, runner_id);";
/** Columns the entry adds, each a stamp derived from existing rows. */
let priorColumns: Record<string, string[]>;
/** The tables this entry adds, and the basemap library's, which a later
 * entry adds with nothing in it. */
const ADDED_TABLES = new Set(["project_people", "ownership_transfer_gate", "step_runner_outputs", "basemap_styles"]);
const now = "2026-01-01T00:00:00.000Z";
let directory: string, file: string, db: Database.Database;

beforeEach(() => {
  directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "sharing-"));
  file = path.join(directory, "metadata.sqlite");
  db = new Database(file);
  db.pragma("foreign_keys = ON");
  for (const migration of MIGRATIONS.slice(0, ENTRY)) db.exec(migration);
  db.pragma(`user_version = ${ENTRY}`);
  priorColumns = Object.fromEntries(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map(({ name }) => [name, (db.pragma(`table_info("${name}")`) as { name: string }[]).map(c => c.name)]),
  );
});
afterEach(() => {
  if (db?.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});

function account(id: string, name: string, email: string, created = now) {
  db.prepare(`INSERT INTO accounts (id, name, email, is_admin, status, created_at, updated_at)
    VALUES (?, ?, ?, 0, 'active', ?, ?)`).run(id, name, email, created, created);
}
/** Work owned by named accounts (null leaves it for setup to adopt). */
function populate(first: string | null, second: string | null) {
  const owner = (id: string | null) => (id === null ? "NULL" : `'${id}'`);
  // Two people may each have a "roads"; one person (or setup's one owner) has one.
  const otherName = first !== null && second !== null && first !== second ? "roads" : "other_roads";
  db.exec(`INSERT INTO projects (id, name, note, created_at, updated_at, owner_id) VALUES ('project', 'Survey', 'Keep this', '${now}', '${now}', ${owner(first)});
    INSERT INTO maps (id, name, publish_token, published_at, created_at, updated_at, project_id, owner_id)
      VALUES ('map', 'Survey map', 'publication', '${now}', '${now}', '${now}', 'project', ${owner(first)}),
             ('other-map', 'Other map', NULL, NULL, '${now}', '${now}', NULL, ${owner(second)});
    INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at)
      VALUES ('layer', 'map', 'Roads', 'SELECT * FROM roads', '{}', 0, '${now}', '${now}');
    INSERT INTO map_history (id, map_id, seq, scope, target_id, op, before, after, created_at)
      VALUES ('history', 'map', 1, 'layer', 'layer', 'update', '{"sql":"SELECT 1"}', '{"sql":"SELECT * FROM roads"}', '${now}');
    INSERT INTO data_tables (id, name, format, file, row_count, created_at, owner_id)
      VALUES ('roads', 'roads', 'geoparquet', 'tables/roads.parquet', 4, '${now}', ${owner(first)}),
             ('other-roads', '${otherName}', 'geoparquet', 'tables/other-roads.parquet', 2, '${now}', ${owner(second)}),
             ('roads-out', 'roads_out', 'geoparquet', 'tables/roads-out.parquet', 4, '${now}', ${owner(first)});
    INSERT INTO project_datasets VALUES ('project', 'roads', '${now}');
    INSERT INTO recipes (id, name, origin, created_at, updated_at, project_id, owner_id)
      VALUES ('recipe', 'Survey workflow', 'workflow', '${now}', '${now}', 'project', ${owner(first)}),
             ('other-recipe', 'Other workflow', 'workflow', '${now}', '${now}', NULL, ${owner(second)});
    INSERT INTO recipe_steps (id, recipe_id, ordinal, operation, parameters, output_table_id, output_table_name, last_success_at, created_at, updated_at)
      VALUES ('step', 'recipe', 0, 'sql_step', '{"sql":"SELECT * FROM roads","name":"roads_out"}', 'roads-out', 'roads_out', '2026-01-02T00:00:00.000Z', '${now}', '${now}'),
             ('other-step', 'other-recipe', 0, 'sql_step', '{"sql":"SELECT 1"}', NULL, NULL, NULL, '${now}', '${now}');
    INSERT INTO lineage_edges VALUES ('edge', 'step', 'roads-out', 'roads', 'roads', 'tables/roads.parquet', '${now}');
    INSERT INTO operation_jobs (id, subject_kind, subject_id, operation, state, accepted_at, finished_at, output_id, output_name, owner_id)
      VALUES ('job', 'step', 'step', 'sql_step', 'succeeded', '${now}', '2026-01-02T00:00:00.000Z', 'roads-out', 'roads_out', ${owner(first)});
    INSERT INTO cascade_runs (id, recipe_id, kind, outcome, started_at, finished_at)
      VALUES ('run', 'recipe', 'single', 'completed', '${now}', '2026-01-02T00:00:00.000Z'),
             ('orphan-run', 'deleted-recipe', 'single', 'completed', '${now}', '${now}');
    INSERT INTO cascade_members (cascade_id, step_id, ordinal, state, job_id, output_table_id, output_table_name)
      VALUES ('run', 'step', 0, 'succeeded', 'job', 'roads-out', 'roads_out');
    INSERT INTO pg_connections (id, name, host, port, database, username, password_encrypted, created_at, owner_id)
      VALUES ('connection', 'Survey DB', 'db.example.test', 5432, 'survey', 'reader', 'opaque-envelope', '${now}', ${owner(first)});`);
}
function reopen() { db.close(); db = open(file); }
function raw() { db.close(); db = new Database(file); db.pragma("foreign_keys = ON"); }
/** Every row of every table the store had before the entry, without the
 * columns and tables the entry adds. */
function rows() {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map(row => row.name).filter(name => !ADDED_TABLES.has(name));
  return Object.fromEntries(names.map(name => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()
    .map(row => Object.fromEntries(Object.entries(row as object).filter(([key]) => priorColumns[name].includes(key))))]));
}
/** The whole store: schema objects (tables, indexes, triggers with their
 * SQL), every row and the migration version. */
function store() {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(row => row.name);
  return {
    schema: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
    rows: Object.fromEntries(names.map(name => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])),
    version: db.pragma("user_version", { simple: true }),
  };
}
const column = (sql: string) => db.prepare(sql).all();

describe("the project-sharing migration entry", () => {
  it("is one entry after every earlier entry, whose serialized SQL is unchanged", () => {
    expect(ENTRY).toBe(44);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(ENTRY + 1);
    expect(createHash("sha256").update(JSON.stringify(MIGRATIONS.slice(0, ENTRY))).digest("hex"))
      .toBe("ba07b3d7f99babecaf5872074eb87ed7206a8a6aced8154251a3a0de6a301089");
    expect(MIGRATIONS[ENTRY].trim().endsWith(FINAL_STATEMENT)).toBe(true);
  });

  it("upgrades a populated store with nothing shared, every existing row kept and every stamp derived", () => {
    account("first", "Ada Lovelace", "ada@example.test", "2026-01-01T00:00:00.000Z");
    account("second", "Ada Lovelace", "lovelace@example.test", "2026-01-02T00:00:00.000Z");
    account("third", "main", "main@example.test", "2026-01-03T00:00:00.000Z");
    account("fourth", "!!!", "field.notes@example.test", "2026-01-04T00:00:00.000Z");
    db.exec("INSERT INTO original_account VALUES (1, 'first')");
    populate("first", "second");
    const before = rows();
    reopen();
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(before.cascade_runs).toContainEqual(expect.objectContaining({ id: "orphan-run" }));
    expect(rows()).toEqual({ ...before, cascade_runs: before.cascade_runs.filter((row: unknown) =>
      (row as { id: string }).id !== "orphan-run") });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(column("SELECT id, sql_name FROM accounts ORDER BY created_at")).toEqual([
      { id: "first", sql_name: "ada_lovelace" }, { id: "second", sql_name: "ada_lovelace2" },
      { id: "third", sql_name: "main2" }, { id: "fourth", sql_name: "field_notes" },
    ]);
    for (const table of ["maps", "recipes"]) {
      expect(column(`SELECT id FROM ${table} WHERE home_account_id IS NOT owner_id OR home_account_id IS NULL`), table).toEqual([]);
    }
    expect(column("SELECT id, initiator_id FROM cascade_runs ORDER BY id")).toEqual([
      { id: "run", initiator_id: "first" },
    ]);
    expect(column("SELECT id, runner_id FROM lineage_edges")).toEqual([{ id: "edge", runner_id: "first" }]);
    expect(column("SELECT * FROM step_runner_outputs")).toEqual([{
      step_id: "step", runner_id: "first", output_table_id: "roads-out", output_table_name: "roads_out",
      job_id: "job", run_id: "run", succeeded_at: "2026-01-02T00:00:00.000Z",
    }]);
    // Nothing shared: every project keeps its owner and has no people.
    expect(column("SELECT * FROM project_people")).toEqual([]);
    expect(column("SELECT * FROM ownership_transfer_gate")).toEqual([]);
    expect(column("SELECT id FROM projects WHERE owner_id IS NULL")).toEqual([]);
    const upgraded = store();
    reopen();
    expect(store()).toEqual(upgraded);
  });

  it("keeps a mid-setup store pending, then stamps homes, initiators, runners and outputs in the setup transaction", async () => {
    populate(null, null);
    const before = rows();
    reopen();
    expect(before.cascade_runs).toContainEqual(expect.objectContaining({ id: "orphan-run" }));
    expect(rows()).toEqual({ ...before, cascade_runs: before.cascade_runs.filter((row: unknown) =>
      (row as { id: string }).id !== "orphan-run") });
    for (const sql of ["SELECT DISTINCT home_account_id AS v FROM maps", "SELECT DISTINCT home_account_id AS v FROM recipes",
      "SELECT DISTINCT initiator_id AS v FROM cascade_runs", "SELECT DISTINCT runner_id AS v FROM lineage_edges"]) {
      expect(column(sql), sql).toEqual([{ v: null }]);
    }
    expect(column("SELECT * FROM step_runner_outputs")).toEqual([]);
    const first = await createFirstAccount({ name: "Ada Lovelace", email: "ada@example.test", password: "field notebooks at dawn" }, db);
    const id = first.account.id;
    expect(column("SELECT sql_name FROM accounts")).toEqual([{ sql_name: "ada_lovelace" }]);
    for (const table of ["maps", "recipes"]) {
      expect(column(`SELECT DISTINCT owner_id, home_account_id FROM ${table}`), table).toEqual([{ owner_id: id, home_account_id: id }]);
    }
    expect(column("SELECT id, initiator_id FROM cascade_runs ORDER BY id")).toEqual([
      { id: "run", initiator_id: id },
    ]);
    expect(column("SELECT runner_id FROM lineage_edges")).toEqual([{ runner_id: id }]);
    expect(column("SELECT step_id, runner_id, output_table_id, job_id, run_id FROM step_runner_outputs"))
      .toEqual([{ step_id: "step", runner_id: id, output_table_id: "roads-out", job_id: "job", run_id: "run" }]);
    expect(column("SELECT * FROM project_people")).toEqual([]);
    const adopted = store();
    reopen();
    expect(store()).toEqual(adopted);
  });

  it.each([
    ["a populated store", true],
    ["a mid-setup store", false],
  ])("rolls back schema, triggers, rows and version on a late failure in %s, then retries", async (_label, adopted) => {
    if (adopted) {
      account("first", "Ada Lovelace", "ada@example.test");
      db.exec("INSERT INTO original_account VALUES (1, 'first')");
      populate("first", "first");
    } else {
      populate(null, null);
    }
    // The entry's last statement creates this index; a same-named index
    // elsewhere fails the entry after every earlier statement has run.
    db.exec("CREATE INDEX idx_lineage_edges_runner ON maps(name)");
    const before = store();
    db.close();
    expect(() => open(file)).toThrow(/idx_lineage_edges_runner/);
    raw();
    expect(store()).toEqual(before);
    expect(db.pragma("user_version", { simple: true })).toBe(ENTRY);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.exec("DROP INDEX idx_lineage_edges_runner");
    reopen();
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    if (!adopted) {
      expect(column("SELECT DISTINCT home_account_id AS v FROM maps")).toEqual([{ v: null }]);
      await createFirstAccount({ name: "Ada Lovelace", email: "ada@example.test", password: "field notebooks at dawn" }, db);
    }
    const owner = (column("SELECT account_id FROM original_account") as { account_id: string }[])[0].account_id;
    expect(column("SELECT DISTINCT home_account_id AS v FROM maps")).toEqual([{ v: owner }]);
    expect(column("SELECT DISTINCT home_account_id AS v FROM recipes")).toEqual([{ v: owner }]);
    expect(column("SELECT runner_id FROM step_runner_outputs")).toEqual([{ runner_id: owner }]);
    expect(column("SELECT sql_name FROM accounts")).toEqual([{ sql_name: "ada_lovelace" }]);
  });

  it("falls back to the fixed word, suffixed, for stored identities that yield no usable name", () => {
    account("first", "", "");
    account("second", "", "x@example.test", "2026-01-05T00:00:00.000Z");
    db.exec("INSERT INTO original_account VALUES (1, 'first')");
    reopen();
    expect(column("SELECT id, sql_name FROM accounts ORDER BY id")).toEqual([
      { id: "first", sql_name: "user" }, { id: "second", sql_name: "user2" },
    ]);
  });
});
