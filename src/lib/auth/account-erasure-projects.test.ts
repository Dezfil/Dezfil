import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { erasureLedger, type ErasureLedger } from "../../../test-support/account-erasure-ledger";
import { proveErasure } from "../../../test-support/account-erasure-proof";
import * as metadata from "@/lib/metadata/db";
import { eraseAccountCredentials } from "@/lib/metadata/account-erasure";
import { eraseAccountContent } from "@/lib/metadata/account-erasure-content";
import { dissolveAccountProjects } from "@/lib/metadata/account-erasure-projects";
import { resolvePublication } from "@/lib/publish/publication-scope";
import { canReach } from "./reach";
import { withConnection, resetQueryInstance } from "@/lib/duckdb";
import { executeQuery } from "@/lib/query/execute";
import { mapEvaluation, workflowEvaluation } from "@/lib/query/context";
import path from "node:path";

let f: ErasureLedger;
beforeEach(() => { f = erasureLedger(); vi.spyOn(metadata, "metadataDb").mockReturnValue(f.db); });
afterEach(() => { resetQueryInstance(); vi.unstubAllEnvs(); vi.restoreAllMocks(); f.dispose(); });
const accept = () => f.db.exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
it.each(["active", "deactivated"])("refuses %s dissolution without a row or file change", state => {
  f.db.prepare("UPDATE accounts SET status = ? WHERE id = 'target'").run(state);
  const before = f.snapshot(), files = f.files();
  expect(() => dissolveAccountProjects("target", f.scopes.admin, f.db)).toThrow("deleting");
  expect(f.snapshot()).toEqual(before); expect(f.files()).toEqual(files);
});
it("requires a current admin as the recording actor", () => {
  accept(); const before = f.snapshot();
  expect(() => dissolveAccountProjects("target", f.scopes["target-near"], f.db)).toThrow("admin");
  expect(f.snapshot()).toEqual(before);
});
it("dissolves populated projects and grants and records each surviving unfiling exactly once, with a full ledger survivor diff", async () => {
  accept();
  const original = f.snapshot(), files = f.files();
  eraseAccountCredentials("target", f.db);
  eraseAccountContent("target", f.db);
  f.db.exec(`CREATE TEMP TABLE revision_writes (kind TEXT, id TEXT);
    CREATE TEMP TRIGGER map_revisions AFTER UPDATE OF edit_revision ON maps BEGIN INSERT INTO revision_writes VALUES ('map', NEW.id); END;
    CREATE TEMP TRIGGER workflow_revisions AFTER UPDATE OF edit_revision ON recipes BEGIN INSERT INTO revision_writes VALUES ('workflow', NEW.id); END;`);
  const tables = ["projects", "project_people", "project_datasets"];
  await proveErasure(f.inventoryFor(tables), f.probesFor(tables, f.dissolution), () => { dissolveAccountProjects("target", f.scopes.admin, f.db); });
  const expected = f.expected(original, [f.credentials, f.content, f.dissolution]);
  for (const table of ["maps", "recipes"]) {
    const row = f.rows(table).find(r => r.id === "target-near-in-target")!;
    const prior = expected[table].find(r => r.id === row.id)!;
    expect(row.edit_revision).toMatch(/^[0-9a-f]{32}$/); expect(row.edit_revision).not.toBe(prior.edit_revision);
    expect(row.last_changed_by).toBe("admin"); expect(Date.parse(String(row.last_changed_at))).toBeGreaterThan(Date.parse("2026-01-01"));
    Object.assign(prior, { project_id: null, edit_revision: row.edit_revision, last_changed_at: row.last_changed_at, last_changed_by: "admin" });
  }
  expect(f.snapshot()).toEqual(expected); expect(f.files()).toEqual(files);
  expect(f.db.prepare("SELECT * FROM revision_writes ORDER BY kind").all()).toEqual([
    { kind: "map", id: "target-near-in-target" }, { kind: "workflow", id: "target-near-in-target" },
  ]);
  const once = f.snapshot(); dissolveAccountProjects("target", f.scopes.admin, f.db);
  expect(f.snapshot()).toEqual(once);
  expect(f.db.prepare("SELECT count(*) AS n FROM revision_writes").get()).toEqual({ n: 2 });
  expect(f.db.pragma("foreign_key_check")).toEqual([]);
});
it("keeps surviving publications and owner reach, removes erased anonymous links and exclusive project reach", () => {
  const token = "publication-target-in-target", retained = "publication-target-near-in-target";
  expect(resolvePublication(token, f.db)!.scope.mapId).toBe("target-in-target");
  expect(canReach(f.scopes.admin, "map", "target-near-in-target", f.db)).toBe(true);
  accept(); eraseAccountContent("target", f.db); dissolveAccountProjects("target", f.scopes.admin, f.db);
  expect(resolvePublication(token, f.db)).toBeNull();
  expect(resolvePublication(retained, f.db)!.scope.mapId).toBe("target-near-in-target");
  expect(canReach(f.scopes.admin, "map", "target-near-in-target", f.db)).toBe(false);
  expect(canReach(f.scopes["target-near"], "map", "target-near-in-target", f.db)).toBe(true);
  expect(canReach(f.scopes.admin, "map", "target-near-in-target-near", f.db)).toBe(true);
});
it.each(["from", "to"])("removes a target %s transfer reservation with a populated independent singleton control", async side => {
  const control = erasureLedger();
  try {
    const gate = (ledger: ErasureLedger, from: string, to: string) => ledger.add("ownership_transfer_gate", {
      singleton: 1, resource_kind: "map", resource_id: "target-in-target", from_owner_id: from, to_owner_id: to,
    });
    gate(f, side === "from" ? "target" : "target-near", side === "to" ? "target" : "target-near");
    gate(control, "target-near", "admin"); accept();
    await proveErasure(f.inventoryFor(["ownership_transfer_gate"]), { "table:ownership_transfer_gate": {
      populate() {}, dispose() {}, observe() { return { target: f.rows("ownership_transfer_gate").map(r => JSON.stringify(r)), control: control.rows("ownership_transfer_gate").map(r => JSON.stringify(r)) }; },
    } }, () => { dissolveAccountProjects("target", f.scopes.admin, f.db); });
  } finally { control.dispose(); }
});
it("keeps an unrelated transfer reservation byte-for-byte", () => {
  f.add("ownership_transfer_gate", { singleton: 1, resource_kind: "map", resource_id: "target-near-in-target", from_owner_id: "target-near", to_owner_id: "admin" });
  accept(); const before = f.rows("ownership_transfer_gate");
  dissolveAccountProjects("target", f.scopes.admin, f.db);
  expect(f.rows("ownership_transfer_gate")).toEqual(before);
});
it("rolls back grants, unfiling and revision recording together on failure", () => {
  accept(); eraseAccountContent("target", f.db);
  f.db.exec("CREATE TRIGGER fail_recording BEFORE UPDATE OF edit_revision ON recipes BEGIN SELECT RAISE(ABORT, 'recording failed'); END");
  const before = f.snapshot();
  expect(() => dissolveAccountProjects("target", f.scopes.admin, f.db)).toThrow("recording failed");
  expect(f.snapshot()).toEqual(before);
});

