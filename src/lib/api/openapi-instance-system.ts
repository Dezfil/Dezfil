import { PARTS, PART_FAILURES } from "@/lib/system/part-test-answer";
import { STORAGE_KINDS } from "@/lib/system/storage-answer";
import { AUTH_SECURITY } from "./openapi-auth";
import { ERROR_RESPONSE, jsonOk, op } from "./openapi-helpers";
import { LOCAL_READ } from "./operation-mcp";
import { READ_ONLY } from "./operation-metadata";

/**
 * The parts of this server and their Tests, as System's Status shows them.
 */

const object = <T extends Record<string, unknown>>(properties: T) => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});

const part = { type: "string", enum: [...PARTS], description: "The part tested." };

/** Each part's state as the configuration read reports it, starting nothing. */
export const PART_STATES_SCHEMA = {
  ...object({
    query_engine: object({
      version: { type: ["string", "null"], description: "The engine library's version number." },
      started: { type: "boolean", description: "Whether the engine that runs people's SQL has started; the read never starts it." },
      extensions: { type: "array", items: { type: "string", enum: ["spatial", "h3", "json"] }, description: "The extensions the started engine loaded, in load order; empty before it starts." },
    }),
    tile_builder: object({
      found: { type: "boolean", description: "Whether an executable file is where the tile builder's setting points (a bare name looked up on the search path), by a file check alone." },
      version: { type: ["string", "null"], description: "The tile builder's version number once this server has run it, else null." },
    }),
    image_renderer: object({
      found: { type: "boolean", description: "Whether an executable file is where the image renderer's browser setting points (a bare name looked up on the search path), by a file check alone." },
      imagesAtOnce: { type: "integer", minimum: 1, description: "Images at once in effect." },
    }),
    metadata_database: object({ file: { type: "string", description: "The metadata database's file name, without its folder." } }),
  }),
  description: "Each part of this server as System's Status shows it, read without creating an engine, launching a browser or running any program.",
};

const storageUse = (what: string) => ({
  ...object({
    bytes: { type: "integer", minimum: 0, description: "The bytes the files take." },
    files: { type: "integer", minimum: 0, description: "How many files." },
    finished: { type: "boolean", description: "False when the walk stopped at its limit before it had seen every such file: the bytes and files are then at least these." },
  }),
  description: what,
});

export const INSTANCE_SYSTEM_SCHEMAS = {
  StorageRead: {
    ...object({
      kinds: object({
        tables: storageUse("Dataset files the metadata registers."),
        tile_archives: storageUse("Tile archives with a tile record, and what they were built from."),
        service_caches: storageUse("The three service caches' answers."),
        thumbnails: storageUse("Map card images and their evidence."),
        metadata_database: storageUse("The metadata database and its journal files."),
        leftover_files: storageUse("What the next restart's sweeps would remove: upload, download and tile scratch, staged project exports with their ownership records, table files no dataset uses, archives no layer uses and their evidence, unfinished thumbnail writes. It includes work in progress."),
        other: storageUse("Everything else in the data folder, such as the key file and the server's records."),
      }),
      total: storageUse("What the data folder holds: every kind together."),
      disk: { description: "Free and total bytes on the data folder's volume, or null when the system would not say within the read's 10 seconds.",
        oneOf: [object({ free: { type: "integer", minimum: 0 }, total: { type: "integer", minimum: 0 } }), { type: "null" }] },
    }),
    description: `What the data folder holds, by kind (${STORAGE_KINDS.join(", ")}). Never a name, an owner, an account, a map, a dataset, a path or a file name.`,
  },
  PartTestAnswer: {
    description: "A part's Test: passed, with the milliseconds the check took, or failed with one reason: not_found (a program, or the spatial " +
      "extension, is not where its setting points), busy (the part is busy with other work), timed_out (no answer within the Test's own limit) " +
      "or failed. Never a path, a program's output or an error's words.",
    oneOf: [
      object({ part, result: { const: "passed" },
        milliseconds: { type: "integer", minimum: 0, description: "How long the check took." } }),
      object({ part, result: { const: "failed" }, reason: { type: "string", enum: [...PART_FAILURES] } }),
    ],
  },
};

