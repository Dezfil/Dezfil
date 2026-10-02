import type { Database } from "better-sqlite3";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { open } from "./db";
import { insertMap, type MapRecord } from "./maps";
import { addStep, createRecipe, recordOutput } from "./recipes";
import { createProject, deleteProject } from "./owned-projects";
import { createCascade as createOwnedCascade } from "./owned-cascades";
import { createCascade } from "./cascades";
import { replaceEdges } from "./lineage";
import { insertTable, type DataTable } from "./tables";
import { insertConnection } from "./connections";
import { insertJob } from "./owned-jobs";
import { throughTransferGate, type TransferKind } from "./ownership-transfer";
import { testAccountScope } from "@/lib/test-support/accounts";
import { createFirstAccount, updateOwnProfile } from "@/lib/auth/accounts";
import { inviteAccount } from "@/lib/auth/admin";
import { authenticateSession } from "@/lib/auth/credentials";

let db: Database;
beforeEach(() => { db = open(":memory:"); });
afterEach(() => { db.close(); });
const now = "2026-01-01T00:00:00.000Z";
const record = (id: string): MapRecord => ({
  id, name: id, viewport: { lng: 0, lat: 0, zoom: 1 }, basemap: null, customBasemap: null, basemapLayers: null,
  note: null, legendCorner: null, legendOrder: null, timeline: null, widgets: [], widgetsPublished: true,
  publishToken: null, publishedAt: null, published: false, createdAt: now, updatedAt: now,
});
const table = (id: string, name: string): DataTable => ({
  id, name, sourceFilename: null, file: `tables/${id}.parquet`, format: "geoparquet", geometryColumn: null,
  geometryType: null, crsAssumed: false, headerSuspect: false, rowCount: 1, createdAt: now, source: "upload",
  sourceParams: null, importedAt: now,
});
const all = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args);
const value = (sql: string, ...args: unknown[]) => Object.values(db.prepare(sql).get(...args) as object)[0];

describe("project people", () => {
  it("holds each person at most once per project, as viewer or editor, never the owner", () => {
    const ada = testAccountScope(db, "ada");
    for (const id of ["bo", "cy", "dee"]) testAccountScope(db, id);
    const project = createProject(ada, { name: "Survey" }, db);
    const add = (account: string, role: string) => db.prepare(
      "INSERT INTO project_people (project_id, account_id, role, added_at) VALUES (?, ?, ?, ?)").run(project.id, account, role, now);
    add("bo", "viewer");
    add("cy", "editor");
    expect(() => add("bo", "editor")).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(() => add("ada", "editor")).toThrow("A project owner is never its member");
    expect(() => add("missing", "viewer")).toThrow(/FOREIGN KEY/);
    expect(() => add("dee", "owner")).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE project_people SET account_id = 'ada' WHERE account_id = 'bo'").run())
      .toThrow("A project owner is never its member");
    // Ownership cannot land on a person who is still a member, even through an open gate.
    expect(() => throughTransferGate({ kind: "project", id: project.id, from: "ada", to: "bo" }, db,
      () => db.prepare("UPDATE projects SET owner_id = 'bo' WHERE id = ?").run(project.id)))
      .toThrow("A project owner is never its member");
    expect(value("SELECT owner_id FROM projects WHERE id = ?", project.id)).toBe("ada");
    expect(all("SELECT account_id, role FROM project_people ORDER BY account_id")).toEqual([
      { account_id: "bo", role: "viewer" }, { account_id: "cy", role: "editor" },
    ]);
    deleteProject(ada, project.id, db);
    expect(all("SELECT * FROM project_people")).toEqual([]);
  });

  it("goes with an account's deletion, a path the product does not have", () => {
    const ada = testAccountScope(db, "ada");
    testAccountScope(db, "bo");
    const project = createProject(ada, { name: "Survey" }, db);
    db.prepare("INSERT INTO project_people VALUES (?, 'bo', 'viewer', ?)").run(project.id, now);
    db.prepare("DELETE FROM auth_sessions WHERE account_id = 'bo'").run();
    db.prepare("DELETE FROM accounts WHERE id = 'bo'").run();
    expect(all("SELECT * FROM project_people")).toEqual([]);
    // No source file deletes an account: accounts are deactivated, never removed.
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) sources.push(full);
      }
    };
    walk(path.join(process.cwd(), "src"));
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.filter(file => /DELETE\s+FROM\s+["`]?accounts\b/i.test(readFileSync(file, "utf8")))).toEqual([]);
  });
});

