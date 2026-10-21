import {
  ACCOUNT,
  ASSISTANT_ENABLED,
  ASSISTANT_OFF,
  CATALOGUE_PAGE,
  CONFIG,
  FIELD_NOTES,
  INSTANCE_SETTINGS,
  INSTANCE_SETTINGS_CHANGED,
  LAYER_CREATED,
  MAP_CREATED,
  MAP_LIGHT,
  MAP_PUBLISHED,
  MAPS_LISTED,
  NIGHTLY_TOKEN,
  PUBLISHED,
  QUICKSTART_TOKEN,
  SAVE_RUN,
  SETTINGS,
  SETTINGS_CHANGED,
  TABLES,
  TOKENS,
  UNPUBLISHED,
  UPLOADED,
  WORLD_CITIES_CSV,
} from "./openapi-example-answers";

/**
 * Worked examples for the operations the documentation calls: what a call
 * sends and what it answers, on the operations themselves, so the
 * reference can draw each one as a request and its response.
 *
 * An example is placed in the description's own example fields: `examples`
 * on each parameter it gives a value, on its request body's media type and
 * on its response's media type, every part under the example's name. An
 * answer without content, such as a 204, has no media type to hold it, so
 * the example's name, summary and description sit on the response itself,
 * under `x-examples`. The name pairs a request with its response. The
 * steps of the API quickstart are all named `quickstart`, and their values
 * follow one another: the
 * dataset the upload makes is the one the query reads, the map the first
 * call makes is the one the layer joins, and each change sends the
 * editRevision the change before it answered.
 *
 * The tools derived from the description read a parameter's schema and
 * description and a body's or response's schema, never these fields, so
 * no example reaches a tool's description or schemas.
 */

/** One worked example of one operation. */
export interface WorkedExample {
  /** A short name for the call. */
  summary: string;
  /** What must exist before the call, and anything else a caller sends. */
  description: string;
  /** The value of each path, query and header parameter the call sends, by
   * the parameter's declared name. */
  parameters?: Record<string, string | number>;
  /** The request body under its media type. For a file upload, `files`
   * names the file each binary field of the form is sent as. */
  request?: { mediaType: string; value: unknown; files?: Record<string, string> };
  /** The answer: its status, media type and body, or its status alone for
   * an answer without content. */
  response: { status: string; mediaType: string; value: unknown } | { status: string; mediaType?: undefined; value?: undefined };
}

/** Worked examples by operation, written `METHOD /path`, then by name. */
export type WorkedExamples = Record<string, Record<string, WorkedExample>>;

const JSON_TYPE = "application/json";
const json = (value: unknown) => ({ mediaType: JSON_TYPE, value });
const answer = (status: string, value: unknown) => ({ status, mediaType: JSON_TYPE, value });

const BIG_CITIES_SQL = "SELECT name, population, geometry FROM world_cities WHERE population > 10000000";
const LARGEST_SQL = "SELECT name, country, population FROM world_cities ORDER BY population DESC LIMIT 3";

/** The MCP endpoint's answer to one call: one server-sent event holding
 * the JSON-RPC response, as the streamable HTTP transport sends it. */
function serverSentEvent(message: unknown): string {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}

