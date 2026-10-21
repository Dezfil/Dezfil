import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assistantAvailability } from "@/lib/assistant/config";
import { pageCalls } from "@/lib/test-support/page-calls";
import { buildOpenApiDocument } from "./openapi";
import { WORKED_EXAMPLES, withExamples } from "./openapi-examples";

/**
 * The worked examples the guides draw: one for every operation a guide
 * tells a reader to call, complete enough to send as it stands, and the
 * API quickstart's steps carried as one sequence whose values follow one
 * another, from the uploaded dataset to the published map.
 */

type Json = Record<string, unknown>;
type Media = { schema?: unknown; example?: unknown; examples?: Record<string, { value?: unknown; "x-filenames"?: Record<string, string> }> };
type Parameter = { name: string; in: string; required?: boolean; schema?: unknown; example?: unknown; examples?: Record<string, { value?: unknown }> };
/** A response; one without content holds its examples' words under `x-examples`. */
type Response = { content?: Record<string, Media>; "x-examples"?: Record<string, { summary?: string; description?: string }> };
type Operation = { parameters?: Parameter[]; requestBody?: { required?: boolean; content?: Record<string, Media> }; responses: Record<string, Response> };
type Description = { paths: Record<string, Record<string, Operation>>; components: { schemas: Record<string, unknown> } };

const METHODS = ["get", "put", "post", "delete", "patch"];
const document = buildOpenApiDocument() as unknown as Description;

/** Every operation of a description, as `METHOD /path`. */
function operations(doc: Description): [string, Operation][] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    METHODS.filter((method) => item[method]).map((method) => [`${method.toUpperCase()} ${path}`, item[method]] as [string, Operation]));
}

/** The API quickstart's steps, in order. */
const QUICKSTART = [
  "POST /api/auth/sign-in", "POST /api/account/tokens", "GET /api/maps", "POST /api/tables",
  "POST /api/query", "POST /api/maps", "POST /api/maps/{id}/layers", "POST /api/maps/{id}/publish",
];
/** The operations a page tells its reader to call in words, beside the
 * calls its code makes. */
const NAMED = [
  "GET /api/account/tokens", "DELETE /api/account/tokens/{id}",
  "GET /api/maps/{id}", "PATCH /api/maps/{id}", "DELETE /api/maps/{id}/publish",
  "GET /api/tables", "POST /api/query/export", "POST /api/operations/run",
  "GET /api/config", "GET /api/instance/settings", "GET /api/settings", "PATCH /api/settings",
  "DELETE /api/publications/{token}",
];
const lookup = (doc: Description, key: string) => {
  const [method, path] = key.split(" ");
  return doc.paths[path]?.[method.toLowerCase()];
};

/** A path a call names, as the description's path it matches: the path
 * itself, or the template with the fewest parameters that matches it. */
function described(doc: Description, path: string): string {
  if (doc.paths[path]) return path;
  const fits = Object.keys(doc.paths).filter((template) => template.includes("{") &&
    new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(path));
  fits.sort((a, b) => a.split("{").length - b.split("{").length);
  return fits[0] ?? `unknown ${path}`;
}

/** The operations a page's code calls, as `METHOD /path`: every curl
 * command, every fetch and every `request("METHOD", "/api/...")` call. A
 * part of a path a call fills in, such as `<MAP_ID>` or `${id}`, matches a
 * path parameter. */
