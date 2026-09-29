import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";
it("publishes private workflow runs and their retained attempt lifecycle through every generated tool", () => {
  const paths = ["/api/recipes/{id}/runs", "/api/recipes/{id}/runs/{runId}", "/api/recipes/{id}/runs/{runId}/cancel", "/api/recipes/{id}/steps/{stepId}/run"];
  const doc = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { summary: string; description: string; responses: Record<string, unknown> }>> };
  const tools = buildTools().filter(tool => paths.includes(tool.path)); expect(tools).toHaveLength(5);
  for (const tool of tools) {
    const op = doc.paths[tool.path][tool.method.toLowerCase()];
    expect(op.description).toContain("Workflow plans, runs, member attempts and retained outputs are private");
    expect(op.description).toContain("after step or output deletion"); expect(op.responses).toHaveProperty("404");
    expect(tool.description).toBe(`${op.summary}. ${op.description}`); expect(tool.inputSchema.properties).not.toHaveProperty("ownerId");
  }
});
