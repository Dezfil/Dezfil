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
