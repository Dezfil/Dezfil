import { declaredRevisionArguments } from "./edit-basis";
import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import * as metadata from "./metadata/db";
import { testAccountScope, testAccountRequest } from "./test-support/accounts";
import { createMap, updateMap, undoChange } from "./map-service";
import * as tiles from "./tiles/build";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { createLayer } from "./layer-creation";
import { publishMap } from "./publish/publication-state";
import { readDocumentRevision } from "./metadata/revisions";
import { fileMap } from "./metadata/owned-projects";
import { buildTools } from "./tools/tools";
import { executeTool, elideAttachment } from "./tools/execute";
import { mcpResult } from "./mcp/result";
import { dispatchAssistantTestRoute } from "./assistant/testing/route-dispatch";
import { POST as createMapRoute } from "@/app/api/maps/route";
import { DELETE as removeLayerRoute } from "@/app/api/layers/[id]/route";
import { DELETE as unpublishRoute } from "@/app/api/maps/[id]/publish/route";
let db: Database;
beforeEach(() => { db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });
const req = (url: string, method: string, body?: unknown) => testAccountRequest(new Request(`http://instance.test${url}`, { method,
  ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }), db);
const revision = (id: string) => readDocumentRevision({ kind: "map", id }, db)!.editRevision;
const dispatch = (async (input: RequestInfo | URL, init?: RequestInit) => dispatchAssistantTestRoute(new Request(String(input), init))) as typeof fetch;
async function call(name: string, args: Record<string, unknown>, document?: { kind: "map" | "workflow"; id: string }) {
  const tool = buildTools().find(tool => tool.name === name)!;
  const result = await executeTool(tool, document ? declaredRevisionArguments(tool, args, readDocumentRevision(document, db)!) : args, "http://instance.test", dispatch);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  const wire = mcpResult(tool, result, null);
  const validator = fromJsonSchema(tool.outputSchema as Parameters<typeof fromJsonSchema>[0]);
  expect((await validator["~standard"].validate(wire.structuredContent)).issues, name).toBeUndefined();
  const body = result.body as Record<string, unknown>;
  if (document) {
    expect(body.editRevision, name).toBe(readDocumentRevision(document, db)!.editRevision);
    const { editRevision: _removed, ...withoutRevision } = body;
    void _removed;
    expect((await validator["~standard"].validate({ result: withoutRevision, history: null })).issues, name).toBeDefined();
  }
  return body;
}
it("returns the created map's revision", async () => {
  const response = await createMapRoute(req("/api/maps", "POST", { name: "Created" }));
  const body = await response.json();
  expect(response.status).toBe(201);
  expect(body.editRevision).toBe(revision(body.id));
});
it("returns JSON revisions for formerly bodyless layer deletion and unpublication", async () => {
  const scope = testAccountScope(db), map = createMap(scope, "Map");
  const layer = await createLayer(scope, map.id, { name: "Layer", sql: "SELECT ST_Point(1,2) AS geom" });
  const removed = await removeLayerRoute(req(`/api/layers/${layer.id}`, "DELETE"), { params: Promise.resolve({ id: layer.id }) });
  expect(removed.status).toBe(200);
  expect(await removed.json()).toMatchObject({ editRevision: revision(map.id) });
  publishMap(scope, map.id);
  const unpublished = await unpublishRoute(req(`/api/maps/${map.id}/publish`, "DELETE"), { params: Promise.resolve({ id: map.id }) });
  expect(unpublished.status).toBe(200);
  expect(await unpublished.json()).toMatchObject({ editRevision: revision(map.id) });
});
it("preserves accepted revisions through tool execution, MCP text/structured output and assistant context", async () => {
  const scope = testAccountScope(db), map = createMap(scope, "Map");
  publishMap(scope, map.id);
  const tool = buildTools().find(tool => tool.name === "unpublish_map")!;
  const result = await executeTool(tool, { id: map.id }, "http://instance.test", dispatch);
  expect(result).toMatchObject({ status: 200, ok: true, body: { editRevision: revision(map.id) } });
  expect(elideAttachment(result.body)).toEqual(result.body);
  expect(elideAttachment({ editRevision: revision(map.id), attachment: { content_base64: "AA==", filename: "map.png", content_type: "image/png", size_bytes: 1 } }))
    .toMatchObject({ editRevision: revision(map.id), attachment: { content_base64: expect.stringContaining("elided") } });
  const mcp = mcpResult(tool, result, null);
  expect(mcp.structuredContent).toMatchObject({ result: { editRevision: revision(map.id) } });
  expect(JSON.parse((mcp.content[0] as { text: string }).text)).toEqual(result.body);
});
it("returns and requires workflow result revisions across definition, layout and child operations", async () => {
  const created = await call("create_recipe", { name: "Workflow" });
  const id = (created.recipe as { id: string }).id, doc = { kind: "workflow" as const, id };
  expect(created.editRevision).toBe(readDocumentRevision(doc, db)!.editRevision);
  await call("update_recipe", { id, name: "Renamed" }, doc);
  const added = await call("add_recipe_step", { id, operation: "sql_step", parameters: { name: "first", sql: "SELECT 1" } }, doc);
  const stepId = (added.step as { id: string }).id;
  await call("update_recipe_step", { id, stepId, parameters: { name: "first", sql: "SELECT 2" } }, doc);
  await call("add_recipe_step", { id, operation: "sql_step", parameters: { name: "second", sql: "SELECT 3" } }, doc);
  await call("move_recipe_step", { id, stepId, ordinal: 1 }, doc);
  await call("discard_recipe_step_edit", { id, stepId }, doc);
  await call("set_recipe_layout", { id, steps: { [stepId]: { x: 40, y: 60 } }, sources: {}, notes: [] }, doc);
  const copy = await call("duplicate_recipe", { id });
  expect(copy.editRevision).toBe(readDocumentRevision({ kind: "workflow", id: (copy.recipe as { id: string }).id }, db)!.editRevision);
  await call("remove_recipe_step", { id, stepId }, doc);
  const deleted = await call("delete_recipe", { id });
  expect(deleted).not.toHaveProperty("editRevision");
});
it("returns map revisions across edits, copies, layer operations and publication", async () => {
  const map = await call("create_map", { name: "Map" });
  const id = map.id as string, doc = { kind: "map" as const, id };
  await call("update_map", { id, name: "Renamed" }, doc);
  const layer = await call("create_layer", { id, name: "Layer", sql: "SELECT ST_Point(1,2) AS geom" }, doc);
  await call("update_layer", { id: layer.id, name: "Renamed layer" }, doc);
  const copy = await call("duplicate_layer", { id: layer.id }, doc);
  await call("delete_layer", { id: copy.id }, doc);
  await call("publish_map", { id }, doc);
  await call("unpublish_map", { id }, doc);
  const copiedMap = await call("duplicate_map", { id });
  expect(copiedMap.editRevision).toBe(revision(copiedMap.id as string));
});
it("returns map revisions for sketch attachment and both cascade entry points", async () => {
  const map = createMap(testAccountScope(db), "Sketches"), doc = { kind: "map" as const, id: map.id };
  const feature = { kind: "point", geometry: { type: "Point", coordinates: [1, 2] } };
  const first = await call("create_sketch", { id: map.id, feature }, doc);
  await call("delete_layer", { id: first.layerId }, doc);
  const second = await call("create_sketch", { id: map.id, feature }, doc);
  await call("delete_sketch", { name: second.table }, doc);
});
it("returns withdrawn filing revisions and omits documents lost on dissolution", async () => {
  const own = createMap(testAccountScope(db), "Own");
  const project = await call("create_project", { name: "Project", members: { addMaps: [own.id] } });
  expect(project.revisions).toEqual([{ kind: "map", id: own.id, editRevision: revision(own.id) }]);
  const removed = await call("update_project_members", { id: project.id, removeMaps: [own.id] });
  expect(removed).toMatchObject({ maps: [], revisions: [{ kind: "map", id: own.id, editRevision: revision(own.id) }] });
  const other = createMap(testAccountScope(db, "other"), "Other");
  db.prepare("INSERT INTO project_people VALUES (?, 'other', 'editor', 't')").run(project.id);
  fileMap(testAccountScope(db, "other"), other.id, project.id as string, db);
  await call("update_project_members", { id: project.id, addMaps: [own.id] });
  const dissolved = await call("delete_project", { id: project.id });
  expect(dissolved.revisions).toEqual([{ kind: "map", id: own.id, editRevision: revision(own.id) }]);
});
it("omits the resulting revision when transfer ends the caller's reach", async () => {
  const owner = testAccountScope(db), other = testAccountScope(db, "other");
  const { createProject } = await import("./metadata/owned-projects");
  const project = createProject(other, { name: "Other project" }, db);
  db.prepare("INSERT INTO project_people VALUES (?, ?, 'editor', 't')").run(project.id, owner.accountId);
  const map = createMap(owner, "Map", project.id);
  db.prepare("DELETE FROM project_people WHERE project_id = ? AND account_id = ?").run(project.id, owner.accountId);
  const result = await call("transfer_map", { id: map.id, to: "other" });
  expect(result).not.toHaveProperty("editRevision");
});
it("returns the accepted history state while later work lands during artifact cleanup", async () => {
  const scope = testAccountScope(db), map = createMap(scope, "Before");
  await createLayer(scope, map.id, { name: "Layer", sql: "SELECT ST_Point(1,2) AS geom" });
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(tiles, "removeTileArtifacts").mockImplementation(async () => { entered(); await barrier; });
  const pending = undoChange(scope, map.id);
  await waiting;
  const accepted = revision(map.id);
  updateMap(scope, map.id, { name: "Later" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  release();
  expect(await pending).toMatchObject({ name: "Before", editRevision: accepted, history: { editRevision: accepted } });
});
