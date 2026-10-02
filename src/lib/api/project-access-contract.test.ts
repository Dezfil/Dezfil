import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";

it("publishes project reach, owner and role, atomic member checks and delete-unfiles behavior", () => {
  const paths = ["/api/projects", "/api/projects/{id}", "/api/projects/{id}/members", "/api/projects/{id}/export"];
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { description: string; responses: Record<string, unknown> }>> };
  let count = 0;
  for (const path of paths) for (const [method, operation] of Object.entries(document.paths[path])) {
    if (method === "head" || method === "options" || (path.endsWith("/export") && method === "get")) continue;
    expect(operation.description).toContain("A project is reached by its owner and by its people, its viewers and editors.");
    expect(operation.description).toContain("name each project's owner and the caller's role");
    expect(operation.description).not.toContain("belong only to the authenticated account");
    expect(operation.description).toContain("Anyone who reaches a project may export it, viewers included");
    expect(operation.description).not.toContain("Exporting stays the project owner's");
    expect(operation.description).toContain("Renaming, the note, dissolution, its people and its transfer are the owner's");
    expect(operation.responses).toHaveProperty("404"); count++;
  }
  expect(count).toBe(8);
  const tools = buildTools().filter(tool => paths.includes(tool.path)); expect(tools).toHaveLength(8);
  for (const tool of tools) {
    expect(tool.description).toContain("Compound changes are atomic");
    expect(tool.inputSchema.properties).not.toHaveProperty("ownerId");
  }
});

it("documents the archive's per-owner dataset entries and the homes its documents carry", () => {
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { description: string }>> };
  const exporting = document.paths["/api/projects/{id}/export"].post.description;
  expect(exporting).toContain("<sql name>.<name> for another owner's, so two people's same-named datasets never collide");
  expect(exporting).toContain("Map and workflow documents carry their SQL home");
  expect(exporting).toContain("No connection facts travel");
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

it("states the filing rules on the project operations and wherever a project is named at creation", () => {
  type Operation = { description: string; parameters?: { name: string; description?: string }[]; requestBody?: unknown };
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, Operation>> };
  for (const name of ["list_projects", "get_project", "update_project_members", "delete_project"]) {
    const tool = buildTools().find(entry => entry.name === name)!;
    expect(tool.description, name).toContain("adding a map, workflow or dataset needs the destination's permission (the project's owner, or an editor filing their own resource)");
    expect(tool.description, name).toContain("the owner of a resource may always withdraw it from any project, member or not");
    expect(tool.description, name).not.toContain("Filing or unfiling requires ownership of the project");
  }
  expect(document.paths["/api/projects/{id}/members"].patch.description).toContain("An owner who no longer reaches the project may still withdraw their own resources from it");
  const destination = "It must be a project the caller owns or edits, whose owner is active: one the caller only views refuses with forbidden";
  for (const path of ["/api/maps", "/api/recipes", "/api/imports/url", "/api/imports/osm", "/api/imports/overture", "/api/imports/postgis", "/api/tables"]) {
    expect(JSON.stringify(document.paths[path].post), path).toContain(destination);
  }
});

it("names the project as the one boundary of sharing, and lists what the caller reaches", () => {
  const document = buildOpenApiDocument() as unknown as { tags: { name: string; description: string }[]; paths: Record<string, Record<string, { description: string }>> };
  const tag = document.tags.find(entry => entry.name === "Projects")!.description;
  expect(tag).toContain("A project is also the one boundary of sharing: its owner gives people the viewer or editor role, and they reach everything filed in it, whoever owns it.");
  expect(tag).toContain("Filing never changes who owns a resource or what a plain table name means in a map's or workflow's SQL.");
  expect(tag).not.toContain("never change what SQL sees");
  expect(document.paths["/api/projects"].get.description).toContain("Every project the caller reaches, its own and those shared with it, with its member counts");
});
