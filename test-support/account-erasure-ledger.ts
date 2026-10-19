import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { open } from "../src/lib/metadata/db";
import { testAccountScope } from "../src/lib/test-support/accounts";
import { erasureInventory } from "../src/lib/auth/account-erasure-inventory";
import type { ErasureProbe } from "./account-erasure-proof";

type Row = Record<string, unknown> & { _row: number };
export const contentTables = ["maps", "layers", "map_pictures", "map_history", "layer_tiles", "data_tables", "pg_connections", "recipes", "recipe_steps", "recipe_layouts", "cascade_runs", "cascade_members", "operation_jobs", "step_runner_outputs", "lineage_edges", "project_datasets"];
/** The fixture assigns expectations when it creates a row. It never consumes
 * the erasure service's captured inventory, counts or reported deletions. */
export function erasureLedger() {
  const directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "content-ledger-"));
  const db = open(":memory:");
  const scopes = Object.fromEntries(["target", "target-near", "admin"].map(id => [id, testAccountScope(db, id)]));
  db.exec("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'");
  const content: Record<string, number[]> = {}, dissolution: Record<string, number[]> = {};
  function add(table: string, row: Record<string, unknown>, erase?: "content" | "dissolution") {
    const result = db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    if (erase) ((erase === "content" ? content : dissolution)[table] ??= []).push(Number(result.lastInsertRowid));
  }
  const time = { created_at: "2026-01-01", updated_at: "2026-01-01" };
  for (const owner of ["target", "target-near", "admin"]) {
    const gone = owner === "target" ? "content" : undefined;
    add("projects", { id: `project-${owner}`, name: "same project", ...time, owner_id: owner }, owner === "target" ? "dissolution" : undefined);
    add("data_tables", { id: `dataset-${owner}`, name: "same_dataset", format: "parquet", file: `tables/${owner}.parquet`, row_count: 1, created_at: time.created_at, owner_id: owner }, gone);
    add("pg_connections", { id: `connection-${owner}`, name: "same connection", host: "localhost", port: 5432, database: "gis", username: "user", password_encrypted: `${owner}-envelope`, created_at: time.created_at, owner_id: owner }, gone);
    mkdirSync(path.join(directory, "tables"), { recursive: true });
    writeFileSync(path.join(directory, `tables/${owner}.parquet`), `${owner}-independent-file`);
    add("account_preferences", { account_id: owner, view_prefs: `${owner}-prefs`, updated_at: time.updated_at });
  }
  for (const owner of ["target", "target-near"]) for (const filing of ["target", "target-near"]) {
    const id = `${owner}-in-${filing}`, gone = owner === "target" ? "content" : undefined;
    add("maps", { id, name: "same map", ...time, owner_id: owner, home_account_id: "target", project_id: `project-${filing}`, last_changed_by: "target", publish_token: `publication-${id}`, published_at: time.created_at }, gone);
    add("map_pictures", { map_id: id, digest: "drawing", drawing_changed_at: 1, requested_at: 1, next_attempt_at: 1 }, gone);
    add("layers", { id: `layer-${id}`, map_id: id, name: "layer", sql: 'SELECT * FROM target.same_dataset', style: '{}', ordinal: 0, ...time }, gone);
    add("layer_tiles", { layer_id: `layer-${id}`, state: "ready", fingerprint: `fingerprint-${id}`, updated_at: time.updated_at }, gone);
    add("map_history", { id: `history-${id}`, map_id: id, seq: 1, scope: "map", target_id: id, op: "update", before: '{}', after: '{"name":"same map"}', created_at: time.created_at, author_id: "target" }, gone);
    add("recipes", { id, name: "same workflow", ...time, owner_id: owner, home_account_id: "target", project_id: `project-${filing}`, origin: "workflow", last_changed_by: "target" }, gone);
    add("recipe_steps", { id: `step-${id}`, recipe_id: id, ordinal: 0, operation: "sql", parameters: '{"sql":"SELECT * FROM target.same_dataset"}', output_table_id: `dataset-${owner}`, output_table_name: "same_dataset", ...time }, gone);
    add("recipe_layouts", { recipe_id: id, document: '{"nodes":[]}', updated_at: time.updated_at }, gone);
    add("cascade_runs", { id: `run-${id}`, recipe_id: id, kind: "single", started_at: time.created_at, initiator_id: "target" }, gone);
    add("operation_jobs", { id: `job-${id}`, owner_id: "target", subject_kind: "step", subject_id: `step-${id}`, operation: "sql", state: "succeeded", accepted_at: time.created_at, output_id: `dataset-${owner}` }, gone);
    add("cascade_members", { cascade_id: `run-${id}`, step_id: `step-${id}`, ordinal: 0, state: "succeeded", job_id: `job-${id}`, stopped_reason: "personal text remains in a surviving run" }, gone);
    add("lineage_edges", { id: `edge-${id}`, step_id: `step-${id}`, output_table_id: `dataset-${owner}`, input_table_id: 'dataset-target', input_table_name: 'target.same_dataset', bound_artifact: 'retained-input-generation', recorded_at: time.created_at, runner_id: "target" }, gone);
    add("step_runner_outputs", { step_id: `step-${id}`, runner_id: owner, output_table_id: `dataset-${owner}`, output_table_name: "same_dataset", succeeded_at: time.created_at }, gone);
  }
  // Other people's independent outputs survive even when their producing
  // workflow goes. Its contained associations, jobs and run members do not.
  add("step_runner_outputs", { step_id: "step-target-in-target", runner_id: "target-near", output_table_id: "dataset-target-near", output_table_name: "same_dataset", succeeded_at: time.created_at }, "content");
  add("operation_jobs", { id: "other-runner-in-erased-workflow", owner_id: "target-near", subject_kind: "step", subject_id: "step-target-in-target", operation: "sql", state: "succeeded", accepted_at: time.created_at }, "content");
  for (const owner of ["target", "target-near"]) {
    add("operation_jobs", { id: `standalone-${owner}`, owner_id: owner, subject_kind: "client", subject_id: "step-target-in-target", operation: "sql", state: "succeeded", accepted_at: time.created_at }, owner === "target" ? "content" : undefined);
    // Removed steps still have workflow-contained history through run members.
    const gone = owner === "target" ? "content" : undefined;
    add("operation_jobs", { id: `removed-step-${owner}`, owner_id: "target", subject_kind: "step", subject_id: `absent-${owner}`, operation: "sql", state: "succeeded", accepted_at: time.created_at }, gone);
    add("cascade_members", { cascade_id: `run-${owner}-in-target`, step_id: `absent-${owner}`, ordinal: 1, state: "succeeded", job_id: `removed-step-${owner}` }, gone);
    for (const filing of ["target", "target-near"]) add("project_datasets", { project_id: `project-${filing}`, table_id: `dataset-${owner}`, added_at: time.created_at }, owner === "target" ? "content" : filing === "target" ? "dissolution" : undefined);
  }
  add("step_runner_outputs", { step_id: "step-target-near-in-target", runner_id: "target", output_table_id: "dataset-target", output_table_name: "same_dataset", succeeded_at: time.created_at }, "content");
  add("lineage_edges", { id: "target-output-in-surviving-workflow", step_id: "step-target-near-in-target", output_table_id: "dataset-target", input_table_id: "dataset-target-near", input_table_name: "same_dataset", bound_artifact: "generation", recorded_at: time.created_at, runner_id: "target" }, "content");
  for (const [project, member] of [["target", "target-near"], ["target", "admin"], ["target-near", "target"], ["target-near", "admin"]]) {
    add("project_people", { project_id: `project-${project}`, account_id: member, role: "editor", added_at: time.created_at }, project === "target" || member === "target" ? "dissolution" : undefined);
  }
  const rows = (table: string) => db.prepare(`SELECT rowid AS _row, * FROM ${table} ORDER BY rowid`).all() as Row[];
  const snapshot = () => Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(({ name }) => [name, rows(name)]));
  const files = () => Object.fromEntries(readdirSync(directory, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => {
    const file = path.join(e.parentPath, e.name); return [path.relative(directory, file), createHash("sha256").update(readFileSync(file)).digest("hex")];
  }));
  function probesFor(tables: string[], group: Record<string, number[]>): Record<string, ErasureProbe> {
    return Object.fromEntries(tables.map(table => [`table:${table}`, { populate() {}, dispose() {}, observe() {
      return { target: rows(table).filter(r => group[table]?.includes(r._row)).map(r => JSON.stringify(r)), control: rows(table).filter(r => !group[table]?.includes(r._row)).map(r => JSON.stringify(r)) };
    } }]));
  }
  function expected(before: ReturnType<typeof snapshot>, groups: Record<string, number[]>[]) {
    return Object.fromEntries(Object.entries(before).map(([table, values]) => [table, values.filter(r => !groups.some(g => g[table]?.includes(r._row)))]));
  }
  const credentials = Object.fromEntries(["account_preferences", "auth_sessions"].map(table => [table, rows(table).filter(r => r.account_id === "target").map(r => r._row)]));
  return { db, directory, scopes, add, content, dissolution, credentials, rows, snapshot, files, expected, probesFor,
    inventoryFor(tables: string[]) { return { ...erasureInventory, stores: Object.fromEntries(tables.map(table => [`table:${table}`, erasureInventory.stores[`table:${table}` as keyof typeof erasureInventory.stores]])) }; },
    dispose() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}
export type ErasureLedger = ReturnType<typeof erasureLedger>;
