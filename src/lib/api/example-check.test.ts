import { describe, expect, it } from "vitest";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { buildOpenApiDocument } from "./openapi";

/**
 * Every example in the description holds to the schema at its own place,
 * the worked examples and any other: a parameter's value to the
 * parameter's schema, a body to its request's, an answer to its
 * response's. A broken example fails here, named by operation, place and
 * example.
 */

type Json = Record<string, unknown>;
type Media = { schema?: unknown; example?: unknown; examples?: Record<string, { value?: unknown }> };
type Parameter = { name: string; schema?: unknown; example?: unknown; examples?: Record<string, { value?: unknown }> };
type Operation = { parameters?: Parameter[]; requestBody?: { content?: Record<string, Media> }; responses: Record<string, { content?: Record<string, Media> }> };
type Description = { paths: Record<string, Record<string, Operation>>; components: { schemas: Record<string, unknown> } };

const METHODS = ["get", "put", "post", "delete", "patch"];
const document = buildOpenApiDocument() as unknown as Description;

/** Every operation of a description, as `METHOD /path`. */
function operations(doc: Description): [string, Operation][] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    METHODS.filter((method) => item[method]).map((method) => [`${method.toUpperCase()} ${path}`, item[method]] as [string, Operation]));
}

/** Every example value at a place the standard gives examples: a
 * parameter, and the media types of a request body and of a response. */
function exampleValues(where: string, holder: { example?: unknown; examples?: Record<string, { value?: unknown }> }): [string, unknown][] {
  const found: [string, unknown][] = [];
  if ("example" in holder) found.push([where, holder.example]);
  for (const [name, example] of Object.entries(holder.examples ?? {})) found.push([`${where} example ${name}`, example.value]);
  return found;
}

/**
 * Each example, checked against the schema at its own place. A reference
 * resolves into the description's own components, carried as `$defs`, so
 * the check reads the schemas as the description states them and shares
 * no code with the tools' projection.
 */
function exampleProblems(doc: Description): string[] {
  const rewrite = (schema: unknown) => JSON.parse(JSON.stringify(schema).replaceAll('"#/components/schemas/', '"#/$defs/'));
  const defs = rewrite(doc.components.schemas);
  const problems: string[] = [];
  const check = (where: string, schema: unknown, value: unknown) => {
    if (schema === undefined) { problems.push(`${where}: an example where no schema is declared`); return; }
    const root = typeof schema === "boolean" ? schema : { ...rewrite(schema), $defs: defs };
    const result = fromJsonSchema(root as Parameters<typeof fromJsonSchema>[0])["~standard"].validate(value) as { issues?: { message: string; path?: unknown[] }[] };
    for (const issue of result.issues ?? []) problems.push(`${where}: ${issue.message}${issue.path?.length ? ` at ${JSON.stringify(issue.path)}` : ""}`);
  };
  for (const [key, operation] of operations(doc)) {
    for (const parameter of operation.parameters ?? []) {
      for (const [where, value] of exampleValues(`${key} parameter ${parameter.name}`, parameter)) check(where, parameter.schema, value);
    }
    for (const [type, media] of Object.entries(operation.requestBody?.content ?? {})) {
      for (const [where, value] of exampleValues(`${key} request ${type}`, media)) check(where, media.schema, value);
    }
    for (const [status, response] of Object.entries(operation.responses)) {
      for (const [type, media] of Object.entries(response.content ?? {})) {
        for (const [where, value] of exampleValues(`${key} ${status} ${type}`, media)) check(where, media.schema, value);
      }
    }
  }
  return problems;
}

describe("the examples in the description", () => {
  it("every example validates against the schema at its place", () => {
    expect(exampleProblems(document)).toEqual([]);
  });

  it("the check names an example that breaks its schema, at a parameter, a request and a response", () => {
    const seeded = structuredClone(document);
    const patch = seeded.paths["/api/maps/{id}"].patch;
    patch.parameters!.find((parameter) => parameter.name === "X-Edit-Revision")!.examples!.lightBasemap.value = "not-a-revision";
    (seeded.paths["/api/query"].post.requestBody!.content!["application/json"].examples!.quickstart.value as Json).sql = 42;
    delete (seeded.paths["/api/account/tokens"].post.responses["201"].content!["application/json"].examples!.quickstart.value as Json).secret;
    const problems = exampleProblems(seeded);
    expect(problems.some((problem) => problem.startsWith("PATCH /api/maps/{id} parameter X-Edit-Revision example lightBasemap"))).toBe(true);
    expect(problems.some((problem) => problem.startsWith("POST /api/query request application/json example quickstart"))).toBe(true);
    expect(problems.some((problem) => problem.startsWith("POST /api/account/tokens 201 application/json example quickstart"))).toBe(true);
    expect(problems).toHaveLength(3);
  });
});
