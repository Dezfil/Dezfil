import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assistantAvailability } from "@/lib/assistant/config";
import { buildOpenApiDocument } from "./openapi";
import { WORKED_EXAMPLES } from "./openapi-examples";

/**
 * The worked examples the guides draw: one for every operation a guide
 * tells a reader to call, complete enough to send as it stands, and the
 * API quickstart's steps carried as one sequence whose values follow one
 * another, from the uploaded dataset to the published map.
 */

type Json = Record<string, unknown>;
type Media = { schema?: unknown; example?: unknown; examples?: Record<string, { value?: unknown; "x-filenames"?: Record<string, string> }> };
type Parameter = { name: string; in: string; required?: boolean; schema?: unknown; example?: unknown; examples?: Record<string, { value?: unknown }> };
type Operation = { parameters?: Parameter[]; requestBody?: { required?: boolean; content?: Record<string, Media> }; responses: Record<string, { content?: Record<string, Media> }> };
type Description = { paths: Record<string, Record<string, Operation>>; components: { schemas: Record<string, unknown> } };

const METHODS = ["get", "put", "post", "delete", "patch"];
const document = buildOpenApiDocument() as unknown as Description;

/** Every operation of a description, as `METHOD /path`. */
function operations(doc: Description): [string, Operation][] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    METHODS.filter((method) => item[method]).map((method) => [`${method.toUpperCase()} ${path}`, item[method]] as [string, Operation]));
}

/** The operations the documentation calls, the API quickstart's steps
 * first. Each carries a worked example in the description. */
const QUICKSTART = [
  "POST /api/auth/sign-in", "POST /api/account/tokens", "GET /api/maps", "POST /api/tables",
  "POST /api/query", "POST /api/maps", "POST /api/maps/{id}/layers", "POST /api/maps/{id}/publish",
];
const CALLED = [
  ...QUICKSTART,
  "GET /api/account", "GET /api/account/tokens", "DELETE /api/account/tokens/{id}",
  "GET /api/maps/{id}", "PATCH /api/maps/{id}", "DELETE /api/maps/{id}/publish",
  "GET /api/tables", "POST /api/query/export", "POST /api/operations/run", "GET /api/catalogue/tables",
  "POST /api/mcp", "GET /api/openapi.json", "GET /api/health", "GET /api/config", "GET /api/assistant",
  "GET /api/instance/settings", "PATCH /api/instance/settings", "GET /api/settings", "PATCH /api/settings",
];
const lookup = (doc: Description, key: string) => {
  const [method, path] = key.split(" ");
  return doc.paths[path]?.[method.toLowerCase()];
};

/** What a worked example named `name` lacks on an operation: a value for
 * every path parameter, every required parameter and the edit revision; a
 * required body; and a success answer, with its media type and body. */
function incomplete(operation: Operation, name: string): string[] {
  const missing: string[] = [];
  for (const parameter of operation.parameters ?? []) {
    const wanted = parameter.in === "path" || parameter.required || parameter.name === "X-Edit-Revision";
    if (wanted && !parameter.examples?.[name]) missing.push(`parameter ${parameter.name}`);
  }
  if (operation.requestBody?.required && !Object.values(operation.requestBody.content ?? {}).some((media) => media.examples?.[name])) missing.push("request body");
  const answered = Object.entries(operation.responses).some(([status, response]) => /^2\d\d$/.test(status) &&
    Object.values(response.content ?? {}).some((media) => media.examples?.[name] && media.examples[name].value !== undefined));
  if (!answered) missing.push("success answer");
  return missing;
}
/** The names of an operation's examples that give a success answer. */
function successNames(operation: Operation): string[] {
  return Object.entries(operation.responses).filter(([status]) => /^2\d\d$/.test(status))
    .flatMap(([, response]) => Object.values(response.content ?? {}).flatMap((media) => Object.keys(media.examples ?? {})));
}

