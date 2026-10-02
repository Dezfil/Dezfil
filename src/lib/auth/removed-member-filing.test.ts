import { readFilingRevisions } from "@/lib/test-support/edit-basis";
import { documentFacts } from "@/lib/metadata/document-facts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import type { DataTable } from "@/lib/metadata/tables";
import { createMap } from "@/lib/map-service";
import { createRecipe } from "@/lib/metadata/recipes";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";

/**
 * A person removed from a project keeps their own work filed there, and it
 * stays theirs to take out. Bo owns project B, where Ada is an editor and Cy
 * a viewer; Ada owns project Q, where Dee is a viewer. Ada files her dataset
 * `customers`, her map and her workflow into B, and `customers` into Q too.
 * Bo removes Ada. Her own reads and lists still report the membership in B
 * by its identity, so the work never reads as in no project, while B stays
 * absent to her; nobody else learns of a project they do not reach. She
 * withdraws it by that identity, and Cy's reach through B ends.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let customers: DataTable;
let mapId: string;
let workflowId: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "removed-member-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance();
  const scopes = Object.fromEntries(["bo", "ada", "cy", "dee"].map((id) => [id, testAccountScope(undefined, id)]));
  const file = path.join(directory, "customers.csv");
  await writeFile(file, "who,lon,lat\nsomeone,1,2\n");
  customers = await ingestFile(scopes.ada, file, "customers.csv");
  mapId = createMap(scopes.ada, "Customer map").id;
  workflowId = createRecipe(scopes.ada, "Customer flow").id;
  shareProject("bo", "B", [["ada", "editor"], ["cy", "viewer"]]);
  shareProject("ada", "Q", [["dee", "viewer"]]);
  expect((await call("ada", route.members, "/api/projects/B/members", "PATCH", { id: "B" },
    { ...{ addTables: [customers.id], addMaps: [mapId], addRecipes: [workflowId] }, expectedRevisions: readFilingRevisions({ addTables: [customers.id], addMaps: [mapId], addRecipes: [workflowId] }, undefined) })).status).toBe(200);
  expect((await call("ada", route.members, "/api/projects/Q/members", "PATCH", { id: "Q" }, { addTables: [customers.id] })).status).toBe(200);
  expect((await call("cy", route.table, "/api/tables/ada.customers", "GET", { name: "ada.customers" })).status).toBe(200);
  expect((await call("bo", route.person, "/api/projects/B/people/ada", "DELETE", { id: "B", sqlName: "ada" })).status).toBe(200);
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(account: string, load: () => Promise<Record<string, unknown>>, url: string, method = "GET", params: Record<string, string> = {}, body?: unknown) {
  const request = testAccountRequest(new Request(`http://instance.test${url}`, { method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), undefined, account);
  const response = await ((await load())[method] as Handler)(request, { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as unknown : null };
}
const route = {
  tables: () => import("@/app/api/tables/route"),
  table: () => import("@/app/api/tables/[name]/route"),
  catalogue: () => import("@/app/api/catalogue/tables/route"),
  maps: () => import("@/app/api/maps/route"),
  map: () => import("@/app/api/maps/[id]/route"),
  recipes: () => import("@/app/api/recipes/route"),
  recipe: () => import("@/app/api/recipes/[id]/route"),
  projects: () => import("@/app/api/projects/route"),
  project: () => import("@/app/api/projects/[id]/route"),
  members: () => import("@/app/api/projects/[id]/members/route"),
  person: () => import("@/app/api/projects/[id]/people/[sqlName]/route"),
};
type Row = { id: string; projectId?: string | null; projectIds?: string[] };
const rows = async (account: string, load: () => Promise<Record<string, unknown>>, url: string) => {
  const body = (await call(account, load, url)).body as Row[] | { recipes: Row[] } | { tables: Row[] };
  return Array.isArray(body) ? body : "recipes" in body ? body.recipes : body.tables;
};
const find = (list: Row[], id: string) => list.find((row) => row.id === id);

describe("a removed member's own work filed in the project", () => {
  it("reports the membership on her own reads and lists, never as in no project, while the project stays absent to her", async () => {
    expect(find(await rows("ada", route.tables, "/api/tables"), customers.id)?.projectIds).toEqual(["B", "Q"]);
    expect(((await call("ada", route.table, "/api/tables/customers", "GET", { name: "customers" })).body as Row).projectIds).toEqual(["B", "Q"]);
    expect(find(await rows("ada", route.catalogue, "/api/catalogue/tables?columns=0"), customers.id)?.projectIds).toEqual(["B", "Q"]);
    expect(find(await rows("ada", route.maps, "/api/maps"), mapId)?.projectId).toBe("B");
    expect(((await call("ada", route.map, `/api/maps/${mapId}`, "GET", { id: mapId })).body as Row).projectId).toBe("B");
    expect(find(await rows("ada", route.recipes, "/api/recipes?origin=workflow"), workflowId)?.projectId).toBe("B");
    expect((((await call("ada", route.recipe, `/api/recipes/${workflowId}`, "GET", { id: workflowId })).body as { recipe: Row }).recipe).projectId).toBe("B");
    for (const [load, url] of [[route.tables, "/api/tables?project=none"], [route.catalogue, "/api/catalogue/tables?columns=0&project=none"],
      [route.maps, "/api/maps?project=none"], [route.recipes, "/api/recipes?origin=workflow&project=none"]] as const) {
      expect((await rows("ada", load, url)).map((row) => row.id), url).toEqual([]);
    }
    expect(((await call("ada", route.projects, "/api/projects")).body as Row[]).map((p) => p.id)).toEqual(["Q"]);
    const absent = await call("ada", route.project, "/api/projects/B", "GET", { id: "B" });
    expect(absent).toEqual(await call("ada", route.project, "/api/projects/never", "GET", { id: "never" }));
    expect(absent.status).toBe(404);
  });

  it("names to nobody else a project they do not reach", async () => {
    expect(find(await rows("dee", route.tables, "/api/tables"), customers.id)?.projectIds).toEqual(["Q"]);
    expect(find(await rows("dee", route.catalogue, "/api/catalogue/tables?columns=0"), customers.id)?.projectIds).toEqual(["Q"]);
    expect(((await call("dee", route.table, "/api/tables/ada.customers", "GET", { name: "ada.customers" })).body as Row).projectIds).toEqual(["Q"]);
    expect(find(await rows("cy", route.tables, "/api/tables"), customers.id)?.projectIds).toEqual(["B"]);
  });

  it("is withdrawn by the identity her reads report, which ends the reach it gave others", async () => {
    const answer = await call("ada", route.members, "/api/projects/B/members", "PATCH", { id: "B" },
      { ...{ removeTables: [customers.id], removeMaps: [mapId], removeRecipes: [workflowId] }, expectedRevisions: readFilingRevisions({ removeTables: [customers.id], removeMaps: [mapId], removeRecipes: [workflowId] }, undefined) });
    expect(answer).toEqual({ status: 200, body: { maps: [], recipes: [], tables: [], revisions: [{ kind: "map" as const, id: mapId }, { kind: "workflow" as const, id: workflowId }].map(doc => ({ ...doc, editRevision: documentFacts(doc).editRevision })) } });
    expect(find(await rows("ada", route.tables, "/api/tables"), customers.id)?.projectIds).toEqual(["Q"]);
    expect(find(await rows("ada", route.maps, "/api/maps?project=none"), mapId)?.projectId).toBeNull();
    expect(find(await rows("ada", route.recipes, "/api/recipes?origin=workflow&project=none"), workflowId)?.projectId).toBeNull();
    for (const [load, url, params] of [[route.table, "/api/tables/ada.customers", { name: "ada.customers" }],
      [route.map, `/api/maps/${mapId}`, { id: mapId }], [route.recipe, `/api/recipes/${workflowId}`, { id: workflowId }]] as const) {
      const gone = await call("cy", load, url, "GET", params);
      expect(gone.status, url).toBe(404);
    }
    expect(find(await rows("cy", route.tables, "/api/tables"), customers.id)).toBeUndefined();
  });
});
