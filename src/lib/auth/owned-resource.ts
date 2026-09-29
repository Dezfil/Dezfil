import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import { requireAccountScope, type AccountScope } from "./scope";

const relations = {
  map: "maps r",
  dataset: "data_tables r",
  workflow: "recipes r",
  connection: "pg_connections r",
  project: "projects r",
  job: "operation_jobs r",
  layer: "layers r JOIN maps p ON p.id = r.map_id",
  step: "recipe_steps r JOIN recipes p ON p.id = r.recipe_id",
  history: "map_history r JOIN maps p ON p.id = r.map_id",
  cascade: "cascade_runs r JOIN recipes p ON p.id = r.recipe_id",
} as const;
export type OwnedResourceKind = keyof typeof relations;

/** The same failure for hidden and nonexistent identities on every transport. */
export function resourceAbsent(): ApiError {
  return new ApiError("not_found", ERROR_CATALOGUE.not_found, 404);
}

/** Resolve authority before a service reads content, artifacts or secrets. */
export function requireOwnedResource(scope: AccountScope, kind: OwnedResourceKind, id: string,
  db: Database = metadataDb()): string {
  const accountId = requireAccountScope(scope, db);
  const owner = ["layer", "step", "history", "cascade"].includes(kind) ? "p" : "r";
  const row = db.prepare(`SELECT r.id FROM ${relations[kind]} WHERE r.id = ? AND ${owner}.owner_id = ?`)
    .get(id, accountId) as { id: string } | undefined;
  if (!row) throw resourceAbsent();
  return row.id;
}
