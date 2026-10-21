import { afterEach, describe, expect, it, vi } from "vitest";
import { laneSettled } from "@/lib/operations/lane";
import { SETTING_CATALOGUE } from "@/lib/settings/catalogue";
import { ownInstance, type OwnInstance } from "@/lib/test-support/page-calls";
import { buildOpenApiDocument } from "./openapi";

/**
 * The worked examples of the served description, sent to an instance of
 * their own in the order a reader meets them: the API quickstart's steps in
 * their order, and each guide's example where what it needs is there, so
 * the dataset list, the query's refusals, its export, the save and the
 * catalogue go between the upload and the map, and the rest after the
 * quickstart's last step. Where an example needs what no example before it
 * makes, such as another account's published map, the test makes it over
 * the API first. Each request is built from the example as the
 * operation reference draws it, and each answer must be the example's. An
 * identifier, a revision or a placeholder in an example stands for the
 * value the instance gave at that place first, which must be of its kind
 * and not one another of them stands for, and every later use must be that
 * value; a time stands for any time, and a field that varies by run for any
 * value of its type. Where an example's description says it is cut, only what it
 * shows is held, and the data folder and port it says it was read on stand
 * for this instance's own. So an example stays what the instance answers,
 * and a seeded wrong one is named.
 */

// Whether the tile builder and the image renderer are there is a file check
// where their settings point, on the machine the test runs on. The examples
// were read where the tile builder is on the search path and no browser is
// where the image renderer's setting points, so for this test the check
// answers as it did there, whatever this machine has.
vi.mock("@/lib/system/executable", () => ({ executableFound: (program: string) => program === "tippecanoe" }));

const ADDRESS = "http://localhost:3000";
const PORT = "3452";
const READER = { name: "Ana Diaz", email: "ana@example.com", password: "field notebooks at dawn" };
/** The variables an instance's settings are read from, but the data folder
 * and port the instance is given. None is set, as on a new instance,
 * whatever the shell running the test exports. */
const UNSET = SETTING_CATALOGUE.flatMap(({ environment }) => environment && environment !== "DEZFIL_DATA_DIR" && environment !== "PORT" ? [environment] : []);
/** The fields whose value differs from run to run. */
const VARIES = new Set(["runtimeMs"]);

type Example = { description?: string; value?: unknown; "x-filenames"?: Record<string, string> };
type Media = { examples?: Record<string, Example> };
type Operation = {
  parameters?: { name: string; in: string; examples?: Record<string, Example> }[];
  requestBody?: { content?: Record<string, Media> };
  responses: Record<string, { content?: Record<string, Media>; "x-examples"?: Record<string, Example> }>;
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
  ["GET /api/assistant", "enabled"],
  ["GET /api/instance/settings", "defaults"],
  ["PATCH /api/instance/settings", "previewRows"],
  ["GET /api/settings", "newAccount"],
  ["PATCH /api/settings", "mapsAsList"],
  ["GET /api/openapi.json", "excerpt"],
  ["DELETE /api/publications/{token}", "deactivatedOwner"],
];
/** The variables set for one call only, as its example's description says
 * the instance has them. A placeholder stands for the key: reading the
 * assistant's status holds no credential, makes no client and reaches no
 * network. */
const SET_FOR: Record<string, Record<string, string>> = {
  "GET /api/assistant enabled": { ANTHROPIC_API_KEY: "placeholder-not-a-key" },
};

/** Every example placed on an answer of the description, as `METHOD /path
 * name`: under an answer's media type, or on an answer without content. */
function placedExamples(doc: Description): string[] {
  return Object.entries(doc.paths).flatMap(([path, item]) => Object.entries(item).flatMap(([method, operation]) =>
    Object.values(operation.responses ?? {}).flatMap((response) => [
      ...Object.values(response.content ?? {}).flatMap((media) => Object.keys(media.examples ?? {})),
      ...Object.keys(response["x-examples"] ?? {}),
    ].map((name) => `${method.toUpperCase()} ${path} ${name}`))));
}

/** The answer an example names: its status, media type and value; an
 * answer without content has no media type. */
