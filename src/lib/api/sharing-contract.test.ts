import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { AUTH_SECURITY } from "./openapi-auth";
import { buildTools, type ToolDef } from "@/lib/tools/tools";

/**
 * The sharing operations' published contract: each route is documented,
 * generates its tool, and carries the consequence and confirmation metadata
 * the assistant and MCP clients act on. The intended values are pinned here
 * independently of the document the tools are generated from.
 */
type Operation = { description: string; security: unknown; responses: Record<string, unknown>; "x-tool": string;
  "x-confirm"?: boolean; parameters?: { name: string; in: string }[] };
const document = () => buildOpenApiDocument() as unknown as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, { properties?: Record<string, { enum?: string[] } & Record<string, unknown>>; required?: string[] }> };
};
const tool = (name: string): ToolDef => {
  const found = buildTools().find(entry => entry.name === name);
  expect(found, name).toBeDefined();
  return found!;
};

it("documents a project's people as one read and two owner-only writes, each generating its tool", () => {
  const paths = document().paths;
  const operations: [string, string, string][] = [
    ["/api/projects/{id}/people", "get", "list_project_people"],
    ["/api/projects/{id}/people/{sqlName}", "put", "set_project_person"],
    ["/api/projects/{id}/people/{sqlName}", "delete", "remove_project_person"],
  ];
  for (const [path, method, name] of operations) {
    const operation = paths[path]?.[method];
    expect(operation, `${method} ${path}`).toBeDefined();
    expect(operation["x-tool"]).toBe(name);
    expect(operation.security).toEqual(AUTH_SECURITY);
    expect(operation.description).toContain("A project is reached by its owner and by its people");
    expect(operation.responses).toHaveProperty("404");
    expect(tool(name).inputSchema.properties).not.toHaveProperty("ownerId");
  }
  expect(paths["/api/projects/{id}/people"].get.description).toContain("the owner first");
  for (const method of ["put", "delete"]) {
    const operation = paths["/api/projects/{id}/people/{sqlName}"][method];
    expect(operation.description).toContain("Adding a person, changing a role and removing a person are the project owner's alone");
    expect(operation.description).toContain("on their next request");
    expect(operation.responses).toHaveProperty("403");
  }
  expect(paths["/api/projects/{id}/people/{sqlName}"].put.description).toContain("No active person has that SQL name.");
  expect(Object.keys(tool("set_project_person").inputSchema.properties as object).sort()).toEqual(["id", "role", "sqlName"]);
  expect((tool("set_project_person").inputSchema.properties as Record<string, { enum?: string[] }>).role.enum).toEqual(["viewer", "editor"]);
});

it("describes each person by display name, SQL name, role and the deactivated mark, never an email or an identity", () => {
  const schemas = document().components.schemas;
  expect(schemas.ProjectPerson.required).toEqual(["name", "sqlName", "role", "deactivated"]);
  expect(Object.keys(schemas.ProjectPerson.properties!).sort()).toEqual(["deactivated", "name", "role", "sqlName"]);
  expect(schemas.ProjectPerson.properties!.role.enum).toEqual(["owner", "editor", "viewer"]);
  expect(schemas.ProjectPeople.required).toEqual(["people"]);
  for (const name of ["list_project_people", "set_project_person", "remove_project_person"]) {
    const output = JSON.stringify(tool(name).outputSchema);
    expect(output, name).toContain("deactivated");
    expect(output, name).not.toMatch(/"(email|isAdmin|id|accountId)":/);
  }
});

it("reads people freely and puts every change of them behind the confirmation gate", () => {
  expect(tool("list_project_people")).toMatchObject({ confirm: false, effects: { readOnly: true, writes: [] },
    mcp: { destructiveHint: false, idempotentHint: true, openWorldHint: false } });
  for (const name of ["set_project_person", "remove_project_person"]) {
    const write = tool(name);
    expect(write.confirm, name).toBe(true);
    expect(write.effects, name).toEqual({ readOnly: false, writes: [{ resource: "projects", argument: "id", collection: true }] });
    expect(write.mcp, name).toEqual({ destructiveHint: true, idempotentHint: true, openWorldHint: false });
    expect(write.confirmation?.subject, name).toMatchObject({ path: "/api/projects/{id}", argument: "id", name: "name" });
    expect(write.confirmation?.target, name).toContain("{target}");
    expect(write.confirmation?.consequence, name).toMatch(/next request/);
  }
});

it("documents transfer for a project, a map and a workflow, each the owner's alone and behind the confirmation gate", () => {
  const paths = document().paths;
  const operations: [string, string, string, string][] = [
    ["/api/projects/{id}/transfer", "transfer_project", "A project is reached by its owner and by its people", "projects"],
    ["/api/maps/{id}/transfer", "transfer_map", "A map is reached by its owner and, while it is filed in a project", "maps"],
    ["/api/recipes/{id}/transfer", "transfer_workflow", "A workflow is reached by its owner and, while it is filed in a project", "recipes"],
  ];
  for (const [path, name, reach, written] of operations) {
    const operation = paths[path]?.post;
    expect(operation, path).toBeDefined();
    expect(operation["x-tool"]).toBe(name);
    expect(operation.security).toEqual(AUTH_SECURITY);
    expect(operation.description).toContain(reach);
    expect(operation.description).toContain("Transfer is the only change of ownership");
    for (const status of ["400", "403", "404"]) expect(operation.responses, `${path} ${status}`).toHaveProperty(status);
    const transfer = tool(name);
    expect(Object.keys(transfer.inputSchema.properties as object).sort()).toEqual(["id", "to"]);
    expect(transfer.confirm).toBe(true);
    expect(transfer.effects).toEqual({ readOnly: false, writes: [{ resource: written, argument: "id", collection: true }] });
    expect(transfer.mcp).toEqual({ destructiveHint: true, idempotentHint: false, openWorldHint: false });
    expect(transfer.confirmation?.target).toContain("{target}");
    expect(transfer.confirmation?.consequence).toContain("Only they can give it back.");
  }
  expect(paths["/api/projects/{id}/transfer"].post.description).toContain("the previous owner becomes an editor");
  for (const path of ["/api/maps/{id}/transfer", "/api/recipes/{id}/transfer"]) {
    expect(paths[path].post.description).toContain("keeps its SQL home");
    expect(paths[path].post.description).toContain("in a project first");
  }
  expect(paths["/api/maps/{id}/transfer"].post.description).toContain("its publication, which becomes the new owner's");
  expect(document().components.schemas.Transfer.required).toEqual(["id", "owner"]);
});