it("keeps definitions intact while erased and dissolution-only inputs use the shipped missing-input state", async () => {
  vi.stubEnv("DEZFIL_DATA_DIR", f.directory); resetQueryInstance();
  f.add("project_datasets", { project_id: "project-target", table_id: "dataset-admin", added_at: "time" }, "dissolution");
  await withConnection(async conn => {
    for (const owner of ["target", "target-near", "admin"]) {
      const file = path.join(f.directory, `tables/${owner}.parquet`).replaceAll("'", "''");
      await conn.run(`COPY (SELECT '${owner}' AS sentinel) TO '${file}' (FORMAT PARQUET)`);
    }
  });
  const scope = f.scopes["target-near"];
  const contexts = [mapEvaluation(scope, "target-near-in-target", f.db), workflowEvaluation(scope, "target-near-in-target", f.db)];
  const definitions = () => [f.rows("layers"), f.rows("recipe_steps")].map(rows => rows.filter(r => String(r.id).startsWith("layer-target-near") || String(r.id).startsWith("step-target-near")));
  const before = definitions();
  for (const context of contexts) for (const owner of ["target", "admin"]) {
    expect((await executeQuery(context, `SELECT * FROM ${owner}.same_dataset`)).preview).toEqual([{ sentinel: owner }]);
  }
  accept(); eraseAccountContent("target", f.db); dissolveAccountProjects("target", f.scopes.admin, f.db);
  for (const context of contexts) for (const owner of ["target", "admin"]) {
    await expect(executeQuery(context, `SELECT * FROM ${owner}.same_dataset`)).rejects.toMatchObject({
      code: "sql_error", message: `The dataset "${owner}.same_dataset" is not available to you.`,
    });
  }
  await expect(executeQuery(scope, "SELECT * FROM target.same_dataset")).rejects.toMatchObject({ code: "sql_error", message: "The query refers to an unknown table." });
  expect((await executeQuery(scope, "SELECT * FROM same_dataset")).preview).toEqual([{ sentinel: "target-near" }]);
  expect((await executeQuery(f.scopes.admin, "SELECT * FROM same_dataset")).preview).toEqual([{ sentinel: "admin" }]);
  expect(definitions()).toEqual(before);
});

it("unfiles surviving member documents when their project dissolves", () => {
  accept(); eraseAccountContent("target", f.db);
  dissolveAccountProjects("target", f.scopes.admin, f.db);
  for (const table of ["maps", "recipes"]) expect(f.rows(table).find(r => r.id === "target-near-in-target")?.project_id).toBeNull();
});
