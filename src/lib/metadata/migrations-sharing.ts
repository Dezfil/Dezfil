import { sqlNameCondition } from "./sql-names";

const originalOwner = "(SELECT account_id FROM original_account WHERE singleton = 1)";
const recipeOwner = (recipe: string) => `(SELECT owner_id FROM recipes WHERE id = ${recipe})`;
const stepOwner = (step: string) =>
  `(SELECT r.owner_id FROM recipe_steps s JOIN recipes r ON r.id = s.recipe_id WHERE s.id = ${step})`;

/** The legacy single association of each step, adopted as its workflow
 * owner's per-runner row, with the job and run that produced it while their
 * records are still kept. Steps of ownerless workflows wait for setup. */
const adoptLegacyOutputs = `
  INSERT INTO step_runner_outputs
    (step_id, runner_id, output_table_id, output_table_name, job_id, run_id, succeeded_at)
  SELECT s.id, r.owner_id, s.output_table_id, s.output_table_name,
    (SELECT j.id FROM operation_jobs j WHERE j.subject_kind = 'step' AND j.subject_id = s.id
       AND j.state = 'succeeded' AND j.output_id = s.output_table_id
       ORDER BY j.finished_at DESC, j.id DESC LIMIT 1),
    (SELECT m.cascade_id FROM cascade_members m JOIN cascade_runs c ON c.id = m.cascade_id
       WHERE m.step_id = s.id AND m.state = 'succeeded' AND m.output_table_id = s.output_table_id
       ORDER BY c.started_at DESC, c.id DESC LIMIT 1),
    COALESCE(s.last_success_at, s.updated_at)
  FROM recipe_steps s JOIN recipes r ON r.id = s.recipe_id
  WHERE s.output_table_id IS NOT NULL AND s.output_table_name IS NOT NULL AND r.owner_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM step_runner_outputs o WHERE o.step_id = s.id);`;

/** Owner stamps at first-account adoption, with each SQL home set in the
 * same statement as its owner. */
const adoptOwners = [
  `UPDATE maps SET owner_id = ${originalOwner}, home_account_id = ${originalOwner} WHERE owner_id IS NULL;`,
  `UPDATE data_tables SET owner_id = ${originalOwner} WHERE owner_id IS NULL;`,
  `UPDATE recipes SET owner_id = ${originalOwner}, home_account_id = ${originalOwner} WHERE owner_id IS NULL;`,
  `UPDATE pg_connections SET owner_id = ${originalOwner} WHERE owner_id IS NULL;`,
  `UPDATE projects SET owner_id = ${originalOwner} WHERE owner_id IS NULL;`,
  `UPDATE operation_jobs SET owner_id = ${originalOwner} WHERE owner_id IS NULL;`,
].join("\n");

/** Ownership of a map, workflow or project changes only while a transfer
 * holds the gate open for exactly that row and that transition; first-account
 * adoption keeps its one null-to-original stamp. */
const ownerImmutable = (table: string, kind: string) => `
  DROP TRIGGER ${table}_owner_immutable;
  CREATE TRIGGER ${table}_owner_immutable BEFORE UPDATE OF owner_id ON ${table}
    WHEN (OLD.owner_id IS NOT NULL AND NEW.owner_id IS NOT OLD.owner_id AND NOT EXISTS (
        SELECT 1 FROM ownership_transfer_gate g
        WHERE g.resource_kind = '${kind}' AND g.resource_id = OLD.id AND NEW.id = OLD.id
          AND g.from_owner_id = OLD.owner_id AND g.to_owner_id = NEW.owner_id))
      OR (NEW.owner_id IS NULL AND EXISTS (SELECT 1 FROM original_account))
      OR (OLD.owner_id IS NULL AND NEW.owner_id IS NOT ${originalOwner})
    BEGIN SELECT RAISE(ABORT, 'Ownership cannot change'); END;`;

/** A map's or workflow's SQL home: the space of the account that created it.
 * Stamped from the owner, defaulted from the owner for a row inserted without
 * one, and fixed once set. */
