import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";

it("publishes dataset reach, the reader's name for a dataset and the absent-resource response in every affected operation and tool", () => {
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { description: string; responses: Record<string, unknown> }>> };
  const paths = ["/api/tables", "/api/tables/{name}", "/api/tables/{name}/features", "/api/tables/{name}/export", "/api/tables/{name}/refresh",
    "/api/catalogue/tables", "/api/tables/{name}/geometry", "/api/tables/{name}/geometry/preview",
    "/api/maps/{id}/sketches", "/api/sketches/{name}", "/api/sketches/{name}/features", "/api/sketches/{name}/features/{featureId}",
    "/api/imports/url", "/api/imports/osm", "/api/imports/overture", "/api/imports/postgis"];
  let count = 0;
  for (const path of paths) for (const operation of Object.values(document.paths[path])) {
    expect(operation.description, path).toContain("A dataset is reached by its owner and by the owner and people of every project it is filed in.");
    expect(operation.description, path).toContain("<sql name>.<name> for another owner's");
    expect(operation.description, path).toContain("Datasets change, refresh and go only by their owner");
    expect(operation.description, path).not.toContain("resolve only in the authenticated account's space");
    expect(operation.responses, path).toHaveProperty("404"); count++;
  }
  expect(count).toBe(23);
  const tools = buildTools().filter(tool => paths.includes(tool.path));
  expect(tools).toHaveLength(22);
  for (const tool of tools) {
    expect(tool.description, tool.name).toContain("Unreached and missing datasets, maps and project references return not_found");
    expect(tool.inputSchema.properties, tool.name).not.toHaveProperty("ownerId");
    expect(tool.inputSchema.properties, tool.name).not.toHaveProperty("owner_id");
  }
});

it("documents the owner and the reader's name on every dataset listing, read and catalogue entry", () => {
  const schemas = buildOpenApiDocument().components.schemas as unknown as Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
  expect(Object.keys(schemas.Table.properties!)).toEqual(expect.arrayContaining(["qualifiedName", "owner"]));
  expect(schemas.DependencyDataset.required).toEqual(expect.arrayContaining(["qualifiedName", "owner"]));
  const catalogue = schemas.TableCatalogue.properties!.tables as { items: { required: string[] } };
  expect(catalogue.items.required).toEqual(expect.arrayContaining(["qualifiedName", "owner"]));
  for (const name of ["list_tables", "inspect_table", "read_table_catalogue", "get_map_dependencies"]) {
    expect(JSON.stringify(buildTools().find(tool => tool.name === name)!.outputSchema), name).toContain("qualifiedName");
  }
  const parameters = (buildOpenApiDocument() as unknown as { paths: Record<string, { get: { parameters: { name: string; description: string }[] } }> })
    .paths["/api/catalogue/tables"].get.parameters;
  expect(parameters.find(p => p.name === "after")!.description).toContain("qualifiedName cursor");
});
