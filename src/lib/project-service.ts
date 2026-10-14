import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { ApiError } from "@/lib/api/errors";
import {
  listProjects,
  projectMemberCounts,
  requireProject,
  type MemberChange,
  type ProjectRecord,
} from "@/lib/metadata/owned-projects";
import { listRecipes } from "@/lib/metadata/owned-recipes";
import { mapsOverview, type MapOverview } from "@/lib/map-service";
import { listTablesWithSize, type TableListing } from "@/lib/table-service";
import { readRecipe } from "@/lib/operations/recipe-view";
import { recipePayload } from "@/lib/operations/recipe-api";

/**
 * The projects service: composes what the rows cannot state alone —
 * member counts, the published count, and the size total with its honesty
 * marker. Projects organize; nothing here reaches the SQL catalog or the
 * published surfaces.
 */

/** The six member-change groups off the wire, each an array of ids. */
export function memberChange(raw: unknown): MemberChange {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("invalid_request", '"members" must be an object.', 400);
  }
  const body = raw as Record<string, unknown>;
  const keys = [
    "addMaps",
    "removeMaps",
    "addRecipes",
    "removeRecipes",
    "addTables",
    "removeTables",
  ] as const;
  const change: MemberChange = { ...(body.expectedRevisions === undefined ? {} : { expectedRevisions: body.expectedRevisions }) };
  for (const key of keys) {
    const value = body[key];
    if (value === undefined) continue;
    if (
      !Array.isArray(value) ||
      value.some((v) => typeof v !== "string" || v === "")
    ) {
      throw new ApiError(
        "invalid_request",
        `"${key}" must be an array of ids.`,
        400,
      );
    }
    change[key] = value as string[];
  }
  return change;
}

export interface ProjectOverview extends ProjectRecord {
  /** The project's owner. */
  owner: { name: string; sqlName: string };
  /** How the caller stands to it: its owner, or one of its people. */
  role: "owner" | "editor" | "viewer";
  mapCount: number;
  publishedMapCount: number;
  recipeCount: number;
  tableCount: number;
  /** The sum of the member datasets' known artifact sizes. */
  sizeBytes: number;
  /** False when a member dataset's size is unknown — the sum is partial
   * and says so rather than pretending. */
  sizeComplete: boolean;
}

/** The projects the caller reaches, their own and the ones shared with them,
 * each with its owner, the caller's role and what it holds, whoever owns
 * that: everything filed in a reached project is within reach, and nothing
 * the caller cannot reach is counted. */
export async function projectsOverview(scope: AccountScope): Promise<ProjectOverview[]> {
  const counts = projectMemberCounts(scope);
  const tables = await listTablesWithSize(scope);
  const sizes = new Map<string, { sum: number; complete: boolean }>();
  for (const t of tables) {
    for (const p of t.projectIds) {
      const entry = sizes.get(p) ?? { sum: 0, complete: true };
      if (t.sizeBytes === null) entry.complete = false;
      else entry.sum += t.sizeBytes;
      sizes.set(p, entry);
    }
  }
  requireAccountScope(scope);
  return listProjects(scope).map((p) => ({
    ...p,
    mapCount: counts.get(p.id)?.maps ?? 0,
    publishedMapCount: counts.get(p.id)?.publishedMaps ?? 0,
    recipeCount: counts.get(p.id)?.recipes ?? 0,
    tableCount: counts.get(p.id)?.tables ?? 0,
    sizeBytes: sizes.get(p.id)?.sum ?? 0,
    sizeComplete: sizes.get(p.id)?.complete ?? true,
  }));
}

export async function projectOverview(scope: AccountScope, id: string): Promise<ProjectOverview> {
  requireProject(scope, id);
  const overview = (await projectsOverview(scope)).find((p) => p.id === id);
  // The project exists (checked above); a race with a concurrent delete
  // answers not-found through the same door.
  if (!overview) requireProject(scope, id);
  return overview as ProjectOverview;
}

export interface ProjectMembers {
  maps: MapOverview[];
  recipes: ReturnType<typeof recipePayload>[];
  tables: TableListing[];
}

/** The composite members read: each kind in its
 * ordinary listing shape and order. */
export async function projectMembers(scope: AccountScope, id: string): Promise<ProjectMembers> {
  requireProject(scope, id);
  const recipes = await Promise.all(
    listRecipes(scope, undefined, { origin: "workflow", project: id }).map(async (r) =>
      recipePayload(await readRecipe(scope, r.id)),
    ),
  );
  const tables = await listTablesWithSize(scope, id);
  requireProject(scope, id);
  return { maps: await mapsOverview(scope, id), recipes, tables };
}