const sqlHome = (table: string) => `
  ALTER TABLE ${table} ADD COLUMN home_account_id TEXT REFERENCES accounts(id);
  UPDATE ${table} SET home_account_id = owner_id;
  CREATE TRIGGER ${table}_home_from_creator AFTER INSERT ON ${table}
    WHEN NEW.home_account_id IS NULL AND NEW.owner_id IS NOT NULL
    BEGIN UPDATE ${table} SET home_account_id = NEW.owner_id WHERE id = NEW.id; END;
  CREATE TRIGGER ${table}_home_fixed BEFORE UPDATE OF home_account_id ON ${table}
    WHEN (OLD.home_account_id IS NOT NULL AND NEW.home_account_id IS NOT OLD.home_account_id)
      OR (OLD.home_account_id IS NULL AND NEW.home_account_id IS NOT NEW.owner_id)
    BEGIN SELECT RAISE(ABORT, 'A SQL home cannot change'); END;`;

const notMember = "BEGIN SELECT RAISE(ABORT, 'A project owner is never its member'); END;";

/**
 * Project sharing's metadata, one atomic entry:
 *
 *  - every account gets its SQL name, allocated by the application's own
 *    derivation (registered on the connection as `allocate_sql_names`), unique
 *    and fixed;
 *  - `project_people`: a project's viewers and editors, at most once each,
 *    never its owner;
 *  - SQL homes on maps and workflows;
 *  - the transfer gate the ownership triggers of maps, workflows and projects
 *    now admit; datasets, connections and jobs keep theirs unchanged;
 *  - the initiating account on every workflow run;
 *  - successful step outputs per runner, the legacy association adopted as the
 *    workflow owner's row, and lineage edges carrying their runner.
 *
 * Nothing is shared by it: every project keeps its owner and has no people.
 * The final statement is the last index, so a failure anywhere rolls every
 * earlier statement back with the version.
 */
