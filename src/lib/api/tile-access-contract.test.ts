import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";
it("describes private tile work and token-bound publication without widening the generated input", () => {
  const doc = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { summary: string; description: string }>> };
  for (const path of ["/api/layers/{id}/render", "/api/layers/{id}/tiles/{z}/{x}/{y}"]) for (const op of Object.values(doc.paths[path])) {
    expect(op.description).toContain("Private render results, tile status and archive bytes follow the layer's map owner");
    expect(op.description).toContain("a revoked token cannot authorize a new archive");
  }
  const tool = buildTools().find(tool => tool.name === "render_layer")!; const op = doc.paths[tool.path].get;
  expect(tool.description).toBe(`${op.summary}. ${op.description}`); expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(["id"]);
});
