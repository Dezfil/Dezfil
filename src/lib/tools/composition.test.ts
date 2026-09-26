import { describe, expect, it, vi } from "vitest";

// Independent contract fixture, passed through the public tool derivation.
// No expected fields are computed by the resolver under test.
vi.mock("@/lib/api/openapi", () => ({
  buildOpenApiDocument: () => {
    const composed = {
      type: "object",
      properties: { sibling: { type: "string", minLength: 2 } },
      required: ["sibling"],
      allOf: [{
        type: "object",
        properties: { member: { type: "integer" } },
        required: ["member"],
      }],
    };
    const operation = (schema: unknown) => ({
      post: {
        "x-tool": "fixture_" + (++sequence),
        "x-tool-output": { envelope: "result-history" },
        responses: { "204": { description: "No content." } },
        summary: "Composition fixture",
        "x-effects": { readOnly: true, writes: [] },
        "x-mcp": { destructiveHint: false, openWorldHint: false, idempotentHint: true },
        // Every tool-generating operation declares its record words.
        "x-display": { verb: "Ran the composition fixture" },
        requestBody: { required: true, content: { "application/json": { schema } } },
      },
    });
    let sequence = 0;
    return {
      components: { schemas: { Composed: composed } },
      paths: {
        "/root": operation(composed),
        "/referenced-root": operation({ $ref: "#/components/schemas/Composed" }),
        "/nested": operation({
          type: "object",
          properties: { nested: composed },
          required: ["nested"],
        }),
        "/nested-reference": operation({
          type: "object",
          properties: { nested: { $ref: "#/components/schemas/Composed" } },
          required: ["nested"],
        }),
        "/array-reference": operation({
          type: "object",
          properties: { entries: { type: "array", items: { $ref: "#/components/schemas/Composed" } } },
          required: ["entries"],
        }),
      },
    };
  },
}));

import { buildTools } from "./tools";
import { executeTool } from "./execute";

const expectedObject = {
  type: "object",
  properties: {
    sibling: { type: "string", minLength: 2 },
    member: { type: "integer" },
  },
  required: expect.arrayContaining(["sibling", "member"]),
};

describe("object siblings survive composition", () => {
  for (const path of ["/root", "/referenced-root"]) {
    it(`retains own fields and requirements at ${path}, including the HTTP body`, async () => {
      const tool = buildTools().find((entry) => entry.path === path)!;
      expect(tool.inputSchema).toMatchObject(expectedObject);
      expect(tool.bodyKeys).toEqual(expect.arrayContaining(["sibling", "member"]));
      let submitted: unknown;
      const transport: typeof fetch = async (_url, init) => {
        submitted = JSON.parse(String(init?.body));
        return Response.json({ ok: true });
      };
      await executeTool(tool, { sibling: "kept", member: 7 }, "http://localhost", transport);
      expect(submitted).toEqual({ sibling: "kept", member: 7 });
    });
  }
  for (const path of ["/nested", "/nested-reference"]) {
    it(`retains own fields and requirements at ${path}`, () => {
      const tool = buildTools().find((entry) => entry.path === path)!;
      expect(tool.inputSchema.properties.nested).toMatchObject(expectedObject);
      expect(tool.inputSchema.required).toEqual(["nested"]);
    });
  }
  it("retains siblings inside a referenced array item", () => {
    const tool = buildTools().find((entry) => entry.path === "/array-reference")!;
    expect(tool.inputSchema.properties.entries).toMatchObject({ type: "array", items: expectedObject });
  });
});
