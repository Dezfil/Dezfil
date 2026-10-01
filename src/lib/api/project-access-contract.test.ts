import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";

it("publishes project reach, owner and role, atomic member checks and delete-unfiles behavior", () => {
  const paths = ["/api/projects", "/api/projects/{id}", "/api/projects/{id}/members", "/api/projects/{id}/export"];
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { description: string; responses: Record<string, unknown> }>> };
  let count = 0;
  for (const path of paths) for (const [method, operation] of Object.entries(document.paths[path])) {
    if (path.endsWith("/export") && method === "get") continue;
    expect(operation.description).toContain("A project is reached by its owner and by its people, its viewers and editors.");
    expect(operation.description).toContain("name each project's owner and the caller's role");
    expect(operation.description).not.toContain("belong only to the authenticated account");
    expect(operation.responses).toHaveProperty("404"); count++;
  }
  expect(count).toBe(8);
  const tools = buildTools().filter(tool => paths.includes(tool.path)); expect(tools).toHaveLength(8);
  for (const tool of tools) {
    expect(tool.description).toContain("Compound changes are atomic");
    expect(tool.inputSchema.properties).not.toHaveProperty("ownerId");
  }
});

it("documents the owner and the caller's role on every project shape, and a shared project as a filter value", () => {
  const schemas = buildOpenApiDocument().components.schemas as unknown as Record<string, { properties?: Record<string, { enum?: string[] }>; required?: string[] }>;
  expect(schemas.Project.required).toEqual(expect.arrayContaining(["owner", "role"]));
  expect(schemas.Project.properties!.role.enum).toEqual(["owner", "editor", "viewer"]);
  for (const name of ["list_projects", "get_project", "create_project", "update_project"]) {
    expect(JSON.stringify(buildTools().find(tool => tool.name === name)!.outputSchema), name).toContain("\"viewer\"");
  }
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, { get: { parameters: { name: string; description: string }[] } }> };
  for (const path of ["/api/maps", "/api/tables", "/api/recipes"]) {
    const project = document.paths[path].get.parameters.find(p => p.name === "project")!;
    expect(project.description, path).toContain("any project the caller reaches, its own or one shared with it");
  }
});
