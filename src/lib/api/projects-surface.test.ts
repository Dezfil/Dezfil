import { describe, it, expect } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";

/**
 * The published surface of.
 *
 * **This inventory is the completeness check, and parity is not** — parity
 * compares implemented routes to documented ones, so a capability missing
 * from *both* stays green through all its sweeps (the recipe-surface
 * precedent). Every row is a promise the spec makes in prose, typed by
 * hand so the check stays falsifiable.
 */

interface Capability {
  promise: string;
  method: string;
  path: string;
  tool: string;
}

const PROMISED: Capability[] = [
  { promise: "listing projects with counts and size", method: "get", path: "/api/projects", tool: "list_projects" },
  { promise: "creating a project, optionally with initial members", method: "post", path: "/api/projects", tool: "create_project" },
  { promise: "reading a project", method: "get", path: "/api/projects/{id}", tool: "get_project" },
  { promise: "renaming a project or editing its note", method: "patch", path: "/api/projects/{id}", tool: "update_project" },
  { promise: "deleting a project (dissolve, not destroy)", method: "delete", path: "/api/projects/{id}", tool: "delete_project" },
  { promise: "reading a project's members", method: "get", path: "/api/projects/{id}/members", tool: "get_project_members" },
  { promise: "one atomic membership change", method: "patch", path: "/api/projects/{id}/members", tool: "update_project_members" },
];

/** The listings the spec scopes and the creations it files: each must document the parameter or body field. */
const SCOPED_LISTINGS = ["/api/maps", "/api/tables", "/api/recipes"];
const FILED_CREATIONS = ["/api/maps", "/api/recipes"];

type Operation = {
  description?: string;
  "x-tool"?: string | false;
  "x-confirm"?: boolean | string;
  parameters?: { name: string; in: string }[];
  requestBody?: {
    content?: Record<
      string,
      { schema?: { properties?: Record<string, unknown> } }
    >;
  };
};

const WORKFLOW_PROJECT_RULE =
  "Only workflows can be project members.";

function operation(path: string, method: string): Operation {
  const doc = buildOpenApiDocument() as {
    paths: Record<string, Record<string, Operation>>;
  };
  const op = doc.paths[path]?.[method];
  expect(op, `${method.toUpperCase()} ${path} must be documented`).toBeDefined();
  return op;
}

