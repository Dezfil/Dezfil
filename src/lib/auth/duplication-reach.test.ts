import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { listLayers, type MapRecord } from "@/lib/metadata/maps";
import { addStep, createRecipe, listSteps } from "@/lib/metadata/recipes";
import { fileRecipe } from "@/lib/metadata/projects";
import type { DataTable } from "@/lib/metadata/tables";
import { mapSqlRevision } from "@/lib/map-sql-revision";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import type { AccountScope } from "./scope";

/**
 * Duplication under reach. Ada owns project P, where Bob is a viewer and Cyd
 * an editor; Zed belongs to nothing. Ada files `roads` in P and keeps `parks`
 * to herself; Bob owns a `roads` of his own. Ada's map M in P draws `roads`
 * and carries a card image of it; her map N in P draws `parks`; Cyd's map C
 * is filed in P too; Ada's workflow W in P stages `roads` and reads its own
 * staged output.
 *
 * Anyone who reaches a map or workflow may duplicate it. The copy is the
 * duplicator's; a viewer's is unfiled, an editor's or the project owner's is
 * filed in the project. The copy keeps the original's SQL home and its SQL as
 * stored, so a plain name still means the home's dataset, and a workflow copy
 * still reads its own copied output. A card image comes along only when the
 * duplicator may be served it. Zed is refused exactly as for something that
 * never existed, and nothing is created.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let tables: Record<string, DataTable>;
let maps: Record<"M" | "N" | "C", MapRecord>;
let workflow: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "duplication-reach-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance();
  scopes = Object.fromEntries(["ada", "bob", "cyd", "zed"].map((id) => [id, testAccountScope(undefined, id)]));
  tables = {};
  for (const [owner, name] of [["ada", "roads"], ["ada", "parks"], ["bob", "roads"]] as const) {
    const file = path.join(directory, `${owner}-${name}.csv`);
    await writeFile(file, `sentinel,lon,lat\n${owner} ${name},1,2\n`);
    tables[`${owner}.${name}`] = await ingestFile(scopes[owner], file, `${name}.csv`);
  }
  shareProject("ada", "P", [["bob", "viewer"], ["cyd", "editor"]], [tables["ada.roads"].id]);
  maps = {
    M: createMap(scopes.ada, "Roads", "P"),
    N: createMap(scopes.ada, "Parks", "P"),
    C: createMap(scopes.cyd, "Cyd's", "P"),
  };
  await createLayer(scopes.ada, maps.M.id, { name: "Roads", sql: "SELECT * FROM roads" }, { expectedRevision: readEditRevision({ kind: "map", id: maps.M.id })?.editRevision });
  await createLayer(scopes.ada, maps.N.id, { name: "Parks", sql: "SELECT * FROM parks" }, { expectedRevision: readEditRevision({ kind: "map", id: maps.N.id })?.editRevision });
  await createLayer(scopes.cyd, maps.C.id, { name: "Ada's roads", sql: "SELECT * FROM ada.roads" }, { expectedRevision: readEditRevision({ kind: "map", id: maps.C.id })?.editRevision });
  for (const map of [maps.M, maps.N]) {
    const put = await call("ada", route.thumbnail, `/api/maps/${map.id}/thumbnail?revision=${mapSqlRevision(listLayers(map.id))}`,
      { id: map.id }, "PUT", png(map.name));
    expect(put.status).toBe(204);
  }
  const recipe = createRecipe(scopes.ada, "Survey");
  fileRecipe(recipe.id, "P");
  addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT * FROM roads", name: "staged" } });
  addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT * FROM staged", name: "final" } });
  workflow = recipe.id;
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(account: string, load: () => Promise<Record<string, unknown>>, url: string, params: Record<string, string>,
  method = "GET", body?: Uint8Array<ArrayBuffer>) {
  const request = testAccountRequest(new Request(`http://instance.test${url}`, { method,
    ...(body ? { body, headers: { "content-type": "image/png" } } : {}) }), undefined, account);
  const response = await ((await load())[method] as Handler)(request, { params: Promise.resolve(params) });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const json = response.headers.get("content-type")?.includes("json");
  return { status: response.status, bytes, body: (json ? JSON.parse(new TextDecoder().decode(bytes)) : null) as Record<string, unknown> };
}
const route = {
  duplicateMap: () => import("@/app/api/maps/[id]/duplicate/route"),
  duplicateRecipe: () => import("@/app/api/recipes/[id]/duplicate/route"),
  thumbnail: () => import("@/app/api/maps/[id]/thumbnail/route"),
  render: () => import("@/app/api/layers/[id]/render/route"),
};
const png = (tag: string) => new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]));
const duplicateMap = (account: string, id: string) => call(account, route.duplicateMap, `/api/maps/${id}/duplicate`, { id }, "POST");
const duplicateRecipe = (account: string, id: string) => call(account, route.duplicateRecipe, `/api/recipes/${id}/duplicate`, { id }, "POST");
const count = (table: string) => (metadataDb().prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const ADA = { name: "ada", sqlName: "ada" };

describe("duplicating a map under reach", () => {
  it.each([
    ["bob", null],
    ["cyd", "P"],
    ["ada", "P"],
  ] as const)("gives %s a copy of their own, filed in %s, in the original's home with its SQL as stored", async (account, projectId) => {
    const copy = await duplicateMap(account, maps.M.id);
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ name: "Roads copy", owner: { name: account, sqlName: account }, home: "ada", projectId,
      publishToken: null, layers: [expect.objectContaining({ sql: "SELECT * FROM roads" })] });
    // The copy draws the home's `roads`, never the duplicator's own.
    const layer = (copy.body.layers as { id: string }[])[0];
    const render = await call(account, route.render, `/api/layers/${layer.id}/render`, { id: layer.id });
    expect((render.body.geojson as { features: { properties: { sentinel: string } }[] }).features.map((f) => f.properties.sentinel))
      .toEqual(["ada roads"]);
    // The image drew `roads`, which every one of them reaches: it comes along.
    const image = await call(account, route.thumbnail, `/api/maps/${copy.body.id}/thumbnail`, { id: copy.body.id as string });
    expect(image.status).toBe(200);
    expect(Buffer.from(image.bytes).toString("latin1")).toContain("Roads");
  });

  it("files the project owner's copy of someone else's map in the project, in that map's home", async () => {
    const copy = await duplicateMap("ada", maps.C.id);
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ owner: ADA, home: "cyd", projectId: "P", layers: [expect.objectContaining({ sql: "SELECT * FROM ada.roads" })] });
  });

  it("starts a copy without the image when the duplicator may not be served what it drew", async () => {
    const copy = await duplicateMap("bob", maps.N.id);
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ owner: { name: "bob", sqlName: "bob" }, home: "ada", projectId: null });
    const image = await call("bob", route.thumbnail, `/api/maps/${copy.body.id}/thumbnail`, { id: copy.body.id as string });
    expect(image.body).toEqual({ error: { code: "not_found", message: "This map has no snapshot yet." } });
  });

  it("refuses a non-member exactly as a map that never existed, creating nothing", async () => {
    const before = [count("maps"), count("layers")];
    const hidden = await duplicateMap("zed", maps.M.id);
    const missing = await duplicateMap("zed", "never-existed");
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
    expect([count("maps"), count("layers")]).toEqual(before);
  });
});

describe("duplicating a workflow under reach", () => {
  it.each([
    ["bob", null],
    ["cyd", "P"],
    ["ada", "P"],
  ] as const)("gives %s a copy of their own, filed in %s, reading its own copied output in the original's home", async (account, projectId) => {
    const copy = await duplicateRecipe(account, workflow);
    expect(copy.status).toBe(201);
    const recipe = copy.body.recipe as { id: string };
    expect(recipe).toMatchObject({ name: "Survey copy", owner: { name: account, sqlName: account }, home: "ada", projectId });
    const steps = listSteps(recipe.id).map((step) => step.parameters as { sql: string; name: string });
    expect(steps[0]).toEqual({ sql: "SELECT * FROM roads", name: "staged_copy" });
    expect(steps[1].sql).toBe("SELECT * FROM staged_copy");
  });

  it("refuses a non-member exactly as a workflow that never existed, creating nothing", async () => {
    const before = [count("recipes"), count("recipe_steps")];
    const hidden = await duplicateRecipe("zed", workflow);
    const missing = await duplicateRecipe("zed", "never-existed");
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
    expect([count("recipes"), count("recipe_steps")]).toEqual(before);
  });
});
