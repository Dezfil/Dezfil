import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";
import { isAnonymousOperation } from "@/lib/auth/request-policy";
it("exposes a narrow authenticated revocation with identity-only confirmation and generated consequences", () => {
  const operation = buildOpenApiDocument().paths["/api/publications/{token}"].delete;
  const tool = buildTools().find(tool => tool.name === "revoke_inactive_publication")!;
  expect(tool.path).toBe("/api/publications/{token}"); expect(tool.method).toBe("delete");
  expect(tool.effects).toMatchObject({ readOnly: false, writes: [{ resource: "publications", argument: "token" }] });
  expect(tool.mcp).toMatchObject({ destructiveHint: true, openWorldHint: false, idempotentHint: true });
  expect(tool.confirm).toBe(true); expect(tool.confirmation?.subject.path).toBeNull();
  expect(tool.description).toContain("never reads or returns private map content");
  expect(tool.description).toContain("same transaction as current admin authority");
  expect(operation.security).not.toEqual([]); expect(isAnonymousOperation(tool.path, "DELETE")).toBe(false);
  expect(operation.responses).toHaveProperty("204"); expect(operation.responses).toHaveProperty("404");
});
it("documents owner and pending-adoption query scopes without widening the anonymous operation set", () => {
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { description: string }>> };
  for (const [path, methods] of Object.entries(document.paths).filter(([path]) => path.startsWith("/api/published/"))) {
    for (const [method, operation] of Object.entries(methods)) {
      expect(operation.description).toContain("pending-adoption publication scope");
      expect(operation.description).toContain("including while the owner is deactivated");
      expect(operation.description).toContain("restricted to the datasets the map's own layers name: nothing else of the owner's space is mounted for the link");
      expect(operation.description).toContain("fails with catalogue_not_published while the owner holds datasets the map does not name");
      expect(isAnonymousOperation(path, method.toUpperCase())).toBe(true);
    }
  }
});
it("catalogues the published link's catalogue refusal with its reason", () => {
  const document = buildOpenApiDocument() as unknown as { "x-error-codes": Record<string, string>; components: { schemas: { Error: { properties: { error: { properties: { code: { enum: string[] } } } } } } } };
  expect(document["x-error-codes"].catalogue_not_published).toContain("a published map reaches only the datasets its own layers name");
  expect(document.components.schemas.Error.properties.error.properties.code.enum).toContain("catalogue_not_published");
});
it("documents a publication's token as the map owner's alone, on every map read and the publication state", () => {
  const schemas = buildOpenApiDocument().components.schemas as unknown as Record<string, { properties: Record<string, { type?: unknown; description?: string }> }>;
  expect(schemas.Map.properties.published).toMatchObject({ type: "boolean" });
  expect(schemas.Map.properties.publishToken.description).toContain("the map owner's alone: null to anyone else who reaches the map");
  expect(schemas.PublicationState.properties.token.description).toContain("the map owner's alone: absent for anyone else who reaches the map");
  for (const name of ["get_map", "list_maps", "get_publication_state"]) {
    expect(JSON.stringify(buildTools().find(tool => tool.name === name)!.outputSchema), name).toContain("the map owner's alone");
  }
});