describe("the projects surface", () => {
  it("documents every promised capability with its tool name", () => {
    const tools = new Map(buildTools().map((t) => [t.name, t]));
    for (const cap of PROMISED) {
      const op = operation(cap.path, cap.method);
      expect(op["x-tool"], `${cap.promise}`).toBe(cap.tool);
      expect(tools.has(cap.tool), `tool ${cap.tool} must exist`).toBe(true);
    }
  });

  it("marks deletion as requiring confirmation", () => {
    expect(operation("/api/projects/{id}", "delete")["x-confirm"]).toBe(true);
    expect(buildTools().find((t) => t.name === "delete_project")?.confirm).toBe(
      true,
    );
  });

  it("documents the project scope on all three listings, as a tool input", () => {
    for (const path of SCOPED_LISTINGS) {
      const params = operation(path, "get").parameters ?? [];
      expect(
        params.some((p) => p.name === "project" && p.in === "query"),
        `${path} must take ?project=`,
      ).toBe(true);
    }
    for (const tool of ["list_maps", "list_tables", "list_recipes"]) {
      const def = buildTools().find((t) => t.name === tool);
      expect(
        def?.queryParams.includes("project"),
        `${tool} must accept project`,
      ).toBe(true);
    }
  });

  it("documents the filed-creation context on map and workflow creation", () => {
    for (const path of FILED_CREATIONS) {
      const body = operation(path, "post").requestBody?.content?.[
        "application/json"
      ]?.schema?.properties;
      expect(body?.projectId, `${path} POST must take projectId`).toBeDefined();
    }
  });

  it("documents the import context on all five roads", () => {
    for (const path of [
      "/api/imports/url",
      "/api/imports/overture",
      "/api/imports/osm",
      "/api/imports/postgis",
    ]) {
      const props = operation(path, "post").requestBody?.content?.[
        "application/json"
      ]?.schema?.properties;
      expect(props?.projectId, `${path} must take projectId`).toBeDefined();
    }
    const params = operation("/api/tables", "post").parameters ?? [];
    expect(
      params.some((p) => p.name === "project" && p.in === "query"),
      "the upload road takes ?project=",
    ).toBe(true);
  });

  it("documents the membership fields on the three response shapes", () => {
    const doc = buildOpenApiDocument() as {
      components: {
        schemas: Record<
          string,
          {
            properties?: Record<string, unknown>;
            allOf?: { properties?: Record<string, unknown> }[];
          }
        >;
      };
    };
    const schemas = doc.components.schemas;
    expect(schemas.Recipe.properties?.projectId).toBeDefined();
    expect(schemas.Table.properties?.projectIds).toBeDefined();
    const overviewExtension = schemas.MapOverview.allOf?.find(
      (part) => part.properties,
    );
    expect(overviewExtension?.properties?.projectId).toBeDefined();
    expect(schemas.Project).toBeDefined();
    expect(schemas.ProjectMembers).toBeDefined();
    expect(schemas.ProjectMemberChange).toBeDefined();
  });

  it("defines project workflows as workflow-origin recipes across the reads", () => {
    for (const [path, method] of [
      ["/api/projects", "get"],
      ["/api/projects/{id}", "get"],
      ["/api/projects/{id}/members", "get"],
    ]) {
      expect.soft(operation(path, method).description, `${method} ${path}`).toContain(
        "workflow-origin recipes",
      );
    }
  });

  it("documents the builder-origin refusal on all three filing roads and their generated tools", () => {
    for (const [path, method, toolName] of [
      ["/api/projects", "post", "create_project"],
      ["/api/projects/{id}/members", "patch", "update_project_members"],
      ["/api/recipes", "post", "create_recipe"],
    ]) {
      expect.soft(operation(path, method).description, `${method} ${path}`).toContain(
        WORKFLOW_PROJECT_RULE,
      );
      expect.soft(
        buildTools().find((tool) => tool.name === toolName)?.description,
        toolName,
      ).toContain(WORKFLOW_PROJECT_RULE);
    }
  });

  it("keeps the project recipe field shapes while documenting their origin rule", () => {
    const schemas = (buildOpenApiDocument() as {
      components: {
        schemas: Record<
          string,
          {
            properties?: Record<string, { description?: string }>;
          }
        >;
      };
    }).components.schemas;
    expect(Object.keys(schemas.Project.properties ?? {})).toContain("recipeCount");
    // The shapes, not only the names: the members read still
    // points at the recipe list and the count is still an integer.
    expect(
      (schemas.ProjectMembers.properties?.recipes as unknown as { $ref?: string } | undefined)?.$ref,
    ).toBe("#/components/schemas/RecipeList");
    expect(
      (schemas.Project.properties?.recipeCount as unknown as { type?: string } | undefined)?.type,
    ).toBe("integer");
    expect(Object.keys(schemas.ProjectMembers.properties ?? {})).toEqual([
      "maps",
      "recipes",
      "tables",
    ]);
    expect(Object.keys(schemas.ProjectMemberChange.properties ?? {})).toEqual([
      "addMaps",
      "removeMaps",
      "addRecipes",
      "removeRecipes",
      "addTables",
      "removeTables",
    ]);
    expect.soft(schemas.Project.properties?.recipeCount?.description).toContain(
      "workflow-origin recipes",
    );
    expect.soft(schemas.ProjectMembers.properties?.recipes?.description).toContain(
      "workflow-origin recipes",
    );
    expect
      .soft(schemas.ProjectMemberChange.properties?.addRecipes?.description)
      .toContain(WORKFLOW_PROJECT_RULE);
  });
});