describe("SQL names", () => {
  const insert = (id: string, sqlName: string | null) => db.prepare(`INSERT INTO accounts
    (id, name, email, is_admin, status, created_at, updated_at, sql_name) VALUES (?, ?, ?, 0, 'active', ?, ?, ?)`)
    .run(id, id, `${id}@example.test`, now, now, sqlName);

  it("requires a valid, unique SQL name on every account and never changes it", () => {
    expect(() => insert("a", null)).toThrow("A valid SQL name is required");
    for (const bad of ["ab", "1abc", "Ada", "a-b", "main", "memory", "temp", "system", "information_schema", "pg_catalog", "duckdb_x", "pg_x", "a".repeat(33)]) {
      expect(() => insert("a", bad), bad).toThrow("A valid SQL name is required");
    }
    insert("a", "ada");
    expect(() => insert("b", "ada")).toThrow(/UNIQUE/);
    expect(() => db.prepare("UPDATE accounts SET sql_name = 'ada2' WHERE id = 'a'").run()).toThrow("A SQL name cannot change");
    expect(() => db.prepare("UPDATE accounts SET sql_name = NULL WHERE id = 'a'").run()).toThrow("A SQL name cannot change");
    db.prepare("UPDATE accounts SET name = 'Someone Else', email = 'else@example.test', status = 'deactivated' WHERE id = 'a'").run();
    expect(value("SELECT sql_name FROM accounts WHERE id = 'a'")).toBe("ada");
  });

  it("allocates one on first-run setup and on invitation, and keeps it through profile edits", async () => {
    const first = await createFirstAccount({ name: "Ada Lovelace", email: "ada@example.test", password: "field notebooks at dawn" }, db);
    const context = authenticateSession(first.secret, db)!;
    const twin = inviteAccount(context, { name: "Ada Lovelace", email: "lovelace@example.test" }, db).account;
    const main = inviteAccount(context, { name: "Main", email: "main@example.test" }, db).account;
    const symbols = inviteAccount(context, { name: "!!!", email: "field.notes@example.test" }, db).account;
    const name = (id: string) => value("SELECT sql_name FROM accounts WHERE id = ?", id);
    expect([name(first.account.id), name(twin.id), name(main.id), name(symbols.id)])
      .toEqual(["ada_lovelace", "ada_lovelace2", "main2", "field_notes"]);
    await updateOwnProfile(context, { name: "Grace Hopper" }, db);
    expect(name(first.account.id)).toBe("ada_lovelace");
  });
});

describe("SQL homes", () => {
  it("stamps a home from the creator, keeps a given one on copies, defaults raw rows to the owner and never changes it", () => {
    const ada = testAccountScope(db, "ada");
    testAccountScope(db, "bo");
    insertMap(ada, record("created"), db);
    insertMap(ada, record("copied"), db, "bo");
    const recipe = createRecipe(ada, "Workflow", db);
    const copy = createRecipe(ada, "Workflow copy", db, "workflow", "bo");
    db.exec(`INSERT INTO maps (id, name, created_at, updated_at, owner_id) VALUES ('raw', 'Raw', 'time', 'time', 'bo');
      INSERT INTO recipes (id, name, created_at, updated_at, owner_id) VALUES ('raw', 'Raw', 'time', 'time', 'bo');`);
    expect(all("SELECT id, owner_id, home_account_id FROM maps ORDER BY id")).toEqual([
      { id: "copied", owner_id: "ada", home_account_id: "bo" },
      { id: "created", owner_id: "ada", home_account_id: "ada" },
      { id: "raw", owner_id: "bo", home_account_id: "bo" },
    ]);
    expect(value("SELECT home_account_id FROM recipes WHERE id = 'raw'")).toBe("bo");
    expect(value("SELECT home_account_id FROM recipes WHERE id = ?", recipe.id)).toBe("ada");
    expect(value("SELECT home_account_id FROM recipes WHERE id = ?", copy.id)).toBe("bo");
    for (const relation of ["maps", "recipes"]) {
      expect(() => db.prepare(`UPDATE ${relation} SET home_account_id = 'bo' WHERE id = 'created' OR id = ?`).run(recipe.id))
        .toThrow("A SQL home cannot change");
      expect(() => db.prepare(`UPDATE ${relation} SET home_account_id = NULL WHERE id = 'raw'`).run())
        .toThrow("A SQL home cannot change");
    }
  });
});

