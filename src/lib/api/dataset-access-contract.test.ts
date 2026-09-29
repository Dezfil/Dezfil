import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";

it("publishes owner-local dataset access and the absent-resource response in every affected operation and tool", () => {
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { description: string; responses: Record<string, unknown> }>> };
  const paths = ["/api/tables", "/api/tables/{name}", "/api/tables/{name}/features", "/api/tables/{name}/export", "/api/tables/{name}/refresh",
    "/api/catalogue/tables", "/api/tables/{name}/geometry", "/api/tables/{name}/geometry/preview",
    "/api/maps/{id}/sketches", "/api/sketches/{name}", "/api/sketches/{name}/features", "/api/sketches/{name}/features/{featureId}",
    "/api/imports/url", "/api/imports/osm", "/api/imports/overture", "/api/imports/postgis"];
  let count = 0;
  for (const path of paths) for (const operation of Object.values(document.paths[path])) {
    expect(operation.description, path).toContain("authenticated account's space");
    expect(operation.responses, path).toHaveProperty("404"); count++;
  }
  expect(count).toBe(23);
  const tools = buildTools().filter(tool => paths.includes(tool.path));
  expect(tools).toHaveLength(22);
  for (const tool of tools) {
    expect(tool.description, tool.name).toContain("authenticated account's space");
    expect(tool.inputSchema.properties, tool.name).not.toHaveProperty("ownerId");
    expect(tool.inputSchema.properties, tool.name).not.toHaveProperty("owner_id");
  }
});
