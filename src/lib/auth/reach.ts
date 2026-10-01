import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import { resourceAbsent } from "./owned-resource";
import { requireAccountScope, type AccountScope } from "./scope";

/**
 * The reach kernel: what an account can reach, how it stands to it, and
 * which actions that standing permits.
 *
 * A person reaches a map, workflow, dataset or project when they own it, or
 * when it is filed in a project they own or belong to. Layers, widgets and
 * history follow their map; steps and runs follow their workflow. Everything
 * else stays its owner's or its initiator's, as the boundaries below say.
 *
 * Two refusals, and only two: an unreachable identity is refused exactly as a
 * missing one (the absent refusal), and a reachable one whose action the
 * standing does not permit is refused with the permission refusal, one plain
 * sentence with no detail. Admin rights grant nothing here.
 */

/** The authorization boundaries, as data. Every kind belongs to one. */
export const AUTHORIZATION_BOUNDARIES = {
  /** Reached by their owner or through a project the account owns or belongs to. */
  projectReachable: ["map", "layer", "widget", "history", "workflow", "step", "cascade", "dataset", "project"],
  /** Their owner's alone, whatever a project grants. */
  ownerOnly: ["connection", "dataset-mutation", "dataset-refresh"],
  /** Their initiator's alone: work that outlives the request. */
  initiatorPrivate: ["job", "receipt", "render", "prepared-download", "assistant-run"],
} as const;
export type Boundary = keyof typeof AUTHORIZATION_BOUNDARIES;

/**
 * Every module under src/lib/metadata and src/lib/auth that selects rows by
 * their owner, and the boundaries it serves. A test holds this inventory to
 * the source both ways, so no owner query sits outside a boundary.
 */
export const OWNER_QUERY_MODULES: Record<string, readonly Boundary[]> = {
  "src/lib/auth/owned-resource.ts": ["projectReachable", "ownerOnly", "initiatorPrivate"],
  "src/lib/auth/reach.ts": ["projectReachable"],
  "src/lib/metadata/cascades.ts": ["projectReachable", "initiatorPrivate"],
  "src/lib/metadata/connections.ts": ["ownerOnly"],
  "src/lib/metadata/jobs.ts": ["initiatorPrivate"],
  "src/lib/metadata/lineage.ts": ["projectReachable"],
  "src/lib/metadata/map-queries.ts": ["projectReachable"],
  "src/lib/metadata/maps.ts": ["projectReachable"],
  "src/lib/metadata/owned-cascades.ts": ["projectReachable", "initiatorPrivate"],
  "src/lib/metadata/owned-jobs.ts": ["initiatorPrivate"],
  "src/lib/metadata/owned-projects.ts": ["projectReachable"],
  "src/lib/metadata/owned-recipes.ts": ["projectReachable"],
  "src/lib/metadata/owned-tables.ts": ["projectReachable", "ownerOnly"],
  "src/lib/metadata/recipe-outputs.ts": ["projectReachable"],
  "src/lib/metadata/recipes.ts": ["projectReachable"],
  "src/lib/metadata/table-catalogue.ts": ["projectReachable"],
  "src/lib/metadata/tables.ts": ["projectReachable", "ownerOnly"],
};
/** Modules that name owners only to define the schema, never to read rows. */
export const SCHEMA_MODULES: readonly string[] = [
  "src/lib/metadata/migrations-ownership.ts",
  "src/lib/metadata/migrations-sharing.ts",
];

/** The plain sentence of the permission refusal, on every surface. */
export const PERMISSION_REFUSAL = "You can view this but cannot make this change.";

/** Reachable, but the action is not the caller's to take. */
export function permissionRefused(): ApiError {
  return new ApiError("forbidden", PERMISSION_REFUSAL, 403);
}

/** How the acting account stands to a reachable resource, strongest first. */
export type Relation = "owner" | "project-owner" | "editor" | "viewer";
export type ProjectRole = "owner" | "editor" | "viewer" | "none";
export type ReachKind = "map" | "layer" | "history" | "workflow" | "step" | "cascade" | "dataset" | "project";
type Family = "map" | "workflow" | "dataset" | "project";

const FAMILY = {
  map: "map", layer: "map", history: "map",
  workflow: "workflow", step: "workflow", cascade: "workflow",
  dataset: "dataset", project: "project",
} as const satisfies Record<ReachKind, Family>;

