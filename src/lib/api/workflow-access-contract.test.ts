import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";

it("publishes workflow reach, the reader's view in its home, parent references and caller-local output names", () => {
  const paths = ["/api/recipes", "/api/recipes/{id}", "/api/recipes/{id}/duplicate", "/api/recipes/{id}/dependencies",
    "/api/recipes/{id}/layout", "/api/recipes/{id}/steps", "/api/recipes/{id}/steps/{stepId}",
    "/api/recipes/{id}/steps/{stepId}/proposal", "/api/recipes/{id}/steps/{stepId}/move"];
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { description: string; responses: Record<string, unknown> }>> };
  let count = 0;
  for (const path of paths) for (const operation of Object.values(document.paths[path])) {
    expect(operation.description).toContain("A workflow is reached by its owner and, while it is filed in a project, by that project's owner and people");
    expect(operation.description).toContain("read in that home within the caller's own reach");
    expect(operation.description).toContain("anyone but the owner saves into a step must name only datasets within their own reach in the workflow's home, the workflow's declared outputs aside");
    expect(operation.description).not.toContain("private to the authenticated account");
    expect(operation.description).not.toContain("Every recipe in the workspace");
    expect(operation.description).toContain("A step's declared output name is taken when a dataset of that name is in the workflow's SQL home or in the declaring person's own space");
    expect(operation.description).toContain("duplicate-name allocation considers the duplicator's own datasets and workflows");
    expect(operation.description).not.toContain("consider only the caller's own datasets");
    expect(operation.responses).toHaveProperty("404"); count++;
  }
  expect(count).toBe(15);
  const tools = buildTools().filter(tool => paths.includes(tool.path)); expect(tools).toHaveLength(15);
  for (const tool of tools) {
    expect(tool.description).toContain("same-workflow conflict rules");
    expect(tool.inputSchema.properties).not.toHaveProperty("ownerId");
  }
});

it("lists every workflow the caller reaches", () => {
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { description: string }>> };
  expect(document.paths["/api/recipes"].get.description).toContain("Every recipe the caller reaches (their own, and every one filed in a project they own or belong to)");
});
