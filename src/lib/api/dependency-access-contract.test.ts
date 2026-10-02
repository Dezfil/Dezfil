import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";
it("publishes dependency identity under reach and generated tool parity", () => {
  const paths = ["/api/maps/{id}/dependencies", "/api/recipes/{id}/dependencies"];
  const document = buildOpenApiDocument() as unknown as { paths: Record<string, { get: { summary: string; description: string; responses: Record<string, unknown> } }> };
  expect(document.paths["/api/maps/{id}/dependencies"].get.description).toContain("Each layer's references resolve to dataset identities in the map's SQL home within the caller's reach");
  expect(document.paths["/api/maps/{id}/dependencies"].get.description).toContain("a dataset the caller cannot reach is left out rather than named");
  const workflow = document.paths["/api/recipes/{id}/dependencies"].get.description;
  expect(workflow).toContain("Each step's references resolve to dataset identities in the workflow's SQL home within the caller's reach, the workflow's own outputs as the caller would run them");
  expect(workflow).toContain("every runner's recorded output of the workflow that the caller reaches");
  expect(workflow).not.toContain("resolve only within the authenticated account");
  expect(workflow).not.toContain("every current registered output of the workflow");
  for (const path of paths) {
    const description = document.paths[path].get.description;
    expect(description, path).toContain("Memberships name the projects the caller reaches, and on the caller's own datasets every project they are in, one the caller no longer reaches included; producers only workflows the caller reaches, each marked with whether the caller owns it.");
    expect(description, path).not.toContain("producers only the caller's own workflows");
  }
  for (const path of paths) expect(document.paths[path].get.responses).toHaveProperty("404");
  const tools = buildTools().filter(tool => paths.includes(tool.path)); expect(tools).toHaveLength(2);
  for (const tool of tools) {
    const operation = document.paths[tool.path].get;
    expect(tool.description).toBe(`${operation.summary}. ${operation.description}`);
  }
});
