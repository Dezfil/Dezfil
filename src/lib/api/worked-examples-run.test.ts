import { afterEach, describe, expect, it } from "vitest";
import { laneSettled } from "@/lib/operations/lane";
import { ownInstance, type OwnInstance } from "@/lib/test-support/page-calls";
import { buildOpenApiDocument } from "./openapi";

/**
 * The worked examples of the served description, sent to an instance of
 * their own in the API quickstart's order and then the order of the guides
 * that follow it: each request is built from the example as the operation
 * reference draws it, and each answer must be the example's. An identifier,
 * a revision or a placeholder in an example stands for the value the
 * instance gave at that place first, and every later use must be that value;
 * a time stands for any time, and a field that varies by run for any value
 * of its type. Where an example's description says it is cut, only what it
 * shows is held. So an example stays what the instance answers, and a seeded
 * wrong one is named.
 */

const ADDRESS = "http://localhost:3000";
const READER = { name: "Ana Diaz", email: "ana@example.com", password: "field notebooks at dawn" };
/** The fields whose value differs from run to run. */
const VARIES = new Set(["runtimeMs"]);

type Example = { value?: unknown; "x-filenames"?: Record<string, string> };
type Media = { examples?: Record<string, Example> };
type Operation = {
  parameters?: { name: string; in: string; examples?: Record<string, Example> }[];
  requestBody?: { content?: Record<string, Media> };
  responses: Record<string, { content?: Record<string, Media> }>;
};
type Description = { paths: Record<string, Record<string, Operation>> };

const document = buildOpenApiDocument() as unknown as Description;
const lookup = (doc: Description, key: string): Operation => {
  const [method, path] = key.split(" ");
  return doc.paths[path][method.toLowerCase()];
};

/** The calls in the order they are sent: each operation, its example's
 * name, and how it signs in. */
const SEQUENCE: [key: string, name: string, how?: "cookie" | "mcp"][] = [
  ["POST /api/auth/sign-in", "quickstart"],
  ["POST /api/account/tokens", "quickstart", "cookie"],
  ["GET /api/maps", "quickstart"],
  ["POST /api/tables", "quickstart"],
  ["GET /api/tables", "afterUpload"],
  ["POST /api/query", "quickstart"],
  ["POST /api/query", "unknownTable"],
  ["POST /api/query", "valueTooLarge"],
  ["POST /api/query/export", "csv"],
  ["POST /api/operations/run", "saveAsDataset"],
  ["GET /api/catalogue/tables", "firstPage"],
  ["POST /api/maps", "quickstart"],
  ["POST /api/maps/{id}/layers", "quickstart"],
  ["POST /api/maps/{id}/publish", "quickstart"],
  ["GET /api/maps/{id}", "published"],
  ["PATCH /api/maps/{id}", "lightBasemap"],
  ["DELETE /api/maps/{id}/publish", "unpublish"],
  ["GET /api/maps", "afterQuickstart"],
  ["POST /api/account/tokens", "nightlyImport"],
  ["GET /api/account/tokens", "twoTokens"],
  ["DELETE /api/account/tokens/{id}", "nightlyImport"],
  ["GET /api/account", "signedIn"],
  ["GET /api/maps/{id}", "notFound"],
  ["POST /api/mcp", "createMap", "mcp"],
  ["GET /api/health", "ready"],
  ["GET /api/config", "newInstance"],
  ["GET /api/assistant", "notEnabled"],
  ["GET /api/instance/settings", "defaults"],
  ["PATCH /api/instance/settings", "previewRows"],
  ["GET /api/settings", "newAccount"],
  ["PATCH /api/settings", "mapsAsList"],
  ["GET /api/openapi.json", "excerpt"],
];
/** Examples not sent, and why. */
const NOT_SENT: Record<string, string> = {
  "GET /api/assistant enabled": "it needs a provider key on the instance",
};

