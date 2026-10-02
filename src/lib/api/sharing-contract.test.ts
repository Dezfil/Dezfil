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
    expect(Object.keys(transfer.inputSchema.properties as object).sort()).toEqual(name === "transfer_project" ? ["id", "to"] : ["expected_revision", "id", "to"]);
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

it("documents the directory search as the one minimal exception to admin-only account reads", () => {
  const { paths, components } = document();
  const operation = paths["/api/accounts/search"]?.get;
  expect(operation, "/api/accounts/search").toBeDefined();
  expect(operation["x-tool"]).toBe("find_accounts");
  expect(operation.security).toEqual(AUTH_SECURITY);
  expect(operation.description).toContain("the one deliberate exception to account reads being admin-only");
  expect(operation.description).toContain("display name and SQL name and nothing else");
  expect(operation.description).toContain("Deactivated accounts and invitations not yet redeemed are never offered");
  expect(operation.description).toContain("Managing accounts stays admin-only");
  expect(operation.parameters).toEqual([expect.objectContaining({ name: "q", in: "query" })]);
  const find = tool("find_accounts");
  expect(find).toMatchObject({ confirm: false, effects: { readOnly: true, writes: [] },
    mcp: { destructiveHint: false, idempotentHint: true, openWorldHint: false } });
  expect(find.inputSchema.required).toEqual(["q"]);
  const entry = (components.schemas.AccountDirectory.properties!.accounts as unknown as { items: { $ref: string }; maxItems: number });
  expect(entry.maxItems).toBe(20);
  const person = components.schemas.DirectoryPerson as unknown as { properties: object; required: string[]; additionalProperties: boolean };
  expect(Object.keys(person.properties).sort()).toEqual(["name", "sqlName"]);
  expect(person.additionalProperties).toBe(false);
  expect(JSON.stringify(find.outputSchema)).not.toMatch(/"(email|isAdmin|id|status)":/);
  for (const [path, methods] of Object.entries(paths).filter(([path]) => path.startsWith("/api/users"))) {
    for (const users of Object.values(methods)) expect(users.description, path).toContain("Requires a current admin account");
  }
});

it("refuses every change of a deactivated owner's people, removal included", () => {
  const paths = document().paths;
  for (const method of ["put", "delete"]) {
    expect(paths["/api/projects/{id}/people/{sqlName}"][method].description, method)
      .toContain("While the owner's account is deactivated nobody can change the people.");
  }
});

/** Every sentence the published contract and its tools carry: the
 * introduction, the tags, each operation, each schema, each tool. */
function publishedTexts(): string[] {
  const texts: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === "string" && ["description", "summary", "target", "consequence"].includes(key)) texts.push(entry);
        else walk(entry);
      }
    }
  };
  walk(buildOpenApiDocument());
  for (const entry of buildTools()) texts.push(entry.description, JSON.stringify(entry.inputSchema), JSON.stringify(entry.outputSchema));
  return texts;
}

it("promises owner-only access nowhere a project grant reaches", () => {
  const texts = publishedTexts();
  expect(texts.length).toBeGreaterThan(1000);
  const retired = [
    "Maps, datasets, workflows, connections, projects and retained work are private",
    "resolve only within the authenticated account",
    "producers only the caller's own workflows",
    "never change what SQL sees",
    "Every recipe in the workspace",
    "those its content changes are open to",
    "belong only to the authenticated account",
    "authenticated account's own maps",
    "Exporting stays the project owner's",
  ];
  for (const phrase of retired) {
    expect(texts.filter(text => text.includes(phrase)), phrase).toEqual([]);
  }
  // Private to one account is said of connections alone, which a grant never
  // reaches; any other resource saying so contradicts the reach rule.
  const privateTo = /[^.]*private to the authenticated account/g;
  const claims = new Set(texts.flatMap(text => text.match(privateTo) ?? []).map(sentence => sentence.trim()));
  expect([...claims]).toEqual(["Connections are private to the authenticated account"]);
  // The scan can fail: a resource other than connections claiming it is caught.
  const seeded = [...texts, "Workflows are private to the authenticated account, including for administrators."];
  const seededClaims = new Set(seeded.flatMap(text => text.match(privateTo) ?? []).map(sentence => sentence.trim()));
  expect([...seededClaims]).not.toEqual(["Connections are private to the authenticated account"]);
});

it("reports one's own filing in a project one no longer reaches, by identity, and keeps none for the unfiled alone", () => {
  const { paths, components } = document();
  const schemas = components.schemas as unknown as Record<string, { properties: Record<string, { description: string; items?: { properties: Record<string, { description: string }> } }> }>;
  const own = /(a project|one) they no longer reach included/;
  const withdraw = "PATCH /api/projects/{id}/members";
  const fields = [
    schemas.MapPresence.properties.projectId.description,
    schemas.Recipe.properties.projectId.description,
    schemas.Table.properties.projectIds.description,
    schemas.DependencyDataset.properties.projectIds.description,
    schemas.TableCatalogue.properties.tables.items!.properties.projectIds.description,
  ];
  for (const text of fields) expect(text).toMatch(own);
  for (const text of [fields[0], fields[1], fields[2], fields[4]]) expect(text).toContain(withdraw);
  for (const path of ["/api/maps", "/api/recipes", "/api/tables"]) {
    const scope = (paths[path].get.parameters as unknown as { name: string; description: string }[]).find(p => p.name === "project")!;
    expect(scope.description, path).toContain("filed in no project at all");
  }
  const catalogue = (paths["/api/catalogue/tables"].get.parameters as unknown as { name: string; description: string }[]).find(p => p.name === "project")!;
  expect(catalogue.description).toContain("filed in no project at all");
  for (const name of ["list_maps", "get_map", "list_recipes", "get_recipe", "list_tables", "inspect_table", "read_table_catalogue"]) {
    expect(JSON.stringify(tool(name).outputSchema), name).toMatch(own);
  }
  const texts = publishedTexts();
  for (const phrase of ["in none the caller reaches", "filed in no project it reaches", "filed in no project they reach", "never another. Identities only"]) {
    expect(texts.filter(text => text.includes(phrase)), phrase).toEqual([]);
  }
});

it("documents the roster as the owner's to read whole, a member reading the owner and themselves alone", () => {
  const sentence = "The project's owner reads them all; anyone else who reaches the project reads the owner and themselves alone, with their own role.";
  const paths = document().paths;
  for (const [path, method] of [["/api/projects/{id}/people", "get"], ["/api/projects/{id}/people/{sqlName}", "put"], ["/api/projects/{id}/people/{sqlName}", "delete"]]) {
    expect(paths[path][method].description, `${method} ${path}`).toContain(sentence);
    expect(paths[path][method].description, `${method} ${path}`).not.toContain("Everyone who reaches the project reads them.");
  }
  expect(tool("list_project_people").description).toContain(sentence);
});
