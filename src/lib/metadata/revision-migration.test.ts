import Database from "better-sqlite3";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, open } from "./db";
import { allocateSqlNames, type SqlNameIdentity } from "./sql-names";
import { testAccountScope } from "@/lib/test-support/accounts";
import { getMap, updateMapFields } from "./maps";
import { createRecipe, getRecipe } from "./recipes";
import { createCascade } from "./cascades";

const ENTRY = 45;
const time = "2026-01-02T03:04:05.000Z";
const token = /^[0-9a-f]{32}$/;
let directory: string, file: string, db: Database.Database;
let originalColumns: Record<string, string[]>;

function tables() {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(r => r.name);
}
function rows(columns = originalColumns) {
  return Object.fromEntries(Object.entries(columns).map(([table, names]) =>
    [table, db.prepare(`SELECT ${names.map(n => `"${n}"`).join(",")} FROM "${table}" ORDER BY rowid`).all()]));
}
function store() {
  return {
    schema: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
    rows: Object.fromEntries(tables().map(t => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()])),
    version: db.pragma("user_version", { simple: true }),
  };
}
function reopen() { db.close(); db = open(file); }
function seed() {
  testAccountScope(db, "ada");
  testAccountScope(db, "bea");
  db.exec(`
    INSERT INTO projects (id, name, created_at, updated_at, owner_id)
      VALUES ('project', 'Survey', '${time}', '${time}', 'ada');
    INSERT INTO project_people (project_id, account_id, role, added_at)
      VALUES ('project', 'bea', 'editor', '${time}');
    INSERT INTO maps (id, name, owner_id, home_account_id, project_id, publish_token, published_at, history_cursor, created_at, updated_at)
      VALUES ('map', 'Survey', 'ada', 'bea', 'project', 'shared-link', '${time}', 2, '${time}', '${time}'),
        ('other', 'Other', 'bea', 'bea', NULL, NULL, NULL, 0, '${time}', '${time}');
    INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at)
      VALUES ('layer', 'map', 'Roads', 'SELECT * FROM bea.roads', '{}', 0, '${time}', '${time}');
    INSERT INTO map_history (id, map_id, seq, scope, target_id, op, before, after, group_id, created_at)
      VALUES ('h1', 'map', 1, 'map', 'map', 'update', '{"name":"Before"}', '{"name":"Survey"}', 'g', '${time}'),
        ('h2', 'map', 2, 'layer', 'layer', 'update', '{"sql":"SELECT 1"}', '{"sql":"SELECT * FROM bea.roads"}', 'g', '${time}'),
        ('h3', 'map', 3, 'layer', 'layer', 'delete', '{}', NULL, NULL, '${time}');
    INSERT INTO recipes (id, name, origin, owner_id, home_account_id, project_id, created_at, updated_at)
      VALUES ('recipe', 'Workflow', 'workflow', 'ada', 'bea', 'project', '${time}', '${time}'),
        ('builder', 'Builder recipe', 'builder', 'bea', 'bea', NULL, '${time}', '${time}');
    INSERT INTO recipe_steps (id, recipe_id, ordinal, operation, parameters, proposed_parameters, origin, proposed_origin, created_at, updated_at)
      VALUES ('step', 'recipe', 0, 'sql_step', '{"sql":"SELECT 1"}', '{"sql":"SELECT 2"}', '{"layerId":"layer"}', '{"layerId":"other-layer"}', '${time}', '${time}');
    INSERT INTO recipe_layouts (recipe_id, document, updated_at)
      VALUES ('recipe', '{"steps":{"step":{"x":1,"y":2}},"sources":{"loose":{"x":3,"y":4}},"notes":[{"text":"Keep this"}]}', '${time}');
    INSERT INTO data_tables (id, name, format, file, row_count, owner_id, created_at)
      VALUES ('out', 'output', 'geoparquet', 'tables/out.parquet', 1, 'bea', '${time}');
    INSERT INTO cascade_runs (id, recipe_id, kind, outcome, started_at, finished_at, initiator_id)
      VALUES ('run', 'recipe', 'single', 'completed', '${time}', '${time}', 'bea'),
        ('adopted', 'recipe', 'single', 'completed', '${time}', '${time}', 'ada'),
        ('orphan', 'gone', 'single', 'completed', '${time}', '${time}', NULL);
    INSERT INTO step_runner_outputs (step_id, runner_id, output_table_id, output_table_name, run_id, succeeded_at)
      VALUES ('step', 'bea', 'out', 'output', 'run', '${time}');
  `);
  mkdirSync(path.join(directory, "tables"));
  writeFileSync(path.join(directory, "tables/out.parquet"), "retained artifact bytes");
  writeFileSync(path.join(directory, "instance.key"), "scratch encryption key bytes");
}

