import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";

it("publishes private projects, atomic member checks and delete-unfiles behavior", () => {
  const paths = ["/api/projects", "/api/projects/{id}", "/api/projects/{id}/members", "/api/projects/{id}/export"];
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { description: string; responses: Record<string, unknown> }>> };
  let count = 0;
  for (const path of paths) for (const [method, operation] of Object.entries(document.paths[path])) {
    if (path.endsWith("/export") && method === "get") continue;
    expect(operation.description).toContain("Projects, their counts and their member lists belong only to the authenticated account");
    expect(operation.responses).toHaveProperty("404"); count++;
  }
  expect(count).toBe(8);
  const tools = buildTools().filter(tool => paths.includes(tool.path)); expect(tools).toHaveLength(8);
  for (const tool of tools) {
    expect(tool.description).toContain("Compound changes are atomic");
    expect(tool.inputSchema.properties).not.toHaveProperty("ownerId");
  }
});
