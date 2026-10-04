import { expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { ERROR_CATALOGUE } from "./error-catalogue";

it("documents all four bounded reader operations with fixed binary-byte ceilings", () => {
  const doc = buildOpenApiDocument();
  for (const [path, method] of [
    ["/api/query", "post"], ["/api/tables/{name}", "get"],
    ["/api/tables/{name}/geometry/preview", "post"], ["/api/connections/postgis/{id}/preview", "post"],
  ] as const) {
    const operation = (doc.paths as Record<string, Record<string, { description: string; responses: Record<string, unknown> }>>)[path][method];
    expect(operation.description, path).toContain("33,554,432");
    expect(operation.description, path).toContain("2,097,152");
    expect(operation.description, path).toContain("query_result_too_large");
    expect(operation.responses["422"] ?? operation.responses.default, path).toMatchObject({ content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });
  }
  expect(ERROR_CATALOGUE.query_result_too_large).toBe("The result is too large to return: more than 32 MB in total, or one non-geometry value over 2 MB. Select fewer rows or columns, or shorten the value.");
  expect(doc.components.schemas.Error).toMatchObject({ properties: { error: { properties: { code: { enum: expect.arrayContaining(["query_result_too_large"]) } } } } });
});

import { readFileSync } from "node:fs";
it("keeps the four-reader limits and refusal code in every operator guide", () => {
  for (const file of ["README.md", "docs/api.md", "docs/mcp.md", "docs/configuration.md", "docs/self-hosting.md"]) {
    const text = readFileSync(file, "utf8");
    expect(text, file).toContain("33,554,432"); expect(text, file).toContain("2,097,152");
    expect(text, file).toContain("query_result_too_large");
    for (const reader of file === "docs/mcp.md" ? ["run_sql", "inspect_table", "preview_table_geometry", "preview_postgis_relation"] : file === "docs/api.md" ? ["POST /api/query", "GET /api/tables/{name}", "POST /api/tables/{name}/geometry/preview", "POST /api/connections/postgis/{id}/preview"] : ["SQL console", "dataset inspection", "geometry-choice preview", "PostGIS five-row preview"]) expect(text, file).toContain(reader);
  }
});

it("names the inspection-dependent consumers in every affected guide", () => {
  for (const file of ["README.md", "docs/api.md", "docs/configuration.md", "docs/self-hosting.md"]) {
    const text = readFileSync(file, "utf8").replace(/\s+/g, " ");
    for (const consumer of ["tool column pickers", "SQL schema inventory and completion", "workflow dataset reads and facts", "automatic layer addition after a tool run"]) {
      expect(text.includes(consumer), `${file}: ${consumer}`).toBe(true);
    }
    expect(text, file).toContain("the dataset has already been written");
    expect(text, file).toContain("Existing layer rendering");
  }
});

it("keeps result-budget commands and their outcomes in the runbook", () => {
  const text = readFileSync("docs/runbook.md", "utf8").split("## SQL result byte budget")[1] ?? "";
  for (const command of ["probe:query-result-budget", "e2e:result-budget", "geometry-latency.test.ts", "geometry-engine-budget.test.ts", "--observation-dir", "result-budget-image.sh"]) {
    expect(text.includes(command), command).toBe(true);
  }
  expect(text).not.toMatch(/delegated (?:browser|runner)|supervising session|single observation/i);
  expect(readFileSync("docs/api.md", "utf8")).toContain("runbook.md#sql-result-byte-budget");
});

it("distinguishes fixed result ceilings from engine-memory admission", () => {
  for (const file of ["README.md", "docs/configuration.md", "docs/self-hosting.md"]) {
    const text = readFileSync(file, "utf8").replace(/\s+/g, " ");
    expect(text, file).toContain("Row and engine-memory limits still apply");
    expect(text, file).toContain("a result below both byte ceilings can fail the engine-memory limit");
    expect(text, file).not.toContain("independent of row and engine-memory limits");
  }
});
