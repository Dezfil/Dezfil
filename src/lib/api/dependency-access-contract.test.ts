import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";
it("publishes owner-local dependency identity and generated tool parity", () => {
  const paths = ["/api/maps/{id}/dependencies", "/api/recipes/{id}/dependencies"];
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, { get: { summary: string; description: string; responses: Record<string, unknown> } }> };
  for (const path of paths) {
    expect(document.paths[path].get.description).toContain("Dependency identities, memberships and producers resolve only within the authenticated account");
    expect(document.paths[path].get.responses).toHaveProperty("404");
  }
  const tools = buildTools().filter(tool => paths.includes(tool.path)); expect(tools).toHaveLength(2);
  for (const tool of tools) {
    const operation = document.paths[tool.path].get;
    expect(tool.description).toBe(`${operation.summary}. ${operation.description}`);
  }
});
