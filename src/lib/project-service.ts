import { ApiError } from "@/lib/api/errors";
import {
  listProjects,
  projectMemberCounts,
  requireProject,
  type MemberChange,
  type ProjectRecord,
} from "@/lib/metadata/projects";
import { listRecipes } from "@/lib/metadata/recipes";
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
  const change: MemberChange = {};
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

export async function projectsOverview(): Promise<ProjectOverview[]> {
  const counts = projectMemberCounts();
  const tables = await listTablesWithSize();
  const sizes = new Map<string, { sum: number; complete: boolean }>();
  for (const t of tables) {
    for (const p of t.projectIds) {
      const entry = sizes.get(p) ?? { sum: 0, complete: true };
      if (t.sizeBytes === null) entry.complete = false;
      else entry.sum += t.sizeBytes;
      sizes.set(p, entry);
    }
  }
  return listProjects().map((p) => ({
    ...p,
    mapCount: counts.get(p.id)?.maps ?? 0,
    publishedMapCount: counts.get(p.id)?.publishedMaps ?? 0,
    recipeCount: counts.get(p.id)?.recipes ?? 0,
    tableCount: counts.get(p.id)?.tables ?? 0,
    sizeBytes: sizes.get(p.id)?.sum ?? 0,
    sizeComplete: sizes.get(p.id)?.complete ?? true,
  }));
}

export async function projectOverview(id: string): Promise<ProjectOverview> {
  requireProject(id);
  const overview = (await projectsOverview()).find((p) => p.id === id);
  // The project exists (checked above); a race with a concurrent delete
  // answers not-found through the same door.
  if (!overview) requireProject(id);
  return overview as ProjectOverview;
}

export interface ProjectMembers {
  maps: MapOverview[];
  recipes: ReturnType<typeof recipePayload>[];
  tables: TableListing[];
}

/** The composite members read: each kind in its
 * ordinary listing shape and order. */
export async function projectMembers(id: string): Promise<ProjectMembers> {
  requireProject(id);
  const recipes = await Promise.all(
    listRecipes(undefined, { origin: "workflow", project: id }).map(async (r) =>
      recipePayload(await readRecipe(r.id)),
    ),
  );
  return {
    maps: mapsOverview(id),
    recipes,
    tables: await listTablesWithSize(id),
  };
}