describe("the ownership transfer gate", () => {
  const kinds: [TransferKind, string][] = [["map", "maps"], ["workflow", "recipes"], ["project", "projects"]];
  function owned(kind: TransferKind, id: string, owner: string) {
    const scope = testAccountScope(db, owner);
    if (kind === "map") insertMap(scope, record(id), db);
    else if (kind === "workflow") db.prepare("INSERT INTO recipes (id, name, created_at, updated_at, owner_id) VALUES (?, ?, 'time', 'time', ?)").run(id, id, owner);
    else db.prepare("INSERT INTO projects (id, name, created_at, updated_at, owner_id) VALUES (?, ?, 'time', 'time', ?)").run(id, id, owner);
  }
  const move = (relation: string, id: string, to: string) => db.prepare(`UPDATE ${relation} SET owner_id = ? WHERE id = ?`).run(to, id);
  const owner = (relation: string, id: string) => value(`SELECT owner_id FROM ${relation} WHERE id = ?`, id);
  beforeEach(() => { for (const id of ["ada", "bo", "cy"]) testAccountScope(db, id); });

  it.each(kinds)("refuses a %s ownership change outside a transfer", (kind, relation) => {
    owned(kind, "x", "ada");
    expect(() => move(relation, "x", "bo")).toThrow("Ownership cannot change");
    expect(owner(relation, "x")).toBe("ada");
  });

  it.each(kinds)("admits exactly the one %s transition an open gate names", (kind, relation) => {
    owned(kind, "x", "ada");
    owned(kind, "y", "ada");
    throughTransferGate({ kind, id: "x", from: "ada", to: "bo" }, db, () => {
      expect(() => move(relation, "y", "bo")).toThrow("Ownership cannot change");
      expect(() => move(relation, "x", "cy")).toThrow("Ownership cannot change");
      move(relation, "x", "bo");
      expect(() => move(relation, "x", "ada")).toThrow("Ownership cannot change");
      expect(all("SELECT * FROM ownership_transfer_gate")).toHaveLength(1);
    });
    expect([owner(relation, "x"), owner(relation, "y")]).toEqual(["bo", "ada"]);
    expect(all("SELECT * FROM ownership_transfer_gate")).toEqual([]);
    expect(() => move(relation, "x", "ada")).toThrow("Ownership cannot change");
  });

  it.each(kinds)("leaves no %s gate behind and changes nothing when the transfer fails after the update", (kind, relation) => {
    owned(kind, "x", "ada");
    expect(() => throughTransferGate({ kind, id: "x", from: "ada", to: "bo" }, db, () => {
      move(relation, "x", "bo");
      throw new Error("role adjustment failed");
    })).toThrow("role adjustment failed");
    expect(owner(relation, "x")).toBe("ada");
    expect(all("SELECT * FROM ownership_transfer_gate")).toEqual([]);
  });

  it("refuses an inactive recipient, an unknown kind and a second open gate", () => {
    owned("map", "x", "ada");
    db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'cy'").run();
    expect(() => throughTransferGate({ kind: "map", id: "x", from: "ada", to: "cy" }, db, () => move("maps", "x", "cy")))
      .toThrow("The new owner must be active");
    expect(() => throughTransferGate({ kind: "dataset" as TransferKind, id: "x", from: "ada", to: "bo" }, db, () => undefined))
      .toThrow(/CHECK/);
    expect(() => throughTransferGate({ kind: "map", id: "x", from: "ada", to: "bo" }, db,
      () => throughTransferGate({ kind: "map", id: "x", from: "ada", to: "bo" }, db, () => undefined))).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(owner("maps", "x")).toBe("ada");
    expect(all("SELECT * FROM ownership_transfer_gate")).toEqual([]);
  });

  it("keeps datasets, connections and jobs immutable while a gate is open for the same identity", () => {
    const ada = testAccountScope(db, "ada");
    owned("map", "same", "ada");
    insertTable(ada, table("same", "roads"), db);
    insertConnection(ada, { id: "same", name: "Survey", host: "db.example.test", port: 5432, database: "survey", username: "reader", password: "secret", ssl: true }, db);
    insertJob(ada, { id: "same", subjectKind: "run", subjectId: "same", operation: "sql", parameters: null, state: "queued", errorCode: null,
      errorMessage: null, outputId: null, outputName: null, acceptedAt: now, startedAt: null, finishedAt: null }, db);
    throughTransferGate({ kind: "map", id: "same", from: "ada", to: "bo" }, db, () => {
      for (const relation of ["data_tables", "pg_connections", "operation_jobs"]) {
        expect(() => move(relation, "same", "bo"), relation).toThrow("Ownership cannot change");
      }
      move("maps", "same", "bo");
    });
    expect(owner("maps", "same")).toBe("bo");
    for (const relation of ["data_tables", "pg_connections", "operation_jobs"]) expect(owner(relation, "same")).toBe("ada");
  });
});