function placedAnswer(doc: Description, key: string, name: string): { status: string; type: string | null; value: unknown } {
  for (const [status, response] of Object.entries(lookup(doc, key).responses)) {
    for (const [type, media] of Object.entries(response.content ?? {})) {
      if (media.examples?.[name]) return { status, type, value: media.examples[name].value };
    }
    if (response["x-examples"]?.[name]) return { status, type: null, value: undefined };
  }
  throw new Error(`${key} has no answer for the example ${name}`);
}

/** What the revocation example needs first: a map another account owns and
 * published, that account then deactivated by the reader, an admin. The
 * map's publish token is the one the example sends. */
async function deactivatedOwnersLink(token: string): Promise<string> {
  const admin = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const invited = await fetch(`${ADDRESS}/api/users`, { method: "POST", headers: admin, body: JSON.stringify({ name: "Ben Okafor", email: "ben@example.com" }) });
  const { account, signInUrl } = await invited.json() as { account: { id: string }; signInUrl: string };
  const secret = new URLSearchParams(new URL(signInUrl).hash.slice(1)).get("secret");
  const redeemed = await fetch(`${ADDRESS}/api/auth/redeem`, { method: "POST", headers: { "content-type": "application/json", origin: ADDRESS }, body: JSON.stringify({ secret, password: READER.password }) });
  const session = { cookie: redeemed.headers.getSetCookie().map((set) => set.split(";")[0]).join("; "), origin: ADDRESS, "content-type": "application/json" };
  const map = await (await fetch(`${ADDRESS}/api/maps`, { method: "POST", headers: session, body: JSON.stringify({ name: "Survey sites" }) })).json() as { id: string; editRevision: string };
  const published = await (await fetch(`${ADDRESS}/api/maps/${map.id}/publish`, { method: "POST", headers: { ...session, "x-edit-revision": map.editRevision } })).json() as { token: string };
  const deactivated = await fetch(`${ADDRESS}/api/users/${account.id}`, { method: "PATCH", headers: admin, body: JSON.stringify({ status: "deactivated" }) });
  expect([invited.status, redeemed.status, typeof published.token, deactivated.status], "another account's published map, its owner deactivated").toEqual([201, 200, "string", 200]);
  return published.token;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVISION = /^[0-9a-f]{32}$/;
const PLACEHOLDER = /^<[A-Z][A-Z0-9_]*>$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const show = (value: unknown) => JSON.stringify(value)?.slice(0, 200);

/** The values an example writes in place of one the instance makes up, and
 * what the instance must answer there: an identifier, a revision, or some
 * text for a placeholder. */
const STAND_INS: { shape: RegExp; kind: string; answers: (value: unknown) => boolean }[] = [
  { shape: UUID, kind: "an identifier", answers: (value) => typeof value === "string" && UUID.test(value) },
  { shape: REVISION, kind: "a revision", answers: (value) => typeof value === "string" && REVISION.test(value) },
  { shape: PLACEHOLDER, kind: "text", answers: (value) => typeof value === "string" && value !== "" },
];

/** What an example's value stands for: the values the instance gave in
 * its place, by the example's value. */
type Bindings = Map<string, unknown>;

/** Where an answer differs from its example. */
function differences(example: unknown, actual: unknown, bindings: Bindings, at: string): string[] {
  if (typeof example === "string") {
    const standIn = STAND_INS.find(({ shape }) => shape.test(example));
    if (standIn) {
      if (bindings.has(example)) return show(bindings.get(example)) === show(actual) ? [] : [`${at}: the example's ${example} stood for ${show(bindings.get(example))}, the instance answers ${show(actual)}`];
      if (!standIn.answers(actual)) return [`${at}: the example's ${example} stands for ${standIn.kind}, the instance answers ${show(actual)}`];
      // One value, one stand-in: the examples agree with each other.
      const before = [...bindings].find(([, value]) => show(value) === show(actual))?.[0];
      if (before !== undefined) return [`${at}: the example shows ${example} for the value it showed as ${before} before`];
      bindings.set(example, actual);
      return [];
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

/** The data folder and port an instance runs with, and its session
 * cookie's name, which follows the port. */
interface RunWith { dataDir: string; port: string; sessionCookie: string }
const runWith = (dataDir: string, port: string): RunWith =>
  ({ dataDir, port, sessionCookie: port === "3000" ? "dezfil_session" : `dezfil_session_${port}` });

/** What the instance settings examples were read on: the data folder and
 * port the reading example's description names. */
function readOn(doc: Description): RunWith {
  const words = lookup(doc, "GET /api/instance/settings").responses["200"].content?.["application/json"].examples?.defaults.description ?? "";
  const dataDir = /DEZFIL_DATA_DIR=(\S+)/.exec(words)?.[1], port = /\bPORT=(\d+)/.exec(words)?.[1];
  if (!dataDir || !port) throw new Error("The instance settings example names no data folder and port it was read on");
  return runWith(dataDir, port);
}

/** An answer with the parts its example's description says are cut taken
 * out, so only what the example shows is held. */
function asCut(doc: Description, key: string, example: unknown, actual: unknown, ran: RunWith): unknown {
  const shown = example as Record<string, unknown>, answer = structuredClone(actual) as Record<string, unknown>;
  if (key === "GET /api/config") {
    // Its palettes are trimmed to the ones it shows.
    const names = (shown.palettes as { name: string }[]).map((palette) => palette.name);
    answer.palettes = names.map((name) => (answer.palettes as { name: string }[]).find((palette) => palette.name === name));
  }
  if (key === "GET /api/instance/settings" || key === "PATCH /api/instance/settings") {
    // They were read on an instance run with the data folder and port the
    // reading example names, and this one runs with its own. Where the
    // instance answers what it runs with, that is read as what the example
    // was read on, so a wrong value on either side is named.
    const settings = answer.settings as Record<string, { value: unknown }>, read = readOn(doc);
    for (const name of ["dataDir", "port", "sessionCookie"] as const) if (settings[name].value === ran[name]) settings[name].value = read[name];
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
    if (key === "DELETE /api/publications/{token}") {
      // The example's token stands for the link of the map made for it.
      const shown = operation.parameters!.find((parameter) => parameter.name === "token")!.examples![name].value as string;
      bindings.set(shown, await deactivatedOwnersLink(token));
    }
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
    const variables = Object.entries(SET_FOR[`${key} ${name}`] ?? {});
    for (const [variable, value] of variables) vi.stubEnv(variable, value);
    const response = await fetch(`${ADDRESS}${path}${query.size ? `?${query}` : ""}`, { method, headers, body });
    for (const [variable] of variables) vi.stubEnv(variable, undefined);
    if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map((set) => set.split(";")[0]).join("; ");
    const type = response.headers.get("content-type") ?? "", text = await response.text();
    const parsed = type.includes("json") ? JSON.parse(text) : type.includes("event-stream") ? eventMessage(text) : text;
    answered.push({ key, name, status: response.status, type, body: parsed });
    // Bind what this answer gave, so the next request sends it.
    const placed = placedAnswer(doc, key, name);
    if (placed.type !== null) differences(placed.value, parsed, bindings, "");
    if (key === "POST /api/account/tokens" && name === "quickstart") token = (parsed as { secret: string }).secret;
    if (key === "POST /api/operations/run") await laneSettled();
  }
  return answered;
}

/** Where the answers of an instance run with `ran` differ from the
 * description's examples. */
function problems(doc: Description, answered: Answered[], ran: RunWith): string[] {
  const bindings: Bindings = new Map();
  return answered.flatMap(({ key, name, status, type, body }) => {
    const example = placedAnswer(doc, key, name), where = `${key} ${name}`;
    const found: string[] = [];
    if (String(status) !== example.status) found.push(`${where}: the example answers ${example.status}, the instance ${status}`);
    if (example.type === null) return body === "" ? found : [...found, `${where}: the example answers without content, the instance answers ${show(body)}`];
    // A file's example sits under the media type the operation declares, so
    // only its bytes are held.
    if (example.type.includes("json") && !type.includes("json")) found.push(`${where}: the example is JSON, the instance answers ${type}`);
    if (example.type === "text/event-stream" && !type.includes("event-stream")) found.push(`${where}: the example is an event stream, the instance answers ${type}`);
    const shown = example.type === "text/event-stream" ? eventMessage(example.value as string) : example.value;
    return [...found, ...differences(shown, asCut(doc, key, shown, body, ran), bindings, "the answer").map((problem) => `${where}: ${problem}`)];
  });
}

let instance: OwnInstance | undefined;
afterEach(async () => { await instance?.close(); instance = undefined; vi.unstubAllEnvs(); });

describe("the worked examples, sent to an instance in the quickstart's order", () => {
  it("sends every example the description places", () => {
    const sent = SEQUENCE.map(([key, name]) => `${key} ${name}`);
    expect(new Set(sent).size).toBe(sent.length);
    expect([...sent].sort()).toEqual(placedExamples(document).sort());
    expect(Object.keys(SET_FOR).filter((example) => !sent.includes(example))).toEqual([]);
  });

  it("gets every example's answer from a new instance, and names an answer a seeded example does not match", async () => {
    for (const variable of UNSET) vi.stubEnv(variable, undefined);
    instance = await ownInstance(ADDRESS, PORT);
    const ran = runWith(instance.directory, PORT);
    const setup = await fetch(`${ADDRESS}/api/auth/setup`, {
      method: "POST", headers: { "content-type": "application/json", origin: ADDRESS }, body: JSON.stringify(READER),
    });
    expect(setup.status, "the first account is made").toBe(200);
    const answered = await sendAll(document);
    expect(answered).toHaveLength(SEQUENCE.length);
    expect(problems(document, answered, ran)).toEqual([]);

    // The same answers against a copy of the description whose examples
    // were changed: a wrong count, a wrong city, a renamed field, the map's
    // identifier written two ways, an identifier where there is none, a
    // data folder other than the one the example was read on, an image
    // renderer found where that host had none, and a revocation that claims
    // the refusal for its answer.
    const seeded = structuredClone(document);
    const uploaded = placedAnswer(seeded, "POST /api/tables", "quickstart").value as Record<string, unknown>;
    uploaded.rowCount = 47;
    const queried = placedAnswer(seeded, "POST /api/query", "quickstart").value as { preview: { name: string }[] } & Record<string, unknown>;
    queried.preview[0].name = "Osaka";
    const media = lookup(seeded, "POST /api/query").responses["200"].content!["application/json"].examples!.quickstart;
    media.value = Object.fromEntries(Object.entries(queried).map(([field, value]) => [field === "rowCount" ? "rowCuont" : field, value]));
    (placedAnswer(seeded, "POST /api/maps/{id}/layers", "quickstart").value as Record<string, unknown>).mapId = "99999999-8888-4777-8666-555555555555";
    (placedAnswer(seeded, "GET /api/maps", "afterQuickstart").value as Record<string, unknown>[])[0].publishToken = "33333333-4444-4555-8666-777777777777";
    const settings = placedAnswer(seeded, "GET /api/instance/settings", "defaults").value as { settings: Record<string, { value: unknown }>; parts: { image_renderer: { found: boolean } } };
    settings.settings.dataDir.value = "/srv/elsewhere";
    settings.parts.image_renderer.found = true;
    const revoke = lookup(seeded, "DELETE /api/publications/{token}").responses;
    revoke["404"]["x-examples"] = revoke["204"]["x-examples"];
    delete revoke["204"]["x-examples"];
    expect(problems(seeded, answered, ran)).toEqual([
      "POST /api/tables quickstart: the answer.rowCount: the example shows 47, the instance answers 48",
      "POST /api/query quickstart: the answer.rowCuont: the example shows it, the instance answers no such field",
      'POST /api/query quickstart: the answer.preview[0].name: the example shows "Osaka", the instance answers "Tokyo"',
      "POST /api/query quickstart: the answer: the instance also answers rowCount, which the example does not show",
      "POST /api/maps/{id}/layers quickstart: the answer.mapId: the example shows 99999999-8888-4777-8666-555555555555 for the value it showed as 2f6e9c41-8d3b-4a7e-b1f5-6c0d2e8a9b34 before",
      "GET /api/maps afterQuickstart: the answer[0].publishToken: the example's 33333333-4444-4555-8666-777777777777 stands for an identifier, the instance answers null",
      'GET /api/instance/settings defaults: the answer.settings.dataDir.value: the example shows "/srv/elsewhere", the instance answers "/data"',
      "GET /api/instance/settings defaults: the answer.parts.image_renderer.found: the example shows true, the instance answers false",
      "DELETE /api/publications/{token} deactivatedOwner: the example answers 404, the instance 204",
    ]);
  }, 120_000);
});
