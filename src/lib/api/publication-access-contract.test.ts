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
      expect(isAnonymousOperation(path, method.toUpperCase())).toBe(true);
    }
  }
});