describe("the worked examples in the description", () => {
  it("every operation the documentation calls carries a complete worked example", () => {
    for (const key of CALLED) {
      const operation = lookup(document, key);
      expect(operation, key).toBeDefined();
      const names = successNames(operation!);
      expect(names, `${key} has no worked example with a success answer`).not.toEqual([]);
      for (const name of names) expect(incomplete(operation!, name), `${key} example ${name}`).toEqual([]);
    }
    // The completeness rule fails an example that leaves the revision out.
    const seeded = structuredClone(document);
    delete seeded.paths["/api/maps/{id}/layers"].post.parameters!.find((parameter) => parameter.name === "X-Edit-Revision")!.examples!.quickstart;
    expect(incomplete(seeded.paths["/api/maps/{id}/layers"].post, "quickstart")).toEqual(["parameter X-Edit-Revision"]);
  });

  it("every step of the API quickstart has an example named quickstart, and their values follow one another", () => {
    for (const key of QUICKSTART) expect(successNames(lookup(document, key)!), key).toContain("quickstart");
    const answer = (key: string, status: string) => lookup(document, key)!.responses[status].content!["application/json"].examples!.quickstart.value as Json;
    const sent = (key: string, name: string) => lookup(document, key)!.parameters!.find((parameter) => parameter.name === name)!.examples!.quickstart.value;
    const map = answer("POST /api/maps", "201"), layer = answer("POST /api/maps/{id}/layers", "201");
    expect(sent("POST /api/maps/{id}/layers", "id")).toBe(map.id);
    expect(sent("POST /api/maps/{id}/layers", "X-Edit-Revision")).toBe(map.editRevision);
    expect(sent("POST /api/maps/{id}/publish", "id")).toBe(map.id);
    expect(sent("POST /api/maps/{id}/publish", "X-Edit-Revision")).toBe(layer.editRevision);
    expect(layer.mapId).toBe(map.id);
    const uploaded = answer("POST /api/tables", "201");
    const query = (lookup(document, "POST /api/query")!.requestBody!.content!["application/json"].examples!.quickstart.value as Json).sql as string;
    expect(query).toContain(`FROM ${uploaded.name}`);
    expect(layer.sql).toContain(`FROM ${uploaded.name}`);
    // The token a caller sends is the secret creating it answered.
    expect(answer("POST /api/account/tokens", "201").secret).toBe("<YOUR_TOKEN>");
  });

  it("the upload is the multipart form it is, carrying the bytes of the quickstart's file", () => {
    const upload = lookup(document, "POST /api/tables")!.requestBody!.content!["multipart/form-data"].examples!.quickstart;
    expect(upload["x-filenames"]).toEqual({ file: "world-cities.csv" });
    expect((upload.value as Json).file).toBe(readFileSync("e2e/fixtures/world-cities.csv", "utf8"));
  });

  it("every body with a byte limit names the code a larger one is refused with", () => {
    const limited = operations(document).filter(([, operation]) => (operation.requestBody as Json | undefined)?.["x-byte-limit"] !== undefined);
    expect(limited.length).toBeGreaterThan(50);
    for (const [key, operation] of limited) {
      const body = operation.requestBody as Json, code = body["x-byte-error"];
      expect(typeof code, key).toBe("string");
      expect((operation as unknown as Json).description, key).toContain(`\`${code}\``);
    }
  });

  it("the assistant's not-enabled example is what an instance without a provider key answers", () => {
    const notEnabled = lookup(document, "GET /api/assistant")!.responses["200"].content!["application/json"].examples!.notEnabled.value;
    expect(notEnabled).toEqual(assistantAvailability({}));
  });

  it("names only operations, parameters, statuses and media types the description declares", () => {
    for (const [key, named] of Object.entries(WORKED_EXAMPLES)) {
      const operation = lookup(document, key)!;
      for (const [name, example] of Object.entries(named)) {
        expect(operation.responses[example.response.status]?.content?.[example.response.mediaType]?.examples?.[name], `${key} ${name}`).toBeDefined();
      }
    }
  });

  it("the description file under docs/ carries the same examples", () => {
    const committed = JSON.parse(readFileSync("docs/api/openapi.json", "utf8")) as Description;
    for (const key of CALLED) expect(lookup(committed, key), key).toEqual(lookup(document, key));
  });
});
