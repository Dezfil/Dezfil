import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";

it("documents the map owner boundary on private operations and generated tools", () => {
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { description: string; responses: Record<string, unknown> }>> };
  for (const path of ["/api/maps", "/api/maps/{id}", "/api/maps/{id}/duplicate", "/api/maps/{id}/publish",
    "/api/maps/{id}/dependencies", "/api/maps/{id}/history", "/api/maps/{id}/undo", "/api/maps/{id}/redo", "/api/maps/look", "/api/maps/{id}/export/image"]) {
    for (const operation of Object.values(document.paths[path])) {
      expect(operation.description, path).toContain("authenticated account's own maps");
      expect(operation.responses, path).toHaveProperty("404");
    }
  }
  for (const name of ["list_maps", "get_map", "update_map", "delete_map", "duplicate_map", "publish_map", "unpublish_map", "get_history"]) {
    const tool = buildTools().find(tool => tool.name === name)!;
    expect(tool.description, name).toContain("Hidden and missing map or project identities both return not_found");
    expect(tool.inputSchema.properties).not.toHaveProperty("ownerId");
  }
  expect(document.paths["/api/maps/look/{renderId}"].get.description).not.toContain("authenticated account's own maps");
});
