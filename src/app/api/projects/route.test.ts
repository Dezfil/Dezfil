import { readFilingRevisions } from "@/lib/test-support/edit-basis";
import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap, duplicateMap } from "@/lib/map-service";
import { getTableByName } from "@/lib/metadata/tables";
import { getMap } from "@/lib/metadata/maps";
import {
  mapProjectId,
  projectMemberIds,
} from "@/lib/metadata/projects";
import {
  createRecipe as createRecipeRecord,
  getRecipe,
} from "@/lib/metadata/recipes";
import { GET as listProjectsRoute, POST as createProjectRoute } from "./route";
import {
  DELETE as deleteProjectRoute,
  GET as readProjectRoute,
  PATCH as patchProjectRoute,
} from "./[id]/route";
import {
  GET as readMembersRoute,
  PATCH as patchMembersRoute,
} from "./[id]/members/route";
import { GET as listMapsRoute, POST as createMapRoute } from "../maps/route";
import { GET as readMapRoute } from "../maps/[id]/route";
import { GET as readTableRoute } from "../tables/[name]/route";
import { GET as listTablesRoute } from "../tables/route";
import {
  GET as listRecipesRoute,
  POST as createRecipeRoute,
} from "../recipes/route";

/**
 * The projects surface, driven through its own handlers: what a caller
 * actually reaches, not what the repository would answer.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "stations.csv");
  await writeFile(src, "name,lon,lat\nalex,13.41,52.52\nzoo,13.33,52.51\n");
  await ingestFile(testAccountScope(), src, "stations.csv");
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

type Json = Record<string, unknown>;
const body = async (r: Response) => (await r.json()) as Json;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonReq = (url: string, method: string, payload?: unknown) =>
  new Request(`http://test${url}`, {
    method,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });

async function newProject(name = "Berlin mobility study"): Promise<Json> {
  const response = await createProjectRoute(
    testAccountRequest(jsonReq("/api/projects", "POST", { name })),
  );
  expect(response.status).toBe(201);
  return body(response);
}

function directlyFileBothRecipeOrigins(projectId: string) {
  const workflow = createRecipeRecord(testAccountScope(), "Filed workflow", undefined, "workflow");
  const builder = createRecipeRecord(testAccountScope(), "Filed builder recipe", undefined, "builder");
  metadataDb()
    .prepare(`UPDATE recipes SET project_id = ? WHERE id IN (?, ?)`)
    .run(projectId, workflow.id, builder.id);
  return { workflow, builder };
}

describe("project CRUD over the API", () => {
  it("creates, lists, reads, renames, edits the note, and reports counts", async () => {
    const p = await newProject();
    expect(p.name).toBe("Berlin mobility study");
    expect(p.mapCount).toBe(0);
    expect(p.sizeComplete).toBe(true);

    const map = createMap(testAccountScope(), "Stations map");
    const table = getTableByName("stations")!;
    const patched = await patchMembersRoute(
      testAccountRequest(jsonReq(`/api/projects/${p.id}/members`, "PATCH", { ...{
        addMaps: [map.id],
        addTables: [table.id],
      }, expectedRevisions: readFilingRevisions({
        addMaps: [map.id],
        addTables: [table.id],
      }, undefined) })),
      params(p.id as string),
    );
    expect(patched.status).toBe(200);

    const read = await body(
      await readProjectRoute(testAccountRequest(jsonReq(`/api/projects/${p.id}`, "GET")), params(p.id as string)),
    );
    expect(read.mapCount).toBe(1);
    expect(read.tableCount).toBe(1);
    expect(read.publishedMapCount).toBe(0);
    expect(read.sizeBytes as number).toBeGreaterThan(0);
    expect(read.sizeComplete).toBe(true);

    const renamed = await body(
      await patchProjectRoute(
        testAccountRequest(jsonReq(`/api/projects/${p.id}`, "PATCH", { name: "  Flood atlas  ", note: "First pass" })),
        params(p.id as string),
      ),
    );
    expect(renamed.name).toBe("Flood atlas");
    expect(renamed.note).toBe("First pass");

    const listed = (await (await listProjectsRoute(testAccountRequest(new Request("http://test/api/projects")))).json()) as Json[];
    expect(listed.map((x) => x.id)).toContain(p.id);
  });

  it("creation with initial members is atomic at the route: one unknown member creates nothing", async () => {
    const map = createMap(testAccountScope(), "Stations map");
    const response = await createProjectRoute(
      testAccountRequest(jsonReq("/api/projects", "POST", {
        name: "Doomed",
        members: { ...{ addMaps: [map.id], addTables: ["t-none"] }, expectedRevisions: readFilingRevisions({ addMaps: [map.id], addTables: ["t-none"] }, undefined) },
      })),
    );
    expect(response.status).toBe(404);
    const listed = (await (await listProjectsRoute(testAccountRequest(new Request("http://test/api/projects")))).json()) as Json[];
    expect(listed.length).toBe(0);
    expect(mapProjectId(map.id)).toBeNull();
  });

  it("delete answers the dissolution disclosure and every member survives", async () => {
    const map = createMap(testAccountScope(), "Stations map");
    const p = await newProject();
    await patchMembersRoute(
      testAccountRequest(jsonReq(`/api/projects/${p.id}/members`, "PATCH", { ...{ addMaps: [map.id] }, expectedRevisions: readFilingRevisions({ addMaps: [map.id] }, undefined) })),
      params(p.id as string),
    );
    const deleted = await body(
      await deleteProjectRoute(testAccountRequest(jsonReq(`/api/projects/${p.id}`, "DELETE")), params(p.id as string)),
    );
    expect(deleted).toMatchObject({ deleted: true, contentsRemain: true });
    expect(typeof deleted.message).toBe("string");
    expect(getMap(map.id)).not.toBeNull();
    expect(mapProjectId(map.id)).toBeNull();
    const missing = await readProjectRoute(testAccountRequest(jsonReq(`/api/projects/${p.id}`, "GET")), params(p.id as string));
    expect(missing.status).toBe(404);
  });
});

describe("the members surface", () => {
  it("reads the composite in listing shapes and applies mixed changes atomically", async () => {
    const map = createMap(testAccountScope(), "Stations map");
    const table = getTableByName("stations")!;
    const a = await newProject("A");
    const b = await newProject("B");

    await patchMembersRoute(
      testAccountRequest(jsonReq(`/api/projects/${a.id}/members`, "PATCH", { ...{ addMaps: [map.id], addTables: [table.id] }, expectedRevisions: readFilingRevisions({ addMaps: [map.id], addTables: [table.id] }, undefined) })),
      params(a.id as string),
    );
    // The move: B takes the map; the dataset joins B while staying in A.
    const moved = await body(
      await patchMembersRoute(
        testAccountRequest(jsonReq(`/api/projects/${b.id}/members`, "PATCH", { ...{ addMaps: [map.id], addTables: [table.id] }, expectedRevisions: readFilingRevisions({ addMaps: [map.id], addTables: [table.id] }, undefined) })),
        params(b.id as string),
      ),
    );
    const bMaps = moved.maps as Json[];
    const bTables = moved.tables as Json[];
    expect(bMaps.map((m) => m.id)).toEqual([map.id]);
    expect(bMaps[0].projectId).toBe(b.id);
    expect((bTables[0].projectIds as string[]).slice().sort()).toEqual(
      [a.id, b.id].sort() as string[],
    );

    const aMembers = await body(
      await readMembersRoute(testAccountRequest(jsonReq(`/api/projects/${a.id}/members`, "GET")), params(a.id as string)),
    );
    expect((aMembers.maps as Json[]).length).toBe(0);
    expect((aMembers.tables as Json[]).length).toBe(1);

    // One unknown member changes nothing.
    const refused = await patchMembersRoute(
      testAccountRequest(jsonReq(`/api/projects/${a.id}/members`, "PATCH", { ...{ addMaps: [map.id], addTables: ["t-none"] }, expectedRevisions: readFilingRevisions({ addMaps: [map.id], addTables: ["t-none"] }, undefined) })),
      params(a.id as string),
    );
    expect(refused.status).toBe(404);
    expect(mapProjectId(map.id)).toBe(b.id as string);
  });
});

describe("workflow-origin project membership", () => {
  it("refuses a builder-origin recipe in a compound members change and rolls back the valid workflow addition", async () => {
    const p = await newProject();
    const workflow = createRecipeRecord(testAccountScope(), "Valid workflow", undefined, "workflow");
    const builder = createRecipeRecord(testAccountScope(), "Builder tool", undefined, "builder");

    const refused = await patchMembersRoute(
      testAccountRequest(jsonReq(`/api/projects/${p.id}/members`, "PATCH", { ...{
        addRecipes: [workflow.id, builder.id],
      }, expectedRevisions: readFilingRevisions({
        addRecipes: [workflow.id, builder.id],
      }, undefined) })),
      params(p.id as string),
    );
    expect(refused.status).toBe(400);
    const refusal = (await refused.json()) as {
      error: { code: string; message: string };
    };
    expect(refusal.error.code).toBe("invalid_request");
    expect(refusal.error.message).toContain(
      "Only workflows can be project members.",
    );
    expect(getRecipe(workflow.id)?.projectId).toBeNull();
    expect(getRecipe(builder.id)?.projectId).toBeNull();

    const accepted = await patchMembersRoute(
      testAccountRequest(jsonReq(`/api/projects/${p.id}/members`, "PATCH", { ...{
        addRecipes: [workflow.id],
      }, expectedRevisions: readFilingRevisions({
        addRecipes: [workflow.id],
      }, undefined) })),
      params(p.id as string),
    );
    expect(accepted.status).toBe(200);
    expect(getRecipe(workflow.id)?.projectId).toBe(p.id);
  });

  it("refuses an initial builder-origin member without creating the project, while a workflow-origin member succeeds", async () => {
    const workflow = createRecipeRecord(testAccountScope(), "Valid workflow", undefined, "workflow");
    const builder = createRecipeRecord(testAccountScope(), "Builder tool", undefined, "builder");

    const refused = await createProjectRoute(
      testAccountRequest(jsonReq("/api/projects", "POST", {
        name: "Doomed",
        members: { ...{ addRecipes: [workflow.id, builder.id] }, expectedRevisions: readFilingRevisions({ addRecipes: [workflow.id, builder.id] }, undefined) },
      })),
    );
    expect(refused.status).toBe(400);
    const refusal = (await refused.json()) as {
      error: { code: string; message: string };
    };
    expect(refusal.error.code).toBe("invalid_request");
    expect(refusal.error.message).toContain(
      "Only workflows can be project members.",
    );
    expect((await (await listProjectsRoute(testAccountRequest(new Request("http://test/api/projects")))).json()) as Json[]).toHaveLength(0);
    expect(getRecipe(workflow.id)?.projectId).toBeNull();
    expect(getRecipe(builder.id)?.projectId).toBeNull();

    const accepted = await createProjectRoute(
      testAccountRequest(jsonReq("/api/projects", "POST", {
        name: "Workflow shelf",
        members: { ...{ addRecipes: [workflow.id] }, expectedRevisions: readFilingRevisions({ addRecipes: [workflow.id] }, undefined) },
      })),
    );
    expect(accepted.status).toBe(201);
    expect(getRecipe(workflow.id)?.projectId).not.toBeNull();
  });

  it("counts only the directly filed workflow in the projects listing", async () => {
    const p = await newProject();
    directlyFileBothRecipeOrigins(p.id as string);

    const listed = (await (await listProjectsRoute(testAccountRequest(new Request("http://test/api/projects")))).json()) as Json[];
    expect(listed.find((project) => project.id === p.id)?.recipeCount).toBe(1);
  });

  it("counts only the directly filed workflow in project detail", async () => {
    const p = await newProject();
    directlyFileBothRecipeOrigins(p.id as string);

    const detail = await body(
      await readProjectRoute(
        testAccountRequest(jsonReq(`/api/projects/${p.id}`, "GET")),
        params(p.id as string),
      ),
    );
    expect(detail.recipeCount).toBe(1);
  });

  it("returns only the directly filed workflow from the composite members read", async () => {
    const p = await newProject();
    const { workflow } = directlyFileBothRecipeOrigins(p.id as string);

    const members = await body(
      await readMembersRoute(
        testAccountRequest(jsonReq(`/api/projects/${p.id}/members`, "GET")),
        params(p.id as string),
      ),
    );
    expect((members.recipes as Json[]).map((recipe) => recipe.id)).toEqual([
      workflow.id,
    ]);
  });

  it("returns only the directly filed workflow from the member-ids read", async () => {
    const p = await newProject();
    const { workflow } = directlyFileBothRecipeOrigins(p.id as string);

    expect(projectMemberIds(p.id as string).recipes).toEqual([workflow.id]);
  });
});

describe("creation and duplication contexts", () => {
  it("a map created with a project is a member at birth; unknown projects refuse and create nothing", async () => {
    const p = await newProject();
    const created = await body(
      await createMapRoute(testAccountRequest(jsonReq("/api/maps", "POST", { name: "Filed", projectId: p.id }))),
    );
    expect(created.projectId).toBe(p.id);
    expect(mapProjectId(created.id as string)).toBe(p.id as string);

    const before = ((await (await listMapsRoute(testAccountRequest(jsonReq("/api/maps", "GET")))).json()) as Json[]).length;
    const refused = await createMapRoute(
      testAccountRequest(jsonReq("/api/maps", "POST", { name: "Nowhere", projectId: "p-none" })),
    );
    expect(refused.status).toBe(404);
    const after = ((await (await listMapsRoute(testAccountRequest(jsonReq("/api/maps", "GET")))).json()) as Json[]).length;
    expect(after).toBe(before);
  });

  it("a workflow created with a project is a member at birth", async () => {
    const p = await newProject();
    const response = await createRecipeRoute(
      testAccountRequest(jsonReq("/api/recipes", "POST", { name: "Catchments", projectId: p.id })),
    );
    expect(response.status).toBe(201);
    const recipe = ((await response.json()) as { recipe: Json }).recipe;
    expect(recipe.projectId).toBe(p.id);
  });

  it("a duplicate of a filed map lands in the source's project", async () => {
    const p = await newProject();
    const created = await body(
      await createMapRoute(testAccountRequest(jsonReq("/api/maps", "POST", { name: "Filed", projectId: p.id }))),
    );
    const copy = duplicateMap(testAccountScope(), created.id as string);
    expect(mapProjectId(copy.id)).toBe(p.id as string);
  });
});

describe("scoped listings", () => {
  it("each listing answers exactly the members, the unfiled for none, and everything unscoped, with membership fields", async () => {
    const filed = createMap(testAccountScope(), "Filed");
    const loose = createMap(testAccountScope(), "Loose");
    const table = getTableByName("stations")!;
    const p = await newProject();
    await patchMembersRoute(
      testAccountRequest(jsonReq(`/api/projects/${p.id}/members`, "PATCH", { ...{ addMaps: [filed.id], addTables: [table.id] }, expectedRevisions: readFilingRevisions({ addMaps: [filed.id], addTables: [table.id] }, undefined) })),
      params(p.id as string),
    );

    const scoped = (await (await listMapsRoute(testAccountRequest(jsonReq(`/api/maps?project=${p.id}`, "GET")))).json()) as Json[];
    expect(scoped.map((m) => m.id)).toEqual([filed.id]);
    const unfiled = (await (await listMapsRoute(testAccountRequest(jsonReq("/api/maps?project=none", "GET")))).json()) as Json[];
    expect(unfiled.map((m) => m.id)).toEqual([loose.id]);
    const all = (await (await listMapsRoute(testAccountRequest(jsonReq("/api/maps", "GET")))).json()) as Json[];
    expect(all.length).toBe(2);
    expect(all.every((m) => "projectId" in m)).toBe(true);

    const scopedTables = (await (await listTablesRoute(testAccountRequest(jsonReq(`/api/tables?project=${p.id}`, "GET")))).json()) as Json[];
    expect(scopedTables.map((t) => t.name)).toEqual(["stations"]);
    expect(scopedTables[0].projectIds).toEqual([p.id]);
    const noTables = (await (await listTablesRoute(testAccountRequest(jsonReq("/api/tables?project=none", "GET")))).json()) as Json[];
    expect(noTables.length).toBe(0);

    // Recipes: project composes with origin.
    await createRecipeRoute(testAccountRequest(jsonReq("/api/recipes", "POST", { name: "W", projectId: p.id })));
    const both = (await (
      await listRecipesRoute(testAccountRequest(jsonReq(`/api/recipes?origin=workflow&project=${p.id}`, "GET")))
    ).json()) as { recipes: Json[] };
    expect(both.recipes.length).toBe(1);
    expect(both.recipes[0].projectId).toBe(p.id);
    const otherOrigin = (await (
      await listRecipesRoute(testAccountRequest(jsonReq(`/api/recipes?origin=builder&project=${p.id}`, "GET")))
    ).json()) as { recipes: Json[] };
    expect(otherOrigin.recipes.length).toBe(0);
  });

  it("an unknown project scope answers not found, never an empty list", async () => {
    for (const [route, url] of [
      [listMapsRoute, "/api/maps?project=p-none"],
      [listTablesRoute, "/api/tables?project=p-none"],
      [listRecipesRoute, "/api/recipes?project=p-none"],
    ] as const) {
      const response = await route(testAccountRequest(jsonReq(url, "GET")));
      expect(response.status).toBe(404);
    }
  });
});

describe("project ids on detail reads", () => {
  it("map detail reads carry projectId; table detail reads carry projectIds", async () => {
    const p = await newProject();
    const table = getTableByName("stations")!;
    const created = await body(
      await createMapRoute(testAccountRequest(jsonReq("/api/maps", "POST", { name: "Filed", projectId: p.id }))),
    );
    await patchMembersRoute(
      testAccountRequest(jsonReq(`/api/projects/${p.id}/members`, "PATCH", { addTables: [table.id] })),
      params(p.id as string),
    );
    const detail = await body(
      await readMapRoute(testAccountRequest(jsonReq(`/api/maps/${created.id}`, "GET")), params(created.id as string)),
    );
    expect(detail.projectId).toBe(p.id);
    const inspected = await body(
      await readTableRoute(testAccountRequest(jsonReq("/api/tables/stations", "GET")), {
        params: Promise.resolve({ name: "stations" }),
      }),
    );
    expect(inspected.projectIds).toEqual([p.id]);
  });

  it("an empty projectId refuses; it never silently creates unfiled", async () => {
    const before = ((await (await listMapsRoute(testAccountRequest(jsonReq("/api/maps", "GET")))).json()) as Json[]).length;
    const refused = await createMapRoute(
      testAccountRequest(jsonReq("/api/maps", "POST", { name: "X", projectId: "" })),
    );
    expect(refused.status).toBe(400);
    const after = ((await (await listMapsRoute(testAccountRequest(jsonReq("/api/maps", "GET")))).json()) as Json[]).length;
    expect(after).toBe(before);
  });

  it("a duplicate files where the source is at the write, not where it was", async () => {
    const a = await newProject("A");
    const b = await newProject("B");
    const created = await body(
      await createMapRoute(testAccountRequest(jsonReq("/api/maps", "POST", { name: "Move me", projectId: a.id }))),
    );
    // Move the source, then duplicate: the copy belongs to B.
    await patchMembersRoute(
      testAccountRequest(jsonReq(`/api/projects/${b.id}/members`, "PATCH", { ...{ addMaps: [created.id as string] }, expectedRevisions: readFilingRevisions({ addMaps: [created.id as string] }, undefined) })),
      params(b.id as string),
    );
    const copy = duplicateMap(testAccountScope(), created.id as string);
    expect(mapProjectId(copy.id)).toBe(b.id as string);
  });
});

describe("size honesty", () => {
  it("the total is the exact known sum, and turns explicitly partial when a member's size is unknown", async () => {
    const table = getTableByName("stations")!;
    const p = await newProject();
    await patchMembersRoute(
      testAccountRequest(jsonReq(`/api/projects/${p.id}/members`, "PATCH", { addTables: [table.id] })),
      params(p.id as string),
    );
    const listed = (await (
      await listTablesRoute(testAccountRequest(jsonReq(`/api/tables?project=${p.id}`, "GET")))
    ).json()) as Json[];
    const known = listed[0].sizeBytes as number;
    expect(known).toBeGreaterThan(0);
    const exact = await body(
      await readProjectRoute(testAccountRequest(jsonReq(`/api/projects/${p.id}`, "GET")), params(p.id as string)),
    );
    expect(exact.sizeBytes).toBe(known);
    expect(exact.sizeComplete).toBe(true);

    // Remove the artifact: the size is now unknown, and the total says
    // so instead of pretending.
    await rm(path.join(dir, "data", table.file), { force: true });
    const partial = await body(
      await readProjectRoute(testAccountRequest(jsonReq(`/api/projects/${p.id}`, "GET")), params(p.id as string)),
    );
    expect(partial.sizeComplete).toBe(false);
    expect(partial.sizeBytes).toBe(0);
  });
});
