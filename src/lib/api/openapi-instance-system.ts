import { PARTS, PART_FAILURES } from "@/lib/system/part-test-answer";
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

export const INSTANCE_SYSTEM_SCHEMAS = {
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
  "/api/instance/parts/{part}/test": { post: { ...op({
    summary: "Test a part of this server",
    description: "Requires a current admin through cookie or bearer authentication, rechecked on every call. " +
      "Cookie requests require the same trusted Origin; an admin bearer token calls directly. Responses, including refusals, are private, no-store. " +
      "Runs one small fixed check on one part of this server as it is configured now, never one given here: data_folder writes and removes one " +
      "empty file in the data folder, as the readiness check does, within 5 seconds; query_engine asks the engine that runs people's SQL one fixed " +
      "spatial question with a known answer within 30 seconds, interrupting it past them, and starts a cold engine for it loading only the " +
      "extensions already installed: it installs nothing, so without the spatial extension it answers not_found and leaves the engine for the next " +
      "query to start, and a missing optional extension stays off until the next start; tile_builder asks the tile builder for its version, then " +
      "builds a small archive from a few fixed points in a folder of its own under the tile scratch and removes it, within 30 seconds, beside any " +
      "layer build, neither waiting behind one nor holding one up; image_renderer has the image renderer's browser photograph a small fixed " +
      "picture of this server's own, from no map or data, and reads its mark's color back, within 10 seconds, only on an image slot free now with " +
      "no image waiting: otherwise it answers busy at once, launching nothing, and an image asked while it runs waits for it as behind any image; " +
      "metadata_database takes the metadata database's write lock, " +
      "reads the schema's version and gives the lock back, writing nothing, answering busy when other work holds the lock past the database's " +
      "5-second wait. It changes no setting, leaves no file and sends nothing outside this server. A second Test of a part while one runs gets " +
      "the same answer from the same run. " +
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