/** Every example placed on an answer of the description, as `METHOD /path name`. */
function placedExamples(doc: Description): string[] {
  return Object.entries(doc.paths).flatMap(([path, item]) => Object.entries(item).flatMap(([method, operation]) =>
    Object.values(operation.responses ?? {}).flatMap((response) => Object.values(response.content ?? {}).flatMap((media) =>
      Object.keys(media.examples ?? {}).map((name) => `${method.toUpperCase()} ${path} ${name}`)))));
}

/** The answer an example names: its status, media type and value. */
function placedAnswer(doc: Description, key: string, name: string): { status: string; type: string; value: unknown } {
  for (const [status, response] of Object.entries(lookup(doc, key).responses)) {
    for (const [type, media] of Object.entries(response.content ?? {})) {
      if (media.examples?.[name]) return { status, type, value: media.examples[name].value };
    }
  }
  throw new Error(`${key} has no answer for the example ${name}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVISION = /^[0-9a-f]{32}$/;
const PLACEHOLDER = /^<[A-Z][A-Z0-9_]*>$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const show = (value: unknown) => JSON.stringify(value)?.slice(0, 200);

/** What an example's value stands for: the values the instance gave in
 * its place, by the example's value. */
type Bindings = Map<string, unknown>;

/** Where an answer differs from its example. */
function differences(example: unknown, actual: unknown, bindings: Bindings, at: string): string[] {
  if (typeof example === "string") {
    if (PLACEHOLDER.test(example) || UUID.test(example) || REVISION.test(example)) {
      if (!bindings.has(example)) { bindings.set(example, actual); return []; }
      return show(bindings.get(example)) === show(actual) ? [] : [`${at}: the example's ${example} stood for ${show(bindings.get(example))}, the instance answers ${show(actual)}`];
    }
    if (TIME.test(example)) return typeof actual === "string" && TIME.test(actual) ? [] : [`${at}: the example shows a time, the instance answers ${show(actual)}`];
    let expected = example;
    for (const [from, to] of bindings) if (typeof to === "string") expected = expected.replaceAll(from, to);
    return expected === actual ? [] : [`${at}: the example shows ${show(example)}, the instance answers ${show(actual)}`];
  }
  if (Array.isArray(example)) {
    if (!Array.isArray(actual)) return [`${at}: the example shows a list, the instance answers ${show(actual)}`];
    if (example.length !== actual.length) return [`${at}: the example shows ${example.length} items, the instance answers ${actual.length}`];
    return example.flatMap((item, index) => differences(item, actual[index], bindings, `${at}[${index}]`));
  }
  if (example && typeof example === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return [`${at}: the example shows an object, the instance answers ${show(actual)}`];
    const shown = Object.keys(example), answered = Object.keys(actual);
    const problems: string[] = [];
    for (const key of shown) {
      const value = (example as Record<string, unknown>)[key], given = (actual as Record<string, unknown>)[key];
      if (!answered.includes(key)) problems.push(`${at}.${key}: the example shows it, the instance answers no such field`);
      else if (VARIES.has(key)) { if (typeof given !== typeof value) problems.push(`${at}.${key}: the example shows a ${typeof value}, the instance answers ${show(given)}`); }
      else problems.push(...differences(value, given, bindings, `${at}.${key}`));
    }
    const extra = answered.filter((key) => !shown.includes(key));
    if (extra.length) problems.push(`${at}: the instance also answers ${extra.join(", ")}, which the example does not show`);
    const order = answered.filter((key) => shown.includes(key));
    if (order.length === shown.length && show(order) !== show(shown)) problems.push(`${at}: the example shows the fields as ${shown.join(", ")}; the instance answers ${order.join(", ")}`);
    return problems;
  }
  return show(example) === show(actual) ? [] : [`${at}: the example shows ${show(example)}, the instance answers ${show(actual)}`];
}

/** An answer with the parts its example's description says are cut taken
 * out, so only what the example shows is held. */
