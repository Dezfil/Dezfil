import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";

it("documents the map reach boundary on map operations and generated tools", () => {
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { description: string; responses: Record<string, unknown> }>> };
  for (const path of ["/api/maps", "/api/maps/{id}", "/api/maps/{id}/duplicate", "/api/maps/{id}/publish",
    "/api/maps/{id}/dependencies", "/api/maps/{id}/history", "/api/maps/{id}/undo", "/api/maps/{id}/redo", "/api/maps/look", "/api/maps/{id}/export/image"]) {
    for (const operation of Object.values(document.paths[path])) {
      expect(operation.description, path).toContain("A map is reached by its owner and, while it is filed in a project, by that project's owner and people.");
      expect(operation.description, path).toContain("name each map's owner and SQL home");
      expect(operation.description, path).toContain("SQL anyone but the owner saves, directly or by undo and redo, must name only datasets within their own reach in the map's home");
      expect(operation.description, path).not.toContain("authenticated account's own maps");
      expect(operation.responses, path).toHaveProperty("404");
    }
  }
  for (const name of ["list_maps", "get_map", "update_map", "delete_map", "duplicate_map", "publish_map", "unpublish_map", "get_history"]) {
    const tool = buildTools().find(tool => tool.name === name)!;
    expect(tool.description, name).toContain("Unreached and missing map or project identities both return not_found");
    expect(tool.description, name).toContain("a reached map whose change the caller may not make returns forbidden");
    expect(tool.inputSchema.properties).not.toHaveProperty("ownerId");
  }
  expect(document.paths["/api/maps/look/{renderId}"].get.description).not.toContain("A map is reached by its owner");
});

it("documents the owner, SQL home and reachable project on every map read shape", () => {
  const schemas = buildOpenApiDocument().components.schemas as unknown as Record<string, { properties?: Record<string, unknown>; required?: string[]; allOf?: { $ref?: string }[] }>;
  expect(schemas.ResourceOwner.required).toEqual(["name", "sqlName"]);
  expect(Object.keys(schemas.ResourceOwner.properties!)).not.toContain("email");
  expect(schemas.MapPresence.required).toEqual(["projectId", "owner", "home"]);
  for (const name of ["MapOverview", "MapWithLayers", "MapCreated"]) {
    expect(schemas[name].allOf!.map(part => part.$ref), name).toContain("#/components/schemas/MapPresence");
  }
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: { $ref: string } }> }> }>> };
  expect(document.paths["/api/maps"].post.responses["201"].content!["application/json"].schema.$ref).toBe("#/components/schemas/MapCreated");
  for (const name of ["get_map", "list_maps", "update_map", "create_map", "undo_change"]) {
    expect(JSON.stringify(buildTools().find(tool => tool.name === name)!.outputSchema), name).toContain("sqlName");
  }
});

it("names the publication settings the owner's alone wherever a write or replay could change one", () => {
  type Operation = { description: string; requestBody?: { content: { "application/json": { schema: { properties?: Record<string, { description?: string }>; $ref?: string } } } } };
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, Operation>>; components: { schemas: Record<string, { properties?: Record<string, { description?: string }> }> } };
  expect(document.paths["/api/maps/{id}/publish"].post.description).toContain("Minting a publication and changing its theme or reader controls are the map owner's alone.");
  expect(document.paths["/api/maps/{id}/publish"].delete.description).toContain("Revoking a publication is the map owner's alone.");
  for (const path of ["/api/maps/{id}/undo", "/api/maps/{id}/redo"]) {
    expect(document.paths[path].post.description, path).toContain("A replay that would change a publication setting (the widget publication toggle or a layer's published fields) is the map owner's alone");
  }
  const owned = "A publication setting: only the map's owner changes it, and anyone else's write that would change it is refused whole with forbidden.";
  const mapBody = JSON.stringify(document.paths["/api/maps/{id}"].patch.requestBody);
  const layerBody = JSON.stringify(document.paths["/api/layers/{id}"].patch.requestBody) + JSON.stringify(document.components.schemas);
  expect(mapBody + JSON.stringify(document.components.schemas)).toContain(`Whether widgets ship with the published view. ${owned}`);
  expect(layerBody).toContain("publishes regardless of this list. " + owned);
  for (const name of ["publish_map", "unpublish_map", "undo_change", "redo_change"]) {
    expect(buildTools().find(tool => tool.name === name)!.description, name).toContain("the map owner's alone");
  }
  for (const name of ["update_map", "update_layer"]) {
    expect(JSON.stringify(buildTools().find(tool => tool.name === name)!.inputSchema), name).toContain(owned);
  }
});