/** The row that carries a kind's owner and filing, from the kind's identity. */
const PARENT: Record<ReachKind, string> = {
  map: "SELECT id AS parent FROM maps WHERE id = ?",
  layer: "SELECT map_id AS parent FROM layers WHERE id = ?",
  history: "SELECT map_id AS parent FROM map_history WHERE id = ?",
  workflow: "SELECT id AS parent FROM recipes WHERE id = ?",
  step: "SELECT recipe_id AS parent FROM recipe_steps WHERE id = ?",
  cascade: "SELECT recipe_id AS parent FROM cascade_runs WHERE id = ?",
  dataset: "SELECT id AS parent FROM data_tables WHERE id = ?",
  project: "SELECT id AS parent FROM projects WHERE id = ?",
};

/** Owner, owner status and the caller's strongest relation, per family. A map
 * or workflow is filed in at most one project; a dataset in any number. */
const STANDING: Record<Family, string> = {
  map: `SELECT r.owner_id AS owner, o.status AS owner_status, r.project_id AS project,
      CASE WHEN r.owner_id = @me THEN 'owner' WHEN p.owner_id = @me THEN 'project-owner' ELSE pp.role END AS relation
    FROM maps r JOIN accounts o ON o.id = r.owner_id
    LEFT JOIN projects p ON p.id = r.project_id
    LEFT JOIN project_people pp ON pp.project_id = r.project_id AND pp.account_id = @me
    WHERE r.id = @id`,
  workflow: `SELECT r.owner_id AS owner, o.status AS owner_status, r.project_id AS project,
      CASE WHEN r.owner_id = @me THEN 'owner' WHEN p.owner_id = @me THEN 'project-owner' ELSE pp.role END AS relation
    FROM recipes r JOIN accounts o ON o.id = r.owner_id
    LEFT JOIN projects p ON p.id = r.project_id
    LEFT JOIN project_people pp ON pp.project_id = r.project_id AND pp.account_id = @me
    WHERE r.id = @id`,
  dataset: `SELECT r.owner_id AS owner, o.status AS owner_status, NULL AS project,
      CASE WHEN r.owner_id = @me THEN 'owner'
        WHEN EXISTS (SELECT 1 FROM project_datasets pd JOIN projects p ON p.id = pd.project_id
          WHERE pd.table_id = r.id AND p.owner_id = @me) THEN 'project-owner'
        WHEN EXISTS (SELECT 1 FROM project_datasets pd JOIN project_people pp ON pp.project_id = pd.project_id
          WHERE pd.table_id = r.id AND pp.account_id = @me AND pp.role = 'editor') THEN 'editor'
        WHEN EXISTS (SELECT 1 FROM project_datasets pd JOIN project_people pp ON pp.project_id = pd.project_id
          WHERE pd.table_id = r.id AND pp.account_id = @me) THEN 'viewer' END AS relation
    FROM data_tables r JOIN accounts o ON o.id = r.owner_id
    WHERE r.id = @id`,
  project: `SELECT r.owner_id AS owner, o.status AS owner_status, r.id AS project,
      CASE WHEN r.owner_id = @me THEN 'owner' ELSE pp.role END AS relation
    FROM projects r JOIN accounts o ON o.id = r.owner_id
    LEFT JOIN project_people pp ON pp.project_id = r.id AND pp.account_id = @me
    WHERE r.id = @id`,
};

/** A reachable resource, as the kernel found it. */
export interface Reached {
  kind: ReachKind;
  id: string;
  /** The map, workflow, dataset or project whose owner and filing decide. */
  parentId: string;
  ownerId: string;
  /** The project a map or workflow is filed in, the project itself for a
   * project, null otherwise. */
  projectId: string | null;
  relation: Relation;
  /** The resource's owner is deactivated: its content is read-only for everyone. */
  frozen: boolean;
}

function standing(scope: AccountScope, kind: ReachKind, id: string, db: Database): Reached | null {
  const me = requireAccountScope(scope, db);
  const parent = db.prepare(PARENT[kind]).get(id) as { parent: string } | undefined;
  if (!parent) return null;
  const row = db.prepare(STANDING[FAMILY[kind]]).get({ me, id: parent.parent }) as
    { owner: string; owner_status: string; project: string | null; relation: Relation | null } | undefined;
  if (!row?.relation) return null;
  return {
    kind, id, parentId: parent.parent, ownerId: row.owner, projectId: row.project,
    relation: row.relation, frozen: row.owner_status !== "active",
  };
}

/** Whether the acting account reaches this resource. */
export function canReach(scope: AccountScope, kind: ReachKind, id: string, db: Database = metadataDb()): boolean {
  return standing(scope, kind, id, db) !== null;
}

/** The reachable resource, or the absent refusal. */
export function requireReachable(scope: AccountScope, kind: ReachKind, id: string, db: Database = metadataDb()): Reached {
  const reached = standing(scope, kind, id, db);
  if (!reached) throw resourceAbsent();
  return reached;
}

