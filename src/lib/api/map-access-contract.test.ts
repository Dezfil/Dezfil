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
