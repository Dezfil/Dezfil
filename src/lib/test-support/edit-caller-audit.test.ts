import { expect, it } from "vitest";
import { auditSource, auditCheckout } from "../../../scripts/audit-edit-callers.mjs";

it("finds inline browser fetches, request contexts, helper calls and direct services", () => {
  const rows = auditSource("e2e/example.spec.ts", `
    await page.evaluate(async id => fetch(\`/api/layers/\${id}\`, {method: 'DELETE'}), id);
    await context.request.patch('/api/maps/m', {data: {name: 'new'}});
    await api(page, 'POST', '/api/recipes/r/steps', {});
    await updateMap(scope, id, {name: 'new'});
  `);
  expect(rows.map((row: { method: string }) => row.method)).toEqual(["DELETE", "PATCH", "POST", "service"]);
});

it("audits the whole browser and service tree, including setup and non-core suites", async () => {
  const result = await auditCheckout(process.cwd());
  const files = new Set(result.calls.map((row: { file: string }) => row.file));
  for (const file of ["e2e/workflow-results.spec.ts", "e2e/assistant-record.spec.ts", "e2e/grantee-world.spec.ts", "e2e/support.ts", "scripts/journey.mjs", "src/lib/map-preconditions.test.ts"]) {
    expect(files.has(file), file).toBe(true);
  }
  expect(result.scanned.browser).toBeGreaterThan(100);
});