/** The acting account's role on a project: none when it does not reach it. */
export function projectRole(scope: AccountScope, projectId: string, db: Database = metadataDb()): ProjectRole {
  const reached = standing(scope, "project", projectId, db);
  return reached ? (reached.relation as Exclude<Relation, "project-owner">) : "none";
}

/** Every dataset identity the acting account reaches. */
export function reachableDatasetIds(scope: AccountScope, db: Database = metadataDb()): Set<string> {
  const me = requireAccountScope(scope, db);
  const rows = db.prepare(`SELECT id FROM data_tables WHERE owner_id = @me
    UNION SELECT pd.table_id FROM project_datasets pd JOIN projects p ON p.id = pd.project_id WHERE p.owner_id = @me
    UNION SELECT pd.table_id FROM project_datasets pd JOIN project_people pp ON pp.project_id = pd.project_id
      WHERE pp.account_id = @me`).all({ me }) as { id: string }[];
  return new Set(rows.map(row => row.id));
}

/** Who may take an action, and whether a frozen owner stops it. */
export interface ActionRule {
  by: readonly Relation[];
  /** "refuse": a deactivated owner's resource refuses the action for everyone. */
  frozen: "refuse" | "allow";
}
const CONTENT: readonly Relation[] = ["owner", "project-owner", "editor"];
const ANYONE: readonly Relation[] = ["owner", "project-owner", "editor", "viewer"];
const OWNER: readonly Relation[] = ["owner"];

/**
 * The actions, per family, and who may take them.
 *
 * Maps: content changes (layers, styles, widgets, camera, legend, history and
 * undo, name) are the owner's, the project owner's acting as an editor, and an
 * editor's; publication settings (the token, published fields, the widget
 * publication toggle, the theme, the reader controls), browser captures,
 * sketches drawn on the map, deletion and transfer are the owner's. Workflows: content changes and runs
 * likewise, deletion and transfer the owner's; a run reads a frozen space and
 * stays permitted. Datasets change, refresh and go only by their owner.
 * Projects: rename, note, dissolution, membership and transfer are the
 * owner's.
 */
export const ACTION_RULES = {
  map: {
    edit: { by: CONTENT, frozen: "refuse" },
    publish: { by: OWNER, frozen: "refuse" },
    capture: { by: OWNER, frozen: "refuse" },
    sketch: { by: OWNER, frozen: "refuse" },
    delete: { by: OWNER, frozen: "refuse" },
    transfer: { by: OWNER, frozen: "refuse" },
    duplicate: { by: ANYONE, frozen: "allow" },
  },
  workflow: {
    edit: { by: CONTENT, frozen: "refuse" },
    run: { by: CONTENT, frozen: "allow" },
    delete: { by: OWNER, frozen: "refuse" },
    transfer: { by: OWNER, frozen: "refuse" },
    duplicate: { by: ANYONE, frozen: "allow" },
  },
  dataset: {
    mutate: { by: OWNER, frozen: "refuse" },
    refresh: { by: OWNER, frozen: "refuse" },
    delete: { by: OWNER, frozen: "refuse" },
  },
  project: {
    rename: { by: OWNER, frozen: "refuse" },
    note: { by: OWNER, frozen: "refuse" },
    dissolve: { by: OWNER, frozen: "refuse" },
    membership: { by: OWNER, frozen: "refuse" },
    transfer: { by: OWNER, frozen: "refuse" },
  },
} as const satisfies Record<Family, Record<string, ActionRule>>;

/** The actions a kind's family names. */
export type ActionOf<K extends ReachKind> = keyof (typeof ACTION_RULES)[(typeof FAMILY)[K]];

/** A run's cancellation: its initiator's, whatever their role is now (a
 * viewer included), or its workflow owner's, for anyone who still reaches the
 * run. The initiator is read from the run's own record. */
export function requireCancellable(scope: AccountScope, runId: string, db: Database = metadataDb()): Reached {
  const reached = requireReachable(scope, "cascade", runId, db);
  const run = db.prepare("SELECT initiator_id FROM cascade_runs WHERE id = ?").get(runId) as { initiator_id: string | null };
  if (reached.relation !== "owner" && run.initiator_id !== scope.accountId) throw permissionRefused();
  return reached;
}

/** The reachable resource when its standing permits the action: else the
 * absent refusal for an unreachable one, the permission refusal otherwise. */
export function requirePermitted<K extends ReachKind>(scope: AccountScope, kind: K, id: string,
  action: ActionOf<K>, db: Database = metadataDb()): Reached {
  const reached = requireReachable(scope, kind, id, db);
  const rule = (ACTION_RULES[FAMILY[kind]] as Record<string, ActionRule>)[action as string];
  if (!rule.by.includes(reached.relation)) throw permissionRefused();
  if (reached.frozen && rule.frozen === "refuse") throw permissionRefused();
  return reached;
}