function asCut(key: string, example: unknown, actual: unknown): unknown {
  const shown = example as Record<string, unknown>, answer = structuredClone(actual) as Record<string, unknown>;
  if (key === "GET /api/config") {
    // Its palettes are trimmed to the ones it shows.
    const names = (shown.palettes as { name: string }[]).map((palette) => palette.name);
    answer.palettes = names.map((name) => (answer.palettes as { name: string }[]).find((palette) => palette.name === name));
  }
  if (key === "GET /api/instance/settings" || key === "PATCH /api/instance/settings") {
    // It names the data folder and port it was read with; the session
    // cookie's name follows the port.
    const settings = answer.settings as Record<string, { value: unknown }>, given = shown.settings as Record<string, { value: unknown }>;
    for (const name of ["dataDir", "port", "sessionCookie"]) settings[name].value = given[name].value;
  }
  if (key === "GET /api/openapi.json") return excerpt(example, actual);
  return answer;
}

/** The parts of a value that an excerpt of it shows. */
function excerpt(shown: unknown, actual: unknown): unknown {
  if (!shown || typeof shown !== "object" || Array.isArray(shown) || !actual || typeof actual !== "object") return actual;
  return Object.fromEntries(Object.keys(shown).filter((key) => key in actual).map((key) => [key, excerpt((shown as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key])]));
}

/** A value of an example with every value an answer gave in its place. */
function filled(value: unknown, bindings: Bindings): unknown {
  if (typeof value === "string") return bindings.has(value) ? bindings.get(value) : value === "<YOUR_PASSWORD>" ? READER.password : value;
  if (Array.isArray(value)) return value.map((item) => filled(item, bindings));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, filled(item, bindings)]));
  return value;
}

/** The JSON-RPC message one server-sent event carries, with the tool's
 * result, sent as text, read as JSON. */
function eventMessage(text: string): unknown {
  const data = /^data: (.*)$/m.exec(text);
  if (!data) return text;
  const message = JSON.parse(data[1]) as { result?: { content?: { text?: string }[] } };
  const content = message.result?.content?.[0];
  if (content?.text) content.text = JSON.parse(content.text);
  return message;
}

/** What one example's call answered. */
interface Answered { key: string; name: string; status: number; type: string; body: unknown }

/** Every example of the sequence, sent to the instance in order. */
async function sendAll(doc: Description): Promise<Answered[]> {
  const bindings: Bindings = new Map(), answered: Answered[] = [];
  let cookie = "", token = "";
  for (const [key, name, how] of SEQUENCE) {
    const [method, template] = key.split(" "), operation = lookup(doc, key);
    let path = template;
    const headers: Record<string, string> = {}, query = new URLSearchParams();
    for (const parameter of operation.parameters ?? []) {
      const example = parameter.examples?.[name];
      if (!example) continue;
      const value = String(filled(example.value, bindings));
      if (parameter.in === "path") path = path.replace(`{${parameter.name}}`, encodeURIComponent(value));
      else if (parameter.in === "header") headers[parameter.name] = value;
      else if (parameter.in === "query") query.set(parameter.name, value);
    }
    if (how === "cookie") Object.assign(headers, { cookie, origin: ADDRESS });
    else if (token) headers.authorization = `Bearer ${token}`;
    // The example's description asks for this Accept header.
    if (how === "mcp") headers.accept = "application/json, text/event-stream";
    let body: BodyInit | undefined;
    for (const [type, media] of Object.entries(operation.requestBody?.content ?? {})) {
      const example = media.examples?.[name];
      if (!example) continue;
      if (type === "multipart/form-data") {
        const form = new FormData();
        for (const [field, value] of Object.entries(example.value as Record<string, string>)) {
          const file = example["x-filenames"]?.[field];
          if (file) form.append(field, new Blob([value]), file); else form.append(field, value);
        }
        body = form;
      } else {
        headers["content-type"] = type;
        body = JSON.stringify(filled(example.value, bindings));
      }
    }
    const response = await fetch(`${ADDRESS}${path}${query.size ? `?${query}` : ""}`, { method, headers, body });
    if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map((set) => set.split(";")[0]).join("; ");
    const type = response.headers.get("content-type") ?? "", text = await response.text();
    const parsed = type.includes("json") ? JSON.parse(text) : type.includes("event-stream") ? eventMessage(text) : text;
    answered.push({ key, name, status: response.status, type, body: parsed });
    // Bind what this answer gave, so the next request sends it.
    differences(placedAnswer(doc, key, name).value, parsed, bindings, "");
    if (key === "POST /api/account/tokens" && name === "quickstart") token = (parsed as { secret: string }).secret;
    if (key === "POST /api/operations/run") await laneSettled();
  }
  return answered;
}

