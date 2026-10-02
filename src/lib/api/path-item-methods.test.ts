import { expect, it } from "vitest";
import { deriveApiMethods } from "@/lib/auth/api-methods";
import { withAutomaticMethods } from "./openapi-methods";
import { measureContract } from "../../../scripts/check-contract-docs.mjs";

const paths = { "/api/example": {
  summary: "Path summary",
  parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
  get: { tags: ["Example"], responses: { "200": { description: "Example", content: { "application/json": {} } } } },
} };
it("derives Allow from HTTP methods while ignoring path-level metadata", () => {
  expect(deriveApiMethods(paths)[0].methods).toEqual(["GET"]);
});
it("expands automatic methods and counts operations without treating metadata as methods", () => {
  // Path-item metadata is legal beside operation objects.
  const document = withAutomaticMethods({ paths });
  const item = document.paths["/api/example"];
  expect(item.summary).toBe("Path summary");
  expect(item.parameters).toEqual(paths["/api/example"].parameters);
  expect(deriveApiMethods(document.paths)[0].methods).toEqual(["GET", "HEAD", "OPTIONS"]);
  expect(item).toMatchObject({ options: { responses: { "204": { headers: { Allow: { schema: { const: "GET, HEAD, OPTIONS" } } } } } } });
  expect(item).not.toHaveProperty("head.responses.200.content");
  const measured = measureContract({ ...document, components: { schemas: {} }, "x-error-codes": {} }, []);
  expect(measured.operations).toBe(3);
  expect(paths["/api/example"]).not.toHaveProperty("head");
});
