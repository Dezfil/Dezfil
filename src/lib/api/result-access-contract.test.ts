import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";

it("publishes account-bound result lifetime in the API and its generated tools", () => {
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { description: string; "x-tool": string | false; responses: unknown }>> };
  const tools = buildTools();
  for (const path of ["/api/maps/look", "/api/maps/look/{renderId}", "/api/maps/{id}/export/image", "/api/layers/{id}/export/{format}", "/api/query/export", "/api/projects/{id}/export"]) {
    for (const operation of Object.values(document.paths[path])) {
      expect(operation.description).toContain("initiating account through completion");
      expect(operation.description).toContain("even after the source or output is deleted");
      expect(operation.description).toContain("same refusal as an unknown identifier");
      expect(operation.responses).toHaveProperty("401");
      if (operation["x-tool"]) expect(tools.find(tool => tool.name === operation["x-tool"])?.description).toContain(operation.description);
    }
  }
  expect(document.paths["/api/assistant/runs/{id}"].get.description).toContain("deletion of any output");
});
