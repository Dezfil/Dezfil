import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { WORKED_EXAMPLES } from "@/lib/api/openapi-examples";
import { buildTools, deriveTools } from "./tools";

/**
 * The description's examples stay out of the tools derived from it: what a
 * tool says and takes is the same with every example and without one. The
 * MCP listing and the assistant's tool definitions as they stand are held
 * against committed captures by the assistant's unchanged-surface test;
 * this holds the derivation itself, so an example added later cannot reach
 * a tool either.
 */

type Document = ReturnType<typeof buildOpenApiDocument>;
type Holder = Record<string, unknown>;

/** The description with no example anywhere the standard places one: on a
 * parameter, and on the media types of a request body and a response. */
function withoutExamples(document: Document): Document {
  const copy = structuredClone(document);
  const strip = (holder: Holder | undefined) => { if (holder) { delete holder.example; delete holder.examples; } };
  for (const item of Object.values(copy.paths as Record<string, Record<string, Holder>>)) {
    for (const operation of Object.values(item)) {
      for (const parameter of (operation.parameters as Holder[] | undefined) ?? []) strip(parameter);
      for (const media of Object.values(((operation.requestBody as Holder | undefined)?.content as Record<string, Holder> | undefined) ?? {})) strip(media);
      for (const response of Object.values((operation.responses as Record<string, Holder> | undefined) ?? {})) {
        for (const media of Object.values((response.content as Record<string, Holder> | undefined) ?? {})) strip(media);
      }
    }
  }
  return copy;
}
const serialized = (document: Document) => JSON.stringify(deriveTools(document));
const counted = (document: Document) => JSON.stringify(document).split('"examples":').length - 1;

describe("examples stay out of the tools", () => {
  const document = buildOpenApiDocument();

  it("the tools are byte-equal with every example in the description and with none", () => {
    const bare = withoutExamples(document);
    expect(counted(document)).toBeGreaterThan(40);
    expect(counted(bare)).toBe(0);
    expect(serialized(bare)).toBe(serialized(document));
    expect(JSON.stringify(buildTools())).toBe(serialized(document));
  });

  it("the comparison sees an example placed where the tools read", () => {
    const leaked = structuredClone(document);
    const update = (leaked.paths["/api/maps/{id}"] as unknown as Record<string, { parameters: { name: string; schema: Holder }[] }>).patch;
    update.parameters.find((parameter) => parameter.name === "X-Edit-Revision")!.schema.examples = ["4f1c9a7e2b0d4c6e8a1f3b5d7c9e0a2b"];
    expect(serialized(withoutExamples(leaked))).not.toBe(serialized(document));
  });

  it("no tool carries the words or the values of a worked example", () => {
    const tools = serialized(document);
    for (const [key, named] of Object.entries(WORKED_EXAMPLES)) {
      for (const [name, example] of Object.entries(named)) {
        expect(tools.includes(example.summary), `${key} ${name} summary`).toBe(false);
        expect(tools.includes(example.description), `${key} ${name} description`).toBe(false);
      }
    }
    for (const value of ["world-cities.csv", "World cities", "Big cities", "Ana Diaz"]) expect(tools.includes(value), value).toBe(false);
  });
});