beforeEach(() => {
  directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "revisions-"));
  file = path.join(directory, "metadata.sqlite");
  db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.function("allocate_sql_names", { deterministic: true }, (accounts: unknown) =>
    JSON.stringify(allocateSqlNames(JSON.parse(String(accounts)) as SqlNameIdentity[])));
  for (const sql of MIGRATIONS.slice(0, ENTRY)) db.exec(sql);
  db.pragma(`user_version = ${ENTRY}`);
  originalColumns = Object.fromEntries(tables().map(table => [table,
    (db.pragma(`table_info("${table}")`) as { name: string }[]).map(c => c.name)]));
  seed();
});
afterEach(() => {
  if (db?.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("document revision migration", () => {
  it("adds one atomic entry, valid distinct document tokens and unknown actors without changing existing facts", () => {
    expect(MIGRATIONS).toHaveLength(ENTRY + 1);
    const before = rows();
    reopen();
    expect(rows()).toEqual(before);
    const revisions = [];
    for (const table of ["maps", "recipes"]) {
      const records = db.prepare(`SELECT edit_revision, last_changed_at, last_changed_by FROM ${table}`).all();
      for (const row of records as { edit_revision: string; last_changed_at: string; last_changed_by: string | null }[]) {
        expect(row.edit_revision).toMatch(token);
        revisions.push(row.edit_revision);
        expect(row.last_changed_at).toBe(time);
        expect(row.last_changed_by).toBeNull();
      }
    }
    expect(new Set(revisions).size).toBe(4);
    const definitions = db.prepare("SELECT executable_revision FROM recipes").all() as { executable_revision: string }[];
    expect(definitions).toHaveLength(2);
    for (const row of definitions) expect(row.executable_revision).toMatch(token);
    expect(new Set([...revisions, ...definitions.map(r => r.executable_revision)]).size).toBe(6);
    expect(db.prepare("SELECT DISTINCT author_id FROM map_history").all()).toEqual([{ author_id: null }]);
    // A past run has no recoverable admitted definition basis. Preserve its
    // stored initiator, including the prior adoption, without inventing one.
    expect(db.prepare("SELECT id, initiator_id, admitted_executable_revision FROM cascade_runs ORDER BY id").all()).toEqual([
      { id: "adopted", initiator_id: "ada", admitted_executable_revision: null },
      { id: "orphan", initiator_id: null, admitted_executable_revision: null },
      { id: "run", initiator_id: "bea", admitted_executable_revision: null },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    const upgraded = store();
    reopen();
    expect(store()).toEqual(upgraded);
  });

  it("rolls back every addition and initialized value on a late failure, then retries", () => {
    // This column is the entry's final addition. A collision fails after
    // document and author initialization, so partial commits are visible.
    db.exec("ALTER TABLE cascade_runs ADD COLUMN admitted_executable_revision TEXT");
    const before = store();
    db.close();
    expect(() => open(file)).toThrow(/duplicate column.*admitted_executable_revision/i);
    db = new Database(file);
    expect(store()).toEqual(before);
    db.exec("ALTER TABLE cascade_runs DROP COLUMN admitted_executable_revision");
    reopen();
    expect(db.prepare("SELECT edit_revision FROM maps WHERE id = 'map'").get()).toEqual({ edit_revision: expect.stringMatching(token) });
    expect(db.pragma("user_version", { simple: true })).toBe(ENTRY + 1);
  });

  it("allows pre-revision readers and writers to omit every new field", () => {
    reopen();
    // These repositories still use the pre-revision field lists. Inserts,
    // updates and existing SELECT * hydrators must accept the additive schema.
    expect(getMap("map", db)?.name).toBe("Survey");
    updateMapFields("map", { name: "Edited by an older writer" }, db);
    expect(getMap("map", db)?.name).toBe("Edited by an older writer");
    const recipe = createRecipe(testAccountScope(db, "ada"), "Older writer", db);
    expect(getRecipe(recipe.id, db)?.name).toBe("Older writer");
    const created = db.prepare("SELECT edit_revision, executable_revision, last_changed_by FROM recipes WHERE id = ?").get(recipe.id);
    expect(created).toEqual({ edit_revision: expect.stringMatching(token),
      executable_revision: expect.stringMatching(token), last_changed_by: null });
    db.exec(`INSERT INTO maps (id, name, owner_id, created_at, updated_at)
      VALUES ('old-new-map', 'Older map insert', 'ada', '${time}', '${time}')`);
    expect(db.prepare("SELECT edit_revision, last_changed_at, last_changed_by FROM maps WHERE id = 'old-new-map'").get())
      .toEqual({ edit_revision: expect.stringMatching(token), last_changed_at: time, last_changed_by: null });
    reopen();
    expect(db.prepare("SELECT edit_revision, executable_revision, last_changed_by FROM recipes WHERE id = ?").get(recipe.id)).toEqual(created);
    expect(createCascade(recipe.id, "single", [], db, "ada").recipeId).toBe(recipe.id);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    // No table rebuild or enforcing trigger: all additions stay nullable.
    for (const [table, names] of Object.entries({ maps: ["edit_revision", "last_changed_at", "last_changed_by"],
      recipes: ["edit_revision", "last_changed_at", "last_changed_by", "executable_revision"],
      map_history: ["author_id"], cascade_runs: ["admitted_executable_revision"] })) {
      const columns = db.pragma(`table_info(${table})`) as { name: string; notnull: number }[];
      for (const name of names) expect(columns.find(c => c.name === name)?.notnull).toBe(0);
    }
  });

  it("restores the complete stopped backup, including credentials and artifacts, without a down-migration", () => {
    const before = store();
    const backup = path.join(directory, "stopped-backup");
    db.close();
    mkdirSync(backup);
    for (const name of readdirSync(directory).filter(n => n !== "stopped-backup")) {
      cpSync(path.join(directory, name), path.join(backup, name), { recursive: true });
    }
    const backedUpDatabase = readFileSync(path.join(backup, "metadata.sqlite"));
    db = open(file);
    db.exec("UPDATE maps SET name = 'Changed after upgrade' WHERE id = 'map'");
    writeFileSync(path.join(directory, "tables/out.parquet"), "replaced artifact bytes");
    db.close();
    for (const name of readdirSync(directory).filter(n => n !== "stopped-backup")) rmSync(path.join(directory, name), { recursive: true });
    for (const name of readdirSync(backup)) cpSync(path.join(backup, name), path.join(directory, name), { recursive: true });
    expect(readFileSync(file)).toEqual(backedUpDatabase);
    expect(readFileSync(path.join(directory, "tables/out.parquet"), "utf8")).toBe("retained artifact bytes");
    expect(readFileSync(path.join(directory, "instance.key"), "utf8")).toBe("scratch encryption key bytes");
    db = new Database(file);
    expect(store()).toEqual(before);
    reopen();
    expect(db.prepare("SELECT edit_revision FROM maps WHERE id = 'map'").get()).toEqual({ edit_revision: expect.stringMatching(token) });
  });
});
