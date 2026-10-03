import { resourceOperations } from "../../../test-support/api-route-inventory";
import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { AUTH_SECURITY } from "./openapi-auth";

it("documents authentication and private refusals on every MCP and assistant transport", () => {
  const doc = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { security: unknown; description: string; responses: unknown; "x-tool": unknown }>> };
  const paths = Object.entries(doc.paths).filter(([path]) => path === "/api/mcp" || path.startsWith("/api/assistant"));
  expect(paths).toHaveLength(8);
  for (const [, methods] of paths) for (const operation of resourceOperations(methods)) {
    expect(operation.security).toEqual(AUTH_SECURITY);
    expect(operation["x-tool"]).toBe(false);
    expect(operation.description).toContain("private, no-store");
    expect(operation.responses).toHaveProperty("401"); expect(operation.responses).toHaveProperty("403");
  }
});
it("documents account-bound recovery and freshly authorized confirmation", () => {
  const doc = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { description: string }>> };
  expect(doc.paths["/api/assistant/runs"].post.description).toContain("bound to the authenticated account");
  expect(doc.paths["/api/assistant/pending"].get.description).toContain("only the caller");
  expect(doc.paths["/api/assistant/messages"].post.description).toContain("reauthenticates that same account");
  expect(doc.paths["/api/assistant/messages"].post.description).toContain("No credential is retained");
});
