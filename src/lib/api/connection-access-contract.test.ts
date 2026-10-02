import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";

it("publishes connection ownership and refusal before secrets, source contact and health writes", () => {
  const paths = ["/api/connections/postgis", "/api/connections/postgis/{id}", "/api/connections/postgis/{id}/test",
    "/api/connections/postgis/{id}/tables", "/api/connections/postgis/{id}/preview", "/api/connections/postgis/{id}/snapshots", "/api/imports/postgis"];
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { description: string; responses: Record<string, unknown> }>> };
  let count = 0;
  for (const path of paths) for (const operation of Object.values(document.paths[path])) {
    expect(operation.description).toContain("Connections are private to the authenticated account");
    expect(operation.description).toContain("before reading credentials, contacting the source or changing stored health");
    expect(operation.description).toContain("A project grant never reaches a connection");
    expect(operation.description).toContain("no operation transfers a connection");
    expect(operation.responses).toHaveProperty("404"); count++;
  }
  expect(count).toBe(9);
  const tools = buildTools().filter(tool => paths.includes(tool.path));
  expect(tools).toHaveLength(9);
  for (const tool of tools) {
    expect(tool.description).toContain("Connections are private to the authenticated account");
    expect(tool.inputSchema.properties).not.toHaveProperty("ownerId");
  }
});

it("states a shared snapshot's boundary on every dataset operation and on its source name", () => {
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { description: string }>>;
    components: { schemas: Record<string, { properties?: Record<string, { description?: string }> }> } };
  for (const path of ["/api/tables", "/api/tables/{name}", "/api/catalogue/tables"]) {
    expect(document.paths[path].get.description, path).toContain("a PostGIS snapshot shows its origin kind, with neither its connection nor its remote schema and table");
  }
  const table = Object.values(document.components.schemas).find((schema) => schema.properties?.sourceFilename && schema.properties?.qualifiedName)!;
  expect(table.properties!.sourceFilename.description).toContain("to anyone but its owner, for a PostGIS snapshot");
});
