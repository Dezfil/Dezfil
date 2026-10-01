import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";
it("publishes the layer boundary its map's reach decides and the parent-reference refusals", () => {
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { description: string; responses: Record<string, unknown> }>> };
  for (const [path, methods] of Object.entries(document.paths)) {
    if (!path.startsWith("/api/layers/") && path !== "/api/maps/{id}/layers") continue;
    for (const operation of Object.values(methods)) {
      expect(operation.description, path).toContain("Unreached, missing or mismatched parent/child identities return not_found");
      expect(operation.description, path).toContain("Layers and widgets follow their map: everyone who reaches the map reads and evaluates them");
      expect(operation.description, path).toContain("Layer SQL saved by anyone but the map's owner must name only datasets within their own reach in the map's home");
      expect(operation.responses, path).toHaveProperty("404");
    }
  }
  for (const name of ["list_layers", "create_layer", "get_layer", "update_layer", "delete_layer", "duplicate_layer", "update_map"]) {
    const tool = buildTools().find(tool => tool.name === name)!;
    expect(tool.description, name).toContain("Layers and widgets follow their map");
    expect(tool.description, name).not.toContain("authenticated account's own maps");
    expect(tool.description, name).toContain("exact map");
    expect(tool.inputSchema.properties).not.toHaveProperty("ownerId");
  }
});
