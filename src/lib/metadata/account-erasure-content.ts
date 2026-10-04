import type { Database } from "better-sqlite3";
import { requireDeletingAccount } from "./account-erasure";

const ownedWorkflows = "SELECT id FROM recipes WHERE owner_id = @account";
const ownedSteps = `SELECT id FROM recipe_steps WHERE recipe_id IN (${ownedWorkflows})`;
const ownedRuns = `SELECT id FROM cascade_runs WHERE recipe_id IN (${ownedWorkflows})`;
const ownedDatasets = "SELECT id FROM data_tables WHERE owner_id = @account";
const erasedJob = `(subject_kind = 'step' AND (subject_id IN (${ownedSteps})
  OR id IN (SELECT job_id FROM cascade_members WHERE cascade_id IN (${ownedRuns}))))
  OR (owner_id = @account AND NOT (subject_kind = 'step' AND (
    EXISTS (SELECT 1 FROM recipe_steps s JOIN recipes r ON r.id = s.recipe_id
      WHERE s.id = operation_jobs.subject_id AND r.owner_id IS NOT @account)
    OR EXISTS (SELECT 1 FROM cascade_members m JOIN cascade_runs c ON c.id = m.cascade_id
      JOIN recipes r ON r.id = c.recipe_id WHERE m.job_id = operation_jobs.id AND r.owner_id IS NOT @account))))`;

export interface AccountContentCapture {
  datasets: { id: string; file: string; source: string; sourceParams: string | null }[];
  maps: string[];
  layers: { id: string; mapId: string }[];
  workflows: string[];
  steps: string[];
  runs: string[];
  jobs: string[];
  connections: string[];
}

/** Capture before any cascade destroys the identities needed for file and
 * retained-state cleanup. The coordinator must journal this before erasure. */
export function captureAccountContent(accountId: string, db: Database): AccountContentCapture {
  requireDeletingAccount(accountId, db);
  const args = { account: accountId };
  const ids = (sql: string) => (db.prepare(sql).all(args) as { id: string }[]).map(r => r.id);
  return {
    datasets: db.prepare(`SELECT id, file, source, source_params AS sourceParams FROM data_tables WHERE owner_id = @account ORDER BY id`).all(args) as AccountContentCapture["datasets"],
    maps: ids("SELECT id FROM maps WHERE owner_id = @account ORDER BY id"),
    layers: db.prepare("SELECT id, map_id AS mapId FROM layers WHERE map_id IN (SELECT id FROM maps WHERE owner_id = @account) ORDER BY id").all(args) as AccountContentCapture["layers"],
    workflows: ids(`${ownedWorkflows} ORDER BY id`), steps: ids(`${ownedSteps} ORDER BY id`), runs: ids(`${ownedRuns} ORDER BY id`),
    jobs: ids(`SELECT id FROM operation_jobs WHERE ${erasedJob} ORDER BY id`),
    connections: ids("SELECT id FROM pg_connections WHERE owner_id = @account ORDER BY id"),
  };
}

/** Only identity and parent relations select rows. In a surviving workflow,
 * job ownership is its historical runner, not authority to erase its history. */
export function eraseAccountContent(accountId: string, db: Database): AccountContentCapture {
  return db.transaction(() => {
    requireDeletingAccount(accountId, db);
    const captured = captureAccountContent(accountId, db), args = { account: accountId };
    db.prepare(`DELETE FROM operation_jobs WHERE ${erasedJob}`).run(args);
    db.prepare(`DELETE FROM cascade_runs WHERE recipe_id IN (${ownedWorkflows})`).run(args);
    db.prepare(`DELETE FROM lineage_edges WHERE output_table_id IN (${ownedDatasets})`).run(args);
    db.prepare(`DELETE FROM step_runner_outputs WHERE runner_id = @account OR output_table_id IN (${ownedDatasets})`).run(args);
    for (const table of ["maps", "recipes", "data_tables", "pg_connections"]) {
      db.prepare(`DELETE FROM ${table} WHERE owner_id = @account`).run(args);
    }
    return captured;
  }).immediate();
}
