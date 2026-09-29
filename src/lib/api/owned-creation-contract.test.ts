import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";

it("documents authenticated creation and carries ownership semantics into generated tools", () => {
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { description: string }>> };
  const paths = ["/api/maps", "/api/maps/{id}/duplicate", "/api/maps/{id}/sketches", "/api/tables",
    "/api/imports/url", "/api/imports/osm", "/api/imports/overture", "/api/imports/postgis",
    "/api/connections/postgis", "/api/projects", "/api/recipes", "/api/recipes/{id}/duplicate",
    "/api/recipes/{id}/runs", "/api/recipes/{id}/steps/{stepId}/run", "/api/operations/run"];
  for (const path of paths) expect(document.paths[path].post.description, path).toContain("belong to the authenticated account");
  const tools = buildTools();
  for (const name of ["create_map", "create_project", "create_recipe", "create_sketch", "upload_table", "run_operation"]) {
    const tool = tools.find(tool => tool.name === name)!;
    expect(tool, name).toBeDefined();
    expect(tool.description, name).toContain("belong to the authenticated account");
    expect(tool.inputSchema.properties).not.toHaveProperty("ownerId");
    expect(tool.inputSchema.properties).not.toHaveProperty("owner_id");
  }
});
