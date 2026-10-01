import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";
it("publishes dependency identity under reach and generated tool parity", () => {
  const paths = ["/api/maps/{id}/dependencies", "/api/recipes/{id}/dependencies"];
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, { get: { summary: string; description: string; responses: Record<string, unknown> } }> };
  expect(document.paths["/api/maps/{id}/dependencies"].get.description).toContain("Each layer's references resolve to dataset identities in the map's SQL home within the caller's reach");
  expect(document.paths["/api/maps/{id}/dependencies"].get.description).toContain("a dataset the caller cannot reach is left out rather than named");
  expect(document.paths["/api/recipes/{id}/dependencies"].get.description).toContain("Dependency identities, memberships and producers resolve only within the authenticated account");
  for (const path of paths) expect(document.paths[path].get.responses).toHaveProperty("404");
  const tools = buildTools().filter(tool => paths.includes(tool.path)); expect(tools).toHaveLength(2);
  for (const tool of tools) {
    const operation = document.paths[tool.path].get;
    expect(tool.description).toBe(`${operation.summary}. ${operation.description}`);
  }
});
