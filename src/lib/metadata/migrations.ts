import { DATASET_CONNECTION_MIGRATIONS } from "./migrations-datasets-connections";
import { OWNERSHIP_MIGRATION, CONNECTION_NAMES_MIGRATION, DATASET_NAMES_MIGRATION } from "./migrations-ownership";
import { REVISIONS_MIGRATION } from "./migrations-revisions";
import { SHARING_MIGRATION } from "./migrations-sharing";
import { IDENTITIES_MIGRATION } from "./migrations-identities";

export const MIGRATIONS: string[] = [
  DATASET_CONNECTION_MIGRATIONS.v1,
  // v2 — maps and their layers. A layer IS its SQL text plus a style; the
  // map owns layer order, visibility, viewport. Publishing lives here too.
  `CREATE TABLE maps (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     view_lng REAL NOT NULL DEFAULT 0,
     view_lat REAL NOT NULL DEFAULT 20,
     view_zoom REAL NOT NULL DEFAULT 1.4,
     publish_token TEXT UNIQUE,
     published_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE layers (
     id TEXT PRIMARY KEY,
     map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     sql TEXT NOT NULL,
     style TEXT NOT NULL,
     visible INTEGER NOT NULL DEFAULT 1,
     ordinal INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX idx_layers_map ON layers(map_id, ordinal);`,
  // v3 — builder core: per-map basemap choice (null = deployment
  // default); per-layer tooltip fields (JSON array, null = automatic) and
  // legend inclusion. Earlier rows read cleanly through the defaults.
  `ALTER TABLE maps ADD COLUMN basemap TEXT;
   ALTER TABLE layers ADD COLUMN tooltip TEXT;
   ALTER TABLE layers ADD COLUMN in_legend INTEGER NOT NULL DEFAULT 1;`,
  // v4 — analysis core: per-layer visualization config (JSON, null =
  // points), filters (JSON array, null = none), and legend text overrides
  // (null = automatic). Earlier rows read cleanly through the defaults.
  `ALTER TABLE layers ADD COLUMN viz TEXT;
   ALTER TABLE layers ADD COLUMN filters TEXT;
   ALTER TABLE layers ADD COLUMN legend_title TEXT;
   ALTER TABLE layers ADD COLUMN legend_labels TEXT;`,
  // v5 — tiled rendering: one build record per tiled layer. The
  // fingerprint identifies the effective query the archive was built from;
  // freshness is decided by comparing it. Layers without a record simply
  // have no tiles (every earlier row).
  `CREATE TABLE layer_tiles (
     layer_id TEXT PRIMARY KEY REFERENCES layers(id) ON DELETE CASCADE,
     state TEXT NOT NULL,
     fingerprint TEXT NOT NULL,
     error TEXT,
     feature_count INTEGER,
     built_at TEXT,
     updated_at TEXT NOT NULL
   )`,
  // v6 — builder polish: per-channel legend attribute-name overrides (JSON
  // object keyed by channel, null = automatic). Earlier rows read cleanly
  // through the default.
  `ALTER TABLE layers ADD COLUMN legend_attrs TEXT;`,
  // v7 — map info box: one optional note per map (JSON: title, body,
  // corner; null = no box — every earlier row).
  `ALTER TABLE maps ADD COLUMN note TEXT;`,
  // v8 — basemap layer toggles: per-map visibility of basemap content groups
  // (JSON object keeping only hidden groups; null = all visible — every pre-
  // row).
  `ALTER TABLE maps ADD COLUMN basemap_layers TEXT;`,
  // v9 — overlay ergonomics: where the legend sits (one of the four
  // corners; null = bottom-left — every earlier row).
  `ALTER TABLE maps ADD COLUMN legend_corner TEXT;`,
  // v10 — labels & pop-ups: per-layer click pop-up fields (JSON array,
  // null = automatic), a sibling of tooltip but chosen independently.
  // Earlier rows read cleanly through the default.
  `ALTER TABLE layers ADD COLUMN popup TEXT;`,
  // v11 — undo/redo: a per-map timeline of history steps. Each step
  // records the changed fields' before/after images (JSON); the cursor on
  // the map marks the undo position — steps above it are redoable. Every
  // earlier map starts with an empty timeline.
  `CREATE TABLE map_history (
     id TEXT PRIMARY KEY,
     map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     scope TEXT NOT NULL,
     target_id TEXT NOT NULL,
     op TEXT NOT NULL,
     before TEXT,
     after TEXT,
     group_id TEXT,
     created_at TEXT NOT NULL
   );
   CREATE UNIQUE INDEX idx_map_history_seq ON map_history(map_id, seq);
   ALTER TABLE maps ADD COLUMN history_cursor INTEGER NOT NULL DEFAULT 0;`,
  // v12 — time playback: the map's docked timeline (JSON: layerId, field,
  // speed; null = no timeline docked — every earlier map). The window itself
  // stays on the layer as its timerange filter.
  `ALTER TABLE maps ADD COLUMN timeline TEXT;`,
  DATASET_CONNECTION_MIGRATIONS.v13,
  DATASET_CONNECTION_MIGRATIONS.v14,
  // v15 — workspace navigation: workspace preferences as a small key-value
  // store. Single-user until the multi-user phase; the first key is the
  // display name behind the rail avatar.
  `CREATE TABLE workspace_settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  // v16 — widgets & cross-filtering: the map's ordered widget list (JSON
  // array, null = none — every earlier map) and whether widgets ship with the
  // published view (on by default). Selections are session state and are
  // never stored.
  `ALTER TABLE maps ADD COLUMN widgets TEXT;
   ALTER TABLE maps ADD COLUMN widgets_published INTEGER NOT NULL DEFAULT 1;`,
  // v17 — dashboard cards: the map's single note becomes a trailing
  // note widget; corner positioning retires. The note column stays
  // (cleared) so pre-migration undo images still apply — nothing
  // renders it anymore. Missing widget fields normalize on read.
  `UPDATE maps SET
     widgets = json_insert(
       COALESCE(widgets, '[]'), '$[#]',
       json_object(
         'id', id || ':note',
         'type', 'note',
         'layerId', NULL,
         'title', COALESCE(NULLIF(TRIM(json_extract(note, '$.title')), ''), 'Note'),
         'field', NULL,
         'agg', 'count',
         'aggField', NULL,
         'unit', NULL,
         'note', json_extract(note, '$.body'),
         'format', NULL,
         'visible', json('true')
       )
     ),
     note = NULL
   WHERE note IS NOT NULL AND json_extract(note, '$.body') IS NOT NULL;`,
  // v18 — custom palettes: user-saved ramp palettes, instance-global until
  // the multi-user phase. Stops are JSON: an array of { color: "#rrggbb",
  // position: 0–1 } in ascending position order.
  `CREATE TABLE custom_palettes (
     name TEXT PRIMARY KEY,
     label TEXT NOT NULL,
     stops TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  // v19 — 3D camera: the map viewport grows pitch and bearing. Defaults
  // keep every existing map flat and north-up.
  `ALTER TABLE maps ADD COLUMN view_pitch REAL NOT NULL DEFAULT 0;
   ALTER TABLE maps ADD COLUMN view_bearing REAL NOT NULL DEFAULT 0;`,
  // v20 — published-field projection: the author's explicit
  // published-field list (JSON array; null = the derived minimal
  // projection — every earlier row, which is the announced migration).
  `ALTER TABLE layers ADD COLUMN published_fields TEXT;`,
  // v21 — dashboard truth states: stored orphan widgets — data widgets
  // naming a layer the map no longer owns — are swept. They were
  // invisible on every read surface yet held a budget slot and made the
  // whole-list widget write fail. Layer deletion now cascades to its
  // widgets undoably and duplication drops what it cannot resolve, so no
  // new orphans are written.
  `UPDATE maps SET widgets = (
     SELECT json_group_array(json(je.value))
     FROM json_each(maps.widgets) AS je
     WHERE json_extract(je.value, '$.layerId') IS NULL
        OR EXISTS (SELECT 1 FROM layers l
                   WHERE l.id = json_extract(je.value, '$.layerId')
                     AND l.map_id = maps.id)
   )
   WHERE widgets IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM json_each(maps.widgets) AS je
       WHERE json_extract(je.value, '$.layerId') IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM layers l
                         WHERE l.id = json_extract(je.value, '$.layerId')
                           AND l.map_id = maps.id)
     );`,
  // v22 — published-view theme: the authored default, captured at
  // publication and cleared with the token. Null = published (readers
  // get dark) or not currently published.
  `ALTER TABLE maps ADD COLUMN published_theme TEXT;`,
  // v23 — published viewer controls: which optional reader controls the
  // active publication exposes, as a JSON object. Null = every control
  // enabled — which is both the earlier publication's reading and the
  // default for a publication that never states one.
  `ALTER TABLE maps ADD COLUMN viewer_controls TEXT;`,
  // v24 — per-map custom basemap style: a JSON value holding the style
  // URL, its optional display name, and the attribution snapshot
  // captured at save time — the reader's credit when the style cannot be
  // read later. Null = no custom style; the stored basemap key survives
  // a custom save untouched.
  `ALTER TABLE maps ADD COLUMN custom_basemap TEXT;`,
  DATASET_CONNECTION_MIGRATIONS.v25,
  // v26 — the operation run lane's job record. Deliberately NOT the tile
  // record's shape: that is one row per layer, overwritten on every
  // transition, so the previous outcome and its error are destroyed and it
  // cannot answer "when did this last succeed" after a failed re-run. This is
  // one row per run, appended and never overwritten by a later run.
  //
  // `subject_id` is what groups runs into a history. A caller may supply one
  // (steps will supply their step id); a run without one is its own subject,
  // which `subject_kind` records the difference between. No foreign key: an
  // output may be deleted while its run record legitimately survives, and a
  // subject need not be a row in this database at all.
  `CREATE TABLE operation_jobs (
     id TEXT PRIMARY KEY,
     subject_kind TEXT NOT NULL,
     subject_id TEXT NOT NULL,
     operation TEXT NOT NULL,
     parameters TEXT,
     state TEXT NOT NULL,
     error_code TEXT,
     error_message TEXT,
     output_id TEXT,
     output_name TEXT,
     accepted_at TEXT NOT NULL,
     started_at TEXT,
     finished_at TEXT
   );
   CREATE INDEX idx_operation_jobs_subject ON operation_jobs(subject_id, accepted_at);
   CREATE INDEX idx_operation_jobs_state ON operation_jobs(state);
   CREATE INDEX idx_operation_jobs_accepted ON operation_jobs(accepted_at);`,
  // v27 — the recipe object: a named, ordered list of steps, the table-to-table
  // lineage those steps create, and the record of a cascade.
  //
  // Two shapes here are deliberate departures from the rest of this schema,
  // and both come from the same rule: a deletion must never erase the evidence
  // of what it broke.
  //
  //  * Steps cascade from their recipe, because a recipe owns them. **Nothing
  //    cascades from data_tables.** The ids a step and an edge record are
  //    exactly what let a row say "output missing" or "broken", so a foreign
  //    key would delete the explanation along with the table. The same reason
  //    operation_jobs (v26) carries no foreign keys.
  //  * A lineage edge records the *artifact* its run bound, not just the input's
  //    identity. Staleness is then a generation mismatch — the input's artifact
  //    differs from the one this step read — rather than a comparison of
  //    completion times, which cannot tell which generation a concurrent
  //    consumer actually bound. The registry swap that changes an artifact is
  //    itself the durable change record, so no separate staleness mark exists
  //    to be lost.
  `CREATE TABLE recipes (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE recipe_steps (
     id TEXT PRIMARY KEY,
     recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
     ordinal INTEGER NOT NULL,
     operation TEXT NOT NULL,
     parameters TEXT NOT NULL,
     proposed_parameters TEXT,
     output_table_id TEXT,
     output_table_name TEXT,
     origin TEXT,
     last_success_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX idx_recipe_steps_recipe ON recipe_steps(recipe_id, ordinal);
   CREATE INDEX idx_recipe_steps_output ON recipe_steps(output_table_id);
   CREATE TABLE lineage_edges (
     id TEXT PRIMARY KEY,
     step_id TEXT NOT NULL REFERENCES recipe_steps(id) ON DELETE CASCADE,
     output_table_id TEXT NOT NULL,
     input_table_id TEXT NOT NULL,
     input_table_name TEXT NOT NULL,
     bound_artifact TEXT NOT NULL,
     recorded_at TEXT NOT NULL
   );
   CREATE INDEX idx_lineage_by_input ON lineage_edges(input_table_id);
   CREATE INDEX idx_lineage_by_step ON lineage_edges(step_id);
   CREATE TABLE cascade_runs (
     id TEXT PRIMARY KEY,
     recipe_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     outcome TEXT,
     cancelled INTEGER NOT NULL DEFAULT 0,
     started_at TEXT NOT NULL,
     finished_at TEXT
   );
   CREATE TABLE cascade_members (
     cascade_id TEXT NOT NULL REFERENCES cascade_runs(id) ON DELETE CASCADE,
     step_id TEXT NOT NULL,
     ordinal INTEGER NOT NULL,
     state TEXT NOT NULL,
     job_id TEXT,
     stopped_by TEXT,
     PRIMARY KEY (cascade_id, step_id)
   );
   CREATE INDEX idx_cascade_runs_recipe ON cascade_runs(recipe_id, started_at);`,
  // v28 — two records that were being derived from something more perishable
  // than the thing describing them (cross-model).
  //
  //  * A cascade named its outputs by reading its members' jobs. Job history is
  //    capped per subject, so an older cascade quietly lost the outputs it
  //    produced while its own row stayed durable — a durable result that
  //    forgets half of itself. The member now records what it published.
  //  * A step edited from a *different* layer captured the new SQL and kept the
  //    old layer's origin, so after the proposal was promoted the API described
  //    the step as authored from a layer it was not. A proposal now carries its
  //    own origin and is promoted with the definition.
  `ALTER TABLE cascade_members ADD COLUMN output_table_id TEXT;
   ALTER TABLE cascade_members ADD COLUMN output_table_name TEXT;
   ALTER TABLE recipe_steps ADD COLUMN proposed_origin TEXT;`,
  // v29 — a provider run's disclosure belongs to the run (cross-model).
  //
  // The API was reading it from the *output table's* current provenance. A
  // step re-run replaces that output in place, so every older job then
  // reported the newest run's cache and wire counts; deleting the output and
  // reclaiming its name could attach an unrelated run's disclosure, or none.
  // What a run asked is a fact about that run, so it is written on the job's
  // own row, in the transaction that settles it.
  `ALTER TABLE operation_jobs ADD COLUMN disclosure TEXT;`,
  // v30 — a stopped cascade member keeps the sentence, not only the code
  // (harvested from paused at its retirement; named it a transfer).
  //
  // A member refused at admission mints no job, so the member row is the only
  // channel that can carry why it stopped — and it kept just the code.
  // `stopped_by` holds a code, a blocking step id or "cancelled", and none of
  // those can say which table is gone, which is the half a reader can act on.
  `ALTER TABLE cascade_members ADD COLUMN stopped_reason TEXT;`,
  // The manual legend arrangement: a JSON array of layer ids,
  // NULL = automatic (follow the layer panel) — every earlier map.
  `ALTER TABLE maps ADD COLUMN legend_order TEXT;`,
  DATASET_CONNECTION_MIGRATIONS.v32,
  // v33 — which surface made a recipe: "workflow" for the workflows list,
  // "builder" for the one-step Tools' invisible recipes. Every row from
  // before the column is classified as the builder's — the gate's decision:
  // stored data cannot tell them apart, and the builder is the only shipped
  // surface that has made any. The API still lists them by origin, so
  // nothing is lost, only kept off the workflows page.
  `ALTER TABLE recipes ADD COLUMN origin TEXT;
   UPDATE recipes SET origin = 'builder';`,
  // v34 — the canvas layout document: one row per recipe, beside it and
  // never inside it — positions and notes are how a workflow is *shown*,
  // and a run must mean the same whether or not anyone has arranged it.
  // The document is JSON; it goes with its recipe. A recipe without a row
  // reads as the empty document.
  `CREATE TABLE recipe_layouts (
     recipe_id TEXT PRIMARY KEY REFERENCES recipes(id) ON DELETE CASCADE,
     document TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  // v35 — a run reads whole on its own: each member keeps its node's
  // identity from the plan (the operation and the name the node was called
  // by), so a node removed later is still named; and, once its attempt
  // settles, a snapshot of that attempt — state, error, times — so a run
  // still says why a member failed after the node's own history is pruned.
  // The output columns of v28 complete the snapshot. Members recorded
  // before this version take their identity from the steps that still
  // exist and their attempt from the jobs still kept, so an older run
  // reads as whole as the records allow.
  `ALTER TABLE cascade_members ADD COLUMN operation TEXT;
   ALTER TABLE cascade_members ADD COLUMN node_name TEXT;
   ALTER TABLE cascade_members ADD COLUMN attempt_state TEXT;
   ALTER TABLE cascade_members ADD COLUMN attempt_error_code TEXT;
   ALTER TABLE cascade_members ADD COLUMN attempt_error_message TEXT;
   ALTER TABLE cascade_members ADD COLUMN attempt_accepted_at TEXT;
   ALTER TABLE cascade_members ADD COLUMN attempt_started_at TEXT;
   ALTER TABLE cascade_members ADD COLUMN attempt_finished_at TEXT;
   UPDATE cascade_members
   SET operation = (SELECT s.operation FROM recipe_steps s WHERE s.id = cascade_members.step_id),
       node_name = COALESCE(
         output_table_name,
         (SELECT COALESCE(s.output_table_name, json_extract(s.parameters, '$.name')) FROM recipe_steps s WHERE s.id = cascade_members.step_id)
       )
   WHERE operation IS NULL;
   UPDATE cascade_members
   SET attempt_state = (SELECT j.state FROM operation_jobs j WHERE j.id = cascade_members.job_id),
       attempt_error_code = (SELECT j.error_code FROM operation_jobs j WHERE j.id = cascade_members.job_id),
       attempt_error_message = (SELECT j.error_message FROM operation_jobs j WHERE j.id = cascade_members.job_id),
       attempt_accepted_at = (SELECT j.accepted_at FROM operation_jobs j WHERE j.id = cascade_members.job_id),
       attempt_started_at = (SELECT j.started_at FROM operation_jobs j WHERE j.id = cascade_members.job_id),
       attempt_finished_at = (SELECT j.finished_at FROM operation_jobs j WHERE j.id = cascade_members.job_id),
       output_table_id = COALESCE(output_table_id, (SELECT j.output_id FROM operation_jobs j WHERE j.id = cascade_members.job_id)),
       output_table_name = COALESCE(output_table_name, (SELECT j.output_name FROM operation_jobs j WHERE j.id = cascade_members.job_id))
   WHERE job_id IS NOT NULL
     AND attempt_state IS NULL
     AND EXISTS (SELECT 1 FROM operation_jobs j WHERE j.id = cascade_members.job_id AND j.state IN ('succeeded', 'failed', 'cancelled'));`,
  DATASET_CONNECTION_MIGRATIONS.v36,
  // v37 — projects: an optional named set over maps, recipes and data
  // tables. A map or recipe carries at most one project (a nullable
  // reference that survives as NULL when the project dissolves); a table
  // can belong to several through the join, whose rows go with either
  // endpoint — the membership is organizational, never evidence, so the
  // no-cascade doctrine for run records does not apply to it. No
  // backfill: every pre-migration row reads as "Not in a project".
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     note TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE project_datasets (
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     table_id TEXT NOT NULL REFERENCES data_tables(id) ON DELETE CASCADE,
     added_at TEXT NOT NULL,
     PRIMARY KEY (project_id, table_id)
   );
   CREATE INDEX idx_project_datasets_table ON project_datasets(table_id);
   ALTER TABLE maps ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
   ALTER TABLE recipes ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
   CREATE INDEX idx_maps_project ON maps(project_id);
   CREATE INDEX idx_recipes_project ON recipes(project_id);`,
  // v38 — project "workflows" are workflow-origin recipes. The correction changes only memberships:
  // project rows and their timestamps stay byte-for-byte as they were. Fail-closed on the origin: a
  // row whose origin is not the workflows page's leaves its project, so no membership survives that
  // the reads would hide.
  `UPDATE recipes SET project_id = NULL
   WHERE project_id IS NOT NULL AND origin IS NOT 'workflow';`,
  DATASET_CONNECTION_MIGRATIONS.v39,
  // Accounts and credentials are additive. Legacy personal settings are
  // adopted only when the first account is successfully created.
  `CREATE TABLE accounts (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     email TEXT NOT NULL UNIQUE,
     password_hash TEXT,
     is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
     status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'deactivated')),
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     last_sign_in_at TEXT
   );
   CREATE TABLE original_account (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id)
   );
   CREATE TRIGGER original_account_no_update BEFORE UPDATE ON original_account
     BEGIN SELECT RAISE(ABORT, 'The original account cannot change'); END;
   CREATE TRIGGER original_account_no_delete BEFORE DELETE ON original_account
     BEGIN SELECT RAISE(ABORT, 'The original account cannot be removed'); END;
   CREATE TABLE account_preferences (
     account_id TEXT PRIMARY KEY REFERENCES accounts(id),
     view_prefs TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE auth_sessions (
     id TEXT PRIMARY KEY,
     secret_hash TEXT NOT NULL UNIQUE,
     account_id TEXT NOT NULL REFERENCES accounts(id),
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     last_used_at INTEGER NOT NULL,
     revoked_at INTEGER
   );
   CREATE INDEX idx_auth_sessions_account ON auth_sessions(account_id);
   CREATE TABLE auth_tokens (
     id TEXT PRIMARY KEY,
     account_id TEXT NOT NULL REFERENCES accounts(id),
     name TEXT NOT NULL,
     secret_hash TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL,
     last_used_at INTEGER,
     revoked_at INTEGER
   );
   CREATE INDEX idx_auth_tokens_account ON auth_tokens(account_id);
   CREATE TABLE auth_links (
     id TEXT PRIMARY KEY,
     account_id TEXT NOT NULL REFERENCES accounts(id),
     kind TEXT NOT NULL CHECK (kind IN ('invite', 'reset')),
     secret_hash TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     consumed_at INTEGER,
     revoked_at INTEGER
   );
   CREATE INDEX idx_auth_links_account ON auth_links(account_id);`,
  // Durable login budgets coordinate workers and survive process replacement.
  `CREATE TABLE auth_login_limits (
     bucket TEXT PRIMARY KEY,
     window_started_at INTEGER NOT NULL,
     failures INTEGER NOT NULL DEFAULT 0,
     pending INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX idx_auth_login_limits_window ON auth_login_limits(window_started_at);`,
  OWNERSHIP_MIGRATION,
  DATASET_NAMES_MIGRATION,
  CONNECTION_NAMES_MIGRATION,
  // Project sharing: SQL names, project people, SQL homes, the transfer gate,
  // run initiators and per-runner step outputs. Nothing is shared by it.
  SHARING_MIGRATION,
  REVISIONS_MIGRATION,
  IDENTITIES_MIGRATION,
  // A token may carry an expiry, stamped at its creation from the instance's
  // policy. Null never expires: every token made before keeps working until
  // revoked, and a later change of policy moves no token's expiry.
  `ALTER TABLE auth_tokens ADD COLUMN expires_at INTEGER;`,
  // The instance's basemap library: styles an admin added by their address,
  // read once at the add for their credit. One row per address; a map takes
  // a copy, so no map refers to a row and removing one changes no map.
  `CREATE TABLE basemap_styles (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     url TEXT NOT NULL UNIQUE,
     attribution TEXT NOT NULL,
     offered INTEGER NOT NULL DEFAULT 1 CHECK (offered IN (0, 1)),
     position INTEGER NOT NULL,
     created_at TEXT NOT NULL
   );`,
  // Earlier workflow deletions left runs without an owning workflow. Their
  // members cascade away; datasets and independently owned jobs stay intact.
  `DELETE FROM cascade_runs WHERE NOT EXISTS
    (SELECT 1 FROM recipes WHERE recipes.id = cascade_runs.recipe_id);`,
  // Picture work is a child of the map, outside its edit revision and history.
  `CREATE TABLE map_pictures (
    map_id TEXT PRIMARY KEY REFERENCES maps(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('current', 'waiting', 'failed', 'unsupported', 'unavailable')),
    digest TEXT NOT NULL,
    published_digest TEXT,
    requested_generation INTEGER NOT NULL DEFAULT 1,
    published_generation INTEGER NOT NULL DEFAULT 0,
    drawing_changed_at INTEGER NOT NULL,
    requested_at INTEGER NOT NULL,
    producer TEXT NOT NULL DEFAULT 'server' CHECK (producer IN ('server', 'inherited', 'old')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL
  );`,
  // Attempt credentials are neither sessions nor API tokens and die with work.
  `ALTER TABLE map_pictures ADD COLUMN work_key TEXT;
   ALTER TABLE map_pictures ADD COLUMN work_owner TEXT;
   ALTER TABLE map_pictures ADD COLUMN work_expires_at INTEGER;
   CREATE UNIQUE INDEX idx_picture_work_key ON map_pictures(work_key);`,
  `ALTER TABLE map_pictures ADD COLUMN work_inputs TEXT;`,
  `ALTER TABLE map_pictures ADD COLUMN binding_inputs TEXT;`,
  `CREATE TRIGGER revoke_picture_work_on_inactive_owner AFTER UPDATE OF status ON accounts
   WHEN OLD.status = 'active' AND NEW.status <> 'active'
   BEGIN
     UPDATE map_pictures SET work_key = NULL, work_owner = NULL, work_expires_at = NULL,
       work_inputs = NULL, requested_generation = requested_generation + 1,
       state = 'waiting', attempt_count = 0
       WHERE map_id IN (SELECT id FROM maps WHERE owner_id = NEW.id);
   END;`,
  // Finished pictures survive deactivation; only unfinished work is requeued.
  `DROP TRIGGER revoke_picture_work_on_inactive_owner;
   CREATE TRIGGER revoke_picture_work_on_inactive_owner AFTER UPDATE OF status ON accounts
   WHEN OLD.status = 'active' AND NEW.status <> 'active'
   BEGIN
     UPDATE map_pictures SET work_key = NULL, work_owner = NULL, work_expires_at = NULL,
       work_inputs = NULL,
       requested_generation = requested_generation + CASE WHEN state = 'current' THEN 0 ELSE 1 END,
       attempt_count = CASE WHEN state = 'current' THEN attempt_count ELSE 0 END,
       state = CASE WHEN state = 'current' THEN 'current' ELSE 'waiting' END
       WHERE map_id IN (SELECT id FROM maps WHERE owner_id = NEW.id)
         AND (state <> 'current' OR work_key IS NOT NULL);
   END;`,
  // The generation a re-make of an earlier picture was asked at, which the
  // queue orders after all other work.
  `ALTER TABLE map_pictures ADD COLUMN remake_generation INTEGER;`,
];
