import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import * as metadata from "./metadata/db";
import { testAccountScope } from "./test-support/accounts";
import { createMap, readMap, updateMap } from "./map-service";
import { mapHistory } from "./map-history";
import { createRecipe } from "./metadata/owned-recipes";
import { createCascade } from "./metadata/cascades";
import { throughTransferGate } from "./metadata/ownership-transfer";
import { readDocumentRevision } from "./metadata/revisions";
import { readCascade } from "./operations/cascade";
import { namespaceFor } from "./query/namespace";
import { mapEvaluation } from "./query/context";
import { dispatchAssistantTestRoute } from "./assistant/testing/route-dispatch";
import { testClient } from "./mcp/test-client";
import { buildTools } from "./tools/tools";

let db: Database;
beforeEach(() => { db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); db.close(); });
function fixture() {
  const scope = testAccountScope(db), actor = testAccountScope(db, "former-person");
  const map = createMap(actor, "Surviving map"), workflow = createRecipe(scope, "Workflow", db);
  throughTransferGate({ kind: "map", id: map.id, from: actor.accountId, to: scope.accountId }, db, () => {
    db.prepare("UPDATE maps SET owner_id = ? WHERE id = ?").run(scope.accountId, map.id);
  });
  updateMap(scope, map.id, { name: "Changed" }, { expectedRevision: readDocumentRevision({ kind: "map", id: map.id }, db)!.editRevision });
  db.prepare("UPDATE map_history SET author_id = ? WHERE map_id = ?").run(actor.accountId, map.id);
  db.prepare("UPDATE maps SET last_changed_by = ? WHERE id = ?").run(actor.accountId, map.id);
  db.prepare("UPDATE recipes SET last_changed_by = ? WHERE id = ?").run(actor.accountId, workflow.id);
  const run = createCascade(workflow.id, "single", [], db, actor.accountId);
  const snapshot = () => ["maps", "recipes", "map_history", "cascade_runs"].map(t => db.prepare(`SELECT * FROM ${t}`).all());
  return { scope, actor, map, workflow, run, snapshot };
}
function eraseProfile() {
  db.exec(`UPDATE accounts SET status = 'deleted', name = NULL, email = NULL, password_hash = NULL,
    is_admin = NULL, created_at = NULL, updated_at = NULL, last_sign_in_at = NULL WHERE id = 'former-person'`);
}
it("changes named attribution to the explicit deleted actor on facts, history and runs without rewriting records or homes", async () => {
  const f = fixture(), before = f.snapshot();
  expect(readMap(f.scope, f.map.id).lastChangedBy).toEqual({ name: "former-person", sqlName: "former_person" });
  expect((await mapHistory(f.scope, f.map.id)).undoTarget?.steps[0].author).toEqual({ name: "former-person", sqlName: "former_person" });
  expect(readCascade(f.scope, f.run.id).runner).toEqual({ name: "former-person", sqlName: "former_person" });
  eraseProfile();
  expect(readMap(f.scope, f.map.id).lastChangedBy).toEqual({ deleted: true });
  expect((await mapHistory(f.scope, f.map.id)).undoTarget?.steps[0].author).toEqual({ deleted: true });
  expect(readCascade(f.scope, f.run.id).runner).toEqual({ deleted: true });
  expect(readMap(f.scope, f.map.id).home).toBe("former_person");
  expect(namespaceFor(mapEvaluation(f.scope, f.map.id), db).home.sqlName).toBe("former_person");
  expect(f.snapshot()).toEqual(before);
});
it("keeps null Unknown distinct from a deleted identity", async () => {
  const f = fixture();
  db.exec("UPDATE maps SET last_changed_by = NULL; UPDATE map_history SET author_id = NULL");
  expect(readMap(f.scope, f.map.id).lastChangedBy).toBeNull();
  expect((await mapHistory(f.scope, f.map.id)).undoTarget?.steps[0].author).toBeNull();
  const unknown = createCascade("no-longer-present", "single", [], db);
  db.prepare("UPDATE cascade_runs SET recipe_id = ? WHERE id = ?").run(f.workflow.id, unknown.id);
  expect(readCascade(f.scope, unknown.id).runner).toBeNull();
});
it("carries identical explicit actors through real REST handlers and generated MCP results", async () => {
  const f = fixture(); eraseProfile();
  const client = await testClient(dispatchAssistantTestRoute);
  try {
    for (const [name, args, url, field] of [
      ["get_map", { id: f.map.id }, `/api/maps/${f.map.id}`, "lastChangedBy"],
      ["get_recipe", { id: f.workflow.id }, `/api/recipes/${f.workflow.id}`, "recipe"],
      ["get_history", { id: f.map.id }, `/api/maps/${f.map.id}/history`, "history"],
      ["get_recipe_run", { id: f.workflow.id, runId: f.run.id }, `/api/recipes/${f.workflow.id}/runs/${f.run.id}`, "run"],
    ] as const) {
      const response = await dispatchAssistantTestRoute(new Request(`http://localhost:3307${url}`));
      expect(response.status).toBe(200); const rest = await response.json();
      const actor = field === "history" ? rest.undoTarget.steps[0].author : field === "run" ? rest.run.runner : field === "recipe" ? rest.recipe.lastChangedBy : rest.lastChangedBy;
      expect(actor).toEqual({ deleted: true });
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError ?? false).toBe(false);
      expect(result.structuredContent).toEqual({ result: rest, history: null });
      expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual(rest);
      const validator = fromJsonSchema(buildTools().find(t => t.name === name)!.outputSchema! as Parameters<typeof fromJsonSchema>[0]);
      expect((await validator["~standard"].validate(result.structuredContent)).issues).toBeUndefined();
      const bad = structuredClone(result.structuredContent) as { result: typeof rest };
      if (field === "history") bad.result.undoTarget.steps[0].author = { deleted: true, name: "leak" };
      else if (field === "run") bad.result.run.runner = { deleted: true, sqlName: "leak" };
      else if (field === "recipe") bad.result.recipe.lastChangedBy = { deleted: true, name: "leak" };
      else bad.result.lastChangedBy = { deleted: true, name: "leak" };
      expect((await validator["~standard"].validate(bad)).issues).toBeDefined();
    }
  } finally { await client.close(); }
});
