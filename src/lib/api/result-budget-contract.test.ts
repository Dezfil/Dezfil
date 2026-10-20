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
  for (const file of ["docs/api/limits.md", "docs/api/http-api.md", "docs/api/mcp.md", "docs/self-host/configuration.md", "docs/self-host/what-leaves-the-instance.md"]) {
    const text = readFileSync(file, "utf8");
    expect(text, file).toContain("33,554,432"); expect(text, file).toContain("2,097,152");
    expect(text, file).toContain("query_result_too_large");
    for (const reader of file === "docs/api/mcp.md" ? ["run_sql", "inspect_table", "preview_table_geometry", "preview_postgis_relation"] : file === "docs/api/http-api.md" ? ["POST /api/query", "GET /api/tables/{name}", "POST /api/tables/{name}/geometry/preview", "POST /api/connections/postgis/{id}/preview"] : ["SQL console", "dataset inspection", "geometry-choice preview", "PostGIS five-row preview"]) expect(text, file).toContain(reader);
  }
});

it("names the inspection-dependent consumers in every affected guide", () => {
  for (const file of ["docs/api/limits.md", "docs/api/http-api.md", "docs/self-host/configuration.md", "docs/self-host/what-leaves-the-instance.md"]) {
    const text = readFileSync(file, "utf8").replace(/\s+/g, " ");
    for (const consumer of ["tool column pickers", "SQL schema inventory and completion", "workflow dataset reads and facts", "automatic layer addition after a tool run"]) {
      expect(text.includes(consumer), `${file}: ${consumer}`).toBe(true);
    }
    expect(text, file).toContain("the dataset has already been written");
    expect(text, file).toContain("Existing layer rendering");
  }
});

it("keeps result-budget commands and their outcomes in the probe's procedure beside its script", () => {
  const text = readFileSync("scripts/query-result-budget-probe.md", "utf8").split("# SQL result byte budget")[1] ?? "";
  for (const command of ["probe:query-result-budget", "e2e:result-budget", "geometry-latency.test.ts", "geometry-engine-budget.test.ts", "--observation-dir", "result-budget-image.sh"]) {
    expect(text.includes(command), command).toBe(true);
  }
  const words = /delegated (?:browser|runner)|supervising session|single observation/i;
  expect(text).not.toMatch(words);
  // The wording rule covers everything from this procedure on as it was
  // first written: the settings probe that followed it, now beside its own
  // script, and the template release section still at the end of Back up
  // and restore. Every one of those sections is read, wherever it lives.
  const page = readFileSync("docs/self-host/backup-and-restore.md", "utf8");
  const release = page.indexOf("## Shipping a template release");
  expect(release).toBeGreaterThan(-1);
  const after: [string, string][] = [["scripts/settings-probe.md", readFileSync("scripts/settings-probe.md", "utf8")], ["docs/self-host/backup-and-restore.md", page.slice(release)]];
  const headings = [text, ...after.map(([, part]) => part)].join("\n").split("\n").filter((line) => /^#{1,6} /.test(line)).map((line) => line.replace(/^#+ /, "").trim());
  for (const heading of ["Local regressions", "Served standalone probe", "Request markers", "Built image", "Browser flow", "Companion commands", "Settings persistence smoke probe", "Shipping a template release"]) {
    expect(headings, heading).toContain(heading);
  }
  for (const [file, part] of after) expect(part, file).not.toMatch(words);
  expect(readFileSync("docs/api/http-api.md", "utf8")).toContain("](../../scripts/query-result-budget-probe.md)");
});

it("distinguishes fixed result ceilings from engine-memory admission", () => {
  for (const file of ["docs/api/limits.md", "docs/self-host/configuration.md", "docs/self-host/what-leaves-the-instance.md"]) {
    const text = readFileSync(file, "utf8").replace(/\s+/g, " ");
    expect(text, file).toContain("Row and engine-memory limits still apply");
    expect(text, file).toContain("a result below both byte ceilings can fail the engine-memory limit");
    expect(text, file).not.toContain("independent of row and engine-memory limits");
  }
});
