import { documentFacts } from "@/lib/metadata/document-facts";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { createApiToken } from "./credentials";
import { requireRequestAuth } from "./http";
import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import type { AccountScope } from "./scope";
import { insertTable, type DataTable } from "@/lib/metadata/tables";
import { createMap } from "@/lib/map-service";
import { insertLayer } from "@/lib/metadata/maps";
import { normalizeStyle } from "@/lib/style/style";
import { createRecipe, addStep, recordOutput } from "@/lib/metadata/recipes";
import { replaceEdges, edgesForStep, edgesForInput, clearEdges } from "@/lib/metadata/lineage";
import { currentProducers, mapDependencies } from "@/lib/map-dependencies";
import { workflowDependencies } from "@/lib/recipe-dependencies";
import { tileFingerprint, resetTileBuilds } from "@/lib/tiles/build";
import { invalidateTilesForTable } from "@/lib/ingest/refresh";
import { getTileRecord, upsertTileRecord } from "@/lib/metadata/tiles";
import { removeTable } from "@/lib/table-service";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { datasetInputs, seedTileEvidence } from "@/lib/test-support/tile-evidence";

let db: Database;
const accounts = ["alice", "bob", "admin"];
let scopes: Record<string, AccountScope>, maps: Record<string, string>, steps: Record<string, string>, recipes: Record<string, string>;
const parse = vi.hoisted(() => ({ after: undefined as undefined | (() => void), calls: 0 }));
vi.mock("@/lib/query/bounded", () => ({ boundedEvaluation: async (callback: (conn: unknown) => unknown) => callback({}) }));
vi.mock("@/lib/operations/inputs", () => ({ queryInputsStrict: async () => { parse.calls++; parse.after?.(); return { tables: ["roads"] }; } }));
function table(account: string): DataTable {
  return { id: `${account}-table`, name: "roads", sourceFilename: "roads.csv", file: `tables/${account}.parquet`, format: "csv",
    geometryColumn: null, geometryType: null, crsAssumed: false, headerSuspect: false, rowCount: 1, source: "upload", sourceParams: null, createdAt: "time", importedAt: "time" };
}
function lineage(scope: AccountScope, id: string) { return edgesForStep(scope, id, db); }
function readers(scope: AccountScope, id: string) { return edgesForInput(scope, id, db); }
function clear(scope: AccountScope, id: string) { return clearEdges(scope, id, db); }
/** Each account's layer reads its own `roads`: the identity its evaluation recorded. */
function fingerprint(account: string) { return tileFingerprint("SELECT * FROM roads", [], "", datasetInputs([table(account).id], false, db)); }
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "dependency-ownership-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  scopes = {}; maps = {}; steps = {}; recipes = {}; parse.after = undefined; parse.calls = 0;
  for (const account of accounts) {
    const scope = scopes[account] = testAccountScope(db, account);
    insertTable(scope, table(account), db);
    maps[account] = createMap(scope, account).id;
    insertLayer({ id: `${account}-layer`, mapId: maps[account], name: "roads", sql: "SELECT * FROM roads", style: normalizeStyle({}), visible: true,
      tooltip: null, popup: null, publishedFields: null, inLegend: true, viz: { type: "points" }, filters: [], legendTitle: null, legendLabels: null, legendAttrs: null, ordinal: 0, createdAt: "time", updatedAt: "time" }, db);
    recipes[account] = createRecipe(scope, account, db).id;
    steps[account] = addStep(recipes[account], { operation: "sql_step", parameters: { sql: "SELECT * FROM roads", name: "output" } }, db).id;
    recordOutput(steps[account], { id: table(account).id, name: "roads" }, "time", db);
    replaceEdges(scope, steps[account], table(account).id, [{ inputTableId: table(account).id, inputTableName: "roads", boundArtifact: table(account).file }], db);
    upsertTileRecord({ layerId: `${account}-layer`, state: "ready", fingerprint: "seed", error: null, featureCount: 1, builtAt: "time" }, db);
    seedTileEvidence(`${account}-layer`, "seed", "time", { catalogue: false, datasets: [{ id: table(account).id, file: table(account).file }] });
  }
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
});
afterEach(() => { resetTileBuilds(); vi.restoreAllMocks(); db.close(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
it("selects producers within each owner before decoding private workflow content", () => {
  for (const account of accounts) expect([...currentProducers(scopes[account]).keys()]).toEqual([table(account).id]);
  db.prepare("UPDATE recipe_steps SET parameters = 'private-invalid-json' WHERE id = ?").run(steps.bob);
  expect([...currentProducers(scopes.alice).keys()]).toEqual([table("alice").id]);
});
it("does not expose a foreign workflow claiming an owned dataset as its output", async () => {
  // Bob's workflow, out of Alice's reach, claims her dataset as its output,
  // in the legacy column and as his run's recorded output.
  db.prepare("UPDATE recipe_steps SET output_table_id = ? WHERE id = ?").run(table("alice").id, steps.bob);
  db.prepare("UPDATE step_runner_outputs SET output_table_id = ? WHERE step_id = ?").run(table("alice").id, steps.bob);
  db.prepare("UPDATE recipe_steps SET output_table_id = NULL WHERE id = ?").run(steps.alice);
  const own = { id: recipes.alice, name: "alice", owned: true, ...documentFacts({ kind: "workflow", id: recipes.alice }, db) };
  expect((await mapDependencies(scopes.alice, maps.alice))[0].producer).toEqual(own);
  expect((await workflowDependencies(scopes.alice, recipes.alice))[0].producer).toEqual(own);
  db.prepare("DELETE FROM step_runner_outputs WHERE step_id = ?").run(steps.alice);
  expect((await mapDependencies(scopes.alice, maps.alice))[0].producer).toBeNull();
});
it.each(accounts)("keeps %s's fingerprint stable through another owner's refresh, delete and name reuse", account => {
  const before = fingerprint(account), other = accounts.find(a => a !== account)!;
  db.prepare("UPDATE data_tables SET file = 'tables/refreshed.parquet' WHERE owner_id = ?").run(other);
  expect(fingerprint(account)).toBe(before);
  db.prepare("DELETE FROM data_tables WHERE owner_id = ?").run(other);
  expect(fingerprint(account)).toBe(before);
  insertTable(scopes[other], { ...table(other), id: `${other}-replacement`, file: "tables/replacement.parquet" }, db);
  expect(fingerprint(account)).toBe(before);
  db.prepare("UPDATE data_tables SET file = 'tables/own-refresh.parquet' WHERE owner_id = ?").run(account);
  expect(fingerprint(account)).not.toBe(before);
});
it("retains durable dataset identity in a fingerprint even when a name and path are reused", () => {
  const before = fingerprint("alice");
  db.prepare("DELETE FROM data_tables WHERE owner_id = 'alice'").run();
  insertTable(scopes.alice, { ...table("alice"), id: "new-identity" }, db);
  expect(fingerprint("alice")).not.toBe(before);
});
it("refuses hidden lineage and clearing like absence for ordinary accounts and admin", () => {
  const before = db.prepare("SELECT * FROM lineage_edges ORDER BY id").all();
  for (const account of accounts) for (const id of [steps[accounts.find(a => a !== account)!], "missing"]) {
    expect(() => lineage(scopes[account], id)).toThrow(expect.objectContaining({ status: 404, code: "not_found" }));
    expect(() => clear(scopes[account], id)).toThrow(expect.objectContaining({ status: 404, code: "not_found" }));
  }
  expect(db.prepare("SELECT * FROM lineage_edges ORDER BY id").all()).toEqual(before);
});
it("filters reverse lineage by its parent owner, including deleted input identities", () => {
  db.prepare("UPDATE lineage_edges SET input_table_id = ? WHERE step_id = ?").run(table("alice").id, steps.bob);
  expect(readers(scopes.alice, table("alice").id).map(e => e.stepId)).toEqual([steps.alice]);
  db.prepare("DELETE FROM data_tables WHERE owner_id = 'alice'").run();
  insertTable(scopes.alice, { ...table("alice"), id: "reclaimed" }, db);
  expect(lineage(scopes.alice, steps.alice)[0]).toMatchObject({ inputTableId: "alice-table", boundArtifact: "tables/alice.parquet" });
  expect(readers(scopes.alice, "alice-table").map(e => e.stepId)).toEqual([steps.alice]);
  expect(readers(scopes.alice, "reclaimed")).toEqual([]);
});
it.each(["deactivate", "delete"])("rechecks map access after asynchronous dependency analysis: %s", async action => {
  parse.after = () => action === "deactivate" ? db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run() : db.prepare("DELETE FROM maps WHERE id = ?").run(maps.alice);
  await expect(mapDependencies(scopes.alice, maps.alice)).rejects.toMatchObject({ status: action === "deactivate" ? 401 : 404 });
});
it("invalidates and reclaims only the mutating owner's derived archives", async () => {
  expect(invalidateTilesForTable(scopes.alice, "roads")).toBe(1);
  expect(getTileRecord("alice-layer")).toBeNull();
  expect(getTileRecord("bob-layer")?.fingerprint).toBe("seed");
  await removeTable(scopes.alice, "roads");
  expect(getTileRecord("bob-layer")?.fingerprint).toBe("seed");
  expect(getTileRecord("admin-layer")?.fingerprint).toBe("seed");
});
it("refuses mixed lineage writes before replacing any owned edges", () => {
  const before = db.prepare("SELECT * FROM lineage_edges ORDER BY id").all();
  for (const account of accounts) {
    const other = accounts.find(a => a !== account)!;
    const edge = (who: string) => ({ inputTableId: table(who).id, inputTableName: "roads", boundArtifact: table(who).file });
    for (const [output, inputs] of [[table(account).id, [edge(account), edge(other)]], [table(other).id, [edge(account)]]] as const) {
      expect(() => replaceEdges(scopes[account], steps[account], output, [...inputs], db)).toThrow(expect.objectContaining({ status: 404 }));
    }
  }
  expect(db.prepare("SELECT * FROM lineage_edges ORDER BY id").all()).toEqual(before);
});
it("keeps the originally bound input after deletion and owner-local name reuse", () => {
  db.prepare("DELETE FROM data_tables WHERE owner_id = 'alice'").run();
  insertTable(scopes.alice, { ...table("alice"), id: "new-roads", file: "tables/new.parquet" }, db);
  replaceEdges(scopes.alice, steps.alice, "alice-output", [{ inputTableId: "alice-table", inputTableName: "roads", boundArtifact: "tables/alice.parquet" }], db);
  expect(lineage(scopes.alice, steps.alice)[0]).toMatchObject({ inputTableId: "alice-table", boundArtifact: "tables/alice.parquet" });
  expect(readers(scopes.alice, "new-roads")).toEqual([]);
});
it("requires genuine active scope for lineage and producer services", () => {
  for (const scope of [undefined, { accountId: "alice" }] as unknown as AccountScope[]) {
    for (const action of [() => lineage(scope, steps.alice), () => readers(scope, "alice-table"), () => clear(scope, steps.alice), () => currentProducers(scope),
      () => replaceEdges(scope, steps.alice, "alice-table", [], db)]) expect(action).toThrow(expect.objectContaining({ status: 401 }));
  }
});
it("keeps a published fingerprint bound to its inactive owner without decoding foreign provenance", () => {
  const before = fingerprint("alice");
  db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'alice'").run();
  db.prepare("UPDATE data_tables SET source_params = 'private-invalid-json' WHERE owner_id = 'bob'").run();
  expect(fingerprint("alice")).toBe(before);
});
it("refuses direct provenance reads of hidden or absent datasets", async () => {
  const { resolveInputs } = await import("@/lib/operations/provenance");
  for (const account of accounts) for (const foreign of [table(accounts.find(a => a !== account)!), { ...table(account), id: "missing" }]) {
    expect(() => resolveInputs(scopes[account], foreign)).toThrow(expect.objectContaining({ status: 404 }));
  }
});

it.each(["session", "token"])("keeps map and workflow dependency identities private over %s requests", async kind => {
  const mapRoute = await import("@/app/api/maps/[id]/dependencies/route");
  const recipeRoute = await import("@/app/api/recipes/[id]/dependencies/route");
  for (const account of accounts) for (const [route, ids] of [[mapRoute, maps], [recipeRoute, recipes]] as const) {
    function request() {
      const req = testAccountRequest(new Request("http://instance.test/api/dependencies"), db, account);
      if (kind === "token") { const token = createApiToken(requireRequestAuth(req, db), "Dependencies", db); req.headers.delete("cookie"); req.headers.set("authorization", `Bearer ${token.secret}`); }
      return req;
    }
    const own = await route.GET(request(), { params: Promise.resolve({ id: ids[account] }) });
    expect(own.status).toBe(200); expect((await own.json()).datasets.map((d: { id: string }) => d.id)).toEqual([table(account).id]);
    const before = parse.calls, other = accounts.find(a => a !== account)!;
    const hidden = await route.GET(request(), { params: Promise.resolve({ id: ids[other] }) });
    const absent = await route.GET(request(), { params: Promise.resolve({ id: "missing" }) });
    expect([hidden.status, absent.status]).toEqual([404, 404]); expect(await hidden.json()).toEqual(await absent.json()); expect(parse.calls).toBe(before);
  }
});
