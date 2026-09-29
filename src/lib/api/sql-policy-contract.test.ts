import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";
import { SQL_POLICY } from "./openapi-sql";
it("publishes file SQL withdrawal in the API and generated SQL tools", () => {
  expect(SQL_POLICY).toContain("File-referencing PROJ");
  const document = buildOpenApiDocument();
  expect(document.paths["/api/query"].post.description).toContain(SQL_POLICY);
  const tools = buildTools();
  expect(tools.find(tool => tool.name === "run_sql")?.description).toContain(SQL_POLICY);
  for (const name of ["run_sql", "export_sql_result", "create_layer", "update_layer"]) {
    const tool = tools.find(tool => tool.name === name);
    expect(tool, name).toBeDefined();
    expect(JSON.stringify(tool!.inputSchema), name).toContain("File readers");
    expect(JSON.stringify(tool!.inputSchema), name).toContain("sql_rejected");
  }
});