describe("runs keep their initiator and runner", () => {
  function workflow(owner: string) {
    const scope = testAccountScope(db, owner);
    const recipe = createRecipe(scope, "Workflow", db);
    const step = addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT 1 AS n", name: "out" } }, db);
    return { scope, recipe, step };
  }

  it("records the initiating account on every run and never changes it", () => {
    const { scope, recipe, step } = workflow("ada");
    const run = createOwnedCascade(scope, recipe.id, "single", [{ stepId: step.id, ordinal: 0 }], db);
    const legacy = createCascade(recipe.id, "single", [{ stepId: step.id, ordinal: 0 }], db);
    expect(value("SELECT initiator_id FROM cascade_runs WHERE id = ?", run.id)).toBe("ada");
    expect(value("SELECT initiator_id FROM cascade_runs WHERE id = ?", legacy.id)).toBe("ada");
    testAccountScope(db, "bo");
    expect(() => db.prepare("UPDATE cascade_runs SET initiator_id = 'bo' WHERE id = ?").run(run.id)).toThrow("A run initiator cannot change");
  });

  it("writes the per-runner output beside the legacy association on every write, and lineage with its runner", () => {
    const { scope, step } = workflow("ada");
    insertTable(scope, table("first", "out"), db);
    recordOutput(step.id, { id: "first", name: "out" }, "2026-01-02T00:00:00.000Z", db, { accountId: "ada", jobId: "job-1", runId: "run-1" });
    expect(all("SELECT output_table_id, output_table_name, last_success_at FROM recipe_steps WHERE id = ?", step.id))
      .toEqual([{ output_table_id: "first", output_table_name: "out", last_success_at: "2026-01-02T00:00:00.000Z" }]);
    expect(all("SELECT * FROM step_runner_outputs")).toEqual([{ step_id: step.id, runner_id: "ada", output_table_id: "first",
      output_table_name: "out", job_id: "job-1", run_id: "run-1", succeeded_at: "2026-01-02T00:00:00.000Z" }]);
    // A write that does not name its runner records the workflow's owner, the only runner there has been.
    recordOutput(step.id, { id: "second", name: "out" }, "2026-01-03T00:00:00.000Z", db);
    expect(all("SELECT runner_id, output_table_id, job_id, run_id, succeeded_at FROM step_runner_outputs")).toEqual([
      { runner_id: "ada", output_table_id: "second", job_id: null, run_id: null, succeeded_at: "2026-01-03T00:00:00.000Z" },
    ]);
    replaceEdges(scope, step.id, "second", [{ inputTableId: "first", inputTableName: "out", boundArtifact: "tables/first.parquet" }], db);
    expect(all("SELECT runner_id FROM lineage_edges WHERE step_id = ?", step.id)).toEqual([{ runner_id: "ada" }]);
  });
});