/** Where the answers differ from the description's examples. */
function problems(doc: Description, answered: Answered[]): string[] {
  const bindings: Bindings = new Map();
  return answered.flatMap(({ key, name, status, type, body }) => {
    const example = placedAnswer(doc, key, name), where = `${key} ${name}`;
    const found: string[] = [];
    if (String(status) !== example.status) found.push(`${where}: the example answers ${example.status}, the instance ${status}`);
    // A file's example sits under the media type the operation declares, so
    // only its bytes are held.
    if (example.type.includes("json") && !type.includes("json")) found.push(`${where}: the example is JSON, the instance answers ${type}`);
    if (example.type === "text/event-stream" && !type.includes("event-stream")) found.push(`${where}: the example is an event stream, the instance answers ${type}`);
    const shown = example.type === "text/event-stream" ? eventMessage(example.value as string) : example.value;
    return [...found, ...differences(shown, asCut(key, shown, body), bindings, "the answer").map((problem) => `${where}: ${problem}`)];
  });
}

let instance: OwnInstance | undefined;
afterEach(async () => { await instance?.close(); instance = undefined; });

describe("the worked examples, sent to an instance in the quickstart's order", () => {
  it("sends every example the description places, but one that needs a provider key", () => {
    const sent = SEQUENCE.map(([key, name]) => `${key} ${name}`);
    expect(new Set(sent).size).toBe(sent.length);
    expect([...sent, ...Object.keys(NOT_SENT)].sort()).toEqual(placedExamples(document).sort());
  });

  it("gets every example's answer from a new instance, and names an answer a seeded example does not match", async () => {
    instance = await ownInstance(ADDRESS, "3452");
    const setup = await fetch(`${ADDRESS}/api/auth/setup`, {
      method: "POST", headers: { "content-type": "application/json", origin: ADDRESS }, body: JSON.stringify(READER),
    });
    expect(setup.status, "the first account is made").toBe(200);
    const answered = await sendAll(document);
    expect(answered).toHaveLength(SEQUENCE.length);
    expect(problems(document, answered)).toEqual([]);

    // The same answers against a copy of the description whose examples
    // were changed: a wrong count, a wrong city and a renamed field.
    const seeded = structuredClone(document);
    const uploaded = placedAnswer(seeded, "POST /api/tables", "quickstart").value as Record<string, unknown>;
    uploaded.rowCount = 47;
    const queried = placedAnswer(seeded, "POST /api/query", "quickstart").value as { preview: { name: string }[] } & Record<string, unknown>;
    queried.preview[0].name = "Osaka";
    const media = lookup(seeded, "POST /api/query").responses["200"].content!["application/json"].examples!.quickstart;
    media.value = Object.fromEntries(Object.entries(queried).map(([field, value]) => [field === "rowCount" ? "rowCuont" : field, value]));
    expect(problems(seeded, answered)).toEqual([
      "POST /api/tables quickstart: the answer.rowCount: the example shows 47, the instance answers 48",
      "POST /api/query quickstart: the answer.rowCuont: the example shows it, the instance answers no such field",
      'POST /api/query quickstart: the answer.preview[0].name: the example shows "Osaka", the instance answers "Tokyo"',
      "POST /api/query quickstart: the answer: the instance also answers rowCount, which the example does not show",
    ]);
  }, 120_000);
});
