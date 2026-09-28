import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { AUTH_SECURITY } from "./openapi-auth";

it("documents credential requirements and private responses for every image operation", () => {
  const doc = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { security: unknown; description: string; responses: unknown; "x-tool": string }>> };
  for (const [path, method, tool] of [["/api/maps/look", "post", "look_at_map"], ["/api/maps/look/{renderId}", "get", "read_map_look_image"], ["/api/maps/{id}/export/image", "post", "export_map_image"]]) {
    const operation = doc.paths[path][method];
    expect(operation.security).toEqual(AUTH_SECURITY); expect(operation["x-tool"]).toBe(tool);
    expect(operation.description).toContain("private, no-store");
    expect(operation.responses).toHaveProperty("401"); expect(operation.responses).toHaveProperty("403");
  }
});