function calledBy(text: string, doc: Description = document): string[] {
  const found = new Set<string>();
  const add = (method: string, path: string) => found.add(`${method} ${described(doc, path.replace(/\$\{[^}]+\}/g, "x").replace(/[?#].*$/, ""))}`);
  for (const block of pageCalls(text).blocks) {
    if (block.lang === "sh" || block.lang === "powershell") {
      for (const command of block.code.replace(/\\\n\s*/g, " ").split(/\n|\|/)) {
        const curl = /^\s*curl(?:\.exe)?\s(.*)$/.exec(command);
        const address = curl && /(?:https?:\/\/[^\s'"/]+|\$\{?\w+\}?)(\/api\/[^\s'"]*)/.exec(curl[1]);
        if (!address) continue;
        const method = /(?:-X|--request)\s+([A-Z]+)/.exec(curl[1])?.[1] ?? (/\s(?:-d|--data\S*|-F|--form)\s/.test(` ${curl[1]} `) ? "POST" : "GET");
        add(method, address[1]);
      }
    }
    if (block.lang === "js") {
      for (const call of block.code.matchAll(/fetch\(\s*[`"'][^`"']*?(\/api\/[^`"']*)[`"']\s*(?:,\s*\{([\s\S]*?)\}\);)?/g)) {
        add(/method:\s*"([A-Z]+)"/.exec(call[2] ?? "")?.[1] ?? "GET", call[1]);
      }
      for (const call of block.code.matchAll(/\brequest\(\s*"([A-Z]+)"\s*,\s*[`"'](\/api\/[^`"']*)[`"']/g)) add(call[1], call[2]);
    }
  }
  return [...found];
}

/** The pages that hold the writing rules: every page but those not yet
 * rewritten. */
const NOT_REWRITTEN = readFileSync("scripts/docs-not-rewritten.txt", "utf8").split("\n").filter((line) => line && !line.startsWith("#"));
const PAGES = execFileSync("git", ["ls-files", "docs"], { encoding: "utf8" }).split("\n")
  .filter((file) => file.endsWith(".md") && file !== "docs/README.md" && !NOT_REWRITTEN.includes(file));
/** The operations the documentation calls, in its code or in words. Each
 * carries a worked example in the description. */
const CALLED = [...new Set([...PAGES.flatMap((file) => calledBy(readFileSync(file, "utf8"))), ...NAMED])];

/** Whether an example named `name` is a success answer of a response: one
 * under a media type with its body, or, for a success that answers without
 * content, its words on the response itself. */
function answers(status: string, response: Response, name: string): boolean {
  if (!/^2\d\d$/.test(status)) return false;
  if (!response.content) return typeof response["x-examples"]?.[name]?.description === "string";
  return Object.values(response.content).some((media) => media.examples?.[name] && media.examples[name].value !== undefined);
}
/** What a worked example named `name` lacks on an operation: a value for
 * every path parameter, every required parameter and the edit revision; a
 * required body; and a success answer, with its media type and body, or
 * with its status alone where the success has no content. */
function incomplete(operation: Operation, name: string): string[] {
  const missing: string[] = [];
  for (const parameter of operation.parameters ?? []) {
    const wanted = parameter.in === "path" || parameter.required || parameter.name === "X-Edit-Revision";
    if (wanted && !parameter.examples?.[name]) missing.push(`parameter ${parameter.name}`);
  }
  if (operation.requestBody?.required && !Object.values(operation.requestBody.content ?? {}).some((media) => media.examples?.[name])) missing.push("request body");
  if (!Object.entries(operation.responses).some(([status, response]) => answers(status, response, name))) missing.push("success answer");
  return missing;
}
/** The names of an operation's examples that give a success answer. */
function successNames(operation: Operation): string[] {
  return Object.entries(operation.responses).filter(([status]) => /^2\d\d$/.test(status))
    .flatMap(([, response]) => response.content
      ? Object.values(response.content).flatMap((media) => Object.keys(media.examples ?? {}))
      : Object.keys(response["x-examples"] ?? {}));
}

describe("the worked examples in the description", () => {
  it("finds the operations a page calls in the page's own code", () => {
    expect(calledBy(readFileSync("docs/api/quickstart.md", "utf8")).sort()).toEqual([...QUICKSTART].sort());
    expect(CALLED.filter((key) => key.includes("unknown"))).toEqual([]);
    // A call a page adds is found, whatever form it takes.
    const added = '```sh title="Terminal"\ncurl -s -X DELETE http://localhost:3000/api/maps/<MAP_ID> \\\n  -H "X-Edit-Revision: <MAP_REVISION>"\n```\n\n' +
      '```js title="a.mjs"\nawait fetch(`${base}/api/layers/${id}`, {\n  method: "PATCH",\n  body: "{}",\n});\nawait request("GET", "/api/projects");\n```\n';
    expect(calledBy(added).sort()).toEqual(["DELETE /api/maps/{id}", "GET /api/projects", "PATCH /api/layers/{id}"]);
    // None of the three carries an example, so a page that called them would fail the next test.
    expect(calledBy(added).filter((key) => successNames(lookup(document, key)!).length > 0)).toEqual([]);
  });

  it("every operation the documentation calls carries a complete worked example", () => {
    for (const key of CALLED) {
      const operation = lookup(document, key);
      expect(operation, key).toBeDefined();
      const names = successNames(operation!);
      expect(names, `${key} has no worked example with a success answer`).not.toEqual([]);
      for (const name of names) expect(incomplete(operation!, name), `${key} example ${name}`).toEqual([]);
    }
    // The completeness rule fails an example that leaves the revision out,
    // and, for a success without content, one that leaves out the value it
    // sends or the words that say what it needs.
    const seeded = structuredClone(document);
    delete seeded.paths["/api/maps/{id}/layers"].post.parameters!.find((parameter) => parameter.name === "X-Edit-Revision")!.examples!.quickstart;
    expect(incomplete(seeded.paths["/api/maps/{id}/layers"].post, "quickstart")).toEqual(["parameter X-Edit-Revision"]);
    const revoke = seeded.paths["/api/publications/{token}"].delete;
    expect(revoke.responses["204"].content, "the revocation answers without content").toBeUndefined();
    expect(incomplete(revoke, "deactivatedOwner")).toEqual([]);
    delete revoke.parameters!.find((parameter) => parameter.name === "token")!.examples!.deactivatedOwner;
    delete revoke.responses["204"]["x-examples"]!.deactivatedOwner.description;
    expect(incomplete(revoke, "deactivatedOwner")).toEqual(["parameter token", "success answer"]);
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
    // The token a caller sends is the secret creating it answered; a second
    // token's secret is a new one, never the caller's own.
    expect(answer("POST /api/account/tokens", "201").secret).toBe("<YOUR_TOKEN>");
    const second = lookup(document, "POST /api/account/tokens")!.responses["201"].content!["application/json"].examples!.nightlyImport.value as Json;
    expect(second.secret).toBe("<NEW_TOKEN>");
  });

  it("the upload is the multipart form it is, carrying the bytes of the quickstart's file", () => {
    const upload = lookup(document, "POST /api/tables")!.requestBody!.content!["multipart/form-data"].examples!.quickstart;
    expect(upload["x-filenames"]).toEqual({ file: "world-cities.csv" });
    expect((upload.value as Json).file).toBe(readFileSync("e2e/fixtures/world-cities.csv", "utf8"));
  });

  it("building the description copies the examples, so a change to a built description never reaches them", () => {
    const held = new Set<object>();
    const gather = (value: unknown) => {
      if (!value || typeof value !== "object" || held.has(value)) return;
      held.add(value);
      Object.values(value).forEach(gather);
    };
    gather(WORKED_EXAMPLES);
    const shared: string[] = [];
    const visit = (value: unknown, at: string) => {
      if (!value || typeof value !== "object") return;
      if (held.has(value)) { shared.push(at); return; }
      for (const [key, item] of Object.entries(value)) visit(item, `${at}.${key}`);
    };
    visit(buildOpenApiDocument(), "description");
    expect(shared).toEqual([]);
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
        const response = operation.responses[example.response.status];
        const placed = example.response.mediaType === undefined ? response?.["x-examples"]?.[name] : response?.content?.[example.response.mediaType]?.examples?.[name];
        expect(placed, `${key} ${name}`).toBeDefined();
      }
    }
    // An answer without content is placed only where the status declares none.
    const bodyless = { "GET /api/health": { ready: { ...WORKED_EXAMPLES["GET /api/health"].ready, response: { status: "200" } } } };
    expect(() => withExamples(buildOpenApiDocument(), bodyless)).toThrow("declares no 200 answer without content");
  });

  it("the description file under docs/ carries the same examples", () => {
    const committed = JSON.parse(readFileSync("docs/api/openapi.json", "utf8")) as Description;
    for (const key of CALLED) expect(lookup(committed, key), key).toEqual(lookup(document, key));
  });
});
