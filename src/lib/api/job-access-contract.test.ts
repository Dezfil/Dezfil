import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";
it("publishes private jobs, account-local history and loss-of-activity settlement", () => {
  const paths = ["/api/operations/run", "/api/operations/runs", "/api/operations/runs/{id}", "/api/operations/runs/{id}/cancel", "/api/recipes/{id}/runs/{runId}/cancel"];
  const doc = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { description: string; responses: Record<string, unknown> }>> };
  for (const path of paths) for (const op of Object.values(doc.paths[path])) {
    expect(op.description).toContain("Run records and subject histories are private to their account"); expect(op.responses).toHaveProperty("404");
  }
  const tools = buildTools().filter(tool => paths.includes(tool.path)); expect(tools).toHaveLength(5);
  for (const tool of tools) { expect(tool.description).toContain("after output deletion"); expect(tool.inputSchema.properties).not.toHaveProperty("ownerId"); }
});
