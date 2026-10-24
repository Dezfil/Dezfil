import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { ACCOUNT_ACTOR_SCHEMA } from "./openapi-document-facts";
import { buildTools } from "@/lib/tools/tools";
import { isAnonymousOperation, isEntryRequest } from "@/lib/auth/request-policy";
import { AUTH_SECURITY } from "./openapi-auth";

type Schema = { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
const document = () => buildOpenApiDocument() as unknown as { components: { schemas: Record<string, Schema> } };

/** Every reference to the two person shapes, by where it sits. */
function personReferences(): Record<string, string[]> {
  const found: Record<string, string[]> = { ResourceOwner: [], Person: [] };
  const walk = (value: unknown, at: string[]) => {
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, [...at, String(index)])); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(value)) {
      const name = key === "$ref" && typeof inner === "string" ? inner.replace("#/components/schemas/", "") : null;
      if (name && name in found) found[name].push(at.join("/"));
      walk(inner, [...at, key]);
    }
  };
  walk(document(), []);
  return found;
}

it("draws every face from the person shape and keeps the runner a plain owner label", () => {
  expect(personReferences()).toEqual({
    ResourceOwner: ["components/schemas/RecipeStep/properties/output/properties/runner"],
    Person: [
      "components/schemas/DependencyDataset/properties/owner",
      "components/schemas/Recipe/properties/owner",
      "components/schemas/Table/properties/owner",
      "components/schemas/MapPresence/properties/owner",
      "components/schemas/Project/properties/owner",
      "components/schemas/Transfer/properties/owner",
      "components/schemas/TableCatalogue/properties/tables/items/properties/owner",
    ],
  });
});

it("adds only an optional picture version to the person shapes, and none to the words that name a person", () => {
  const schemas = document().components.schemas;
  expect(schemas.Person.required).toEqual(["name", "sqlName"]);
  expect(Object.keys(schemas.Person.properties!).sort()).toEqual(["name", "pictureVersion", "sqlName"]);
  expect(Object.keys(schemas.ResourceOwner.properties!).sort()).toEqual(["name", "sqlName"]);
  for (const name of ["Account", "DirectoryPerson", "ProjectPerson"]) {
    expect(schemas[name].properties, name).toHaveProperty("pictureVersion", expect.objectContaining({ type: "string" }));
    expect(schemas[name].required, name).not.toContain("pictureVersion");
  }
  expect(JSON.stringify(ACCOUNT_ACTOR_SCHEMA)).not.toContain("pictureVersion");
});

it("hands the version to an agent on every person read the tools answer", () => {
  const tools = buildTools();
  for (const name of ["get_account", "find_accounts", "list_project_people", "set_project_person", "remove_project_person",
    "get_map", "list_maps", "list_tables", "get_project", "list_projects", "transfer_project"]) {
    const tool = tools.find((candidate) => candidate.name === name);
    expect(tool, name).toBeDefined();
    expect(JSON.stringify(tool!.outputSchema), name).toContain("pictureVersion");
  }
});

it("names no picture in any answer a published visitor reads, and keeps the picture itself signed in", () => {
  const doc = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { responses?: unknown; security?: unknown[] }>> };
  const schemas = document().components.schemas as Record<string, unknown>;
  // Everything an answer's schema reaches, through its references.
  const reach = (value: unknown, seen = new Set<string>()): string => {
    const text = JSON.stringify(value) ?? "";
    for (const [, name] of text.matchAll(/"#\/components\/schemas\/([^"]+)"/g)) {
      if (!seen.has(name)) { seen.add(name); reach(schemas[name], seen); }
    }
    return text + [...seen].map((name) => JSON.stringify(schemas[name])).join("");
  };
  let anonymous = 0;
  for (const [template, operations] of Object.entries(doc.paths)) {
    const pathname = template.replace(/\{[^}]+\}/g, "fixture-id");
    for (const [method, operation] of Object.entries(operations)) {
      // Signing in answers the person's own account; every other anonymous
      // answer is what a published page's visitor can read.
      if (!isAnonymousOperation(pathname, method.toUpperCase()) || isEntryRequest(pathname, method.toUpperCase())) continue;
      anonymous++;
      expect(reach(operation.responses), `${method} ${template}`).not.toContain("pictureVersion");
    }
  }
  expect(anonymous).toBeGreaterThan(10);
  expect(isAnonymousOperation("/api/accounts/fixture-id/picture", "GET")).toBe(false);
  expect(doc.paths["/api/accounts/{sqlName}/picture"].get.security).toEqual(AUTH_SECURITY);
});