export const INSTANCE_SYSTEM_PATHS = {
  "/api/instance/storage": { get: { ...op({
    summary: "Read how the data folder is used",
    description: "Requires a current admin through cookie or bearer authentication, rechecked on every call. " +
      "A cookie request must show it comes from this instance's own page, by an Origin that is this instance's, Sec-Fetch-Site same-origin or the " +
      "X-Dezfil-Account header its pages send; one with none of them, or with another origin's Origin or a cross-site or same-site Sec-Fetch-Site, " +
      "is refused. An admin bearer token calls directly. Responses, including refusals, are private, no-store. " +
      "Walks the data folder and answers, for each kind of file, the bytes its files take and how many there are: tables (dataset files the metadata " +
      "registers), tile_archives (archives with a tile record and what they were built from), service_caches (the three caches' answers), thumbnails " +
      "(map card images), metadata_database (the database and its journal files), leftover_files (what the next restart's sweeps would remove: upload, " +
      "download and tile scratch, staged project exports with their ownership records, table files no dataset uses, archives no layer uses, unfinished " +
      "thumbnail writes; it includes work in progress) and other (the rest, such as the key file and the server's records); with every kind " +
      "together and the free and total space on the folder's volume. Each file counts once. " +
      "It takes names and sizes and which files the metadata references, opening no file and following no " +
      "link, and answers no name, owner, account, map, dataset, path or file name. One walk runs at a time: a read during a walk gets that walk's " +
      "answer, and a read within 30 seconds of it gets the same answer, unless a service cache was cleared since the walk began: a Clear ends a " +
      "walk under way at once, the reads already joined to it getting what it had counted, and a read after the Clear never gets a walk begun " +
      "before it but joins one fresh walk. Every read's deadline is 10 seconds from its asking: the walk that answers it cuts every filesystem " +
      "call and the disk's statistics by then and stops the reference read at the first of its slices of 200 rows to end past it. A walk " +
      "stopped by its deadline or ended by a Clear gives each kind it had not finished as at least what it counted, finished false, and the " +
      "disk as null when its statistics had not come. It changes nothing and sends nothing outside this server. " +
      "The embedded assistant asks for confirmation before calling; SQL and workflow assistants refuse this operation. " +
      "MCP advertises that policy and adds no confirmation step.",
    tag: "System", tool: "read_storage", toolInput: { closed: true },
    display: { verb: "Read how the data folder is used" },
    effects: READ_ONLY, mcp: LOCAL_READ, confirm: true,
    confirmation: { target: "Read how this server uses its data folder?",
      consequence: "This server walks its data folder for sizes and counts, for at most 10 seconds. Nothing is saved and nothing is sent outside this server.",
      subject: { path: null, argument: "", name: "" } },
    responses: { "200": jsonOk("#/components/schemas/StorageRead"), "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "503": ERROR_RESPONSE },
  }), security: AUTH_SECURITY } },
  "/api/instance/parts/{part}/test": { post: { ...op({
    summary: "Test a part of this server",
    description: "Requires a current admin through cookie or bearer authentication, rechecked on every call. " +
      "Cookie requests require the same trusted Origin; an admin bearer token calls directly. Responses, including refusals, are private, no-store. " +
      "Runs one small fixed check on one part of this server as it is configured now, never one given here: data_folder writes and removes one " +
      "empty file in the data folder, as the readiness check does, within 5 seconds; query_engine asks the engine that runs people's SQL one fixed " +
      "spatial question with a known answer within 30 seconds, interrupting it a second before them, and starts a cold engine for it loading only the " +
      "extensions already installed: it installs nothing, so without the spatial extension it answers not_found and leaves the engine for the next " +
      "query to start, and a missing optional extension stays off until the next start; tile_builder asks the tile builder for its version, then " +
      "builds a small archive from a few fixed points in a folder of its own under the tile scratch and removes it, within 30 seconds, beside any " +
      "layer build, neither waiting behind one nor holding one up; a tile builder still running 3 seconds before the limit is asked to stop, ended " +
      "outright if it has not 2 seconds later, and its folder removed once it is gone, all within the 30 seconds; image_renderer has the image " +
      "renderer's browser photograph a small fixed " +
      "picture of this server's own, from no map or data, and reads its mark's color back, within 10 seconds, only on an image slot free now with " +
      "no image waiting: otherwise it answers busy at once, launching nothing, and an image asked while it runs waits for it as behind any image; " +
      "its browser is closed, or ended, within those 10 seconds, and only then is its slot free again; " +
      "metadata_database takes the metadata database's write lock, " +
      "reads the schema's version and gives the lock back, writing nothing, answering busy when other work holds the lock past the database's " +
      "5-second wait. It changes no setting, leaves no file and sends nothing outside this server. A second Test of a part asked while one runs, " +
      "its part's work still ending included, gets that run's answer. " +
      "The embedded assistant asks for confirmation before calling; SQL and workflow assistants refuse this operation. " +
      "MCP advertises that policy and adds no confirmation step.",
    tag: "System", tool: "test_part", toolInput: { closed: true },
    display: { verb: "Tested the {arg.part} part of this server" },
    effects: READ_ONLY, mcp: LOCAL_READ, confirm: true,
    confirmation: { target: "Test the {target} part of this server?",
      consequence: "This server runs one small fixed check on that part. Nothing is saved and nothing is sent outside this server.",
      subject: { path: null, argument: "part", name: "" } },
    parameters: [{ name: "part", in: "path", required: true, schema: { type: "string", enum: [...PARTS] },
      description: `The part to test: ${PARTS.join(" or ")}.` }],
    responses: { "200": jsonOk("#/components/schemas/PartTestAnswer"), "400": ERROR_RESPONSE, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "404": ERROR_RESPONSE, "503": ERROR_RESPONSE },
  }), security: AUTH_SECURITY } },
};