export const SHARING_MIGRATION = `
  ALTER TABLE accounts ADD COLUMN sql_name TEXT;
  CREATE TEMP TABLE sql_name_allocation AS
    SELECT key AS account_id, value AS sql_name FROM json_each(allocate_sql_names((
      SELECT json_group_array(json_object('id', id, 'name', name, 'email', email, 'createdAt', created_at))
      FROM accounts)));
  UPDATE accounts SET sql_name = (SELECT sql_name FROM temp.sql_name_allocation WHERE account_id = accounts.id);
  DROP TABLE temp.sql_name_allocation;
  CREATE TEMP TABLE sql_name_guard (
    valid INTEGER CONSTRAINT "Every account needs a valid SQL name" CHECK (valid = 1)
  );
  INSERT INTO sql_name_guard SELECT NOT EXISTS (
    SELECT 1 FROM accounts WHERE sql_name IS NULL OR NOT (${sqlNameCondition("sql_name")}));
  DROP TABLE sql_name_guard;
  CREATE UNIQUE INDEX idx_accounts_sql_name ON accounts(sql_name);
  CREATE TRIGGER accounts_sql_name_required BEFORE INSERT ON accounts
    WHEN NEW.sql_name IS NULL OR NOT (${sqlNameCondition("NEW.sql_name")})
    BEGIN SELECT RAISE(ABORT, 'A valid SQL name is required'); END;
  CREATE TRIGGER accounts_sql_name_fixed BEFORE UPDATE OF sql_name ON accounts
    WHEN NEW.sql_name IS NOT OLD.sql_name
    BEGIN SELECT RAISE(ABORT, 'A SQL name cannot change'); END;

  CREATE TABLE project_people (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
    added_at TEXT NOT NULL,
    PRIMARY KEY (project_id, account_id)
  );
  CREATE INDEX idx_project_people_account ON project_people(account_id);
  CREATE TRIGGER project_people_owner_insert BEFORE INSERT ON project_people
    WHEN EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND owner_id = NEW.account_id)
    ${notMember}
  CREATE TRIGGER project_people_owner_update BEFORE UPDATE OF project_id, account_id ON project_people
    WHEN EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND owner_id = NEW.account_id)
    ${notMember}
  CREATE TRIGGER projects_owner_not_member BEFORE UPDATE OF owner_id ON projects
    WHEN EXISTS (SELECT 1 FROM project_people WHERE project_id = NEW.id AND account_id = NEW.owner_id)
    ${notMember}

  ${sqlHome("maps")}
  ${sqlHome("recipes")}

  CREATE TABLE ownership_transfer_gate (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    resource_kind TEXT NOT NULL CHECK (resource_kind IN ('map', 'workflow', 'project')),
    resource_id TEXT NOT NULL,
    from_owner_id TEXT NOT NULL REFERENCES accounts(id),
    to_owner_id TEXT NOT NULL REFERENCES accounts(id),
    CHECK (to_owner_id IS NOT from_owner_id)
  );
  CREATE TRIGGER ownership_transfer_gate_active_recipient BEFORE INSERT ON ownership_transfer_gate
    WHEN NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.to_owner_id AND status = 'active')
    BEGIN SELECT RAISE(ABORT, 'The new owner must be active'); END;
  ${ownerImmutable("maps", "map")}
  ${ownerImmutable("recipes", "workflow")}
  ${ownerImmutable("projects", "project")}

  ALTER TABLE cascade_runs ADD COLUMN initiator_id TEXT REFERENCES accounts(id);
  UPDATE cascade_runs SET initiator_id = ${recipeOwner("cascade_runs.recipe_id")};
  CREATE TRIGGER cascade_runs_initiator_default AFTER INSERT ON cascade_runs
    WHEN NEW.initiator_id IS NULL
    BEGIN UPDATE cascade_runs SET initiator_id = ${recipeOwner("NEW.recipe_id")} WHERE id = NEW.id; END;
  CREATE TRIGGER cascade_runs_initiator_fixed BEFORE UPDATE OF initiator_id ON cascade_runs
    WHEN OLD.initiator_id IS NOT NULL AND NEW.initiator_id IS NOT OLD.initiator_id
    BEGIN SELECT RAISE(ABORT, 'A run initiator cannot change'); END;

  CREATE TABLE step_runner_outputs (
    step_id TEXT NOT NULL REFERENCES recipe_steps(id) ON DELETE CASCADE,
    runner_id TEXT NOT NULL REFERENCES accounts(id),
    output_table_id TEXT NOT NULL,
    output_table_name TEXT NOT NULL,
    job_id TEXT,
    run_id TEXT,
    succeeded_at TEXT NOT NULL,
    PRIMARY KEY (step_id, runner_id)
  );
  CREATE INDEX idx_step_runner_outputs_output ON step_runner_outputs(output_table_id);
  ${adoptLegacyOutputs}

  ALTER TABLE lineage_edges ADD COLUMN runner_id TEXT REFERENCES accounts(id);
  UPDATE lineage_edges SET runner_id = ${stepOwner("lineage_edges.step_id")};
  CREATE TRIGGER lineage_edges_runner_default AFTER INSERT ON lineage_edges
    WHEN NEW.runner_id IS NULL
    BEGIN UPDATE lineage_edges SET runner_id = ${stepOwner("NEW.step_id")} WHERE id = NEW.id; END;

  DROP TRIGGER original_account_adopt_ownership;
  CREATE TRIGGER original_account_adopt_ownership AFTER INSERT ON original_account
    BEGIN
      ${adoptOwners}
      UPDATE cascade_runs SET initiator_id = ${recipeOwner("cascade_runs.recipe_id")} WHERE initiator_id IS NULL;
      UPDATE lineage_edges SET runner_id = ${stepOwner("lineage_edges.step_id")} WHERE runner_id IS NULL;
      ${adoptLegacyOutputs}
    END;

  CREATE INDEX idx_lineage_edges_runner ON lineage_edges(step_id, runner_id);`;