export const WORKED_EXAMPLES: WorkedExamples = {
  "POST /api/auth/sign-in": {
    quickstart: {
      summary: "Sign in as Ana Diaz",
      description:
        "Needs an account on the instance. Origin names the address the instance is opened at. " +
        "The answer sets the session cookie, which creating a token accepts.",
      parameters: { Origin: "http://localhost:3000" },
      request: json({ email: "ana@example.com", password: "<YOUR_PASSWORD>" }),
      response: answer("200", { account: ACCOUNT }),
    },
  },
  "POST /api/account/tokens": {
    quickstart: {
      summary: "Create the token Quickstart",
      description:
        "Needs a signed-in session: the cookie signing in sets, sent with Origin, or a token. " +
        "The secret is in this answer only; send it as the bearer token from then on.",
      request: json({ name: "Quickstart" }),
      response: answer("201", QUICKSTART_TOKEN),
    },
    nightlyImport: {
      summary: "Create a second token with the first",
      description: "Needs a token.",
      request: json({ name: "Nightly import" }),
      response: answer("201", NIGHTLY_TOKEN),
    },
  },
  "GET /api/account/tokens": {
    twoTokens: {
      summary: "List your tokens",
      description: "Needs a token. Lists the two tokens made above, without their secrets.",
      response: answer("200", TOKENS),
    },
  },
  "DELETE /api/account/tokens/{id}": {
    nightlyImport: {
      summary: "Revoke the token Nightly import",
      description: "Needs a token and the id of the token to revoke. The revoked token's next call answers authentication_required.",
      parameters: { id: NIGHTLY_TOKEN.id },
      response: answer("200", { revoked: true }),
    },
  },
  "GET /api/account": {
    signedIn: {
      summary: "Read the account a token belongs to",
      description: "Needs a token.",
      response: answer("200", { account: ACCOUNT }),
    },
  },
  "GET /api/maps": {
    quickstart: {
      summary: "List the maps of a new account",
      description: "Needs a token. A new account reaches no map yet.",
      response: answer("200", []),
    },
    afterQuickstart: {
      summary: "List the maps once World cities exists",
      description: "Needs a token. Lists the quickstart's map after its basemap changed and it was unpublished.",
      response: answer("200", MAPS_LISTED),
    },
  },
  "POST /api/tables": {
    quickstart: {
      summary: "Upload world-cities.csv",
      description:
        "Needs a token and the file world-cities.csv: 48 cities with latitude and longitude columns. " +
        "The form's one field, file, carries the file's bytes; the dataset takes its name from the file.",
      request: { mediaType: "multipart/form-data", value: { file: WORLD_CITIES_CSV }, files: { file: "world-cities.csv" } },
      response: answer("201", UPLOADED),
    },
  },
  "GET /api/tables": {
    afterUpload: {
      summary: "List your datasets",
      description: "Needs a token. Lists world_cities, the dataset the upload made.",
      response: answer("200", TABLES),
    },
  },
  "POST /api/query": {
    quickstart: {
      summary: "Query the three largest cities",
      description: "Needs a token and the dataset world_cities, which the upload makes.",
      request: json({ sql: LARGEST_SQL }),
      response: answer("200", {
        columns: [{ name: "name", type: "VARCHAR" }, { name: "country", type: "VARCHAR" }, { name: "population", type: "BIGINT" }],
        rowCount: 3,
        preview: [
          { name: "Tokyo", country: "Japan", population: "35676000" },
          { name: "New York", country: "United States of America", population: "19040000" },
          { name: "Mexico City", country: "Mexico", population: "19028000" },
        ],
        previewTruncated: false,
        runtimeMs: 4,
      }),
    },
    unknownTable: {
      summary: "Query a dataset that does not exist",
      description: "Needs a token. No dataset need exist: the answer is the error.",
      request: json({ sql: "SELECT * FROM no_such_dataset" }),
      response: answer("400", { error: { code: "sql_error", message: "The query refers to an unknown table.", position: { line: 1, column: 15 } } }),
    },
    valueTooLarge: {
      summary: "Query one value over 2 MiB",
      description: "Needs a token. No dataset need exist: the one value is over the size a value may have in an answer, so no row is returned.",
      request: json({ sql: "SELECT repeat('x', 3000000) AS value" }),
      response: answer("422", {
        error: {
          code: "query_result_too_large",
          message: "The result is too large to return: more than 32 MB in total, or one non-geometry value over 2 MB. Select fewer rows or columns, or shorten the value.",
        },
      }),
    },
  },
  "POST /api/query/export": {
    csv: {
      summary: "Download a query's result as CSV",
      description: "Needs a token and the dataset world_cities. The answer is the file largest_cities.csv, every row of the result.",
      request: json({ sql: LARGEST_SQL, format: "csv", name: "largest_cities" }),
      response: {
        status: "200",
        mediaType: "application/octet-stream",
        value: "name,country,population\nTokyo,Japan,35676000\nNew York,United States of America,19040000\nMexico City,Mexico,19028000\n",
      },
    },
  },
  "POST /api/operations/run": {
    saveAsDataset: {
      summary: "Save a query's result as the dataset big_cities",
      description:
        "Needs a token and the dataset world_cities. The run is accepted at once and writes big_cities when it finishes; " +
        "read its outcome from the run.",
      request: json({ operation: "sql_step", parameters: { sql: SAVE_RUN.run.parameters.sql, name: "big_cities" } }),
      response: answer("202", SAVE_RUN),
    },
  },
  "GET /api/catalogue/tables": {
    firstPage: {
      summary: "Read a page of one dataset with its columns",
      description:
        "Needs a token, and the datasets world_cities and big_cities. nextAfter is the cursor for the next page: send it as after.",
      parameters: { limit: 1 },
      response: answer("200", CATALOGUE_PAGE),
    },
  },
  "POST /api/maps": {
    quickstart: {
      summary: "Create the map World cities",
      description: "Needs a token. The answer's editRevision is what the next change to the map sends.",
      request: json({ name: "World cities" }),
      response: answer("201", MAP_CREATED),
    },
  },
  "POST /api/maps/{id}/layers": {
    quickstart: {
      summary: "Add the layer Big cities",
      description:
        "Needs the map World cities with the editRevision creating it answered, and the dataset world_cities. " +
        "The layer draws the 15 cities of more than 10 million people.",
      parameters: { id: MAP_CREATED.id, "X-Edit-Revision": MAP_CREATED.editRevision },
      request: json({ name: "Big cities", sql: BIG_CITIES_SQL }),
      response: answer("201", LAYER_CREATED),
    },
  },
  "POST /api/maps/{id}/publish": {
    quickstart: {
      summary: "Publish the map",
      description:
        "Needs the map World cities with the editRevision adding the layer answered. " +
        "The answer's token is the published link's: the map opens at /v/<token> for anyone with the link.",
      parameters: { id: MAP_CREATED.id, "X-Edit-Revision": LAYER_CREATED.editRevision },
      response: answer("201", PUBLISHED),
    },
  },
  "GET /api/maps/{id}": {
    published: {
      summary: "Read the published map with its layer",
      description: "Needs a token and the map World cities, published. The answer carries the editRevision the next change sends.",
      parameters: { id: MAP_CREATED.id },
      response: answer("200", MAP_PUBLISHED),
    },
    notFound: {
      summary: "Read a map that does not exist",
      description: "Needs a token. A map your account does not reach answers the same.",
      parameters: { id: "no-such-map" },
      response: answer("404", { error: { code: "not_found", message: "The requested resource was not found." } }),
    },
  },
  "PATCH /api/maps/{id}": {
    lightBasemap: {
      summary: "Change the map's basemap to Light",
      description: "Needs the map World cities with its newest editRevision, here the one reading the published map answered.",
      parameters: { id: MAP_CREATED.id, "X-Edit-Revision": MAP_PUBLISHED.editRevision },
      request: json({ basemap: "light" }),
      response: answer("200", MAP_LIGHT),
    },
  },
  "DELETE /api/maps/{id}/publish": {
    unpublish: {
      summary: "Stop sharing the map",
      description:
        "Needs the published map World cities with its newest editRevision, here the one the basemap change answered. " +
        "The published link stops working at once.",
      parameters: { id: MAP_CREATED.id, "X-Edit-Revision": MAP_LIGHT.editRevision },
      response: answer("200", UNPUBLISHED),
    },
  },
  "DELETE /api/publications/{token}": {
    deactivatedOwner: {
      summary: "Take a deactivated account's published map offline",
      description:
        "Needs an admin's token and the publish token of a map whose owner is deactivated: the end of the map's link, /v/<token>. " +
        "The answer has no body, and the link stops working at once. The account and the map stay.",
      parameters: { token: "<PUBLISH_TOKEN>" },
      response: { status: "204" },
    },
  },
  "POST /api/mcp": {
    createMap: {
      summary: "Call the tool create_map",
      description:
        "Needs a token. Send Accept: application/json, text/event-stream; the answer arrives as one server-sent event " +
        "holding the JSON-RPC response, the tool's result in structuredContent.",
      request: json({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_map", arguments: { name: "Field notes" } } }),
      response: {
        status: "200",
        mediaType: "text/event-stream",
        value: serverSentEvent({
          result: {
            content: [{ type: "text", text: JSON.stringify(FIELD_NOTES) }],
            structuredContent: { result: FIELD_NOTES, history: null },
            isError: false,
          },
          jsonrpc: "2.0",
          id: 1,
        }),
      },
    },
  },
  "GET /api/health": {
    ready: {
      summary: "Check that the instance is ready",
      description: "Needs nothing: the check takes no sign-in.",
      response: answer("200", { status: "ready" }),
    },
  },
  "GET /api/config": {
    newInstance: {
      summary: "Read the values in effect",
      description: "Needs a token. On a new instance, with its palettes trimmed to two of the twenty-three.",
      response: answer("200", CONFIG),
    },
  },
  "GET /api/assistant": {
    enabled: {
      summary: "Read the assistant's status on an instance with a key",
      description: "Needs a token. The instance has an Anthropic key and the shipped model list.",
      response: answer("200", ASSISTANT_ENABLED),
    },
    notEnabled: {
      summary: "Read the assistant's status on an instance without a key",
      description: "Needs a token. The instance has no provider key, so the assistant is off.",
      response: answer("200", ASSISTANT_OFF),
    },
  },
  "GET /api/instance/settings": {
    defaults: {
      summary: "Read the instance's settings",
      description: "Needs an admin's token. On a new instance run from a checkout with DEZFIL_DATA_DIR=/data and PORT=3000.",
      response: answer("200", INSTANCE_SETTINGS),
    },
  },
  "PATCH /api/instance/settings": {
    previewRows: {
      summary: "Show 2,000 rows in results",
      description:
        "Needs an admin's token. previewRows is the key of Rows shown in results; " +
        "the answer is every setting, as reading them answers, with the new value stored.",
      request: json({ previewRows: 2000 }),
      response: answer("200", INSTANCE_SETTINGS_CHANGED),
    },
  },
  "GET /api/settings": {
    newAccount: {
      summary: "Read your own settings",
      description: "Needs a token. A new account's settings.",
      response: answer("200", SETTINGS),
    },
  },
  "PATCH /api/settings": {
    mapsAsList: {
      summary: "Show the Maps page as a list, by name",
      description: "Needs a token. The slice you send merges into what is stored.",
      request: json({ viewPrefs: { maps: { view: "list", sort: "name" } } }),
      response: answer("200", SETTINGS_CHANGED),
    },
  },
  "GET /api/openapi.json": {
    excerpt: {
      summary: "Read this API description",
      description: "Needs a token. An excerpt: the answer is the whole description, as this document.",
      response: answer("200", {
        openapi: "3.1.0",
        info: { title: "Dezfil API", version: "0.1.0" },
        paths: { "/api/query": { post: { summary: "Run read-only SQL", requestBody: { "x-byte-limit": 16_777_216, "x-byte-error": "request_body_too_large" } } } },
      }),
    },
  },
};

type Media = Record<string, unknown> & { example?: unknown; examples?: Record<string, unknown> };
type Parameter = Record<string, unknown> & { name: string; examples?: Record<string, unknown> };
type Operation = Record<string, unknown> & {
  parameters?: Parameter[];
  requestBody?: Record<string, unknown> & { content?: Record<string, Media> };
  responses: Record<string, Record<string, unknown> & { content?: Record<string, Media> }>;
};

/** A media type object with one more named example. Its single `example`,
 * which the standard does not allow beside `examples`, gives way. */
function withNamedExample(media: Media, name: string, example: Record<string, unknown>): Media {
  const { example: _single, ...rest } = media;
  void _single;
  return { ...rest, examples: { ...rest.examples, [name]: example } };
}

/**
 * Place the worked examples on the operations of a built description. The
 * objects inside it are never changed in place: every one on the way to an
 * example is copied, since operations share parts, and the path map takes
 * the copies. An example that names an operation, parameter, status or media type the
 * description does not declare fails the build.
 */
export function withExamples<T extends { paths: Record<string, unknown> }>(document: T, examples: WorkedExamples = WORKED_EXAMPLES): T {
  for (const [key, named] of Object.entries(examples)) {
    const [method, path] = key.split(" ");
    const item = document.paths[path] as Record<string, Operation> | undefined;
    const original = item?.[method.toLowerCase()];
    if (!item || !original) throw new Error(`Worked example for ${key}: the description has no such operation`);
    let operation: Operation = { ...original, responses: { ...original.responses } };
    for (const [name, example] of Object.entries(named)) {
      const words = { summary: example.summary, description: example.description };
      for (const [parameterName, value] of Object.entries(example.parameters ?? {})) {
        const at = operation.parameters?.findIndex((parameter) => parameter.name === parameterName) ?? -1;
        if (at < 0) throw new Error(`Worked example ${key} ${name}: the operation has no parameter ${parameterName}`);
        const parameters = [...operation.parameters!];
        parameters[at] = { ...parameters[at], examples: { ...parameters[at].examples, [name]: { summary: example.summary, value } } };
        operation = { ...operation, parameters };
      }
      if (example.request) {
        const { mediaType, value, files } = example.request;
        const media = operation.requestBody?.content?.[mediaType];
        if (!media) throw new Error(`Worked example ${key} ${name}: the operation takes no ${mediaType} body`);
        const placed = withNamedExample(media, name, { ...words, value: structuredClone(value), ...(files ? { "x-filenames": structuredClone(files) } : {}) });
        operation = { ...operation, requestBody: { ...operation.requestBody, content: { ...operation.requestBody!.content, [mediaType]: placed } } };
      }
      const { status, mediaType, value } = example.response;
      const response = operation.responses[status];
      if (mediaType === undefined) {
        if (!response || response.content) throw new Error(`Worked example ${key} ${name}: the operation declares no ${status} answer without content`);
        operation.responses[status] = { ...response, "x-examples": { ...(response["x-examples"] as Record<string, unknown> | undefined), [name]: words } };
        continue;
      }
      const media = response?.content?.[mediaType];
      if (!media) throw new Error(`Worked example ${key} ${name}: the operation declares no ${status} ${mediaType} answer`);
      operation.responses[status] = { ...response, content: { ...response.content, [mediaType]: withNamedExample(media, name, { ...words, value: structuredClone(value) }) } };
    }
    document.paths[path] = { ...item, [method.toLowerCase()]: operation };
  }
  return document;
}
